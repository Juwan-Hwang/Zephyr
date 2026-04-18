use rand::RngExt as _;
use std::fs;
use std::io::{Read as _, Write as _};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::Ordering;
use tauri::{AppHandle, Manager as _, State};

#[cfg(any(target_os = "macos", target_os = "linux"))]
use std::os::unix::fs::PermissionsExt as _;

use super::config_sanitizer::{sanitize_config_file_name, validate_path_within_dir};
use super::secure_io::write_file_secure;
#[cfg(target_os = "macos")]
use super::tun_manager::{is_tun_mode, restart_core_as_root, set_tun_mode};
use super::{AppPaths, CoreStartResult, MihomoState, CORE_STARTING};

#[cfg(target_os = "windows")]
use super::CREATE_NO_WINDOW;

#[must_use]
pub const fn core_binary_name() -> &'static str {
    #[cfg(target_os = "windows")]
    {
        "mihomo.exe"
    }
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        "mihomo"
    }
}

/// Kill all mihomo processes (cleanup function)
pub fn kill_mihomo() {
    #[cfg(unix)]
    {
        // Try to kill multiple times to ensure all processes are terminated
        for _ in 0..3 {
            let _ = std::process::Command::new("killall")
                .arg("-9")
                .arg("mihomo")
                .output();
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt as _;
        let _ = std::process::Command::new("taskkill")
            .args(["/F", "/IM", "mihomo.exe"])
            .creation_flags(CREATE_NO_WINDOW)
            .output();
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
pub fn ensure_executable(path: &Path) -> Result<(), String> {
    let metadata = fs::metadata(path).map_err(|e| format!("Failed to read core metadata: {e}"))?;
    let mut permissions = metadata.permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(path, permissions)
        .map_err(|e| format!("Failed to set executable permissions: {e}"))
}

#[cfg(target_os = "windows")]
pub const fn ensure_executable(_path: &Path) -> Result<(), String> {
    Ok(())
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
                        eprintln!("Warning: Failed to copy bundled file {file_name}: {e}");
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
        if is_new {
            use std::os::windows::process::CommandExt as _;
            use std::process::Command;
            if let Ok(username) = std::env::var("USERNAME") {
                let _ = Command::new("icacls")
                    .arg(&paths.app_data_dir)
                    .arg("/inheritance:r")
                    .arg("/grant:r")
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
    let config_file_name = sanitize_config_file_name(config_path)?;
    if config_file_name == "run_config.yaml" {
        return Err("Cannot switch to run_config.yaml directly".to_owned());
    }

    let resolved_path = paths.profiles_dir.join(&config_file_name);

    // Validate that the resolved path is within profiles_dir
    validate_path_within_dir(&resolved_path, &paths.profiles_dir)?;

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
fn create_default_config(path: &PathBuf) -> Result<(), String> {
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
";

    fs::write(path, default_config).map_err(|e| format!("Failed to create default config: {e}"))?;

    println!("Created default config at {path:?}");
    Ok(())
}

fn first_available_profile(paths: &AppPaths) -> Option<PathBuf> {
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
        .unwrap_or(9090)
}

fn validate_custom_args(custom_args: &[String]) -> Result<Vec<String>, String> {
    let mut safe_custom_args = Vec::new();

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

#[must_use]
pub fn prepare_runtime_config(content: &str, secret: &str) -> Option<(String, u16)> {
    let mut yaml_val = serde_yaml::from_str::<serde_yaml::Value>(content).ok()?;
    if !yaml_val.is_mapping() {
        return None;
    }

    let config_port = parse_external_controller_port(&yaml_val);
    if let Some(mapping) = yaml_val.as_mapping_mut() {
        mapping.insert(
            serde_yaml::Value::String("external-controller".to_owned()),
            serde_yaml::Value::String(format!("127.0.0.1:{config_port}")),
        );
        mapping.insert(
            serde_yaml::Value::String("secret".to_owned()),
            serde_yaml::Value::String(secret.to_owned()),
        );

        // Default unified-delay to true if missing
        let unified_delay_key = serde_yaml::Value::String("unified-delay".to_owned());
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
            "mixed-port: 7890\nmode: rule\nlog-level: info\nunified-delay: true\nexternal-controller: 127.0.0.1:9090\nsecret: {secret}\nproxies: []\nproxy-groups:\n  - name: GLOBAL\n    type: select\n    proxies:\n      - DIRECT\nrules:\n  - MATCH,DIRECT\n"
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
        .map_err(|e| format!("Failed to read config {preferred_path:?}: {e}"))?;
    if let Some((final_config, config_port)) = prepare_runtime_config(&preferred_content, secret) {
        return Ok((Some(preferred_name.to_owned()), final_config, config_port));
    }

    let mut fallback_profiles = Vec::new();
    let entries = if let Ok(entries) = fs::read_dir(&paths.profiles_dir) {
        entries
    } else {
        let (config, port) = build_minimal_runtime_config(secret);
        return Ok((None, config, port));
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
                .to_owned();
            println!(
                "Requested config {preferred_name} is not a valid Clash YAML profile, falling back to {file_name}"
            );
            return Ok((Some(file_name), final_config, config_port));
        }
    }

    println!(
        "Requested config {preferred_name} is not a valid Clash YAML profile, falling back to generated minimal config"
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

    Err(format!(
        "Could not find {binary_name} in app data core directory"
    ))
}

pub(super) fn generate_secret() -> String {
    rand::rng()
        .sample_iter(rand::distr::Alphanumeric)
        .take(32)
        .map(char::from)
        .collect()
}

#[tauri::command]
pub async fn start_core(
    app: AppHandle,
    state: State<'_, MihomoState>,
    config_path: String,
    test: bool,
    custom_args: Vec<String>,
    secret: Option<String>,
    rate_limiter: State<'_, crate::RateLimiter>,
) -> Result<CoreStartResult, String> {
    // Rate limit: max 1 call per 3 seconds
    crate::rate_limit!(rate_limiter, "start_core", 3000);

    // Wait for any previous core start operation to complete (max 10s)
    let mut wait_ms = 0;
    while CORE_STARTING
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        if wait_ms > 10000 {
            // Timeout: force reset the flag to prevent permanent deadlock
            // This can happen if previous start crashed without cleaning up
            eprintln!("[CORE] WARNING: Core start lock timeout, forcing reset");
            CORE_STARTING.store(false, Ordering::SeqCst);
            // Try to acquire again after reset
            if CORE_STARTING
                .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                .is_ok()
            {
                break; // Successfully acquired after reset
            }
            // If still can't acquire, another thread is racing, wait more
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

    // Check if TUN mode is active via flag (memory-based, not from config file)
    #[cfg(target_os = "macos")]
    if is_tun_mode() {
        let secret = restart_core_as_root(&app, true).await?;
        return Ok(CoreStartResult { secret, port: 9090 });
    }

    // Kill any existing mihomo processes before starting a new one
    kill_mihomo();

    let paths = ensure_app_storage(&app)?;

    // Note: We no longer delete cache.db proactively
    // cache.db contains DNS cache and other useful data
    // If mihomo fails to start due to lock issues, we'll retry after removing it
    // This is handled in the spawn error handling below

    // Wait for port 9090 to be truly free (max 5s)
    // Even after process death, port release may have a few hundred ms delay
    #[cfg(target_os = "macos")]
    {
        for i in 0..50 {
            if std::net::TcpListener::bind("127.0.0.1:9090").is_ok() {
                eprintln!("[CORE] port 9090 confirmed free after {i * 100}ms");
                break;
            }
            if i == 49 {
                eprintln!("[CORE] WARNING: port 9090 still occupied after 5s, proceeding anyway");
            } else {
                eprintln!("[CORE] waiting for port 9090... {(i + 1) * 100}ms");
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
    }

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
            });
        }
        let mut err_msg = String::from_utf8_lossy(&output.stderr).into_owned();
        // Basic path redaction
        err_msg = err_msg.replace(paths.core_dir.to_str().unwrap_or(""), "[CORE_DIR]");
        err_msg = err_msg.replace(paths.profiles_dir.to_str().unwrap_or(""), "[PROFILES_DIR]");
        println!("Config test failed: {err_msg}");
        return Err(
            "Config test failed. Please check the config file for syntax errors.".to_owned(),
        );
    }

    stop_core(app.clone(), state.clone())?;

    let resolved_secret = secret.unwrap_or_else(generate_secret);

    let (active_config_name, final_config, config_port) = select_runtime_config(
        &paths,
        &resolved_config_name,
        &resolved_config_path,
        &resolved_secret,
    )?;

    let run_config_path = paths.core_dir.join("run_config.yaml");
    write_file_secure(&run_config_path, &final_config)?;

    let mut cmd = Command::new(&exe_path);
    #[cfg(target_os = "windows")]
    use std::os::windows::process::CommandExt as _;
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);

    cmd.args(["-d", "."]);
    cmd.args(["-f", "run_config.yaml"]);

    for arg in &safe_custom_args {
        cmd.arg(arg);
    }

    cmd.current_dir(&paths.core_dir);

    // Debug: show mihomo processes before spawn
    #[cfg(target_os = "macos")]
    {
        let ps = std::process::Command::new("sh")
            .args(["-c", "ps aux | grep mihomo | grep -v grep"])
            .output()
            .ok();
        if let Some(o) = ps {
            eprintln!(
                "[CORE] mihomo processes before spawn:\n{String::from_utf8_lossy(&o.stdout)}"
            );
        }
    }

    // Write stdout/stderr to file to avoid pipe blocking, while still seeing errors
    // Use temp directory with unique filename per process to avoid multi-instance conflicts
    // Prefix with app name to avoid conflicts with other applications
    let log_path = std::env::temp_dir().join(format!(
        "zephyr-mihomo-{}-{}.log",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    ));

    // Cleanup old zephyr-mihomo log files (older than 1 hour) to prevent accumulation
    // Only scan for files matching our specific prefix to avoid interfering with other apps
    if let Ok(entries) = std::fs::read_dir(std::env::temp_dir()) {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        for entry in entries.flatten() {
            if let Some(name) = entry.file_name().to_str() {
                // Only cleanup files with our specific prefix
                if name.starts_with("zephyr-mihomo-") && name.ends_with(".log") {
                    // Extract timestamp from the last segment before .log
                    // Format: zephyr-mihomo-{pid}-{timestamp}.log
                    // We parse from the end to be resilient to prefix changes
                    if let Some(name_without_ext) = name.strip_suffix(".log") {
                        if let Some(last_segment) = name_without_ext.rsplit('-').next() {
                            if let Ok(ts) = last_segment.parse::<u128>() {
                                // Delete logs older than 1 hour (3600000 ms)
                                if now.saturating_sub(ts) > 3600000 {
                                    let _ = std::fs::remove_file(entry.path());
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // Create or truncate log file
    if let Ok(log_file) = std::fs::File::create(&log_path) {
        // Clone the handle for stderr before converting to Stdio
        let stderr_handle = log_file.try_clone();
        cmd.stdout(std::process::Stdio::from(log_file));
        cmd.stderr(
            stderr_handle
                .map(std::process::Stdio::from)
                .unwrap_or_else(|_| std::process::Stdio::null()),
        );
    } else {
        // Fallback to null if log file cannot be created
        cmd.stdout(std::process::Stdio::null());
        cmd.stderr(std::process::Stdio::null());
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn mihomo: {e}"))?;

    // Check if process exits immediately
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    match child.try_wait() {
        Ok(Some(status)) => {
            let log = std::fs::read_to_string(&log_path).unwrap_or_default();

            // Check if this looks like a cache/lock issue
            let is_lock_issue = log.contains("database is locked")
                || log.contains("cache.db")
                || log.contains("unable to open database")
                || log.contains("database disk image is malformed");

            if is_lock_issue {
                eprintln!("[CORE] Detected cache.db lock issue, removing and retrying...");
                let cache_path = paths.core_dir.join("cache.db");
                let _ = std::fs::remove_file(&cache_path);

                // Retry once after removing cache.db
                let mut retry_cmd = Command::new(&exe_path);
                #[cfg(target_os = "windows")]
                {
                    use std::os::windows::process::CommandExt as _;
                    const CREATE_NO_WINDOW: u32 = 0x08000000;
                    retry_cmd.creation_flags(CREATE_NO_WINDOW);
                }
                retry_cmd.args(["-d", "."]);
                retry_cmd.args(["-f", "run_config.yaml"]);
                for arg in &safe_custom_args {
                    retry_cmd.arg(arg);
                }
                retry_cmd.current_dir(&paths.core_dir);

                // Setup log file for retry
                let retry_log_path = std::env::temp_dir().join(format!(
                    "zephyr-mihomo-{}-{}-retry.log",
                    std::process::id(),
                    std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_millis())
                        .unwrap_or(0)
                ));
                if let Ok(log_file) = std::fs::File::create(&retry_log_path) {
                    let stderr_handle = log_file.try_clone();
                    retry_cmd.stdout(std::process::Stdio::from(log_file));
                    retry_cmd.stderr(
                        stderr_handle
                            .map(std::process::Stdio::from)
                            .unwrap_or_else(|_| std::process::Stdio::null()),
                    );
                } else {
                    retry_cmd.stdout(std::process::Stdio::null());
                    retry_cmd.stderr(std::process::Stdio::null());
                }

                match retry_cmd.spawn() {
                    Ok(mut retry_child) => {
                        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                        match retry_child.try_wait() {
                            Ok(None) => {
                                // Retry successful, use this process
                                child = retry_child;
                                // Continue to health check below
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

    // Use config port directly, rely on health check to verify
    let port = config_port;

    // HTTP Health Check via raw TCP
    let mut is_healthy = false;
    for _ in 0..20 {
        if let Ok(mut stream) = std::net::TcpStream::connect(format!("127.0.0.1:{port}")) {
            let request =
                format!("GET / HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
            if stream.write_all(request.as_bytes()).is_ok() {
                let mut response = [0u8; 256];
                if let Ok(n) = stream.read(&mut response) {
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
        let _ = tauri::async_runtime::spawn_blocking(|| {
            std::thread::sleep(std::time::Duration::from_millis(1000));
        })
        .await;
    }

    if !is_healthy {
        let err_msg =
            "Core started but health check failed. Check the logs for details.".to_owned();
        let _ = child.kill();
        let _ = child.wait();
        return Err(err_msg);
    }

    // Note: MSL was set to 1000ms in root shell during TUN start if applicable.
    // Non-TUN mode does not need low MSL, and changing it requires root anyway.

    let mut lock = if let Ok(l) = state.0.lock() {
        l
    } else {
        let _ = child.kill();
        let _ = child.wait();
        return Err("Failed to lock state".to_owned());
    };
    lock.process = Some(child);
    lock.last_secret.clone_from(&resolved_secret);
    lock.last_config_path = active_config_name;
    lock.last_custom_args = Some(safe_custom_args);
    lock.last_port = Some(port);
    lock.last_log_path = Some(log_path.to_string_lossy().into_owned());
    drop(lock);

    Ok(CoreStartResult {
        secret: resolved_secret,
        port,
    })
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn stop_core(app: AppHandle, state: State<'_, MihomoState>) -> Result<String, String> {
    // Take the child process
    let child = {
        let mut lock = state
            .0
            .lock()
            .map_err(|e| format!("Failed to lock state: {e}"))?;
        lock.last_port = None;
        lock.process.take()
    };

    if let Some(mut child_process) = child {
        // Force kill the process (cross-platform safe)
        let _ = child_process.kill();
        let _ = child_process.wait();
    }

    if let Ok(paths) = ensure_app_storage(&app) {
        let run_config_path = paths.core_dir.join("run_config.yaml");
        if run_config_path.exists() {
            if let Err(e) = fs::remove_file(&run_config_path) {
                println!("Warning: Failed to remove run_config.yaml: {e}");
            }
        }
    }

    Ok("Core stopped and cleaned up".to_owned())
}

#[tauri::command]
pub async fn get_core_version(app: AppHandle) -> Result<String, String> {
    let exe_path = get_core_exe_path(&app)?;
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    ensure_executable(&exe_path)?;

    let mut cmd = Command::new(&exe_path);
    #[cfg(target_os = "windows")]
    use std::os::windows::process::CommandExt as _;
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd.arg("-v");

    let output = cmd
        .output()
        .map_err(|e| format!("Failed to run version check: {e}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout);

    if let Some(v_idx) = stdout.find('v') {
        let after_v = &stdout[v_idx..];
        if let Some(space_idx) = after_v.find(' ') {
            return Ok(after_v[..space_idx].to_owned());
        }
        return Ok(after_v.to_owned());
    }

    Ok(stdout.trim().to_owned())
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
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
}
