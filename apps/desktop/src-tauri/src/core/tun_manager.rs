use std::sync::atomic::Ordering;
use tauri::AppHandle;

#[cfg(not(target_os = "macos"))]
use super::core_process::resolve_app_paths;
#[cfg(target_os = "macos")]
use super::core_process::{
    ensure_executable, generate_secret, get_core_exe_path, resolve_app_paths,
};
use super::secure_io::write_file_secure;
use super::{TUN_MODE_ACTIVE, TUN_TOGGLING};

/// Set TUN mode active state
pub fn set_tun_mode(active: bool) {
    TUN_MODE_ACTIVE.store(active, Ordering::SeqCst);
}

/// Check if TUN mode is currently active
pub fn is_tun_mode() -> bool {
    TUN_MODE_ACTIVE.load(Ordering::SeqCst)
}

/// Try to acquire TUN toggle lock. Returns true if acquired, false if already toggling.
pub fn try_acquire_tun_toggle() -> bool {
    TUN_TOGGLING
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_ok()
}

/// Release TUN toggle lock
#[tauri::command]
pub fn release_tun_toggle() {
    TUN_TOGGLING.store(false, Ordering::SeqCst);
}

/// Check if TUN toggle is in progress
pub fn is_tun_toggling() -> bool {
    TUN_TOGGLING.load(Ordering::SeqCst)
}

/// Extract secret from YAML config content using the YAML parser.
/// This avoids issues with line-by-line parsing (multi-line strings, comments, etc.).
#[cfg(target_os = "macos")]
fn extract_secret_from_yaml(content: &str) -> Option<String> {
    let yaml: serde_yaml::Value = serde_yaml::from_str(content).ok()?;
    yaml.get("secret")
        .and_then(|v| v.as_str())
        .map(|s| s.to_owned())
}

use serde_yaml::Value as YamlValue;

/// Ensure dns-hijack list contains both UDP (`any:53`) and TCP (`tcp://any:53`) entries.
/// This prevents DNS leaks by hijacking all DNS traffic to mihomo.
fn ensure_dns_hijack_entries(tun_map: &mut serde_yaml::Mapping) {
    const ANY_UDP: &str = "any:53";
    const ANY_TCP: &str = "tcp://any:53";

    let dns_hijack_key = YamlValue::String("dns-hijack".to_owned());
    let any_udp_val = YamlValue::String(ANY_UDP.to_owned());
    let any_tcp_val = YamlValue::String(ANY_TCP.to_owned());

    match tun_map.entry(dns_hijack_key) {
        serde_yaml::mapping::Entry::Occupied(mut entry) => {
            // Existing dns-hijack entry - ensure it contains both entries
            match entry.get_mut() {
                YamlValue::Sequence(seq) => {
                    if !seq.contains(&any_udp_val) {
                        seq.push(any_udp_val);
                    }
                    if !seq.contains(&any_tcp_val) {
                        seq.push(any_tcp_val);
                    }
                }
                // If it's not a sequence (e.g., a string or other type), replace it
                YamlValue::Null
                | YamlValue::Bool(_)
                | YamlValue::Number(_)
                | YamlValue::String(_)
                | YamlValue::Mapping(_)
                | YamlValue::Tagged(_) => {
                    entry.insert(YamlValue::Sequence(vec![any_udp_val, any_tcp_val]));
                }
            }
        }
        serde_yaml::mapping::Entry::Vacant(entry) => {
            // No dns-hijack entry - create new sequence
            entry.insert(YamlValue::Sequence(vec![any_udp_val, any_tcp_val]));
        }
    }
}

/// Update TUN enable setting in YAML config content using `serde_yaml`.
/// Returns updated content with TUN block modified or appended.
fn update_tun_in_yaml(content: &str, enable: bool) -> Result<String, String> {
    let mut yaml = serde_yaml::from_str::<YamlValue>(content)
        .map_err(|e| format!("Failed to parse YAML config: {e}"))?;

    if let Some(mapping) = yaml.as_mapping_mut() {
        let tun = mapping
            .entry(YamlValue::String("tun".to_owned()))
            .or_insert_with(|| YamlValue::Mapping(serde_yaml::Mapping::new()));
        if let Some(tun_map) = tun.as_mapping_mut() {
            tun_map.insert(
                YamlValue::String("enable".to_owned()),
                YamlValue::Bool(enable),
            );
            // Preserve sensible defaults when enabling TUN
            if enable {
                tun_map
                    .entry(YamlValue::String("stack".to_owned()))
                    .or_insert_with(|| YamlValue::String("system".to_owned()));
                tun_map
                    .entry(YamlValue::String("auto-route".to_owned()))
                    .or_insert_with(|| YamlValue::Bool(true));
                tun_map
                    .entry(YamlValue::String("auto-detect-interface".to_owned()))
                    .or_insert_with(|| YamlValue::Bool(true));
                // Hijack all DNS traffic to prevent leaks (UDP + TCP)
                ensure_dns_hijack_entries(tun_map);
            }
        }
    }

    serde_yaml::to_string(&yaml)
        .map_err(|e| format!("Failed to serialize YAML after TUN toggle: {e}"))
}

/// Extract TUN enable status from YAML config content using `serde_yaml`.
fn extract_tun_enabled_from_yaml(content: &str) -> bool {
    let yaml = match serde_yaml::from_str::<YamlValue>(content) {
        Ok(v) => v,
        Err(_) => return false,
    };

    yaml.get("tun")
        .and_then(|t| t.get("enable"))
        .and_then(YamlValue::as_bool)
        .unwrap_or(false)
}

/// Restart mihomo core with root privileges on macOS for TUN mode
/// This is required because creating /dev/utun devices needs root access
/// Returns the secret for frontend to update
#[cfg(target_os = "macos")]
pub async fn restart_core_as_root(app: &AppHandle, enable_tun: bool) -> Result<String, String> {
    let paths = resolve_app_paths(app)?;
    let core_path = get_core_exe_path(app)?;
    ensure_executable(&core_path)?;

    let config_dir_str = paths.core_dir.to_string_lossy();

    // Update TUN config in run_config.yaml before starting
    let config_file = paths.core_dir.join("run_config.yaml");
    let mut secret = String::new();

    if config_file.exists() {
        let content = std::fs::read_to_string(&config_file)
            .map_err(|e| format!("Failed to read config: {e}"))?;

        // Extract current secret from config or generate new one
        secret = extract_secret_from_yaml(&content).unwrap_or_else(|| generate_secret());

        // Update TUN setting
        let mut updated = update_tun_in_yaml(&content, enable_tun)?;

        // Ensure secret is present and up-to-date
        let mut found_secret = false;
        let mut lines: Vec<String> = updated
            .lines()
            .map(|line| {
                if line.trim().starts_with("secret:") {
                    found_secret = true;
                    let indent = line
                        .chars()
                        .take_while(|c| c.is_whitespace())
                        .collect::<String>();
                    format!("{indent}secret: {secret}")
                } else {
                    line.to_owned()
                }
            })
            .collect();

        if !found_secret {
            lines.push(format!("secret: {secret}"));
        }

        updated = lines.join("\n");

        write_file_secure(&config_file, &updated)
            .map_err(|e| format!("Failed to write config: {e}"))?;
    }

    // Build the command: kill all mihomo (including root), wait, then start new
    // All in one osascript with administrator privileges
    // Use user-specific Logs directory (~/Library/Logs/) - secure and predictable for debugging
    let log_path = std::env::var("HOME")
        .map(|h| {
            // macOS: ~/Library/Logs/ - user-specific, other users cannot access
            let path = format!("{h}/Library/Logs");
            // Create directory if it doesn't exist
            if let Err(e) = std::fs::create_dir_all(&path) {
                emit_warn!(
                    System,
                    SYS_TUN_FAILED,
                    "Failed to create log directory: {e}"
                );
            }
            format!("{path}/mihomo-tun.log")
        })
        .unwrap_or_else(|_| {
            // Fallback to user temp directory with fixed name
            let temp = std::env::temp_dir();
            temp.join("mihomo-tun.log").to_string_lossy().into_owned()
        });

    // CRITICAL: Escape paths for shell single-quote context to prevent command injection
    // Replace all ' with '\'' (end quote, escaped quote, start quote)
    let escaped_config_dir = config_dir_str.replace("'", "'\\''");
    let escaped_log_path = log_path.replace("'", "'\\''");

    // Get binary name from resolved core_path to ensure backward compatibility
    let binary_name = core_path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "Invalid core binary name".to_owned())?;
    let escaped_binary_name = binary_name.replace("'", "'\\''");
    // Kill both new (zephyr-mihomo) and legacy (mihomo) names to handle upgrade scenario
    // where a root-owned legacy process might still be running
    // Also apply TCP performance optimizations (Google Cloud best practices):
    //   - MSL=1000: reduce TIME_WAIT from 60s to 2s for faster port reuse
    //   - tcp.fastopen=3: enable TCP Fast Open for client+server
    //   - tcp.ecn=1: enable ECN for congestion signaling without drops
    // Note: macOS BSD kernel has no direct equivalent to Linux's tcp_slow_start_after_idle
    // or tcp_rto_min_us; these optimizations are Linux-specific.
    let script = format!(
        r#"do shell script "killall -9 zephyr-mihomo mihomo 2>/dev/null; sysctl -w net.inet.tcp.msl=1000 2>/dev/null; sysctl -w net.inet.tcp.fastopen=3 2>/dev/null; sysctl -w net.inet.tcp.ecn=1 2>/dev/null; sleep 0.3; cd '{escaped_config_dir}' && './{escaped_binary_name}' -d '.' -f 'run_config.yaml' > '{escaped_log_path}' 2>&1 &" with administrator privileges"#,
    );

    // Spawn osascript without waiting for it to complete
    // The & at the end of the shell command makes mihomo run in background
    // but osascript might still wait, so we use spawn() instead of output()
    let mut child = std::process::Command::new("osascript")
        .arg("-e")
        .arg(&script)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn osascript: {e}"))?;

    // Wait a bit for osascript to potentially show errors (like user cancel)
    tokio::time::sleep(std::time::Duration::from_millis(1000)).await;

    // Check if osascript exited quickly with an error (e.g., user canceled)
    match child.try_wait() {
        Ok(Some(status)) => {
            if !status.success() {
                // Read stderr to get the error
                let stderr = child.stderr.take();
                if let Some(mut stderr) = stderr {
                    let mut err = String::new();
                    let _ = std::io::Read::read_to_string(&mut stderr, &mut err);
                    if err.contains("canceled") || err.contains("User canceled") {
                        return Err("canceled".to_owned());
                    }
                    return Err(format!("osascript failed: {err}"));
                }
                return Err("osascript failed".to_owned());
            }
        }
        Ok(None) => {
            // Still running, which is expected - password dialog is showing
        }
        Err(_) => {}
    }

    // Wait for root mihomo to appear (poll for up to 30 seconds to allow time for password entry)
    let mut started = false;
    for _ in 0..60 {
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;

        // Check if user canceled (osascript exited with failure)
        if let Ok(Some(status)) = child.try_wait() {
            if !status.success() {
                return Err("canceled".to_owned());
            }
        }

        if has_root_mihomo() {
            started = true;
            break;
        }
    }

    if !started {
        // Kill osascript if still running
        let _ = child.kill();
        return Err("Root mihomo failed to start within 30 seconds".to_owned());
    }

    // Wait for port to be bound
    let mut bound = false;
    for _ in 0..10 {
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        if std::net::TcpStream::connect("127.0.0.1:9090").is_ok() {
            bound = true;
            break;
        }
    }

    if !bound {
        return Err("root_start_failed".to_owned());
    }

    // MSL and TCP optimizations are already set in the root osascript above (sysctl needs root)
    emit_info!(
        System,
        SYS_TUN_FAILED,
        "TCP optimizations applied: MSL=1000, FastOpen=3, ECN=1 (via root shell)"
    );

    // Mark TUN mode as active
    set_tun_mode(true);

    Ok(secret)
}

/// On non-macOS platforms, this is a no-op
#[cfg(not(target_os = "macos"))]
#[allow(dead_code)]
pub const fn restart_core_as_root(_app: &AppHandle, _enable_tun: bool) -> Result<String, String> {
    Ok(String::new())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    // Helper to extract dns-hijack values from YAML string
    fn extract_dns_hijack(content: &str) -> Option<Vec<String>> {
        let yaml = serde_yaml::from_str::<YamlValue>(content).ok()?;
        let mapping = yaml.as_mapping()?;
        let tun = mapping
            .get(YamlValue::String("tun".to_owned()))?
            .as_mapping()?;
        let hijack = tun
            .get(YamlValue::String("dns-hijack".to_owned()))?
            .as_sequence()?;
        hijack
            .iter()
            .map(|v| v.as_str().map(std::borrow::ToOwned::to_owned))
            .collect()
    }

    #[test]
    fn test_update_tun_enable_no_tun_section() {
        // Case: no tun section at all
        let content = "proxies:\n  - name: test\n";
        let updated = update_tun_in_yaml(content, true).expect("YAML update should succeed");

        let hijack = extract_dns_hijack(&updated).expect("should have dns-hijack");
        assert!(hijack.contains(&"any:53".to_owned()));
        assert!(hijack.contains(&"tcp://any:53".to_owned()));
    }

    #[test]
    fn test_update_tun_enable_no_dns_hijack() {
        // Case: tun exists but no dns-hijack
        let content = "tun:\n  enable: false\n  stack: system\n";
        let updated = update_tun_in_yaml(content, true).expect("YAML update should succeed");

        let hijack = extract_dns_hijack(&updated).expect("should have dns-hijack");
        assert!(hijack.contains(&"any:53".to_owned()));
        assert!(hijack.contains(&"tcp://any:53".to_owned()));
    }

    #[test]
    fn test_update_tun_enable_empty_dns_hijack() {
        // Case: dns-hijack: []
        let content = "tun:\n  enable: false\n  dns-hijack: []\n";
        let updated = update_tun_in_yaml(content, true).expect("YAML update should succeed");

        let hijack = extract_dns_hijack(&updated).expect("should have dns-hijack");
        assert!(hijack.contains(&"any:53".to_owned()));
        assert!(hijack.contains(&"tcp://any:53".to_owned()));
    }

    #[test]
    fn test_update_tun_enable_partial_dns_hijack_udp_only() {
        // Case: dns-hijack: [any:53] - missing TCP
        let content = "tun:\n  enable: false\n  dns-hijack:\n    - any:53\n";
        let updated = update_tun_in_yaml(content, true).expect("YAML update should succeed");

        let hijack = extract_dns_hijack(&updated).expect("should have dns-hijack");
        assert!(hijack.contains(&"any:53".to_owned()));
        assert!(hijack.contains(&"tcp://any:53".to_owned()));
    }

    #[test]
    fn test_update_tun_enable_partial_dns_hijack_tcp_only() {
        // Case: dns-hijack: [tcp://any:53] - missing UDP
        let content = "tun:\n  enable: false\n  dns-hijack:\n    - tcp://any:53\n";
        let updated = update_tun_in_yaml(content, true).expect("YAML update should succeed");

        let hijack = extract_dns_hijack(&updated).expect("should have dns-hijack");
        assert!(hijack.contains(&"any:53".to_owned()));
        assert!(hijack.contains(&"tcp://any:53".to_owned()));
    }

    #[test]
    fn test_update_tun_enable_complete_dns_hijack_unchanged() {
        // Case: dns-hijack already complete - should not duplicate
        let content = "tun:\n  enable: false\n  dns-hijack:\n    - any:53\n    - tcp://any:53\n";
        let updated = update_tun_in_yaml(content, true).expect("YAML update should succeed");

        let hijack = extract_dns_hijack(&updated).expect("should have dns-hijack");
        assert_eq!(hijack.len(), 2);
        assert!(hijack.contains(&"any:53".to_owned()));
        assert!(hijack.contains(&"tcp://any:53".to_owned()));
    }

    #[test]
    fn test_update_tun_enable_dns_hijack_wrong_type() {
        // Case: dns-hijack is a string instead of sequence - should replace
        let content = "tun:\n  enable: false\n  dns-hijack: \"any:53\"\n";
        let updated = update_tun_in_yaml(content, true).expect("YAML update should succeed");

        let hijack = extract_dns_hijack(&updated).expect("should have dns-hijack");
        assert!(hijack.contains(&"any:53".to_owned()));
        assert!(hijack.contains(&"tcp://any:53".to_owned()));
    }

    #[test]
    fn test_update_tun_disable_no_dns_hijack_added() {
        // Case: enable=false should NOT add dns-hijack
        let content = "tun:\n  enable: true\n";
        let updated = update_tun_in_yaml(content, false).expect("YAML update should succeed");

        // dns-hijack should not be present when disabling
        let yaml = serde_yaml::from_str::<YamlValue>(&updated).expect("valid yaml");
        let tun = yaml
            .as_mapping()
            .and_then(|m| m.get(YamlValue::String("tun".to_owned())))
            .and_then(YamlValue::as_mapping)
            .expect("should have tun mapping");
        assert!(tun
            .get(YamlValue::String("dns-hijack".to_owned()))
            .is_none());
        assert_eq!(
            tun.get(YamlValue::String("enable".to_owned()))
                .and_then(YamlValue::as_bool),
            Some(false)
        );
    }

    #[test]
    fn test_ensure_dns_hijack_entries_directly() {
        // Direct test of ensure_dns_hijack_entries
        let mut tun_map = serde_yaml::Mapping::new();
        ensure_dns_hijack_entries(&mut tun_map);

        let hijack = tun_map
            .get(YamlValue::String("dns-hijack".to_owned()))
            .and_then(YamlValue::as_sequence)
            .expect("should have dns-hijack sequence");
        let values: Vec<String> = hijack
            .iter()
            .map(|v| v.as_str().expect("should be string").to_owned())
            .collect();
        assert!(values.contains(&"any:53".to_owned()));
        assert!(values.contains(&"tcp://any:53".to_owned()));
    }
}

/// Check if there's a root-owned mihomo process running
/// Checks for both zephyr-mihomo (new) and mihomo (legacy) for backward compatibility
#[cfg(target_os = "macos")]
fn has_root_mihomo() -> bool {
    if let Ok(output) = std::process::Command::new("ps")
        .args(["-axo", "user,comm"])
        .output()
    {
        let text = String::from_utf8_lossy(&output.stdout);
        text.lines().any(|line| {
            let trimmed = line.trim_start();
            trimmed.starts_with("root ")
                && (trimmed.contains("zephyr-mihomo") || trimmed.contains("mihomo"))
        })
    } else {
        false
    }
}

#[cfg(not(target_os = "macos"))]
#[allow(dead_code)]
const fn has_root_mihomo() -> bool {
    false
}

/// Kill all mihomo processes with root privileges (kills both root and user processes)
/// Also cleans up TUN interface and routes to avoid blocking new mihomo startup
/// Note: Does NOT clear TUN mode flag - caller should call set_tun_mode(false) if disabling TUN
#[cfg(target_os = "macos")]
pub fn kill_all_mihomo_as_root() -> Result<(), String> {
    // Reduce MSL to 1s so TIME_WAIT expires quickly (default 15s = 30s TIME_WAIT)
    // Kill both zephyr-mihomo (new) and mihomo (legacy) for backward compatibility
    let script = r#"do shell script "killall -9 zephyr-mihomo mihomo 2>/dev/null; sleep 0.3; sysctl -w net.inet.tcp.msl=1000; route delete 0.0.0.0/1 2>/dev/null; route delete 128.0.0.0/1 2>/dev/null; true" with administrator privileges"#;
    let status = std::process::Command::new("osascript")
        .args(["-e", script])
        .status()
        .map_err(|e| format!("Failed to run osascript: {e}"))?;

    if !status.success() {
        return Err(format!("osascript exit code: {status}"));
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub const fn kill_all_mihomo_as_root() -> Result<(), String> {
    Ok(())
}

/// Smart kill: only prompt for password if there's actually a root mihomo running
/// Note: This kills ALL mihomo processes, not just root ones
#[cfg(target_os = "macos")]
pub fn smart_kill_all_mihomo_as_root() -> Result<(), String> {
    if !has_root_mihomo() {
        return Ok(()); // No root mihomo, silently return
    }
    kill_all_mihomo_as_root()
}

#[cfg(not(target_os = "macos"))]
pub const fn smart_kill_all_mihomo_as_root() -> Result<(), String> {
    Ok(())
}

/// Tauri command to kill all mihomo with root privileges
#[tauri::command]
pub fn kill_all_mihomo_as_root_cmd(_app: tauri::AppHandle) -> Result<(), String> {
    kill_all_mihomo_as_root()
}

/// Tauri command to disable TUN mode (clears flag and kills root mihomo)
/// Only available on macOS - TUN requires root on macOS
#[tauri::command]
#[cfg(target_os = "macos")]
pub fn disable_tun_cmd(_app: tauri::AppHandle) -> Result<(), String> {
    set_tun_mode(false);
    kill_all_mihomo_as_root()?;

    // Wait for ALL root processes (including osascript shell) to die
    let mut waited = 0;
    loop {
        let has_root_process = std::process::Command::new("sh")
            .args(["-c", "ps aux | grep -E 'mihomo|osascript.*mihomo|sleep.*mihomo' | grep root | grep -v grep"])
            .output()
            .map(|o| !String::from_utf8_lossy(&o.stdout).trim().is_empty())
            .unwrap_or(false);

        if !has_root_process || waited > 8000 {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(200));
        waited += 200;
    }

    Ok(())
}

/// Tauri command to disable TUN mode on non-macOS platforms
/// TUN mode is handled differently on Windows/Linux and doesn't require root
#[tauri::command]
#[cfg(not(target_os = "macos"))]
#[allow(clippy::needless_pass_by_value)]
pub fn disable_tun_cmd(app: tauri::AppHandle) -> Result<(), String> {
    set_tun_mode(false);
    // On Windows/Linux, TUN is handled via config change, no need for root kill
    // Just update the config
    set_tun_enabled_internal(&app, false)
}

/// Update TUN enable setting in `run_config.yaml` (without restarting core)
pub fn set_tun_enabled_internal(app: &AppHandle, enable: bool) -> Result<(), String> {
    let paths = resolve_app_paths(app)?;
    let config_file = paths.core_dir.join("run_config.yaml");

    if !config_file.exists() {
        return Err("Config file not found".to_owned());
    }

    let content =
        std::fs::read_to_string(&config_file).map_err(|e| format!("Failed to read config: {e}"))?;

    let updated = update_tun_in_yaml(&content, enable)?;

    write_file_secure(&config_file, &updated)
        .map_err(|e| format!("Failed to write config: {e}"))?;

    Ok(())
}

/// Tauri command to set TUN enabled in config (without restarting)
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn set_tun_enabled(app: tauri::AppHandle, enable: bool) -> Result<(), String> {
    set_tun_enabled_internal(&app, enable)
}

/// Initialize TUN mode flag from config file (call at app startup)
pub fn init_tun_mode_from_config(app: &AppHandle) -> Result<(), String> {
    let paths = resolve_app_paths(app)?;
    let config_file = paths.core_dir.join("run_config.yaml");

    if !config_file.exists() {
        return Ok(());
    }

    let content =
        std::fs::read_to_string(&config_file).map_err(|e| format!("Failed to read config: {e}"))?;

    // Check if TUN is enabled in config
    let tun_enabled = extract_tun_enabled_from_yaml(&content);

    set_tun_mode(tun_enabled);
    emit_info!(
        System,
        SYS_TUN_FAILED,
        "TUN mode initialized from config: {tun_enabled}"
    );

    Ok(())
}

/// Tauri command to restart mihomo core with root privileges on macOS for TUN mode
/// Returns the secret for frontend to update
#[tauri::command]
#[cfg(target_os = "macos")]
pub async fn restart_core_as_root_cmd(
    app: tauri::AppHandle,
    enable_tun: bool,
) -> Result<String, String> {
    restart_core_as_root(&app, enable_tun).await
}

/// On non-macOS platforms, this is a no-op
#[tauri::command]
#[cfg(not(target_os = "macos"))]
pub async fn restart_core_as_root_cmd(
    _app: tauri::AppHandle,
    _enable_tun: bool,
) -> Result<String, String> {
    Ok(String::new())
}

/// Grant `CAP_NET_ADMIN` capability to the mihomo binary on Linux and install
/// a `PolicyKit` rule to allow DNS/route configuration without password prompts.
/// Also applies TCP performance optimizations following Google Cloud best practices:
/// - Disable slow-start-after-idle (avoid congestion window reset after idle)
/// - Lower `MinRTO` for faster loss recovery
/// - Enable TCP Fast Open for reduced handshake latency
/// - Enable ECN for congestion signaling without packet loss
/// Uses pkexec to prompt for authentication once, then runs setcap,
/// sysctl tuning, and installs the polkit rule file.
#[tauri::command]
#[cfg(target_os = "linux")]
pub async fn grant_linux_tun_permission(app: tauri::AppHandle) -> Result<(), String> {
    use super::core_process::get_core_exe_path;
    let core_path = get_core_exe_path(&app)?;
    let core_path_str = core_path
        .to_str()
        .ok_or_else(|| "Core path contains invalid UTF-8".to_owned())?;

    emit_info!(
        System,
        SYS_TUN_FAILED,
        "Granting CAP_NET_ADMIN, applying TCP optimizations, and installing polkit rule for: {core_path_str}"
    );

    let username = whoami().map_err(|e| format!("Failed to get username: {e}"))?;

    let polkit_rule = format!(
        r#"polkit.addRule(function(action, subject) {{
    if ((action.id == "org.freedesktop.resolve1.set-domains" ||
         action.id == "org.freedesktop.resolve1.set-default-route" ||
         action.id == "org.freedesktop.resolve1.set-dns-servers" ||
         action.id == "org.freedesktop.resolve1.revert" ||
         action.id == "org.freedesktop.NetworkManager.settings.modify.system" ||
         action.id == "org.freedesktop.NetworkManager.network-control") &&
        subject.user == "{username}") {{
        return polkit.Result.YES;
    }}
}});
"#
    );

    // Combined script: setcap + TCP sysctl tuning + polkit rule installation
    // Google Cloud TCP best practices (lines 3912-4160 of optimization doc):
    //   1. tcp_slow_start_after_idle=0 — maintain congestion window after idle
    //   2. tcp_rto_min_us=5000 — lower MinRTO for faster loss recovery (Linux 6.11+)
    //      Fallback: ip route change default rto_min 5ms for older kernels
    //   3. tcp_fastopen=3 — enable TCP Fast Open for both client and server
    //   4. tcp_ecn=1 — enable ECN for congestion signaling without drops
    //   5. Fair Queueing — required prerequisite for disabling slow-start-after-idle
    //      (Google warns: without FQ, idle connections may send line-rate bursts)
    let script = r#"set -e
export PATH="/usr/sbin:/sbin:$PATH"

# Grant network capabilities to mihomo
setcap cap_net_admin,cap_net_bind_service+ep "$1"

# TCP performance tuning (Google Cloud best practices)
# All sysctl writes are idempotent and safe for general use.

# Fair Queueing MUST be installed before disabling slow-start-after-idle.
# Without FQ, idle connections may send line-rate bursts causing packet loss.
# Only disable slow-start-after-idle if FQ was successfully applied.
FQ_APPLIED=0
DEFAULT_IF="$(ip route show default 2>/dev/null | awk '/default/ {print $5; exit}')"
if [ -n "$DEFAULT_IF" ] && tc qdisc replace dev "$DEFAULT_IF" root fq 2>/dev/null; then
    FQ_APPLIED=1
fi

if [ "$FQ_APPLIED" -eq 1 ]; then
    sysctl -w net.ipv4.tcp_slow_start_after_idle=0 2>/dev/null || true
fi
sysctl -w net.ipv4.tcp_fastopen=3 2>/dev/null || true
sysctl -w net.ipv4.tcp_ecn=1 2>/dev/null || true

# Lower MinRTO — Linux 6.11+ uses tcp_rto_min_us, older kernels use ip route
if ! sysctl -w net.ipv4.tcp_rto_min_us=5000 2>/dev/null; then
    # ip route change requires full route spec (via + dev) to uniquely identify the route
    DEFAULT_ROUTE="$(ip route show default 2>/dev/null | head -1)"
    if [ -n "$DEFAULT_ROUTE" ]; then
        ip route change $DEFAULT_ROUTE rto_min 5ms 2>/dev/null || true
    fi
fi

# Install polkit rule for passwordless DNS/route operations
mkdir -p /etc/polkit-1/rules.d
printf '%s' "$2" > /etc/polkit-1/rules.d/50-zephyr-tun.rules
chmod 644 /etc/polkit-1/rules.d/50-zephyr-tun.rules"#;

    let output = std::process::Command::new("pkexec")
        .args(["bash", "-c", script, "bash", core_path_str, &polkit_rule])
        .output()
        .map_err(|e| format!("Failed to execute pkexec: {e}"))?;

    if output.status.success() {
        emit_info!(
            System,
            SYS_TUN_FAILED,
            "CAP_NET_ADMIN granted, TCP optimizations applied, and polkit rule installed successfully"
        );
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("Request dismissed")
            || stderr.contains("canceled")
            || stderr.contains("cancelled")
        {
            Err("canceled".to_owned())
        } else {
            Err(format!("permission grant failed: {stderr}"))
        }
    }
}

#[cfg(target_os = "linux")]
fn whoami() -> Result<String, String> {
    let name = std::env::var("USER")
        .or_else(|_| std::env::var("LOGNAME"))
        .or_else(|_| {
            let output = std::process::Command::new("whoami")
                .output()
                .map_err(|e| format!("Failed to execute whoami: {e}"))?;
            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                return Err(format!("whoami failed: {stderr}"));
            }
            Ok(String::from_utf8_lossy(&output.stdout).trim().to_owned())
        })?;
    if name.is_empty()
        || !name
            .chars()
            .all(|c| c.is_alphanumeric() || c == '_' || c == '-' || c == '.' || c == '@')
    {
        return Err(format!("Invalid username for polkit rule: {name}"));
    }
    Ok(name)
}

/// On non-Linux platforms, this is a no-op
#[tauri::command]
#[cfg(not(target_os = "linux"))]
pub async fn grant_linux_tun_permission(_app: tauri::AppHandle) -> Result<(), String> {
    Ok(())
}

/// Apply Windows TCP performance optimizations following Google Cloud best practices.
/// These netsh commands require administrator privileges, which is typically already
/// available when TUN mode is active (WinTUN requires admin to install driver).
///
/// Optimizations applied:
/// - autotuninglevel=normal: enable TCP receive window auto-tuning (optimal throughput)
/// - heuristics disabled: prevent Windows from artificially limiting window size
/// - initialRto=300: reduce initial retransmission timeout from 1000ms to 300ms
///   (Google recommends low MinRTO for faster loss recovery)
/// - fastopen=enabled: enable TCP Fast Open for reduced handshake latency
/// - ecncapability=enabled: enable ECN for congestion signaling without drops
#[tauri::command]
#[cfg(target_os = "windows")]
pub fn apply_windows_tcp_optimizations() -> Result<(), String> {
    use super::TUN_MODE_ACTIVE;
    use std::os::windows::process::CommandExt;
    use std::sync::atomic::Ordering;

    // Only apply when TUN mode is active
    if !TUN_MODE_ACTIVE.load(Ordering::SeqCst) {
        return Ok(());
    }

    let optimizations: [(&str, &[&str]); 5] = [
        // Enable TCP receive window auto-tuning (normal = optimal for most cases)
        (
            "autotuninglevel",
            &["int", "tcp", "set", "global", "autotuninglevel=normal"],
        ),
        // Disable heuristics that may artificially limit window size
        (
            "heuristics",
            &["int", "tcp", "set", "heuristics", "disabled"],
        ),
        // Reduce initial RTO from 1000ms to 300ms (Google: lower MinRTO for faster loss recovery)
        (
            "initialRto",
            &["int", "tcp", "set", "global", "initialRto=300"],
        ),
        // Enable TCP Fast Open
        (
            "fastopen",
            &["int", "tcp", "set", "global", "fastopen=enabled"],
        ),
        // Enable ECN for congestion signaling without packet drops
        (
            "ecncapability",
            &["int", "tcp", "set", "global", "ecncapability=enabled"],
        ),
    ];

    let mut failed = Vec::new();
    for (name, args) in &optimizations {
        let mut cmd = std::process::Command::new("netsh");
        cmd.args(args);
        // Prevent console window from flashing on screen
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        let result = cmd.output();
        match result {
            Ok(output) if output.status.success() => {
                emit_info!(
                    System,
                    SYS_TUN_FAILED,
                    "Windows TCP optimization applied: {name}"
                );
            }
            Ok(output) => {
                let stderr = String::from_utf8_lossy(&output.stderr);
                // Not fatal — some settings may not be supported on older Windows
                emit_warn!(
                    System,
                    SYS_TUN_FAILED,
                    "Windows TCP optimization skipped ({name}): {stderr}"
                );
                failed.push(*name);
            }
            Err(e) => {
                emit_warn!(
                    System,
                    SYS_TUN_FAILED,
                    "Windows TCP optimization failed ({name}): {e}"
                );
                failed.push(*name);
            }
        }
    }

    if failed.is_empty() {
        emit_info!(
            System,
            SYS_TUN_FAILED,
            "All Windows TCP optimizations applied successfully"
        );
    } else {
        emit_info!(
            System,
            SYS_TUN_FAILED,
            "Windows TCP optimizations applied (skipped: {})",
            failed.join(", ")
        );
    }

    Ok(())
}

/// On non-Windows platforms, this is a no-op
#[tauri::command]
#[cfg(not(target_os = "windows"))]
pub const fn apply_windows_tcp_optimizations() -> Result<(), String> {
    Ok(())
}
