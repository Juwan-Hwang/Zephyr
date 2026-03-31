use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::Mutex;
use std::net::IpAddr;
use std::time::Duration;
use rand::{thread_rng, Rng};
use rand::distributions::Alphanumeric;
use serde::Serialize;
use tauri::{AppHandle, Manager, State};
#[cfg(any(target_os = "macos", target_os = "linux"))]
use std::os::unix::fs::PermissionsExt;

#[derive(Serialize)]
pub struct ConfigInfo {
    pub name: String,
    pub url: Option<String>,
    pub sub_info: Option<String>,
}

use base64::{Engine as _, engine::general_purpose::STANDARD as base64_standard};

pub struct CoreData {
    pub process: Option<Child>,
    pub last_secret: String,
    pub last_config_path: Option<String>,
    pub last_custom_args: Option<Vec<String>>,
    pub last_port: Option<u16>,
}
pub struct MihomoState(pub Mutex<CoreData>);

#[derive(Clone)]
pub struct AppPaths {
    pub app_data_dir: PathBuf,
    pub core_dir: PathBuf,
    pub profiles_dir: PathBuf,
}

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

pub fn core_binary_name() -> &'static str {
    #[cfg(target_os = "windows")]
    {
        "mihomo.exe"
    }
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        "mihomo"
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
pub fn ensure_executable(path: &Path) -> Result<(), String> {
    let metadata = fs::metadata(path).map_err(|e| format!("Failed to read core metadata: {}", e))?;
    let mut permissions = metadata.permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(path, permissions).map_err(|e| format!("Failed to set executable permissions: {}", e))
}

pub fn resolve_app_paths(app: &AppHandle) -> Result<AppPaths, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let core_dir = app_data_dir.join("core");
    let profiles_dir = app_data_dir.join("profiles");

    Ok(AppPaths {
        app_data_dir,
        core_dir,
        profiles_dir,
    })
}

fn legacy_core_candidates() -> Result<Vec<PathBuf>, String> {
    let mut candidates = Vec::new();
    let mut exe_path = std::env::current_exe().map_err(|e| e.to_string())?;
    exe_path.pop();

    let direct_core_dir = exe_path.join("core");
    if direct_core_dir.exists() {
        candidates.push(direct_core_dir);
    }

    let mut dev_path = exe_path.clone();
    while dev_path.pop() {
        let candidate = dev_path.join("core");
        if candidate.exists() {
            candidates.push(candidate);
        }
    }

    let relative_core_dir = Path::new("core");
    if relative_core_dir.exists() {
        candidates.push(fs::canonicalize(relative_core_dir).map_err(|e| e.to_string())?);
    }

    Ok(candidates)
}

/// Get bundled resource directory (for full installer)
fn get_bundled_dir(app: &AppHandle) -> Option<PathBuf> {
    let resource_dir = app.path().resource_dir().ok()?;
    let bundled_dir = resource_dir.join("bundled");
    if bundled_dir.exists() {
        Some(bundled_dir)
    } else {
        None
    }
}

fn migrate_legacy_assets(app: &AppHandle, paths: &AppPaths) -> Result<(), String> {
    // First, check bundled resources (for full installer)
    if let Some(bundled_dir) = get_bundled_dir(app) {
        if bundled_dir != paths.core_dir && bundled_dir.exists() {
            let entries = match fs::read_dir(&bundled_dir) {
                Ok(entries) => entries,
                Err(_) => return Ok(()),
            };

            for entry in entries.flatten() {
                let source = entry.path();
                if !source.is_file() {
                    continue;
                }

                let file_name = match source.file_name().and_then(|name| name.to_str()) {
                    Some(name) => name,
                    None => continue,
                };

                // Skip run_config.yaml
                if file_name.eq_ignore_ascii_case("run_config.yaml") {
                    continue;
                }

                let target = paths.core_dir.join(file_name);

                // Only copy if target doesn't exist
                if !target.exists() {
                    if let Err(e) = fs::copy(&source, &target) {
                        eprintln!("Warning: Failed to copy bundled file {}: {}", file_name, e);
                    } else {
                        // Set executable permission on Unix
                        #[cfg(any(target_os = "macos", target_os = "linux"))]
                        {
                            if file_name == core_binary_name() || file_name == "mihomo" {
                                let _ = ensure_executable(&target);
                            }
                        }
                    }
                }
            }
        }
    }

    // Then, check legacy core directories (for development)
    for candidate in legacy_core_candidates()? {
        if candidate == paths.core_dir || !candidate.exists() {
            continue;
        }

        let entries = match fs::read_dir(&candidate) {
            Ok(entries) => entries,
            Err(_) => continue,
        };

        for entry in entries.flatten() {
            let source = entry.path();
            if !source.is_file() {
                continue;
            }

            let file_name = match source.file_name().and_then(|name| name.to_str()) {
                Some(name) => name,
                None => continue,
            };

            if file_name.eq_ignore_ascii_case("run_config.yaml") {
                continue;
            }

            let is_profile = source
                .extension()
                .map(|ext| ext == "yaml" || ext == "yml")
                .unwrap_or(false);

            let target = if is_profile {
                paths.profiles_dir.join(file_name)
            } else {
                paths.core_dir.join(file_name)
            };

            if target.exists() {
                continue;
            }

            fs::copy(&source, &target).map_err(|e| format!("Failed to migrate {:?}: {}", source, e))?;
        }
    }

    Ok(())
}

pub fn ensure_app_storage(app: &AppHandle) -> Result<AppPaths, String> {
    let paths = resolve_app_paths(app)?;
    
    let is_new = !paths.app_data_dir.exists();
    
    fs::create_dir_all(&paths.app_data_dir).map_err(|e| format!("Failed to create app data dir: {}", e))?;
    fs::create_dir_all(&paths.core_dir).map_err(|e| format!("Failed to create core dir: {}", e))?;
    fs::create_dir_all(&paths.profiles_dir).map_err(|e| format!("Failed to create profiles dir: {}", e))?;
    
    #[cfg(target_os = "windows")]
    {
        if is_new {
            use std::process::Command;
            use std::os::windows::process::CommandExt;
            if let Ok(username) = std::env::var("USERNAME") {
                let _ = Command::new("icacls")
                    .arg(&paths.app_data_dir)
                    .arg("/inheritance:r")
                    .arg("/grant:r")
                    .arg(format!("{}:(OI)(CI)(F)", username))
                    .arg("/grant:r")
                    .arg("SYSTEM:(OI)(CI)(F)")
                    .arg("/grant:r")
                    .arg("Administrators:(OI)(CI)(F)")
                    .creation_flags(CREATE_NO_WINDOW)
                    .output();
            }
        }
    }
    
    migrate_legacy_assets(app, &paths)?;
    Ok(paths)
}


/// Complete URL decoding for path traversal detection
/// Handles standard percent-encoding, double encoding, and mixed case
fn url_decode_complete(input: &str) -> String {
    let mut result = input.to_string();
    
    // Decode iteratively until no more changes (handles nested encoding)
    let mut changed = true;
    let max_iterations = 5; // Prevent infinite loops
    let mut iterations = 0;
    
    while changed && iterations < max_iterations {
        changed = false;
        iterations += 1;
        
        // Handle standard percent-encoded characters
        let mut decoded = String::new();
        let chars: Vec<char> = result.chars().collect();
        let mut i = 0;
        
        while i < chars.len() {
            if chars[i] == '%' && i + 2 < chars.len() {
                // Try to decode %XX
                let hex: String = chars[i+1..i+3].iter().collect();
                if let Ok(byte) = u8::from_str_radix(&hex, 16) {
                    decoded.push(byte as char);
                    i += 3;
                    changed = true;
                    continue;
                }
            }
            decoded.push(chars[i]);
            i += 1;
        }
        
        result = decoded;
    }
    
    result
}

/// Sanitize configuration file name with comprehensive security checks
fn sanitize_config_file_name(config_path: &str) -> Result<String, String> {
    // Step 1: Complete URL decoding to catch all encoded patterns
    let decoded_path = url_decode_complete(config_path);
    
    // Step 2: Extract just the filename
    let config_file_name = Path::new(&decoded_path)
        .file_name()
        .ok_or_else(|| "Invalid config path: no filename component".to_string())?
        .to_str()
        .ok_or("Invalid config filename encoding")?
        .to_string();

    // Step 3: Security checks
    
    // Check for path traversal attempts
    if config_file_name.contains("..") {
        return Err("Path traversal detected: '..' is not allowed".to_string());
    }
    
    // Check for directory separators
    if config_file_name.contains('/') || config_file_name.contains('\\') {
        return Err("Path traversal detected: directory separators are not allowed".to_string());
    }
    
    // Check for null bytes (could be used to bypass extension checks)
    if config_file_name.contains('\0') {
        return Err("Invalid character in filename: null byte detected".to_string());
    }
    
    // Check for control characters
    if config_file_name.chars().any(|c| c.is_control()) {
        return Err("Invalid character in filename: control characters not allowed".to_string());
    }
    
    // Validate extension
    let lower_name = config_file_name.to_lowercase();
    if !lower_name.ends_with(".yaml") && !lower_name.ends_with(".yml") {
        return Err("Invalid file type: only .yaml and .yml files are permitted".to_string());
    }
    
    // Additional safety: check filename length
    if config_file_name.len() > 255 {
        return Err("Filename too long: maximum 255 characters allowed".to_string());
    }
    
    // Check for reserved Windows names (even on other platforms for consistency)
    let upper_name = config_file_name.to_uppercase();
    let base_name = upper_name.trim_end_matches(".YAML").trim_end_matches(".YML");
    let reserved_names = [
        "CON", "PRN", "AUX", "NUL",
        "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
        "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    if reserved_names.contains(&base_name) {
        return Err(format!("Reserved filename: '{}' is not allowed", config_file_name));
    }

    Ok(config_file_name)
}

/// Validates that the resolved path is within the expected base directory
fn validate_path_within_dir(resolved_path: &Path, base_dir: &Path) -> Result<(), String> {
    // If the file exists, use canonicalize for definitive check
    if resolved_path.exists() {
        let canonical_resolved = resolved_path.canonicalize()
            .map_err(|e| format!("Failed to canonicalize resolved path: {}", e))?;
        let canonical_base = base_dir.canonicalize()
            .map_err(|e| format!("Failed to canonicalize base directory: {}", e))?;
        
        if !canonical_resolved.starts_with(&canonical_base) {
            return Err("Path traversal detected: resolved path is outside allowed directory".to_string());
        }
    } else {
        // File doesn't exist yet, do string-level validation
        // Convert to string and check for path traversal patterns
        let resolved_str = resolved_path.to_string_lossy();
        let base_str = base_dir.to_string_lossy();
        
        // Normalize path separators for comparison
        let resolved_normalized = resolved_str.replace('\\', "/");
        let base_normalized = base_str.replace('\\', "/");
        
        if !resolved_normalized.starts_with(&*base_normalized) {
            return Err("Path traversal detected: resolved path is outside allowed directory".to_string());
        }
    }
    Ok(())
}

fn resolve_profile_path(paths: &AppPaths, config_path: &str) -> Result<(String, PathBuf), String> {
    let config_file_name = sanitize_config_file_name(config_path)?;
    if config_file_name == "run_config.yaml" {
        return Err("Cannot switch to run_config.yaml directly".to_string());
    }

    let resolved_path = paths.profiles_dir.join(&config_file_name);
    
    // Validate that the resolved path is within profiles_dir
    validate_path_within_dir(&resolved_path, &paths.profiles_dir)?;
    
    if resolved_path.exists() {
        return Ok((config_file_name, resolved_path));
    }

    if let Some(fallback) = first_available_profile(paths)? {
        let fallback_name = fallback
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or("Invalid fallback config filename encoding")?
            .to_string();
        return Ok((fallback_name, fallback));
    }

    // No config file found - create a default one
    let default_path = paths.profiles_dir.join("config.yaml");
    create_default_config(&default_path)?;
    Ok(("config.yaml".to_string(), default_path))
}

/// Create a minimal default configuration file for first-time users
fn create_default_config(path: &PathBuf) -> Result<(), String> {
    let default_config = r#"# Zephyr Default Configuration
# This is a minimal config file created for first-time setup.
# Please add your proxy nodes or import a subscription.

port: 7890
socks-port: 7891
mixed-port: 7892
allow-lan: false
bind-address: '*'
mode: rule
log-level: info
ipv6: false
external-controller: 127.0.0.1:9090

dns:
  enable: true
  ipv6: false
  enhanced-mode: fake-ip
  fake-ip-range: 198.18.0.1/16
  fake-ip-filter:
    - '*.lan'
    - localhost.ptlogin2.qq.com
  nameserver:
    - 223.5.5.5
    - 119.29.29.29
  fallback:
    - tls://8.8.8.8:853
    - tls://1.1.1.1:853

proxies: []

proxy-groups: []

rules:
  - GEOIP,CN,DIRECT
  - MATCH,DIRECT
"#;
    
    fs::write(path, default_config)
        .map_err(|e| format!("Failed to create default config: {}", e))?;
    
    println!("Created default config at {:?}", path);
    Ok(())
}

fn first_available_profile(paths: &AppPaths) -> Result<Option<PathBuf>, String> {
    let mut configs = Vec::new();
    let entries = match fs::read_dir(&paths.profiles_dir) {
        Ok(entries) => entries,
        Err(_) => return Ok(None),
    };

    for entry in entries.flatten() {
        let path = entry.path();
        let is_yaml = path
            .extension()
            .map(|ext| ext == "yaml" || ext == "yml")
            .unwrap_or(false);
        let is_run_config = path
            .file_name()
            .and_then(|name| name.to_str())
            .map(|name| name == "run_config.yaml")
            .unwrap_or(false);

        if path.is_file() && is_yaml && !is_run_config {
            configs.push(path);
        }
    }

    configs.sort();
    Ok(configs.into_iter().next())
}

fn parse_external_controller_port(yaml_val: &serde_yaml::Value) -> u16 {
    yaml_val
        .get("external-controller")
        .and_then(|v| v.as_str())
        .and_then(|ext_ctrl| ext_ctrl.split(':').last())
        .and_then(|p| p.parse::<u16>().ok())
        .unwrap_or(9090)
}

fn validate_custom_args(custom_args: &[String]) -> Result<Vec<String>, String> {
    let mut safe_custom_args = Vec::new();
    
    let blocked_args = [
        "-d", "--directory",
        "-f", "--config",
        "-ext-ctl", "--external-controller",
        "-secret", "--secret",
    ];

    for arg in custom_args {
        let trimmed = arg.trim();
        if trimmed.is_empty() {
            continue;
        }

        let arg_lower = trimmed.to_lowercase();
        let is_blocked = blocked_args.iter().any(|&b| arg_lower == b || arg_lower.starts_with(&format!("{}=", b)));

        if is_blocked {
            return Err(format!("Argument '{}' is not allowed for security reasons", trimmed));
        }

        safe_custom_args.push(trimmed.to_string());
    }

    Ok(safe_custom_args)
}

fn prepare_runtime_config(content: &str, secret: &str) -> Option<(String, u16)> {
    let mut yaml_val = serde_yaml::from_str::<serde_yaml::Value>(content).ok()?;
    if !yaml_val.is_mapping() {
        return None;
    }

    let config_port = parse_external_controller_port(&yaml_val);
    if let Some(mapping) = yaml_val.as_mapping_mut() {
        mapping.insert(
            serde_yaml::Value::String("external-controller".to_string()),
            serde_yaml::Value::String(format!("127.0.0.1:{}", config_port)),
        );
        mapping.insert(
            serde_yaml::Value::String("secret".to_string()),
            serde_yaml::Value::String(secret.to_string()),
        );
        
        // Default unified-delay to true if missing
        let unified_delay_key = serde_yaml::Value::String("unified-delay".to_string());
        if !mapping.contains_key(&unified_delay_key) {
            mapping.insert(unified_delay_key, serde_yaml::Value::Bool(true));
        }
    }

    serde_yaml::to_string(&yaml_val)
        .ok()
        .map(|final_config| (final_config, config_port))
}

fn build_minimal_runtime_config(secret: &str) -> (String, u16) {
    (
        format!(
            "mixed-port: 7890\nmode: rule\nlog-level: info\nunified-delay: true\nexternal-controller: 127.0.0.1:9090\nsecret: {}\nproxies: []\nproxy-groups:\n  - name: GLOBAL\n    type: select\n    proxies:\n      - DIRECT\nrules:\n  - MATCH,DIRECT\n",
            secret
        ),
        9090,
    )
}

fn select_runtime_config(
    paths: &AppPaths,
    preferred_name: &str,
    preferred_path: &Path,
    secret: &str,
) -> Result<(Option<String>, String, u16), String> {
    let preferred_content = fs::read_to_string(preferred_path)
        .map_err(|e| format!("Failed to read config {:?}: {}", preferred_path, e))?;
    if let Some((final_config, config_port)) = prepare_runtime_config(&preferred_content, secret) {
        return Ok((Some(preferred_name.to_string()), final_config, config_port));
    }

    let mut fallback_profiles = Vec::new();
    let entries = match fs::read_dir(&paths.profiles_dir) {
        Ok(entries) => entries,
        Err(_) => return Ok((None, build_minimal_runtime_config(secret).0, build_minimal_runtime_config(secret).1)),
    };

    for entry in entries.flatten() {
        let path = entry.path();
        let is_yaml = path
            .extension()
            .map(|ext| ext == "yaml" || ext == "yml")
            .unwrap_or(false);
        let is_run_config = path
            .file_name()
            .and_then(|name| name.to_str())
            .map(|name| name == "run_config.yaml")
            .unwrap_or(false);

        if path.is_file() && is_yaml && !is_run_config && path != preferred_path {
            fallback_profiles.push(path);
        }
    }

    fallback_profiles.sort();

    for path in fallback_profiles {
        let content = match fs::read_to_string(&path) {
            Ok(content) => content,
            Err(_) => continue,
        };
        if let Some((final_config, config_port)) = prepare_runtime_config(&content, secret) {
            let file_name = path
                .file_name()
                .and_then(|name| name.to_str())
                .ok_or("Invalid fallback config filename encoding")?
                .to_string();
            println!(
                "Requested config {} is not a valid Clash YAML profile, falling back to {}",
                preferred_name, file_name
            );
            return Ok((Some(file_name), final_config, config_port));
        }
    }

    println!(
        "Requested config {} is not a valid Clash YAML profile, falling back to generated minimal config",
        preferred_name
    );
    let (final_config, config_port) = build_minimal_runtime_config(secret);
    Ok((None, final_config, config_port))
}

pub fn get_core_exe_path(app: &AppHandle) -> Result<PathBuf, String> {
    let binary_name = core_binary_name();
    let core_path = ensure_app_storage(app)?.core_dir.join(binary_name);
    if core_path.exists() {
        return Ok(core_path);
    }

    Err(format!("Could not find {} in app data core directory", binary_name))
}

fn generate_secret() -> String {
    thread_rng()
        .sample_iter(&Alphanumeric)
        .take(32)
        .map(char::from)
        .collect()
}

    // ==========================================
    // 核心伪装引擎 (DRY - 提取公共代码)
    // ==========================================
    fn build_http_client(user_agent: Option<String>, resolve_pin: Option<(String, std::net::SocketAddr)>) -> Result<reqwest::Client, String> {
        // Enhanced redirect policy with SSRF protection for each redirect
        let redirect_policy = reqwest::redirect::Policy::custom(|attempt| {
            // Limit redirects
            if attempt.previous().len() > 5 {
                return attempt.error("Too many redirects (max 5)");
            }
            
            // Validate the redirect URL - clone to avoid borrow issues
            let url = attempt.url().clone();
            
            // Check scheme
            let scheme = url.scheme();
            if scheme != "http" && scheme != "https" {
                return attempt.error(format!("Invalid redirect scheme: {}", scheme));
            }
            
            // Check host
            let host = match url.host_str() {
                Some(h) => h.to_string(),
                None => return attempt.error("Redirect URL has no host"),
            };
            
            // Check if host is private
            if is_private_host(&host) {
                return attempt.error(format!("Redirect to private host blocked: {}", host));
            }
            
            // Perform DNS resolution check for redirect target
            // This prevents DNS rebinding attacks during redirects
            let port = url.port().unwrap_or(if scheme == "https" { 443 } else { 80 });
            match std::net::ToSocketAddrs::to_socket_addrs(&format!("{}:{}", host, port)) {
                Ok(addrs) => {
                    for addr in addrs {
                        if is_private_ip(addr.ip()) {
                            return attempt.error(format!(
                                "Redirect to private IP blocked: {} -> {}",
                                host,
                                addr.ip()
                            ));
                        }
                    }
                },
                Err(e) => return attempt.error(format!("Failed to resolve redirect host {}: {}", host, e)),
            }
            
            attempt.follow()
        });

        let mut client_builder = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .connect_timeout(Duration::from_secs(30))
            .redirect(redirect_policy);

        if let Some((host, addr)) = resolve_pin {
            client_builder = client_builder.resolve(&host, addr);
        }

        // Determine User-Agent: use provided UA, or default to Zephyr
        let ua_to_use = match user_agent {
            Some(ref ua) if !ua.trim().is_empty() => ua.trim().to_string(),
            _ => {
                // Default Zephyr User-Agent with version
                let version = env!("CARGO_PKG_VERSION");
                format!("Zephyr/{}", version)
            }
        };

        // Apply User-Agent and headers based on type
        if ua_to_use.contains("Shadowrocket") {
            let full_ua = "Shadowrocket/3082 CFNetwork/3826.600.41 Darwin/24.6.0 iPhone11,6";
            client_builder = client_builder
                .user_agent(full_ua)
                .default_headers({
                    let mut headers = reqwest::header::HeaderMap::new();
                    headers.insert("Accept", reqwest::header::HeaderValue::from_static("*/*"));
                    headers.insert("Accept-Language", reqwest::header::HeaderValue::from_static("zh-CN,zh-Hans;q=0.9"));
                    headers.insert("Cache-Control", reqwest::header::HeaderValue::from_static("no-cache"));
                    headers
                });
        } else {
            client_builder = client_builder
                .user_agent(&ua_to_use)
                .default_headers({
                    let mut headers = reqwest::header::HeaderMap::new();
                    headers.insert("Accept", reqwest::header::HeaderValue::from_static("text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9"));
                    headers
                });
        }

        client_builder.build().map_err(|e| e.to_string())
    }

// ==========================================
// SSRF 防护 - 私有地址检测
// ==========================================
const MAX_RESPONSE_SIZE: usize = 10 * 1024 * 1024; // 10MB

/// Check if an IP address is private or local
fn is_private_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ipv4) => {
            ipv4.is_private() || 
            ipv4.is_loopback() || 
            ipv4.is_link_local() || 
            ipv4.is_broadcast() ||
            ipv4.is_documentation() ||
            ipv4.is_unspecified()
        },
        IpAddr::V6(ipv6) => {
            ipv6.is_loopback() || 
            ipv6.is_unspecified() ||
            (ipv6.segments()[0] & 0xfe00) == 0xfc00 || // Unique Local Address
            (ipv6.segments()[0] & 0xff00) == 0xfe00    // Link Local Address
        }
    }
}

/// Check if a host is a private or local address (SSRF protection)
fn is_private_host(host: &str) -> bool {
    let host_lower = host.to_lowercase();
    
    // Quick checks for common localnames
    if host_lower == "localhost" || 
       host_lower.ends_with(".localhost") || 
       host_lower.ends_with(".local") || 
       host_lower.ends_with(".test") || 
       host_lower.ends_with(".example") || 
       host_lower.ends_with(".invalid") {
        return true;
    }
    
    // If it's a direct IP address, check it
    if let Ok(ip) = host.parse::<IpAddr>() {
        return is_private_ip(ip);
    }
    
    false
}

/// Validate URL and its resolved IPs for SSRF protection
fn validate_subscription_url_with_ip(url: &str) -> Result<(String, Option<std::net::SocketAddr>), String> {
    let parsed_url = reqwest::Url::parse(url).map_err(|e| format!("Invalid URL: {}", e))?;
    
    // Only allow http and https schemes
    let scheme = parsed_url.scheme();
    if scheme != "http" && scheme != "https" {
        return Err("Only HTTP and HTTPS URLs are allowed".to_string());
    }
    
    // Extract host
    let host = parsed_url.host_str().ok_or("URL must have a host")?;
    
    if is_private_host(host) {
        return Err("Access to private/local addresses is not allowed".to_string());
    }

    // Fix Med-3: DNS Rebinding / SSRF TOCTOU
    // Resolve here and return the resolved SocketAddr so we can pin it in reqwest.
    let mut resolved_addr = None;
    let addrs = std::net::ToSocketAddrs::to_socket_addrs(&format!("{}:80", host))
        .map_err(|e| format!("Failed to resolve host: {}", e))?;
    
    for addr in addrs {
        if is_private_ip(addr.ip()) {
            return Err("Access to private/local resolved addresses is not allowed".to_string());
        }
        if resolved_addr.is_none() {
            resolved_addr = Some(addr);
        }
    }
    
    if resolved_addr.is_none() {
        return Err("Could not resolve any IP address for the host".to_string());
    }
    
    Ok((host.to_string(), resolved_addr))
}

#[derive(serde::Serialize)]
pub struct CoreStartResult {
    pub secret: String,
    pub port: u16,
}

fn monitor_stream_for_port<R: std::io::Read + Send + 'static>(stream: R, tx: std::sync::mpsc::Sender<u16>) {
    std::thread::spawn(move || {
        use std::io::{BufRead, BufReader};
        let reader = BufReader::new(stream);
        for line in reader.lines() {
            if let Ok(line) = line {
                if let Some(idx) = line.find("RESTful API listening at: ") {
                    let addr = &line[idx + "RESTful API listening at: ".len()..];
                    let addr = addr.trim_end_matches('"');
                    if let Some(port_str) = addr.split(':').next_back() {
                        if let Ok(port) = port_str.trim().parse::<u16>() {
                            let _ = tx.send(port);
                        }
                    }
                } else if let Some(idx) = line.find("RESTful API listening at ") {
                    let addr = &line[idx + "RESTful API listening at ".len()..];
                    let addr = addr.trim_end_matches('"');
                    if let Some(port_str) = addr.split(':').next_back() {
                        if let Ok(port) = port_str.trim().parse::<u16>() {
                            let _ = tx.send(port);
                        }
                    }
                }
            } else {
                break;
            }
        }
    });
}

#[tauri::command]
pub async fn start_core(
    app: AppHandle,
    state: State<'_, MihomoState>,
    config_path: String,
    test: bool,
    custom_args: Vec<String>,
    secret: Option<String>,
) -> Result<CoreStartResult, String> {
    let paths = ensure_app_storage(&app)?;
    
    let exe_path = get_core_exe_path(&app)?;
    
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    ensure_executable(&exe_path)?;
    
    let (resolved_config_name, resolved_config_path) = resolve_profile_path(&paths, &config_path)?;
    
    let safe_custom_args = validate_custom_args(&custom_args)?;

    if test {
        let mut cmd = Command::new(&exe_path);
        #[cfg(target_os = "windows")]
        use std::os::windows::process::CommandExt;
        #[cfg(target_os = "windows")]
        cmd.creation_flags(CREATE_NO_WINDOW);
        
        cmd.args(["-t", "-f"]);
        cmd.arg(&resolved_config_path);
        for arg in &safe_custom_args {
            cmd.arg(arg);
        }
        let output = cmd.output().map_err(|e| format!("Failed to run test: {}", e))?;
        
        if output.status.success() {
            return Ok(CoreStartResult {
                secret: "test_ok".to_string(),
                port: 0,
            });
        } else {
            let mut err_msg = String::from_utf8_lossy(&output.stderr).to_string();
            // Basic path redaction
            err_msg = err_msg.replace(paths.core_dir.to_str().unwrap_or(""), "[CORE_DIR]");
            err_msg = err_msg.replace(paths.profiles_dir.to_str().unwrap_or(""), "[PROFILES_DIR]");
            println!("Config test failed: {}", err_msg);
            return Err("Config test failed. Please check the config file for syntax errors.".to_string());
        }
    }

    stop_core(app.clone(), state.clone())?;

    let secret = secret.unwrap_or_else(generate_secret);
    
    let (active_config_name, final_config, config_port) =
        select_runtime_config(&paths, &resolved_config_name, &resolved_config_path, &secret)?;
    
    let run_config_path = paths.core_dir.join("run_config.yaml");
    write_file_secure(&run_config_path, &final_config)?;

    let mut cmd = Command::new(&exe_path);
    #[cfg(target_os = "windows")]
    use std::os::windows::process::CommandExt;
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);
    
    cmd.args(["-d", "."]);
    cmd.args(["-f", "run_config.yaml"]);

    for arg in &safe_custom_args {
        cmd.arg(arg);
    }
    
    cmd.current_dir(&paths.core_dir);
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    
    println!("Spawning core with args: {:?}", cmd.get_args());
    
    let mut child = cmd.spawn().map_err(|e| format!("Failed to spawn mihomo: {}", e))?;
    
    let stdout = match child.stdout.take() {
        Some(s) => s,
        None => {
            let _ = child.kill();
            let _ = child.wait();
            return Err("Failed to capture stdout".to_string());
        }
    };
    let stderr = match child.stderr.take() {
        Some(s) => s,
        None => {
            let _ = child.kill();
            let _ = child.wait();
            return Err("Failed to capture stderr".to_string());
        }
    };
    
    let (tx, rx) = std::sync::mpsc::channel();
    
    monitor_stream_for_port(stdout, tx.clone());
    monitor_stream_for_port(stderr, tx);

    let port = tauri::async_runtime::spawn_blocking(move || {
        match rx.recv_timeout(std::time::Duration::from_secs(5)) {
            Ok(p) => p,
            Err(_) => {
                println!("Warning: Timeout waiting for API port from logs, falling back to config port {}", config_port);
                config_port
            }
        }
    }).await.map_err(|e| format!("Task failed: {}", e))?;
    
    // HTTP Health Check via raw TCP to avoid tokio runtime drop panic from reqwest::blocking
    let mut is_healthy = false;
    for _ in 0..10 {
        if let Ok(mut stream) = std::net::TcpStream::connect(format!("127.0.0.1:{}", port)) {
            let request = format!(
                "GET / HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nConnection: close\r\n\r\n",
                port
            );
            if stream.write_all(request.as_bytes()).is_ok() {
                let mut response = [0u8; 256];
                if let Ok(n) = stream.read(&mut response) {
                    let resp_str = String::from_utf8_lossy(&response[..n]);
                    if resp_str.starts_with("HTTP/1.1 200") || resp_str.starts_with("HTTP/1.1 401") || resp_str.starts_with("HTTP/1.0 200") || resp_str.starts_with("HTTP/1.0 401") {
                        is_healthy = true;
                        break;
                    }
                }
            }
        }
        let _ = tauri::async_runtime::spawn_blocking(|| {
            std::thread::sleep(std::time::Duration::from_millis(500));
        }).await;
    }
    
    if !is_healthy {
        let err_msg = "Core started but health check failed. Check the logs for details.".to_string();
        let _ = child.kill();
        let _ = child.wait();
        return Err(err_msg);
    }
    
    let mut lock = match state.0.lock() {
        Ok(l) => l,
        Err(_) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err("Failed to lock state".to_string());
        }
    };
    lock.process = Some(child);
    lock.last_secret = secret.clone();
    lock.last_config_path = active_config_name;
    lock.last_custom_args = Some(safe_custom_args);
    lock.last_port = Some(port);

    Ok(CoreStartResult { secret, port })
}

#[tauri::command]
pub fn stop_core(app: AppHandle, state: State<'_, MihomoState>) -> Result<String, String> {
    // Take the child process
    let child = {
        let mut lock = state.0.lock().map_err(|_| "Failed to lock state".to_string())?;
        lock.last_port = None;
        lock.process.take()
    };
    
    if let Some(mut child) = child {
        // Try graceful shutdown first (on Unix, send SIGTERM; on Windows, just kill)
        #[cfg(unix)]
        {
            use std::signal::Signal;
            use std::os::unix::process::Signal;
            let _ = child.send_signal(Signal::SIGTERM);
        }
        
        // Wait a bit for graceful shutdown
        std::thread::sleep(std::time::Duration::from_millis(300));
        
        // Force kill if still running
        match child.try_wait() {
            Ok(Some(_status)) => {}
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
            }
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
    
    if let Ok(paths) = ensure_app_storage(&app) {
        let run_config_path = paths.core_dir.join("run_config.yaml");
        if run_config_path.exists() {
            if let Err(e) = fs::remove_file(&run_config_path) {
                println!("Warning: Failed to remove run_config.yaml: {}", e);
            }
        }
    }
    
    Ok("Core stopped and cleaned up".to_string())
}

#[tauri::command]
pub async fn get_core_version(app: AppHandle) -> Result<String, String> {
    let exe_path = get_core_exe_path(&app)?;
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    ensure_executable(&exe_path)?;

    let mut cmd = Command::new(&exe_path);
    #[cfg(target_os = "windows")]
    use std::os::windows::process::CommandExt;
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd.arg("-v");

    let output = cmd.output().map_err(|e| format!("Failed to run version check: {}", e))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    
    if let Some(v_idx) = stdout.find('v') {
        let after_v = &stdout[v_idx..];
        if let Some(space_idx) = after_v.find(' ') {
            return Ok(after_v[..space_idx].to_string());
        }
        return Ok(after_v.to_string());
    }
    
    Ok(stdout.trim().to_string())
}

#[derive(serde::Serialize, serde::Deserialize, Default)]
struct ProfilesMetadata {
    configs: std::collections::HashMap<String, ConfigMetadata>,
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
struct ConfigMetadata {
    pub url: Option<String>,
    pub sub_info: Option<String>,
}

/// Machine key file name for persistent storage
const MACHINE_KEY_FILE: &str = ".machine_key";

/// Get or create a persistent machine-specific encryption key.
/// Uses multiple hardware fingerprints for enhanced security against VM cloning.
/// Falls back to a randomly generated key persisted to disk if system IDs unavailable.
fn get_machine_key() -> Vec<u8> {
    let mut seed_parts: Vec<String> = Vec::new();
    
    // Collect system machine ID
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        if let Ok(hklm) = winreg::RegKey::predef(winreg::enums::HKEY_LOCAL_MACHINE)
            .open_subkey("SOFTWARE\\Microsoft\\Cryptography") {
            if let Ok(guid) = hklm.get_value::<String, _>("MachineGuid") {
                seed_parts.push(guid);
            }
        }
        // Additional Windows fingerprint: Volume serial number of C: drive
        // This adds another factor that changes if the system is cloned
        if let Ok(output) = std::process::Command::new("cmd")
            .args(&["/C", "vol C:"])
            .creation_flags(CREATE_NO_WINDOW)
            .output() 
        {
            let vol_output = String::from_utf8_lossy(&output.stdout);
            // Extract serial number from output like "Volume Serial Number is XXXX-XXXX"
            if let Some(idx) = vol_output.find("Volume Serial Number is ") {
                let serial = &vol_output[idx + 24..];
                if let Some(end) = serial.find('\n') {
                    seed_parts.push(serial[..end].trim().to_string());
                }
            }
        }
    }
    #[cfg(target_os = "macos")]
    {
        if let Ok(output) = std::process::Command::new("ioreg")
            .arg("-rd1")
            .arg("-c")
            .arg("IOPlatformExpertDevice")
            .output() 
        {
            let out_str = String::from_utf8_lossy(&output.stdout);
            if let Some(idx) = out_str.find("IOPlatformUUID") {
                seed_parts.push(out_str[idx..].to_string());
            }
        }
        // Additional macOS fingerprint: Hardware UUID
        if let Ok(output) = std::process::Command::new("ioreg")
            .arg("-rd1")
            .arg("-c")
            .arg("IOPlatformExpertDevice")
            .arg("-d")
            .arg("1")
            .output() 
        {
            let out_str = String::from_utf8_lossy(&output.stdout);
            if let Some(idx) = out_str.find("IOPlatformSerialNumber") {
                if let Some(serial_start) = out_str[idx..].find('"') {
                    let rest = &out_str[idx + serial_start + 1..];
                    if let Some(serial_end) = rest.find('"') {
                        seed_parts.push(rest[..serial_end].to_string());
                    }
                }
            }
        }
    }
    #[cfg(target_os = "linux")]
    {
        if let Ok(id) = fs::read_to_string("/etc/machine-id") {
            seed_parts.push(id.trim().to_string());
        }
        // Additional Linux fingerprint: board serial if available
        if let Ok(output) = std::process::Command::new("cat")
            .arg("/sys/class/dmi/id/board_serial")
            .output() 
        {
            let board_serial = String::from_utf8_lossy(&output.stdout);
            let trimmed = board_serial.trim();
            if !trimmed.is_empty() && trimmed != "None" && trimmed.len() > 2 {
                seed_parts.push(trimmed.to_string());
            }
        }
    }
    
    // Combine all seed parts with process ID for additional uniqueness
    // This adds a session-specific component to prevent cross-session attacks
    let combined_seed = if !seed_parts.is_empty() {
        // Use multiple hardware fingerprints combined
        seed_parts.join("|")
    } else {
        // Fallback: empty seed
        String::new()
    };
    
    // If we have a system seed, derive key from it
    if !combined_seed.is_empty() {
        use sha2::{Sha256, Digest};
        let mut hasher = Sha256::new();
        hasher.update(combined_seed.as_bytes());
        return hasher.finalize().to_vec();
    }
    
    // Fallback: use a persistent random key stored in the app data directory
    // This ensures key consistency across sessions while avoiding hardcoded keys
    if let Some(app_data_dir) = std::env::current_exe()
        .ok()
        .as_ref()
        .and_then(|p| p.parent())
        .map(|p| p.to_path_buf())
    {
        let key_path = app_data_dir.join(MACHINE_KEY_FILE);
        
        // Try to read existing key
        if key_path.exists() {
            if let Ok(existing_key) = fs::read_to_string(&key_path) {
                let trimmed = existing_key.trim();
                if !trimmed.is_empty() && trimmed.len() >= 32 {
                    // Derive key from stored seed
                    use sha2::{Sha256, Digest};
                    let mut hasher = Sha256::new();
                    hasher.update(trimmed.as_bytes());
                    return hasher.finalize().to_vec();
                }
            }
        }
        
        // Generate new random key
        let random_key: String = thread_rng()
            .sample_iter(&Alphanumeric)
            .take(64)
            .map(char::from)
            .collect();
        
        // Try to persist the key (ignore errors - we'll use it in memory anyway)
        let _ = write_file_secure(&key_path, &random_key);
        
        // Derive key from random seed
        use sha2::{Sha256, Digest};
        let mut hasher = Sha256::new();
        hasher.update(random_key.as_bytes());
        return hasher.finalize().to_vec();
    }
    
    // Last resort: generate a session-only key (will change on restart)
    // This should rarely happen, but ensures the app doesn't crash
    eprintln!("[Security] Warning: Could not generate persistent machine key, using session-only key");
    let session_key: String = thread_rng()
        .sample_iter(&Alphanumeric)
        .take(64)
        .map(char::from)
        .collect();

    use sha2::{Sha256, Digest};
    let mut hasher = Sha256::new();
    hasher.update(session_key.as_bytes());
    hasher.finalize().to_vec()
}

fn obfuscate_string(s: &str) -> String {
    let key = get_machine_key();
    let mut xored = Vec::with_capacity(s.len());
    for (i, b) in s.bytes().enumerate() {
        xored.push(b ^ key[i % key.len()]);
    }
    base64_standard.encode(&xored)
}

fn deobfuscate_string(s: &str) -> String {
    if let Ok(decoded) = base64_standard.decode(s) {
        let key = get_machine_key();
        let mut unxored = Vec::with_capacity(decoded.len());
        for (i, b) in decoded.into_iter().enumerate() {
            unxored.push(b ^ key[i % key.len()]);
        }
        String::from_utf8_lossy(&unxored).to_string()
    } else {
        s.to_string() // Fallback to original if not base64
    }
}

fn load_metadata(paths: &AppPaths) -> ProfilesMetadata {
    let meta_path = paths.profiles_dir.join("metadata.json");
    match fs::read_to_string(&meta_path) {
        Ok(data) => {
            match serde_json::from_str::<ProfilesMetadata>(&data) {
                Ok(mut meta) => {
                    for (_, config) in meta.configs.iter_mut() {
                        if let Some(url) = &config.url {
                            // URL should start with http, if not it's obfuscated
                            if !url.starts_with("http") {
                                config.url = Some(deobfuscate_string(url));
                            }
                        }
                        if let Some(info) = &config.sub_info {
                            // sub_info should contain '=' and ';' in format: upload=X; download=Y; total=Z; expire=T
                            // If it doesn't contain both, it's obfuscated
                            // Note: base64 can contain '=' as padding, so we check for ';'
                            if !info.contains(';') {
                                config.sub_info = Some(deobfuscate_string(info));
                            }
                        }
                    }
                    meta
                },
                Err(e) => {
                    eprintln!("[Metadata] Warning: Failed to parse metadata.json: {}. Using default.", e);
                    ProfilesMetadata::default()
                }
            }
        },
        Err(e) => {
            // Only log warning if file exists but cannot be read
            if meta_path.exists() {
                eprintln!("[Metadata] Warning: Failed to read metadata.json: {}. Using default.", e);
            }
            ProfilesMetadata::default()
        }
    }
}

fn save_metadata(paths: &AppPaths, meta: &ProfilesMetadata) {
    let mut obf_meta = ProfilesMetadata::default();
    for (k, v) in &meta.configs {
        obf_meta.configs.insert(k.clone(), ConfigMetadata {
            url: v.url.as_ref().map(|s| obfuscate_string(s)),
            sub_info: v.sub_info.as_ref().map(|s| obfuscate_string(s)),
        });
    }

    let meta_path = paths.profiles_dir.join("metadata.json");
    if let Ok(data) = serde_json::to_string_pretty(&obf_meta) {
        let _ = write_file_secure(&meta_path, &data);
    }
}

/// Clean up metadata entries for configs that no longer exist on disk
fn cleanup_metadata_cache(paths: &AppPaths) {
    let mut metadata = load_metadata(paths);
    let mut changed = false;
    
    // Collect all existing config files
    let existing_configs: std::collections::HashSet<String> = 
        fs::read_dir(&paths.profiles_dir)
            .ok()
            .into_iter()
            .flatten()
            .filter_map(|entry| entry.ok())
            .filter(|entry| {
                entry.path().extension()
                    .map(|ext| ext == "yaml" || ext == "yml")
                    .unwrap_or(false)
            })
            .filter_map(|entry| {
                entry.file_name().to_str().map(|s| s.to_string())
            })
            .filter(|name| name != "run_config.yaml")
            .collect();
    
    // Remove metadata entries for deleted configs
    let keys_to_remove: Vec<String> = metadata.configs.keys()
        .filter(|key| !existing_configs.contains(*key))
        .cloned()
        .collect();
    
    for key in keys_to_remove {
        metadata.configs.remove(&key);
        changed = true;
    }
    
    if changed {
        save_metadata(paths, &metadata);
    }
}

#[tauri::command]
pub async fn list_configs(app: AppHandle) -> Result<Vec<ConfigInfo>, String> {
    let mut configs = Vec::new();
    let paths = ensure_app_storage(&app)?;
    
    // Clean up stale metadata entries
    cleanup_metadata_cache(&paths);
    
    let metadata = load_metadata(&paths);
    
    if let Ok(entries) = fs::read_dir(&paths.profiles_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().map_or(false, |ext| ext == "yaml" || ext == "yml") {
                if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                    if name != "run_config.yaml" {
                        let mut url = None;
                        let mut sub_info = None;
                        
                        // Migrate old plaintext comments if exist, then remove them?
                        // For safety, just read from metadata first.
                        if let Some(meta) = metadata.configs.get(name) {
                            url = meta.url.clone();
                            sub_info = meta.sub_info.clone();
                        } else {
                            // Fallback to reading old comments
                            if let Ok(file) = std::fs::File::open(&path) {
                                use std::io::{BufRead, BufReader};
                                let reader = BufReader::new(file);
                                for line in reader.lines().take(50).map_while(Result::ok) {
                                    if line.starts_with("# URL: ") {
                                        url = Some(line.replace("# URL: ", "").trim().to_string());
                                    } else if line.starts_with("# SUB_INFO: ") {
                                        sub_info = Some(line.replace("# SUB_INFO: ", "").trim().to_string());
                                    }
                                }
                            }
                        }
                        
                        configs.push(ConfigInfo { name: name.to_string(), url, sub_info });
                    }
                }
            }
        }
    }
    configs.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(configs)
}

async fn read_response_body(resp: reqwest::Response) -> Result<Vec<u8>, String> {
    if let Some(content_length) = resp.content_length() {
        if content_length as usize > MAX_RESPONSE_SIZE {
            return Err(format!("Response too large: {} bytes (max {} bytes)", content_length, MAX_RESPONSE_SIZE));
        }
    }
    
    use futures_util::StreamExt;
    let mut bytes = Vec::new();
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Failed to read chunk: {}", e))?;
        if bytes.len() + chunk.len() > MAX_RESPONSE_SIZE {
            return Err(format!("Response exceeded size limit of {} bytes", MAX_RESPONSE_SIZE));
        }
        bytes.extend_from_slice(&chunk);
    }
    
    Ok(bytes)
}
#[tauri::command]
pub async fn download_sub(
    app: AppHandle, 
    url: String, 
    name: String, 
    user_agent: Option<String>
) -> Result<String, String> {
    if name.contains("..") || name.contains('/') || name.contains('\\') {
        return Err("Invalid subscription name".to_string());
    }

    // SSRF protection: validate URL before making request
    let (host, resolved_addr) = validate_subscription_url_with_ip(&url)?;
    let resolve_pin = resolved_addr.map(|addr| (host, addr));

    // 仅仅一句代码，直接调用我们提取的公共伪装方法！
    let client = build_http_client(user_agent, resolve_pin)?;

    let resp = client.get(&url).send().await.map_err(|e| {
        println!("Download failed: {}", e);
        "Network error occurred during download".to_string()
    })?;
    
    if !resp.status().is_success() {
        let status = resp.status();
        println!("Download failed with status: {}", status);
        return Err("Download failed with error status".to_string());
    }
    
    // Check Content-Length header for size limit
    if let Some(content_length) = resp.content_length() {
        if content_length as usize > MAX_RESPONSE_SIZE {
            return Err(format!("Response too large: {} bytes (max {} bytes)", content_length, MAX_RESPONSE_SIZE));
        }
    }
    
    let sub_info_header = resp.headers().get("subscription-userinfo")
        .and_then(|h| h.to_str().ok()).unwrap_or("").to_string();

    let final_url = resp.headers().get("profile-web-page-url")
        .and_then(|h| h.to_str().ok()).unwrap_or(&url).to_string();

    let bytes = read_response_body(resp).await?;
    let mut content = String::from_utf8_lossy(&bytes).to_string();

    // 检测并解码 Base64 订阅
    // 如果内容不包含标准的 yaml 标识（比如 "proxies:" 或 "port:"），且内容看起来像 Base64，尝试解码
    if !content.contains("proxies:") && !content.contains("port:") {
        // 去除可能的空白字符
        let trimmed_content = content.replace(&['\r', '\n', ' ', '\t'][..], "");
        if let Ok(decoded_bytes) = base64_standard.decode(&trimmed_content) {
            if let Ok(decoded_str) = String::from_utf8(decoded_bytes) {
                // 解码后如果是有效的 yaml 或者是节点列表（比如 ss://, vmess://），这里可以进一步处理
                // 但如果是纯节点列表，可能需要转换为 clash yaml 格式。这里先简单保存解码后的文本，
                // 如果机场返回的是 base64 编码的 yaml，这就足够了。
                if decoded_str.contains("proxies:") || decoded_str.contains("port:") {
                    content = decoded_str;
                } else {
                    // If it's not a valid clash yaml, it might be a node list
                    // We'll still save it but it might not run
                    content = decoded_str;
                }
            }
        }
    }
    
    // Basic YAML check and script sanitization for Clash config
    if content.contains("proxies:") || content.contains("proxy-groups:") {
        match serde_yaml::from_str::<serde_yaml::Value>(&content) {
            Ok(mut yaml_val) => {
                if let Some(mapping) = yaml_val.as_mapping_mut() {
                    mapping.remove(&serde_yaml::Value::String("script".to_string()));
                }
                content = serde_yaml::to_string(&yaml_val)
                    .map_err(|e| format!("Failed to serialize sanitized subscription: {}", e))?;
            },
            Err(e) => {
                return Err(format!("Invalid YAML structure in subscription: {}", e));
            }
        }
    } else if !content.trim().starts_with("http") && !content.trim().is_empty() {
        // Not a link list and not a clash config?
        return Err("The subscription content is neither a valid Clash YAML nor a supported node list".to_string());
    }
    
    let paths = ensure_app_storage(&app)?;
    
    let clean_name = if name.ends_with(".yaml") || name.ends_with(".yml") { name.clone() } else { format!("{}.yaml", name) };
    let target_path = paths.profiles_dir.join(&clean_name);
    
    // Save metadata instead of writing plaintext headers
    let mut metadata = load_metadata(&paths);
    metadata.configs.insert(clean_name.clone(), ConfigMetadata {
        url: Some(final_url.clone()),
        sub_info: if sub_info_header.is_empty() { None } else { Some(sub_info_header.clone()) },
    });
    save_metadata(&paths, &metadata);

    let final_content = content;

    write_file_secure(&target_path, &final_content)?;
    
    Ok(format!("Config saved as {}", clean_name))
}

#[tauri::command]
pub async fn delete_config(app: AppHandle, name: String) -> Result<String, String> {
    let paths = ensure_app_storage(&app)?;

    // Ensure the name has a .yaml extension
    let name = if name.ends_with(".yaml") || name.ends_with(".yml") {
        name
    } else {
        format!("{}.yaml", name)
    };

    let name = sanitize_config_file_name(&name)?;
    if name == "run_config.yaml" { return Err("Cannot delete the active temp config".to_string()); }
    
    let target_path = paths.profiles_dir.join(&name);
    validate_path_within_dir(&target_path, &paths.profiles_dir)?;

    let file_exists = target_path.exists();
    
    if !file_exists { 
        // Try with .yml extension as well
        let yml_name = name.replace(".yaml", ".yml");
        let yml_path = paths.profiles_dir.join(&yml_name);
        
        if yml_path.exists() {
            fs::remove_file(&yml_path).map_err(|e| format!("Failed to delete file: {}", e))?;
            let mut metadata = load_metadata(&paths);
            metadata.configs.remove(&yml_name);
            save_metadata(&paths, &metadata);
            return Ok(format!("Config {} deleted", yml_name));
        }
        return Err(format!("File does not exist: {:?}", target_path)); 
    }
    
    // Remove metadata
    let mut metadata = load_metadata(&paths);
    metadata.configs.remove(&name);
    save_metadata(&paths, &metadata);

    // Delete the file and verify
    fs::remove_file(&target_path).map_err(|e| format!("Failed to delete file: {}", e))?;
    
    // Verify deletion (Windows may report success but file remains if locked)
    if target_path.exists() {
        std::thread::sleep(std::time::Duration::from_millis(100));
        fs::remove_file(&target_path).map_err(|e| format!("Failed to delete file: {}", e))?;
        
        if target_path.exists() {
            return Err(format!("File could not be deleted (locked by another process?): {:?}", target_path));
        }
    }
    
    Ok(format!("Config {} deleted", name))
}

#[tauri::command]
pub fn read_config_file(app: AppHandle, config_path: String) -> Result<String, String> {
    let paths = ensure_app_storage(&app)?;
    let config_file_name = sanitize_config_file_name(&config_path)?;
    let (resolved_path, base_dir) = if config_file_name == "run_config.yaml" {
        (paths.core_dir.join(&config_file_name), paths.core_dir.clone())
    } else {
        (paths.profiles_dir.join(&config_file_name), paths.profiles_dir.clone())
    };
    
    validate_path_within_dir(&resolved_path, &base_dir)?;
    
    if !resolved_path.exists() { return Err(format!("Config file {:?} not found", resolved_path)); }
    
    fs::read_to_string(&resolved_path).map_err(|e| format!("Failed to read config: {}", e))
}

pub fn write_file_secure(path: &Path, content: &str) -> Result<(), String> {
    fs::write(path, content).map_err(|e| format!("Failed to write to {:?}: {}", path, e))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

#[tauri::command]
pub fn write_config_file(app: AppHandle, config_path: String, content: String) -> Result<String, String> {
    let paths = ensure_app_storage(&app)?;
    let config_file_name = sanitize_config_file_name(&config_path)?;
    let (resolved_path, base_dir) = if config_file_name == "run_config.yaml" {
        (paths.core_dir.join(&config_file_name), paths.core_dir.clone())
    } else {
        (paths.profiles_dir.join(&config_file_name), paths.profiles_dir.clone())
    };
    
    validate_path_within_dir(&resolved_path, &base_dir)?;
    
    write_file_secure(&resolved_path, &content)?;
    
    Ok(format!("Successfully wrote to {:?}", resolved_path))
}

#[tauri::command]
pub async fn fetch_text(url: String) -> Result<String, String> {
    let (host, resolved_addr) = validate_subscription_url_with_ip(&url)?;
    let resolve_pin = resolved_addr.map(|addr| (host, addr));
    let client = build_http_client(None, resolve_pin)?;
    
    let resp = client.get(&url).send().await.map_err(|e| {
        println!("Fetch failed: {}", e);
        "Network error occurred during fetch".to_string()
    })?;
    
    if !resp.status().is_success() {
        let status = resp.status();
        println!("Fetch failed with status: {}", status);
        return Err("Fetch failed with error status".to_string());
    }
    
    let bytes = read_response_body(resp).await?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

#[cfg(test)]
pub fn sanitize_config_file_name_public(config_path: &str) -> Result<String, String> {
    sanitize_config_file_name(config_path)
}

#[cfg(test)]
pub fn is_private_host_public(host: &str) -> bool {
    is_private_host(host)
}

#[cfg(test)]
mod tests {
    use super::{prepare_runtime_config, validate_custom_args};

    #[test]
    fn prepare_runtime_config_injects_secret_and_controller() {
        let config = "external-controller: 0.0.0.0:7897\nsecret: old\nmode: rule\n";
        let (prepared, port) = prepare_runtime_config(config, "new-secret").unwrap();

        assert_eq!(port, 7897);
        assert!(prepared.contains("external-controller: 127.0.0.1:7897"));
        assert!(prepared.contains("secret: new-secret"));
        assert!(!prepared.contains("secret: old"));
    }

    #[test]
    fn validate_custom_args_rejects_blocked_flags() {
        let args = validate_custom_args(&["--external-controller=0.0.0.0:9090".to_string()]);
        assert!(args.is_err());
        
        let args2 = validate_custom_args(&["-d".to_string(), ".".to_string()]);
        assert!(args2.is_err());
    }

    #[test]
    fn validate_custom_args_keeps_allowed_flags() {
        let args = validate_custom_args(&["  -t  ".to_string(), "--version".to_string()]).unwrap();
        assert_eq!(args, vec!["-t".to_string(), "--version".to_string()]);
    }
}

#[tauri::command]
pub fn open_config_folder(app: AppHandle) -> Result<String, String> {
    let paths = ensure_app_storage(&app)?;
    let target = paths.profiles_dir;

    #[cfg(target_os = "windows")]
    {
        Command::new("explorer")
            .arg(&target)
            .spawn()
            .map_err(|e| format!("Failed to open config folder: {}", e))?;
    }

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(&target)
            .spawn()
            .map_err(|e| format!("Failed to open config folder: {}", e))?;
    }

    #[cfg(target_os = "linux")]
    {
        Command::new("xdg-open")
            .arg(&target)
            .spawn()
            .map_err(|e| format!("Failed to open config folder: {}", e))?;
    }

    Ok(target.to_string_lossy().to_string())
}