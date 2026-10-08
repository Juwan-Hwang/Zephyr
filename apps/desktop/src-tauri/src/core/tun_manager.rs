use std::sync::atomic::Ordering;
use tauri::{AppHandle, Manager as _};

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

#[cfg(target_os = "macos")]
use zephyr_core::config::tun::extract_secret_from_yaml;
use zephyr_core::config::tun::{
    extract_tun_enabled_from_yaml, update_tun_in_yaml as core_update_tun_in_yaml,
};

/// Update TUN enable setting in YAML config content using `zephyr_core`.
/// Returns updated content with TUN block modified or appended.
fn update_tun_in_yaml(content: &str, enable: bool) -> Result<String, String> {
    core_update_tun_in_yaml(content, enable).map_err(|e| e.to_string())
}

/// Returns the log file path for mihomo running in root TUN mode on macOS.
#[cfg(target_os = "macos")]
#[must_use]
pub fn get_tun_log_path() -> String {
    "/Library/Logs/Zephyr/tun.log".to_string()
}

#[cfg(not(target_os = "macos"))]
#[allow(dead_code)]
#[must_use]
pub fn get_tun_log_path() -> String {
    let temp = std::env::temp_dir();
    temp.join(format!("mihomo-tun-{}.log", std::process::id()))
        .to_string_lossy()
        .into_owned()
}

/// Typed error representing failure modes during root TUN core startup.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RootStartError {
    Canceled(String),
    PrivilegeTimeout(String),
    ExecutionFailed(String),
    ScriptRanStartTimeout(String),
    ScriptRanPortBindTimeout(String),
}

impl RootStartError {
    #[must_use]
    pub const fn script_ran(&self) -> bool {
        matches!(
            self,
            Self::ScriptRanStartTimeout(_) | Self::ScriptRanPortBindTimeout(_)
        )
    }

    #[must_use]
    pub fn message(&self) -> &str {
        match self {
            Self::Canceled(msg)
            | Self::PrivilegeTimeout(msg)
            | Self::ExecutionFailed(msg)
            | Self::ScriptRanStartTimeout(msg)
            | Self::ScriptRanPortBindTimeout(msg) => msg,
        }
    }
}

impl std::fmt::Display for RootStartError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message())
    }
}

impl std::error::Error for RootStartError {}

impl From<String> for RootStartError {
    fn from(s: String) -> Self {
        Self::ExecutionFailed(s)
    }
}

/// PIDs of root-owned processes running *this app's* managed core.
///
/// Readiness decisions during a root restart must be scoped to app-owned
/// processes: an unrelated root mihomo service that happens to (re)start or
/// hold the controller port must not make the app's core look started.
#[cfg(target_os = "macos")]
async fn get_managed_root_pids_async(core_path: std::path::PathBuf) -> Vec<i32> {
    tokio::task::spawn_blocking(move || managed_root_mihomo_pids(Some(&core_path)))
        .await
        .unwrap_or_default()
}

/// Restart mihomo core with root privileges on macOS for TUN mode
/// This is required because creating /dev/utun devices needs root access
/// Returns the secret for frontend to update
#[cfg(target_os = "macos")]
pub async fn restart_core_as_root(
    app: &AppHandle,
    enable_tun: bool,
) -> Result<String, RootStartError> {
    let paths = resolve_app_paths(app)?;
    let core_path = get_core_exe_path(app)?;
    ensure_executable(&core_path)?;

    let config_dir_str = paths.core_dir.to_string_lossy();

    // Update TUN config in run_config.yaml before starting
    let config_file = paths.core_dir.join("run_config.yaml");
    let mut secret = String::new();
    let mut api_port = 9090;

    if config_file.exists() {
        let content = std::fs::read_to_string(&config_file)
            .map_err(|e| format!("Failed to read config: {e}"))?;

        api_port = zephyr_core::process::parse_external_controller_port(content.clone());

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
    let log_path = get_tun_log_path();

    // Security: Unlink if log_path is a pre-existing symlink to prevent privilege escalation via root redirection.
    if let Ok(meta) = std::fs::symlink_metadata(&log_path) {
        if meta.file_type().is_symlink() {
            let _ = std::fs::remove_file(&log_path);
        }
    }

    // CRITICAL: Escape paths in two phases — shell first, then AppleScript
    // 1. Shell-escape: replace ' with '\'' for single-quote context (end quote, escaped quote, start quote)
    // 2. AppleScript-escape: replace \ with \\ and " with \" to prevent breaking the outer "do shell script" literal
    let escaped_config_dir = config_dir_str
        .replace("'", "'\\''")
        .replace('\\', "\\\\")
        .replace('"', "\\\"");
    let escaped_log_path = log_path
        .replace("'", "'\\''")
        .replace('\\', "\\\\")
        .replace('"', "\\\"");

    // Launch the managed core by its ABSOLUTE path (not `./name` after `cd`):
    // `ps comm` then reports the absolute executable path, so managed-process
    // detection can match it exactly instead of relying on the legacy
    // working-directory probe for root-owned processes.
    let core_path_str = core_path.to_string_lossy();
    let escaped_core_path = core_path_str
        .replace("'", "'\\''")
        .replace('\\', "\\\\")
        .replace('"', "\\\"");
    let uid = unsafe { libc::getuid() };
    // Terminate only this app's managed core processes (root- and user-owned):
    // an unrelated root mihomo service must never be killed by a TUN start.
    // The scan runs `ps` twice (plus `lsof` per legacy candidate), so it goes
    // through `spawn_blocking` like every other process probe here. The PID
    // list is numeric, so interpolating it into the script is safe.
    let core_path_for_scan = core_path.clone();
    let managed_pids =
        tokio::task::spawn_blocking(move || managed_mihomo_pids_scoped(&core_path_for_scan, false))
            .await
            .unwrap_or_default();
    let kill_prefix = if managed_pids.is_empty() {
        String::new()
    } else {
        // nosemgrep: rust-osascript-privilege-escalation — PID list is numeric-only
        // nosemgrep: rust-osascript-command-pattern — validated numeric PIDs, no injection vector
        format!(
            "kill -9 {} 2>/dev/null; ",
            managed_pids
                .iter()
                .map(ToString::to_string)
                .collect::<Vec<_>>()
                .join(" ")
        )
    };
    let script = format!(
        // nosemgrep: rust-osascript-privilege-escalation — paths are shell-escaped via replace("'", "'\\''")
        // nosemgrep: rust-osascript-command-pattern — escaped values prevent injection
        r#"do shell script "{kill_prefix}sleep 0.3; [ -L '/Library/Logs/Zephyr' ] && rm -f '/Library/Logs/Zephyr'; mkdir -p -m 0755 '/Library/Logs/Zephyr'; chown root:wheel '/Library/Logs/Zephyr' 2>/dev/null; chmod 0755 '/Library/Logs/Zephyr'; rm -f '{escaped_log_path}'; : > '{escaped_log_path}'; chown {uid} '{escaped_log_path}'; chmod 600 '{escaped_log_path}'; cd '{escaped_config_dir}' && '{escaped_core_path}' -d '.' -f 'run_config.yaml' >> '{escaped_log_path}' 2>&1 &" with administrator privileges"#,
    );

    // Spawn osascript without waiting for it to complete
    // The & at the end of the shell command makes mihomo run in background
    // but osascript might still wait, so we use spawn() instead of output()
    // Snapshot managed root PIDs before the script so only processes this app
    // starts count as "new" (an unrelated root mihomo service must not make the
    // app's core look started).
    let initial_root_pids: Vec<i32> = get_managed_root_pids_async(core_path.clone()).await;
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
                        return Err(RootStartError::Canceled("canceled".to_owned()));
                    }
                    return Err(RootStartError::ExecutionFailed(format!(
                        "osascript failed: {err}"
                    )));
                }
                return Err(RootStartError::ExecutionFailed(
                    "osascript failed".to_owned(),
                ));
            }
        }
        Ok(None) => {
            // Still running, which is expected - password dialog is showing
        }
        Err(_) => {}
    }

    // Wait for osascript to finish and root mihomo to appear (poll for up to 30 seconds to allow time for password entry)
    let mut started = false;
    let mut script_finished = false;
    for _ in 0..60 {
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;

        if !script_finished {
            match child.try_wait() {
                Ok(Some(status)) => {
                    if !status.success() {
                        let stderr = child.stderr.take();
                        if let Some(mut stderr) = stderr {
                            let mut err = String::new();
                            let _ = std::io::Read::read_to_string(&mut stderr, &mut err);
                            if err.contains("canceled") || err.contains("User canceled") {
                                return Err(RootStartError::Canceled("canceled".to_owned()));
                            }
                            return Err(RootStartError::ExecutionFailed(format!(
                                "osascript failed: {err}"
                            )));
                        }
                        return Err(RootStartError::ExecutionFailed(
                            "osascript failed".to_owned(),
                        ));
                    }
                    script_finished = true;
                }
                Ok(None) => {
                    // Password dialog is still showing or script is still executing,
                    // but child may already have started mihomo in background.
                }
                Err(_) => {}
            }
        }

        let is_ready = if api_port > 0 {
            tokio::time::timeout(
                std::time::Duration::from_millis(50),
                tokio::net::TcpStream::connect(format!("127.0.0.1:{api_port}")),
            )
            .await
            .map(|r| r.is_ok())
            .unwrap_or(false)
        } else {
            true
        };
        let current_root_pids = get_managed_root_pids_async(core_path.clone()).await;
        let new_root_running = current_root_pids
            .iter()
            .any(|pid| !initial_root_pids.contains(pid));
        let ready_now = new_root_running && is_ready;
        if ready_now {
            started = true;
            break;
        }
    }

    if started {
        if !script_finished {
            tokio::task::spawn_blocking(move || {
                let _ = child.wait();
            });
        }
    } else {
        // Kill osascript if still running and reap child on a blocking thread
        let exited_ok = tokio::task::spawn_blocking(move || {
            if let Ok(Some(status)) = child.try_wait() {
                return status.success();
            }
            let _ = child.kill();
            child.wait().map(|s| s.success()).unwrap_or(false)
        })
        .await
        .unwrap_or(false);
        let script_finished = script_finished || exited_ok;

        // Brief grace wait to check if root core appeared just as timeout hit
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        let current_root_pids = get_managed_root_pids_async(core_path.clone()).await;
        let new_root_present = current_root_pids
            .iter()
            .any(|pid| !initial_root_pids.contains(pid));

        if new_root_present {
            // New root mihomo started right at the deadline; proceed to verify port
        } else if script_finished {
            let core_path_for_kill = core_path.clone();
            let kill_res = tokio::task::spawn_blocking(move || {
                kill_managed_root_mihomo_as_root(Some(&core_path_for_kill))
            })
            .await;
            if kill_res.ok().and_then(Result::ok).is_some() {
                set_tun_mode(false);
            }
            return Err(RootStartError::ScriptRanStartTimeout(
                "Root mihomo failed to start within 30 seconds".to_owned(),
            ));
        } else {
            // osascript never exited within the poll window. Before reporting a
            // privilege timeout (which callers treat as "the script never
            // ran"), re-check the managed root PIDs once more: a last-moment
            // authorization can have run the privileged script (kill + core
            // start) while osascript itself is still waiting to exit.
            let late_root_pids = get_managed_root_pids_async(core_path.clone()).await;
            let script_actually_ran = late_root_pids
                .iter()
                .any(|pid| !initial_root_pids.contains(pid));
            if script_actually_ran {
                // The script ran: treat it as the start-timeout path so the
                // caller does not restore the previous run config while a root
                // core with the new config is running.
                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                let core_path_for_kill = core_path.clone();
                let kill_res = tokio::task::spawn_blocking(move || {
                    kill_managed_root_mihomo_as_root(Some(&core_path_for_kill))
                })
                .await;
                if kill_res.ok().and_then(Result::ok).is_some() {
                    set_tun_mode(false);
                }
                return Err(RootStartError::ScriptRanStartTimeout(
                    "Root mihomo failed to start within 30 seconds".to_owned(),
                ));
            }
            return Err(RootStartError::PrivilegeTimeout(
                "osascript failed: timed out waiting for administrator privileges".to_owned(),
            ));
        }
    }

    // Wait for port to be bound (or verify root daemon liveness if controller is disabled)
    let mut bound = false;
    if api_port == 0 {
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        bound = get_managed_root_pids_async(core_path.clone())
            .await
            .iter()
            .any(|pid| !initial_root_pids.contains(pid));
    } else {
        let target_addr = format!("127.0.0.1:{api_port}");
        for _ in 0..10 {
            tokio::time::sleep(std::time::Duration::from_millis(300)).await;
            let connected = tokio::time::timeout(
                std::time::Duration::from_millis(50),
                tokio::net::TcpStream::connect(&target_addr),
            )
            .await
            .map(|r| r.is_ok())
            .unwrap_or(false);
            if connected {
                bound = true;
                break;
            }
        }
    }

    if !bound {
        let core_path_for_kill = core_path.clone();
        let kill_res = tokio::task::spawn_blocking(move || {
            kill_managed_root_mihomo_as_root(Some(&core_path_for_kill))
        })
        .await;
        if kill_res.ok().and_then(Result::ok).is_some() {
            set_tun_mode(false);
        }
        return Err(RootStartError::ScriptRanPortBindTimeout(
            "root_start_failed".to_owned(),
        ));
    }

    // Mark TUN mode as active
    set_tun_mode(true);

    Ok(secret)
}

/// On non-macOS platforms, this is a no-op
#[cfg(not(target_os = "macos"))]
#[allow(dead_code)]
pub const fn restart_core_as_root(
    _app: &AppHandle,
    _enable_tun: bool,
) -> Result<String, RootStartError> {
    Ok(String::new())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use serde_yaml::Value as YamlValue;
    use zephyr_core::config::tun::ensure_dns_hijack_entries;

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

/// Retrieve PIDs of any root-owned mihomo processes
#[cfg(target_os = "macos")]
pub(crate) fn get_root_mihomo_pids() -> Vec<u32> {
    if let Ok(output) = std::process::Command::new("ps")
        .args(["-axo", "pid,user,comm"])
        .output()
    {
        let text = String::from_utf8_lossy(&output.stdout);
        text.lines()
            .filter_map(|line| {
                let trimmed = line.trim_start();
                let (pid_str, rest) = trimmed.split_once(char::is_whitespace)?;
                let pid = pid_str.parse::<u32>().ok()?;
                let (user, comm) = rest.trim_start().split_once(char::is_whitespace)?;
                let comm = comm.trim();
                let basename = std::path::Path::new(comm)
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or(comm);
                if user == "root" && (basename == "zephyr-mihomo" || basename == "mihomo") {
                    Some(pid)
                } else {
                    None
                }
            })
            .collect()
    } else {
        Vec::new()
    }
}

#[cfg(not(target_os = "macos"))]
#[allow(dead_code)]
pub(crate) const fn get_root_mihomo_pids() -> Vec<u32> {
    Vec::new()
}

/// Check if there's a root-owned mihomo process running
/// Checks for both zephyr-mihomo (new) and mihomo (legacy) for backward compatibility
#[cfg(target_os = "macos")]
pub(crate) fn has_root_mihomo() -> bool {
    !get_root_mihomo_pids().is_empty()
}

#[cfg(not(target_os = "macos"))]
#[allow(dead_code)]
pub(crate) const fn has_root_mihomo() -> bool {
    false
}

/// PIDs of root-owned processes running this app's managed core:
/// - the configured managed executable (matched by full path),
/// - the `zephyr-mihomo` binary name, or
/// - a legacy plain `mihomo` process started from the app's core directory with
///   the managed runtime arguments (`-d . -f run_config.yaml`).
///
/// Unrelated root mihomo services never match, so privileged cleanup stays
/// scoped to app-owned processes.
/// PIDs of processes running this app's managed core.
///
/// A process counts as managed when either:
/// - its executable is exactly the app's configured managed core, or
/// - it is a legacy launch (`mihomo` or `zephyr-mihomo` with `-d .` and a
///   `run_config.yaml` argument) whose working directory is the app's core
///   directory (verified with `lsof`).
///
/// When `root_only` is set, only root-owned processes match. Unrelated mihomo
/// services — regardless of name or arguments — never match.
#[cfg(target_os = "macos")]
fn managed_mihomo_pids_scoped(managed_exe_path: &std::path::Path, root_only: bool) -> Vec<i32> {
    let core_dir = managed_exe_path
        .parent()
        .unwrap_or(managed_exe_path)
        .to_path_buf();
    let user_matches = |user: &str| !root_only || user == "root";
    let mut pids: Vec<i32> = Vec::new();

    // 1. Exact executable path match.
    if let Ok(output) = std::process::Command::new("ps")
        .args(["-axo", "pid,user,comm"])
        .output()
    {
        let text = String::from_utf8_lossy(&output.stdout);
        pids.extend(text.lines().filter_map(|line| {
            let trimmed = line.trim_start();
            let (pid_str, rest) = trimmed.split_once(char::is_whitespace)?;
            let (user, comm) = rest.trim_start().split_once(char::is_whitespace)?;
            let comm = comm.trim();
            if !user_matches(user) || std::path::Path::new(comm) != managed_exe_path {
                return None;
            }
            pid_str.trim().parse::<i32>().ok()
        }));
    }

    // 2. Exact executable path match via the command line (covers relative
    // launches such as `./zephyr-mihomo`, whose `comm` may not equal the
    // absolute path), followed by the legacy core-directory launch pattern.
    if let Ok(output) = std::process::Command::new("ps")
        .args(["-axo", "pid,user,args"])
        .output()
    {
        let text = String::from_utf8_lossy(&output.stdout);
        pids.extend(text.lines().filter_map(|line| {
            let mut fields = line.split_whitespace();
            let pid_str = fields.next()?;
            let user = fields.next()?;
            if !user_matches(user) {
                return None;
            }
            let exe = fields.next()?;
            let pid = pid_str.trim().parse::<i32>().ok()?;
            if std::path::Path::new(exe) == managed_exe_path {
                return Some(pid);
            }
            // Legacy launch: `mihomo` or `zephyr-mihomo` with `-d .` and a
            // `run_config.yaml` argument, started from the app's core directory
            // (working directory verified with `lsof`).
            let basename = std::path::Path::new(exe)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or(exe);
            if basename != "mihomo" && basename != "zephyr-mihomo" {
                return None;
            }
            let args: Vec<&str> = fields.collect();
            let uses_core_dir = args
                .iter()
                .position(|a| *a == "-d")
                .is_some_and(|i| args.get(i + 1) == Some(&"."));
            let uses_managed_config = args.iter().any(|a| a.ends_with("run_config.yaml"));
            if uses_core_dir && uses_managed_config && process_cwd_is(pid, &core_dir) {
                Some(pid)
            } else {
                None
            }
        }));
    }

    pids.sort_unstable();
    pids.dedup();
    pids
}

/// PIDs of root-owned processes running this app's managed core.
#[cfg(target_os = "macos")]
fn managed_root_mihomo_pids(managed_exe_path: Option<&std::path::Path>) -> Vec<i32> {
    match managed_exe_path {
        Some(path) => managed_mihomo_pids_scoped(path, true),
        None => Vec::new(),
    }
}

/// Whether the process with `pid` has `expected_dir` as its working directory.
#[cfg(target_os = "macos")]
fn process_cwd_is(pid: i32, expected_dir: &std::path::Path) -> bool {
    let Ok(output) = std::process::Command::new("lsof")
        .args(["-a", "-p", &pid.to_string(), "-d", "cwd", "-Fn"])
        .output()
    else {
        return false;
    };
    let text = String::from_utf8_lossy(&output.stdout);
    text.lines()
        .filter_map(|line| line.strip_prefix('n'))
        .any(|path| std::path::Path::new(path) == expected_dir)
}

/// Check if there is a root-owned mihomo process running our managed core executable
#[cfg(target_os = "macos")]
pub(crate) fn has_managed_root_mihomo(managed_exe_path: Option<&std::path::Path>) -> bool {
    !managed_root_mihomo_pids(managed_exe_path).is_empty()
}

#[cfg(not(target_os = "macos"))]
#[allow(dead_code)]
pub(crate) const fn has_managed_root_mihomo(_managed_exe_path: Option<&std::path::Path>) -> bool {
    false
}

/// Run an AppleScript privileged shell command, waiting up to 30s for
/// administrator authorization.
#[cfg(target_os = "macos")]
fn run_privileged_shell_script(script: &str) -> Result<(), String> {
    let mut child = std::process::Command::new("osascript")
        .args(["-e", script])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| format!("Failed to spawn osascript: {e}"))?;

    let timeout = std::time::Duration::from_secs(30);
    let start = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if !status.success() {
                    return Err(format!("osascript exit code: {status}"));
                }
                return Ok(());
            }
            Ok(None) => {
                if start.elapsed() >= timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(
                        "osascript timed out waiting for administrator privileges".to_owned()
                    );
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("Failed waiting for osascript: {e}"));
            }
        }
    }
}

/// Kill only root-owned processes running this app's managed core (matched by
/// PID), leaving unrelated root mihomo services untouched. Also cleans up TUN
/// interface and routes. Returns `Ok(())` when no managed root process exists.
#[cfg(target_os = "macos")]
pub fn kill_managed_root_mihomo_as_root(
    managed_exe_path: Option<&std::path::Path>,
) -> Result<(), String> {
    let pids = managed_root_mihomo_pids(managed_exe_path);
    if pids.is_empty() {
        return Ok(());
    }
    // PIDs are validated integers before interpolation, so the composed script
    // cannot carry an injection vector.
    // nosemgrep: rust-osascript-privilege-escalation — PID list is numeric-only
    // nosemgrep: rust-osascript-command-pattern — validated numeric PIDs, no injection vector
    let pid_list = pids
        .iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>()
        .join(" ");
    let script = format!(
        r#"do shell script "kill -9 {pid_list} 2>/dev/null; sleep 0.3; route delete 0.0.0.0/1 2>/dev/null; route delete 128.0.0.0/1 2>/dev/null; true" with administrator privileges"#
    );
    run_privileged_shell_script(&script)
}

#[cfg(not(target_os = "macos"))]
pub const fn kill_managed_root_mihomo_as_root(
    _managed_exe_path: Option<&std::path::Path>,
) -> Result<(), String> {
    Ok(())
}

/// Tauri command to terminate this app's managed core with root privileges.
///
/// Scoped to app-owned processes: an unrelated root mihomo service must never
/// be killed.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn kill_all_mihomo_as_root_cmd(app: tauri::AppHandle) -> Result<(), String> {
    kill_managed_root_mihomo_as_root(super::core_process::get_core_exe_path(&app).ok().as_deref())
}

/// Tauri command to disable TUN mode (clears flag and kills root mihomo)
/// Only available on macOS - TUN requires root on macOS
#[tauri::command]
#[cfg(target_os = "macos")]
pub async fn disable_tun_cmd(app: tauri::AppHandle) -> Result<(), String> {
    // Scope the privileged cleanup to this app's managed core: unrelated root
    // mihomo services must never be killed, and a self-restarting external
    // service must not be able to block TUN from being disabled.
    let managed_exe = get_core_exe_path(&app).ok();
    let exe_for_scan = managed_exe.clone();
    tokio::task::spawn_blocking(move || {
        kill_managed_root_mihomo_as_root(exe_for_scan.as_deref())?;

        let mut waited = 0;
        while has_managed_root_mihomo(exe_for_scan.as_deref()) {
            if waited > 8000 {
                return Err("Root mihomo still running after termination".to_owned());
            }
            std::thread::sleep(std::time::Duration::from_millis(200));
            waited += 200;
        }

        Ok(())
    })
    .await
    .map_err(|e| e.to_string())??;

    set_tun_mode(false);
    set_tun_enabled_internal(&app, false)?;

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

fn sync_tun_settings(app: &AppHandle, enable: bool) -> Result<(), String> {
    if let Some(state) = app.try_state::<crate::SettingsState>() {
        let (updated_settings, previous) = {
            let mut guard = state
                .0
                .lock()
                .map_err(|e| format!("Settings lock failed: {e}"))?;
            let previous = guard.tun_enabled;
            guard.tun_enabled = Some(enable);
            (guard.clone(), previous)
        };
        if let Err(e) = crate::persist_settings(app, &updated_settings) {
            // Persistence failed: roll the in-memory value back so it keeps
            // matching disk (start_core_inner reads it to pick the TUN path).
            if let Ok(mut guard) = state.0.lock() {
                guard.tun_enabled = previous;
            }
            return Err(e);
        }
    }
    Ok(())
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

    if let Err(e) = sync_tun_settings(app, enable) {
        // Settings persistence failed after the YAML was already updated.
        // Roll the YAML back so the two files cannot disagree; if the rollback
        // itself fails, surface the original error (the next start reconciles
        // from the authoritative settings).
        let _ = write_file_secure(&config_file, &content);
        return Err(e);
    }

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
    restart_core_as_root(&app, enable_tun)
        .await
        .map_err(|e| e.to_string())
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
/// Uses pkexec to prompt for authentication once, then runs setcap
/// and installs the polkit rule file.
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
        "Granting CAP_NET_ADMIN and installing polkit rule for: {core_path_str}"
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

    // Combined script: setcap + polkit rule installation
    let script = r#"set -e
export PATH="/usr/sbin:/sbin:$PATH"

# Grant network capabilities to mihomo
setcap cap_net_admin,cap_net_bind_service+ep "$1"

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
            "CAP_NET_ADMIN granted and polkit rule installed successfully"
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

/// Apply Windows TCP performance optimizations.
/// This is now a no-op — TCP optimizations have been moved to the
/// Network Optimization feature (`network_optim` module) and are no
/// longer auto-applied during TUN mode.
#[tauri::command]
#[cfg(target_os = "windows")]
#[allow(clippy::missing_const_for_fn)]
pub fn apply_windows_tcp_optimizations() -> Result<(), String> {
    // No-op: TCP optimizations moved to network_optim module
    Ok(())
}

/// On non-Windows platforms, this is a no-op
#[tauri::command]
#[cfg(not(target_os = "windows"))]
pub const fn apply_windows_tcp_optimizations() -> Result<(), String> {
    Ok(())
}
