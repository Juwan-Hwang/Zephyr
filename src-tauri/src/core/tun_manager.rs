use std::sync::atomic::Ordering;
use tauri::AppHandle;

use super::{TUN_MODE_ACTIVE, TUN_TOGGLING};
#[cfg(target_os = "macos")]
use super::core_process::{ensure_executable, generate_secret, resolve_app_paths};
#[cfg(not(target_os = "macos"))]
use super::core_process::resolve_app_paths;

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

/// Extract secret from YAML config content (simple line-by-line parsing)
#[cfg(target_os = "macos")]
fn extract_secret_from_yaml(content: &str) -> Option<String> {
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("secret:") {
            return trimmed.split(':').nth(1).map(|s| s.trim().to_string());
        }
    }
    None
}

/// Update TUN enable setting in YAML config content
/// Returns updated content with TUN block modified or appended
fn update_tun_in_yaml(content: &str, enable: bool) -> String {
    if content.contains("tun:") {
        // Find the tun block and update enable within it
        let mut in_tun_block = false;
        let lines: Vec<String> = content
            .lines()
            .map(|line| {
                if line.trim().starts_with("tun:") {
                    in_tun_block = true;
                } else if in_tun_block
                    && !line.starts_with(" ")
                    && !line.starts_with("\t")
                    && !line.is_empty()
                {
                    in_tun_block = false;
                }

                if in_tun_block && line.trim().starts_with("enable:") {
                    let indent = line
                        .chars()
                        .take_while(|c| c.is_whitespace())
                        .collect::<String>();
                    format!("{}enable: {}", indent, enable)
                } else {
                    line.to_string()
                }
            })
            .collect();
        lines.join("\n")
    } else {
        // No tun block, append it
        let tun_block = if enable {
            "\ntun:\n  enable: true\n  stack: system\n  auto-route: true\n  auto-detect-interface: true\n"
        } else {
            "\ntun:\n  enable: false\n"
        };
        format!("{}{}", content.trim_end(), tun_block)
    }
}

/// Extract TUN enable status from YAML config content
#[allow(dead_code)]
fn extract_tun_enabled_from_yaml(content: &str) -> bool {
    let mut in_tun_block = false;

    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("tun:") {
            in_tun_block = true;
        } else if in_tun_block {
            if trimmed.starts_with("enable:") {
                return trimmed
                    .split(':')
                    .nth(1)
                    .map(|s| s.trim() == "true")
                    .unwrap_or(false);
            }
            // Exit tun block when we hit a non-indented line
            if !line.starts_with(" ") && !line.starts_with("\t") && !line.is_empty() {
                in_tun_block = false;
            }
        }
    }
    false
}

/// Restart mihomo core with root privileges on macOS for TUN mode
/// This is required because creating /dev/utun devices needs root access
/// Returns the secret for frontend to update
#[cfg(target_os = "macos")]
pub async fn restart_core_as_root(app: &AppHandle, enable_tun: bool) -> Result<String, String> {
    let paths = resolve_app_paths(app)?;
    let core_path = paths.core_dir.join("mihomo");
    ensure_executable(&core_path)?;

    let config_dir_str = paths.core_dir.to_string_lossy();

    // Update TUN config in run_config.yaml before starting
    let config_file = paths.core_dir.join("run_config.yaml");
    let mut secret = String::new();

    if config_file.exists() {
        let content = std::fs::read_to_string(&config_file)
            .map_err(|e| format!("Failed to read config: {}", e))?;

        // Extract current secret from config or generate new one
        secret = extract_secret_from_yaml(&content).unwrap_or_else(|| generate_secret());

        // Update TUN setting
        let mut updated = update_tun_in_yaml(&content, enable_tun);

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
                    format!("{}secret: {}", indent, secret)
                } else {
                    line.to_string()
                }
            })
            .collect();

        if !found_secret {
            lines.push(format!("secret: {}", secret));
        }

        updated = lines.join("\n");

        std::fs::write(&config_file, &updated)
            .map_err(|e| format!("Failed to write config: {}", e))?;
    }

    // Build the command: kill all mihomo (including root), wait, then start new
    // All in one osascript with administrator privileges
    // Use user-specific Logs directory (~/Library/Logs/) - secure and predictable for debugging
    let log_path = std::env::var("HOME")
        .map(|h| {
            // macOS: ~/Library/Logs/ - user-specific, other users cannot access
            let path = format!("{}/Library/Logs", h);
            // Create directory if it doesn't exist
            if let Err(e) = std::fs::create_dir_all(&path) {
                eprintln!("[TUN] Failed to create log directory: {}", e);
            }
            format!("{}/mihomo-tun.log", path)
        })
        .unwrap_or_else(|_| {
            // Fallback to user temp directory with fixed name
            let temp = std::env::temp_dir();
            temp.join("mihomo-tun.log").to_string_lossy().to_string()
        });

    // CRITICAL: Escape paths for shell single-quote context to prevent command injection
    // Replace all ' with '\'' (end quote, escaped quote, start quote)
    let escaped_config_dir = config_dir_str.replace("'", "'\\''");
    let escaped_log_path = log_path.replace("'", "'\\''");

    let script = format!(
        r#"do shell script "killall -9 mihomo 2>/dev/null; sysctl -w net.inet.tcp.msl=1000 2>/dev/null; sleep 0.3; cd '{}' && './mihomo' -d '.' -f 'run_config.yaml' > '{}' 2>&1 &" with administrator privileges"#,
        escaped_config_dir, escaped_log_path
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
        .map_err(|e| format!("Failed to spawn osascript: {}", e))?;

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
                        return Err("canceled".to_string());
                    }
                    return Err(format!("osascript failed: {}", err));
                }
                return Err("osascript failed".to_string());
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
                return Err("canceled".to_string());
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
        return Err("Root mihomo failed to start within 30 seconds".to_string());
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
        return Err("root_start_failed".to_string());
    }

    // MSL is already set in the root osascript above (sysctl needs root)
    eprintln!("[TUN] Set MSL=1000 for short TIME_WAIT (via root shell)");

    // Mark TUN mode as active
    set_tun_mode(true);

    Ok(secret)
}

/// On non-macOS platforms, this is a no-op
#[cfg(not(target_os = "macos"))]
#[allow(dead_code)]
pub fn restart_core_as_root(_app: &AppHandle, _enable_tun: bool) -> Result<String, String> {
    Ok(String::new())
}

/// Check if there's a root-owned mihomo process running
#[cfg(target_os = "macos")]
fn has_root_mihomo() -> bool {
    if let Ok(output) = std::process::Command::new("ps")
        .args(["-axo", "user,comm"])
        .output()
    {
        let text = String::from_utf8_lossy(&output.stdout);
        text.lines()
            .any(|line| line.trim_start().starts_with("root ") && line.contains("mihomo"))
    } else {
        false
    }
}

#[cfg(not(target_os = "macos"))]
#[allow(dead_code)]
fn has_root_mihomo() -> bool {
    false
}

/// Kill all mihomo processes with root privileges (kills both root and user processes)
/// Also cleans up TUN interface and routes to avoid blocking new mihomo startup
/// Note: Does NOT clear TUN mode flag - caller should call set_tun_mode(false) if disabling TUN
#[cfg(target_os = "macos")]
pub fn kill_all_mihomo_as_root() -> Result<(), String> {
    // Reduce MSL to 1s so TIME_WAIT expires quickly (default 15s = 30s TIME_WAIT)
    let script = r#"do shell script "killall -9 mihomo 2>/dev/null; sleep 0.3; sysctl -w net.inet.tcp.msl=1000; route delete 0.0.0.0/1 2>/dev/null; route delete 128.0.0.0/1 2>/dev/null; true" with administrator privileges"#;
    let status = std::process::Command::new("osascript")
        .args(["-e", script])
        .status()
        .map_err(|e| format!("Failed to run osascript: {}", e))?;

    if !status.success() {
        return Err(format!("osascript exit code: {}", status));
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub fn kill_all_mihomo_as_root() -> Result<(), String> {
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
pub fn smart_kill_all_mihomo_as_root() -> Result<(), String> {
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
pub fn disable_tun_cmd(app: tauri::AppHandle) -> Result<(), String> {
    set_tun_mode(false);
    // On Windows/Linux, TUN is handled via config change, no need for root kill
    // Just update the config
    set_tun_enabled_internal(&app, false)
}

/// Update TUN enable setting in run_config.yaml (without restarting core)
pub fn set_tun_enabled_internal(app: &AppHandle, enable: bool) -> Result<(), String> {
    let paths = resolve_app_paths(app)?;
    let config_file = paths.core_dir.join("run_config.yaml");

    if !config_file.exists() {
        return Err("Config file not found".to_string());
    }

    let content = std::fs::read_to_string(&config_file)
        .map_err(|e| format!("Failed to read config: {}", e))?;

    let updated = update_tun_in_yaml(&content, enable);

    std::fs::write(&config_file, updated).map_err(|e| format!("Failed to write config: {}", e))?;

    Ok(())
}

/// Tauri command to set TUN enabled in config (without restarting)
#[tauri::command]
pub fn set_tun_enabled(app: tauri::AppHandle, enable: bool) -> Result<(), String> {
    set_tun_enabled_internal(&app, enable)
}

/// Initialize TUN mode flag from config file (call at app startup)
#[allow(dead_code)]
pub fn init_tun_mode_from_config(app: &AppHandle) -> Result<(), String> {
    let paths = resolve_app_paths(app)?;
    let config_file = paths.core_dir.join("run_config.yaml");

    if !config_file.exists() {
        return Ok(());
    }

    let content = std::fs::read_to_string(&config_file)
        .map_err(|e| format!("Failed to read config: {}", e))?;

    // Check if TUN is enabled in config
    let tun_enabled = extract_tun_enabled_from_yaml(&content);

    set_tun_mode(tun_enabled);
    eprintln!("[CORE] TUN mode initialized from config: {}", tun_enabled);

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
