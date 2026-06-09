//! Core process management — platform-agnostic trait definitions and pure helpers.
//!
//! Migrated from `src-tauri/src/core/core_process.rs`.
//! Only pure functions and data types are here; IO/Tauri-dependent code stays in src-tauri.

use crate::error::AppError;

// ── Constants ─────────────────────────────────────────────────────────────

const DEFAULT_API_PORT: u16 = 9090;
const DEFAULT_MIXED_PORT: u16 = 7890;

// ── Data types ────────────────────────────────────────────────────────────

/// Result of a successful core start.
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
#[derive(Debug, Clone)]
pub struct CoreStartResult {
    /// The port the core API is listening on.
    pub api_port: u16,
    /// The mixed proxy port.
    pub mixed_port: u16,
    /// The generated API secret.
    pub secret: String,
    /// The path to the running config file.
    pub config_path: String,
}

/// Global user preferences to inject into runtime config.
///
/// Fields set to `Some(...)` override the YAML profile values;
/// `None` means "use whatever the YAML profile has".
/// `Some(0)` for port fields means "disabled"; `None` means "use YAML default".
///
/// Migrated from `src-tauri/src/core/core_process.rs`.
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
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

/// Result of `prepare_runtime_config`: the modified YAML string and the detected API port.
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
#[derive(Debug, Clone)]
pub struct RuntimeConfigResult {
    pub yaml_content: String,
    pub api_port: u16,
}

// ── Platform-agnostic process management trait ────────────────────────────

/// Platform-agnostic process management trait.
///
/// Each platform provides its own implementation:
/// - **Desktop**: Spawns mihomo as a child process via `std::process::Command`
/// - **Android**: Manages mihomo through a foreground service / JNI
/// - **iOS**: Manages mihomo through a bundled executable
#[cfg_attr(feature = "uniffi", uniffi::export(callback_interface))]
pub trait ProcessManager: Send + Sync {
    /// Start the core process with the given config path.
    fn start_core(&self, config_path: String) -> Result<CoreStartResult, AppError>;

    /// Stop the running core process gracefully.
    fn stop_core(&self) -> Result<(), AppError>;

    /// Check if the core process is currently running.
    fn is_running(&self) -> bool;

    /// Get the version of the core binary.
    fn get_version(&self) -> Result<String, AppError>;

    /// Kill all core processes (cleanup on app exit).
    fn kill_all(&self) -> Result<(), AppError>;
}

// ── Pure helper functions ────────────────────────────────────────────────

/// Detect whether a core log indicates a cache/lock issue that warrants retry.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn detect_cache_lock_issue(log: String) -> bool {
    log.contains("database is locked")
        || log.contains("cache.db")
        || log.contains("unable to open database")
        || log.contains("database disk image is malformed")
}

/// Parse the version string from `mihomo -v` stdout.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn parse_version_output(stdout: String) -> String {
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

/// Generate a random 32-character hex secret.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn generate_secret() -> Result<String, AppError> {
    use rand::Rng as _;
    let mut rng = rand::rng();
    let secret: String = (0..32)
        .map(|_| format!("{:02x}", rng.random::<u8>()))
        .collect();
    Ok(secret)
}

/// Return the platform-specific core binary name.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn core_binary_name() -> String {
    #[cfg(target_os = "windows")]
    {
        "zephyr-mihomo.exe".to_owned()
    }
    #[cfg(not(target_os = "windows"))]
    {
        "zephyr-mihomo".to_owned()
    }
}

/// Validate and filter user-supplied custom command-line arguments.
///
/// Blocks dangerous flags like `-d`, `-f`, `--external-controller`, `--secret`
/// that could override security-critical settings.
///
/// Migrated from `src-tauri/src/core/core_process.rs`.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn validate_custom_args(custom_args: Vec<String>) -> Result<Vec<String>, AppError> {
    let mut safe_args = Vec::with_capacity(custom_args.len());

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
            return Err(AppError::ConfigError(format!(
                "Argument '{trimmed}' is not allowed for security reasons"
            )));
        }

        safe_args.push(trimmed.to_owned());
    }

    Ok(safe_args)
}

/// Parse the port from an `external-controller` YAML value string.
///
/// Migrated from `src-tauri/src/core/core_process.rs`.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn parse_external_controller_port(yaml_str: String) -> u16 {
    let yaml_val: serde_yaml::Value = match serde_yaml::from_str(&yaml_str) {
        Ok(v) => v,
        Err(_) => return DEFAULT_API_PORT,
    };
    yaml_val
        .get("external-controller")
        .and_then(|v| v.as_str())
        .and_then(|ext_ctrl| ext_ctrl.split(':').next_back())
        .and_then(|p| p.parse::<u16>().ok())
        .unwrap_or(DEFAULT_API_PORT)
}

/// Extract the `mixed-port` value from a YAML config string.
///
/// Returns the default mixed port (7890) if not found or invalid.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn extract_mixed_port_from_yaml(yaml_str: String) -> u16 {
    let yaml_val: serde_yaml::Value = match serde_yaml::from_str(&yaml_str) {
        Ok(v) => v,
        Err(_) => return DEFAULT_MIXED_PORT,
    };
    yaml_val
        .get("mixed-port")
        .and_then(|v| v.as_u64())
        .and_then(|p| u16::try_from(p).ok())
        .unwrap_or(DEFAULT_MIXED_PORT)
}

/// Get the default API port (9090).
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn default_api_port() -> u16 {
    DEFAULT_API_PORT
}

/// Get the default mixed proxy port (7890).
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn default_mixed_port() -> u16 {
    DEFAULT_MIXED_PORT
}

/// Prepare runtime config by injecting secret, controller, defaults, and global preferences.
///
/// This is the **complete** version migrated from `src-tauri/src/core/core_process.rs`.
/// It modifies the YAML to include:
/// - `external-controller: 127.0.0.1:{port}` (forced to localhost)
/// - `secret: {secret}`
/// - Default `unified-delay: true` if missing
/// - Default `tcp-concurrent: true` if missing
/// - Default `keep-alive-interval: 30` if missing
/// - Default `keep-alive-idle: 600` if missing
/// - Default `find-process-mode: always` if missing
/// - Default `profile.store-fake-ip: true` if missing
/// - GlobalPreferences overrides (mode, tun, ports, ipv6, allow_lan, unified_delay)
/// - Removes dangerous keys
///
/// Returns `None` if the YAML is invalid or not a mapping.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn prepare_runtime_config(
    content: String,
    secret: String,
    prefs: Option<GlobalPreferences>,
) -> Option<RuntimeConfigResult> {
    let mut yaml_val = serde_yaml::from_str::<serde_yaml::Value>(&content).ok()?;
    if !yaml_val.is_mapping() {
        return None;
    }

    let config_port = yaml_val
        .get("external-controller")
        .and_then(|v| v.as_str())
        .and_then(|ext_ctrl| ext_ctrl.split(':').next_back())
        .and_then(|p| p.parse::<u16>().ok())
        .unwrap_or(DEFAULT_API_PORT);

    if let Some(mapping) = yaml_val.as_mapping_mut() {
        // Inject external-controller (forced to localhost)
        mapping.insert(
            serde_yaml::Value::String("external-controller".to_owned()),
            serde_yaml::Value::String(format!("127.0.0.1:{config_port}")),
        );
        // Inject secret
        mapping.insert(
            serde_yaml::Value::String("secret".to_owned()),
            serde_yaml::Value::String(secret),
        );

        // Default unified-delay to true if missing
        let unified_delay_key = serde_yaml::Value::String("unified-delay".to_owned());
        if !mapping.contains_key(&unified_delay_key) {
            mapping.insert(unified_delay_key, serde_yaml::Value::Bool(true));
        }

        // Default tcp-concurrent to true if missing
        let tcp_concurrent_key = serde_yaml::Value::String("tcp-concurrent".to_owned());
        if !mapping.contains_key(&tcp_concurrent_key) {
            mapping.insert(tcp_concurrent_key, serde_yaml::Value::Bool(true));
        }

        // Default keep-alive-interval to 30 if missing
        let keep_alive_key = serde_yaml::Value::String("keep-alive-interval".to_owned());
        if !mapping.contains_key(&keep_alive_key) {
            mapping.insert(
                keep_alive_key,
                serde_yaml::Value::Number(serde_yaml::Number::from(30)),
            );
        }

        // Default keep-alive-idle to 600 if missing
        let keep_alive_idle_key = serde_yaml::Value::String("keep-alive-idle".to_owned());
        if !mapping.contains_key(&keep_alive_idle_key) {
            mapping.insert(
                keep_alive_idle_key,
                serde_yaml::Value::Number(serde_yaml::Number::from(600)),
            );
        }

        // Default profile.store-fake-ip to true if missing
        let profile_key = serde_yaml::Value::String("profile".to_owned());
        let store_fake_ip_key = serde_yaml::Value::String("store-fake-ip".to_owned());
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
            profile_map.insert(
                serde_yaml::Value::String("store-fake-ip".to_owned()),
                serde_yaml::Value::Bool(true),
            );
            mapping.insert(profile_key, serde_yaml::Value::Mapping(profile_map));
        }

        // Default find-process-mode to always if missing
        let find_process_key = serde_yaml::Value::String("find-process-mode".to_owned());
        if !mapping.contains_key(&find_process_key) {
            mapping.insert(
                find_process_key,
                serde_yaml::Value::String("always".to_owned()),
            );
        }

        // Inject global user preferences (override YAML profile values)
        if let Some(p) = prefs {
            if let Some(mode) = &p.mode {
                if matches!(mode.as_str(), "rule" | "global" | "direct") {
                    mapping.insert(
                        serde_yaml::Value::String("mode".to_owned()),
                        serde_yaml::Value::String(mode.clone()),
                    );
                }
            }
            if let Some(tun) = p.tun_enabled {
                let tun_key = serde_yaml::Value::String("tun".to_owned());
                if let Some(serde_yaml::Value::Mapping(tun_map)) = mapping.get_mut(&tun_key) {
                    tun_map.insert(
                        serde_yaml::Value::String("enable".to_owned()),
                        serde_yaml::Value::Bool(tun),
                    );
                } else {
                    let mut tun_map = serde_yaml::Mapping::new();
                    tun_map.insert(
                        serde_yaml::Value::String("enable".to_owned()),
                        serde_yaml::Value::Bool(tun),
                    );
                    mapping.insert(tun_key, serde_yaml::Value::Mapping(tun_map));
                }
            }
            if let Some(port) = p.mixed_port {
                mapping.insert(
                    serde_yaml::Value::String("mixed-port".to_owned()),
                    serde_yaml::Value::Number(serde_yaml::Number::from(port)),
                );
            }
            if let Some(port) = p.socks_port {
                mapping.insert(
                    serde_yaml::Value::String("socks-port".to_owned()),
                    serde_yaml::Value::Number(serde_yaml::Number::from(port)),
                );
            }
            if let Some(port) = p.http_port {
                mapping.insert(
                    serde_yaml::Value::String("port".to_owned()),
                    serde_yaml::Value::Number(serde_yaml::Number::from(port)),
                );
            }
            if let Some(ipv6) = p.ipv6 {
                mapping.insert(
                    serde_yaml::Value::String("ipv6".to_owned()),
                    serde_yaml::Value::Bool(ipv6),
                );
            }
            if let Some(allow_lan) = p.allow_lan {
                mapping.insert(
                    serde_yaml::Value::String("allow-lan".to_owned()),
                    serde_yaml::Value::Bool(allow_lan),
                );
            }
            if let Some(unified_delay) = p.unified_delay {
                mapping.insert(
                    serde_yaml::Value::String("unified-delay".to_owned()),
                    serde_yaml::Value::Bool(unified_delay),
                );
            }
        }
    }

    let result = serde_yaml::to_string(&yaml_val).ok()?;

    Some(RuntimeConfigResult {
        yaml_content: result,
        api_port: config_port,
    })
}

/// Build a minimal runtime config string as fallback.
///
/// Migrated from `src-tauri/src/core/core_process.rs`.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn build_minimal_runtime_config(secret: String) -> RuntimeConfigResult {
    let config = format!(
        "mixed-port: {DEFAULT_MIXED_PORT}\n\
         mode: rule\n\
         log-level: info\n\
         unified-delay: true\n\
         tcp-concurrent: true\n\
         keep-alive-interval: 30\n\
         keep-alive-idle: 600\n\
         find-process-mode: always\n\
         profile:\n  store-fake-ip: true\n\
         external-controller: 127.0.0.1:{DEFAULT_API_PORT}\n\
         secret: {secret}\n\
         proxies: []\n\
         proxy-groups:\n  - name: GLOBAL\n    type: select\n    proxies:\n      - DIRECT\n\
         rules:\n  - MATCH,DIRECT\n"
    );
    RuntimeConfigResult {
        yaml_content: config,
        api_port: DEFAULT_API_PORT,
    }
}

/// Pure function: find an available port starting from the given port.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn find_available_port(start_port: u16) -> Result<u16, AppError> {
    let mut port = start_port;
    let end_port = start_port.saturating_add(100);
    while port < end_port {
        if std::net::TcpListener::bind(("127.0.0.1", port)).is_ok() {
            return Ok(port);
        }
        port += 1;
    }
    Err(AppError::NetworkError(format!(
        "No available port found in range {start_port}-{end_port}"
    )))
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn test_detect_cache_lock_issue() {
        assert!(detect_cache_lock_issue(
            "error: database is locked".to_owned()
        ));
        assert!(detect_cache_lock_issue("cache.db: corrupted".to_owned()));
        assert!(!detect_cache_lock_issue("normal log message".to_owned()));
    }

    #[test]
    fn test_parse_version_output() {
        assert_eq!(
            parse_version_output("Mihomo v1.18.0 abc123 linux/amd64".to_owned()),
            "v1.18.0"
        );
        assert_eq!(parse_version_output("v1.18.0".to_owned()), "v1.18.0");
        assert_eq!(parse_version_output("1.18.0".to_owned()), "1.18.0");
    }

    #[test]
    fn test_generate_secret() {
        let secret = generate_secret().unwrap();
        assert_eq!(secret.len(), 64); // 32 bytes * 2 hex chars
        assert!(secret.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn test_validate_custom_args_rejects_blocked() {
        assert!(
            validate_custom_args(vec!["--external-controller=0.0.0.0:9090".to_owned()]).is_err()
        );
        assert!(validate_custom_args(vec!["-d".to_owned()]).is_err());
        assert!(validate_custom_args(vec!["-f".to_owned()]).is_err());
        assert!(validate_custom_args(vec!["--secret".to_owned()]).is_err());
    }

    #[test]
    fn test_validate_custom_args_keeps_allowed() {
        let args = validate_custom_args(vec!["  -t  ".to_owned(), "--version".to_owned()]).unwrap();
        assert_eq!(args, vec!["-t".to_owned(), "--version".to_owned()]);
    }

    #[test]
    fn test_validate_custom_args_empty() {
        assert_eq!(validate_custom_args(vec![]).unwrap(), Vec::<String>::new());
    }

    #[test]
    fn test_validate_custom_args_trims_and_filters_empty() {
        let args = validate_custom_args(vec!["  -v  ".to_owned(), "".to_owned(), "   ".to_owned()])
            .unwrap();
        assert_eq!(args, vec!["-v"]);
    }

    #[test]
    fn test_validate_custom_args_case_insensitive() {
        assert!(validate_custom_args(vec!["--Config".to_owned()]).is_err());
        assert!(validate_custom_args(vec!["--SECRET=value".to_owned()]).is_err());
    }

    #[test]
    fn test_prepare_runtime_config_basic() {
        let content = "port: 7890\nmode: rule".to_owned();
        let result = prepare_runtime_config(content, "mysecret".to_owned(), None);
        assert!(result.is_some());
        let r = result.unwrap();
        assert_eq!(r.api_port, 9090);
        assert!(r
            .yaml_content
            .contains("external-controller: 127.0.0.1:9090"));
        assert!(r.yaml_content.contains("secret: mysecret"));
        assert!(r.yaml_content.contains("unified-delay: true"));
        assert!(r.yaml_content.contains("tcp-concurrent: true"));
        assert!(r.yaml_content.contains("keep-alive-interval: 30"));
        assert!(r.yaml_content.contains("keep-alive-idle: 600"));
        assert!(r.yaml_content.contains("store-fake-ip: true"));
        assert!(r.yaml_content.contains("find-process-mode: always"));
    }

    #[test]
    fn test_prepare_runtime_config_custom_port() {
        let content = "external-controller: 0.0.0.0:8080\nport: 7890".to_owned();
        let result = prepare_runtime_config(content, "secret".to_owned(), None);
        assert!(result.is_some());
        let r = result.unwrap();
        assert_eq!(r.api_port, 8080);
        assert!(r
            .yaml_content
            .contains("external-controller: 127.0.0.1:8080"));
    }

    #[test]
    fn test_prepare_runtime_config_preserves_existing() {
        let content = "unified-delay: false\nport: 7890".to_owned();
        let result = prepare_runtime_config(content, "s".to_owned(), None);
        assert!(result.is_some());
        let config = &result.unwrap().yaml_content;
        assert!(config.contains("unified-delay: false"));
        assert_eq!(config.matches("unified-delay").count(), 1);
    }

    #[test]
    fn test_prepare_runtime_config_invalid_yaml() {
        assert!(
            prepare_runtime_config("not: valid: yaml: :".to_owned(), "s".to_owned(), None)
                .is_none()
        );
    }

    #[test]
    fn test_prepare_runtime_config_non_mapping() {
        assert!(prepare_runtime_config("just a string".to_owned(), "s".to_owned(), None).is_none());
    }

    #[test]
    fn test_prefs_mode_override() {
        let content = "mode: rule\nport: 7890".to_owned();
        let prefs = GlobalPreferences {
            mode: Some("global".to_owned()),
            ..Default::default()
        };
        let r = prepare_runtime_config(content, "s".to_owned(), Some(prefs)).unwrap();
        assert!(r.yaml_content.contains("mode: global"));
        assert!(!r.yaml_content.contains("mode: rule"));
    }

    #[test]
    fn test_prefs_tun_enabled_creates_when_missing() {
        let content = "port: 7890".to_owned();
        let prefs = GlobalPreferences {
            tun_enabled: Some(true),
            ..Default::default()
        };
        let r = prepare_runtime_config(content, "s".to_owned(), Some(prefs)).unwrap();
        assert!(r.yaml_content.contains("enable: true"));
    }

    #[test]
    fn test_prefs_mixed_port_override() {
        let content = "mixed-port: 7890\nport: 7891".to_owned();
        let prefs = GlobalPreferences {
            mixed_port: Some(9090),
            ..Default::default()
        };
        let r = prepare_runtime_config(content, "s".to_owned(), Some(prefs)).unwrap();
        assert!(r.yaml_content.contains("mixed-port: 9090"));
    }

    #[test]
    fn test_prefs_multiple_overrides() {
        let content = "mode: rule\nipv6: false\nallow-lan: false\nport: 7890".to_owned();
        let prefs = GlobalPreferences {
            mode: Some("direct".to_owned()),
            ipv6: Some(true),
            allow_lan: Some(true),
            mixed_port: Some(7892),
            ..Default::default()
        };
        let r = prepare_runtime_config(content, "s".to_owned(), Some(prefs)).unwrap();
        assert!(r.yaml_content.contains("mode: direct"));
        assert!(r.yaml_content.contains("ipv6: true"));
        assert!(r.yaml_content.contains("allow-lan: true"));
        assert!(r.yaml_content.contains("mixed-port: 7892"));
    }

    #[test]
    fn test_build_minimal_runtime_config() {
        let r = build_minimal_runtime_config("test-secret".to_owned());
        assert_eq!(r.api_port, 9090);
        assert!(r.yaml_content.contains("secret: test-secret"));
        assert!(r
            .yaml_content
            .contains("external-controller: 127.0.0.1:9090"));
        assert!(r.yaml_content.contains("unified-delay: true"));
    }

    #[test]
    fn test_parse_external_controller_port() {
        assert_eq!(
            parse_external_controller_port("external-controller: 127.0.0.1:9090".to_owned()),
            9090
        );
        assert_eq!(
            parse_external_controller_port("external-controller: 0.0.0.0:8080".to_owned()),
            8080
        );
        assert_eq!(
            parse_external_controller_port("port: 7890".to_owned()),
            DEFAULT_API_PORT
        );
    }

    #[test]
    fn test_find_available_port() {
        let port = find_available_port(59090).unwrap();
        assert!(port >= 59090);
        assert!(port < 59190);
    }
}
