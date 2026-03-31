use crate::core_manager::{self, MihomoState};
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
    #[allow(dead_code)]
    body: Option<String>,
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

const MIHOMO_RELEASE_API: &str = "https://api.github.com/repos/MetaCubeX/mihomo/releases/latest";

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
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())
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

fn build_asset_download_url(version: &str, asset_name: &str) -> String {
    format!(
        "https://github.com/MetaCubeX/mihomo/releases/download/{}/{}",
        version, asset_name
    )
}

async fn fetch_latest_release() -> Result<GithubRelease, String> {
    let client = build_github_client()?;
    
    let response = client
        .get(MIHOMO_RELEASE_API)
        .send()
        .await
        .map_err(|e| format!("Failed to fetch release info: {}", e))?;
    
    if !response.status().is_success() {
        return Err(format!("GitHub API returned status: {}", response.status()));
    }
    
    response.json::<GithubRelease>().await.map_err(|e| format!("Failed to parse release info: {}", e))
}

fn is_trusted_update_url(url: &str) -> bool {
    if let Ok(parsed) = reqwest::Url::parse(url) {
        if let Some(host) = parsed.host_str() {
            return TRUSTED_HOSTS.iter().any(|&h| host == h || host.ends_with(&format!(".{}", h)));
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

/// Fetch SHA256 hash from GitHub API asset digest field
async fn get_expected_sha256(version: &str, asset_name: &str) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .connect_timeout(Duration::from_secs(10))
        .user_agent("Zephyr-Update-Checker")
        .build()
        .map_err(|e| format!("Failed to build client: {}", e))?;

    let api_url = format!(
        "https://api.github.com/repos/MetaCubeX/mihomo/releases/tags/{}",
        version
    );
    
    let response = client.get(&api_url).send().await
        .map_err(|e| format!("Failed to fetch release info: {}", e))?;
    
    if !response.status().is_success() {
        return Err(format!("GitHub API returned status: {}", response.status()));
    }
    
    let json: serde_json::Value = response.json().await
        .map_err(|e| format!("Failed to parse JSON: {}", e))?;
    
    let assets = json["assets"].as_array()
        .ok_or_else(|| "No assets found in release".to_string())?;
    
    for asset in assets {
        if let Some(name) = asset["name"].as_str() {
            if name == asset_name {
                if let Some(digest) = asset["digest"].as_str() {
                    if digest.starts_with("sha256:") {
                        let hash = digest.strip_prefix("sha256:").unwrap_or(digest);
                        if hash.len() == 64 && hash.chars().all(|c| c.is_ascii_hexdigit()) {
                            return Ok(hash.to_lowercase());
                        }
                    }
                }
            }
        }
    }
    
    Err(format!("Could not find SHA256 hash for {}. Verification is required for security.", asset_name))
}

async fn download_release_asset(window: &Window, url: &str, dest_path: &std::path::Path) -> Result<(), String> {
    if !is_trusted_update_url(url) {
        return Err("Untrusted download URL: only github.com is allowed".to_string());
    }
    
    let client = build_github_client()?;
    emit_core_download_status(window, "正在从 GitHub 下载核心...", 24);
    
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Failed to download: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("Download failed with status: {}", response.status()));
    }

    let total_size = response.content_length().unwrap_or(0);
    if total_size > 100 * 1024 * 1024 {
        return Err(format!("Update package too large: {} bytes", total_size));
    }
    
    let mut downloaded = 0_u64;
    let mut stream = response.bytes_stream();
    let mut file = std::fs::File::create(dest_path)
        .map_err(|e| format!("Failed to create temp file: {}", e))?;

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
        emit_core_download_status(window, format!("正在下载核心... {}%", progress), progress);
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
    if version.contains("..") || version.contains('/') || version.contains('\\') 
        || version.contains('\0') || version.contains('<') || version.contains('>')
        || version.contains('|') || version.contains('&') || version.contains(';')
        || version.contains('$') || version.contains('`') || version.contains('\n')
        || version.contains('\r') {
        return false;
    }
    
    let version_part = &version[1..];
    let (main_version, _pre_release) = if let Some(idx) = version_part.find('-') {
        (&version_part[..idx], Some(&version_part[idx+1..]))
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

        if segments.len() >= 5 && 
           segments[0] == "MetaCubeX" && 
           segments[1] == "mihomo" && 
           segments[2] == "releases" && 
           segments[3] == "download" {
            let version = segments[4].to_string();
            let asset_name = segments[5].to_string();
            
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
        .ok_or_else(|| "Invalid update URL: only official MetaCubeX/mihomo GitHub releases are supported".to_string())?;

    let paths = core_manager::ensure_app_storage(&app)?;
    let archive_path = paths.core_dir.join("core_update.tmp");
    
    if let Err(e) = download_release_asset(&window, &url, &archive_path).await {
        let _ = std::fs::remove_file(&archive_path);
        return Err(e);
    }

    emit_core_download_status(&window, "正在验证文件完整性...", 82);
    let expected_hash = get_expected_sha256(&version, &asset_name).await?;
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
    
    // Stop core and wait for it to fully exit
    let _ = core_manager::stop_core(app.clone(), state.clone());
    
    // Wait for the process to fully exit (give it some time)
    std::thread::sleep(std::time::Duration::from_millis(500));
    
    let exe_path = paths.core_dir.join(core_manager::core_binary_name());
    
    // On Windows, try multiple times to replace the file
    let mut retries = 5;
    loop {
        if let Err(_e) = std::fs::rename(&temp_exe_path, &exe_path) {
            if let Err(e2) = std::fs::copy(&temp_exe_path, &exe_path) {
                retries -= 1;
                if retries == 0 {
                    let _ = std::fs::remove_file(&temp_exe_path);
                    return Err(format!("Failed to replace core binary: {}. Please close any running mihomo processes and try again.", e2));
                }
                std::thread::sleep(std::time::Duration::from_millis(500));
            } else {
                let _ = std::fs::remove_file(&temp_exe_path);
                break;
            }
        } else {
            let _ = std::fs::remove_file(&temp_exe_path);
            break;
        }
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
    emit_core_download_status(&window, "正在获取校验信息...", 5);
    
    let geoip_sha_res = client.get(geoip_sha_url).send().await
        .map_err(|e| format!("Failed to fetch GeoIP hash: {}", e))?;
    if !geoip_sha_res.status().is_success() {
        return Err(format!("Failed to fetch GeoIP hash: HTTP {}", geoip_sha_res.status()));
    }
    let geoip_sha_text = geoip_sha_res.text().await.map_err(|e| format!("Failed to read GeoIP hash: {}", e))?;
    let geoip_expected_hash = geoip_sha_text.split_whitespace().next().ok_or("Invalid GeoIP hash format")?.to_string();

    let geosite_sha_res = client.get(geosite_sha_url).send().await
        .map_err(|e| format!("Failed to fetch GeoSite hash: {}", e))?;
    if !geosite_sha_res.status().is_success() {
        return Err(format!("Failed to fetch GeoSite hash: HTTP {}", geosite_sha_res.status()));
    }
    let geosite_sha_text = geosite_sha_res.text().await.map_err(|e| format!("Failed to read GeoSite hash: {}", e))?;
    let geosite_expected_hash = geosite_sha_text.split_whitespace().next().ok_or("Invalid GeoSite hash format")?.to_string();

    // Download GeoIP
    emit_core_download_status(&window, "正在下载 GeoIP...", 10);
    let geoip_path = paths.core_dir.join("geoip.dat.tmp");
    let response = client.get(geoip_url).send().await
        .map_err(|e| format!("Failed to download GeoIP: {}", e))?;
    
    if !response.status().is_success() {
        return Err(format!("Failed to download GeoIP: HTTP {}", response.status()));
    }
    
    let mut stream = response.bytes_stream();
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

    emit_core_download_status(&window, "正在验证 GeoIP...", 45);
    verify_sha256(&geoip_path, &geoip_expected_hash).await.map_err(|e| {
        let _ = std::fs::remove_file(&geoip_path);
        e
    })?;

    // Download GeoSite
    emit_core_download_status(&window, "正在下载 GeoSite...", 50);
    let geosite_path = paths.core_dir.join("geosite.dat.tmp");
    let response = client.get(geosite_url).send().await
        .map_err(|e| format!("Failed to download GeoSite: {}", e))?;
    
    if !response.status().is_success() {
        return Err(format!("Failed to download GeoSite: HTTP {}", response.status()));
    }
    
    let mut stream = response.bytes_stream();
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

    emit_core_download_status(&window, "正在验证 GeoSite...", 90);
    verify_sha256(&geosite_path, &geosite_expected_hash).await.map_err(|e| {
        let _ = std::fs::remove_file(&geosite_path);
        e
    })?;

    // Apply updates
    emit_core_download_status(&window, "正在应用更新...", 95);
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

    emit_core_download_status(&window, "Geo 数据库更新完成", 100);
    Ok("Geo databases updated successfully".to_string())
}
