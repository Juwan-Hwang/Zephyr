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

/// Executable path of the root core this process started, if any.
///
/// Used as a fallback when the managed binary can no longer be resolved (for
/// example it was replaced or removed while the app kept running), so the exit
/// path can still terminate the app's own root core.
static ROOT_CORE_EXE: std::sync::Mutex<Option<std::path::PathBuf>> = std::sync::Mutex::new(None);

/// Record the executable of the root core started by this process.
pub fn record_root_core_exe(path: &std::path::Path) {
    if let Ok(mut guard) = ROOT_CORE_EXE.lock() {
        *guard = Some(path.to_path_buf());
    }
}

/// Executable of the root core started by this process, when known.
#[must_use]
pub fn last_root_core_exe() -> Option<std::path::PathBuf> {
    ROOT_CORE_EXE.lock().ok().and_then(|guard| guard.clone())
}

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
    // through `spawn_blocking` like every other process probe here.
    let core_path_for_scan = core_path.clone();
    let (confirmed_pids, legacy_pids) = tokio::task::spawn_blocking(move || {
        let confirmed = managed_mihomo_pids_scoped(&core_path_for_scan, false);
        let confirmed_set: std::collections::HashSet<i32> = confirmed.iter().copied().collect();
        let legacy = legacy_candidate_pids(&core_path_for_scan)
            .into_iter()
            .filter(|pid| !confirmed_set.contains(pid))
            .collect::<Vec<_>>();
        (confirmed, legacy)
    })
    .await
    .unwrap_or_default();
    // The PIDs were collected before the authorization dialog, so the script
    // re-verifies each one before SIGKILL: confirmed PIDs must still show the
    // managed executable; otherwise (for both loops) the legacy launch identity
    // must still hold — the app's core directory as working directory (`lsof`
    // works here because the script runs as root) plus argv[0] named
    // `mihomo`/`zephyr-mihomo` and the managed `run_config.yaml` argument.
    let (confirmed_cmd, legacy_cmd) = build_pid_kill_commands(
        &confirmed_pids,
        &legacy_pids,
        &escaped_core_path,
        &escaped_config_dir,
    );
    let mut kill_parts: Vec<String> = Vec::new();
    if !confirmed_cmd.is_empty() {
        // nosemgrep: rust-oscript-privilege-escalation — escaped paths + numeric PIDs
        // nosemgrep: rust-oscript-command-pattern — escaped values prevent injection
        kill_parts.push(confirmed_cmd);
    }
    if !legacy_cmd.is_empty() {
        // nosemgrep: rust-oscript-privilege-escalation — escaped paths + numeric PIDs
        // nosemgrep: rust-osascript-command-pattern — escaped values prevent injection
        kill_parts.push(legacy_cmd);
    }
    let kill_prefix = kill_parts.join(" ");
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
                kill_managed_root_mihomo_as_root_verified(Some(&core_path_for_kill))
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
            // ran"), poll the managed root PIDs for a bounded window: a
            // last-moment authorization can have run the privileged script
            // (kill + core start) while osascript itself is still waiting to
            // exit. The script itself sleeps 0.3s before launching the core.
            //
            // A newly appearing PID is the positive signal, but its absence is
            // not proof the script never ran: if the relaunched core failed to
            // come up, the script still killed the old root core. Disappearance
            // of a previously running PID is therefore treated as "the script
            // ran" too, so the caller does not restore the previous run state
            // on top of a core that is already gone.
            let mut script_actually_ran = false;
            for _ in 0..6 {
                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                let late_root_pids = get_managed_root_pids_async(core_path.clone()).await;
                if late_root_pids
                    .iter()
                    .any(|pid| !initial_root_pids.contains(pid))
                {
                    script_actually_ran = true;
                    break;
                }
                if initial_root_pids
                    .iter()
                    .any(|pid| !late_root_pids.contains(pid))
                {
                    // The old root core is gone, so the script's kill ran. The
                    // fresh core may have crashed right after; either way the
                    // previous run config must not be restored.
                    script_actually_ran = true;
                    break;
                }
            }
            if script_actually_ran {
                // The script ran: treat it as the start-timeout path so the
                // caller does not restore the previous run config while a root
                // core with the new config is running.
                let core_path_for_kill = core_path.clone();
                let kill_res = tokio::task::spawn_blocking(move || {
                    kill_managed_root_mihomo_as_root_verified(Some(&core_path_for_kill))
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
            kill_managed_root_mihomo_as_root_verified(Some(&core_path_for_kill))
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
    // Remember which executable this root core runs, so later cleanup can
    // still identify it if the binary is replaced or removed.
    record_root_core_exe(&core_path);

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

    /// Assert that every `"` inside an `AppleScript` `do shell script "..."`
    /// literal is escaped as `\"` (a bare `"` would end the literal early and
    /// make `osascript` fail with a syntax error).
    fn assert_applescript_quotes_escaped(script: &str) {
        let open = script
            .find("do shell script \"")
            .expect("script must open the AppleScript literal");
        let close = script
            .rfind("\" with administrator privileges")
            .expect("script must close the AppleScript literal");
        assert!(open < close, "AppleScript literal delimiters out of order");
        let literal = &script[open + "do shell script \"".len()..close];
        let mut escaped = false;
        for ch in literal.chars() {
            assert!(
                ch != '"' || escaped,
                "unescaped double quote inside AppleScript literal: {script}"
            );
            escaped = if ch == '\\' { !escaped } else { false };
        }
    }

    /// Shared expectations for both kill loops: the working directory may only
    /// authorise a SIGKILL together with the legacy launch identity (argv[0]
    /// named `mihomo`/`zephyr-mihomo` plus the managed `run_config.yaml`
    /// argument), and every shell-visible quote must be escaped for `AppleScript`.
    fn assert_rechecks_legacy_identity(snippet: &str) {
        assert!(snippet.contains("if [ \\\"$cwd\\\" = '/Applications/Zephyr.app/Contents/MacOS/core' ] && [ \\\"$cfg\\\" = 1 ] && [ \\\"$named\\\" = 1 ]; then ok=1; fi;"));
        assert!(snippet.contains("base=${args%% *}; base=${base##*/};"));
        assert!(snippet.contains("case \\\"$args\\\" in *run_config.yaml*) cfg=1;; esac;"));
        assert!(snippet.contains(
            "if [ \\\"$base\\\" = 'mihomo' ] || [ \\\"$base\\\" = 'zephyr-mihomo' ]; then named=1; fi;"
        ));
        // `-ww` keeps a long absolute argv[0] (and therefore the managed config
        // argument) from being truncated away.
        assert!(snippet.contains("args=$(ps -ww -p $p -o args= 2>/dev/null)"));
        for var in ["$cwd", "$cfg", "$named", "$base", "$args", "$ok"] {
            assert!(
                snippet.contains(&format!("\\\"{var}\\\"")),
                "unescaped {var} inside the AppleScript literal: {snippet}"
            );
        }
    }

    #[test]
    fn test_pid_kill_commands_escape_applescript_quotes() {
        // Both snippets are embedded into `do shell script "..."`, so the shell
        // command-substitution quotes must be escaped for `AppleScript`.
        let (confirmed, legacy) = build_pid_kill_commands(
            &[1234, 5678],
            &[9012],
            "/Applications/Zephyr.app/Contents/MacOS/zephyr-mihomo",
            "/Applications/Zephyr.app/Contents/MacOS/core",
        );

        assert!(confirmed.contains("for p in 1234 5678"));
        assert!(legacy.contains("for p in 9012"));
        assert!(legacy.contains("$(lsof -a -p $p -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')"));
        assert!(legacy.contains("sed -n 's/^n//p'"));

        // The confirmed loop must accept every PID discovery confirmed: the
        // executable path (`comm`) directly, or the app's core directory as the
        // working directory (a relative `./mihomo` launch). A working directory
        // alone is never enough — see `assert_rechecks_legacy_identity`, which
        // pins the guard on both loops. Without the `comm` branch a relative
        // launch would be skipped and the verified wait would time out; with a
        // bare `cwd` branch a recycled PID in the core directory would be killed.
        assert!(confirmed.contains("comm=$(ps -p $p -o comm= 2>/dev/null)"));
        assert!(confirmed.contains("if [ \\\"$comm\\\" = '/Applications/Zephyr.app/Contents/MacOS/zephyr-mihomo' ]; then ok=1; fi;"));
        // Only the confirmed loop may kill on the executable path.
        assert!(!legacy.contains("\\\"$comm\\\" ="));
        assert_rechecks_legacy_identity(&confirmed);
        assert_rechecks_legacy_identity(&legacy);

        // A successful kill marks the run so the caller can skip the TUN route
        // teardown when nothing was actually terminated (a foreign candidate
        // that the working-directory check skipped).
        assert!(confirmed.contains("kill -9 $p 2>/dev/null && killed=1"));
        assert!(legacy.contains("kill -9 $p 2>/dev/null && killed=1"));

        // Empty lists produce empty commands (so the script stays valid).
        let (none_conf, none_leg) = build_pid_kill_commands(&[], &[], "/opt/core", "/opt/core");
        assert!(none_conf.is_empty());
        assert!(none_leg.is_empty());
    }

    #[test]
    fn test_managed_root_kill_script_escapes_applescript_quotes() {
        let exe = std::path::Path::new("/Applications/Zephyr.app/Contents/MacOS/zephyr-mihomo");

        // Both loops present: the full script must contain no unescaped `"`
        // inside the AppleScript literal.
        let script = build_managed_root_kill_script(exe, &[1234], &[5678])
            .expect("script expected for non-empty PID lists");
        assert_applescript_quotes_escaped(&script);
        // The routes are only removed when a loop actually killed something.
        assert!(script.starts_with("do shell script \"killed=0; "));
        assert!(script.contains("if [ \\\"$killed\\\" = 1 ]; then route delete 0.0.0.0/1"));
        assert!(script.contains("route delete 128.0.0.0/1"));

        // Confirmed-only and legacy-only variants must also stay escaped.
        let confirmed_only = build_managed_root_kill_script(exe, &[1234], &[])
            .expect("script expected for confirmed PIDs");
        assert_applescript_quotes_escaped(&confirmed_only);

        let legacy_only = build_managed_root_kill_script(exe, &[], &[5678])
            .expect("script expected for legacy candidates");
        assert_applescript_quotes_escaped(&legacy_only);

        // Nothing to kill: no script at all.
        assert!(build_managed_root_kill_script(exe, &[], &[]).is_none());
    }

    #[test]
    fn test_shell_escape_single_covers_quotes_and_backslashes() {
        // The same escaping the TUN restart script uses for its paths: shell
        // escaping first, then AppleScript escaping, so the output is what
        // appears inside the `do shell script "..."` literal.
        assert_eq!(shell_escape_single("/opt/core"), "/opt/core");
        // `'` becomes the shell `'\''` idiom, whose backslash is then doubled
        // for AppleScript.
        assert_eq!(shell_escape_single("/opt/it's"), "/opt/it'\\\\''s");
        assert_eq!(shell_escape_single("C:\\core"), "C:\\\\core");
        assert_eq!(shell_escape_single("/opt/a\"b"), "/opt/a\\\"b");
    }

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
    // `-ww` keeps `ps` from truncating a long command line: without it the
    // `run_config.yaml` argument can be cut off and the legacy pattern below
    // stops matching, so a running managed core would not be found at all.
    if let Ok(output) = std::process::Command::new("ps")
        .args(["-ww", "-axo", "pid,user,args"])
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

/// PIDs of root-owned processes running this app's managed core, confirmed
/// without privileges:
/// - the configured managed executable (matched by full path or `ps args`), or
/// - a legacy launch (`mihomo` or `zephyr-mihomo` with `-d .` and a
///   `run_config.yaml` argument) whose working directory is the app's core
///   directory (verified with `lsof` when permissions allow).
#[cfg(target_os = "macos")]
fn managed_root_mihomo_pids(managed_exe_path: Option<&std::path::Path>) -> Vec<i32> {
    match managed_exe_path {
        Some(path) => managed_mihomo_pids_scoped(path, true),
        None => Vec::new(),
    }
}

/// PIDs of root-owned processes that LOOK like this app's managed core but
/// could not be confirmed without privileges: a legacy launch (`mihomo` or
/// `zephyr-mihomo` with `-d .` and a `run_config.yaml` argument) whose working
/// directory could not be verified because an unprivileged `lsof` cannot read
/// a root process's cwd on macOS.
///
/// These are candidates only: the privileged kill script re-verifies each
/// one's working directory (as root) before terminating it.
///
/// `-ww` keeps `ps` from truncating the command line, so a long `argv` still
/// exposes its trailing `run_config.yaml` argument; without it the pattern
/// below silently stops matching managed cores launched with long arguments.
#[cfg(target_os = "macos")]
fn legacy_candidate_pids(managed_exe_path: &std::path::Path) -> Vec<i32> {
    let mut pids: Vec<i32> = Vec::new();
    if let Ok(output) = std::process::Command::new("ps")
        .args(["-ww", "-axo", "pid,user,args"])
        .output()
    {
        let text = String::from_utf8_lossy(&output.stdout);
        pids.extend(text.lines().filter_map(|line| {
            let mut fields = line.split_whitespace();
            let pid_str = fields.next()?;
            let user = fields.next()?;
            if user != "root" {
                return None;
            }
            let exe = fields.next()?;
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
            if uses_core_dir && uses_managed_config {
                pid_str.trim().parse::<i32>().ok()
            } else {
                None
            }
        }));
    }
    pids.sort_unstable();
    pids.dedup();
    // Drop candidates a previous privileged run in this process already
    // re-verified as foreign, so they stop re-triggering the administrator
    // dialog on every start. See PRIVILEGED_LEGACY_CHECKED.
    if let Ok(already_checked) = PRIVILEGED_LEGACY_CHECKED.lock() {
        pids.retain(|pid| !already_checked.contains(pid));
    }
    pids
}

/// Legacy candidate PIDs that a privileged run has already re-verified in this
/// process.
///
/// The privileged script re-checks each candidate's working directory as root
/// and deliberately skips one that turns out to belong to a foreign core, but
/// the app only observes the script's exit status — never which PIDs it skipped.
/// Without this record the same foreign PID re-triggers the administrator dialog
/// on *every* core start (profile switch, resume restart, forced restart) and the
/// user can never get past it.
///
/// Entries are added only when the script actually ran, so a cancelled prompt can
/// ask again, and they are safe to keep for the lifetime of the process: a PID
/// re-verified as foreign cannot become the app's own core later unless the OS
/// recycles it. The filter only decides *when* the optional cleanup is offered;
/// the script still re-verifies every PID it is actually given.
#[cfg(target_os = "macos")]
static PRIVILEGED_LEGACY_CHECKED: std::sync::LazyLock<
    std::sync::Mutex<std::collections::HashSet<i32>>,
> = std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::HashSet::new()));

/// Check if there is a root-owned mihomo process running our managed core executable
/// (confirmed, or a legacy candidate awaiting privileged verification).
#[cfg(target_os = "macos")]
pub(crate) fn has_managed_root_mihomo(managed_exe_path: Option<&std::path::Path>) -> bool {
    let Some(path) = managed_exe_path else {
        return false;
    };
    !managed_root_mihomo_pids(Some(path)).is_empty() || !legacy_candidate_pids(path).is_empty()
}

/// Whether a root-owned process running *this app's* managed core executable is
/// confirmed alive without privileges.
///
/// Unlike [`has_managed_root_mihomo`], legacy candidates are excluded: an
/// unprivileged scan cannot read a root process's working directory, so a
/// candidate may belong to a different install (e.g. another macOS user
/// running its own root core with `-d .` and `run_config.yaml`). The privileged
/// kill script skips such a foreign process, so letting a candidate block a
/// decision would make an unrelated service block startup, TUN disable and
/// stop — exactly what the managed-scope cleanup exists to prevent. Use
/// [`has_managed_root_mihomo`] only where an unverified candidate is worth a
/// (harmless) privileged cleanup attempt.
#[cfg(target_os = "macos")]
pub(crate) fn has_confirmed_root_mihomo(managed_exe_path: Option<&std::path::Path>) -> bool {
    let Some(path) = managed_exe_path else {
        return false;
    };
    !managed_root_mihomo_pids(Some(path)).is_empty()
}

#[cfg(not(target_os = "macos"))]
#[allow(dead_code)]
pub(crate) const fn has_confirmed_root_mihomo(_managed_exe_path: Option<&std::path::Path>) -> bool {
    false
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

/// Shell-escape a value for the single-quoted context inside the privileged
/// `do shell script` strings (same two-phase escaping as the restart script).
///
/// Pure string manipulation, so it is compiled (and unit-tested) on every
/// platform; the privileged scripts themselves are macOS-only.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn shell_escape_single(value: &str) -> String {
    value
        .replace('\'', "'\\''")
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
}

/// Build the shell snippets that re-verify each managed PID inside the
/// privileged script before sending SIGKILL.
///
/// The PID list is collected before the authorization dialog, so each entry is
/// re-checked immediately before the kill. Two properties have to hold at once:
///
/// * **No false negatives.** The accepted criteria must cover every way
///   [`managed_mihomo_pids_scoped`] confirmed the PID — the executable path in
///   `comm`, or (for a relative `./mihomo` launch) the app's core directory as
///   the working directory — otherwise [`kill_managed_root_mihomo_as_root_verified`]
///   keeps waiting for a process the script deliberately skipped and every
///   caller (TUN start/stop, core update) fails with a timeout.
/// * **No false positives.** A working directory alone must never authorize a
///   kill: between collection and the kill the PID can be recycled, or the
///   process can have exec'd something else while keeping that directory.
///   So the working-directory path additionally re-verifies the legacy launch
///   identity — `argv[0]`'s basename is `mihomo`/`zephyr-mihomo` and the managed
///   `run_config.yaml` is still an argument — which is exactly what discovery
///   required (`-d .` is left out: it adds nothing once the config file and the
///   core directory are both confirmed, and rejecting it could skip our own
///   core). Checking only `comm` would skip PIDs discovery matched another way.
///
/// `-ww` keeps `ps` from truncating a long absolute `argv[0]`, which would
/// otherwise hide the managed config file.
///
/// A successful kill sets the shell variable `killed`, which the caller uses to
/// decide whether the TUN routes may be torn down: a skipped (foreign) candidate
/// must leave them alone.
///
/// The snippets are embedded into `do shell script "..."`, an `AppleScript`
/// string literal delimited by double quotes, so every literal `"` inside them
/// MUST be escaped as `\"` for `AppleScript` (written `\\\"` in Rust source);
/// otherwise the `AppleScript` literal ends early and `osascript` fails. The
/// returned strings are raw shell text (no `AppleScript` wrapper).
///
/// Pure string manipulation, so it is compiled (and unit-tested) on every
/// platform; the privileged scripts themselves are macOS-only.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn build_pid_kill_commands(
    confirmed: &[i32],
    legacy: &[i32],
    core_escaped: &str,
    core_dir_escaped: &str,
) -> (String, String) {
    // Identity probe shared by both loops: re-read `comm`, the full `argv` and
    // the working directory, then reduce them to the two legacy signals. The
    // basename of `argv[0]` is taken with shell parameter expansion (`=`
    // context), so it neither splits nor globs a hostile argument list.
    let probe = concat!(
        "comm=$(ps -p $p -o comm= 2>/dev/null); ",
        "args=$(ps -ww -p $p -o args= 2>/dev/null); ",
        "cwd=$(lsof -a -p $p -d cwd -Fn 2>/dev/null | sed -n 's/^n//p'); ",
        "base=${args%% *}; base=${base##*/}; ",
        "cfg=0; case \\\"$args\\\" in *run_config.yaml*) cfg=1;; esac; ",
        "named=0; ",
        "if [ \\\"$base\\\" = 'mihomo' ] || [ \\\"$base\\\" = 'zephyr-mihomo' ]; then named=1; fi; ",
    );
    let join_pids = |pids: &[i32]| {
        pids.iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>()
            .join(" ")
    };
    // The working directory only authorises a kill together with the legacy
    // launch identity: a recycled PID that merely happens to sit in the core
    // directory must not be terminated.
    let cwd_ok = format!(
        "if [ \\\"$cwd\\\" = '{core_dir_escaped}' ] && [ \\\"$cfg\\\" = 1 ] && [ \\\"$named\\\" = 1 ]; then ok=1; fi; "
    );
    let kill_tail = "if [ \\\"$ok\\\" = 1 ]; then kill -9 $p 2>/dev/null && killed=1; fi; done;";

    let confirmed_cmd = if confirmed.is_empty() {
        String::new()
    } else {
        let comm_ok = format!("if [ \\\"$comm\\\" = '{core_escaped}' ]; then ok=1; fi; ");
        format!(
            "for p in {}; do {} ok=0; {} {} {}",
            join_pids(confirmed),
            probe,
            comm_ok,
            cwd_ok,
            kill_tail
        )
    };
    let legacy_cmd = if legacy.is_empty() {
        String::new()
    } else {
        format!(
            "for p in {}; do {} ok=0; {} {}",
            join_pids(legacy),
            probe,
            cwd_ok,
            kill_tail
        )
    };
    (confirmed_cmd, legacy_cmd)
}

/// Compose the privileged script that terminates this app's managed root core.
///
/// The script re-verifies each PID immediately before SIGKILL (confirmed PIDs
/// must still show the managed executable; otherwise the legacy launch identity
/// must still hold — core directory as working directory plus argv[0] named
/// `mihomo`/`zephyr-mihomo` and the managed `run_config.yaml` argument — `lsof`
/// works here because the script runs as root), then removes the TUN routes.
/// Returns `None` when there is nothing to kill.
///
/// The snippets are embedded into `do shell script "..."`, an `AppleScript` string
/// literal delimited by double quotes, so every literal `"` inside them MUST be
/// escaped as `\"` for `AppleScript`; otherwise the literal ends early and
/// `osascript` fails with a syntax error. Covered by
/// `test_managed_root_kill_script_escapes_applescript_quotes`.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn build_managed_root_kill_script(
    exe: &std::path::Path,
    confirmed: &[i32],
    candidates: &[i32],
) -> Option<String> {
    if confirmed.is_empty() && candidates.is_empty() {
        return None;
    }
    let core_escaped = shell_escape_single(&exe.to_string_lossy());
    let core_dir_escaped = shell_escape_single(&exe.parent().unwrap_or(exe).to_string_lossy());
    let (confirmed_cmd, legacy_cmd) =
        build_pid_kill_commands(confirmed, candidates, &core_escaped, &core_dir_escaped);
    let mut parts: Vec<String> = Vec::new();
    if !confirmed_cmd.is_empty() {
        parts.push(confirmed_cmd);
    }
    if !legacy_cmd.is_empty() {
        parts.push(legacy_cmd);
    }
    // Tear down the split-default routes only when a loop above actually
    // terminated an app-owned core. A legacy candidate whose working directory
    // is not the app's core directory (a foreign root core) is skipped, and
    // removing its routes would break that unrelated service's TUN.
    Some(format!(
        r#"do shell script "killed=0; {body} sleep 0.3; if [ \"$killed\" = 1 ]; then route delete 0.0.0.0/1 2>/dev/null; route delete 128.0.0.0/1 2>/dev/null; fi; true" with administrator privileges"#,
        body = parts.join(" ")
    ))
}

/// Kill only root-owned processes running this app's managed core (matched by
/// PID), leaving unrelated root mihomo services untouched. Also cleans up TUN
/// interface and routes. Returns `Ok(())` when no managed root process exists.
///
/// The PID list is collected before the authorization dialog, so the script
/// re-verifies each PID immediately before sending SIGKILL:
/// - confirmed PIDs must still show the managed executable in `ps comm`;
/// - otherwise the legacy launch identity must still hold: the app's core
///   directory as working directory (verified with `lsof`, which runs with
///   privileges here and can therefore read root processes) together with an
///   `argv[0]` named `mihomo`/`zephyr-mihomo` and a `run_config.yaml` argument.
#[cfg(target_os = "macos")]
pub fn kill_managed_root_mihomo_as_root(
    managed_exe_path: Option<&std::path::Path>,
) -> Result<(), String> {
    let Some(exe) = managed_exe_path else {
        return Ok(());
    };
    let confirmed = managed_root_mihomo_pids(Some(exe));
    let candidates = legacy_candidate_pids(exe);
    let Some(script) = build_managed_root_kill_script(exe, &confirmed, &candidates) else {
        return Ok(());
    };
    let result = run_privileged_shell_script(&script);
    if result.is_ok() {
        // The script re-verified every candidate as root while it had the
        // privileges to do so. Remember them so a candidate that was skipped as
        // foreign does not prompt again on the next start, while a genuinely new
        // PID still triggers. A cancelled prompt leaves them unrecorded, so the
        // user is asked again next time.
        if let Ok(mut already_checked) = PRIVILEGED_LEGACY_CHECKED.lock() {
            already_checked.extend(candidates.iter().copied());
        }
    }
    result
}

#[cfg(not(target_os = "macos"))]
pub const fn kill_managed_root_mihomo_as_root(
    _managed_exe_path: Option<&std::path::Path>,
) -> Result<(), String> {
    Ok(())
}

/// Longest wait for a terminated managed root core to disappear before the
/// termination is reported as failed.
#[cfg(target_os = "macos")]
const ROOT_KILL_VERIFY_TIMEOUT_MS: u32 = 8000;

/// Terminate this app's managed root core and confirm that it is gone.
///
/// [`kill_managed_root_mihomo_as_root`] only reports whether the privileged
/// *script* ran: the script suppresses per-PID kill failures (`2>/dev/null`) and
/// always exits successfully, so `Ok(())` is not proof that the process died.
/// A caller that trusted it would clear the TUN flag while the root core keeps
/// running and holding the configured ports.
///
/// Only the executable-confirmed set can block here. A legacy candidate's
/// working directory cannot be read without privileges, so it may be a foreign
/// root core that the script deliberately skipped; treating it as "still
/// running" would make an unrelated service block the caller.
///
/// The scan is blocking; run it on a blocking task.
#[cfg(target_os = "macos")]
pub fn kill_managed_root_mihomo_as_root_verified(
    managed_exe_path: Option<&std::path::Path>,
) -> Result<(), String> {
    let script_result = kill_managed_root_mihomo_as_root(managed_exe_path);
    // A script failure (most often a cancelled authorization prompt) only
    // matters when this app's own managed core is confirmed alive. When only
    // unverified legacy candidates triggered the prompt, the script skipped
    // them and the caller must not fail — otherwise a foreign root core (e.g.
    // another install) would break startup, TUN disable and stop.
    if let Err(err) = script_result {
        if has_confirmed_root_mihomo(managed_exe_path) {
            return Err(err);
        }
    }
    let mut waited = 0;
    while has_confirmed_root_mihomo(managed_exe_path) {
        if waited > ROOT_KILL_VERIFY_TIMEOUT_MS {
            return Err("Root mihomo still running after termination".to_owned());
        }
        std::thread::sleep(std::time::Duration::from_millis(200));
        waited += 200;
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub const fn kill_managed_root_mihomo_as_root_verified(
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
pub async fn kill_all_mihomo_as_root_cmd(app: tauri::AppHandle) -> Result<(), String> {
    // Prefer the executable recorded when the root core was started: the managed
    // binary may have been replaced or removed while it still runs, in which case
    // `get_core_exe_path` fails and the cleanup would silently do nothing.
    let exe = last_root_core_exe().or_else(|| super::core_process::get_core_exe_path(&app).ok());
    // Async + `spawn_blocking`: a synchronous command runs on the main thread,
    // and the privileged script waits for the administrator dialog (up to 30s),
    // which would freeze the window for that whole time. The verified variant
    // also confirms the core is actually gone instead of merely assuming it.
    tokio::task::spawn_blocking(move || kill_managed_root_mihomo_as_root_verified(exe.as_deref()))
        .await
        .map_err(|e| e.to_string())?
}

/// Tauri command to disable TUN mode (clears flag and kills root mihomo)
/// Only available on macOS - TUN requires root on macOS
#[tauri::command]
#[cfg(target_os = "macos")]
pub async fn disable_tun_cmd(app: tauri::AppHandle) -> Result<(), String> {
    // Scope the privileged cleanup to this app's managed core: unrelated root
    // mihomo services must never be killed, and a self-restarting external
    // service must not be able to block TUN from being disabled. Prefer the
    // executable recorded when the root core was started: the managed binary
    // may have been replaced or removed while it still runs.
    let managed_exe = last_root_core_exe().or_else(|| get_core_exe_path(&app).ok());
    let exe_for_scan = managed_exe.clone();
    tokio::task::spawn_blocking(move || {
        kill_managed_root_mihomo_as_root_verified(exe_for_scan.as_deref())
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

/// Persist `tun_enabled` through the owner path (`run_config.yaml` + settings).
///
/// Callers outside this module use it to record that a TUN core is live when the
/// flag is not set by a settings-carrying frontend call, so the next launch reads
/// a value that matches what is actually running.
pub fn sync_tun_settings(app: &AppHandle, enable: bool) -> Result<(), String> {
    if let Some(state) = app.try_state::<crate::SettingsState>() {
        // Persist and publish while still holding the settings lock, the same
        // order `save_settings` / `patch_settings` use. Taking a snapshot and
        // releasing the lock first would let a concurrent writer publish and
        // persist in between, after which this write would put the stale value
        // back on disk while memory kept the newer one. Publishing only after a
        // successful write also removes the need for a rollback write, which
        // could itself overwrite a value another writer had just set.
        let mut guard = state
            .0
            .lock()
            .map_err(|e| format!("Settings lock failed: {e}"))?;
        let mut next = guard.clone();
        next.tun_enabled = Some(enable);
        crate::persist_settings(app, &next)?;
        guard.tun_enabled = Some(enable);
        drop(guard);
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
