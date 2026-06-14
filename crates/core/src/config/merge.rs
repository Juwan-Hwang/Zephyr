//! YAML merge logic and security settings protection — platform-agnostic.
//!
//! Migrated from `src-tauri/src/config_manager.rs` for cross-platform reuse.

use serde_json::Value as JsonValue;
use serde_yaml::{Mapping, Value as YamlValue};

use super::sanitizer::remove_dangerous_keys_internal_pub;

// ── Security settings extraction / restoration (pure functions) ─────────

/// Security-critical settings that must be preserved across config updates.
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SecuritySettings {
    pub external_controller: Option<String>,
    pub secret: Option<String>,
    pub tun_enabled: bool,
}

/// Extract security-critical settings from a YAML value before merge.
pub fn extract_security_settings(yaml: &YamlValue) -> SecuritySettings {
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
pub fn restore_security_settings(yaml: &mut YamlValue, settings: &SecuritySettings) {
    let YamlValue::Mapping(ref mut map) = yaml else {
        return;
    };

    // Restore external-controller: always bind to localhost
    if let Some(ctrl) = &settings.external_controller {
        let raw_port = ctrl.split(':').next_back().unwrap_or("9090");
        // Validate that the extracted port is actually a valid u16 port number.
        // If external_controller is configured without a port (e.g. just "127.0.0.1"),
        // next_back() would return the entire string, producing an invalid address.
        let port = raw_port.parse::<u16>().map_or("9090", |_| raw_port);
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
pub fn strip_secret_from_yaml(yaml: &mut YamlValue) {
    if let YamlValue::Mapping(ref mut map) = yaml {
        map.remove(YamlValue::String("secret".to_owned()));
    }
}

/// Recursively merge a patch into a base YAML value.
/// Null values in the patch remove the corresponding key from base.
pub fn merge_yaml(base: &mut YamlValue, patch: &YamlValue, depth: usize) -> Result<(), String> {
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

fn merge_yaml_owned(base: &mut YamlValue, patch: YamlValue, depth: usize) -> Result<(), String> {
    if depth > 50 {
        return Err("YAML nesting depth exceeded limit".to_owned());
    }
    match (base, patch) {
        (YamlValue::Mapping(a), YamlValue::Mapping(b)) => {
            for (k, v) in b {
                if v.is_null() {
                    a.remove(&k);
                } else if let Some(a_v) = a.get_mut(&k) {
                    merge_yaml_owned(a_v, v, depth + 1)?;
                } else {
                    a.insert(k, v);
                }
            }
        }
        (a, b) => {
            *a = b;
        }
    }
    Ok(())
}

// ── ConfigIo trait for testable file operations ────────────────────────────

/// Trait for file system operations used by config management.
/// Allows mocking in tests while maintaining zero-overhead monomorphization in production.
pub trait ConfigIo {
    fn read_to_string(&self, path: &std::path::Path) -> Result<String, String>;
    fn write_file(&self, path: &std::path::Path, content: &str) -> Result<(), String>;
    fn path_exists(&self, path: &std::path::Path) -> bool;
}

/// Testable core of `read_config` that accepts a `ConfigIo` implementation.
pub fn read_config_with_io<I: ConfigIo>(
    io: &I,
    run_config_path: &std::path::Path,
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

/// Testable core of `update_config` that handles merge + security settings.
/// Returns the merged YAML content and the extracted port.
pub fn update_config_core<I: ConfigIo>(
    io: &I,
    run_config_path: &std::path::Path,
    patch: &JsonValue,
) -> Result<(YamlValue, String), String> {
    // 1. Read existing config
    let mut current_yaml: YamlValue = if io.path_exists(run_config_path) {
        let content = io.read_to_string(run_config_path)?;
        serde_yaml::from_str(&content)
            .map_err(|e| format!("Failed to parse run_config.yaml: {e}"))?
    } else {
        YamlValue::Mapping(Mapping::new())
    };

    // 2. Convert patch to YAML
    let patch_yaml: YamlValue = serde_yaml::to_value(patch)
        .map_err(|e| format!("Failed to convert JSON patch to YAML: {e}"))?;

    // 3. SECURITY: Remove dangerous keys before merging
    remove_dangerous_keys_internal_pub(&mut current_yaml, false);
    let security_settings = extract_security_settings(&current_yaml);
    merge_yaml_owned(&mut current_yaml, patch_yaml, 0)?;
    remove_dangerous_keys_internal_pub(&mut current_yaml, false);
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

/// Mask URL for safe display in UI (hide sensitive host, path, and query parts)
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn mask_url(url: String) -> String {
    if let Ok(parsed) = url::Url::parse(&url) {
        let host = parsed.host_str().unwrap_or("???");
        let masked_host = if host.len() > 6 {
            format!("{}***{}", &host[..3], &host[host.len() - 3..])
        } else {
            "***".to_owned()
        };
        // Only show scheme + masked host; hide path and query entirely
        format!("{}://{masked_host}/***", parsed.scheme())
    } else {
        "***".to_owned()
    }
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    clippy::indexing_slicing,
    clippy::needless_borrows_for_generic_args
)]
mod tests {
    use super::*;

    #[test]
    fn test_merge_yaml_basic() {
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
    fn test_merge_yaml_null_removes_key() {
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
    fn test_strip_secret_removes_secret() {
        let mut yaml: YamlValue = serde_yaml::from_str("secret: mysecret\nport: 7890").unwrap();
        strip_secret_from_yaml(&mut yaml);
        assert!(yaml.get("secret").is_none());
        assert_eq!(yaml.get("port").unwrap().as_i64().unwrap(), 7890);
    }

    #[test]
    fn test_mask_url_long_domain() {
        let result = mask_url(
            "https://very-long-domain-name.example.com/path/to/config?token=secret".to_owned(),
        );
        assert!(result.contains("***"));
        assert!(!result.contains("very-long-domain-name"));
        assert!(!result.contains("secret"));
    }

    #[test]
    fn test_mask_url_invalid() {
        let result = mask_url("not-a-url".to_owned());
        assert_eq!(result, "***");
    }

    #[test]
    fn test_mask_url_preserves_scheme() {
        let result = mask_url("https://example.com/path".to_owned());
        assert!(result.starts_with("https://"));
    }
}
