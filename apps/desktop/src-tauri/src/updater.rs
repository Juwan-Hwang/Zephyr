use crate::core_manager::{self, MihomoState};
use flate2::read::GzDecoder;
use futures_util::StreamExt as _;
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};
use std::io::Read as _;
use std::time::Duration;
use tauri::{command, Manager as _, State, Window};

// ── Pure helper functions ────────────────────────────────────────────────

/// Strip a leading 'v' or 'V' prefix from a version tag.
#[must_use]
fn strip_version_prefix(tag: &str) -> &str {
    tag.strip_prefix('v')
        .or_else(|| tag.strip_prefix('V'))
        .unwrap_or(tag)
}

#[derive(Debug, Deserialize, Serialize)]
pub struct UpdateInfo {
    pub version: String,
    pub download_url: String,
}

#[derive(Debug, Deserialize)]
struct GithubRelease {
    tag_name: String,
    assets: Vec<GithubAsset>,
    body: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GithubAsset {
    name: String,
    digest: Option<String>,
}

/// Extract a valid SHA256 hex hash from a GitHub API digest string (e.g. `"sha256:abc…"`).
/// Returns `None` if the digest is missing, malformed, or not SHA256.
#[must_use]
fn parse_digest(digest: &str) -> Option<String> {
    let hash = digest.strip_prefix("sha256:")?;
    (hash.len() == 64 && hash.chars().all(|c| c.is_ascii_hexdigit())).then(|| hash.to_lowercase())
}

/// In-memory cache of asset digests from the last successful REST API fetch.
///
/// Populated by [`fetch_latest_release`] when the API path wins, so that
/// [`get_expected_sha256`] can look up the hash without a second API call
/// (which may be rate-limited at 60 req/hour unauthenticated).
type DigestCache = Option<(String, Vec<(String, String)>)>;
static DIGEST_CACHE: std::sync::Mutex<DigestCache> = std::sync::Mutex::new(None);

/// Store all asset digests from a release into the in-memory cache.
fn cache_digests(release: &GithubRelease) {
    let digests: Vec<(String, String)> = release
        .assets
        .iter()
        .filter_map(|a| {
            a.digest
                .as_ref()
                .and_then(|d| parse_digest(d).map(|h| (a.name.clone(), h)))
        })
        .collect();
    if !digests.is_empty() {
        if let Ok(mut cache) = DIGEST_CACHE.lock() {
            *cache = Some((release.tag_name.clone(), digests));
        }
    }
}

#[derive(Clone, Serialize)]
struct CoreDownloadStatus {
    status_text: String,
    progress: u8,
}

const MIHOMO_RELEASE_API: &str = "https://api.github.com/repos/MetaCubeX/mihomo/releases/latest";
const MIHOMO_ATOM_FEED: &str = "https://github.com/MetaCubeX/mihomo/releases.atom";

/// Trusted hosts for core updates - GitHub only for security
const TRUSTED_HOSTS: [&str; 3] = [
    "github.com",
    "api.github.com",
    "objects.githubusercontent.com",
];

fn current_platform_tags() -> Result<(&'static str, &'static str), String> {
    let os = std::env::consts::OS;
    let arch = std::env::consts::ARCH;
    let os_tag = match os {
        "windows" => "windows",
        "macos" => "darwin",
        "linux" => "linux",
        "freebsd" => "freebsd",
        "openbsd" => "openbsd",
        "netbsd" => "netbsd",
        "dragonfly" => "dragonfly",
        _ => return Err(format!("Unsupported OS: {os}")),
    };
    let arch_tag = match arch {
        "x86_64" => "amd64",
        "aarch64" => "arm64",
        "x86" => "386",
        "arm" => "armv7",
        "mips" => "mips-softfloat",
        "mips64" => "mips64",
        "mips64el" => "mips64le",
        "mipsel" => "mipsle-hardfloat",
        "riscv64" => "riscv64",
        "s390x" => "s390x",
        "loongarch64" => "loongarch64",
        _ => return Err(format!("Unsupported ARCH: {arch}")),
    };
    Ok((os_tag, arch_tag))
}

fn build_github_client() -> Result<reqwest::Client, String> {
    let version = env!("CARGO_PKG_VERSION");
    reqwest::Client::builder()
        .user_agent(format!("Zephyr/{version}"))
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())
}

fn emit_core_download_status(window: &Window, status_text: impl Into<String>, progress: u8) {
    crate::backend_event::emit_to_main(
        window.app_handle(),
        "core-download-status",
        CoreDownloadStatus {
            status_text: status_text.into(),
            progress,
        },
    );
}

fn build_asset_download_url(version: &str, asset_name: &str) -> String {
    format!("https://github.com/MetaCubeX/mihomo/releases/download/{version}/{asset_name}")
}

/// Fetch the latest release info from the GitHub REST API (primary source).
///
/// Returns full release information including the complete asset list.
/// Subject to rate limiting (60 req/hour unauthenticated).
async fn fetch_release_from_api(client: &reqwest::Client) -> Result<GithubRelease, String> {
    let response = client
        .get(MIHOMO_RELEASE_API)
        .send()
        .await
        .map_err(|e| format!("Failed to fetch release info: {e}"))?;

    if !response.status().is_success() {
        return Err(format!("GitHub API returned status: {}", response.status()));
    }

    // Limit response body size to prevent memory exhaustion from malicious responses
    const MAX_RELEASE_SIZE: u64 = 10 * 1024 * 1024; // 10 MB
    let content_length = response.content_length().unwrap_or(0);
    if content_length > MAX_RELEASE_SIZE {
        return Err(format!(
            "Release info too large: {content_length} bytes (max {MAX_RELEASE_SIZE} bytes)"
        ));
    }

    response
        .json::<GithubRelease>()
        .await
        .map_err(|e| format!("Failed to parse release info: {e}"))
}

/// Fetch the latest release tag from the GitHub Atom feed (secondary source).
///
/// The Atom feed (`/releases.atom`) is served from the web frontend and
/// is **not** subject to the REST API rate limit.  It returns XML; we
/// extract the first `<entry>`'s `<title>` which is the latest release tag.
async fn fetch_tag_from_atom_feed(client: &reqwest::Client) -> Result<String, String> {
    let response = client
        .get(MIHOMO_ATOM_FEED)
        .send()
        .await
        .map_err(|e| format!("Failed to fetch Atom feed: {e}"))?;

    if !response.status().is_success() {
        return Err(format!("Atom feed returned status: {}", response.status()));
    }

    let text = response
        .text()
        .await
        .map_err(|e| format!("Failed to read Atom feed: {e}"))?;

    // Lightweight XML extraction: find the first <entry> → <title>text</title>
    let entry_start = text.find("<entry>").ok_or("No <entry> in Atom feed")?;
    let entry_end = text[entry_start..]
        .find("</entry>")
        .map(|i| entry_start + i)
        .ok_or("Malformed Atom feed: missing </entry>")?;
    let entry = &text[entry_start..entry_end];

    let title_start = entry.find("<title").ok_or("No <title> in Atom entry")?;
    let title_content_start = entry[title_start..]
        .find('>')
        .map(|i| title_start + i + 1)
        .ok_or("Malformed <title> tag")?;
    let title_close = entry[title_content_start..]
        .find("</title>")
        .map(|i| title_content_start + i)
        .ok_or("Malformed <title> tag")?;
    let tag = entry[title_content_start..title_close].trim();

    if tag.is_empty() {
        return Err("Empty version tag in Atom feed".to_owned());
    }

    Ok(tag.to_owned())
}

/// Construct a `GithubRelease` from a tag when only the Atom feed is available.
///
/// Generates all plausible asset names (v3, compatible, plain) so that
/// `select_release_asset` can pick the right one using its existing logic.
fn construct_release_from_tag(tag: &str) -> Result<GithubRelease, String> {
    let (os_tag, arch_tag) = current_platform_tags()?;
    let ext = if os_tag == "windows" { "zip" } else { "gz" };

    let mut assets = Vec::new();

    if arch_tag == "amd64" {
        // x86_64: include all variants so select_release_asset can choose.
        assets.push(GithubAsset {
            name: format!("mihomo-{os_tag}-{arch_tag}-v3-{tag}.{ext}"),
            digest: None,
        });
        assets.push(GithubAsset {
            name: format!("mihomo-{os_tag}-{arch_tag}-compatible-{tag}.{ext}"),
            digest: None,
        });
    }
    // Always include the plain variant (common to all arches).
    assets.push(GithubAsset {
        name: format!("mihomo-{os_tag}-{arch_tag}-{tag}.{ext}"),
        digest: None,
    });

    Ok(GithubRelease {
        tag_name: tag.to_owned(),
        assets,
        body: None,
    })
}

async fn fetch_latest_release() -> Result<GithubRelease, String> {
    let client = build_github_client()?;

    // ── Dual-source racing: REST API vs Atom Feed ──
    //
    // The REST API is rate-limited (60 req/hour unauthenticated).
    // The Atom Feed (`/releases.atom`) is served from the web frontend
    // and has no such limit.  We race both; first success wins.
    //
    // If the API wins, we get the full release incl. asset list.
    // If the Atom Feed wins, we get just the tag and construct the
    // expected asset names from the known naming pattern.

    let api_fut = fetch_release_from_api(&client);
    let atom_fut = fetch_tag_from_atom_feed(&client);

    tokio::pin!(api_fut);
    tokio::pin!(atom_fut);

    tokio::select! {
        result = &mut api_fut => {
            if let Ok(release) = result {
                    // Cache digests so get_expected_sha256 can skip the
                    // rate-limited API call during the actual update.
                    cache_digests(&release);

                    // Best-effort consistency check: if the Atom feed
                    // has already completed, compare tags — without
                    // blocking the fast path (now_or_never = zero delay).
                    use futures_util::FutureExt as _;
                    if let Some(Ok(atom_tag)) = atom_fut.as_mut().now_or_never() {
                        if release.tag_name != atom_tag {
                            crate::emit_warn!(
                                Updater,
                                UPDATE_CHECK_FAILED,
                                "Version mismatch: API={}, Atom={}",
                                release.tag_name,
                                atom_tag
                            );
                        }
                    }
                    Ok(release)
                } else {
                    // API failed — fall back to Atom Feed result.
                    let tag = atom_fut.await?;
                    construct_release_from_tag(&tag)
                }
        }
        result = &mut atom_fut => {
            match result {
                Ok(tag) => {
                    // Atom Feed won — construct release from tag.
                    // The api_fut is dropped here (aborted).
                    construct_release_from_tag(&tag)
                }
                Err(_) => {
                    // Atom failed — fall back to API result.
                    api_fut.await
                }
            }
        }
    }
}

fn is_trusted_update_url(url: &str) -> bool {
    if let Ok(parsed) = reqwest::Url::parse(url) {
        if let Some(host) = parsed.host_str() {
            return TRUSTED_HOSTS
                .iter()
                .any(|&h| host == h || host.ends_with(&format!(".{h}")));
        }
    }
    false
}

fn verify_sha256(file_path: &std::path::Path, expected_hash: &str) -> Result<(), String> {
    let mut file = std::fs::File::open(file_path).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 8192];
    loop {
        let n = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        hasher.update(buffer.get(..n).unwrap_or(&[]));
    }
    let result = hasher.finalize();
    let hex_result = hex::encode(result);
    if hex_result.to_lowercase() == expected_hash.to_lowercase() {
        Ok(())
    } else {
        Err(format!(
            "SHA256 mismatch: expected {expected_hash}, got {hex_result}"
        ))
    }
}

/// Resolve the expected SHA256 hash for a release asset.
///
/// Strategy (fastest → slowest):
/// 1. **In-memory cache** — populated during `fetch_latest_release` when the
///    REST API path succeeds.  Zero network I/O; bypasses rate limiting.
/// 2. **REST API fallback** — fetches `/releases/tags/{version}` and extracts
///    the `digest` field.  Subject to 60 req/hour unauthenticated rate limit.
async fn get_expected_sha256(version: &str, asset_name: &str) -> Result<String, String> {
    // ── 1. Check digest cache ──
    if let Ok(cache) = DIGEST_CACHE.lock() {
        if let Some((cached_tag, digests)) = &*cache {
            if cached_tag == version {
                for (name, hash) in digests {
                    if name == asset_name {
                        return Ok(hash.clone());
                    }
                }
            }
        }
    }

    // ── 2. Fall back to REST API ──
    let client = build_github_client()?;
    let api_url = format!("https://api.github.com/repos/MetaCubeX/mihomo/releases/tags/{version}");

    let response = client
        .get(&api_url)
        .send()
        .await
        .map_err(|e| format!("Failed to fetch release info: {e}"))?;

    if !response.status().is_success() {
        return Err(format!("GitHub API returned status: {}", response.status()));
    }

    let json: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse JSON: {e}"))?;

    let assets = json
        .get("assets")
        .unwrap_or(&serde_json::Value::Null)
        .as_array()
        .ok_or_else(|| "No assets found in release".to_owned())?;

    for asset in assets {
        if asset["name"].as_str() == Some(asset_name) {
            if let Some(digest) = asset["digest"].as_str() {
                if let Some(hash) = parse_digest(digest) {
                    return Ok(hash);
                }
            }
        }
    }

    Err(format!(
        "Could not find SHA256 hash for {asset_name}. Verification is required for security."
    ))
}

async fn download_release_asset(
    window: &Window,
    url: &str,
    dest_path: &std::path::Path,
) -> Result<(), String> {
    if !is_trusted_update_url(url) {
        return Err("Untrusted download URL: only github.com is allowed".to_owned());
    }

    let client = build_github_client()?;
    emit_core_download_status(window, "Downloading core from GitHub...", 24);

    let response = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Failed to download: {e}"))?;

    if !response.status().is_success() {
        return Err(format!(
            "Download failed with status: {}",
            response.status()
        ));
    }

    let total_size = response.content_length().unwrap_or(0);
    if total_size > 100 * 1024 * 1024 {
        return Err(format!("Update package too large: {total_size} bytes"));
    }

    let mut downloaded = 0_u64;
    let mut stream = response.bytes_stream();
    let mut file =
        std::fs::File::create(dest_path).map_err(|e| format!("Failed to create temp file: {e}"))?;

    while let Some(item) = stream.next().await {
        let chunk = match item {
            Ok(c) => c,
            Err(e) => {
                let _ = std::fs::remove_file(dest_path);
                return Err(e.to_string());
            }
        };
        downloaded += chunk.len() as u64;
        if downloaded > 100 * 1024 * 1024 {
            let _ = std::fs::remove_file(dest_path);
            return Err("Update package exceeded size limit".to_owned());
        }
        use std::io::Write as _;
        if let Err(e) = file.write_all(&chunk) {
            let _ = std::fs::remove_file(dest_path);
            return Err(format!("Failed to write chunk: {e}"));
        }

        #[allow(clippy::manual_hash_one)]
        let progress = if total_size > 0 {
            // Integer-only progress: ratio ∈ [0, 1000] maps to font size [24, 80]
            let ratio_x1000 = downloaded
                .checked_mul(1000)
                .unwrap_or(0)
                .checked_div(total_size)
                .unwrap_or(0);
            let font_size = 24 + ((ratio_x1000 * 56) / 1000);
            u8::try_from(font_size).unwrap_or(52)
        } else {
            52
        };
        emit_core_download_status(window, format!("Downloading core... {progress}%"), progress);
    }

    if let Err(e) = file.sync_all() {
        let _ = std::fs::remove_file(dest_path);
        return Err(e.to_string());
    }
    Ok(())
}

/// Detect x86_64-v3 microarchitecture-level support at runtime.
///
/// The v3 feature set requires: AVX, AVX2, BMI1, BMI2, F16C, FMA,
/// LZCNT, MOVBE, OSXSAVE.  `is_x86_feature_detected!` checks both
/// CPUID flags *and* OS/hypervisor XSAVE enablement, so a bare-metal
/// CPU that supports AVX but runs under an OS that hasn't enabled
/// XSAVE will correctly return `false`.
#[cfg(target_arch = "x86_64")]
fn supports_x86_64_v3() -> bool {
    std::is_x86_feature_detected!("avx")
        && std::is_x86_feature_detected!("avx2")
        && std::is_x86_feature_detected!("bmi1")
        && std::is_x86_feature_detected!("bmi2")
        && std::is_x86_feature_detected!("f16c")
        && std::is_x86_feature_detected!("fma")
        && std::is_x86_feature_detected!("lzcnt")
        && std::is_x86_feature_detected!("movbe")
}

/// Pure selection logic — separated from runtime detection for testability.
///
/// # Three-branch asset selection
///
/// | # | Condition | Target asset |
/// |---|-----------|--------------|
/// | 1 | `x86_64` + v3 supported + v3 asset present | `mihomo-{os}-amd64-v3-{ver}.{ext}` |
/// | 2 | `x86_64` + (v3 unsupported **or** v3 asset absent) | `mihomo-{os}-amd64-compatible-{ver}.{ext}` |
/// | 3 | ARM64 / other arch | `mihomo-{os}-{arch}-{ver}.{ext}` (plain) |
///
/// Go-version variants (`go120`, `go121`, …) are always excluded so
/// we pick the canonical build.
fn select_release_asset_inner<'a>(
    assets: &'a [GithubAsset],
    os_tag: &str,
    arch_tag: &str,
    supports_v3: bool,
) -> Result<&'a GithubAsset, String> {
    let prefix = format!("mihomo-{os_tag}-{arch_tag}");

    // Candidate filter: correct prefix, correct extension, no go-version variant.
    let candidates: Vec<&GithubAsset> = assets
        .iter()
        .filter(|a| {
            a.name.starts_with(&prefix)
                && (a.name.ends_with(".zip") || a.name.ends_with(".gz"))
                && !a.name.contains("-go")
        })
        .collect();

    // ARM64 / non-amd64: no v3 or compatible variants exist.
    if arch_tag != "amd64" {
        return candidates
            .into_iter()
            .next()
            .ok_or_else(|| format!("Could not find release asset for {os_tag}-{arch_tag}"));
    }

    // ── x86_64 branch 1: v3 (preferred) ──
    if supports_v3 {
        if let Some(v3) = candidates.iter().find(|a| a.name.contains("-v3-")) {
            return Ok(v3);
        }
        // v3 asset missing — fall through to compatible.
    }

    // ── x86_64 branch 2: compatible (fallback) ──
    if let Some(compat) = candidates.iter().find(|a| a.name.contains("-compatible-")) {
        return Ok(compat);
    }

    // ── x86_64 branch 3: default (no variant suffix) ──
    candidates
        .into_iter()
        .next()
        .ok_or_else(|| format!("Could not find release asset for {os_tag}-{arch_tag}"))
}

/// Select the best mihomo release asset for the current platform.
///
/// On `x86_64`, performs runtime v3 feature detection and prefers the
/// v3 build when available, falling back to `compatible` if the CPU
/// lacks v3 features **or** the v3 asset is absent from the release.
fn select_release_asset(assets: &[GithubAsset]) -> Result<&GithubAsset, String> {
    let (os_tag, arch_tag) = current_platform_tags()?;

    #[cfg(target_arch = "x86_64")]
    let supports_v3 = supports_x86_64_v3();
    #[cfg(not(target_arch = "x86_64"))]
    let supports_v3 = false;

    select_release_asset_inner(assets, os_tag, arch_tag, supports_v3)
}

fn extract_from_zip(
    archive_path: &std::path::Path,
    exe_path: &std::path::Path,
) -> Result<(), String> {
    let file = std::fs::File::open(archive_path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("Failed to read ZIP: {e}"))?;
    let expected = core_manager::core_binary_name();

    for i in 0..archive.len() {
        let mut file = archive.by_index(i).map_err(|e| e.to_string())?;
        // Reject symlinks outright — not silently skip
        if file.is_symlink() {
            return Err("Refusing to extract symlink from ZIP".to_owned());
        }
        let name = file.name();
        if name.contains("..") || name.starts_with('/') || name.starts_with('\\') {
            return Err(format!("Malicious ZIP path detected: {name}"));
        }
        let lower = name.to_lowercase();
        #[cfg(target_os = "windows")]
        let matched = lower.ends_with(".exe");
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        let matched = lower.ends_with("/mihomo") || lower == "mihomo";
        if matched || lower.ends_with(expected) {
            // Zip bomb detection: check uncompressed size and compression ratio
            let uncompressed = file.size();
            let compressed = file.compressed_size();
            if uncompressed > 200 * 1024 * 1024 {
                return Err("ZIP entry uncompressed size exceeds 200 MB limit".to_owned());
            }
            if compressed > 0 && uncompressed > compressed.saturating_mul(200) {
                return Err(
                    "Suspicious ZIP compression ratio detected (possible zip bomb)".to_owned(),
                );
            }
            let mut out_file = std::fs::File::create(exe_path).map_err(|e| e.to_string())?;
            let written = std::io::copy(&mut file, &mut out_file).map_err(|e| e.to_string())?;
            if written == 0 {
                return Err("Extracted core binary is empty".to_owned());
            }
            return Ok(());
        }
    }
    Err("No executable found in ZIP".to_owned())
}

fn extract_from_gz(
    archive_path: &std::path::Path,
    exe_path: &std::path::Path,
) -> Result<(), String> {
    let file = std::fs::File::open(archive_path).map_err(|e| e.to_string())?;
    let compressed_size = file.metadata().map_err(|e| e.to_string())?.len();
    let mut decoder = GzDecoder::new(file);

    let temp_tar_path = archive_path.with_extension("tar");
    let mut temp_decompressed = std::fs::File::create(&temp_tar_path).map_err(|e| e.to_string())?;
    let mut total_decompressed = 0_u64;
    let mut buffer = [0u8; 8192];
    use std::io::{Read as _, Seek as _, SeekFrom, Write as _};
    loop {
        let n = decoder.read(&mut buffer).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        total_decompressed += n as u64;
        if total_decompressed > 200 * 1024 * 1024 {
            let _ = std::fs::remove_file(&temp_tar_path);
            return Err("Decompressed gz too large".to_owned());
        }
        // Bomb ratio check: use multiplication to avoid integer division edge cases
        if total_decompressed > 64 * 1024
            && compressed_size > 0
            && total_decompressed > compressed_size.saturating_mul(200)
        {
            let _ = std::fs::remove_file(&temp_tar_path);
            return Err("Suspicious compression ratio detected (possible zip bomb)".to_owned());
        }
        temp_decompressed
            .write_all(buffer.get(..n).unwrap_or(&[]))
            .map_err(|e| e.to_string())?;
    }
    temp_decompressed.sync_all().map_err(|e| e.to_string())?;

    let mut decomp_file = std::fs::File::open(&temp_tar_path).map_err(|e| e.to_string())?;
    let mut magic = [0u8; 265];
    let n = decomp_file.read(&mut magic).unwrap_or(0);
    decomp_file
        .seek(SeekFrom::Start(0))
        .map_err(|e| e.to_string())?;

    if n >= 262 && &magic[257..262] == b"ustar" {
        let mut archive = tar::Archive::new(decomp_file);
        let expected = core_manager::core_binary_name();
        for entry in archive
            .entries()
            .map_err(|e| format!("Failed to parse tar entries: {e}"))?
        {
            let mut entry_inner = entry.map_err(|e| e.to_string())?;
            // Reject symlinks and hard links outright
            let entry_type = entry_inner.header().entry_type();
            if entry_type.is_symlink() || entry_type.is_hard_link() {
                let _ = std::fs::remove_file(&temp_tar_path);
                return Err("Refusing to extract linked TAR entry".to_owned());
            }
            let path = entry_inner.path().map_err(|e| e.to_string())?;
            let path_str = path.to_string_lossy().replace('\\', "/");
            let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
            if path_str.contains("..") || path_str.starts_with('/') {
                let _ = std::fs::remove_file(&temp_tar_path);
                return Err(format!("Malicious TAR path detected: {path_str}"));
            }
            #[cfg(target_os = "windows")]
            let matched = file_name.eq_ignore_ascii_case(expected);
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            let matched = file_name == expected;
            if matched {
                let mut out_file = std::fs::File::create(exe_path).map_err(|e| e.to_string())?;
                let written =
                    std::io::copy(&mut entry_inner, &mut out_file).map_err(|e| e.to_string())?;
                let _ = std::fs::remove_file(&temp_tar_path);
                if written == 0 {
                    return Err("Extracted core binary is empty".to_owned());
                }
                return Ok(());
            }
        }
        let _ = std::fs::remove_file(&temp_tar_path);
        Err("No executable found in tar.gz".to_owned())
    } else {
        let mut out_file = std::fs::File::create(exe_path).map_err(|e| e.to_string())?;
        std::io::copy(&mut decomp_file, &mut out_file).map_err(|e| e.to_string())?;
        let _ = std::fs::remove_file(&temp_tar_path);
        Ok(())
    }
}

fn extract_core_binary(
    archive_path: &std::path::Path,
    exe_path: &std::path::Path,
    url: &str,
) -> Result<(), String> {
    if url.ends_with(".zip") {
        return extract_from_zip(archive_path, exe_path);
    }
    if url.ends_with(".gz") {
        return extract_from_gz(archive_path, exe_path);
    }
    Err("Unsupported asset format, expected .zip or .gz".to_owned())
}

#[allow(clippy::missing_const_for_fn, clippy::unnecessary_wraps)]
fn install_core_binary(app: &tauri::AppHandle) -> Result<(), String> {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        let paths = core_manager::ensure_app_storage(app)?;
        let core_path = paths.core_dir.join(core_manager::core_binary_name());
        core_manager::ensure_executable(&core_path)?;
    }
    #[cfg(target_os = "windows")]
    let _ = app;
    Ok(())
}

#[derive(Serialize)]
pub struct ClientVersions {
    pub verge: String,
    pub mihomo_party: String,
    pub flclash: String,
}

#[command]
pub async fn get_latest_client_versions() -> Result<ClientVersions, String> {
    let client = reqwest::Client::builder()
        .user_agent("Zephyr/Update-Checker")
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;

    let verge_res = match client
        .get("https://api.github.com/repos/clash-verge-rev/clash-verge-rev/releases/latest")
        .send()
        .await
    {
        Ok(res) if res.status().is_success() => {
            if let Ok(release) = res.json::<GithubRelease>().await {
                strip_version_prefix(&release.tag_name).to_owned()
            } else {
                "1.7.5".to_owned()
            }
        }
        _ => "1.7.5".to_owned(),
    };

    let party_res = match client
        .get("https://api.github.com/repos/mihomo-party-org/mihomo-party/releases/latest")
        .send()
        .await
    {
        Ok(res) if res.status().is_success() => {
            if let Ok(release) = res.json::<GithubRelease>().await {
                strip_version_prefix(&release.tag_name).to_owned()
            } else {
                "1.0.0".to_owned()
            }
        }
        _ => "1.0.0".to_owned(),
    };

    let flclash_res = match client
        .get("https://api.github.com/repos/chen08209/Flclash/releases/latest")
        .send()
        .await
    {
        Ok(res) if res.status().is_success() => {
            if let Ok(release) = res.json::<GithubRelease>().await {
                strip_version_prefix(&release.tag_name).to_owned()
            } else {
                "0.8.92".to_owned()
            }
        }
        _ => "0.8.92".to_owned(),
    };

    Ok(ClientVersions {
        verge: format!("clash-verge/{verge_res}"),
        mihomo_party: format!("mihomo-party/{party_res}"),
        flclash: format!("Flclash/{flclash_res}"),
    })
}

#[command]
pub async fn get_latest_version() -> Result<UpdateInfo, String> {
    let release = fetch_latest_release().await?;
    let asset = select_release_asset(&release.assets)?;
    let version = release.tag_name;

    Ok(UpdateInfo {
        download_url: build_asset_download_url(&version, &asset.name),
        version,
    })
}

/// Validates that a version string follows the semantic versioning pattern
fn validate_version_format(version: &str) -> bool {
    if !version.starts_with('v') {
        return false;
    }

    if version.len() < 3 || version.len() > 25 {
        return false;
    }

    // Security: reject path traversal and special characters
    if version.contains("..")
        || version.contains('/')
        || version.contains('\\')
        || version.contains('\0')
        || version.contains('<')
        || version.contains('>')
        || version.contains('|')
        || version.contains('&')
        || version.contains(';')
        || version.contains('$')
        || version.contains('`')
        || version.contains('\n')
        || version.contains('\r')
    {
        return false;
    }

    let version_part = &version[1..];
    let (main_version, _pre_release) = if let Some(idx) = version_part.find('-') {
        (&version_part[..idx], Some(&version_part[idx + 1..]))
    } else {
        (version_part, None)
    };

    let parts: Vec<&str> = main_version.split('.').collect();
    if parts.len() != 3 {
        return false;
    }

    for part in parts {
        if part.is_empty() || !part.chars().all(|c| c.is_ascii_digit()) {
            return false;
        }
    }

    true
}

fn parse_github_release_info(url: &str) -> Option<(String, String)> {
    if let Ok(parsed) = reqwest::Url::parse(url) {
        if parsed.host_str() != Some("github.com") {
            return None; // Only allow direct github.com URLs
        }

        let segments: Vec<&str> = parsed.path_segments()?.collect();

        if segments.len() >= 5
            && segments.first().is_some_and(|s| *s == "MetaCubeX")
            && segments.get(1).is_some_and(|s| *s == "mihomo")
            && segments.get(2).is_some_and(|s| *s == "releases")
            && segments.get(3).is_some_and(|s| *s == "download")
        {
            let version = segments.get(4).map(|s| (*s).to_owned()).unwrap_or_default();
            let asset_name = segments.get(5).map(|s| (*s).to_owned()).unwrap_or_default();

            if !validate_version_format(&version) {
                return None;
            }

            let asset_lower = asset_name.to_lowercase();
            if !asset_lower.starts_with("mihomo-") {
                return None;
            }
            if !asset_lower.ends_with(".zip") && !asset_lower.ends_with(".gz") {
                return None;
            }
            if asset_name.contains("..")
                || asset_name.contains('/')
                || asset_name.contains('\\')
                || asset_name.contains('\0')
                || asset_name.contains('<')
                || asset_name.contains('>')
            {
                return None;
            }

            return Some((version, asset_name));
        }
    }
    None
}

async fn update_core_inner(
    window: Window,
    state: State<'_, MihomoState>,
    url: String,
) -> Result<core_manager::CoreStartResult, String> {
    let app = window.app_handle();
    emit_core_download_status(&window, "Preparing to update Mihomo core...", 4);

    let (version, asset_name) = parse_github_release_info(&url).ok_or_else(|| {
        "Invalid update URL: only official MetaCubeX/mihomo GitHub releases are supported"
            .to_owned()
    })?;

    let paths = core_manager::ensure_app_storage(app)?;

    // Use unpredictable temp file names to prevent TOCTOU attacks
    let temp_suffix = uuid::Uuid::new_v4();
    let archive_path = paths
        .core_dir
        .join(format!("core_update_{temp_suffix}.tmp"));

    if let Err(e) = download_release_asset(&window, &url, &archive_path).await {
        let _ = std::fs::remove_file(&archive_path);
        return Err(e);
    }

    emit_core_download_status(&window, "Verifying file integrity...", 82);
    let expected_hash = get_expected_sha256(&version, &asset_name).await?;
    verify_sha256(&archive_path, &expected_hash).inspect_err(|e| {
        let _ = std::fs::remove_file(&archive_path);
        let _ = e;
    })?;

    emit_core_download_status(&window, "Download complete, extracting core...", 84);
    let temp_exe_path = paths.core_dir.join(format!(
        "{}_{}.tmp",
        core_manager::core_binary_name(),
        temp_suffix
    ));
    if let Err(e) = extract_core_binary(&archive_path, &temp_exe_path, &url) {
        let _ = std::fs::remove_file(&archive_path);
        let _ = std::fs::remove_file(&temp_exe_path);
        return Err(e);
    }
    let _ = std::fs::remove_file(&archive_path);

    emit_core_download_status(&window, "Writing core files...", 92);

    // Stop core and wait for it to fully exit
    let _ = core_manager::stop_core_inner(app, &state);

    // Wait for the process to fully exit (give it some time)
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;

    let exe_path = paths.core_dir.join(core_manager::core_binary_name());

    // Atomic replace sequence:
    // 1. rename exe_path -> backup_path  (move old binary out of the way)
    // 2. rename temp_exe_path -> exe_path (move new binary in)
    // 3. On success: delete backup
    // 4. On failure: delete exe_path, rename backup_path -> exe_path
    let backup_path = paths
        .core_dir
        .join(format!("{}.backup", core_manager::core_binary_name()));

    // Step 1: Move old binary to backup (must succeed to guarantee rollback)
    if exe_path.exists() {
        // Clean up stale backup first
        let _ = std::fs::remove_file(&backup_path);
        std::fs::rename(&exe_path, &backup_path).map_err(|e| {
            format!("Failed to move current binary to backup (update aborted for safety): {e}")
        })?;
    }

    // Step 2: Move new binary into place (target no longer exists, so rename will work)
    let mut retries = 5;
    loop {
        match std::fs::rename(&temp_exe_path, &exe_path) {
            Ok(()) => break,
            Err(e) => {
                retries -= 1;
                if retries == 0 {
                    let _ = std::fs::remove_file(&temp_exe_path);
                    // Restore backup
                    if backup_path.exists() {
                        let _ = std::fs::rename(&backup_path, &exe_path);
                    }
                    return Err(format!(
                        "Failed to install new core binary: {e}. Please close any running mihomo processes and try again."
                    ));
                }
                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            }
        }
    }

    // Step 2b: Set executable permissions (may fail on some platforms)
    if let Err(e) = install_core_binary(app) {
        // Rollback: remove failed binary, restore backup
        emit_error!(
            Updater,
            UPDATE_DOWNLOAD_FAILED,
            "install_core_binary failed: {e}, rolling back..."
        );
        let _ = std::fs::remove_file(&exe_path);
        if backup_path.exists() {
            let _ = std::fs::rename(&backup_path, &exe_path);
        }
        return Err(format!(
            "Failed to set executable permissions: {e}. Rolled back to previous version."
        ));
    }

    let (last_config, last_args, last_secret) = {
        let lock = state
            .0
            .lock()
            .map_err(|e| format!("Failed to lock state: {e}"))?;
        let config = lock
            .last_config_path()
            .map(String::from)
            .unwrap_or_else(|| "config.yaml".to_owned());
        let args = lock.last_custom_args().map(Vec::from).unwrap_or_default();
        let secret = if lock.last_secret().is_empty() {
            None
        } else {
            Some(lock.last_secret().to_owned())
        };
        (config, args, secret)
    };

    emit_core_download_status(&window, "Update complete, restarting core...", 98);

    let result = core_manager::start_core(
        app.clone(),
        state,
        last_config,
        false,
        last_args,
        last_secret,
        Some(true),
    )
    .await;
    match result {
        Ok(r) => {
            // Step 3: New core started — delete backup
            let _ = std::fs::remove_file(&backup_path);
            emit_core_download_status(&window, "Core ready", 100);
            Ok(r)
        }
        Err(e) => {
            // Step 4: Rollback — atomic rename swap
            emit_error!(
                Updater,
                UPDATE_DOWNLOAD_FAILED,
                "New core failed to start: {e}, attempting rollback..."
            );
            let rollback_ok = if backup_path.exists() {
                tokio::time::sleep(std::time::Duration::from_millis(300)).await;
                // Remove the failed new binary, then rename backup back
                let _ = std::fs::remove_file(&exe_path);
                std::fs::rename(&backup_path, &exe_path).is_ok()
            } else {
                false
            };
            if rollback_ok {
                Err(format!(
                    "New core failed to start: {e}. Rolled back to previous version. Please restart the application."
                ))
            } else {
                Err(format!(
                    "New core failed to start: {e}. Rollback not available — manual repair may be needed."
                ))
            }
        }
    }
}

/// Tauri command wrapper for `update_core_inner` with `catch_unwind` guard.
#[command]
pub async fn update_core(
    window: Window,
    state: State<'_, MihomoState>,
    url: String,
) -> Result<core_manager::CoreStartResult, String> {
    use futures_util::future::FutureExt as _;
    use std::panic::AssertUnwindSafe;

    AssertUnwindSafe(update_core_inner(window, state, url))
        .catch_unwind()
        .await
        .map_err(|payload| {
            let msg = crate::backend_event::panic_to_string(payload);
            crate::emit_error!(Updater, UPDATE_PANIC_GUARD, "Panic in update_core: {msg}");
            format!("Internal error in update_core: {msg}")
        })
        .and_then(std::convert::identity)
}

#[command]
pub async fn update_geo_data(window: Window) -> Result<String, String> {
    let app = window.app_handle();
    let paths = core_manager::ensure_app_storage(app)?;
    let client = build_github_client()?;

    let geoip_url =
        "https://github.com/MetaCubeX/meta-rules-dat/releases/latest/download/geoip.dat";
    let geoip_sha_url =
        "https://github.com/MetaCubeX/meta-rules-dat/releases/latest/download/geoip.dat.sha256sum";
    let geosite_url =
        "https://github.com/MetaCubeX/meta-rules-dat/releases/latest/download/geosite.dat";
    let geosite_sha_url = "https://github.com/MetaCubeX/meta-rules-dat/releases/latest/download/geosite.dat.sha256sum";

    // Fetch hashes first
    emit_core_download_status(&window, "Fetching verification info...", 5);

    let geoip_sha_res = client
        .get(geoip_sha_url)
        .send()
        .await
        .map_err(|e| format!("Failed to fetch GeoIP hash: {e}"))?;
    if !geoip_sha_res.status().is_success() {
        return Err(format!(
            "Failed to fetch GeoIP hash: HTTP {}",
            geoip_sha_res.status()
        ));
    }
    let geoip_sha_text = geoip_sha_res
        .text()
        .await
        .map_err(|e| format!("Failed to read GeoIP hash: {e}"))?;
    let geoip_expected_hash = geoip_sha_text
        .split_whitespace()
        .next()
        .ok_or("Invalid GeoIP hash format")?
        .to_owned();

    let geosite_sha_res = client
        .get(geosite_sha_url)
        .send()
        .await
        .map_err(|e| format!("Failed to fetch GeoSite hash: {e}"))?;
    if !geosite_sha_res.status().is_success() {
        return Err(format!(
            "Failed to fetch GeoSite hash: HTTP {}",
            geosite_sha_res.status()
        ));
    }
    let geosite_sha_text = geosite_sha_res
        .text()
        .await
        .map_err(|e| format!("Failed to read GeoSite hash: {e}"))?;
    let geosite_expected_hash = geosite_sha_text
        .split_whitespace()
        .next()
        .ok_or("Invalid GeoSite hash format")?
        .to_owned();

    // Use unpredictable temp file names to prevent TOCTOU attacks
    let temp_suffix = uuid::Uuid::new_v4();

    // Download GeoIP
    emit_core_download_status(&window, "Downloading GeoIP...", 10);
    let geoip_path = paths.core_dir.join(format!("geoip_{temp_suffix}.dat.tmp"));
    let response = client
        .get(geoip_url)
        .send()
        .await
        .map_err(|e| format!("Failed to download GeoIP: {e}"))?;

    if !response.status().is_success() {
        return Err(format!(
            "Failed to download GeoIP: HTTP {}",
            response.status()
        ));
    }

    let mut stream = response.bytes_stream();
    let mut file = std::fs::File::create(&geoip_path)
        .map_err(|e| format!("Failed to create geoip temp file: {e}"))?;

    while let Some(item) = stream.next().await {
        let chunk = match item {
            Ok(c) => c,
            Err(e) => {
                let _ = std::fs::remove_file(&geoip_path);
                return Err(e.to_string());
            }
        };
        use std::io::Write as _;
        if let Err(e) = file.write_all(&chunk) {
            let _ = std::fs::remove_file(&geoip_path);
            return Err(format!("Failed to write geoip chunk: {e}"));
        }
    }

    if let Err(e) = file.sync_all() {
        let _ = std::fs::remove_file(&geoip_path);
        return Err(e.to_string());
    }

    emit_core_download_status(&window, "Verifying GeoIP...", 45);
    verify_sha256(&geoip_path, &geoip_expected_hash).inspect_err(|e| {
        let _ = std::fs::remove_file(&geoip_path);
        let _ = e;
    })?;

    // Download GeoSite
    emit_core_download_status(&window, "Downloading GeoSite...", 50);
    let geosite_path = paths
        .core_dir
        .join(format!("geosite_{temp_suffix}.dat.tmp"));
    let response = client
        .get(geosite_url)
        .send()
        .await
        .map_err(|e| format!("Failed to download GeoSite: {e}"))?;

    if !response.status().is_success() {
        return Err(format!(
            "Failed to download GeoSite: HTTP {}",
            response.status()
        ));
    }

    let mut stream = response.bytes_stream();
    let mut file = std::fs::File::create(&geosite_path)
        .map_err(|e| format!("Failed to create geosite temp file: {e}"))?;

    while let Some(item) = stream.next().await {
        let chunk = match item {
            Ok(c) => c,
            Err(e) => {
                let _ = std::fs::remove_file(&geosite_path);
                return Err(e.to_string());
            }
        };
        use std::io::Write as _;
        if let Err(e) = file.write_all(&chunk) {
            let _ = std::fs::remove_file(&geosite_path);
            return Err(format!("Failed to write geosite chunk: {e}"));
        }
    }

    if let Err(e) = file.sync_all() {
        let _ = std::fs::remove_file(&geosite_path);
        return Err(e.to_string());
    }

    emit_core_download_status(&window, "Verifying GeoSite...", 90);
    verify_sha256(&geosite_path, &geosite_expected_hash).inspect_err(|e| {
        let _ = std::fs::remove_file(&geosite_path);
        let _ = e;
    })?;

    // Apply updates — atomic swap pattern with rollback on failure.
    // Both geo files must succeed or neither is applied.
    emit_core_download_status(&window, "Applying updates...", 95);
    let final_geoip = paths.core_dir.join("geoip.dat");
    let final_geosite = paths.core_dir.join("geosite.dat");

    // Use timestamped backup names to avoid stale backup conflicts
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let old_geoip = paths.core_dir.join(format!("geoip.dat.bak.{ts}"));
    let old_geosite = paths.core_dir.join(format!("geosite.dat.bak.{ts}"));

    // Move current files out of the way via rename (not copy).
    // This ensures the target path is free for the new file's rename.
    // Abort if rename fails — without backup, rollback is impossible.
    if final_geoip.exists() {
        std::fs::rename(&final_geoip, &old_geoip)
            .map_err(|e| format!("Failed to backup geoip.dat (update aborted for safety): {e}"))?;
    }
    if final_geosite.exists() {
        std::fs::rename(&final_geosite, &old_geosite).map_err(|e| {
            format!("Failed to backup geosite.dat (update aborted for safety): {e}")
        })?;
    }

    // Apply geoip (target path is now free)
    if let Err(e) = std::fs::rename(&geoip_path, &final_geoip) {
        // Restore old geoip (target should be free since rename failed)
        if old_geoip.exists() {
            let _ = std::fs::rename(&old_geoip, &final_geoip);
        }
        let _ = std::fs::remove_file(&geosite_path);
        let _ = std::fs::remove_file(&old_geosite);
        return Err(format!("Failed to apply geoip: {e}"));
    }

    // Apply geosite (target path is now free)
    if let Err(e) = std::fs::rename(&geosite_path, &final_geosite) {
        // geosite failed — rollback geoip too (both must succeed together)
        // Remove new geoip first so rename back won't hit "target exists"
        let _ = std::fs::remove_file(&final_geoip);
        if old_geoip.exists() {
            let _ = std::fs::rename(&old_geoip, &final_geoip);
        }
        if old_geosite.exists() {
            let _ = std::fs::rename(&old_geosite, &final_geosite);
        }
        let _ = std::fs::remove_file(&old_geoip);
        let _ = std::fs::remove_file(&old_geosite);
        return Err(format!(
            "Failed to apply geosite: {e}. Both geo files rolled back."
        ));
    }

    // Clean up backups
    let _ = std::fs::remove_file(&old_geoip);
    let _ = std::fs::remove_file(&old_geosite);

    emit_core_download_status(&window, "Geo database update complete", 100);
    Ok("Geo databases updated successfully".to_owned())
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Client (Zephyr) self-update
// ═══════════════════════════════════════════════════════════════════════════════

const ZEPHYR_RELEASE_API: &str = "https://api.github.com/repos/Juwan-Hwang/Zephyr/releases/latest";

/// Release info returned to the frontend for Zephyr client updates.
#[derive(Debug, Serialize)]
pub struct ClientUpdateInfo {
    pub version: String,
    pub download_url: String,
    pub release_notes: String,
    pub download_digest: Option<String>,
}

/// Determine the expected asset extension for the current platform.
const fn platform_asset_extensions() -> &'static [&'static str] {
    if cfg!(target_os = "windows") {
        &[".exe", ".msi"]
    } else if cfg!(target_os = "macos") {
        &[".dmg"]
    } else {
        &[".AppImage", ".deb"]
    }
}

/// Select the best installer asset from a GitHub release for the current platform.
fn select_client_asset(assets: &[GithubAsset]) -> Result<&GithubAsset, String> {
    let extensions = platform_asset_extensions();
    let target_triple = format!(
        "{}-{}",
        std::env::consts::OS,
        if std::env::consts::ARCH == "x86_64" {
            "x86_64"
        } else if std::env::consts::ARCH == "aarch64" {
            "aarch64"
        } else {
            std::env::consts::ARCH
        }
    );

    // First pass: try to find an asset matching the target triple
    for asset in assets {
        let lower = asset.name.to_lowercase();
        if extensions.iter().any(|ext| lower.ends_with(ext)) && lower.contains(&target_triple) {
            return Ok(asset);
        }
    }

    // Second pass: any asset with a matching extension
    for asset in assets {
        let lower = asset.name.to_lowercase();
        if extensions.iter().any(|ext| lower.ends_with(ext)) {
            return Ok(asset);
        }
    }

    Err("No suitable installer asset found for this platform".to_owned())
}

/// Check for the latest Zephyr client version.
#[command]
pub async fn get_latest_client_version() -> Result<ClientUpdateInfo, String> {
    let client = build_github_client()?;

    let response = client
        .get(ZEPHYR_RELEASE_API)
        .send()
        .await
        .map_err(|e| format!("Failed to fetch Zephyr release info: {e}"))?;

    if !response.status().is_success() {
        return Err(format!("GitHub API returned status: {}", response.status()));
    }

    let release: GithubRelease = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse Zephyr release info: {e}"))?;

    let asset = select_client_asset(&release.assets)?;
    let download_url = format!(
        "https://github.com/Juwan-Hwang/Zephyr/releases/download/{}/{}",
        release.tag_name, asset.name
    );

    let version = strip_version_prefix(&release.tag_name).to_owned();

    Ok(ClientUpdateInfo {
        version,
        download_url,
        release_notes: release.body.unwrap_or_default(),
        download_digest: asset.digest.clone(),
    })
}

/// Download and open the Zephyr client installer.
#[command]
pub async fn update_client(window: Window) -> Result<String, String> {
    // Portable mode: cannot self-update (exe is locked while running)
    if crate::core_manager::core::core_process::is_portable_mode() {
        return Err("Portable version does not support self-update. Please download the latest release manually.".to_owned());
    }

    emit_core_download_status(&window, "Checking for Zephyr updates...", 5);

    let info = get_latest_client_version().await?;

    // Compare with current version
    let current = env!("CARGO_PKG_VERSION");
    if info.version == current {
        return Ok("Already up to date".to_owned());
    }

    emit_core_download_status(&window, "Downloading Zephyr update...", 10);

    // Create temp directory for the installer
    let temp_dir = std::env::temp_dir().join(format!("zephyr_update_{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&temp_dir).map_err(|e| format!("Failed to create temp dir: {e}"))?;

    // Determine file extension from download URL
    let asset_name = info
        .download_url
        .rsplit('/')
        .next()
        .unwrap_or("Zephyr-installer");
    let dest_path = temp_dir.join(asset_name);

    // Download the installer
    download_release_asset(&window, &info.download_url, &dest_path).await?;

    // Verify SHA256 if digest is available from GitHub API
    if let Some(digest) = &info.download_digest {
        if let Some(hash) = digest
            .strip_prefix("sha256:")
            .filter(|h| h.len() == 64 && h.chars().all(|c| c.is_ascii_hexdigit()))
        {
            emit_core_download_status(&window, "Verifying installer integrity...", 93);
            verify_sha256(&dest_path, hash).map_err(|e| {
                let _ = std::fs::remove_file(&dest_path);
                format!("SHA256 verification failed: {e}. Installer deleted for security.")
            })?;
        }
    } else {
        // No digest available — refuse to open unverified installer for security
        let _ = std::fs::remove_file(&dest_path);
        return Err(
            "No integrity digest available for this release. Installer was deleted for security."
                .to_owned(),
        );
    }

    // Verify Minisign Ed25519 signature
    let minisig_url = format!("{}.minisig", info.download_url);
    emit_core_download_status(&window, "Downloading signature...", 94);

    let sig_client = build_github_client()?;
    let sig_response = sig_client.get(&minisig_url).send().await.map_err(|e| {
        let _ = std::fs::remove_file(&dest_path);
        format!("Failed to download signature: {e}. Installer deleted for security.")
    })?;

    if !sig_response.status().is_success() {
        let _ = std::fs::remove_file(&dest_path);
        return Err(
            "Minisign signature not available for this release. Installer was deleted for security."
                .to_owned(),
        );
    }

    // Stream signature with size limit (4 KB is more than enough for a Minisign signature)
    let mut sig_stream = sig_response.bytes_stream();
    let mut sig_bytes = Vec::new();
    const MAX_SIG_SIZE: usize = 4096;
    while let Some(chunk_result) = sig_stream.next().await {
        let chunk = chunk_result.map_err(|e| {
            let _ = std::fs::remove_file(&dest_path);
            format!("Failed to download signature chunk: {e}. Installer deleted for security.")
        })?;
        if sig_bytes.len() + chunk.len() > MAX_SIG_SIZE {
            let _ = std::fs::remove_file(&dest_path);
            return Err(
                "Signature file exceeded size limit. Installer deleted for security.".to_owned(),
            );
        }
        sig_bytes.extend_from_slice(&chunk);
    }
    let signature_content = String::from_utf8(sig_bytes).map_err(|e| {
        let _ = std::fs::remove_file(&dest_path);
        format!("Invalid UTF-8 in signature: {e}. Installer deleted for security.")
    })?;

    emit_core_download_status(&window, "Verifying signature...", 95);
    crate::minisign_verify::verify_minisign_signature(&dest_path, &signature_content).map_err(
        |e| {
            let _ = std::fs::remove_file(&dest_path);
            format!("{e}. Installer deleted for security.")
        },
    )?;

    emit_core_download_status(&window, "Opening installer...", 96);

    // Open the installer with the system default application
    tauri_plugin_opener::open_path(&dest_path, None::<&str>)
        .map_err(|e| format!("Failed to open installer: {e}"))?;

    emit_core_download_status(&window, "Installer launched", 100);

    Ok(format!(
        "Zephyr {} installer downloaded and opened",
        info.version
    ))
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn test_strip_lowercase_v() {
        assert_eq!(strip_version_prefix("v1.18.0"), "1.18.0");
    }

    #[test]
    fn test_strip_uppercase_v() {
        assert_eq!(strip_version_prefix("V1.18.0"), "1.18.0");
    }

    #[test]
    fn test_no_prefix() {
        assert_eq!(strip_version_prefix("1.18.0"), "1.18.0");
    }

    #[test]
    fn test_empty() {
        assert_eq!(strip_version_prefix(""), "");
    }

    #[test]
    fn test_only_v() {
        assert_eq!(strip_version_prefix("v"), "");
    }

    #[test]
    fn test_only_uppercase_v() {
        assert_eq!(strip_version_prefix("V"), "");
    }

    #[test]
    fn test_lowercase_v_priority_over_uppercase() {
        assert_eq!(strip_version_prefix("vV1.0"), "V1.0");
    }

    // ── select_release_asset_inner tests ──

    fn make_asset(name: &str) -> GithubAsset {
        GithubAsset {
            name: name.to_owned(),
            digest: None,
        }
    }

    /// Path 1: v3-capable CPU + v3 asset present → selects v3.
    #[test]
    fn test_select_asset_v3_on_v3_cpu() {
        let assets = vec![
            make_asset("mihomo-windows-amd64-v1.19.28.zip"),
            make_asset("mihomo-windows-amd64-compatible-v1.19.28.zip"),
            make_asset("mihomo-windows-amd64-v3-v1.19.28.zip"),
            make_asset("mihomo-windows-amd64-v3-go120-v1.19.28.zip"),
        ];
        let sel = select_release_asset_inner(&assets, "windows", "amd64", true).unwrap();
        assert_eq!(sel.name, "mihomo-windows-amd64-v3-v1.19.28.zip");
    }

    /// Path 2: non-v3 CPU → selects compatible.
    #[test]
    fn test_select_asset_compatible_on_old_cpu() {
        let assets = vec![
            make_asset("mihomo-windows-amd64-v1.19.28.zip"),
            make_asset("mihomo-windows-amd64-compatible-v1.19.28.zip"),
            make_asset("mihomo-windows-amd64-v3-v1.19.28.zip"),
        ];
        let sel = select_release_asset_inner(&assets, "windows", "amd64", false).unwrap();
        assert_eq!(sel.name, "mihomo-windows-amd64-compatible-v1.19.28.zip");
    }

    /// Path 3: ARM64 → selects plain arm64 asset (no variant logic).
    #[test]
    fn test_select_asset_arm64() {
        let assets = vec![
            make_asset("mihomo-linux-arm64-v1.19.28.gz"),
            make_asset("mihomo-windows-arm64-v1.19.28.zip"),
        ];
        let sel = select_release_asset_inner(&assets, "windows", "arm64", false).unwrap();
        assert_eq!(sel.name, "mihomo-windows-arm64-v1.19.28.zip");
    }

    /// Path 4: v3 CPU but v3 asset missing → falls back to compatible.
    #[test]
    fn test_select_asset_v3_missing_fallback() {
        let assets = vec![
            make_asset("mihomo-linux-amd64-v1.19.28.gz"),
            make_asset("mihomo-linux-amd64-compatible-v1.19.28.gz"),
            // No -v3- asset!
        ];
        let sel = select_release_asset_inner(&assets, "linux", "amd64", true).unwrap();
        assert_eq!(sel.name, "mihomo-linux-amd64-compatible-v1.19.28.gz");
    }

    /// Go-version variants (go120, go121, …) must never be selected.
    #[test]
    fn test_select_asset_excludes_go_variants() {
        let assets = vec![
            make_asset("mihomo-windows-amd64-v3-go120-v1.19.28.zip"),
            make_asset("mihomo-windows-amd64-v3-go124-v1.19.28.zip"),
            make_asset("mihomo-windows-amd64-compatible-v1.19.28.zip"),
        ];
        // v3 is "supported" but only go-variants exist → should fall back to compatible.
        let sel = select_release_asset_inner(&assets, "windows", "amd64", true).unwrap();
        assert_eq!(sel.name, "mihomo-windows-amd64-compatible-v1.19.28.zip");
    }

    /// No matching asset at all → error.
    #[test]
    fn test_select_asset_not_found() {
        let assets = vec![make_asset("mihomo-darwin-arm64-v1.19.28.gz")];
        let result = select_release_asset_inner(&assets, "windows", "amd64", true);
        assert!(result.is_err());
    }

    // ── construct_release_from_tag tests ──

    /// Constructing from a tag produces assets that `select_release_asset_inner` can resolve.
    #[test]
    fn test_construct_release_amd64_v3() {
        let release = construct_release_from_tag("v1.19.28").unwrap();
        assert_eq!(release.tag_name, "v1.19.28");
        // On amd64, should have v3, compatible, and plain variants.
        assert!(release.assets.len() >= 2);
        // select_release_asset_inner with supports_v3=true should pick v3.
        let (os_tag, arch_tag) = current_platform_tags().unwrap();
        if arch_tag == "amd64" {
            let sel = select_release_asset_inner(&release.assets, os_tag, arch_tag, true).unwrap();
            assert!(sel.name.contains("-v3-"));
        }
    }

    /// Atom feed XML parsing: extract tag from a minimal valid feed.
    #[test]
    fn test_atom_feed_parsing() {
        let xml = r#"<?xml version="1.0"?>
<feed>
  <entry>
    <id>tag:github.com,2008:repository/123</id>
    <title>v1.19.28</title>
  </entry>
  <entry>
    <title>v1.19.27</title>
  </entry>
</feed>"#;
        // Simulate the parsing logic (handles <title> and <title type="text">)
        let entry_start = xml.find("<entry>").unwrap();
        let entry_end = xml[entry_start..]
            .find("</entry>")
            .map(|i| entry_start + i)
            .unwrap();
        let entry = &xml[entry_start..entry_end];
        let title_open = entry.find("<title").unwrap();
        let title_content_start = entry[title_open..]
            .find('>')
            .map(|i| title_open + i + 1)
            .unwrap();
        let title_close = entry[title_content_start..]
            .find("</title>")
            .map(|i| title_content_start + i)
            .unwrap();
        let tag = entry[title_content_start..title_close].trim();
        assert_eq!(tag, "v1.19.28");
    }

    /// Atom feed with `<title type="text">` attribute (GitHub uses this).
    #[test]
    fn test_atom_feed_parsing_with_attributes() {
        let xml = r#"<?xml version="1.0"?>
<feed>
  <entry>
    <title type="text">v1.19.28</title>
  </entry>
</feed>"#;
        let entry_start = xml.find("<entry>").unwrap();
        let entry_end = xml[entry_start..]
            .find("</entry>")
            .map(|i| entry_start + i)
            .unwrap();
        let entry = &xml[entry_start..entry_end];
        let title_open = entry.find("<title").unwrap();
        let title_content_start = entry[title_open..]
            .find('>')
            .map(|i| title_open + i + 1)
            .unwrap();
        let title_close = entry[title_content_start..]
            .find("</title>")
            .map(|i| title_content_start + i)
            .unwrap();
        let tag = entry[title_content_start..title_close].trim();
        assert_eq!(tag, "v1.19.28");
    }

    // ── parse_digest tests ──

    #[test]
    fn test_parse_digest_valid() {
        let hash = "a".repeat(64);
        let digest = format!("sha256:{hash}");
        assert_eq!(parse_digest(&digest).as_deref(), Some(&hash[..]));
    }

    #[test]
    fn test_parse_digest_uppercase_normalised() {
        let hash = "A".repeat(64);
        let digest = format!("sha256:{hash}");
        assert_eq!(parse_digest(&digest).as_deref(), Some(&"a".repeat(64)[..]));
    }

    #[test]
    fn test_parse_digest_wrong_prefix() {
        assert_eq!(parse_digest("md5:abc"), None);
    }

    #[test]
    fn test_parse_digest_too_short() {
        assert_eq!(parse_digest("sha256:abc"), None);
    }

    #[test]
    fn test_parse_digest_non_hex() {
        let digest = format!("sha256:{}", "g".repeat(64));
        assert_eq!(parse_digest(&digest), None);
    }

    // ── cache_digests + get_expected_sha256 cache lookup tests ──

    #[test]
    fn test_cache_digests_populates_cache() {
        let release = GithubRelease {
            tag_name: "v1.19.28".to_owned(),
            assets: vec![
                GithubAsset {
                    name: "mihomo-windows-amd64-v3-v1.19.28.zip".to_owned(),
                    digest: Some(format!("sha256:{}", "a".repeat(64))),
                },
                GithubAsset {
                    name: "mihomo-linux-arm64-v1.19.28.gz".to_owned(),
                    digest: None,
                },
            ],
            body: None,
        };
        cache_digests(&release);

        // Clone out of the lock to avoid holding the MutexGuard.
        let (tag, digests) = DIGEST_CACHE.lock().unwrap().clone().unwrap();
        assert_eq!(tag, "v1.19.28");
        assert_eq!(digests.len(), 1); // Only the asset with a digest
        let first = digests.first().unwrap();
        assert_eq!(first.0, "mihomo-windows-amd64-v3-v1.19.28.zip");
    }

    /// Atom feed with no entries → error.
    #[test]
    fn test_atom_feed_no_entries() {
        let xml = r#"<?xml version="1.0"?><feed></feed>"#;
        assert!(!xml.contains("<entry>"));
    }
}
