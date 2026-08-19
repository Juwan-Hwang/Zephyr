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
use super::tun_manager::{is_tun_mode, restart_core_as_root};
use super::{AppPaths, CoreData, CoreStartResult, MihomoState, CORE_STARTING};

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

    // No config file found - create a default one
    let default_path = paths.profiles_dir.join("config.yaml");
    create_default_config(&default_path)?;
    Ok(("config.yaml".to_owned(), default_path))
}

/// Create a minimal default configuration file for first-time users
fn create_default_config(path: &Path) -> Result<(), String> {
    let default_config = r"# Zephyr Default Configuration
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
  fake-ip-range: 198.18.0.0/16
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
";

    write_file_secure(path, default_config)
        .map_err(|e| format!("Failed to create default config: {e}"))?;

    emit_info!(Config, CONFIG_CREATED_DEFAULT, "Created default config");
    Ok(())
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

/// Parse the proxy port from YAML config.
/// Checks `mixed-port`, `port`, `socks-port` in order (same logic as frontend).
/// Supports both integer (`mixed-port: 7890`) and string (`mixed-port: "7890"`) formats.
fn parse_proxy_port(yaml_val: &serde_yaml::Value) -> u16 {
    let parse_u16 = |val: &serde_yaml::Value| -> Option<u16> {
        val.as_u64()
            .and_then(|p| u16::try_from(p).ok())
            .or_else(|| val.as_str().and_then(|s| s.trim().parse::<u16>().ok()))
            .filter(|&p| p != 0)
    };

    yaml_val
        .get("mixed-port")
        .and_then(parse_u16)
        .or_else(|| yaml_val.get("port").and_then(parse_u16))
        .or_else(|| yaml_val.get("socks-port").and_then(parse_u16))
        .unwrap_or(DEFAULT_MIXED_PORT)
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
) -> Option<(String, u16, u16)> {
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
    let proxy_port = parse_proxy_port(&yaml_val);

    let result = serde_yaml::to_string(&yaml_val).ok()?;

    Some((result, config_port, proxy_port))
}

fn build_minimal_runtime_config(secret: &str) -> (String, u16, u16) {
    (
        format!(
            "mixed-port: {DEFAULT_MIXED_PORT}\nmode: rule\nlog-level: info\nunified-delay: true\ntcp-concurrent: true\nkeep-alive-interval: 30\nkeep-alive-idle: 600\nfind-process-mode: always\nprofile:\n  store-fake-ip: true\nexternal-controller: 127.0.0.1:9090\nsecret: {secret}\nproxies: []\nproxy-groups:\n  - name: GLOBAL\n    type: select\n    proxies:\n      - DIRECT\nrules:\n  - MATCH,DIRECT\n"
        ),
        DEFAULT_API_PORT,
        DEFAULT_MIXED_PORT,
    )
}

fn select_runtime_config(
    paths: &AppPaths,
    preferred_name: &str,
    preferred_path: &Path,
    secret: &str,
    prefs: Option<&GlobalPreferences>,
) -> Result<(Option<String>, String, u16, u16), String> {
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

    let mut fallback_profiles = Vec::new();
    let entries = if let Ok(entries) = fs::read_dir(&paths.profiles_dir) {
        entries
    } else {
        let (config, api_port, proxy_port) = build_minimal_runtime_config(secret);
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

    emit_warn!(
        Config,
        CONFIG_PARSE_FAILED,
        "Requested config {preferred_name} is not valid, falling back to minimal config"
    );
    let (final_config, api_port, proxy_port) = build_minimal_runtime_config(secret);
    Ok((None, final_config, api_port, proxy_port))
}

pub fn get_core_exe_path(app: &AppHandle) -> Result<PathBuf, String> {
    let binary_name = core_binary_name();
    let core_dir = ensure_app_storage(app)?.core_dir;
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
async fn spawn_with_cache_retry(
    exe_path: &Path,
    safe_custom_args: &[String],
    core_dir: &Path,
    app_data_dir: &Path,
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

/// Perform an HTTP health check against the mihomo API.
///
/// Tries to connect via raw TCP and checks for HTTP 200/401 responses.
/// Returns `Ok(())` if the core responds within the retry limit.
async fn health_check(port: u16) -> Result<(), String> {
    let mut is_healthy = false;
    let mut interval = std::time::Duration::from_millis(HEALTH_CHECK_INITIAL_INTERVAL_MS);
    let max_interval = std::time::Duration::from_millis(HEALTH_CHECK_MAX_INTERVAL_MS);

    for _ in 0..HEALTH_CHECK_MAX_RETRIES {
        if let Ok(mut stream) = TcpStream::connect(format!("127.0.0.1:{port}")).await {
            let request =
                format!("GET / HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
            if stream.write_all(request.as_bytes()).await.is_ok() {
                let mut response = [0u8; 256];
                if let Ok(n) = stream.read(&mut response).await {
                    let resp_str = String::from_utf8_lossy(response.get(..n).unwrap_or(&[]));
                    if resp_str.starts_with("HTTP/1.1 200")
                        || resp_str.starts_with("HTTP/1.1 401")
                        || resp_str.starts_with("HTTP/1.0 200")
                        || resp_str.starts_with("HTTP/1.0 401")
                    {
                        is_healthy = true;
                        break;
                    }
                }
            }
        }
        let sleep_dur = interval;
        interval = (interval * 2).min(max_interval);
        tokio::time::sleep(sleep_dur).await;
    }

    if is_healthy {
        Ok(())
    } else {
        Err("Core started but health check failed. Check the logs for details.".to_owned())
    }
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
        if result.is_err() {
            // The Manual event was dropped — invalidate applied_state directly
            // so the next polling tick detects the mismatch and reconciles.
            coordinator.invalidate_applied_state();
            emit_warn!(
                System,
                SYS_NETWORK_COORDINATOR_ERROR,
                "Network coordinator notify timed out after 5s — \
                 applied_state invalidated; will reconcile on next poll"
            );
        }
    }
}

#[allow(clippy::cognitive_complexity)]
pub async fn start_core_inner(
    app: AppHandle,
    state: State<'_, MihomoState>,
    config_path: String,
    test: bool,
    custom_args: Vec<String>,
    secret: Option<String>,
    force: Option<bool>,
) -> Result<CoreStartResult, String> {
    // Wait for any previous core start operation to complete (max 10s)
    let mut wait_ms = 0;
    while CORE_STARTING
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        if wait_ms > 10000 {
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
                let same_config = lock
                    .last_config_path()
                    .is_some_and(|current| current == config_path);
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

    // Check if TUN mode is active via flag (memory-based, not from config file)
    #[cfg(target_os = "macos")]
    if is_tun_mode() {
        let secret = restart_core_as_root(&app, true).await?;
        // Record uptime for the TUN start path (restart_core_as_root spawns
        // mihomo as root; the normal spawn path below is never reached).
        // Best-effort: if the lock fails, mihomo is already running — don't
        // fail the entire start just because we couldn't record the timestamp.
        if let Ok(mut lock) = lock_critical(&state.0, BackendModule::Core, codes::CORE_LOCK_FAILED)
        {
            // Clear the stale Child handle: restart_core_as_root killed the
            // old process and spawned a new root-owned one that is NOT tracked
            // by Child (it's managed externally via killall).  Without this,
            // get_core_uptime() would see the dead Child, call try_wait(),
            // detect exit, and incorrectly clear started_at + ports.
            lock.set_process(None);
            lock.set_last_secret(secret.clone());
            lock.set_last_config_path(Some(config_path.clone()));
            lock.set_last_port(Some(DEFAULT_API_PORT));
            // proxy_port is not yet parsed (select_runtime_config runs later
            // in the normal path); clear any stale value from a prior config.
            lock.set_last_proxy_port(None);
            lock.set_started_at(Some(std::time::Instant::now()));
        } else {
            emit_warn!(
                Core,
                CORE_LOCK_FAILED,
                "TUN start: failed to acquire lock to record started_at — uptime will be unavailable until next restart"
            );
        }
        // For TUN mode, use the config_path as-is to match the frontend's requested name.
        // Do NOT strip extension here, as normal mode returns full filename with extension.
        // Notify the network coordinator that a fresh core instance was started.
        // The new process has no rules applied, so the coordinator's applied_state
        // is now stale and must be re-evaluated.
        notify_core_started(&app).await;
        return Ok(CoreStartResult {
            secret,
            port: DEFAULT_API_PORT,
            active_config: Some(config_path),
        });
    }

    // Kill any existing mihomo processes before starting a new one
    // Use spawn_blocking to avoid blocking the tokio runtime (kill_mihomo sleeps 300ms)
    tokio::task::spawn_blocking(kill_mihomo)
        .await
        .map_err(|e| format!("Kill task failed: {e}"))?;

    let paths = ensure_app_storage(&app)?;

    // Note: We no longer delete cache.db proactively
    // cache.db contains DNS cache and other useful data
    // If mihomo fails to start due to lock issues, we'll retry after removing it
    // This is handled in the spawn error handling below

    // Wait for port to be truly free (max 5s)
    #[cfg(target_os = "macos")]
    wait_for_port_free(DEFAULT_API_PORT).await;

    let exe_path = get_core_exe_path(&app)?;

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    ensure_executable(&exe_path)?;

    let (resolved_config_name, resolved_config_path) = resolve_profile_path(&paths, &config_path)?;

    let safe_custom_args = validate_custom_args(&custom_args)?;

    if test {
        let mut cmd = Command::new(&exe_path);
        #[cfg(target_os = "windows")]
        use std::os::windows::process::CommandExt as _;
        #[cfg(target_os = "windows")]
        cmd.creation_flags(CREATE_NO_WINDOW);

        cmd.args(["-t", "-f"]);
        cmd.arg(&resolved_config_path);
        for arg in &safe_custom_args {
            cmd.arg(arg);
        }
        let output = cmd
            .output()
            .map_err(|e| format!("Failed to run test: {e}"))?;

        if output.status.success() {
            return Ok(CoreStartResult {
                secret: "test_ok".to_owned(),
                port: 0,
                active_config: Some(resolved_config_name),
            });
        }
        let mut err_msg = String::from_utf8_lossy(&output.stderr).into_owned();
        // Basic path redaction
        err_msg = redact_error_message(&err_msg);
        emit_error!(Config, CONFIG_PARSE_FAILED, "Config test failed: {err_msg}");
        return Err(
            "Config test failed. Please check the config file for syntax errors.".to_owned(),
        );
    }

    let app_clone = app.clone();
    tokio::task::spawn_blocking(move || {
        let state = app_clone.state::<MihomoState>();
        stop_core_inner(&app_clone, &state)
    })
    .await
    .map_err(|e| format!("Failed to stop core: {e}"))??;

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
    write_file_secure(&run_config_path, &final_config)?;

    // Preflight: validate config with `mihomo -t` before spawning the process.
    // This catches syntax errors, missing proxy references, etc. early and prevents
    // the core from entering a crash-restart loop due to an invalid config.
    {
        let exe_path_clone = exe_path.clone();
        let core_dir_clone = paths.core_dir.clone();
        let safe_custom_args_clone = safe_custom_args.clone();
        let output = tokio::task::spawn_blocking(move || {
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
        .await
        .map_err(|e| format!("Preflight check task panicked: {e}"))?
        .map_err(|e| format!("Preflight check failed to execute: {e}"))?;

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

    // Spawn mihomo (stdout/stderr redirected to log file internally)
    let (mut child, log_path) = spawn_with_cache_retry(
        &exe_path,
        &safe_custom_args,
        &paths.core_dir,
        &paths.app_data_dir,
    )
    .await?;
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

    // HTTP Health Check via raw TCP
    health_check(port).await?;

    // Note: MSL was set to 1000ms in root shell during TUN start if applicable.
    // Non-TUN mode does not need low MSL, and changing it requires root anyway.

    {
        let mut lock = match lock_critical(&state.0, BackendModule::Core, codes::CORE_LOCK_FAILED) {
            Ok(l) => l,
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(e);
            }
        };
        lock.set_process(Some(child));
        lock.set_last_secret(resolved_secret.clone());
        lock.set_last_config_path(active_config_name.clone());
        lock.set_last_custom_args(Some(safe_custom_args));
        lock.set_last_port(Some(port));
        lock.set_last_proxy_port(Some(proxy_port));
        lock.set_last_log_path(Some(log_path.to_string_lossy().into_owned()));
        lock.set_started_at(Some(started_at));
    }
    // `lock` is now out of scope — the MutexGuard is fully dropped before any `.await`.

    notify_core_started(&app).await;

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
    test: bool,
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
        test,
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
    lock.set_last_proxy_port(None);
}

/// Internal: stop the core process (no rate limiter reset).
pub fn stop_core_inner(app: &AppHandle, state: &MihomoState) -> Result<(), String> {
    // Take the child process
    let child = {
        let mut lock = state
            .0
            .lock()
            .map_err(|e| format!("Failed to lock state: {e}"))?;
        let child = lock.take_process();
        clear_stopped_core_state(&mut lock);
        drop(lock);
        child
    };

    if let Some(mut child_process) = child {
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
                            killed_group = true;
                            break;
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

    cleanup_run_config(app);
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
    fn test_core_binary_name() {
        let name = core_binary_name();
        #[cfg(target_os = "windows")]
        assert_eq!(name, "zephyr-mihomo.exe");
        #[cfg(not(target_os = "windows"))]
        assert_eq!(name, "zephyr-mihomo");
    }

    #[test]
    fn prepare_runtime_config_injects_secret_and_controller() {
        let config = "external-controller: 0.0.0.0:7897\nsecret: old\nmode: rule\n";
        let (prepared, api_port, proxy_port) =
            prepare_runtime_config(config, "new-secret", None).unwrap();

        assert_eq!(api_port, 7897);
        assert_eq!(proxy_port, DEFAULT_MIXED_PORT);
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
        assert_eq!(proxy_port, 7890);
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
        assert_eq!(proxy_port, 7890);
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
            "secret must be alphanumeric: {secret}"
        );
    }
}
