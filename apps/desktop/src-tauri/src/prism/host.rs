//! `ZephyrPrismHost` --- bridges Prism Engine to Zephyr's internal state.

use tauri::Manager as _;

use clash_prism_extension::{ApplyStatus, CoreInfo, PrismEvent, PrismHost, ProfileInfo};

use crate::backend_event::{codes, lock_best_effort, lock_critical, BackendModule};
use crate::core_manager::core::MAX_RESPONSE_SIZE;
use crate::core_manager::{ensure_app_storage, read_profile_file, write_file_secure, MihomoState};
use zephyr_core::config::sanitizer::validate_path_within_dir;

use super::prism_data_dir;
use super::types::sanitize_filename;

// ── WiFi SSID detection (for `__when__.ssid` condition) ──────────────────

/// SSID cache TTL — avoids spawning a subprocess on every patch compilation.
const SSID_CACHE_TTL_SECS: u64 = 5;

/// Cached SSID result (including `None`) with the instant it was observed.
/// Caching `None` avoids re-spawning subprocesses when `WiFi` is disconnected.
static SSID_CACHE: std::sync::Mutex<Option<(Option<String>, std::time::Instant)>> =
    std::sync::Mutex::new(None);

/// Detect the current `WiFi` SSID via platform-specific commands.
///
/// Results are cached for `SSID_CACHE_TTL_SECS` to avoid excessive subprocess
/// spawning during frequent recompilations (e.g. rapid rule edits).
fn detect_ssid() -> Option<String> {
    // Fast path: return cached value if still fresh.
    if let Ok(cache) = SSID_CACHE.lock() {
        if let Some((cached, instant)) = cache.as_ref() {
            if instant.elapsed().as_secs() < SSID_CACHE_TTL_SECS {
                return cached.clone();
            }
        }
    }

    let ssid = detect_ssid_uncached();

    // Update cache (best-effort; lock failure is non-fatal).
    if let Ok(mut cache) = SSID_CACHE.lock() {
        *cache = Some((ssid.clone(), std::time::Instant::now()));
    }

    ssid
}

/// Platform-specific SSID detection without caching.
#[cfg(target_os = "windows")]
fn detect_ssid_uncached() -> Option<String> {
    use std::os::windows::process::CommandExt as _;
    let output = std::process::Command::new("netsh")
        .args(["wlan", "show", "interfaces"])
        .creation_flags(crate::core_manager::CREATE_NO_WINDOW)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    // Parse: "    SSID                   : MyWiFi"
    // Skip:  "    BSSID                  : aa:bb:cc:dd:ee:ff"
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .find(|line| line.starts_with("SSID") && !line.starts_with("BSSID"))
        .and_then(|line| line.split_once(':').map(|(_, v)| v.trim().to_owned()))
        .filter(|s| !s.is_empty())
}

/// Platform-specific SSID detection without caching.
#[cfg(target_os = "macos")]
fn detect_ssid_uncached() -> Option<String> {
    // Resolve the Wi-Fi interface name (not always en0).
    let iface = detect_macos_wifi_iface().unwrap_or_else(|| "en0".to_string());
    let output = std::process::Command::new("networksetup")
        .args(["-getairportnetwork", &iface])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    // Output: "Current Wi-Fi Network: MyWiFi"
    String::from_utf8_lossy(&output.stdout)
        .strip_prefix("Current Wi-Fi Network: ")
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from)
}

/// Find the macOS Wi-Fi interface via `networksetup -listallhardwareports`.
#[cfg(target_os = "macos")]
fn detect_macos_wifi_iface() -> Option<String> {
    let output = std::process::Command::new("networksetup")
        .args(["-listallhardwareports"])
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    let mut found_wifi = false;
    for line in text.lines().map(str::trim) {
        if found_wifi {
            // The line after "Wi-Fi" contains "Device: enX"
            if let Some(dev) = line.strip_prefix("Device: ") {
                return Some(dev.trim().to_owned());
            }
        }
        if line.starts_with("Hardware Port:") && line.contains("Wi-Fi") {
            found_wifi = true;
        }
    }
    None
}

/// Platform-specific SSID detection without caching.
#[cfg(target_os = "linux")]
fn detect_ssid_uncached() -> Option<String> {
    // Try nmcli first (most common on modern Linux desktops).
    // `-t -f active,ssid` produces terse output: "yes:MyWiFi\n:OtherNet"
    // `-e no` disables escaping so SSIDs containing `:` or `\` are preserved.
    if let Ok(output) = std::process::Command::new("nmcli")
        .args(["-t", "-e", "no", "-f", "active,ssid", "dev", "wifi"])
        .output()
    {
        if output.status.success() {
            for line in String::from_utf8_lossy(&output.stdout).lines() {
                // Active row starts with "yes:" — split on first ':' to get SSID
                let (active, ssid) = line.split_once(':').unwrap_or((line, ""));
                if active.trim() == "yes" {
                    let ssid_trimmed = ssid.trim();
                    if !ssid_trimmed.is_empty() {
                        return Some(ssid_trimmed.to_owned());
                    }
                }
            }
        }
    }

    // Fallback: iwconfig (prints to stdout on some systems, stderr on others).
    if let Ok(output) = std::process::Command::new("iwconfig").output() {
        let combined = format!(
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        for line in combined.lines() {
            // Parse: '    ESSID:"MyWiFi"'
            if let Some(rest) = line.split("ESSID:").nth(1) {
                let trimmed = rest.trim();
                if let Some(stripped) = trimmed.strip_prefix('"') {
                    if let Some(end) = stripped.find('"') {
                        let ssid = &stripped[..end];
                        if !ssid.is_empty() {
                            return Some(ssid.to_owned());
                        }
                    }
                }
            }
        }
    }
    None
}

/// Platform-specific SSID detection without caching.
#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
fn detect_ssid_uncached() -> Option<String> {
    None
}

pub(crate) struct ZephyrPrismHost {
    app: tauri::AppHandle,
}

impl ZephyrPrismHost {
    pub(crate) const fn new(app: tauri::AppHandle) -> Self {
        Self { app }
    }

    /// Synchronous HTTP PUT to localhost --- no tokio dependency.
    /// Used by `apply_config` which is a sync trait method callable from any thread.
    fn http_put(url: &str, body: &str, bearer: &str) -> bool {
        use std::io::{Read as _, Write as _};
        use std::net::TcpStream;

        let parsed = match url::Url::parse(url) {
            Ok(u) => u,
            Err(_) => return false,
        };

        let host = parsed.host_str().unwrap_or("127.0.0.1");
        let port = parsed.port().unwrap_or(9090);
        let target = &parsed[url::Position::BeforePath..url::Position::AfterQuery];

        // Connect with timeout (2s connect, 5s total)
        let mut stream = match TcpStream::connect_timeout(
            &format!("{host}:{port}")
                .parse()
                .unwrap_or_else(|_| std::net::SocketAddr::from(([127, 0, 0, 1], port))),
            std::time::Duration::from_secs(2),
        ) {
            Ok(s) => s,
            Err(_) => return false,
        };
        stream
            .set_read_timeout(Some(std::time::Duration::from_secs(5)))
            .ok();
        stream
            .set_write_timeout(Some(std::time::Duration::from_secs(5)))
            .ok();

        let auth_header = if bearer.is_empty() {
            String::new()
        } else {
            format!("Authorization: Bearer {bearer}\r\n")
        };

        let request = format!(
            "PUT {target} HTTP/1.1\r\n\
             Host: {host}:{port}\r\n\
             Content-Type: application/json\r\n\
             Content-Length: {}\r\n\
             Connection: close\r\n\
             {auth_header}\
             \r\n\
             {body}",
            body.len()
        );

        if stream.write_all(request.as_bytes()).is_err() {
            return false;
        }

        // Read response status line (first line only)
        let mut buf = [0u8; 256];
        let mut response = Vec::new();
        loop {
            match stream.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => response.extend_from_slice(buf.get(..n).unwrap_or_default()),
            }
            // Stop after we have the status line
            if response.windows(4).any(|w| w == b"\r\n\r\n") {
                break;
            }
        }

        // Check for HTTP 2xx status (200, 204, etc.)
        // Require at least 3 digits to avoid truncated responses being treated as success.
        response.starts_with(b"HTTP/")
            && response
                .get(9..12)
                .is_some_and(|s| s.first() == Some(&b'2'))
    }
}

impl PrismHost for ZephyrPrismHost {
    // -- Required methods ----------------------------------------------------

    fn read_running_config(&self) -> Result<String, String> {
        let paths = ensure_app_storage(&self.app)?;
        std::fs::read_to_string(paths.core_dir.join("run_config.yaml"))
            .map_err(|e| format!("Failed to read running config: {e}"))
    }

    fn apply_config(&self, config: &str) -> Result<ApplyStatus, String> {
        let paths = ensure_app_storage(&self.app)?;
        let run_config_path = paths.core_dir.join("run_config.yaml");

        // Secure write (Unix 0600 / Windows DACL)
        write_file_secure(&run_config_path, config)?;

        // Hot-reload via mihomo REST API (PUT for full config replacement)
        let (port, secret) = {
            let state = self.app.state::<MihomoState>();
            let lock = lock_critical(&state.0, BackendModule::Core, codes::CORE_LOCK_FAILED)?;
            (
                lock.last_port().unwrap_or(9090),
                lock.last_secret().to_owned(),
            )
        };

        let url = format!("http://127.0.0.1:{port}/configs?force=true");
        // Mihomo's PUT /configs expects a JSON body {"path": "..."} to reload
        // from disk — NOT the raw YAML config. Sending raw YAML with
        // Content-Type: application/json causes a silent 400 Bad Request.
        let body = serde_json::json!({ "path": run_config_path.to_string_lossy() }).to_string();
        // Synchronous HTTP PUT --- apply_config is a sync trait method that may be
        // called from non-tokio threads (e.g. WebView2 COM callbacks). Using
        // std::net avoids the "no reactor running" panic from block_on().
        let hot_reload_success = Self::http_put(&url, &body, &secret);

        Ok(ApplyStatus {
            files_saved: true,
            hot_reload_success,
            message: if hot_reload_success {
                "Config applied and reloaded".to_owned()
            } else {
                "Config saved. Restart core to apply.".to_owned()
            },
            restarted: false,
        })
    }

    fn get_prism_workspace(&self) -> Result<std::path::PathBuf, String> {
        prism_data_dir(&self.app)
    }

    fn notify(&self, event: PrismEvent) {
        crate::backend_event::emit_to_main(&self.app, "prism-event", event);
    }

    // -- Optional methods (override defaults) --------------------------------

    fn read_raw_profile(&self, profile_id: &str) -> Result<String, String> {
        // H-5: Sanitize profile_id to prevent path traversal
        let safe_id = sanitize_filename(profile_id)?;
        let paths = ensure_app_storage(&self.app)?;
        let profile_path = paths.profiles_dir.join(&safe_id);
        validate_path_within_dir(&profile_path, &paths.profiles_dir).map_err(|e| e.to_string())?;
        let metadata = std::fs::metadata(&profile_path)
            .map_err(|e| format!("Failed to read profile '{safe_id}': {e}"))?;
        if metadata.len() > MAX_RESPONSE_SIZE as u64 {
            return Err(format!(
                "Profile '{safe_id}' exceeds maximum size of {MAX_RESPONSE_SIZE} bytes"
            ));
        }
        // Use read_profile_file to auto-decrypt encrypted profiles (encrypt_configs)
        // Without this, encrypted YAML is parsed as a plain string,
        // causing "No 'rules' section found in profile" when extracting rules.
        read_profile_file(&profile_path)
            .map_err(|e| format!("Failed to read profile '{safe_id}': {e}"))
    }

    fn list_profiles(&self) -> Result<Vec<ProfileInfo>, String> {
        let paths = ensure_app_storage(&self.app)?;
        let current = {
            let state = self.app.state::<MihomoState>();
            state
                .0
                .lock()
                .ok()
                .and_then(|lock| lock.last_config_path().map(String::from))
                .unwrap_or_default()
        };

        let entries = std::fs::read_dir(&paths.profiles_dir)
            .map_err(|e| format!("Failed to read profiles dir: {e}"))?;

        let mut profiles = Vec::new();
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            let is_yaml = name.ends_with(".yaml") || name.ends_with(".yml");
            if is_yaml {
                let is_current = name == current;
                profiles.push(ProfileInfo {
                    id: name.clone(),
                    name,
                    profile_type: "local".to_owned(),
                    is_current,
                });
            }
        }

        Ok(profiles)
    }

    fn get_core_info(&self) -> Result<CoreInfo, String> {
        let state = self.app.state::<MihomoState>();
        let lock = lock_critical(&state.0, BackendModule::Core, codes::CORE_LOCK_FAILED)?;
        Ok(CoreInfo {
            version: String::from("unknown"), // async get_core_version unavailable in sync trait
            api_port: lock.last_port().unwrap_or(9090),
            api_secret: lock.last_secret().to_owned(),
            is_running: lock.process().is_some(),
        })
    }

    fn get_current_profile(&self) -> Option<String> {
        let state = self.app.state::<MihomoState>();
        let path = lock_best_effort(&state.0).last_config_path()?.to_owned();
        let stem = std::path::Path::new(&path)
            .file_stem()
            .and_then(|s| s.to_str())
            .map(String::from);
        stem
    }

    fn get_variables(&self) -> std::collections::HashMap<String, String> {
        let mut vars = std::collections::HashMap::new();

        // Read the final merged config (run_config.yaml) to extract proxy-group names.
        // This allows {{proxy|DIRECT}} in .prism.yaml files to resolve to the actual
        // proxy group name from the current subscription.
        let paths = match ensure_app_storage(&self.app) {
            Ok(p) => p,
            Err(_) => return vars,
        };
        let run_config = paths.core_dir.join("run_config.yaml");
        let content = match std::fs::read_to_string(&run_config) {
            Ok(c) => c,
            Err(_) => return vars,
        };

        // Parse just enough to get proxy-groups[].name
        if let Ok(config) = serde_yaml::from_str::<serde_yaml::Value>(&content) {
            if let Some(groups) = config.get("proxy-groups").and_then(|g| g.as_sequence()) {
                // Collect all non-special proxy group names
                let names: Vec<String> = groups
                    .iter()
                    .filter_map(|g| g.get("name").and_then(|n| n.as_str()).map(String::from))
                    .filter(|n| {
                        // Skip internal/special groups
                        !matches!(n.as_str(), "GLOBAL" | "DIRECT" | "REJECT" | "PASS")
                    })
                    .collect();

                // Provide "proxy" = first usable proxy group name (typically the main selector)
                if let Some(first) = names.first() {
                    vars.insert("proxy".to_owned(), first.clone());
                }

                // Also provide each group name as a variable (identity mapping)
                // so users can reference specific groups.
                for name in &names {
                    vars.insert(name.clone(), name.clone());
                }
                // Debug: log resolved variables for diagnosing cross-subscription rule errors
                let proxy_val = vars.get("proxy").map(String::as_str).unwrap_or("<none>");
                emit_info!(
                    Prism,
                    PRISM_SCRIPT_ERROR,
                    "get_variables: proxy={proxy_val}, groups={names:?}"
                );
            }
        }

        vars
    }

    fn validate_config(&self, config: &str) -> Result<bool, String> {
        let paths = ensure_app_storage(&self.app)?;
        let tmp_path = paths.core_dir.join("_prism_validate.yaml");
        write_file_secure(&tmp_path, config)?;

        let exe = crate::core_manager::get_core_exe_path(&self.app)?;
        let mut cmd = std::process::Command::new(&exe);
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt as _;
            cmd.creation_flags(crate::core_manager::CREATE_NO_WINDOW);
        }
        let output = cmd
            .args(["-t", "-f"])
            .arg(&tmp_path)
            .output()
            .map_err(|e| format!("Failed to run validation: {e}"))?;

        let _ = std::fs::remove_file(&tmp_path);
        Ok(output.status.success())
    }

    fn get_ssid(&self) -> Option<String> {
        detect_ssid()
    }
}
