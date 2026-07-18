//! TUN configuration pure functions — migrated from `src-tauri/src/core/tun_manager.rs`.
//!
//! Only the pure YAML manipulation functions are migrated.
//! Platform-specific process management (root, osascript, etc.) remains in src-tauri.

use serde_yaml as yaml;

use yaml::Value as YamlValue;

use crate::error::AppError;

/// Extract secret from YAML config content using the YAML parser.
/// This avoids issues with line-by-line parsing (multi-line strings, comments, etc.).
#[cfg_attr(feature = "uniffi", uniffi::export)]
#[must_use]
pub fn extract_secret_from_yaml(content: &str) -> Option<String> {
    let yaml_val: yaml::Value = yaml::from_str(content).ok()?;
    yaml_val
        .get("secret")
        .and_then(|v| v.as_str())
        .map(str::to_owned)
}

/// Ensure dns-hijack list contains both UDP (`any:53`) and TCP (`tcp://any:53`) entries.
/// This prevents DNS leaks by hijacking all DNS traffic to mihomo.
pub fn ensure_dns_hijack_entries(tun_map: &mut yaml::Mapping) {
    const ANY_UDP: &str = "any:53";
    const ANY_TCP: &str = "tcp://any:53";

    let dns_hijack_key = YamlValue::String("dns-hijack".to_owned());
    let any_udp_val = YamlValue::String(ANY_UDP.to_owned());
    let any_tcp_val = YamlValue::String(ANY_TCP.to_owned());

    match tun_map.entry(dns_hijack_key) {
        yaml::mapping::Entry::Occupied(mut entry) => {
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
        yaml::mapping::Entry::Vacant(entry) => {
            // No dns-hijack entry - create new sequence
            entry.insert(YamlValue::Sequence(vec![any_udp_val, any_tcp_val]));
        }
    }
}

/// Update TUN enable setting in YAML config content using `serde_yaml`.
/// Returns updated content with TUN block modified or appended.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn update_tun_in_yaml(content: &str, enable: bool) -> Result<String, AppError> {
    let mut yaml_val = yaml::from_str::<YamlValue>(content)
        .map_err(|e| AppError::ParseError(format!("Failed to parse YAML config: {e}")))?;

    let mapping = yaml_val
        .as_mapping_mut()
        .ok_or_else(|| AppError::ConfigError("YAML root is not a mapping".to_owned()))?;
    // Ensure tun key is a Mapping — replace if it's a non-mapping type (e.g. `tun: false`, `tun: null`)
    let tun_key = YamlValue::String("tun".to_owned());
    if !mapping.get(&tun_key).is_some_and(YamlValue::is_mapping) {
        mapping.insert(tun_key.clone(), YamlValue::Mapping(yaml::Mapping::new()));
    }
    let tun = mapping
        .get_mut(&tun_key)
        .and_then(YamlValue::as_mapping_mut)
        .ok_or_else(|| AppError::ConfigError("Failed to get tun mapping".to_owned()))?;
    tun.insert(
        YamlValue::String("enable".to_owned()),
        YamlValue::Bool(enable),
    );
    // Preserve sensible defaults when enabling TUN
    if enable {
        tun.entry(YamlValue::String("stack".to_owned()))
            .or_insert_with(|| YamlValue::String("system".to_owned()));
        tun.entry(YamlValue::String("auto-route".to_owned()))
            .or_insert_with(|| YamlValue::Bool(true));
        tun.entry(YamlValue::String("auto-detect-interface".to_owned()))
            .or_insert_with(|| YamlValue::Bool(true));
        // Hijack all DNS traffic to prevent leaks (UDP + TCP)
        ensure_dns_hijack_entries(tun);
    }

    yaml::to_string(&yaml_val).map_err(|e| {
        AppError::ConfigError(format!("Failed to serialize YAML after TUN toggle: {e}"))
    })
}

/// Inject TUN file descriptor into YAML config content for Android VPN Service.
///
/// On Android, mihomo cannot create its own TUN device (netlink is banned).
/// Instead, Android `VpnService` creates the TUN interface and passes the fd
/// to mihomo via the `tun.fd` config field. This function reliably injects
/// the fd using `serde_yaml` (not regex), and enables `auto-route` and
/// `auto-detect-interface` since VPN Service requires mihomo to handle routing
/// through the TUN interface.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn inject_tun_fd(content: &str, fd: i32) -> Result<String, AppError> {
    let mut yaml_val = yaml::from_str::<YamlValue>(content)
        .map_err(|e| AppError::ParseError(format!("Failed to parse YAML config: {e}")))?;

    if let Some(mapping) = yaml_val.as_mapping_mut() {
        // Disable process matching on Android — non-root apps cannot read
        // /data/system/packages.xml which mihomo needs for Android package rules.
        // Without this, TUN startup fails with:
        //   "build android rules: read packages list: open /data/system/packages.xml: permission denied"
        mapping.insert(
            YamlValue::String("find-process-mode".to_owned()),
            YamlValue::String("off".to_owned()),
        );

        // Ensure tun key is a Mapping — replace if it's a non-mapping type (e.g. `tun: false`, `tun: null`)
        let tun_key = YamlValue::String("tun".to_owned());
        if !mapping.get(&tun_key).is_some_and(YamlValue::is_mapping) {
            mapping.insert(tun_key.clone(), YamlValue::Mapping(yaml::Mapping::new()));
        }
        if let Some(tun_map) = mapping
            .get_mut(&tun_key)
            .and_then(YamlValue::as_mapping_mut)
        {
            // Inject the VPN Service TUN fd
            tun_map.insert(
                YamlValue::String("fd".to_owned()),
                YamlValue::Number(fd.into()),
            );
            // On Android with VPN Service, mihomo needs auto-route to set up
            // proper routing rules including fwmark-based bypass for its own
            // outbound connections. Without auto-route, mihomo cannot detect
            // the real network interface and all connections will loop back
            // through the VPN tunnel.
            // The netlink error ("netlink socket in Android is banned by Google")
            // is non-fatal — mihomo falls back to alternative methods.
            tun_map
                .entry(YamlValue::String("auto-route".to_owned()))
                .or_insert_with(|| YamlValue::Bool(true));
            tun_map
                .entry(YamlValue::String("auto-detect-interface".to_owned()))
                .or_insert_with(|| YamlValue::Bool(true));
        }
    }

    yaml::to_string(&yaml_val).map_err(|e| {
        AppError::ConfigError(format!("Failed to serialize YAML after fd injection: {e}"))
    })
}

/// Extract TUN enable status from YAML config content using `serde_yaml`.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn extract_tun_enabled_from_yaml(content: &str) -> bool {
    let yaml_val = match yaml::from_str::<YamlValue>(content) {
        Ok(v) => v,
        Err(_) => return false,
    };

    yaml_val
        .get("tun")
        .and_then(|t| t.get("enable"))
        .and_then(YamlValue::as_bool)
        .unwrap_or(false)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    // Helper to extract dns-hijack values from YAML string
    fn extract_dns_hijack(content: &str) -> Option<Vec<String>> {
        let yaml_val = yaml::from_str::<YamlValue>(content).ok()?;
        let mapping = yaml_val.as_mapping()?;
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
        let content = "proxies:\n  - name: test\n";
        let updated = update_tun_in_yaml(content, true).expect("YAML update should succeed");

        let hijack = extract_dns_hijack(&updated).expect("should have dns-hijack");
        assert!(hijack.contains(&"any:53".to_owned()));
        assert!(hijack.contains(&"tcp://any:53".to_owned()));
    }

    #[test]
    fn test_update_tun_enable_no_dns_hijack() {
        let content = "tun:\n  enable: false\n  stack: system\n";
        let updated = update_tun_in_yaml(content, true).expect("YAML update should succeed");

        let hijack = extract_dns_hijack(&updated).expect("should have dns-hijack");
        assert!(hijack.contains(&"any:53".to_owned()));
        assert!(hijack.contains(&"tcp://any:53".to_owned()));
    }

    #[test]
    fn test_update_tun_enable_empty_dns_hijack() {
        let content = "tun:\n  enable: false\n  dns-hijack: []\n";
        let updated = update_tun_in_yaml(content, true).expect("YAML update should succeed");

        let hijack = extract_dns_hijack(&updated).expect("should have dns-hijack");
        assert!(hijack.contains(&"any:53".to_owned()));
        assert!(hijack.contains(&"tcp://any:53".to_owned()));
    }

    #[test]
    fn test_update_tun_enable_partial_dns_hijack_udp_only() {
        let content = "tun:\n  enable: false\n  dns-hijack:\n    - any:53\n";
        let updated = update_tun_in_yaml(content, true).expect("YAML update should succeed");

        let hijack = extract_dns_hijack(&updated).expect("should have dns-hijack");
        assert!(hijack.contains(&"any:53".to_owned()));
        assert!(hijack.contains(&"tcp://any:53".to_owned()));
    }

    #[test]
    fn test_update_tun_enable_partial_dns_hijack_tcp_only() {
        let content = "tun:\n  enable: false\n  dns-hijack:\n    - tcp://any:53\n";
        let updated = update_tun_in_yaml(content, true).expect("YAML update should succeed");

        let hijack = extract_dns_hijack(&updated).expect("should have dns-hijack");
        assert!(hijack.contains(&"any:53".to_owned()));
        assert!(hijack.contains(&"tcp://any:53".to_owned()));
    }

    #[test]
    fn test_update_tun_enable_complete_dns_hijack_unchanged() {
        let content = "tun:\n  enable: false\n  dns-hijack:\n    - any:53\n    - tcp://any:53\n";
        let updated = update_tun_in_yaml(content, true).expect("YAML update should succeed");

        let hijack = extract_dns_hijack(&updated).expect("should have dns-hijack");
        assert_eq!(hijack.len(), 2);
        assert!(hijack.contains(&"any:53".to_owned()));
        assert!(hijack.contains(&"tcp://any:53".to_owned()));
    }

    #[test]
    fn test_update_tun_enable_dns_hijack_wrong_type() {
        let content = "tun:\n  enable: false\n  dns-hijack: \"any:53\"\n";
        let updated = update_tun_in_yaml(content, true).expect("YAML update should succeed");

        let hijack = extract_dns_hijack(&updated).expect("should have dns-hijack");
        assert!(hijack.contains(&"any:53".to_owned()));
        assert!(hijack.contains(&"tcp://any:53".to_owned()));
    }

    #[test]
    fn test_update_tun_disable_no_dns_hijack_added() {
        let content = "tun:\n  enable: true\n";
        let updated = update_tun_in_yaml(content, false).expect("YAML update should succeed");

        let yaml_val = yaml::from_str::<YamlValue>(&updated).expect("valid yaml");
        let tun = yaml_val
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
        let mut tun_map = yaml::Mapping::new();
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

    #[test]
    fn test_extract_secret_from_yaml() {
        let content = "secret: mysecret\nport: 9090\n";
        assert_eq!(
            extract_secret_from_yaml(content),
            Some("mysecret".to_owned())
        );
    }

    #[test]
    fn test_extract_secret_from_yaml_missing() {
        let content = "port: 9090\n";
        assert_eq!(extract_secret_from_yaml(content), None);
    }

    #[test]
    fn test_extract_tun_enabled_from_yaml() {
        let content = "tun:\n  enable: true\n";
        assert!(extract_tun_enabled_from_yaml(content));
    }

    #[test]
    fn test_extract_tun_disabled_from_yaml() {
        let content = "tun:\n  enable: false\n";
        assert!(!extract_tun_enabled_from_yaml(content));
    }

    #[test]
    fn test_extract_tun_missing_from_yaml() {
        let content = "port: 9090\n";
        assert!(!extract_tun_enabled_from_yaml(content));
    }
}
