use crate::core_manager::{self, CoreStartResult, MihomoState};
use flate2::read::GzDecoder;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tauri::{command, Emitter, Manager, State, Window};

use sha2::{Sha256, Digest};
use std::io::Read;

#[derive(Debug, Deserialize, Serialize)]
pub struct UpdateInfo {
    pub version: String,
    pub download_url: String,
}

#[derive(Debug, Deserialize)]
struct GithubRelease {
    tag_name: String,
    assets: Vec<GithubAsset>,
}

#[derive(Debug, Deserialize)]
struct GithubAsset {
    name: String,
}

#[derive(Clone, Serialize)]
struct CoreDownloadStatus {
    status_text: String,
    progress: u8,
}

struct MirrorResponse {
    response: reqwest::Response,
    mirror_name: &'static str,
}

const MIHOMO_RELEASE_API: &str = "https://api.github.com/repos/MetaCubeX/mihomo/releases/latest";
const GITHUB_MIRROR_PREFIXES: [&str; 4] = [
    "",
    "https://ghproxy.net/",
    "https://gh-proxy.com/",
    "https://ghfast.top/",
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
        _ => return Err(format!("Unsupported OS: {}", os)),
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
        _ => return Err(format!("Unsupported ARCH: {}", arch)),
    };
    Ok((os_tag, arch_tag))
}

fn build_github_client() -> Result<reqwest::Client, String> {
    let version = env!("CARGO_PKG_VERSION");
    reqwest::Client::builder()
        .user_agent(format!("Zephyr/{}", version))
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())
}

fn mirror_name(prefix: &str) -> &'static str {
    match prefix {
        "" => "官方源",
        "https://ghproxy.net/" => "ghproxy.net",
        "https://gh-proxy.com/" => "gh-proxy.com",
        "https://ghfast.top/" => "ghfast.top",
        _ => "镜像源",
    }
}

fn with_mirror_prefix(prefix: &str, url: &str) -> String {
    if prefix.is_empty() {
        url.to_string()
    } else {
        format!("{}{}", prefix, url)
    }
}

fn emit_core_download_status(window: &Window, status_text: impl Into<String>, progress: u8) {
    let _ = window.emit(
        "core-download-status",
        CoreDownloadStatus {
            status_text: status_text.into(),
            progress,
        },
    );
}

fn emit_switching_status(window: Option<&Window>, mirror: &str, error: &str, progress: u8) {
    if let Some(window) = window {
        let status_text = if error.contains("timed out") || error.contains("deadline has elapsed") {
            format!("{}超时，切换镜像中...", mirror)
        } else if error.contains("Connection refused") || error.contains("connection refused") {
            format!("{}连接被拒绝，切换镜像中...", mirror)
        } else {
            format!("{}请求失败，切换镜像中...", mirror)
        };
        emit_core_download_status(window, status_text, progress);
    }
}

async fn request_with_mirror_fallback(
    client: &reqwest::Client,
    url: &str,
    window: Option<&Window>,
    loading_text: &str,
    progress: u8,
) -> Result<MirrorResponse, String> {
    let mut last_error = None;

    for prefix in GITHUB_MIRROR_PREFIXES {
        let current_mirror = mirror_name(prefix);
        if let Some(window) = window {
            emit_core_download_status(window, format!("正在通过 {}{}...", current_mirror, loading_text), progress);
        }

        let target_url = with_mirror_prefix(prefix, url);
        match client.get(&target_url).send().await {
            Ok(response) if response.status().is_success() => {
                return Ok(MirrorResponse {
                    response,
                    mirror_name: current_mirror,
                });
            }
            Ok(response) => {
                let error = format!("HTTP {}", response.status());
                last_error = Some(format!("{} returned {}", current_mirror, response.status()));
                emit_switching_status(window, current_mirror, &error, progress);
            }
            Err(error) => {
                let message = error.to_string();
                last_error = Some(format!("{} request failed: {}", current_mirror, message));
                emit_switching_status(window, current_mirror, &message, progress);
            }
        }
    }

    Err(last_error.unwrap_or_else(|| "All mirrors failed".to_string()))
}

fn build_asset_download_url(version: &str, asset_name: &str) -> String {
    format!(
        "https://github.com/MetaCubeX/mihomo/releases/download/{}/{}",
        version, asset_name
    )
}

async fn fetch_latest_release(window: Option<&Window>) -> Result<GithubRelease, String> {
    let client = build_github_client()?;
    let response = request_with_mirror_fallback(&client, MIHOMO_RELEASE_API, window, "拉取核心版本信息", 12).await?;
    response.response.json::<GithubRelease>().await.map_err(|e| e.to_string())
}

fn is_trusted_update_url(url: &str) -> bool {
    let trusted_hosts = [
        "github.com",
        "api.github.com",
        "ghproxy.net",
        "gh-proxy.com",
        "ghfast.top",
        "objects.githubusercontent.com",
    ];
    if let Ok(parsed) = reqwest::Url::parse(url) {
        if let Some(host) = parsed.host_str() {
            return trusted_hosts.iter().any(|&h| host == h || host.ends_with(&format!(".{}", h)));
        }
    }
    false
}

async fn verify_sha256(file_path: &std::path::Path, expected_hash: &str) -> Result<(), String> {
    let mut file = std::fs::File::open(file_path).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 8192];
    loop {
        let n = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if n == 0 { break; }
        hasher.update(&buffer[..n]);
    }
    let result = hasher.finalize();
    let hex_result = hex::encode(result);
    if hex_result.to_lowercase() == expected_hash.to_lowercase() {
        Ok(())
    } else {
        Err(format!("SHA256 mismatch: expected {}, got {}", expected_hash, hex_result))
    }
}

async fn get_expected_sha256(window: Option<&Window>, version: &str, asset_name: &str) -> Result<String, String> {
    let client = build_github_client()?;
    // For Mihomo, hashes are usually in sha256sum.txt
    let sha_url = build_asset_download_url(version, "sha256sum.txt");
    let response = request_with_mirror_fallback(&client, &sha_url, window, "正在校验哈希", 82).await?;
    let content = response.response.text().await.map_err(|e| e.to_string())?;
    
    for line in content.lines() {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() >= 2 && parts[1] == asset_name {
            return Ok(parts[0].to_string());
        }
    }
    Err(format!("Could not find hash for {} in sha256sum.txt", asset_name))
}

async fn download_release_asset(window: &Window, url: &str, dest_path: &std::path::Path) -> Result<(), String> {
    if !is_trusted_update_url(url) {
        return Err("Untrusted download URL".to_string());
    }
    let client = build_github_client()?;
    let response = request_with_mirror_fallback(&client, url, Some(window), "拉取核心", 24).await?;
    let mirror_name = response.mirror_name;
    let total_size = response.response.content_length().unwrap_or(0);
    if total_size > 100 * 1024 * 1024 {
        return Err(format!("Update package too large: {} bytes", total_size));
    }
    
    let mut downloaded = 0_u64;
    let mut stream = response.response.bytes_stream();
    let mut file = std::fs::File::create(dest_path).map_err(|e| format!("Failed to create temp file: {}", e))?;

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
            return Err("Update package exceeded size limit".to_string());
        }
        use std::io::Write;
        if let Err(e) = file.write_all(&chunk) {
            let _ = std::fs::remove_file(dest_path);
            return Err(format!("Failed to write chunk: {}", e));
        }

        let progress = if total_size > 0 {
            let ratio = downloaded as f64 / total_size as f64;
            (24.0 + ratio * 56.0).round().clamp(24.0, 80.0) as u8
        } else {
            52
        };
        emit_core_download_status(window, format!("正在通过 {} 拉取核心...", mirror_name), progress);
    }
    
    if let Err(e) = file.sync_all() {
        let _ = std::fs::remove_file(dest_path);
        return Err(e.to_string());
    }
    Ok(())
}

fn select_release_asset<'a>(assets: &'a [GithubAsset]) -> Result<&'a GithubAsset, String> {
    let (os_tag, arch_tag) = current_platform_tags()?;
    let key = format!("mihomo-{}-{}", os_tag, arch_tag);
    let is_windows = os_tag == "windows";
    let mut candidates = assets
        .iter()
        .filter(|a| a.name.contains(&key) && (a.name.ends_with(".zip") || a.name.ends_with(".gz")))
        .collect::<Vec<_>>();
    if is_windows {
        candidates.sort_by_key(|a| if a.name.contains("compatible") { 0 } else { 1 });
    }
    candidates
        .into_iter()
        .next()
        .ok_or_else(|| format!("Could not find release asset for {}-{}", os_tag, arch_tag))
}

fn extract_from_zip(archive_path: &std::path::Path, exe_path: &std::path::Path) -> Result<(), String> {
    let file = std::fs::File::open(archive_path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| format!("Failed to read ZIP: {}", e))?;
    let expected = core_manager::core_binary_name();

    for i in 0..archive.len() {
        let mut file = archive.by_index(i).map_err(|e| e.to_string())?;
        let name = file.name();
        if name.contains("..") || name.starts_with('/') || name.starts_with('\\') {
            return Err(format!("Malicious ZIP path detected: {}", name));
        }
        let lower = name.to_lowercase();
        #[cfg(target_os = "windows")]
        let matched = lower.ends_with(".exe");
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        let matched = lower.ends_with("/mihomo") || lower == "mihomo";
        if matched || lower.ends_with(expected) {
            let mut out_file = std::fs::File::create(exe_path).map_err(|e| e.to_string())?;
            let written = std::io::copy(&mut file, &mut out_file).map_err(|e| e.to_string())?;
            if written == 0 {
                return Err("Extracted core binary is empty".to_string());
            }
            return Ok(());
        }
    }
    Err("No executable found in ZIP".to_string())
}

fn extract_from_gz(archive_path: &std::path::Path, exe_path: &std::path::Path) -> Result<(), String> {
    let file = std::fs::File::open(archive_path).map_err(|e| e.to_string())?;
    let mut decoder = GzDecoder::new(file);
    
    let temp_tar_path = archive_path.with_extension("tar");
    let mut temp_decompressed = std::fs::File::create(&temp_tar_path).map_err(|e| e.to_string())?;
    let mut total_decompressed = 0_u64;
    let mut buffer = [0u8; 8192];
    use std::io::{Read, Write, Seek, SeekFrom};
    loop {
        let n = decoder.read(&mut buffer).map_err(|e| e.to_string())?;
        if n == 0 { break; }
        total_decompressed += n as u64;
        if total_decompressed > 200 * 1024 * 1024 {
            let _ = std::fs::remove_file(&temp_tar_path);
            return Err("Decompressed gz too large".to_string());
        }
        temp_decompressed.write_all(&buffer[..n]).map_err(|e| e.to_string())?;
    }
    temp_decompressed.sync_all().map_err(|e| e.to_string())?;
    
    let mut decomp_file = std::fs::File::open(&temp_tar_path).map_err(|e| e.to_string())?;
    let mut magic = [0u8; 265];
    let n = decomp_file.read(&mut magic).unwrap_or(0);
    decomp_file.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
    
    if n >= 262 && &magic[257..262] == b"ustar" {
        let mut archive = tar::Archive::new(decomp_file);
        let expected = core_manager::core_binary_name();
        for entry in archive.entries().map_err(|e| format!("Failed to parse tar entries: {}", e))? {
            let mut entry = entry.map_err(|e| e.to_string())?;
            let path = entry.path().map_err(|e| e.to_string())?;
            let path_str = path.to_string_lossy().replace('\\', "/");
            let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
            if path_str.contains("..") || path_str.starts_with('/') {
                let _ = std::fs::remove_file(&temp_tar_path);
                return Err(format!("Malicious TAR path detected: {}", path_str));
            }
            #[cfg(target_os = "windows")]
            let matched = file_name.eq_ignore_ascii_case(expected);
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            let matched = file_name == expected;
            if matched {
                let mut out_file = std::fs::File::create(exe_path).map_err(|e| e.to_string())?;
                let written = std::io::copy(&mut entry, &mut out_file).map_err(|e| e.to_string())?;
                let _ = std::fs::remove_file(&temp_tar_path);
                if written == 0 {
                    return Err("Extracted core binary is empty".to_string());
                }
                return Ok(());
            }
        }
        let _ = std::fs::remove_file(&temp_tar_path);
        return Err("No executable found in tar.gz".to_string());
    } else {
        let mut out_file = std::fs::File::create(exe_path).map_err(|e| e.to_string())?;
        std::io::copy(&mut decomp_file, &mut out_file).map_err(|e| e.to_string())?;
        let _ = std::fs::remove_file(&temp_tar_path);
        Ok(())
    }
}

fn extract_core_binary(archive_path: &std::path::Path, exe_path: &std::path::Path, url: &str) -> Result<(), String> {
    if url.ends_with(".zip") {
        return extract_from_zip(archive_path, exe_path);
    }
    if url.ends_with(".gz") {
        return extract_from_gz(archive_path, exe_path);
    }
    Err("Unsupported asset format, expected .zip or .gz".to_string())
}

fn install_core_binary(_app: &tauri::AppHandle) -> Result<(), String> {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        let paths = core_manager::ensure_app_storage(_app)?;
        let core_path = paths.core_dir.join(core_manager::core_binary_name());
        core_manager::ensure_executable(&core_path)?;
    }

    Ok(())
}

async fn ensure_core_ready(app: &tauri::AppHandle, window: &Window) -> Result<bool, String> {
    let paths = core_manager::ensure_app_storage(app)?;
    let core_path = paths.core_dir.join(core_manager::core_binary_name());

    if core_path.exists() {
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        core_manager::ensure_executable(&core_path)?;
        return Ok(false);
    }

    emit_core_download_status(window, "未检测到 Mihomo 核心，准备自动下载...", 6);
    let release = fetch_latest_release(Some(window)).await?;
    let asset = select_release_asset(&release.assets)?;
    let download_url = build_asset_download_url(&release.tag_name, &asset.name);

    emit_core_download_status(window, format!("已定位最新版本 {}，准备下载...", release.tag_name), 18);
    let archive_path = paths.core_dir.join("core_download.tmp");
    if let Err(e) = download_release_asset(window, &download_url, &archive_path).await {
        let _ = std::fs::remove_file(&archive_path);
        return Err(e);
    }

    let expected_hash = get_expected_sha256(Some(window), &release.tag_name, &asset.name).await?;
    verify_sha256(&archive_path, &expected_hash).await.map_err(|e| {
        let _ = std::fs::remove_file(&archive_path);
        e
    })?;

    emit_core_download_status(window, "下载完成，正在解压核心...", 84);
    let exe_path = paths.core_dir.join(core_manager::core_binary_name());
    if let Err(e) = extract_core_binary(&archive_path, &exe_path, &download_url) {
        let _ = std::fs::remove_file(&archive_path);
        return Err(e);
    }
    let _ = std::fs::remove_file(&archive_path);

    emit_core_download_status(window, "正在写入核心文件...", 90);
    install_core_binary(app)?;

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    emit_core_download_status(window, "正在设置核心执行权限...", 96);

    Ok(true)
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
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .map_err(|e| e.to_string())?;

    let verge_res = match client.get("https://api.github.com/repos/clash-verge-rev/clash-verge-rev/releases/latest").send().await {
        Ok(res) if res.status().is_success() => {
            if let Ok(release) = res.json::<GithubRelease>().await {
                let mut tag = release.tag_name;
                if tag.starts_with('v') || tag.starts_with('V') { tag.remove(0); }
                tag
            } else { "1.7.5".to_string() }
        }
        _ => "1.7.5".to_string()
    };

    let party_res = match client.get("https://api.github.com/repos/mihomo-party-org/mihomo-party/releases/latest").send().await {
        Ok(res) if res.status().is_success() => {
            if let Ok(release) = res.json::<GithubRelease>().await {
                let mut tag = release.tag_name;
                if tag.starts_with('v') || tag.starts_with('V') { tag.remove(0); }
                tag
            } else { "1.0.0".to_string() }
        }
        _ => "1.0.0".to_string()
    };

    let flclash_res = match client.get("https://api.github.com/repos/chen08209/Flclash/releases/latest").send().await {
        Ok(res) if res.status().is_success() => {
            if let Ok(release) = res.json::<GithubRelease>().await {
                let mut tag = release.tag_name;
                if tag.starts_with('v') || tag.starts_with('V') { tag.remove(0); }
                tag
            } else { "0.8.92".to_string() }
        }
        _ => "0.8.92".to_string()
    };

    Ok(ClientVersions {
        verge: format!("clash-verge/{}", verge_res),
        mihomo_party: format!("mihomo-party/{}", party_res),
        flclash: format!("Flclash/{}", flclash_res),
    })
}

#[command]
pub async fn get_latest_version() -> Result<UpdateInfo, String> {
    let release = fetch_latest_release(None).await?;
    let asset = select_release_asset(&release.assets)?;
    let version = release.tag_name;

    Ok(UpdateInfo {
        download_url: build_asset_download_url(&version, &asset.name),
        version,
    })
}

#[command]
pub async fn bootstrap_core(
    window: Window,
    state: State<'_, MihomoState>,
    config_path: String,
    custom_args: Vec<String>,
) -> Result<CoreStartResult, String> {
    let app = window.app_handle();
    let downloaded = ensure_core_ready(&app, &window).await?;
    if downloaded {
        emit_core_download_status(&window, "核心已就绪，正在启动服务...", 98);
    }
    let result = core_manager::start_core(app.clone(), state, config_path, false, custom_args, None).await?;
    if downloaded {
        emit_core_download_status(&window, "核心已就绪", 100);
    }
    Ok(result)
}

/// Validates that a version string follows the semantic versioning pattern
/// Expected format: vMAJOR.MINOR.PATCH or vMAJOR.MINOR.PATCH-prerelease
/// Examples: v1.18.3, v1.0.0-beta.1, v2.0.0-alpha
fn validate_version_format(version: &str) -> bool {
    // Must start with 'v' followed by digit
    if !version.starts_with('v') {
        return false;
    }
    
    // Length check
    if version.len() < 3 || version.len() > 25 {
        return false;
    }
    
    // Security: reject path traversal and special characters
    if version.contains("..") || version.contains('/') || version.contains('\\') 
        || version.contains('\0') || version.contains('<') || version.contains('>')
        || version.contains('|') || version.contains('&') || version.contains(';')
        || version.contains('$') || version.contains('`') || version.contains('\n')
        || version.contains('\r') {
        return false;
    }
    
    // The part after 'v' should match semantic versioning
    let version_part = &version[1..];
    
    // Split by '-' to handle pre-release
    let (main_version, _pre_release) = if let Some(idx) = version_part.find('-') {
        (&version_part[..idx], Some(&version_part[idx+1..]))
    } else {
        (version_part, None)
    };
    
    // Main version should be MAJOR.MINOR.PATCH
    let parts: Vec<&str> = main_version.split('.').collect();
    if parts.len() != 3 {
        return false;
    }
    
    // Each part should be a valid number
    for part in parts {
        if part.is_empty() || !part.chars().all(|c| c.is_ascii_digit()) {
            return false;
        }
    }
    
    true
}

fn parse_github_release_info(url: &str) -> Option<(String, String)> {
    if let Ok(parsed) = reqwest::Url::parse(url) {
        let segments: Vec<&str> = parsed.path_segments()?.collect();
        // GitHub release download URL pattern
        // MetaCubeX/mihomo/releases/download/v1.18.3/mihomo-linux-amd64.gz
        // Or with mirror prefix: ghproxy.net/https://github.com/MetaCubeX/mihomo/releases/download/v1.18.3/mihomo-linux-amd64.gz
        
        // Handle mirror prefix
        let (segments, start_idx) = if segments.len() >= 7 && segments[1] == "https:" && segments[2] == "" && segments[3] == "github.com" {
            (segments, 4)
        } else if segments.len() >= 5 {
            (segments, 0)
        } else {
            return None;
        };

        if segments.len() >= start_idx + 5 && 
           segments[start_idx] == "MetaCubeX" && 
           segments[start_idx+1] == "mihomo" && 
           segments[start_idx+2] == "releases" && 
           segments[start_idx+3] == "download" {
            let version = segments[start_idx+4].to_string();
            let asset_name = segments[start_idx+5].to_string();
            
            // Enhanced version validation using dedicated function
            if !validate_version_format(&version) {
                return None;
            }
            
            // Validate asset name: should be a valid mihomo release asset
            let asset_lower = asset_name.to_lowercase();
            if !asset_lower.starts_with("mihomo-") {
                return None;
            }
            if !asset_lower.ends_with(".zip") && !asset_lower.ends_with(".gz") {
                return None;
            }
            // Security: reject suspicious characters in asset name
            if asset_name.contains("..") || asset_name.contains('/') || asset_name.contains('\\')
                || asset_name.contains('\0') || asset_name.contains('<') || asset_name.contains('>') {
                return None;
            }
            
            return Some((version, asset_name));
        }
    }
    None
}

#[command]
pub async fn update_core(
    window: Window,
    state: State<'_, MihomoState>,
    url: String,
) -> Result<core_manager::CoreStartResult, String> {
    let app = window.app_handle();
    emit_core_download_status(&window, "正在准备更新 Mihomo 核心...", 4);
    
    let (version, asset_name) = parse_github_release_info(&url)
        .ok_or_else(|| "Invalid update URL format: only official MetaCubeX/mihomo releases are supported".to_string())?;

    let paths = core_manager::ensure_app_storage(&app)?;
    let archive_path = paths.core_dir.join("core_update.tmp");
    if let Err(e) = download_release_asset(&window, &url, &archive_path).await {
        let _ = std::fs::remove_file(&archive_path);
        return Err(e);
    }

    let expected_hash = get_expected_sha256(Some(&window), &version, &asset_name).await?;
    verify_sha256(&archive_path, &expected_hash).await.map_err(|e| {
        let _ = std::fs::remove_file(&archive_path);
        e
    })?;
    
    emit_core_download_status(&window, "下载完成，正在解压核心...", 84);
    let temp_exe_path = paths.core_dir.join(format!("{}.tmp", core_manager::core_binary_name()));
    if let Err(e) = extract_core_binary(&archive_path, &temp_exe_path, &url) {
        let _ = std::fs::remove_file(&archive_path);
        let _ = std::fs::remove_file(&temp_exe_path);
        return Err(e);
    }
    let _ = std::fs::remove_file(&archive_path);
    
    emit_core_download_status(&window, "正在写入核心文件...", 92);
    
    // Stop core only after successfully extracting the new binary
    let _ = core_manager::stop_core(app.clone(), state.clone());
    
    let exe_path = paths.core_dir.join(core_manager::core_binary_name());
    if let Err(_e) = std::fs::rename(&temp_exe_path, &exe_path) {
        // Fallback to copy then delete if rename fails across filesystems
        if let Err(e2) = std::fs::copy(&temp_exe_path, &exe_path) {
            let _ = std::fs::remove_file(&temp_exe_path);
            return Err(format!("Failed to replace core binary: {}", e2));
        }
        let _ = std::fs::remove_file(&temp_exe_path);
    }
    
    install_core_binary(&app)?;

    let (last_config, last_args, last_secret) = {
        let lock = state.0.lock().map_err(|_| "Failed to lock state")?;
        let config = lock.last_config_path.clone().unwrap_or_else(|| "config.yaml".to_string());
        let args = lock.last_custom_args.clone().unwrap_or_default();
        let secret = if lock.last_secret.is_empty() { None } else { Some(lock.last_secret.clone()) };
        (config, args, secret)
    };

    emit_core_download_status(&window, "更新完成，正在重启核心...", 98);
    let result = core_manager::start_core(app.clone(), state, last_config, false, last_args, last_secret).await?;
    emit_core_download_status(&window, "核心已就绪", 100);

    Ok(result)
}

#[command]
pub async fn update_geo_data(window: Window) -> Result<String, String> {
    let app = window.app_handle();
    let paths = core_manager::ensure_app_storage(app)?;
    let client = build_github_client()?;

    let geoip_url = "https://github.com/MetaCubeX/meta-rules-dat/releases/latest/download/geoip.dat";
    let geoip_sha_url = "https://github.com/MetaCubeX/meta-rules-dat/releases/latest/download/geoip.dat.sha256sum";
    let geosite_url = "https://github.com/MetaCubeX/meta-rules-dat/releases/latest/download/geosite.dat";
    let geosite_sha_url = "https://github.com/MetaCubeX/meta-rules-dat/releases/latest/download/geosite.dat.sha256sum";

    // Fetch hashes first
    let geoip_sha_res = request_with_mirror_fallback(&client, geoip_sha_url, None, "拉取 GeoIP Hash", 5).await?;
    let geoip_sha_text = geoip_sha_res.response.text().await.map_err(|e| format!("Failed to read GeoIP hash: {}", e))?;
    let geoip_expected_hash = geoip_sha_text.split_whitespace().next().ok_or("Invalid GeoIP hash format")?.to_string();

    let geosite_sha_res = request_with_mirror_fallback(&client, geosite_sha_url, None, "拉取 GeoSite Hash", 5).await?;
    let geosite_sha_text = geosite_sha_res.response.text().await.map_err(|e| format!("Failed to read GeoSite hash: {}", e))?;
    let geosite_expected_hash = geosite_sha_text.split_whitespace().next().ok_or("Invalid GeoSite hash format")?.to_string();

    // Download GeoIP
    let geoip_path = paths.core_dir.join("geoip.dat.tmp");
    let response = request_with_mirror_fallback(&client, geoip_url, None, "拉取 GeoIP", 10).await?;
    
    let mut stream = response.response.bytes_stream();
    let mut file = std::fs::File::create(&geoip_path).map_err(|e| format!("Failed to create geoip temp file: {}", e))?;

    while let Some(item) = stream.next().await {
        let chunk = match item {
            Ok(c) => c,
            Err(e) => {
                let _ = std::fs::remove_file(&geoip_path);
                return Err(e.to_string());
            }
        };
        use std::io::Write;
        if let Err(e) = file.write_all(&chunk) {
            let _ = std::fs::remove_file(&geoip_path);
            return Err(format!("Failed to write geoip chunk: {}", e));
        }
    }
    
    if let Err(e) = file.sync_all() {
        let _ = std::fs::remove_file(&geoip_path);
        return Err(e.to_string());
    }

    verify_sha256(&geoip_path, &geoip_expected_hash).await.map_err(|e| {
        let _ = std::fs::remove_file(&geoip_path);
        e
    })?;

    // Download GeoSite
    let geosite_path = paths.core_dir.join("geosite.dat.tmp");
    let response = request_with_mirror_fallback(&client, geosite_url, None, "拉取 GeoSite", 50).await?;
    
    let mut stream = response.response.bytes_stream();
    let mut file = std::fs::File::create(&geosite_path).map_err(|e| format!("Failed to create geosite temp file: {}", e))?;

    while let Some(item) = stream.next().await {
        let chunk = match item {
            Ok(c) => c,
            Err(e) => {
                let _ = std::fs::remove_file(&geosite_path);
                return Err(e.to_string());
            }
        };
        use std::io::Write;
        if let Err(e) = file.write_all(&chunk) {
            let _ = std::fs::remove_file(&geosite_path);
            return Err(format!("Failed to write geosite chunk: {}", e));
        }
    }
    
    if let Err(e) = file.sync_all() {
        let _ = std::fs::remove_file(&geosite_path);
        return Err(e.to_string());
    }

    verify_sha256(&geosite_path, &geosite_expected_hash).await.map_err(|e| {
        let _ = std::fs::remove_file(&geosite_path);
        e
    })?;

    // Apply updates
    let final_geoip = paths.core_dir.join("geoip.dat");
    let final_geosite = paths.core_dir.join("geosite.dat");
    
    if final_geoip.exists() {
        let _ = std::fs::remove_file(&final_geoip);
    }
    if final_geosite.exists() {
        let _ = std::fs::remove_file(&final_geosite);
    }
    
    std::fs::rename(&geoip_path, &final_geoip).map_err(|e| format!("Failed to apply geoip: {}", e))?;
    std::fs::rename(&geosite_path, &final_geosite).map_err(|e| format!("Failed to apply geosite: {}", e))?;

    Ok("Geo databases updated successfully".to_string())
}
