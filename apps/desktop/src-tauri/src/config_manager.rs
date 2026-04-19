use crate::core_manager::ensure_app_storage;
use crate::core_manager::MihomoState;
use serde_json::Value as JsonValue;
use serde_yaml::{Mapping, Value as YamlValue};
use std::fs;
use std::path::Path;
use tauri::{AppHandle, State};

// ── ConfigIo trait for testable file operations ────────────────────────────

/// Trait for file system operations used by `config_manager`.
/// Allows mocking in tests while maintaining zero-overhead monomorphization in production.
#[cfg_attr(test, mockall::automock)]
pub(crate) trait ConfigIo {
    fn read_to_string(&self, path: &Path) -> Result<String, String>;
    fn write_file(&self, path: &Path, content: &str) -> Result<(), String>;
    fn path_exists(&self, path: &Path) -> bool;
}

/// Real filesystem implementation of `ConfigIo`.
pub(crate) struct RealConfigIo;

impl ConfigIo for RealConfigIo {
    fn read_to_string(&self, path: &Path) -> Result<String, String> {
        fs::read_to_string(path).map_err(|e| format!("Failed to read file: {e}"))
    }

    fn write_file(&self, path: &Path, content: &str) -> Result<(), String> {
        crate::core_manager::write_file_secure(path, content)
    }

    fn path_exists(&self, path: &Path) -> bool {
        path.exists()
    }
}

// ── Security settings extraction / restoration (pure functions) ─────────

/// Security-critical settings that must be preserved across config updates.
#[derive(Debug, Clone, PartialEq, Eq)]
struct SecuritySettings {
    external_controller: Option<String>,
    secret: Option<String>,
    tun_enabled: bool,
}

/// Extract security-critical settings from a YAML value before merge.
fn extract_security_settings(yaml: &YamlValue) -> SecuritySettings {
    SecuritySettings {
        external_controller: yaml
            .get("external-controller")
            .and_then(|v| v.as_str())
            .map(std::borrow::ToOwned::to_owned),
        secret: yaml
            .get("secret")
            .and_then(|v| v.as_str())
            .map(std::borrow::ToOwned::to_owned),
        tun_enabled: yaml
            .get("tun")
            .and_then(|tun| tun.get("enable"))
            .and_then(serde_yaml::Value::as_bool)
            .unwrap_or(false),
    }
}

/// Restore security-critical settings into a YAML mapping after merge.
fn restore_security_settings(yaml: &mut YamlValue, settings: &SecuritySettings) {
    let YamlValue::Mapping(ref mut map) = yaml else {
        return;
    };

    // Restore external-controller: always bind to localhost
    if let Some(ctrl) = &settings.external_controller {
        let port = ctrl.split(':').next_back().unwrap_or("9090");
        map.insert(
            YamlValue::String("external-controller".to_owned()),
            YamlValue::String(format!("127.0.0.1:{port}")),
        );
    } else {
        // No original, set secure default
        map.insert(
            YamlValue::String("external-controller".to_owned()),
            YamlValue::String("127.0.0.1:9090".to_owned()),
        );
    }

    // Restore original secret - never allow removal
    if let Some(secret) = &settings.secret {
        map.insert(
            YamlValue::String("secret".to_owned()),
            YamlValue::String(secret.clone()),
        );
    }

    // Protect TUN state - only allow changes through proper UI toggle
    if !settings.tun_enabled {
        if let Some(YamlValue::Mapping(ref mut tun_map)) =
            map.get_mut(YamlValue::String("tun".to_owned()))
        {
            tun_map.insert(
                YamlValue::String("enable".to_owned()),
                YamlValue::Bool(false),
            );
        }
    }
}

/// Remove the `secret` field from a YAML value to prevent credential leakage.
fn strip_secret_from_yaml(yaml: &mut YamlValue) {
    if let YamlValue::Mapping(ref mut map) = yaml {
        map.remove(YamlValue::String("secret".to_owned()));
    }
}

// ── Test-only public wrappers ───────────────────────────────────────────

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn read_config(app: AppHandle) -> Result<JsonValue, String> {
    let paths = ensure_app_storage(&app)?;
    let run_config_path = paths.core_dir.join("run_config.yaml");
    read_config_with_io(&RealConfigIo, &run_config_path)
}

/// Testable core of `read_config` that accepts a `ConfigIo` implementation.
pub(crate) fn read_config_with_io<I: ConfigIo>(
    io: &I,
    run_config_path: &Path,
) -> Result<JsonValue, String> {
    if !io.path_exists(run_config_path) {
        return Err("run_config.yaml not found".to_owned());
    }

    let content = io.read_to_string(run_config_path)?;

    let mut yaml_val: YamlValue =
        serde_yaml::from_str(&content).map_err(|e| format!("Failed to parse YAML: {e}"))?;

    // Security mitigation: Strip secret and external-controller to prevent credential leakage
    strip_secret_from_yaml(&mut yaml_val);

    let json_val: JsonValue = serde_json::to_value(yaml_val)
        .map_err(|e| format!("Failed to convert YAML to JSON: {e}"))?;

    Ok(json_val)
}

fn merge_yaml(base: &mut YamlValue, patch: &YamlValue, depth: usize) -> Result<(), String> {
    if depth > 50 {
        return Err("YAML nesting depth exceeded limit".to_owned());
    }
    match (base, patch) {
        (YamlValue::Mapping(a), YamlValue::Mapping(b)) => {
            for (k, v) in b {
                if v.is_null() {
                    a.remove(k);
                } else if let Some(a_v) = a.get_mut(k) {
                    merge_yaml(a_v, v, depth + 1)?;
                } else {
                    a.insert(k.clone(), v.clone());
                }
            }
        }
        (a, b) => {
            *a = b.clone();
        }
    }
    Ok(())
}

/// Result of config update operation with detailed status
#[derive(serde::Serialize)]
pub struct ConfigUpdateResult {
    /// Whether the config files were successfully written
    pub files_saved: bool,
    /// Whether the core hot reload succeeded
    pub hot_reload_success: bool,
    /// Human-readable status message
    pub message: String,
}

#[tauri::command]
pub async fn update_config(
    app: AppHandle,
    state: State<'_, MihomoState>,
    patch: JsonValue,
) -> Result<ConfigUpdateResult, String> {
    let paths = ensure_app_storage(&app)?;
    let run_config_path = paths.core_dir.join("run_config.yaml");

    // Steps 1-4: Read, merge, secure, write (testable core)
    let (current_yaml, _port_from_core) =
        update_config_core(&RealConfigIo, &run_config_path, &patch)?;

    // 5. Update original profile if it exists
    let (last_config_path, port, secret) = {
        let lock = state
            .0
            .lock()
            .map_err(|e| format!("Failed to lock state: {e}"))?;
        (
            lock.last_config_path.clone(),
            lock.last_port.unwrap_or(9090),
            lock.last_secret.clone(),
        )
    };

    if let Some(profile_name) = last_config_path {
        if profile_name != "run_config.yaml" {
            let profile_path = paths.profiles_dir.join(&profile_name);
            if profile_path.exists() {
                let profile_content = fs::read_to_string(&profile_path).unwrap_or_default();
                let patch_yaml: YamlValue = serde_yaml::to_value(&patch)
                    .map_err(|e| format!("Failed to convert JSON patch to YAML: {e}"))?;
                if let Ok(mut profile_yaml) = serde_yaml::from_str::<YamlValue>(&profile_content) {
                    if merge_yaml(&mut profile_yaml, &patch_yaml, 0).is_ok() {
                        if let Ok(new_profile_content) = serde_yaml::to_string(&profile_yaml) {
                            let _ = crate::core_manager::write_file_secure(
                                &profile_path,
                                &new_profile_content,
                            );
                        }
                    }
                }
            }
        }
    }

    // 6. Request Core Reload
    // First, try to find the actual port from run_config.yaml external-controller
    let actual_port = if let Some(ext_ctrl) = current_yaml
        .get("external-controller")
        .and_then(|v| v.as_str())
    {
        if let Some(p) = ext_ctrl.split(':').next_back() {
            p.parse::<u16>().unwrap_or(port)
        } else {
            port
        }
    } else {
        port
    };

    let client = reqwest::Client::builder()
        .no_proxy() // Force direct connection to local core, bypass system proxy
        .build()
        .map_err(|e| format!("failed to build HTTP client: {e}"))?;
    // For Mihomo, /configs requires PATCH for partial updates.
    let url = format!("http://127.0.0.1:{actual_port}/configs?force=true");
    let patch_yaml: YamlValue = serde_yaml::to_value(&patch)
        .map_err(|e| format!("Failed to convert JSON patch to YAML: {e}"))?;
    let mut req = client.patch(&url).json(&patch_yaml);

    if !secret.is_empty() {
        req = req.bearer_auth(secret);
    }

    // Attempt hot reload but don't fail if it doesn't work
    let mut hot_reload_success = false;
    let mut hot_reload_message = String::new();

    match req.send().await {
        Ok(res) => {
            let status = res.status();
            if status.is_success() {
                hot_reload_success = true;
            } else {
                let text = res.text().await.unwrap_or_default();
                println!("Warning: Core reload API returned non-success: {text}");
                hot_reload_message = format!("Hot reload returned status {status}");
            }
        }
        Err(e) => {
            println!("Warning: Failed to reload core via API: {e}");
            "Core API unavailable for hot reload".clone_into(&mut hot_reload_message);
        }
    }

    // Return detailed result so frontend can inform user appropriately
    let files_saved = true;
    let message = if hot_reload_success {
        "Configuration saved and applied successfully".to_owned()
    } else if !hot_reload_message.is_empty() {
        format!("Configuration saved. {hot_reload_message} - restart core to apply changes.")
    } else {
        "Configuration saved. Restart core to apply changes.".to_owned()
    };

    Ok(ConfigUpdateResult {
        files_saved,
        hot_reload_success,
        message,
    })
}

/// Testable core of `update_config` that handles merge + security settings.
/// Returns the merged YAML content and the extracted port.
pub(crate) fn update_config_core<I: ConfigIo>(
    io: &I,
    run_config_path: &Path,
    patch: &JsonValue,
) -> Result<(YamlValue, String), String> {
    // 1. Read existing config
    let mut current_yaml: YamlValue = if io.path_exists(run_config_path) {
        let content = io.read_to_string(run_config_path)?;
        serde_yaml::from_str(&content).unwrap_or_else(|_| YamlValue::Mapping(Mapping::new()))
    } else {
        YamlValue::Mapping(Mapping::new())
    };

    // 2. Convert patch to YAML
    let patch_yaml: YamlValue = serde_yaml::to_value(patch)
        .map_err(|e| format!("Failed to convert JSON patch to YAML: {e}"))?;

    // 3. SECURITY: Save and restore critical settings
    let security_settings = extract_security_settings(&current_yaml);
    merge_yaml(&mut current_yaml, &patch_yaml, 0)?;
    restore_security_settings(&mut current_yaml, &security_settings);

    // 4. Write back
    let new_content = serde_yaml::to_string(&current_yaml)
        .map_err(|e| format!("Failed to serialize YAML: {e}"))?;
    io.write_file(run_config_path, &new_content)?;

    // 5. Extract port for hot reload
    let port = current_yaml
        .get("external-controller")
        .and_then(|v| v.as_str())
        .and_then(|s| s.split(':').next_back())
        .and_then(|p| p.parse::<u16>().ok())
        .unwrap_or(9090);

    Ok((current_yaml, port.to_string()))
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    clippy::indexing_slicing,
    clippy::needless_borrows_for_generic_args
)]
mod tests {
    use super::*;
    use serde_yaml::Mapping;

    // ── merge_yaml tests ──────────────────────────────────────────────────

    #[test]
    fn test_update_config_basic_merge() {
        let mut base: YamlValue = serde_yaml::from_str("port: 7890\nmode: rule").unwrap();
        let patch: YamlValue = serde_yaml::from_str("mode: global\ndns:\n  enable: true").unwrap();
        merge_yaml(&mut base, &patch, 0).unwrap();

        let map = base.as_mapping().unwrap();
        assert_eq!(
            map.get(&YamlValue::String("mode".to_owned()))
                .unwrap()
                .as_str()
                .unwrap(),
            "global"
        );
        assert_eq!(
            map.get(&YamlValue::String("port".to_owned()))
                .unwrap()
                .as_i64()
                .unwrap(),
            7890
        );
        assert!(map.contains_key(&YamlValue::String("dns".to_owned())));
    }

    #[test]
    fn test_update_config_deep_merge() {
        let mut base: YamlValue =
            serde_yaml::from_str("dns:\n  enable: true\n  nameserver:\n    - 8.8.8.8").unwrap();
        let patch: YamlValue = serde_yaml::from_str("dns:\n  nameserver:\n    - 1.1.1.1").unwrap();
        merge_yaml(&mut base, &patch, 0).unwrap();

        let dns = base
            .as_mapping()
            .unwrap()
            .get(&YamlValue::String("dns".to_owned()))
            .unwrap()
            .as_mapping()
            .unwrap();
        assert!(dns
            .get(&YamlValue::String("enable".to_owned()))
            .unwrap()
            .as_bool()
            .unwrap());
        let ns = dns
            .get(&YamlValue::String("nameserver".to_owned()))
            .unwrap()
            .as_sequence()
            .unwrap();
        assert_eq!(ns.len(), 1);
        assert_eq!(ns[0].as_str().unwrap(), "1.1.1.1");
    }

    #[test]
    fn test_update_config_null_removes_key() {
        let mut base: YamlValue =
            serde_yaml::from_str("port: 7890\nmode: rule\nlog-level: info").unwrap();
        let patch: YamlValue = serde_yaml::from_str("mode: null\nlog-level: null").unwrap();
        merge_yaml(&mut base, &patch, 0).unwrap();

        let map = base.as_mapping().unwrap();
        assert!(!map.contains_key(&YamlValue::String("mode".to_owned())));
        assert!(!map.contains_key(&YamlValue::String("log-level".to_owned())));
        assert!(map.contains_key(&YamlValue::String("port".to_owned())));
    }

    #[test]
    fn test_update_config_preserves_security_settings() {
        let mut base: YamlValue = serde_yaml::from_str(
            "port: 7890\nexternal-controller: 127.0.0.1:9090\nsecret: my-secret-token",
        )
        .unwrap();

        let original_ext_ctrl = base
            .get("external-controller")
            .and_then(|v| v.as_str())
            .map(std::borrow::ToOwned::to_owned);
        let original_secret = base
            .get("secret")
            .and_then(|v| v.as_str())
            .map(std::borrow::ToOwned::to_owned);

        let patch: YamlValue =
            serde_yaml::from_str("external-controller: 0.0.0.0:9090\nsecret: hacked\nport: 8080")
                .unwrap();
        merge_yaml(&mut base, &patch, 0).unwrap();

        if let YamlValue::Mapping(ref mut map) = base {
            if let Some(original) = &original_ext_ctrl {
                let port = original.split(':').next_back().unwrap_or("9090");
                map.insert(
                    YamlValue::String("external-controller".to_owned()),
                    YamlValue::String(format!("127.0.0.1:{port}")),
                );
            }
            if let Some(secret) = &original_secret {
                map.insert(
                    YamlValue::String("secret".to_owned()),
                    YamlValue::String(secret.clone()),
                );
            }
        }

        let map = base.as_mapping().unwrap();
        assert_eq!(
            map.get(&YamlValue::String("external-controller".to_owned()))
                .unwrap()
                .as_str()
                .unwrap(),
            "127.0.0.1:9090"
        );
        assert_eq!(
            map.get(&YamlValue::String("secret".to_owned()))
                .unwrap()
                .as_str()
                .unwrap(),
            "my-secret-token"
        );
        assert_eq!(
            map.get(&YamlValue::String("port".to_owned()))
                .unwrap()
                .as_i64()
                .unwrap(),
            8080
        );
    }

    #[test]
    fn test_update_config_empty_patch() {
        let mut base: YamlValue = serde_yaml::from_str("port: 7890\nmode: rule").unwrap();
        let patch = YamlValue::Mapping(Mapping::new());
        merge_yaml(&mut base, &patch, 0).unwrap();

        let map = base.as_mapping().unwrap();
        assert_eq!(map.len(), 2);
        assert_eq!(
            map.get(&YamlValue::String("port".to_owned()))
                .unwrap()
                .as_i64()
                .unwrap(),
            7890
        );
    }

    #[test]
    fn test_update_config_empty_base() {
        let mut base = YamlValue::Mapping(Mapping::new());
        let patch: YamlValue = serde_yaml::from_str("port: 7890\nmode: global").unwrap();
        merge_yaml(&mut base, &patch, 0).unwrap();

        let map = base.as_mapping().unwrap();
        assert_eq!(map.len(), 2);
        assert_eq!(
            map.get(&YamlValue::String("port".to_owned()))
                .unwrap()
                .as_i64()
                .unwrap(),
            7890
        );
        assert_eq!(
            map.get(&YamlValue::String("mode".to_owned()))
                .unwrap()
                .as_str()
                .unwrap(),
            "global"
        );
    }

    #[test]
    fn test_update_config_scalar_replacement() {
        let mut base: YamlValue = serde_yaml::from_str("port: 7890").unwrap();
        let patch: YamlValue = serde_yaml::from_str("port: 1234").unwrap();
        merge_yaml(&mut base, &patch, 0).unwrap();

        assert_eq!(
            base.as_mapping()
                .unwrap()
                .get(&YamlValue::String("port".to_owned()))
                .unwrap()
                .as_i64()
                .unwrap(),
            1234
        );
    }

    // ── security_settings tests ───────────────────────────────────────────

    #[test]
    fn test_extract_security_settings_full() {
        let yaml: YamlValue = serde_yaml::from_str(
            "external-controller: 127.0.0.1:9090\nsecret: mysecret\ntun:\n  enable: true",
        )
        .unwrap();
        let settings = extract_security_settings(&yaml);
        assert_eq!(
            settings.external_controller,
            Some("127.0.0.1:9090".to_owned())
        );
        assert_eq!(settings.secret, Some("mysecret".to_owned()));
        assert!(settings.tun_enabled);
    }

    #[test]
    fn test_extract_security_settings_minimal() {
        let yaml: YamlValue = serde_yaml::from_str("port: 7890").unwrap();
        let settings = extract_security_settings(&yaml);
        assert_eq!(settings.external_controller, None);
        assert_eq!(settings.secret, None);
        assert!(!settings.tun_enabled);
    }

    #[test]
    fn test_extract_security_settings_tun_missing() {
        let yaml: YamlValue = serde_yaml::from_str("external-controller: 127.0.0.1:9090").unwrap();
        let settings = extract_security_settings(&yaml);
        assert!(!settings.tun_enabled);
    }

    #[test]
    fn test_extract_security_settings_tun_enable_false() {
        let yaml: YamlValue = serde_yaml::from_str("tun:\n  enable: false").unwrap();
        let settings = extract_security_settings(&yaml);
        assert!(!settings.tun_enabled);
    }

    #[test]
    fn test_extract_security_settings_empty_mapping() {
        let yaml: YamlValue = serde_yaml::from_str("{}").unwrap();
        let settings = extract_security_settings(&yaml);
        assert_eq!(settings.external_controller, None);
        assert_eq!(settings.secret, None);
        assert!(!settings.tun_enabled);
    }

    #[test]
    fn test_restore_security_settings_preserves_controller() {
        let mut yaml: YamlValue =
            serde_yaml::from_str("external-controller: 0.0.0.0:8080\nport: 7890").unwrap();
        let settings = SecuritySettings {
            external_controller: Some("127.0.0.1:9090".to_owned()),
            secret: Some("mysecret".to_owned()),
            tun_enabled: false,
        };
        restore_security_settings(&mut yaml, &settings);
        let ctrl = yaml.get("external-controller").unwrap().as_str().unwrap();
        assert!(ctrl.starts_with("127.0.0.1:"));
        assert!(ctrl.contains("9090"));
    }

    #[test]
    fn test_restore_security_settings_preserves_secret() {
        let mut yaml: YamlValue =
            serde_yaml::from_str("external-controller: 127.0.0.1:9090").unwrap();
        let settings = SecuritySettings {
            external_controller: Some("127.0.0.1:9090".to_owned()),
            secret: Some("mysecret".to_owned()),
            tun_enabled: false,
        };
        restore_security_settings(&mut yaml, &settings);
        assert_eq!(yaml.get("secret").unwrap().as_str().unwrap(), "mysecret");
    }

    #[test]
    fn test_restore_security_settings_preserves_tun() {
        let mut yaml: YamlValue =
            serde_yaml::from_str("tun:\n  enable: false\nport: 7890").unwrap();
        let settings = SecuritySettings {
            external_controller: None,
            secret: None,
            tun_enabled: true,
        };
        restore_security_settings(&mut yaml, &settings);
        assert!(!yaml
            .get("tun")
            .unwrap()
            .get("enable")
            .unwrap()
            .as_bool()
            .unwrap());
    }

    #[test]
    fn test_restore_security_settings_does_not_disable_tun_when_was_enabled() {
        let mut yaml: YamlValue = serde_yaml::from_str("tun:\n  enable: true\nport: 7890").unwrap();
        let settings = SecuritySettings {
            external_controller: None,
            secret: None,
            tun_enabled: true,
        };
        restore_security_settings(&mut yaml, &settings);
        assert!(yaml
            .get("tun")
            .unwrap()
            .get("enable")
            .unwrap()
            .as_bool()
            .unwrap());
    }

    #[test]
    fn test_restore_security_settings_forces_tun_off_when_was_disabled() {
        let mut yaml: YamlValue = serde_yaml::from_str("tun:\n  enable: true\nport: 7890").unwrap();
        let settings = SecuritySettings {
            external_controller: None,
            secret: None,
            tun_enabled: false,
        };
        restore_security_settings(&mut yaml, &settings);
        assert!(!yaml
            .get("tun")
            .unwrap()
            .get("enable")
            .unwrap()
            .as_bool()
            .unwrap());
    }

    #[test]
    fn test_restore_security_settings_no_original_controller_sets_default() {
        let mut yaml: YamlValue = serde_yaml::from_str("port: 7890").unwrap();
        let settings = SecuritySettings {
            external_controller: None,
            secret: None,
            tun_enabled: false,
        };
        restore_security_settings(&mut yaml, &settings);
        assert_eq!(
            yaml.get("external-controller").unwrap().as_str().unwrap(),
            "127.0.0.1:9090"
        );
    }

    #[test]
    fn test_restore_security_settings_no_secret_does_not_add_one() {
        let mut yaml: YamlValue = serde_yaml::from_str("port: 7890").unwrap();
        let settings = SecuritySettings {
            external_controller: None,
            secret: None,
            tun_enabled: false,
        };
        restore_security_settings(&mut yaml, &settings);
        assert!(yaml.get("secret").is_none());
    }

    #[test]
    fn test_restore_security_settings_non_mapping_noop() {
        let mut yaml: YamlValue = YamlValue::Null;
        let settings = SecuritySettings {
            external_controller: Some("127.0.0.1:9090".to_owned()),
            secret: Some("s".to_owned()),
            tun_enabled: false,
        };
        restore_security_settings(&mut yaml, &settings);
    }

    #[test]
    fn test_strip_secret_removes_secret() {
        let mut yaml: YamlValue = serde_yaml::from_str("secret: mysecret\nport: 7890").unwrap();
        strip_secret_from_yaml(&mut yaml);
        assert!(yaml.get("secret").is_none());
        assert_eq!(yaml.get("port").unwrap().as_i64().unwrap(), 7890);
    }

    #[test]
    fn test_strip_secret_no_secret_key() {
        let mut yaml: YamlValue = serde_yaml::from_str("port: 7890").unwrap();
        strip_secret_from_yaml(&mut yaml);
        assert_eq!(yaml.get("port").unwrap().as_i64().unwrap(), 7890);
    }

    #[test]
    fn test_strip_secret_non_mapping_noop() {
        let mut yaml: YamlValue = YamlValue::Null;
        strip_secret_from_yaml(&mut yaml);
    }

    #[test]
    fn test_extract_restore_roundtrip() {
        let original =
            "external-controller: 127.0.0.1:9090\nsecret: s3cret\ntun:\n  enable: true\nport: 7890";
        let mut yaml: YamlValue = serde_yaml::from_str(original).unwrap();
        let settings = extract_security_settings(&yaml);

        let patch: YamlValue = serde_yaml::from_str(
            "external-controller: 0.0.0.0:9090\nsecret: hacked\ntun:\n  enable: true\nport: 8080",
        )
        .unwrap();
        merge_yaml(&mut yaml, &patch, 0).unwrap();
        restore_security_settings(&mut yaml, &settings);

        let map = yaml.as_mapping().unwrap();
        assert_eq!(
            map.get(&YamlValue::String("external-controller".to_owned()))
                .unwrap()
                .as_str()
                .unwrap(),
            "127.0.0.1:9090"
        );
        assert_eq!(
            map.get(&YamlValue::String("secret".to_owned()))
                .unwrap()
                .as_str()
                .unwrap(),
            "s3cret"
        );
        assert_eq!(
            map.get(&YamlValue::String("port".to_owned()))
                .unwrap()
                .as_i64()
                .unwrap(),
            8080
        );
    }

    // ── Config integration tests (real filesystem) ────────────────────────

    fn write_temp_config(content: &str) -> (std::path::PathBuf, tempfile::TempDir) {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("run_config.yaml");
        fs::write(&path, content).unwrap();
        (path, dir)
    }

    #[test]
    fn test_read_config_real_fs_success() {
        let (path, _dir) = write_temp_config("port: 7890\nmode: rule\nsecret: mysecret\n");
        let io = RealConfigIo;
        let result = read_config_with_io(&io, &path).unwrap();
        assert_eq!(result["port"], 7890);
        assert_eq!(result["mode"], "rule");
        assert!(result.get("secret").is_none());
    }

    #[test]
    fn test_read_config_real_fs_secret_stripped() {
        let (path, _dir) = write_temp_config(
            "secret: supersecret\nport: 7890\nexternal-controller: 127.0.0.1:9090\n",
        );
        let io = RealConfigIo;
        let result = read_config_with_io(&io, &path).unwrap();
        assert!(result.get("secret").is_none());
        assert_eq!(result["port"], 7890);
        assert_eq!(result["external-controller"], "127.0.0.1:9090");
    }

    #[test]
    fn test_read_config_real_fs_file_not_found() {
        let path = std::path::PathBuf::from("/nonexistent/path/run_config.yaml");
        let io = RealConfigIo;
        let result = read_config_with_io(&io, &path);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("not found"));
    }

    #[test]
    fn test_read_config_real_fs_invalid_yaml() {
        let (path, _dir) = write_temp_config("not: valid: yaml: :");
        let io = RealConfigIo;
        let result = read_config_with_io(&io, &path);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Failed to parse YAML"));
    }

    #[test]
    fn test_read_config_real_fs_empty_config() {
        let (path, _dir) = write_temp_config("");
        let io = RealConfigIo;
        let result = read_config_with_io(&io, &path).unwrap();
        assert_eq!(result, serde_json::Value::Null);
    }

    #[test]
    fn test_read_config_real_fs_complex_yaml() {
        let config = r"port: 7890
mode: rule
log-level: info
dns:
  enable: true
  nameserver:
    - 8.8.8.8
    - 1.1.1.1
proxy-groups:
  - name: auto
    type: url-test
    proxies:
      - name: server1
        type: ss
        server: 1.2.3.4
        port: 443
";
        let (path, _dir) = write_temp_config(config);
        let io = RealConfigIo;
        let result = read_config_with_io(&io, &path).unwrap();
        assert_eq!(result["port"], 7890);
        assert!(result["dns"]["enable"].as_bool().unwrap());
        assert_eq!(result["dns"]["nameserver"][0], "8.8.8.8");
        assert_eq!(result["proxy-groups"][0]["name"], "auto");
    }

    #[test]
    fn test_update_config_core_real_fs_basic_merge() {
        let (path, _dir) = write_temp_config("port: 7890\nmode: rule\n");
        let io = RealConfigIo;

        let patch = serde_json::json!({"mode": "global", "log-level": "debug"});
        let (yaml, _port) = update_config_core(&io, &path, &patch).unwrap();

        assert_eq!(yaml["mode"], "global");
        assert_eq!(yaml["log-level"], "debug");
        assert_eq!(yaml["port"], 7890);

        let written = fs::read_to_string(&path).unwrap();
        assert!(written.contains("mode: global"));
        assert!(written.contains("port: 7890"));
    }

    #[test]
    fn test_update_config_core_real_fs_security_settings_restored() {
        let (path, _dir) = write_temp_config(
            "external-controller: 127.0.0.1:9090\nsecret: mysecret\nport: 7890\n",
        );
        let io = RealConfigIo;

        let patch = serde_json::json!({
            "external-controller": "0.0.0.0:8080",
            "secret": ""
        });
        let (yaml, _port) = update_config_core(&io, &path, &patch).unwrap();

        assert_eq!(yaml["secret"], "mysecret");
        let ctrl = yaml["external-controller"].as_str().unwrap();
        assert!(ctrl.starts_with("127.0.0.1:"));
        assert!(ctrl.contains("9090"));

        let written = fs::read_to_string(&path).unwrap();
        assert!(written.contains("secret: mysecret"));
        assert!(written.contains("127.0.0.1:9090"));
        assert!(!written.contains("0.0.0.0"));
    }

    #[test]
    fn test_update_config_core_real_fs_null_removes_key() {
        let (path, _dir) = write_temp_config("port: 7890\nmode: rule\nlog-level: info\n");
        let io = RealConfigIo;

        let patch = serde_json::json!({"log-level": null});
        let (yaml, _) = update_config_core(&io, &path, &patch).unwrap();

        assert!(yaml.get("log-level").is_none());
        assert_eq!(yaml["port"], 7890);
        assert_eq!(yaml["mode"], "rule");

        let written = fs::read_to_string(&path).unwrap();
        assert!(!written.contains("log-level"));
    }

    #[test]
    fn test_update_config_core_real_fs_empty_base() {
        let (path, _dir) = write_temp_config("");
        let io = RealConfigIo;

        let patch = serde_json::json!({"port": 7890, "mode": "rule"});
        let (yaml, _) = update_config_core(&io, &path, &patch).unwrap();

        assert_eq!(yaml["port"], 7890);
        assert_eq!(yaml["mode"], "rule");
    }

    #[test]
    fn test_update_config_core_real_fs_deep_merge() {
        let (path, _dir) =
            write_temp_config("dns:\n  enable: true\n  nameserver:\n    - 8.8.8.8\n");
        let io = RealConfigIo;

        let patch = serde_json::json!({"dns": {"nameserver": ["1.1.1.1"]}});
        let (yaml, _) = update_config_core(&io, &path, &patch).unwrap();

        assert!(yaml["dns"]["enable"].as_bool().unwrap());
        assert_eq!(yaml["dns"]["nameserver"][0], "1.1.1.1");
    }

    #[test]
    fn test_update_config_core_real_fs_default_port() {
        let (path, _dir) = write_temp_config("port: 7890\n");
        let io = RealConfigIo;

        let patch = serde_json::json!({"mode": "rule"});
        let (_, port) = update_config_core(&io, &path, &patch).unwrap();

        assert_eq!(port, "9090");
    }

    #[test]
    fn test_update_config_core_real_fs_custom_port() {
        let (path, _dir) = write_temp_config("external-controller: 127.0.0.1:8080\nport: 7890\n");
        let io = RealConfigIo;

        let patch = serde_json::json!({"mode": "global"});
        let (_, port) = update_config_core(&io, &path, &patch).unwrap();

        assert_eq!(port, "8080");
    }

    #[test]
    fn test_full_roundtrip_read_merge_write_read() {
        let (path, _dir) = write_temp_config(
            "external-controller: 127.0.0.1:9090\nsecret: mysecret\nport: 7890\nmode: rule\n",
        );
        let io = RealConfigIo;

        let original = read_config_with_io(&io, &path).unwrap();
        assert_eq!(original["port"], 7890);
        assert!(original.get("secret").is_none());

        let patch = serde_json::json!({"mode": "global", "log-level": "debug"});
        let (merged_yaml, port) = update_config_core(&io, &path, &patch).unwrap();
        assert_eq!(merged_yaml["mode"], "global");
        assert_eq!(merged_yaml["secret"], "mysecret");
        assert_eq!(port, "9090");

        let after = read_config_with_io(&io, &path).unwrap();
        assert_eq!(after["mode"], "global");
        assert_eq!(after["log-level"], "debug");
        assert_eq!(after["port"], 7890);
        assert!(after.get("secret").is_none());
    }

    #[test]
    fn test_full_roundtrip_security_cannot_be_overridden() {
        let (path, _dir) =
            write_temp_config("external-controller: 127.0.0.1:9090\nsecret: s3cret\nport: 7890\n");
        let io = RealConfigIo;

        for _ in 0..5 {
            let patch = serde_json::json!({
                "external-controller": "0.0.0.0:0",
                "secret": "hacked"
            });
            update_config_core(&io, &path, &patch).unwrap();
        }

        let final_config = read_config_with_io(&io, &path).unwrap();
        assert_eq!(final_config["external-controller"], "127.0.0.1:9090");
        assert!(final_config.get("secret").is_none());

        let raw = fs::read_to_string(&path).unwrap();
        assert!(raw.contains("secret: s3cret"));
        assert!(raw.contains("127.0.0.1:9090"));
        assert!(!raw.contains("0.0.0.0"));
        assert!(!raw.contains("hacked"));
    }

    #[test]
    fn test_full_roundtrip_tun_state_protected() {
        let (path, _dir) = write_temp_config(
            "external-controller: 127.0.0.1:9090\nport: 7890\ntun:\n  enable: false\n",
        );
        let io = RealConfigIo;

        let patch = serde_json::json!({"tun": {"enable": true}});
        let (yaml, _) = update_config_core(&io, &path, &patch).unwrap();

        assert!(!yaml["tun"]["enable"].as_bool().unwrap());
    }
}
