use rand::RngExt as _;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::Ordering;
use tauri::{AppHandle, Manager as _, State};
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::net::TcpStream;

#[cfg(any(target_os = "macos", target_os = "linux"))]
use std::os::unix::fs::PermissionsExt as _;

use super::secure_io::write_file_secure;
#[cfg(target_os = "macos")]
use crate::backend_event::lock_best_effort;
use crate::backend_event::{codes, lock_critical, redact_error_message, BackendModule};
#[allow(unused_imports)]
use crate::{emit_error, emit_info, emit_warn};
use zephyr_core::config::sanitizer::{sanitize_config_file_name, validate_path_within_dir};

const DEFAULT_API_PORT: u16 = 9090;
pub const DEFAULT_MIXED_PORT: u16 = 7890;
#[cfg(target_os = "macos")]
const PORT_WAIT_MAX_RETRIES: u64 = 50;
#[cfg(target_os = "macos")]
const PORT_WAIT_INTERVAL_MS: u64 = 100;
const HEALTH_CHECK_MAX_RETRIES: u32 = 20;
const HEALTH_CHECK_INITIAL_INTERVAL_MS: u64 = 50;
const HEALTH_CHECK_MAX_INTERVAL_MS: u64 = 1000;
#[cfg(target_os = "macos")]
#[cfg(target_os = "macos")]
use super::tun_manager::{
    get_tun_log_path, has_managed_root_mihomo, is_tun_mode,
    kill_managed_root_mihomo_as_root_verified, restart_core_as_root, set_tun_mode,
};
use super::{
    AppPaths, CoreData, CoreStartResult, MihomoState, ProxyEndpoint, ProxyScheme, CORE_STARTING,
};

#[cfg(target_os = "windows")]
use super::CREATE_NO_WINDOW;

// ── Windows Job Object for auto-killing mihomo when Tauri exits ──────────
#[cfg(target_os = "windows")]
#[allow(
    clippy::wildcard_imports,
    clippy::doc_markdown,
    clippy::cast_possible_truncation
)]
mod win_job {
    use std::sync::OnceLock;
    use windows_sys::Win32::Foundation::*;
    use windows_sys::Win32::System::JobObjects::*;

    /// Wrapper to make HANDLE Send+Sync so it can live in a static.
    struct SendSyncHandle(HANDLE);
    // Safety: Job Object handles are kernel objects; access is serialized by
    // the kernel, so sharing the handle across threads is safe.
    unsafe impl Send for SendSyncHandle {}
    // Safety: Same as above.
    unsafe impl Sync for SendSyncHandle {}

    /// Handle to a Job Object with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE.
    /// When the Tauri process exits (even from Task Manager), Windows closes
    /// this handle and automatically terminates all processes in the Job.
    static JOB: OnceLock<SendSyncHandle> = OnceLock::new();

    /// Create (once) and return the Job Object handle.
    fn get_or_create_job() -> HANDLE {
        JOB.get_or_init(|| {
            // Safety: CreateJobObjectW is a well-defined Windows API.
            let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
            if job.is_null() {
                return SendSyncHandle(job);
            }

            // Safety: JOBOBJECT_BASIC_LIMIT_INFORMATION consists of primitive
            // integer types, so zero-initializing it is safe.
            let mut info: JOBOBJECT_BASIC_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
            info.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;

            // Safety: JOBOBJECT_EXTENDED_LIMIT_INFORMATION consists of primitive
            // integer types and JOBOBJECT_BASIC_LIMIT_INFORMATION, so
            // zero-initializing it is safe.
            let mut extended_info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION =
                unsafe { std::mem::zeroed() };
            extended_info.BasicLimitInformation = info;

            // Safety: SetInformationJobObject with these parameters is safe.
            let result = unsafe {
                SetInformationJobObject(
                    job,
                    JobObjectExtendedLimitInformation,
                    &extended_info as *const _ as *const _,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                )
            };

            if result == 0 {
                // Failed to set info — job won't auto-kill, but don't crash.
                // Safety: `job` is a valid, non-null handle to a Job Object.
                unsafe { CloseHandle(job) };
                return SendSyncHandle(std::ptr::null_mut());
            }

            SendSyncHandle(job)
        })
        .0
    }

    /// Assign a process to the auto-kill Job Object.
    pub fn assign_to_job(process_handle: HANDLE) -> bool {
        let job = get_or_create_job();
        if job.is_null() {
            return false;
        }
        // Safety: AssignProcessToJobObject is a well-defined Windows API.
        unsafe { AssignProcessToJobObject(job, process_handle) != 0 }
    }
}

// ── ProcessIo trait for testable process operations ────────────────────────

/// Trait for process operations used by `core_process`.
#[cfg_attr(test, mockall::automock)]
pub(crate) trait ProcessIo {
    fn run_command_output(&self, exe: &Path, args: &str) -> Result<std::process::Output, String>;
}

pub(crate) struct RealProcessIo;

impl ProcessIo for RealProcessIo {
    fn run_command_output(&self, exe: &Path, args: &str) -> Result<std::process::Output, String> {
        let mut cmd = Command::new(exe);
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt as _;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        cmd.arg(args);
        cmd.output()
            .map_err(|e| format!("Failed to run command: {e}"))
    }
}

// ── Pure helper functions ────────────────────────────────────────────────

/// Detect whether a core log indicates a cache/lock issue that warrants retry.
fn detect_cache_lock_issue(log: &str) -> bool {
    log.contains("database is locked")
        || log.contains("cache.db")
        || log.contains("unable to open database")
        || log.contains("database disk image is malformed")
}

/// Parse the version string from `mihomo -v` stdout.
fn parse_version_output(stdout: &str) -> String {
    let trimmed = stdout.trim();
    if let Some(v_idx) = trimmed.find('v') {
        let after_v = &trimmed[v_idx..];
        if let Some(space_idx) = after_v.find(' ') {
            after_v[..space_idx].to_owned()
        } else {
            after_v.to_owned()
        }
    } else {
        trimmed.to_owned()
    }
}

// ── Test-only public wrappers ───────────────────────────────────────────

#[must_use]
pub const fn core_binary_name() -> &'static str {
    #[cfg(target_os = "windows")]
    {
        "zephyr-mihomo.exe"
    }
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        "zephyr-mihomo"
    }
}

/// Kill all mihomo processes (cleanup function)
/// Drain existing mihomo connections via REST API before killing the process.
/// This helps mihomo exit faster when it has many active connections.
/// Failure is non-fatal — we fall back to force kill.
async fn drain_connections_if_alive(port: u16, secret_val: &str) {
    let url = format!("http://127.0.0.1:{port}/connections");
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(2))
        // Loopback drain request must never be routed through an ambient
        // (environment) proxy.
        .no_proxy()
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            emit_error!(
                Core,
                CORE_STOP_FAILED,
                "Failed to build HTTP client for drain: {e}"
            );
            return;
        }
    };

    // Close all connections via mihomo API
    if let Err(e) = client
        .delete(&url)
        .header("Authorization", format!("Bearer {secret_val}"))
        .send()
        .await
    {
        emit_error!(Core, CORE_STOP_FAILED, "DELETE /connections failed: {e}");
    }

    // Wait for connections to drain (max 2s)
    let deadline = tokio::time::Instant::now() + tokio::time::Duration::from_secs(2);
    while tokio::time::Instant::now() < deadline {
        match client
            .get(&url)
            .header("Authorization", format!("Bearer {secret_val}"))
            .send()
            .await
        {
            Ok(resp) if resp.status().is_success() => {
                match resp.json::<serde_json::Value>().await {
                    Ok(body) => {
                        let count = body
                            .get("connections")
                            .and_then(|v| v.as_array())
                            .map_or(0, Vec::len);
                        if count == 0 {
                            return;
                        }
                    }
                    Err(e) => {
                        emit_error!(
                            Core,
                            CORE_STOP_FAILED,
                            "Failed to parse drain response JSON: {e}"
                        );
                        return;
                    }
                }
            }
            Ok(resp) => {
                emit_warn!(
                    Core,
                    CORE_STOP_FAILED,
                    "GET /connections returned status: {}",
                    resp.status()
                );
                return; // Core already unreachable
            }
            Err(e) => {
                emit_error!(
                    Core,
                    CORE_STOP_FAILED,
                    "GET /connections request error: {e}"
                );
                return; // Core already unreachable
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    emit_warn!(
        Core,
        CORE_STOP_FAILED,
        "Timeout waiting for connections to drain"
    );
}

/// Kill all zephyr-mihomo processes gracefully (SIGTERM first, SIGKILL after timeout).
/// Also kills legacy 'mihomo' processes for backward compatibility with Lite version users.
///
/// On Unix: sends SIGTERM, waits up to 2s for exit, then SIGKILL.
/// On Windows: uses taskkill /F (no graceful option).
pub fn kill_mihomo() {
    let exe_name = core_binary_name();
    #[cfg(target_os = "windows")]
    let legacy_name = "mihomo.exe";
    #[cfg(not(target_os = "windows"))]
    let legacy_name = "mihomo";

    #[cfg(unix)]
    {
        // Step 1: SIGTERM — allow mihomo to close connections gracefully
        // Kill both new and legacy binary names for backward compatibility
        let _ = std::process::Command::new("killall")
            .arg("-15") // SIGTERM
            .arg(exe_name)
            .arg(legacy_name)
            .output();

        // Step 2: Wait up to 2s for graceful exit
        for _ in 0..20 {
            let output = std::process::Command::new("pgrep")
                .arg("-x")
                .arg(exe_name)
                .output();
            let legacy_output = std::process::Command::new("pgrep")
                .arg("-x")
                .arg(legacy_name)
                .output();
            if let (Ok(out), Ok(legacy_out)) = (output, legacy_output) {
                if out.stdout.is_empty() && legacy_out.stdout.is_empty() {
                    return; // Process has exited gracefully
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }

        // Step 3: Force kill if still alive
        for _ in 0..3 {
            let _ = std::process::Command::new("killall")
                .arg("-9")
                .arg(exe_name)
                .arg(legacy_name)
                .output();
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt as _;
        // Kill both new and legacy binary names for backward compatibility
        let _ = std::process::Command::new("taskkill")
            .args(["/F", "/IM", exe_name, "/IM", legacy_name])
            .creation_flags(CREATE_NO_WINDOW)
            .output();
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
pub fn ensure_executable(path: &Path) -> Result<(), String> {
    let metadata = fs::metadata(path).map_err(|e| format!("Failed to read core metadata: {e}"))?;
    let mode = metadata.permissions().mode();
    if mode & 0o100 != 0 {
        return Ok(());
    }
    let mut permissions = metadata.permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(path, permissions)
        .map_err(|e| format!("Failed to set executable permissions: {e}"))
}

#[cfg(target_os = "windows")]
pub const fn ensure_executable(_path: &Path) -> Result<(), String> {
    Ok(())
}

/// Detect portable mode.
/// Portable mode is activated when a `.portable` marker file exists next to the executable.
/// On Linux (`AppImage`), the `APPIMAGE` env var is used since `current_exe()` returns
/// a temporary mount point.
pub(crate) fn is_portable_mode() -> bool {
    // AppImage: check the directory containing the .AppImage file
    #[cfg(target_os = "linux")]
    if let Ok(appimage_path) = std::env::var("APPIMAGE") {
        if let Some(dir) = std::path::Path::new(&appimage_path).parent() {
            if dir.join(".portable").exists() {
                return true;
            }
        }
    }

    // Windows / general: check the directory containing the executable
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|dir| dir.join(".portable")))
        .map(|marker| marker.exists())
        .unwrap_or(false)
}

/// Get the portable data directory (exe or `AppImage` location)
fn portable_data_dir() -> Result<std::path::PathBuf, String> {
    #[cfg(target_os = "linux")]
    if let Ok(appimage_path) = std::env::var("APPIMAGE") {
        if let Some(dir) = std::path::Path::new(&appimage_path).parent() {
            return Ok(dir.to_path_buf());
        }
    }

    std::env::current_exe()
        .map_err(|e| format!("Failed to get exe path: {e}"))?
        .parent()
        .ok_or_else(|| "Cannot determine exe directory".to_owned())
        .map(std::path::Path::to_path_buf)
}

pub fn resolve_app_paths(app: &AppHandle) -> Result<AppPaths, String> {
    let app_data_dir = if is_portable_mode() {
        portable_data_dir()?
    } else {
        app.path().app_data_dir().map_err(|e| e.to_string())?
    };
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

    // Search parent directories with depth limit to prevent traversing to root
    const MAX_DEPTH: usize = 10;
    let mut dev_path = exe_path.clone();
    let mut depth = 0;
    while dev_path.pop() && depth < MAX_DEPTH {
        let candidate = dev_path.join("core");
        if candidate.exists() {
            candidates.push(candidate);
        }
        depth += 1;
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
    bundled_dir.exists().then_some(bundled_dir)
}

fn migrate_legacy_assets(app: &AppHandle, paths: &AppPaths) -> Result<(), String> {
    // Portable mode: no migration needed, core files are already in the exe directory
    if is_portable_mode() {
        return Ok(());
    }

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
                        emit_warn!(
                            Core,
                            CORE_START_FAILED,
                            "Failed to copy bundled file {file_name}: {e}"
                        );
                    }
                }

                // Always ensure executable permission on Unix
                #[cfg(any(target_os = "macos", target_os = "linux"))]
                {
                    if (file_name == core_binary_name() || file_name == "mihomo") && target.exists()
                    {
                        let _ = ensure_executable(&target);
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

            fs::copy(&source, &target).map_err(|e| format!("Failed to migrate {source:?}: {e}"))?;
        }
    }

    Ok(())
}

pub fn ensure_app_storage(app: &AppHandle) -> Result<AppPaths, String> {
    let paths = resolve_app_paths(app)?;

    #[cfg(target_os = "windows")]
    let is_new = !paths.app_data_dir.exists();
    #[cfg(not(target_os = "windows"))]
    let _is_new = !paths.app_data_dir.exists();

    fs::create_dir_all(&paths.app_data_dir)
        .map_err(|e| format!("Failed to create app data dir: {e}"))?;
    fs::create_dir_all(&paths.core_dir).map_err(|e| format!("Failed to create core dir: {e}"))?;
    fs::create_dir_all(&paths.profiles_dir)
        .map_err(|e| format!("Failed to create profiles dir: {e}"))?;

    #[cfg(target_os = "windows")]
    {
        // Skip ACL in portable mode (setting ACL on USB/removable paths is unnecessary)
        if is_new && !is_portable_mode() {
            use std::os::windows::process::CommandExt as _;
            use std::process::Command;
            if let Ok(username) = std::env::var("USERNAME") {
                let _ = Command::new("icacls")
                    .arg(&paths.app_data_dir)
                    .arg("/inheritance:r")
                    .arg("/grant:r")
                    // nosemgrep: rust-command-format-arg — passed as .arg(), not through shell
                    .arg(format!("{username}:(OI)(CI)(F)"))
                    .arg("/grant:r")
                    .arg("SYSTEM:(OI)(CI)(F)")
                    .arg("/grant:r")
                    .arg("Administrators:(OI)(CI)(F)")
                    .creation_flags(CREATE_NO_WINDOW)
                    .output();
            }
        }
    }

    // S-03: Tighten profiles directory permissions on Unix (owner-only rwx------)
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        let _ = fs::set_permissions(&paths.profiles_dir, fs::Permissions::from_mode(0o700));
    }

    migrate_legacy_assets(app, &paths)?;
    Ok(paths)
}

fn resolve_profile_path(paths: &AppPaths, config_path: &str) -> Result<(String, PathBuf), String> {
    let config_file_name =
        sanitize_config_file_name(config_path.to_owned()).map_err(|e| e.to_string())?;
    if config_file_name == "run_config.yaml" {
        return Err("Cannot switch to run_config.yaml directly".to_owned());
    }

    let resolved_path = paths.profiles_dir.join(&config_file_name);

    // Validate that the resolved path is within profiles_dir
    validate_path_within_dir(&resolved_path, &paths.profiles_dir).map_err(|e| e.to_string())?;

    if resolved_path.exists() {
        return Ok((config_file_name, resolved_path));
    }

    if let Some(fallback) = first_available_profile(paths) {
        let fallback_name = fallback
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or("Invalid fallback config filename encoding")?
            .to_owned();
        return Ok((fallback_name, fallback));
    }

    // No profile yet: the start runs the built-in minimal config and the app
    // shows its no-subscription state, so nothing is written here.
    Ok((config_file_name, resolved_path))
}

/// Contents of the profile a start with `config_path` runs: the bare file name
/// inside the profiles directory, or the first available profile when it is
/// missing (as `resolve_profile_path` does), never a caller-given absolute path.
pub(crate) fn read_start_profile(app: &AppHandle, config_path: &str) -> Option<String> {
    let paths = super::resolve_app_paths(app).ok()?;
    let name = sanitize_config_file_name(config_path.to_owned()).ok()?;
    let requested = paths.profiles_dir.join(name);
    let profile = if requested.exists() {
        requested
    } else {
        first_available_profile(&paths)?
    };
    super::crypto::read_profile_file(&profile).ok()
}

pub(crate) fn first_available_profile(paths: &AppPaths) -> Option<PathBuf> {
    let mut configs = Vec::new();
    let entries = match fs::read_dir(&paths.profiles_dir) {
        Ok(entries) => entries,
        Err(_) => return None,
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
    configs.into_iter().next()
}

fn parse_external_controller_port(yaml_val: &serde_yaml::Value) -> u16 {
    yaml_val
        .get("external-controller")
        .and_then(|v| v.as_str())
        .and_then(|ext_ctrl| ext_ctrl.split(':').next_back())
        .and_then(|p| p.parse::<u16>().ok())
        .unwrap_or(DEFAULT_API_PORT)
}

/// Extract the configured proxy endpoint: port plus the scheme that listener
/// speaks.
/// Checks `mixed-port`, `port`, `socks-port` in order without defaulting.
#[must_use]
pub fn extract_configured_proxy_endpoint_from_yaml(
    yaml_val: &serde_yaml::Value,
) -> Option<ProxyEndpoint> {
    let parse_u16 = |val: &serde_yaml::Value| -> Option<u16> {
        val.as_u64()
            .and_then(|p| u16::try_from(p).ok())
            .or_else(|| val.as_str().and_then(|s| s.trim().parse::<u16>().ok()))
            .filter(|&p| p != 0)
    };

    yaml_val
        .get("mixed-port")
        .and_then(parse_u16)
        .map(ProxyEndpoint::http)
        .or_else(|| {
            yaml_val
                .get("port")
                .and_then(parse_u16)
                .map(ProxyEndpoint::http)
        })
        .or_else(|| {
            yaml_val
                .get("socks-port")
                .and_then(parse_u16)
                .map(ProxyEndpoint::socks5h)
        })
}

/// Extract configured proxy endpoint from raw YAML content string.
#[must_use]
pub fn extract_configured_proxy_endpoint(yaml_content: &str) -> Option<ProxyEndpoint> {
    let yaml_val: serde_yaml::Value = serde_yaml::from_str(yaml_content).ok()?;
    extract_configured_proxy_endpoint_from_yaml(&yaml_val)
}

/// Extract the configured proxy port from a parsed YAML value, if present.
/// Checks `mixed-port`, `port`, `socks-port` in order without defaulting.
#[must_use]
pub fn extract_configured_proxy_port_from_yaml(yaml_val: &serde_yaml::Value) -> Option<u16> {
    extract_configured_proxy_endpoint_from_yaml(yaml_val).map(|e| e.port)
}

/// Extract configured proxy port from raw YAML content string.
#[must_use]
pub fn extract_configured_proxy_port(yaml_content: &str) -> Option<u16> {
    let yaml_val: serde_yaml::Value = serde_yaml::from_str(yaml_content).ok()?;
    extract_configured_proxy_port_from_yaml(&yaml_val)
}

/// Parse the managed proxy endpoint from YAML config.
/// Checks `mixed-port`, `port`, `socks-port` in order (same logic as frontend),
/// keeping the scheme the matched listener speaks.
/// Supports both integer (`mixed-port: 7890`) and string (`mixed-port: "7890"`) formats.
/// Returns `None` when the configuration exposes no proxy endpoint: an unmanaged
/// default port must never be stored or advertised.
fn parse_proxy_endpoint(yaml_val: &serde_yaml::Value) -> Option<ProxyEndpoint> {
    extract_configured_proxy_endpoint_from_yaml(yaml_val)
}

fn validate_custom_args(custom_args: &[String]) -> Result<Vec<String>, String> {
    let mut safe_custom_args = Vec::with_capacity(custom_args.len());

    let blocked_args = [
        "-d",
        "--directory",
        "-f",
        "--config",
        "-ext-ctl",
        "--external-controller",
        "-secret",
        "--secret",
    ];

    for arg in custom_args {
        let trimmed = arg.trim();
        if trimmed.is_empty() {
            continue;
        }

        let arg_lower = trimmed.to_lowercase();
        let is_blocked = blocked_args
            .iter()
            .any(|&b| arg_lower == b || arg_lower.starts_with(&format!("{b}=")));

        if is_blocked {
            return Err(format!(
                "Argument '{trimmed}' is not allowed for security reasons"
            ));
        }

        safe_custom_args.push(trimmed.to_owned());
    }

    Ok(safe_custom_args)
}

/// Global user preferences to inject into runtime config.
/// Fields set to Some(...) override the YAML profile values;
/// None means "use whatever the YAML profile has".
/// `Some(0)` for port fields means "disabled"; `None` means "use YAML default".
#[derive(Debug, Clone, Default)]
pub struct GlobalPreferences {
    pub mode: Option<String>,
    pub tun_enabled: Option<bool>,
    pub mixed_port: Option<u16>,
    pub socks_port: Option<u16>,
    pub http_port: Option<u16>,
    pub ipv6: Option<bool>,
    pub allow_lan: Option<bool>,
    pub unified_delay: Option<bool>,
}

fn yaml_key(key: &str) -> serde_yaml::Value {
    serde_yaml::Value::String(key.to_owned())
}

fn yaml_number(number: u16) -> serde_yaml::Value {
    serde_yaml::Value::Number(serde_yaml::Number::from(number))
}

fn insert_yaml(mapping: &mut serde_yaml::Mapping, key: &str, value: serde_yaml::Value) {
    mapping.insert(yaml_key(key), value);
}

fn insert_default_yaml(
    mapping: &mut serde_yaml::Mapping,
    key: &str,
    value: impl FnOnce() -> serde_yaml::Value,
) {
    if !mapping.keys().any(|k| k.as_str() == Some(key)) {
        mapping.insert(yaml_key(key), value());
    }
}

#[must_use]
pub fn prepare_runtime_config(
    content: &str,
    secret: &str,
    prefs: Option<&GlobalPreferences>,
) -> Option<(String, u16, Option<ProxyEndpoint>)> {
    let mut yaml_val = serde_yaml::from_str::<serde_yaml::Value>(content).ok()?;
    if !yaml_val.is_mapping() {
        return None;
    }

    let config_port = parse_external_controller_port(&yaml_val);
    if let Some(mapping) = yaml_val.as_mapping_mut() {
        insert_yaml(
            mapping,
            "external-controller",
            serde_yaml::Value::String(format!("127.0.0.1:{config_port}")),
        );
        insert_yaml(
            mapping,
            "secret",
            serde_yaml::Value::String(secret.to_owned()),
        );

        // Default unified-delay to true if missing
        insert_default_yaml(mapping, "unified-delay", || serde_yaml::Value::Bool(true));

        // Network performance defaults (Google Cloud TCP best practices)
        // Only inject when the profile doesn't already specify a value,
        // so user/subscription overrides are respected.

        // tcp-concurrent: attempt TCP connections to all resolved IPs
        // simultaneously and use the fastest one. Reduces handshake
        // latency especially when a proxy node has both IPv4 and IPv6.
        insert_default_yaml(mapping, "tcp-concurrent", || serde_yaml::Value::Bool(true));

        // keep-alive-interval: TCP keep-alive probe interval in seconds.
        // Prevents idle connections from being dropped by middleboxes
        // (NATs, firewalls), aligning with Google's recommendation to
        // maintain persistent connections and avoid slow-start after idle.
        insert_default_yaml(mapping, "keep-alive-interval", || yaml_number(30));

        // keep-alive-idle: maximum idle time (seconds) before TCP keep-alive
        // probes begin. Default is 15s which is too aggressive — connections
        // are probed and potentially closed after just 15s of inactivity.
        // Setting to 600 (10 minutes) keeps connections alive through typical
        // web browsing pauses, reducing TCP+TLS handshake round-trips.
        // (Google: persistent connections reduced TTFB from 230ms to 123ms)
        insert_default_yaml(mapping, "keep-alive-idle", || yaml_number(600));

        // profile.store-fake-ip: persist fake-ip mapping table to disk so
        // that on restart, previously resolved domains reuse the same fake-ip
        // address. This avoids DNS re-resolution and connection disruption,
        // aligning with Google's recommendation to minimize DNS queries
        // as a key latency contributor.
        let profile_key = yaml_key("profile");
        let store_fake_ip_key = yaml_key("store-fake-ip");
        // Handle three cases: existing Mapping, existing Null/non-Mapping, or missing key
        let needs_insert =
            if let Some(serde_yaml::Value::Mapping(profile_map)) = mapping.get_mut(&profile_key) {
                if !profile_map.contains_key(&store_fake_ip_key) {
                    profile_map.insert(store_fake_ip_key, serde_yaml::Value::Bool(true));
                }
                false
            } else {
                true
            };
        if needs_insert {
            let mut profile_map = serde_yaml::Mapping::new();
            profile_map.insert(yaml_key("store-fake-ip"), serde_yaml::Value::Bool(true));
            mapping.insert(profile_key, serde_yaml::Value::Mapping(profile_map));
        }

        // find-process-mode: always match the originating process for
        // each connection. Required for accurate rule-based routing in
        // TUN mode and better connection visibility.
        // (Not a TCP optimization — improves routing accuracy)
        insert_default_yaml(mapping, "find-process-mode", || {
            serde_yaml::Value::String("always".to_owned())
        });

        // Inject global user preferences (override YAML profile values)
        if let Some(p) = prefs {
            if let Some(mode) = &p.mode {
                // Validate mode against supported values
                if matches!(mode.as_str(), "rule" | "global" | "direct") {
                    insert_yaml(mapping, "mode", serde_yaml::Value::String(mode.clone()));
                }
            }
            if let Some(tun) = p.tun_enabled {
                let mut found_mapping = None;
                for (k, v) in mapping.iter_mut() {
                    if k.as_str() == Some("tun") {
                        if let serde_yaml::Value::Mapping(m) = v {
                            found_mapping = Some(m);
                        }
                        break;
                    }
                }
                if let Some(tun_map) = found_mapping {
                    tun_map.insert(yaml_key("enable"), serde_yaml::Value::Bool(tun));
                } else {
                    let mut tun_map = serde_yaml::Mapping::new();
                    tun_map.insert(yaml_key("enable"), serde_yaml::Value::Bool(tun));
                    mapping.insert(yaml_key("tun"), serde_yaml::Value::Mapping(tun_map));
                }
            }
            if let Some(port) = p.mixed_port {
                insert_yaml(mapping, "mixed-port", yaml_number(port));
            }
            if let Some(port) = p.socks_port {
                insert_yaml(mapping, "socks-port", yaml_number(port));
            }
            if let Some(port) = p.http_port {
                insert_yaml(mapping, "port", yaml_number(port));
            }
            if let Some(ipv6) = p.ipv6 {
                insert_yaml(mapping, "ipv6", serde_yaml::Value::Bool(ipv6));
            }
            if let Some(allow_lan) = p.allow_lan {
                insert_yaml(mapping, "allow-lan", serde_yaml::Value::Bool(allow_lan));
            }
            if let Some(unified_delay) = p.unified_delay {
                insert_yaml(
                    mapping,
                    "unified-delay",
                    serde_yaml::Value::Bool(unified_delay),
                );
            }
        }
    }

    // Parse proxy_port AFTER all overrides are applied so it reflects
    // any user-overridden values (mixed_port, socks_port, http_port).
    let proxy_endpoint = parse_proxy_endpoint(&yaml_val);

    let result = serde_yaml::to_string(&yaml_val).ok()?;

    Some((result, config_port, proxy_endpoint))
}

/// The built-in minimal config, with the user's global preferences (ports, TUN, ...) applied
/// the same way as for a profile.
fn build_minimal_runtime_config_with_prefs(
    secret: &str,
    prefs: Option<&GlobalPreferences>,
) -> (String, u16, Option<ProxyEndpoint>) {
    let base = build_minimal_runtime_config(secret);
    prepare_runtime_config(&base.0, secret, prefs).unwrap_or(base)
}

fn build_minimal_runtime_config(secret: &str) -> (String, u16, Option<ProxyEndpoint>) {
    (
        format!(
            "mixed-port: {DEFAULT_MIXED_PORT}\nmode: rule\nlog-level: info\nunified-delay: true\ntcp-concurrent: true\nkeep-alive-interval: 30\nkeep-alive-idle: 600\nfind-process-mode: always\nprofile:\n  store-fake-ip: true\nexternal-controller: 127.0.0.1:9090\nsecret: {secret}\nproxies: []\nproxy-groups:\n  - name: GLOBAL\n    type: select\n    proxies:\n      - DIRECT\nrules:\n  - MATCH,DIRECT\n"
        ),
        DEFAULT_API_PORT,
        Some(ProxyEndpoint {
            port: DEFAULT_MIXED_PORT,
            scheme: ProxyScheme::Http,
        }),
    )
}

fn select_runtime_config(
    paths: &AppPaths,
    preferred_name: &str,
    preferred_path: &Path,
    secret: &str,
    prefs: Option<&GlobalPreferences>,
) -> Result<(Option<String>, String, u16, Option<ProxyEndpoint>), String> {
    if preferred_path.exists() {
        let preferred_content = super::crypto::read_profile_file(preferred_path)
            .map_err(|e| format!("Failed to read config: {e}"))?;
        if let Some((final_config, config_port, proxy_port)) =
            prepare_runtime_config(&preferred_content, secret, prefs)
        {
            return Ok((
                Some(preferred_name.to_owned()),
                final_config,
                config_port,
                proxy_port,
            ));
        }
    }

    let mut fallback_profiles = Vec::new();
    let entries = if let Ok(entries) = fs::read_dir(&paths.profiles_dir) {
        entries
    } else {
        let (config, api_port, proxy_port) = build_minimal_runtime_config_with_prefs(secret, prefs);
        return Ok((None, config, api_port, proxy_port));
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
        let content = match super::crypto::read_profile_file(&path) {
            Ok(content) => content,
            Err(_) => continue,
        };
        if let Some((final_config, config_port, proxy_port)) =
            prepare_runtime_config(&content, secret, prefs)
        {
            let file_name = path
                .file_name()
                .and_then(|name| name.to_str())
                .ok_or("Invalid fallback config filename encoding")?
                .to_owned();
            emit_warn!(
                Config,
                CONFIG_PARSE_FAILED,
                "Requested config {preferred_name} is not valid, falling back to {file_name}"
            );
            return Ok((Some(file_name), final_config, config_port, proxy_port));
        }
    }

    if preferred_path.exists() {
        emit_warn!(
            Config,
            CONFIG_PARSE_FAILED,
            "Requested config {preferred_name} is not valid, falling back to minimal config"
        );
    }
    let (final_config, api_port, proxy_port) =
        build_minimal_runtime_config_with_prefs(secret, prefs);
    Ok((None, final_config, api_port, proxy_port))
}

pub fn get_core_exe_path(app: &AppHandle) -> Result<PathBuf, String> {
    find_core_exe(&ensure_app_storage(app)?.core_dir)
}

/// The installed core binary in `core_dir` (or its legacy name).
fn find_core_exe(core_dir: &Path) -> Result<PathBuf, String> {
    let binary_name = core_binary_name();
    let core_path = core_dir.join(binary_name);
    if core_path.exists() {
        return Ok(core_path);
    }

    // Fallback: check for legacy binary name (mihomo.exe / mihomo) for backward compatibility
    #[cfg(target_os = "windows")]
    let legacy_name = "mihomo.exe";
    #[cfg(not(target_os = "windows"))]
    let legacy_name = "mihomo";
    let legacy_path = core_dir.join(legacy_name);
    if legacy_path.exists() {
        return Ok(legacy_path);
    }

    Err(format!(
        "Could not find {binary_name} (or legacy {legacy_name}) in app data core directory"
    ))
}

/// The executable path that identifies this app's managed core for root-process
/// scans and privileged cleanup.
///
/// Prefers the executable recorded when the root core was started (the binary
/// may since have been replaced), then the installed binary, and finally the
/// path the binary is installed to even when the file is currently missing:
/// a running process keeps reporting that path, and the privileged script
/// derives the core directory from it to verify legacy launches. Only an
/// unresolvable app data directory yields `None`, and the app cannot start
/// without one.
#[must_use]
pub fn managed_core_exe_path(app: &AppHandle) -> Option<PathBuf> {
    // `resolve_app_paths`, not `ensure_app_storage`: this runs several times per
    // start/stop, and a failing legacy-asset migration there would yield `None`
    // and make the root-core cleanup paths skip the managed core.
    super::tun_manager::last_root_core_exe().or_else(|| {
        let core_dir = resolve_app_paths(app).ok()?.core_dir;
        Some(find_core_exe(&core_dir).unwrap_or_else(|_| core_dir.join(core_binary_name())))
    })
}

pub(super) fn generate_secret() -> String {
    rand::rng()
        .sample_iter(rand::distr::Alphanumeric)
        .take(32)
        .map(char::from)
        .collect()
}

/// Wait for a TCP port to become free (macOS only).
///
/// After killing a process, the OS may keep the port occupied for a short period.
/// This function polls until the port can be bound or the retry limit is reached.
#[cfg(target_os = "macos")]
async fn wait_for_port_free(port: u16) {
    for i in 0..PORT_WAIT_MAX_RETRIES {
        if std::net::TcpListener::bind(format!("127.0.0.1:{port}")).is_ok() {
            emit_info!(
                Core,
                CORE_START_FAILED,
                "port {port} confirmed free after {}ms",
                i * PORT_WAIT_INTERVAL_MS
            );
            break;
        }
        if i == PORT_WAIT_MAX_RETRIES - 1 {
            emit_warn!(
                Core,
                CORE_START_FAILED,
                "port {port} still occupied after {}ms, proceeding anyway",
                PORT_WAIT_MAX_RETRIES * PORT_WAIT_INTERVAL_MS
            );
        } else {
            emit_info!(
                Core,
                CORE_START_FAILED,
                "waiting for port {port}... {}ms",
                (i + 1) * PORT_WAIT_INTERVAL_MS
            );
        }
        tokio::time::sleep(std::time::Duration::from_millis(PORT_WAIT_INTERVAL_MS)).await;
    }
}

/// Attach a log file to a `Command` for stdout/stderr redirection.
fn attach_log_file(cmd: &mut Command, log_path: &Path) {
    #[cfg(unix)]
    use std::os::unix::fs::OpenOptionsExt as _;

    let mut options = std::fs::OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    options.mode(0o600);

    let file_result = options.open(log_path);
    if let Ok(log_file) = file_result {
        let stderr_handle = log_file.try_clone();
        cmd.stdout(std::process::Stdio::from(log_file));
        cmd.stderr(
            stderr_handle
                .map(std::process::Stdio::from)
                .unwrap_or_else(|_| std::process::Stdio::null()),
        );
    } else {
        cmd.stdout(std::process::Stdio::null());
        cmd.stderr(std::process::Stdio::null());
    }
}

/// Spawn mihomo, detect immediate exit, and retry on cache lock issues.
///
/// Returns the successfully spawned `Child` process and the log file path, or an error string.
/// `attempted_log` always holds the log of the latest attempt, so a failed start
/// can still point the log viewer at the output of the run that failed.
async fn spawn_with_cache_retry(
    exe_path: &Path,
    safe_custom_args: &[String],
    core_dir: &Path,
    app_data_dir: &Path,
    attempted_log: &mut Option<PathBuf>,
) -> Result<(std::process::Child, PathBuf), String> {
    let spawn_cmd = |log_suffix: &str| -> (Command, PathBuf) {
        let mut cmd = Command::new(exe_path);
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt as _;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt as _;
            // Place mihomo in its own process group so we can kill the entire
            // group (including any child processes mihomo may spawn) without
            // affecting the Tauri main process.
            cmd.process_group(0);
            #[cfg(target_os = "linux")]
            {
                // Ask the kernel to send SIGTERM to mihomo when its parent
                // (the Tauri main process) dies — even from SIGKILL.
                // This prevents mihomo from becoming an orphan process.
                #[allow(clippy::cast_possible_wrap)]
                let parent_pid = std::process::id() as libc::pid_t;
                // Safety: pre_exec runs between fork and exec; prctl and getppid
                // are async-signal-safe syscalls with no memory safety implications.
                #[allow(clippy::multiple_unsafe_ops_per_block)]
                unsafe {
                    cmd.pre_exec(move || {
                        if libc::prctl(
                            libc::PR_SET_PDEATHSIG,
                            libc::SIGTERM as libc::c_ulong,
                            0 as libc::c_ulong,
                            0 as libc::c_ulong,
                            0 as libc::c_ulong,
                        ) == -1
                        {
                            return Err(std::io::Error::last_os_error());
                        }
                        // Prevent race condition if parent died before prctl was set.
                        // getppid is async-signal-safe.
                        // Use from_raw_os_error to avoid heap allocation (not
                        // async-signal-safe) in the pre_exec closure.
                        if libc::getppid() != parent_pid {
                            return Err(std::io::Error::from_raw_os_error(libc::ESRCH));
                        }
                        Ok(())
                    });
                }
            }
        }
        cmd.args(["-d", "."]);
        cmd.args(["-f", "run_config.yaml"]);
        for arg in safe_custom_args {
            cmd.arg(arg);
        }
        cmd.current_dir(core_dir);

        let log_path = if super::LOG_CORE_ENABLED.load(std::sync::atomic::Ordering::Relaxed) {
            // Write to app data directory for persistence
            let logs_dir = app_data_dir.join("logs").join("core");
            let _ = std::fs::create_dir_all(&logs_dir);
            let date = chrono::Local::now().format("%Y-%m-%d").to_string();
            let base_path = logs_dir.join(format!("{date}.log"));
            let max_bytes = super::LOG_MAX_FILE_MB.load(std::sync::atomic::Ordering::Relaxed)
                as u64
                * 1024
                * 1024;
            match std::fs::metadata(&base_path) {
                Ok(meta) if meta.len() >= max_bytes => {
                    #[allow(clippy::redundant_clone)]
                    let mut seq_path = base_path.clone();
                    for seq in 2..100 {
                        seq_path = logs_dir.join(format!("{date}-{seq}.log"));
                        match std::fs::metadata(&seq_path) {
                            Ok(m) => {
                                if m.len() < max_bytes {
                                    break;
                                }
                            }
                            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                                break;
                            }
                            Err(e) => {
                                emit_warn!(
                                    Core,
                                    CORE_LOG_ROTATION_FAILED,
                                    "Failed to read metadata for {seq_path:?}: {e}"
                                );
                            }
                        }
                    }
                    seq_path
                }
                _ => base_path,
            }
        } else {
            std::env::temp_dir().join(format!(
                "zephyr-mihomo-{}-{}-{}.log",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis())
                    .unwrap_or(0),
                log_suffix,
            ))
        };
        (cmd, log_path)
    };

    let (mut cmd, log_path) = spawn_cmd("run");
    attach_log_file(&mut cmd, &log_path);
    *attempted_log = Some(log_path.clone());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn mihomo: {e}"))?;

    // Track the actual log file path (may change on retry)
    let mut actual_log_path = log_path.clone();

    // Check if process exits immediately
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    match child.try_wait() {
        Ok(Some(status)) => {
            let log = std::fs::read_to_string(&log_path).unwrap_or_default();

            if detect_cache_lock_issue(&log) {
                emit_warn!(
                    Core,
                    CORE_CACHE_LOCKED,
                    "Detected cache.db lock issue, removing and retrying..."
                );
                let cache_path = core_dir.join("cache.db");
                let _ = std::fs::remove_file(&cache_path);

                let (mut retry_cmd, retry_log_path) = spawn_cmd("retry");
                attach_log_file(&mut retry_cmd, &retry_log_path);

                match retry_cmd.spawn() {
                    Ok(mut retry_child) => {
                        // Only a retry that actually started has a log worth showing;
                        // otherwise the first attempt's log (with the lock error) stays.
                        *attempted_log = Some(retry_log_path.clone());
                        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                        match retry_child.try_wait() {
                            Ok(None) => {
                                child = retry_child;
                                actual_log_path = retry_log_path;
                            }
                            Ok(Some(retry_status)) => {
                                let retry_log =
                                    std::fs::read_to_string(&retry_log_path).unwrap_or_default();
                                return Err(format!(
                                    "mihomo retry also failed: {retry_status:?}, log: {retry_log}"
                                ));
                            }
                            Err(e) => {
                                return Err(format!("retry try_wait error: {e}"));
                            }
                        }
                    }
                    Err(e) => {
                        return Err(format!("Failed to spawn mihomo on retry: {e}"));
                    }
                }
            } else {
                return Err(format!("mihomo exited immediately: {status:?}, log: {log}"));
            }
        }
        Ok(None) => {}
        Err(e) => {
            return Err(format!("try_wait error: {e}"));
        }
    }

    Ok((child, actual_log_path))
}

/// HTTP status of `GET /version` sent with `token` as the bearer secret.
async fn version_status(port: u16, token: &str) -> Option<u16> {
    let mut stream = TcpStream::connect(format!("127.0.0.1:{port}")).await.ok()?;
    let request = format!(
        "GET /version HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {token}\r\nConnection: close\r\n\r\n"
    );
    stream.write_all(request.as_bytes()).await.ok()?;
    let mut response = [0u8; 256];
    let n = stream.read(&mut response).await.ok()?;
    let head = String::from_utf8_lossy(response.get(..n).unwrap_or(&[]));
    let rest = head
        .strip_prefix("HTTP/1.1 ")
        .or_else(|| head.strip_prefix("HTTP/1.0 "))?;
    rest.get(..3)?.parse().ok()
}

/// A single authenticated `GET /version` probe, without the retry loop.
///
/// [`authenticated_health_check`] is a one-shot-after-start check: it retries with
/// backoff so it can wait out a slow boot. That is wrong inside a polling loop
/// that is already retrying, because each call would then consume the whole
/// budget on its own.
pub(crate) async fn authenticated_health_check_once(
    port: u16,
    secret: &str,
    timeout: std::time::Duration,
) -> bool {
    let attempt = async {
        if version_status(port, secret).await? != 200 {
            return None;
        }
        // A controller without a secret (another client's core on the same
        // port) accepts any token, ours included. Only one that rejects a wrong
        // token is enforcing our secret.
        if !secret.is_empty() && version_status(port, &format!("{secret}-x")).await? != 401 {
            return None;
        }
        Some(())
    };

    tokio::time::timeout(timeout, attempt)
        .await
        .ok()
        .flatten()
        .is_some()
}

/// Perform an authenticated HTTP health check against the mihomo API.
///
/// Sends `GET /version` with `Authorization: Bearer <secret>` and accepts only HTTP 200.
/// Returns `Ok(())` if the core responds with 200 OK within the retry limit.
///
/// The secret is what makes this probe trustworthy: an unauthenticated probe
/// cannot tell our own core apart from whatever else happens to be listening on
/// the port, so a spawn whose child failed to bind would be reported as a
/// successful start.
async fn authenticated_health_check(port: u16, secret: &str) -> Result<(), String> {
    let mut interval = std::time::Duration::from_millis(HEALTH_CHECK_INITIAL_INTERVAL_MS);
    let max_interval = std::time::Duration::from_millis(HEALTH_CHECK_MAX_INTERVAL_MS);

    for _ in 0..HEALTH_CHECK_MAX_RETRIES {
        if authenticated_health_check_once(port, secret, std::time::Duration::from_millis(500))
            .await
        {
            return Ok(());
        }
        tokio::time::sleep(interval).await;
        interval = (interval * 2).min(max_interval);
    }

    Err(
        "Core started but authenticated health check failed. Check the logs for details."
            .to_owned(),
    )
}

/// Notify the network coordinator that a fresh core instance was started.
/// The new process has no rules applied, so the coordinator's `applied_state`
/// is now stale and must be re-evaluated.
///
/// `Manual` is the only reason that clears `applied_state` — it must not be
/// silently dropped by a full channel. Bound the wait with a 5s timeout so
/// a stalled coordinator actor cannot block core startup.
async fn notify_core_started(app: &AppHandle) {
    if let Some(coordinator) =
        app.try_state::<crate::network_coordinator::NetworkCoordinatorHandle>()
    {
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            coordinator.notify(crate::network_coordinator::NetworkChangeReason::Manual),
        )
        .await;
        if !matches!(result, Ok(Ok(()))) {
            // The Manual event was dropped (timeout or closed channel) —
            // invalidate applied_state directly and reset the retry counters
            // so the next polling tick is not suppressed by the
            // MAX_CONSECUTIVE_FAILURES cap.
            coordinator.invalidate_applied_state();
            coordinator.reset_retry_counters();
            emit_warn!(
                System,
                SYS_NETWORK_COORDINATOR_ERROR,
                "Network coordinator Manual notify failed (timeout or channel closed) — \
                 applied_state invalidated; will reconcile on next poll"
            );
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn store_child_in_core_state(
    state: &MihomoState,
    child: std::process::Child,
    resolved_secret: String,
    active_config_name: Option<String>,
    safe_custom_args: Vec<String>,
    port: u16,
    proxy_endpoint: Option<ProxyEndpoint>,
    log_path: &std::path::Path,
    started_at: std::time::Instant,
) -> Result<(), (std::process::Child, String)> {
    let mut lock = match lock_critical(&state.0, BackendModule::Core, codes::CORE_LOCK_FAILED) {
        Ok(guard) => guard,
        Err(e) => return Err((child, e)),
    };
    lock.set_process(Some(child));
    lock.set_last_secret(resolved_secret);
    lock.set_last_config_path(active_config_name);
    lock.set_last_custom_args(Some(safe_custom_args));
    lock.set_last_port(Some(port));
    // `None` means the active configuration exposes no managed proxy endpoint;
    // storing an unmanaged default would point the OS proxy at a dead port.
    lock.set_last_proxy_endpoint(proxy_endpoint);
    lock.set_last_log_path(Some(log_path.to_string_lossy().into_owned()));
    lock.set_started_at(Some(started_at));
    drop(lock);
    Ok(())
}

/// Point `read_core_log` at the log of a start that failed, so the error card's
/// log view shows that run instead of an older one (or nothing at all).
fn remember_failed_log(state: &MihomoState, log_path: Option<&Path>) {
    let Some(path) = log_path else { return };
    if let Ok(mut lock) = state.0.lock() {
        lock.set_last_log_path(Some(path.to_string_lossy().into_owned()));
    }
}

/// Whether the running core already runs what a start with `requested` would: the same
/// profile, or the built-in minimal config while there is still no profile to run.
fn runs_requested_config(running: Option<&str>, requested: &str, requested_missing: bool) -> bool {
    // A requested profile that is gone (deleted while its core ran) is never reused:
    // a fresh start would pick another profile or the minimal config instead.
    if requested_missing {
        return running.is_none();
    }
    running == Some(requested)
}

pub async fn start_core_inner(
    app: AppHandle,
    state: State<'_, MihomoState>,
    config_path: String,
    custom_args: Vec<String>,
    secret: Option<String>,
    force: Option<bool>,
) -> Result<CoreStartResult, String> {
    Box::pin(start_core_with(
        app,
        state,
        config_path,
        custom_args,
        secret,
        force,
        None,
    ))
    .await
}

/// The error [`start_core_with`] returns when the core it was meant to replace
/// was already replaced by another start.
pub const CORE_START_SUPERSEDED: &str = "core already restarted by another start";

/// Like [`start_core_inner`]. With `expect_started_at`, the start only goes
/// ahead when, once it holds the start lock, the running core is still the
/// instance that started at that time; otherwise it returns
/// [`CORE_START_SUPERSEDED`] and leaves the newer core alone (a restart of the
/// same profile keeps the port and config, but not the start time). A core
/// with no start time stopped or exited meanwhile: the start goes ahead.
#[allow(clippy::cognitive_complexity)]
pub async fn start_core_with(
    app: AppHandle,
    state: State<'_, MihomoState>,
    config_path: String,
    custom_args: Vec<String>,
    secret: Option<String>,
    force: Option<bool>,
    expect_started_at: Option<Option<std::time::Instant>>,
) -> Result<CoreStartResult, String> {
    // Wait for any previous core start operation to complete (max 10s)
    let mut wait_ms = 0;
    while CORE_STARTING
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        if wait_ms > 10000 {
            // A guarded restart (resume recovery) only stands in for a core
            // nobody else is starting: one still starting after 10 s (a
            // macOS TUN start waiting for authorization) supersedes it, and
            // taking the lock from it would run two starts at once.
            if expect_started_at.is_some() {
                return Err(CORE_START_SUPERSEDED.to_owned());
            }
            emit_warn!(
                Core,
                CORE_START_FAILED,
                "Core start lock timeout, forcing reset"
            );
            CORE_STARTING.store(false, Ordering::SeqCst);
            if CORE_STARTING
                .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                .is_ok()
            {
                break;
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        wait_ms += 200;
    }

    // Reset flag on function exit
    struct ResetGuard;
    impl Drop for ResetGuard {
        fn drop(&mut self) {
            CORE_STARTING.store(false, Ordering::SeqCst);
        }
    }
    let _guard = ResetGuard;

    if let Some(expected) = expect_started_at {
        let current = state
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .started_at();
        // Only a different start time is another start; none means the
        // core stopped or exited meanwhile and still needs this one.
        if current.is_some() && current != expected {
            return Err(CORE_START_SUPERSEDED.to_owned());
        }
    }

    // Reuse checks compare against the profile this start would actually run: a missing
    // request falls back to another profile. With no profile at all the core runs the
    // built-in minimal config (`last_config_path` stays None), and a repeated start must
    // still reuse it.
    let resolved_profile = resolve_app_paths(&app)
        .ok()
        .and_then(|paths| resolve_profile_path(&paths, &config_path).ok());
    let requested_missing = resolved_profile
        .as_ref()
        .is_some_and(|(_, path)| !path.exists());
    let requested_name = resolved_profile
        .as_ref()
        .map_or_else(|| config_path.clone(), |(name, _)| name.clone());

    #[cfg(target_os = "macos")]
    struct RunConfigRestoreGuard {
        run_config_path: PathBuf,
        prev_content: Option<Vec<u8>>,
        active: bool,
    }

    #[cfg(target_os = "macos")]
    impl RunConfigRestoreGuard {
        fn new(run_config_path: PathBuf, prev_content: Option<Vec<u8>>) -> Self {
            Self {
                run_config_path,
                prev_content,
                active: true,
            }
        }

        fn disarm(&mut self) {
            self.active = false;
        }

        fn disable_tun_in_prev_content(&mut self) {
            if let Some(prev) = &self.prev_content {
                if let Ok(prev_str) = std::str::from_utf8(prev) {
                    if let Ok(disabled) =
                        zephyr_core::config::tun::update_tun_in_yaml(prev_str, false)
                    {
                        self.prev_content = Some(disabled.into_bytes());
                    }
                }
            }
        }
    }

    #[cfg(target_os = "macos")]
    impl Drop for RunConfigRestoreGuard {
        fn drop(&mut self) {
            if self.active {
                if let Some(prev) = &self.prev_content {
                    if let Err(write_err) =
                        write_file_secure(&self.run_config_path, &String::from_utf8_lossy(prev))
                    {
                        emit_warn!(
                            Config,
                            CONFIG_WRITE_FAILED,
                            "Failed to restore previous run config in drop guard: {write_err}"
                        );
                    }
                } else if self.run_config_path.exists() {
                    if let Err(err) = std::fs::remove_file(&self.run_config_path) {
                        emit_warn!(
                            Config,
                            CONFIG_WRITE_FAILED,
                            "Failed to remove newly written run config in drop guard: {err}"
                        );
                    }
                }
            }
        }
    }

    // A macOS root TUN core has no `Child` handle (`record_root_tun_state`
    // clears it), so the same-config shortcut below cannot see it and a
    // repeated start would go through the privileged restart (another
    // administrator prompt). Reuse the recorded root core when it still answers
    // an authenticated probe; otherwise fall through and restart it.
    // Only when TUN is still the recorded preference: a start after TUN was
    // turned off must reach the cleanup path below instead.
    #[cfg(target_os = "macos")]
    if !force.unwrap_or(false)
        && super::tun_manager::is_tun_mode()
        && app
            .state::<crate::SettingsState>()
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .tun_enabled
            == Some(true)
    {
        let recorded = {
            let lock = lock_critical(&state.0, BackendModule::Core, codes::CORE_LOCK_FAILED)?;
            let same_root_core = lock.process().is_none()
                && lock.started_at().is_some()
                && runs_requested_config(
                    lock.last_config_path(),
                    &requested_name,
                    requested_missing,
                );
            let info = if same_root_core {
                lock.last_port().map(|port| {
                    (
                        port,
                        lock.last_secret().to_owned(),
                        lock.last_config_path().map(std::borrow::ToOwned::to_owned),
                    )
                })
            } else {
                None
            };
            drop(lock);
            info
        };
        if let Some((port, recorded_secret, active_config)) = recorded {
            if authenticated_health_check_once(
                port,
                &recorded_secret,
                std::time::Duration::from_secs(2),
            )
            .await
            {
                return Ok(CoreStartResult {
                    secret: recorded_secret,
                    port,
                    active_config,
                });
            }
        }
    }

    // Check if core is already running with the SAME config (under CORE_STARTING protection).
    // If the requested config differs from the current one, we must restart to apply it.
    // Also extract port/secret for drain before killing.
    let drain_info: Option<(u16, String)> = {
        let mut lock = lock_critical(&state.0, BackendModule::Core, codes::CORE_LOCK_FAILED)?;
        if lock.process().is_some() {
            // Check if the process is actually still alive before deciding what to do.
            // If mihomo crashed, the Child handle still exists but the process
            // is dead — we must restart instead of returning stale info or draining.
            let alive = lock
                .process_mut()
                .is_some_and(|p| matches!(p.try_wait(), Ok(None)));

            if !alive {
                // Process is dead — skip drain (no point draining a dead port)
                None
            } else {
                let same_config = runs_requested_config(
                    lock.last_config_path(),
                    &requested_name,
                    requested_missing,
                );
                if same_config && !force.unwrap_or(false) {
                    if let Some(port) = lock.last_port() {
                        let active = lock.last_config_path().map(std::borrow::ToOwned::to_owned);
                        return Ok(CoreStartResult {
                            secret: lock.last_secret().to_owned(),
                            port,
                            active_config: active,
                        });
                    }
                    None
                } else {
                    // Core is running with a different config (or force restart) — prepare drain info
                    lock.last_port()
                        .map(|port| (port, lock.last_secret().to_owned()))
                }
            }
        } else {
            None
        }
    };

    // Drain existing connections before killing to help mihomo exit faster
    if let Some((port, secret)) = drain_info {
        drain_connections_if_alive(port, &secret).await;
    }

    // In macOS TUN mode, the running mihomo is root-owned and cannot be killed by
    // non-root kill_mihomo, and holds the port until restart_core_as_root runs.
    // Skipping unprivileged kill avoids a 7-second dead delay on TUN restart.
    #[cfg(target_os = "macos")]
    let tun_active = {
        // `SettingsState` is managed during setup, before any core start. The
        // profile is consulted only when no TUN preference was ever recorded.
        let tun_pref = app
            .state::<crate::SettingsState>()
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .tun_enabled;
        let tun_enabled = match tun_pref {
            Some(enabled) => enabled,
            None => read_start_profile(&app, &config_path)
                .map(|c| zephyr_core::config::tun::extract_tun_enabled_from_yaml(&c))
                .unwrap_or(false),
        };
        if !tun_enabled {
            // Prefer the recorded root-core executable (survives binary
            // replacement/removal), falling back to the current managed path.
            let managed_exe = managed_core_exe_path(&app);
            // Detect a surviving app-owned root core (the configured managed
            // executable or a legacy managed `mihomo`) independently of the
            // process-local flag: a stale core on a custom port would otherwise
            // keep the configured port busy.
            //
            // A *confirmed* match (executable path) is unambiguously ours. The
            // predicate also counts legacy candidates, whose working directory
            // cannot be read without privileges, so an unrelated root mihomo
            // started with the same `-d . -f run_config.yaml` shape can trigger
            // one privileged attempt here. That attempt never kills it — the
            // script re-verifies the working directory as root and skips it —
            // and its outcome no longer fails the caller; keeping the candidate
            // in the trigger is what lets cores launched by older app versions
            // (reported by `ps comm` as a bare `mihomo`, unmatched by path) be
            // cleaned up instead of holding the ports forever.
            // The ps scan is blocking, so it runs on a blocking task.
            let exe_for_scan = managed_exe.clone();
            let managed_alive = tokio::task::spawn_blocking(move || {
                has_managed_root_mihomo(exe_for_scan.as_deref())
            })
            .await
            .unwrap_or(false);

            let should_clean_root = is_tun_mode() || managed_alive;

            if should_clean_root {
                if managed_alive {
                    // Kill only the managed PIDs via the privileged helper;
                    // never a broad killall by name. The verified variant
                    // confirms the process is gone, so the TUN flag is only
                    // cleared when cleanup actually succeeded.
                    let kill_res = tokio::task::spawn_blocking(move || {
                        kill_managed_root_mihomo_as_root_verified(managed_exe.as_deref())
                    })
                    .await;
                    match kill_res {
                        Ok(Ok(())) => set_tun_mode(false),
                        Ok(Err(e)) => {
                            emit_warn!(Core, CORE_STOP_FAILED, "Root mihomo cleanup failed: {e}");
                            return Err(format!(
                                "Cannot start core: root mihomo cleanup failed: {e}"
                            ));
                        }
                        Err(e) => return Err(format!("Root TUN cleanup task failed: {e}")),
                    }
                } else {
                    set_tun_mode(false);
                }
            } else if is_tun_mode() {
                set_tun_mode(false);
            }
            false
        } else {
            tun_enabled
        }
    };
    #[cfg(not(target_os = "macos"))]
    let tun_active = false;

    if !tun_active {
        // Kill any existing mihomo processes before starting a new one
        // Use spawn_blocking to avoid blocking the tokio runtime (kill_mihomo sleeps 300ms)
        tokio::task::spawn_blocking(kill_mihomo)
            .await
            .map_err(|e| format!("Kill task failed: {e}"))?;
    }
    // TUN-active starts deliberately keep any tracked child (and user-owned
    // orphans) alive at this point: the privileged restart script terminates
    // every mihomo process itself once the user authorizes it. Cleaning up
    // before authorization would leave the app without any core when the user
    // cancels, so the tracked child is reaped only after the script has run.

    let paths = ensure_app_storage(&app)?;

    // Note: We no longer delete cache.db proactively
    // cache.db contains DNS cache and other useful data
    // If mihomo fails to start due to lock issues, we'll retry after removing it
    // This is handled in the spawn error handling below

    // Wait for port to be truly free (max 5s)
    #[cfg(target_os = "macos")]
    if !tun_active {
        wait_for_port_free(DEFAULT_API_PORT).await;
    }

    let exe_path = get_core_exe_path(&app)?;

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    ensure_executable(&exe_path)?;

    let (resolved_config_name, resolved_config_path) = resolve_profile_path(&paths, &config_path)?;

    let safe_custom_args = validate_custom_args(&custom_args)?;

    if !tun_active {
        let app_clone = app.clone();
        tokio::task::spawn_blocking(move || {
            let state = app_clone.state::<MihomoState>();
            stop_core_inner(&app_clone, &state)
        })
        .await
        .map_err(|e| format!("Failed to stop core: {e}"))??;
        // The old core is stopped: forget the previous run's log, so this run's failure shows
        // its own log (a failed preflight below writes one) instead of an older run's. With TUN
        // active the root core keeps running, so its log stays the one to show.
        if let Ok(mut lock) = state.0.lock() {
            lock.set_last_log_path(None);
        }
    }

    // When tun_active is true, stop_core_inner is skipped to preserve the root
    // TUN daemon across preflight. Any tracked unprivileged child is likewise
    // left running until root authorization succeeds: the privileged script
    // terminates it, and the deferred reap below releases it.

    let resolved_secret = secret.unwrap_or_else(generate_secret);

    // Read global user preferences from settings.json to override YAML profile values
    let global_prefs = {
        let settings_state = app.state::<crate::SettingsState>();
        let settings = settings_state
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        Some(settings.to_global_prefs())
    };

    let (active_config_name, final_config, config_port, proxy_port) = select_runtime_config(
        &paths,
        &resolved_config_name,
        &resolved_config_path,
        &resolved_secret,
        global_prefs.as_ref(),
    )?;

    let run_config_path = paths.core_dir.join("run_config.yaml");
    #[cfg(target_os = "macos")]
    let prev_run_config = match std::fs::read(&run_config_path) {
        Ok(bytes) => Some(bytes),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => {
            return Err(format!("Failed to backup existing run_config.yaml: {e}"));
        }
    };
    #[cfg(target_os = "macos")]
    let mut run_config_guard = RunConfigRestoreGuard::new(run_config_path.clone(), prev_run_config);
    write_file_secure(&run_config_path, &final_config)?;

    // Preflight: validate config with `mihomo -t` before spawning the process.
    // This catches syntax errors, missing proxy references, etc. early and prevents
    // the core from entering a crash-restart loop due to an invalid config.
    {
        let exe_path_clone = exe_path.clone();
        let core_dir_clone = paths.core_dir.clone();
        let safe_custom_args_clone = safe_custom_args.clone();
        let preflight_res = tokio::task::spawn_blocking(move || {
            let mut cmd = Command::new(&exe_path_clone);
            #[cfg(target_os = "windows")]
            use std::os::windows::process::CommandExt as _;
            #[cfg(target_os = "windows")]
            cmd.creation_flags(CREATE_NO_WINDOW);
            cmd.current_dir(&core_dir_clone);
            cmd.args(["-d", "."]);
            cmd.args(["-t", "-f", "run_config.yaml"]);
            for arg in &safe_custom_args_clone {
                cmd.arg(arg);
            }
            cmd.output()
        })
        .await;

        let output = match preflight_res {
            Ok(Ok(out)) => out,
            Ok(Err(e)) => {
                return Err(format!("Preflight check failed to execute: {e}"));
            }
            Err(e) => {
                return Err(format!("Preflight check task panicked: {e}"));
            }
        };

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let raw_err = if stderr.trim().is_empty() {
                String::from_utf8_lossy(&output.stdout)
            } else {
                stderr
            };
            let mut err_msg = redact_error_message(raw_err.trim());
            if err_msg.is_empty() {
                err_msg = format!("Process exited with status: {}", output.status);
            }
            // Keep the check's output where the error card's "View log" reads it.
            let preflight_log = paths.core_dir.join("preflight.log");
            let preflight_text = format!(
                "{}\n{}",
                redact_error_message(String::from_utf8_lossy(&output.stdout).trim()),
                redact_error_message(String::from_utf8_lossy(&output.stderr).trim())
            );
            // With TUN active the old root core keeps running, so its log stays
            // the one `read_core_log` shows; the check's output is still on disk.
            match write_file_secure(&preflight_log, preflight_text.trim()) {
                Ok(()) if !tun_active => remember_failed_log(&state, Some(&preflight_log)),
                Ok(()) => {}
                Err(werr) => emit_warn!(
                    Core,
                    CORE_START_FAILED,
                    "Failed to write preflight.log: {werr}"
                ),
            }
            emit_error!(
                Config,
                CONFIG_PARSE_FAILED,
                "Config preflight failed: {err_msg}"
            );
            return Err(format!(
                "Config preflight check failed. The config file has errors and the core will not be started. Details: {err_msg}"
            ));
        }
    }

    // Debug: show mihomo processes before spawn
    #[cfg(target_os = "macos")]
    {
        let ps = std::process::Command::new("sh")
            .args(["-c", "ps aux | grep mihomo | grep -v grep"])
            .output()
            .ok();
        if let Some(o) = ps {
            emit_info!(
                Core,
                CORE_START_FAILED,
                "mihomo processes before spawn:\n{}",
                String::from_utf8_lossy(&o.stdout)
            );
        }
    }

    #[cfg(target_os = "macos")]
    fn record_root_tun_state(
        lock: &mut CoreData,
        secret: String,
        active_config_name: Option<String>,
        port: u16,
        proxy_endpoint: Option<ProxyEndpoint>,
    ) {
        lock.set_process(None);
        lock.set_last_secret(secret);
        lock.set_last_config_path(active_config_name);
        lock.set_last_custom_args(None);
        lock.set_last_port(Some(port));
        lock.set_last_proxy_endpoint(proxy_endpoint);
        lock.set_last_log_path(Some(get_tun_log_path()));
        lock.set_started_at(Some(std::time::Instant::now()));
    }

    /// Adopt a surviving root mihomo as this app's TUN core after a privileged
    /// cleanup could not stop it.
    ///
    /// Both callers are about to return an error, so this function has to do
    /// everything the caller therefore will not: record the root core
    /// executable, record `tun_enabled` (macOS startup reads that flag to choose
    /// the TUN path, so leaving it stale would start the next launch on the
    /// non-TUN path while a root TUN core holds the ports), reap the tracked
    /// child the script already terminated, and point `MihomoState` at the
    /// process that is actually running so a later stop performs the privileged
    /// cleanup.
    ///
    /// Recording the executable matters for the same reason: this app is
    /// tracking a live root core, so every later cleanup path (`stop_core`,
    /// `disable_tun`, app exit) needs to know which binary that is. Falling back
    /// to `get_core_exe_path` there fails, or names a different file, once the
    /// managed binary has been replaced or removed — and then the root core
    /// survives the cleanup it was supposed to get.
    #[cfg(target_os = "macos")]
    async fn adopt_surviving_root_tun_core(
        app: &AppHandle,
        state: &MihomoState,
        secret: &str,
        active_config_name: &Option<String>,
        config_port: u16,
        proxy_endpoint: Option<ProxyEndpoint>,
    ) {
        record_running_root_core_exe(app);
        set_tun_mode(true);
        if let Err(err) = super::tun_manager::sync_tun_settings(app, true) {
            emit_warn!(
                Config,
                CONFIG_PERSIST_FAILED,
                "Failed to record tun_enabled after adopting root TUN core: {err}"
            );
        }
        // The script already terminated any tracked child; reap it before
        // replacing the tracked state so it does not linger as a zombie.
        reap_tracked_child(app).await;
        if let Ok(mut lock) = lock_critical(&state.0, BackendModule::Core, codes::CORE_LOCK_FAILED)
        {
            record_root_tun_state(
                &mut lock,
                secret.to_owned(),
                active_config_name.clone(),
                config_port,
                proxy_endpoint,
            );
        }
    }

    /// Remember which binary the root core we are tracking actually runs.
    ///
    /// `restart_core_as_root` records this on its success path only, but this app can
    /// end up tracking a live root core it did *not* start successfully (a surviving
    /// core, or one adopted after a failed cleanup). Without recording it here,
    /// [`last_root_core_exe`] stays `None` or points at an earlier start's binary,
    /// and later cleanup (`stop_core`, `disable_tun`, app exit) has to guess via
    /// `get_core_exe_path` — which fails, or names a different file, once the managed
    /// binary has been replaced or removed while this root core is still running.
    ///
    /// Every caller runs right after the privileged script launched
    /// `get_core_exe_path`, so that path is the live core's binary and always
    /// replaces whatever an earlier start recorded.
    #[cfg(target_os = "macos")]
    fn record_running_root_core_exe(app: &AppHandle) {
        if let Ok(path) = get_core_exe_path(app) {
            super::tun_manager::record_root_core_exe(&path);
        }
    }

    /// Error text for a caller that failed while a root TUN core is still
    /// running. The caller treats the error as "nothing is running", so the
    /// message has to say otherwise. It deliberately carries no
    /// `TUN_START_FAILED_MARKER`: the adopted core is running and tracked, and
    /// the launch flow's retry without TUN would turn TUN off and kill it.
    #[cfg(target_os = "macos")]
    fn adopted_root_tun_core_error(err: &dyn std::fmt::Display) -> String {
        format!(
            "{err} (a root TUN core is still running and is now tracked; \
             stopping the core will clean it up)"
        )
    }

    /// Error text for a failed root TUN start, prefixed with
    /// [`TUN_START_FAILED_MARKER`](super::tun_manager::TUN_START_FAILED_MARKER)
    /// so the launch flow retries without TUN only for this failure.
    #[cfg(target_os = "macos")]
    fn tun_start_error(err: &dyn std::fmt::Display) -> String {
        format!("{}: {err}", super::tun_manager::TUN_START_FAILED_MARKER)
    }

    /// Reap the tracked child (if any) without holding the state lock across the
    /// blocking wait. Used on the TUN start path once the privileged script has
    /// terminated every mihomo process, including the tracked child.
    #[cfg(target_os = "macos")]
    async fn reap_tracked_child(app: &AppHandle) {
        let tracked = {
            let state = app.state::<MihomoState>();
            let mut guard = lock_best_effort(&state.0);
            guard.take_process()
        };
        if let Some(child) = tracked {
            let _ = tokio::task::spawn_blocking(move || terminate_child_process(child)).await;
        }
    }

    #[cfg(target_os = "macos")]
    async fn cleanup_tun_failure_and_persist(
        app: &AppHandle,
        state: &MihomoState,
        run_config_guard: &mut RunConfigRestoreGuard,
    ) {
        run_config_guard.disable_tun_in_prev_content();
        set_tun_mode(false);
        // macOS startup reads this flag to choose the TUN path; recorded even
        // when the settings write fails so the fallback restart is non-TUN
        // (a failed write is already reported as a warning).
        let _ = super::tun_manager::record_tun_disabled(app);
        let tracked = if let Ok(mut lock) =
            lock_critical(&state.0, BackendModule::Core, codes::CORE_LOCK_FAILED)
        {
            // The privileged script already terminated any tracked child; reap it
            // so it does not linger as a zombie before the state is cleared.
            let tracked = lock.take_process();
            clear_stopped_core_state(&mut lock);
            tracked
        } else {
            None
        };
        if let Some(child) = tracked {
            // `terminate_child_process` sends SIGTERM, sleeps up to 500ms and
            // then blocks in `child.wait()`. The privileged script does not
            // always reach its kill step — the PID scan runs before the
            // authorization dialog, and `ScriptRanStartTimeout` can fire
            // before that — so this path is reached with the child still alive,
            // and blocking an async worker for up to half a second would stall
            // every other task on it. Same `spawn_blocking` treatment as
            // `reap_tracked_child`.
            let _ = tokio::task::spawn_blocking(move || terminate_child_process(child)).await;
        }
    }

    // Check if TUN mode is active via flag captured at start of startup
    #[cfg(target_os = "macos")]
    if tun_active {
        let secret = match restart_core_as_root(&app, true).await {
            Ok(s) => s,
            Err(e) => {
                if !e.script_ran() {
                    // Authorization never reached the privileged script, so
                    // nothing was killed: no root core and no tracked child
                    // were touched. Preserve the tracked child (the user's
                    // still-running core) and its state, restore the previous
                    // run config via the guard, and surface the error.
                    return Err(tun_start_error(&e));
                }
                // The script ran and the root core writes to the TUN log, so that is the
                // log of this failed start.
                remember_failed_log(&state, Some(std::path::Path::new(&get_tun_log_path())));
                // Scope the liveness check to this app's managed core, and only
                // to the executable-confirmed set: an unverified legacy
                // candidate may be a foreign root core (another install), and
                // adopting it as the app's TUN core would be wrong.
                // Prefer the recorded root-core executable (survives binary
                // replacement/removal), falling back to the current managed path.
                let managed_exe = managed_core_exe_path(&app);
                let has_root = tokio::task::spawn_blocking(move || {
                    super::tun_manager::has_confirmed_root_mihomo(managed_exe.as_deref())
                })
                .await
                .unwrap_or(false);
                let mut surviving_core_verified = false;
                if has_root
                    && config_port > 0
                    && authenticated_health_check(config_port, &resolved_secret)
                        .await
                        .is_ok()
                {
                    surviving_core_verified = true;
                }
                if surviving_core_verified {
                    // Newly started root core is actually running and responding; disarm guard and sync state.
                    // The script already terminated any tracked child; reap it before
                    // replacing the tracked state.
                    reap_tracked_child(&app).await;
                    run_config_guard.disarm();
                    // This root core is being tracked even though
                    // `restart_core_as_root` reported failure, so remember its
                    // executable here too — later cleanup depends on it.
                    record_running_root_core_exe(&app);
                    set_tun_mode(true);
                    if let Ok(mut lock) =
                        lock_critical(&state.0, BackendModule::Core, codes::CORE_LOCK_FAILED)
                    {
                        record_root_tun_state(
                            &mut lock,
                            resolved_secret.clone(),
                            active_config_name.clone(),
                            config_port,
                            proxy_port,
                        );
                    }
                    notify_core_started(&app).await;
                    let app_reconcile = app.clone();
                    tokio::spawn(async move {
                        let _ = super::subscription::reconcile_global_mode_restore(&app_reconcile)
                            .await;
                    });
                    return Ok(CoreStartResult {
                        secret: resolved_secret,
                        port: config_port,
                        active_config: active_config_name,
                    });
                } else if has_root {
                    // Script ran (old root was killed), so the surviving root uses the new config.
                    // Scope the privileged kill to this app's managed core so an
                    // unrelated root mihomo service is never terminated.
                    // Prefer the recorded root-core executable (survives binary
                    // replacement/removal), falling back to the current managed path.
                    let managed_exe = managed_core_exe_path(&app);
                    let kill_res = tokio::task::spawn_blocking(move || {
                        kill_managed_root_mihomo_as_root_verified(managed_exe.as_deref())
                    })
                    .await;
                    let killed = matches!(&kill_res, Ok(Ok(())));
                    if killed {
                        cleanup_tun_failure_and_persist(&app, &state, &mut run_config_guard).await;
                        return Err(tun_start_error(&e));
                    }
                    run_config_guard.disarm();
                    // The surviving root core is the app's TUN core: adopt it so
                    // a later stop performs the privileged cleanup instead of
                    // deleting run_config while the root core keeps running.
                    adopt_surviving_root_tun_core(
                        &app,
                        &state,
                        &resolved_secret,
                        &active_config_name,
                        config_port,
                        proxy_port,
                    )
                    .await;
                    emit_warn!(
                        Core,
                        CORE_START_FAILED,
                        "Root TUN core adopted after failed restart: {e}"
                    );
                    return Err(adopted_root_tun_core_error(&e));
                } else {
                    cleanup_tun_failure_and_persist(&app, &state, &mut run_config_guard).await;
                }
                return Err(tun_start_error(&e));
            }
        };

        // The privileged script has now terminated every mihomo process,
        // including any tracked unprivileged child. Reap it so its resources
        // are released and `MihomoState` no longer references a dead process.
        reap_tracked_child(&app).await;

        if config_port > 0 {
            if let Err(e) = authenticated_health_check(config_port, &secret).await {
                // Scope the privileged kill to this app's managed core so an
                // unrelated root mihomo service is never terminated.
                // Prefer the recorded root-core executable (survives binary
                // replacement/removal), falling back to the current managed path.
                let managed_exe = managed_core_exe_path(&app);
                let kill_res = tokio::task::spawn_blocking(move || {
                    kill_managed_root_mihomo_as_root_verified(managed_exe.as_deref())
                })
                .await;
                let killed = matches!(&kill_res, Ok(Ok(())));
                if killed {
                    cleanup_tun_failure_and_persist(&app, &state, &mut run_config_guard).await;
                } else {
                    // Privileged cleanup could not stop root mihomo; it remains
                    // running with the new config. Disarm the restore guard so
                    // on-disk run_config.yaml stays in sync with the live core,
                    // then adopt the survivor exactly as the failed-restart
                    // branch above does — otherwise `tun_enabled` would still
                    // describe "no TUN core" while one holds the ports.
                    run_config_guard.disarm();
                    adopt_surviving_root_tun_core(
                        &app,
                        &state,
                        &secret,
                        &active_config_name,
                        config_port,
                        proxy_port,
                    )
                    .await;
                }
                if let Ok(Err(err)) = kill_res {
                    emit_warn!(
                        Core,
                        CORE_STOP_FAILED,
                        "Failed to clean up root mihomo process after health check failure: {err}"
                    );
                }
                emit_error!(
                    Core,
                    CORE_START_FAILED,
                    "Health check failed for root core on port {config_port}: {e}"
                );
                if killed {
                    return Err(tun_start_error(&e));
                }
                return Err(adopted_root_tun_core_error(&e));
            }
        }

        // Record uptime for the TUN start path after health check succeeds (restart_core_as_root spawns
        // mihomo with root privileges, bypassing regular process tracker).
        // Best-effort lock ensures state is recorded without blocking or holding
        // a !Send MutexGuard across any async yield point.
        {
            let mut lock = lock_best_effort(&state.0);
            record_root_tun_state(
                &mut lock,
                secret.clone(),
                active_config_name.clone(),
                config_port,
                proxy_port,
            );
        }
        notify_core_started(&app).await;
        let app_reconcile = app.clone();
        tokio::spawn(async move {
            let _ = super::subscription::reconcile_global_mode_restore(&app_reconcile).await;
        });
        run_config_guard.disarm();
        return Ok(CoreStartResult {
            secret,
            port: config_port,
            active_config: active_config_name,
        });
    }

    // Spawn mihomo (stdout/stderr redirected to log file internally)
    let mut attempted_log = None;
    let spawn_result = spawn_with_cache_retry(
        &exe_path,
        &safe_custom_args,
        &paths.core_dir,
        &paths.app_data_dir,
        &mut attempted_log,
    )
    .await;
    let (child, log_path) = match spawn_result {
        Ok(spawned) => spawned,
        Err(e) => {
            remember_failed_log(&state, attempted_log.as_deref());
            return Err(e);
        }
    };
    let started_at = std::time::Instant::now();

    // Windows: assign child to a Job Object with KILL_ON_JOB_CLOSE so that
    // mihomo is automatically terminated if the Tauri process dies (even from
    // Task Manager). This is the Windows equivalent of Linux PR_SET_PDEATHSIG.
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::io::AsRawHandle as _;
        let handle = child.as_raw_handle();
        if !win_job::assign_to_job(handle as _) {
            emit_warn!(
                Core,
                CORE_START_FAILED,
                "Failed to assign mihomo to Job Object (auto-kill on exit disabled)"
            );
        }
    }

    // Use config port directly, rely on health check to verify
    let port = config_port;

    // HTTP Health Check via raw TCP. Authenticated, so a listener that merely
    // holds the port (a foreign mihomo/clash instance, or a leftover root core)
    // cannot make a failed start look healthy: it would still hold the port the
    // new child needed, which would then surface as API errors against the
    // wrong core.
    if let Err(e) = authenticated_health_check(port, &resolved_secret).await {
        let _ = tokio::task::spawn_blocking(move || terminate_child_process(child)).await;
        remember_failed_log(&state, Some(&log_path));
        return Err(e);
    }

    // Note: MSL was set to 1000ms in root shell during TUN start if applicable.
    // Non-TUN mode does not need low MSL, and changing it requires root anyway.

    if let Err((untracked_child, e)) = store_child_in_core_state(
        &state,
        child,
        resolved_secret.clone(),
        active_config_name.clone(),
        safe_custom_args,
        port,
        proxy_port,
        &log_path,
        started_at,
    ) {
        let _ = tokio::task::spawn_blocking(move || terminate_child_process(untracked_child)).await;
        return Err(e);
    }

    notify_core_started(&app).await;
    let app_reconcile = app.clone();
    tokio::spawn(async move {
        let _ = super::subscription::reconcile_global_mode_restore(&app_reconcile).await;
    });

    #[cfg(target_os = "macos")]
    run_config_guard.disarm();

    Ok(CoreStartResult {
        secret: resolved_secret,
        port,
        active_config: active_config_name,
    })
}

/// Tauri command wrapper for `start_core_inner` with `catch_unwind` guard.
///
/// If the inner function panics, the error is caught and converted to a
/// user-facing error string, preventing the entire app from crashing.
#[tauri::command]
pub async fn start_core(
    app: AppHandle,
    state: State<'_, MihomoState>,
    config_path: String,
    custom_args: Vec<String>,
    secret: Option<String>,
    force: Option<bool>,
) -> Result<CoreStartResult, String> {
    use futures_util::future::FutureExt as _;
    use std::panic::AssertUnwindSafe;

    AssertUnwindSafe(start_core_inner(
        app,
        state,
        config_path,
        custom_args,
        secret,
        force,
    ))
    .catch_unwind()
    .await
    .map_err(|payload| {
        let msg = crate::backend_event::panic_to_string(payload);
        crate::emit_error!(Core, CORE_PANIC_GUARD, "Panic in start_core: {msg}");
        format!("Internal error in start_core: {msg}")
    })
    .and_then(std::convert::identity)
}

/// Clear all state fields that become stale when the core process stops.
/// Called from both `stop_core_inner` and the exited-process branch of
/// `get_core_uptime` to keep the reset logic in one place.
fn clear_stopped_core_state(lock: &mut CoreData) {
    lock.set_started_at(None);
    lock.set_process(None);
    lock.set_last_port(None);
    lock.set_last_proxy_endpoint(None);
}

/// Terminate a spawned child process and its entire process group on Unix,
/// or force kill on non-Unix platforms.
pub(super) fn terminate_child_process(mut child_process: std::process::Child) {
    // Already reaped (e.g. by the liveness `try_wait` in `start_core_inner`):
    // its PID may since have been reused, so it must never be signalled as a
    // process group.
    if matches!(child_process.try_wait(), Ok(Some(_))) {
        return;
    }
    #[cfg(unix)]
    {
        // Kill the entire process group (mihomo + any child processes it spawned).
        // Negative PID signals the process group whose ID equals |pid|.
        #[allow(clippy::cast_possible_wrap)]
        let pid = child_process.id() as libc::pid_t;
        let mut killed_group = false;
        if pid > 1 {
            let pgid = -pid;
            // Safety: libc::kill is a well-defined POSIX syscall. Negative pgid
            // signals the process group, which is standard POSIX behavior.
            if unsafe { libc::kill(pgid, libc::SIGTERM) } == 0 {
                // Wait up to 500ms for the process group to exit gracefully.
                // This ensures ports are released before we return, preventing
                // port binding conflicts on restart.
                for _ in 0..5 {
                    if let Ok(Some(_)) = child_process.try_wait() {
                        // Safety: signal 0 performs error checking without sending a signal,
                        // used here to check if all processes in the process group have exited.
                        if unsafe { libc::kill(pgid, 0) } != 0 {
                            killed_group = true;
                            break;
                        }
                    }
                    std::thread::sleep(std::time::Duration::from_millis(100));
                }
                if !killed_group {
                    // Safety: same as above — force-kill the process group.
                    let _ = unsafe { libc::kill(pgid, libc::SIGKILL) };
                    let _ = child_process.wait();
                    killed_group = true;
                }
            }
        }
        // Fallback: if process group kill failed or pid <= 1, kill the child directly
        if !killed_group {
            let _ = child_process.kill();
            let _ = child_process.wait();
        }
    }
    #[cfg(not(unix))]
    {
        // Force kill the process (cross-platform safe)
        let _ = child_process.kill();
        let _ = child_process.wait();
    }
}

/// Internal: stop the core process (no rate limiter reset).
pub fn stop_core_inner(app: &AppHandle, state: &MihomoState) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let root_kill_err = {
        let mut err = None;
        if super::tun_manager::is_tun_mode() {
            // Scope the privileged cleanup to this app's managed core: an
            // unrelated root mihomo service must never be terminated, and it
            // must not keep the app's own cleanup state alive either.
            // Prefer the executable recorded when the root core was started:
            // the managed binary may have been replaced or removed while it runs.
            let managed_exe = managed_core_exe_path(app);
            if super::tun_manager::has_managed_root_mihomo(managed_exe.as_deref()) {
                if let Err(e) = super::tun_manager::kill_managed_root_mihomo_as_root_verified(
                    managed_exe.as_deref(),
                ) {
                    emit_warn!(
                        Core,
                        CORE_STOP_FAILED,
                        "Failed to kill root mihomo process on stop: {e}"
                    );
                    err = Some(format!("Failed to kill root mihomo process on stop: {e}"));
                }
            }
            // The kill itself still covers unverified legacy candidates (the
            // privileged script verifies their working directory as root), but
            // the *decisions* below use the executable-confirmed set only: a
            // foreign root core that matches the legacy argv pattern cannot be
            // told apart without privileges, and it must not keep the app's own
            // cleanup state alive or turn a stop into an error.
            if !super::tun_manager::has_confirmed_root_mihomo(managed_exe.as_deref()) {
                super::tun_manager::set_tun_mode(false);
            }
        }
        err
    };

    #[cfg(target_os = "macos")]
    let still_running_root = super::tun_manager::is_tun_mode() && {
        let managed_exe = managed_core_exe_path(app);
        super::tun_manager::has_confirmed_root_mihomo(managed_exe.as_deref())
    };
    #[cfg(not(target_os = "macos"))]
    let still_running_root = false;

    // Take the child process
    let child = {
        let mut lock = state
            .0
            .lock()
            .map_err(|e| format!("Failed to lock state: {e}"))?;
        let child = lock.take_process();
        if !still_running_root {
            clear_stopped_core_state(&mut lock);
        }
        drop(lock);
        child
    };

    if let Some(child_process) = child {
        terminate_child_process(child_process);
    }

    if !still_running_root {
        cleanup_run_config(app);
    }

    #[cfg(target_os = "macos")]
    if let Some(err) = root_kill_err {
        return Err(err);
    }

    Ok(())
}

fn cleanup_run_config(app: &AppHandle) {
    if let Ok(paths) = resolve_app_paths(app) {
        let run_config_path = paths.core_dir.join("run_config.yaml");
        if run_config_path.exists() {
            if let Err(e) = fs::remove_file(&run_config_path) {
                emit_warn!(
                    Core,
                    CORE_STOP_FAILED,
                    "Failed to remove run_config.yaml: {e}"
                );
            }
        }
    }
}

#[tauri::command]
pub async fn stop_core(app: AppHandle) -> Result<String, String> {
    let app_clone = app.clone();
    tokio::task::spawn_blocking(move || {
        let state = app_clone.state::<MihomoState>();
        stop_core_inner(&app_clone, &state)
    })
    .await
    .map_err(|e| format!("Failed to stop core: {e}"))??;
    Ok("Core stopped and cleaned up".to_owned())
}

/// Returns the number of seconds since mihomo was spawned, or `None` if the
/// core is not running.  Uses the monotonic timestamp recorded at spawn in
/// `CoreData::started_at` (`std::time::Instant`), immune to system clock changes.
#[tauri::command]
pub async fn get_core_uptime(app: AppHandle) -> Result<Option<u64>, String> {
    let state = app.state::<MihomoState>();
    let mut lock = lock_critical(&state.0, BackendModule::Core, codes::CORE_LOCK_FAILED)?;
    // If we have a Child handle, verify liveness via try_wait().
    // Distinguish "process exited" from "try_wait error" — only clear
    // started_at when the process actually exited.
    if let Some(child) = lock.process_mut() {
        match child.try_wait() {
            Ok(None) => { /* alive — proceed */ }
            Ok(Some(_)) => {
                // Process exited — clear started_at, process handle, and stale ports.
                // Without clearing ports, other commands (e.g. update_config) may
                // attempt requests to a stale/reused localhost port.
                clear_stopped_core_state(&mut lock);
                return Ok(None);
            }
            Err(e) => {
                // Could not determine process state — log and trust started_at.
                emit_warn!(
                    Core,
                    CORE_HEALTH_CHECK_FAILED,
                    "Failed to check core process status: {}",
                    e
                );
            }
        }
    }
    // If there's no Child (e.g. macOS TUN mode where mihomo is started as root),
    // we cannot check process liveness via try_wait(). We trust started_at as a
    // best-effort uptime. Known limitation: if the root-spawned process exits
    // unexpectedly, this branch will continue reporting stale uptime until the
    // next start_core/stop_core call clears started_at. The frontend mitigates
    // this by re-syncing uptime every 30 seconds and detecting core stops via
    // traffic WS disconnection and connection API failures.
    match lock.started_at() {
        Some(start) => {
            let elapsed = start.elapsed().as_secs();
            Ok(Some(elapsed))
        }
        None => Ok(None),
    }
}

#[tauri::command]
pub async fn get_core_version(app: AppHandle) -> Result<String, String> {
    let exe_path = get_core_exe_path(&app)?;
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    ensure_executable(&exe_path)?;
    get_core_version_with_io(&RealProcessIo, &exe_path)
}

pub(crate) fn get_core_version_with_io<I: ProcessIo>(
    io: &I,
    exe_path: &Path,
) -> Result<String, String> {
    let output = io.run_command_output(exe_path, "-v")?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(parse_version_output(&stdout))
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing)]
mod tests {
    use super::*;

    #[test]
    fn missing_profile_runs_minimal_config_without_writing_one() {
        let dir = std::env::temp_dir().join(format!("zephyr-no-profile-{}", std::process::id()));
        let profiles_dir = dir.join("profiles");
        fs::create_dir_all(&profiles_dir).unwrap();
        let paths = AppPaths {
            app_data_dir: dir.clone(),
            core_dir: dir.join("core"),
            profiles_dir,
        };
        let (name, path) = resolve_profile_path(&paths, "config.yaml").unwrap();
        assert_eq!(name, "config.yaml");
        assert!(!path.exists());
        let (active, _, _, _) = select_runtime_config(&paths, &name, &path, "s", None).unwrap();
        assert!(active.is_none());
        assert!(!path.exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_core_binary_name() {
        let name = core_binary_name();
        #[cfg(target_os = "windows")]
        assert_eq!(name, "zephyr-mihomo.exe");
        #[cfg(not(target_os = "windows"))]
        assert_eq!(name, "zephyr-mihomo");
    }

    #[test]
    fn running_minimal_config_counts_as_requested_while_no_profile_exists() {
        assert!(runs_requested_config(None, "config.yaml", true));
        assert!(!runs_requested_config(None, "config.yaml", false));
        assert!(runs_requested_config(Some("a.yaml"), "a.yaml", false));
        assert!(!runs_requested_config(Some("a.yaml"), "b.yaml", false));
        assert!(!runs_requested_config(Some("a.yaml"), "a.yaml", true));
    }

    #[test]
    fn minimal_config_takes_global_preferences() {
        let prefs = GlobalPreferences {
            mode: Some("global".to_owned()),
            mixed_port: Some(7892),
            ..Default::default()
        };
        let (config, _, _) = build_minimal_runtime_config_with_prefs("s", Some(&prefs));
        assert!(config.contains("MATCH,DIRECT"));
        assert!(config.contains("mode: global"));
        assert!(config.contains("mixed-port: 7892"));
    }

    #[test]
    fn prepare_runtime_config_injects_secret_and_controller() {
        let config = "external-controller: 0.0.0.0:7897\nsecret: old\nmode: rule\n";
        let (prepared, api_port, proxy_port) =
            prepare_runtime_config(config, "new-secret", None).unwrap();

        assert_eq!(api_port, 7897);
        assert_eq!(proxy_port, None);
        assert!(prepared.contains("external-controller: 127.0.0.1:7897"));
        assert!(prepared.contains("secret: new-secret"));
        assert!(!prepared.contains("secret: old"));
    }

    #[test]
    fn validate_custom_args_rejects_blocked_flags() {
        let args = validate_custom_args(&["--external-controller=0.0.0.0:9090".to_owned()]);
        assert!(args.is_err());

        let args2 = validate_custom_args(&["-d".to_owned(), ".".to_owned()]);
        assert!(args2.is_err());
    }

    #[test]
    fn validate_custom_args_keeps_allowed_flags() {
        let args = validate_custom_args(&["  -t  ".to_owned(), "--version".to_owned()]).unwrap();
        assert_eq!(args, vec!["-t".to_owned(), "--version".to_owned()]);
    }

    // ── prepare_runtime_config extended tests ─────────────────────────────

    #[test]
    fn test_prepare_runtime_config_basic() {
        let content = "port: 7890\nmode: rule";
        let result = prepare_runtime_config(content, "mysecret", None);
        assert!(result.is_some());
        let (config, port, proxy_port) = result.unwrap();
        assert_eq!(port, 9090);
        assert_eq!(
            proxy_port,
            Some(ProxyEndpoint {
                port: 7890,
                scheme: ProxyScheme::Http
            })
        );
        assert!(config.contains("external-controller: 127.0.0.1:9090"));
        assert!(config.contains("secret: mysecret"));
        assert!(config.contains("unified-delay: true"));
        assert!(config.contains("tcp-concurrent: true"));
        assert!(config.contains("keep-alive-interval: 30"));
        assert!(config.contains("keep-alive-idle: 600"));
        assert!(config.contains("store-fake-ip: true"));
        assert!(config.contains("find-process-mode: always"));
    }

    #[test]
    fn test_prepare_runtime_config_custom_port() {
        let content = "external-controller: 0.0.0.0:8080\nport: 7890";
        let result = prepare_runtime_config(content, "secret", None);
        assert!(result.is_some());
        let (config, port, proxy_port) = result.unwrap();
        assert_eq!(port, 8080);
        assert_eq!(
            proxy_port,
            Some(ProxyEndpoint {
                port: 7890,
                scheme: ProxyScheme::Http
            })
        );
        assert!(config.contains("external-controller: 127.0.0.1:8080"));
    }

    #[test]
    fn test_prepare_runtime_config_preserves_unified_delay() {
        let content = "unified-delay: false\nport: 7890";
        let result = prepare_runtime_config(content, "s", None);
        assert!(result.is_some());
        let (config, _, _) = result.unwrap();
        assert!(config.contains("unified-delay: false"));
        assert_eq!(config.matches("unified-delay").count(), 1);
    }

    #[test]
    fn test_prepare_runtime_config_preserves_tcp_concurrent() {
        let content = "tcp-concurrent: false\nport: 7890";
        let result = prepare_runtime_config(content, "s", None);
        assert!(result.is_some());
        let (config, _, _) = result.unwrap();
        assert!(config.contains("tcp-concurrent: false"));
        assert_eq!(config.matches("tcp-concurrent").count(), 1);
    }

    #[test]
    fn test_prepare_runtime_config_preserves_keep_alive_interval() {
        let content = "keep-alive-interval: 60\nport: 7890";
        let result = prepare_runtime_config(content, "s", None);
        assert!(result.is_some());
        let (config, _, _) = result.unwrap();
        assert!(config.contains("keep-alive-interval: 60"));
        assert_eq!(config.matches("keep-alive-interval").count(), 1);
    }

    #[test]
    fn test_prepare_runtime_config_preserves_find_process_mode() {
        let content = "find-process-mode: off\nport: 7890";
        let result = prepare_runtime_config(content, "s", None);
        assert!(result.is_some());
        let (config, _, _) = result.unwrap();
        assert!(config.contains("find-process-mode: off"));
        assert_eq!(config.matches("find-process-mode").count(), 1);
    }

    #[test]
    fn test_prepare_runtime_config_preserves_keep_alive_idle() {
        let content = "keep-alive-idle: 300\nport: 7890";
        let result = prepare_runtime_config(content, "s", None);
        assert!(result.is_some());
        let (config, _, _) = result.unwrap();
        assert!(config.contains("keep-alive-idle: 300"));
        assert_eq!(config.matches("keep-alive-idle").count(), 1);
    }

    #[test]
    fn test_prepare_runtime_config_preserves_store_fake_ip() {
        let content = "profile:\n  store-fake-ip: false\nport: 7890";
        let result = prepare_runtime_config(content, "s", None);
        assert!(result.is_some());
        let (config, _, _) = result.unwrap();
        assert!(config.contains("store-fake-ip: false"));
        assert_eq!(config.matches("store-fake-ip").count(), 1);
    }

    #[test]
    fn test_prepare_runtime_config_empty_profile_key() {
        // YAML "profile:" with no value parses as Null — should still inject store-fake-ip
        let content = "profile:\nport: 7890";
        let result = prepare_runtime_config(content, "s", None);
        assert!(result.is_some());
        let (config, _, _) = result.unwrap();
        assert!(config.contains("store-fake-ip: true"));
    }

    #[test]
    fn test_prepare_runtime_config_invalid_yaml() {
        assert!(prepare_runtime_config("not: valid: yaml: :", "s", None).is_none());
    }

    #[test]
    fn test_prepare_runtime_config_non_mapping() {
        assert!(prepare_runtime_config("just a string", "s", None).is_none());
    }

    #[test]
    fn test_prepare_runtime_config_empty_secret() {
        let content = "port: 7890";
        let result = prepare_runtime_config(content, "", None);
        assert!(result.is_some());
        let (config, _, _) = result.unwrap();
        assert!(config.contains("secret: "));
    }

    // ── GlobalPreferences injection tests ──────────────────────────────────

    #[test]
    fn test_prefs_mode_override() {
        let content = "mode: rule\nport: 7890";
        let prefs = GlobalPreferences {
            mode: Some("global".to_owned()),
            ..Default::default()
        };
        let (config, _, _) = prepare_runtime_config(content, "s", Some(&prefs)).unwrap();
        assert!(config.contains("mode: global"));
        assert!(!config.contains("mode: rule"));
    }

    #[test]
    fn test_prefs_none_does_not_override() {
        let content = "mode: rule\nport: 7890";
        let prefs = GlobalPreferences::default();
        let (config, _, _) = prepare_runtime_config(content, "s", Some(&prefs)).unwrap();
        assert!(config.contains("mode: rule"));
    }

    #[test]
    fn test_prefs_tun_enabled_inject_into_existing() {
        let content = "tun:\n  enable: false\nport: 7890";
        let prefs = GlobalPreferences {
            tun_enabled: Some(true),
            ..Default::default()
        };
        let (config, _, _) = prepare_runtime_config(content, "s", Some(&prefs)).unwrap();
        assert!(config.contains("enable: true"));
    }

    #[test]
    fn test_prefs_tun_enabled_creates_when_missing() {
        let content = "port: 7890";
        let prefs = GlobalPreferences {
            tun_enabled: Some(true),
            ..Default::default()
        };
        let (config, _, _) = prepare_runtime_config(content, "s", Some(&prefs)).unwrap();
        assert!(config.contains("tun:\n  enable: true"));
    }

    #[test]
    fn test_prefs_mixed_port_override() {
        let content = "mixed-port: 7890\nport: 7891";
        let prefs = GlobalPreferences {
            mixed_port: Some(9090),
            ..Default::default()
        };
        let (config, _, _) = prepare_runtime_config(content, "s", Some(&prefs)).unwrap();
        assert!(config.contains("mixed-port: 9090"));
    }

    #[test]
    fn test_prefs_socks_port_override() {
        let content = "socks-port: 7891";
        let prefs = GlobalPreferences {
            socks_port: Some(1080),
            ..Default::default()
        };
        let (config, _, _) = prepare_runtime_config(content, "s", Some(&prefs)).unwrap();
        assert!(config.contains("socks-port: 1080"));
    }

    #[test]
    fn test_prefs_http_port_override() {
        let content = "port: 7890";
        let prefs = GlobalPreferences {
            http_port: Some(8080),
            ..Default::default()
        };
        let (config, _, _) = prepare_runtime_config(content, "s", Some(&prefs)).unwrap();
        assert!(config.contains("port: 8080"));
    }

    #[test]
    fn test_prefs_ipv6_override() {
        let content = "ipv6: false\nport: 7890";
        let prefs = GlobalPreferences {
            ipv6: Some(true),
            ..Default::default()
        };
        let (config, _, _) = prepare_runtime_config(content, "s", Some(&prefs)).unwrap();
        assert!(config.contains("ipv6: true"));
    }

    #[test]
    fn test_prefs_allow_lan_override() {
        let content = "allow-lan: false\nport: 7890";
        let prefs = GlobalPreferences {
            allow_lan: Some(true),
            ..Default::default()
        };
        let (config, _, _) = prepare_runtime_config(content, "s", Some(&prefs)).unwrap();
        assert!(config.contains("allow-lan: true"));
    }

    #[test]
    fn test_prefs_unified_delay_override() {
        let content = "unified-delay: false\nport: 7890";
        let prefs = GlobalPreferences {
            unified_delay: Some(true),
            ..Default::default()
        };
        let (config, _, _) = prepare_runtime_config(content, "s", Some(&prefs)).unwrap();
        assert!(config.contains("unified-delay: true"));
    }

    #[test]
    fn test_prefs_multiple_overrides() {
        let content = "mode: rule\nipv6: false\nallow-lan: false\nport: 7890";
        let prefs = GlobalPreferences {
            mode: Some("direct".to_owned()),
            ipv6: Some(true),
            allow_lan: Some(true),
            mixed_port: Some(7892),
            ..Default::default()
        };
        let (config, _, _) = prepare_runtime_config(content, "s", Some(&prefs)).unwrap();
        assert!(config.contains("mode: direct"));
        assert!(config.contains("ipv6: true"));
        assert!(config.contains("allow-lan: true"));
        assert!(config.contains("mixed-port: 7892"));
    }

    // ── validate_custom_args extended tests ───────────────────────────────

    #[test]
    fn test_validate_custom_args_empty() {
        assert_eq!(validate_custom_args(&[]).unwrap(), Vec::<String>::new());
    }

    #[test]
    fn test_validate_custom_args_blocked_config() {
        assert!(validate_custom_args(&["-f".to_owned()]).is_err());
        assert!(validate_custom_args(&["--config".to_owned()]).is_err());
        assert!(validate_custom_args(&["--config=xxx".to_owned()]).is_err());
        assert!(validate_custom_args(&["-secret".to_owned()]).is_err());
        assert!(validate_custom_args(&["--secret".to_owned()]).is_err());
        assert!(validate_custom_args(&["-ext-ctl".to_owned()]).is_err());
        assert!(validate_custom_args(&["--external-controller".to_owned()]).is_err());
        assert!(validate_custom_args(&["-d".to_owned()]).is_err());
        assert!(validate_custom_args(&["--directory".to_owned()]).is_err());
    }

    #[test]
    fn test_validate_custom_args_allowed() {
        let args = vec!["-v".to_owned(), "--log-level=debug".to_owned()];
        assert_eq!(validate_custom_args(&args).unwrap(), args);
    }

    #[test]
    fn test_validate_custom_args_trims_and_filters_empty() {
        let args = vec!["  -v  ".to_owned(), "".to_owned(), "   ".to_owned()];
        let result = validate_custom_args(&args).unwrap();
        assert_eq!(result, vec!["-v"]);
    }

    #[test]
    fn test_validate_custom_args_case_insensitive() {
        assert!(validate_custom_args(&["--Config".to_owned()]).is_err());
        assert!(validate_custom_args(&["--SECRET=value".to_owned()]).is_err());
    }

    // ── parse_external_controller_port tests ──────────────────────────────

    #[test]
    fn test_parse_port_with_ip() {
        assert_eq!(
            parse_external_controller_port(
                &serde_yaml::from_str("external-controller: 127.0.0.1:9090").unwrap()
            ),
            9090
        );
    }

    #[test]
    fn test_parse_port_ip_only() {
        assert_eq!(
            parse_external_controller_port(
                &serde_yaml::from_str("external-controller: 0.0.0.0:8080").unwrap()
            ),
            8080
        );
    }

    #[test]
    fn test_parse_port_missing() {
        assert_eq!(
            parse_external_controller_port(&serde_yaml::from_str("port: 7890").unwrap()),
            9090
        );
    }

    #[test]
    fn test_parse_port_not_number() {
        assert_eq!(
            parse_external_controller_port(
                &serde_yaml::from_str("external-controller: invalid").unwrap()
            ),
            9090
        );
    }

    #[test]
    fn test_parse_port_zero() {
        assert_eq!(
            parse_external_controller_port(
                &serde_yaml::from_str("external-controller: 127.0.0.1:0").unwrap()
            ),
            0
        );
    }

    // ── detect_cache_lock_issue tests ─────────────────────────────────────

    #[test]
    fn test_detect_cache_lock_keywords() {
        assert!(detect_cache_lock_issue("database is locked"));
        assert!(detect_cache_lock_issue("error: cache.db corrupted"));
        assert!(detect_cache_lock_issue("unable to open database file"));
        assert!(detect_cache_lock_issue("database disk image is malformed"));
    }

    #[test]
    fn test_detect_cache_lock_negative() {
        assert!(!detect_cache_lock_issue("core started successfully"));
        assert!(!detect_cache_lock_issue("listening on :9090"));
        assert!(!detect_cache_lock_issue(""));
    }

    #[test]
    fn test_detect_cache_lock_case_sensitive() {
        assert!(detect_cache_lock_issue("database is locked"));
        assert!(!detect_cache_lock_issue("Database is locked"));
        assert!(!detect_cache_lock_issue("DATABASE IS LOCKED"));
    }

    #[test]
    fn test_detect_cache_lock_substring() {
        assert!(detect_cache_lock_issue(
            "error: unable to open database file at path"
        ));
    }

    // ── parse_version_output tests ────────────────────────────────────────

    #[test]
    fn test_parse_version_standard() {
        assert_eq!(parse_version_output("mihomo v1.18.0\n"), "v1.18.0");
    }

    #[test]
    fn test_parse_version_no_prefix() {
        assert_eq!(parse_version_output("1.18.0"), "1.18.0");
    }

    #[test]
    fn test_parse_version_with_metadata() {
        assert_eq!(
            parse_version_output("mihomo v1.18.0-alpha.1 2024-01-01"),
            "v1.18.0-alpha.1"
        );
    }

    #[test]
    fn test_parse_version_empty() {
        assert_eq!(parse_version_output(""), "");
    }

    #[test]
    fn test_parse_version_whitespace() {
        assert_eq!(parse_version_output("   v1.0.0   "), "v1.0.0");
    }

    #[test]
    fn test_parse_version_only_v_prefix() {
        assert_eq!(parse_version_output("v"), "v");
    }

    #[test]
    fn test_parse_version_no_space_after() {
        assert_eq!(parse_version_output("v1.2.3"), "v1.2.3");
    }

    #[test]
    fn test_parse_version_multiple_v() {
        assert_eq!(parse_version_output("av1.2.3 b4.5.6"), "v1.2.3");
    }

    // ── ProcessIo unit tests (mocked) ─────────────────────────────────────

    /// Helper to create a fake successful `Output` for testing.
    fn fake_success_output(stdout: &[u8]) -> std::process::Output {
        #[cfg(unix)]
        {
            use std::os::unix::process::ExitStatusExt as _;
            std::process::Output {
                stdout: stdout.to_vec(),
                stderr: Vec::new(),
                status: std::process::ExitStatus::from_raw(0),
            }
        }
        #[cfg(windows)]
        {
            std::process::Output {
                stdout: stdout.to_vec(),
                stderr: Vec::new(),
                status: std::process::ExitStatus::default(),
            }
        }
    }

    #[test]
    fn test_get_core_version_with_io_success() {
        let mut mock = MockProcessIo::new();
        mock.expect_run_command_output()
            .returning(|_, _| Ok(fake_success_output(b"mihomo v1.18.0\n")));

        let result =
            get_core_version_with_io(&mock, std::path::Path::new("/usr/bin/mihomo")).unwrap();
        assert_eq!(result, "v1.18.0");
    }

    #[test]
    fn test_get_core_version_with_io_no_prefix() {
        let mut mock = MockProcessIo::new();
        mock.expect_run_command_output()
            .returning(|_, _| Ok(fake_success_output(b"1.18.0\n")));

        let result =
            get_core_version_with_io(&mock, std::path::Path::new("/usr/bin/mihomo")).unwrap();
        assert_eq!(result, "1.18.0");
    }

    #[test]
    fn test_get_core_version_with_io_command_failure() {
        let mut mock = MockProcessIo::new();
        mock.expect_run_command_output()
            .returning(|_, _| Err("File not found".to_owned()));

        let result = get_core_version_with_io(&mock, std::path::Path::new("/usr/bin/mihomo"));
        assert!(result.is_err());
    }

    #[test]
    fn test_get_core_version_with_io_empty_output() {
        let mut mock = MockProcessIo::new();
        mock.expect_run_command_output()
            .returning(|_, _| Ok(fake_success_output(b"")));

        let result =
            get_core_version_with_io(&mock, std::path::Path::new("/usr/bin/mihomo")).unwrap();
        assert_eq!(result, "");
    }

    #[test]
    fn test_get_core_version_with_io_with_metadata() {
        let mut mock = MockProcessIo::new();
        mock.expect_run_command_output().returning(|_, _| {
            Ok(fake_success_output(
                b"mihomo v1.18.0-alpha.1 (linux amd64) 2024-01-01\n",
            ))
        });

        let result =
            get_core_version_with_io(&mock, std::path::Path::new("/usr/bin/mihomo")).unwrap();
        assert_eq!(result, "v1.18.0-alpha.1");
    }

    // -- Snapshot tests for version parsing --------------------------------

    #[test]
    fn snapshot_parse_version_standard() {
        insta::assert_snapshot!(parse_version_output("mihomo v1.18.0 linux amd64"));
    }

    #[test]
    fn snapshot_parse_version_alpha() {
        insta::assert_snapshot!(parse_version_output("mihomo v1.18.0-alpha.1 (linux amd64)"));
    }

    #[test]
    fn snapshot_parse_version_no_prefix() {
        insta::assert_snapshot!(parse_version_output("1.18.0"));
    }

    #[test]
    fn snapshot_parse_version_empty() {
        insta::assert_snapshot!(parse_version_output(""));
    }

    // -- Property test for secret generation -------------------------------

    #[test]
    fn generate_secret_is_32_alphanumeric() {
        let secret = generate_secret();
        assert_eq!(secret.len(), 32, "secret must be exactly 32 characters");
        assert!(
            secret.chars().all(|c| c.is_ascii_alphanumeric()),
            "secret must be alphanumeric"
        );
    }

    #[test]
    fn test_extract_configured_proxy_port() {
        assert_eq!(
            extract_configured_proxy_port("mixed-port: 7890"),
            Some(7890)
        );
        assert_eq!(extract_configured_proxy_port("port: 7891"), Some(7891));
        assert_eq!(
            extract_configured_proxy_port("socks-port: 7892"),
            Some(7892)
        );
        assert_eq!(
            extract_configured_proxy_port("mixed-port: '9090'"),
            Some(9090)
        );
        assert_eq!(extract_configured_proxy_port("other: 1234"), None);
        assert_eq!(extract_configured_proxy_port("invalid yaml ::::"), None);
        assert_eq!(extract_configured_proxy_port("mixed-port: 0"), None);
    }

    #[test]
    fn test_extract_configured_proxy_endpoint() {
        assert_eq!(
            extract_configured_proxy_endpoint("mixed-port: 7890"),
            Some(ProxyEndpoint::http(7890))
        );
        assert_eq!(
            extract_configured_proxy_endpoint("port: 7891"),
            Some(ProxyEndpoint::http(7891))
        );
        assert_eq!(
            extract_configured_proxy_endpoint("socks-port: 7892"),
            Some(ProxyEndpoint::socks5h(7892))
        );
        assert_eq!(
            extract_configured_proxy_endpoint("mixed-port: '9090'"),
            Some(ProxyEndpoint::http(9090))
        );
        assert_eq!(extract_configured_proxy_endpoint("other: 1234"), None);
        assert_eq!(extract_configured_proxy_endpoint("invalid yaml ::::"), None);
        assert_eq!(extract_configured_proxy_endpoint("mixed-port: 0"), None);
        // A disabled `mixed-port` must fall through to the next configured
        // listener rather than being selected as port 0: `parse_u16` rejects
        // zero, so the `or_else` chain continues to `port` and then
        // `socks-port`. Pinned explicitly, because "no endpoint at all" (the
        // assertion above) and "the wrong listener" look identical from outside
        // but are very different failures.
        assert_eq!(
            extract_configured_proxy_endpoint("mixed-port: 0\nsocks-port: 7892"),
            Some(ProxyEndpoint::socks5h(7892))
        );
        assert_eq!(
            extract_configured_proxy_endpoint("mixed-port: 0\nport: 7891"),
            Some(ProxyEndpoint::http(7891))
        );
    }

    // ── Additional Core Startup & State Management Tests ─────────────────────

    fn setup_test_app_paths() -> (tempfile::TempDir, AppPaths) {
        let temp_dir = tempfile::tempdir().unwrap();
        let app_paths = AppPaths {
            app_data_dir: temp_dir.path().to_path_buf(),
            core_dir: temp_dir.path().join("core"),
            profiles_dir: temp_dir.path().join("profiles"),
        };
        std::fs::create_dir_all(&app_paths.app_data_dir).unwrap();
        std::fs::create_dir_all(&app_paths.core_dir).unwrap();
        std::fs::create_dir_all(&app_paths.profiles_dir).unwrap();
        (temp_dir, app_paths)
    }

    #[test]
    fn test_first_available_profile() {
        let (_temp, paths) = setup_test_app_paths();

        std::fs::write(paths.profiles_dir.join("b_profile.yaml"), "port: 7890").unwrap();
        std::fs::write(paths.profiles_dir.join("a_profile.yml"), "port: 7890").unwrap();
        std::fs::write(paths.profiles_dir.join("run_config.yaml"), "port: 7890").unwrap();
        std::fs::write(paths.profiles_dir.join("readme.txt"), "hello").unwrap();

        let first = first_available_profile(&paths).unwrap();
        assert_eq!(
            first.file_name().unwrap().to_str().unwrap(),
            "a_profile.yml"
        );
    }

    #[test]
    fn test_resolve_profile_path() {
        let (_temp, paths) = setup_test_app_paths();

        // Rejects run_config.yaml directly
        let res = resolve_profile_path(&paths, "run_config.yaml");
        assert_eq!(
            res.unwrap_err(),
            "Cannot switch to run_config.yaml directly"
        );

        // No profile yet: keeps the requested name and writes nothing
        let (name, path) = resolve_profile_path(&paths, "nonexistent.yaml").unwrap();
        assert_eq!(name, "nonexistent.yaml");
        assert!(!path.exists());

        // Resolves an existing profile
        std::fs::write(paths.profiles_dir.join("profile1.yaml"), "port: 7890").unwrap();
        let (name1, path1) = resolve_profile_path(&paths, "profile1.yaml").unwrap();
        assert_eq!(name1, "profile1.yaml");
        assert_eq!(path1, paths.profiles_dir.join("profile1.yaml"));

        // Falls back to the first available profile when the requested one is missing
        let (fallback_name, _) = resolve_profile_path(&paths, "missing_target.yaml").unwrap();
        assert_eq!(fallback_name, "profile1.yaml");
    }

    #[test]
    fn test_select_runtime_config() {
        let (_temp, paths) = setup_test_app_paths();

        let preferred_path = paths.profiles_dir.join("pref.yaml");
        let valid_yaml = "port: 7890\nmode: rule";
        std::fs::write(&preferred_path, valid_yaml).unwrap();

        // 1. Preferred profile is valid
        let (name, yaml, port, proxy) =
            select_runtime_config(&paths, "pref.yaml", &preferred_path, "sec123", None).unwrap();
        assert_eq!(name, Some("pref.yaml".to_owned()));
        assert_eq!(port, 9090);
        assert_eq!(proxy, Some(ProxyEndpoint::http(7890)));
        assert!(yaml.contains("secret: sec123"));

        // 2. Preferred profile is invalid, secondary fallback profile is valid
        let invalid_path = paths.profiles_dir.join("invalid.yaml");
        std::fs::write(&invalid_path, "{ invalid yaml: [").unwrap();
        let fallback_path = paths.profiles_dir.join("fallback.yaml");
        std::fs::write(&fallback_path, "port: 7895\nmode: rule").unwrap();

        let (fb_name, fb_yaml, fb_port, fb_proxy) =
            select_runtime_config(&paths, "invalid.yaml", &invalid_path, "sec456", None).unwrap();
        assert_eq!(fb_name, Some("fallback.yaml".to_owned()));
        assert_eq!(fb_port, 9090);
        assert_eq!(fb_proxy, Some(ProxyEndpoint::http(7895)));
        assert!(fb_yaml.contains("secret: sec456"));

        // 3. Preferred profile invalid and no valid fallbacks exist
        let (_temp2, empty_paths) = setup_test_app_paths();
        let bad_path = empty_paths.profiles_dir.join("bad.yaml");
        std::fs::write(&bad_path, "{ invalid yaml: [").unwrap();

        let (no_name, min_yaml, min_port, min_proxy) =
            select_runtime_config(&empty_paths, "bad.yaml", &bad_path, "sec789", None).unwrap();
        assert_eq!(no_name, None);
        assert_eq!(min_port, 9090);
        assert_eq!(min_proxy, Some(ProxyEndpoint::http(DEFAULT_MIXED_PORT)));
        assert!(min_yaml.contains("secret: sec789"));
    }

    #[test]
    fn test_clear_stopped_core_state() {
        let mut core_data = CoreData::new();
        core_data.set_started_at(Some(std::time::Instant::now()));
        core_data.set_last_port(Some(9090));
        core_data.set_last_proxy_endpoint(Some(ProxyEndpoint::http(7890)));

        assert!(core_data.started_at().is_some());
        assert_eq!(core_data.last_port(), Some(9090));

        clear_stopped_core_state(&mut core_data);

        assert!(core_data.started_at().is_none());
        assert!(core_data.process().is_none());
        assert!(core_data.last_port().is_none());
        assert!(core_data.last_proxy_endpoint().is_none());
    }
}
