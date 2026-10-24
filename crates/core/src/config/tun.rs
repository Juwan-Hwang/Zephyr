//! TUN configuration pure functions — migrated from `src-tauri/src/core/tun_manager.rs`.
//!
//! Only the pure YAML manipulation functions are migrated.
//! Platform-specific process management (root, osascript, etc.) remains in src-tauri.

use serde_yaml as yaml;

use yaml::Value as YamlValue;

use crate::error::AppError;

/// Fast-path extraction for simple top-level scalar YAML values (`key: value`).
///
/// Avoids parsing the full YAML AST (which can take tens of milliseconds for large
/// subscription configs) by performing line scanning for unindented scalar key definitions.
/// Falls back to `serde_yaml::from_str` if complex YAML features (directives, tags,
/// anchors, aliases, multiline block scalars) or ambiguous structures are present.
fn extract_top_level_scalar_fast<'a>(content: &'a str, key: &str) -> Option<&'a str> {
    if content.contains("<<") || content.contains("%YAML") {
        return None;
    }

    let mut result = None;

    for line in content.lines() {
        let trimmed_line = line.trim();
        if trimmed_line.is_empty() || trimmed_line.starts_with('#') {
            continue;
        }

        // Directives or doc start/end markers requiring full parser
        if line.starts_with("---") || line.starts_with("...") {
            return None;
        }

        // Top-level key must have no leading whitespace
        if let Some(rest) = line.strip_prefix(key) {
            if let Some(after_colon) = rest.strip_prefix(':') {
                // YAML spec: key colon must be followed by whitespace, comment, or end-of-line
                if !after_colon.is_empty()
                    && !after_colon.starts_with(' ')
                    && !after_colon.starts_with('\t')
                    && !after_colon.starts_with('#')
                {
                    continue;
                }

                let val_raw = after_colon.trim();

                let val_trimmed = if let Some(rest_q) = val_raw.strip_prefix('"') {
                    // Double-quoted string
                    if let Some(close_idx) = rest_q.find('"') {
                        let inner = &rest_q[..close_idx];
                        if inner.contains('\\') {
                            return None;
                        }
                        let trailing = rest_q[close_idx + 1..].trim();
                        if !trailing.is_empty() && !trailing.starts_with('#') {
                            return None;
                        }
                        inner
                    } else {
                        return None;
                    }
                } else if let Some(rest_q) = val_raw.strip_prefix('\'') {
                    // Single-quoted string
                    if let Some(close_idx) = rest_q.find('\'') {
                        let inner = &rest_q[..close_idx];
                        if inner.contains('\'') {
                            return None;
                        }
                        let trailing = rest_q[close_idx + 1..].trim();
                        if !trailing.is_empty() && !trailing.starts_with('#') {
                            return None;
                        }
                        inner
                    } else {
                        return None;
                    }
                } else {
                    // Unquoted scalar
                    let mut val = val_raw;
                    if let Some(comment_pos) = val.find(" #") {
                        val = val[..comment_pos].trim();
                    } else if val.starts_with('#') {
                        val = "";
                    }

                    val.trim()
                };

                // Reject empty or complex structures (multiline scalars, maps, arrays, anchors/aliases)
                if val_trimmed.is_empty()
                    || val_trimmed.starts_with('|')
                    || val_trimmed.starts_with('>')
                    || val_trimmed.starts_with('{')
                    || val_trimmed.starts_with('[')
                    || val_trimmed.starts_with('&')
                    || val_trimmed.starts_with('*')
                    || val_trimmed.starts_with('!')
                {
                    return None;
                }

                result = Some(val_trimmed);
            }
        }
    }

    result
}

/// Fast-path extraction for `tun.enable` status from YAML config content.
///
/// Scans for top-level `tun:` block and inspects indented `enable:` keys without
/// parsing the full YAML tree. Falls back to `serde_yaml` for complex YAML.
fn extract_tun_enabled_fast(content: &str) -> Option<bool> {
    if content.contains("<<") || content.contains("%YAML") {
        return None;
    }

    let mut lines = content.lines().peekable();

    while let Some(line) = lines.next() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }

        if line.starts_with("---") || line.starts_with("...") {
            return None;
        }

        if let Some(after_colon_raw) = line.strip_prefix("tun:") {
            if !after_colon_raw.is_empty()
                && !after_colon_raw.starts_with(' ')
                && !after_colon_raw.starts_with('\t')
                && !after_colon_raw.starts_with('#')
            {
                continue;
            }

            let after_colon = after_colon_raw.trim();
            if !after_colon.is_empty() && !after_colon.starts_with('#') {
                // Inline scalar like `tun: true` or `tun: false`
                let mut val = after_colon;
                if let Some(pos) = val.find(" #") {
                    val = val[..pos].trim();
                }
                val = val.trim_matches(|c| c == '"' || c == '\'');
                if val.eq_ignore_ascii_case("true") {
                    return Some(true);
                } else if val.eq_ignore_ascii_case("false") {
                    return Some(false);
                }
                return None;
            }

            // `tun:` mapping block. Look for indented lines under `tun:`.
            let mut expected_indent: Option<usize> = None;

            while let Some(&next_line) = lines.peek() {
                let next_trimmed = next_line.trim();
                if next_trimmed.is_empty() || next_trimmed.starts_with('#') {
                    lines.next();
                    continue;
                }

                let indent = next_line.len() - next_line.trim_start().len();

                // If line is not indented at all, the `tun:` block has ended.
                if indent == 0 {
                    break;
                }

                // Establish the child indentation level of the `tun:` mapping
                let child_indent = *expected_indent.get_or_insert(indent);

                // If this line is indented further than the child level, it's inside a sub-mapping
                if indent > child_indent {
                    lines.next();
                    continue;
                }

                // If this line is less indented than the child level, the `tun:` mapping has ended
                if indent < child_indent {
                    break;
                }

                let indented = next_line.trim_start();
                if let Some(after_enable_raw) = indented.strip_prefix("enable:") {
                    if after_enable_raw.is_empty()
                        || after_enable_raw.starts_with(' ')
                        || after_enable_raw.starts_with('\t')
                        || after_enable_raw.starts_with('#')
                    {
                        let mut val = after_enable_raw.trim();
                        if !val.starts_with('"') && !val.starts_with('\'') {
                            if let Some(pos) = val.find(" #") {
                                val = val[..pos].trim();
                            }
                        }
                        val = val.trim_matches(|c| c == '"' || c == '\'');
                        if val.eq_ignore_ascii_case("true") {
                            return Some(true);
                        } else if val.eq_ignore_ascii_case("false") {
                            return Some(false);
                        }
                        return None;
                    }
                }

                lines.next();
            }

            // In YAML, if `tun:` exists as a mapping block but has no `enable:` field at the root of `tun:`, `tun.enable` is false.
            return Some(false);
        }
    }

    // No `tun:` section in content at all.
    Some(false)
}

/// Proxy mode a profile sets at top level (`mode:`), lowercased, when it is one
/// the app supports (`rule`, `global`, `direct`). `None` when the key is missing
/// or invalid, in which case mihomo runs `rule`.
#[must_use]
pub fn extract_mode_from_yaml(content: &str) -> Option<String> {
    if let Some(val) = extract_top_level_scalar_fast(content, "mode") {
        let lower = val.to_ascii_lowercase();
        if matches!(lower.as_str(), "rule" | "global" | "direct") {
            return Some(lower);
        }
    }

    let yaml_val: yaml::Value = yaml::from_str(content).ok()?;
    let mode = yaml_val.get("mode")?.as_str()?.to_ascii_lowercase();
    matches!(mode.as_str(), "rule" | "global" | "direct").then_some(mode)
}

/// Extract secret from YAML config content using the YAML parser.
/// This avoids issues with line-by-line parsing (multi-line strings, comments, etc.).
#[cfg_attr(feature = "uniffi", uniffi::export)]
#[must_use]
pub fn extract_secret_from_yaml(content: &str) -> Option<String> {
    if let Some(val) = extract_top_level_scalar_fast(content, "secret") {
        return Some(val.to_owned());
    }

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

/// Set the top-level controller `secret` in YAML config content.
///
/// Only the root key changes: a nested `secret:` inside a proxy, provider or
/// listener block is left alone, and `serde_yaml` quotes the value as needed.
pub fn set_secret_in_yaml(content: &str, secret: &str) -> Result<String, AppError> {
    let mut yaml_val = yaml::from_str::<YamlValue>(content)
        .map_err(|e| AppError::ParseError(format!("Failed to parse YAML config: {e}")))?;
    yaml_val
        .as_mapping_mut()
        .ok_or_else(|| AppError::ConfigError("YAML root is not a mapping".to_owned()))?
        .insert(
            YamlValue::String("secret".to_owned()),
            YamlValue::String(secret.to_owned()),
        );
    yaml::to_string(&yaml_val)
        .map_err(|e| AppError::ConfigError(format!("Failed to serialize YAML: {e}")))
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
    if let Some(enabled) = extract_tun_enabled_fast(content) {
        return enabled;
    }

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

    #[test]
    fn test_extract_mode_from_yaml() {
        assert_eq!(
            extract_mode_from_yaml("mode: Global\n").as_deref(),
            Some("global")
        );
        assert_eq!(
            extract_mode_from_yaml("mode: direct\nport: 1\n").as_deref(),
            Some("direct")
        );
        assert_eq!(extract_mode_from_yaml("port: 1\n"), None);
        assert_eq!(extract_mode_from_yaml("mode: script\n"), None);
        assert_eq!(extract_mode_from_yaml("tun:\n  mode: global\n"), None);
    }

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
    fn test_set_secret_in_yaml_only_touches_top_level() {
        let content = "secret: old\nproxies:\n  - name: a\n    secret: nested\n";
        let out = set_secret_in_yaml(content, "a#b: c").expect("secret update should succeed");
        assert_eq!(extract_secret_from_yaml(&out).as_deref(), Some("a#b: c"));
        let val: YamlValue = yaml::from_str(&out).expect("output should parse");
        let nested = val
            .get("proxies")
            .and_then(|p| p.get(0))
            .and_then(|p| p.get("secret"))
            .and_then(YamlValue::as_str);
        assert_eq!(nested, Some("nested"));
        let added =
            set_secret_in_yaml("mixed-port: 7890\n", "s1").expect("secret insert should succeed");
        assert_eq!(extract_secret_from_yaml(&added).as_deref(), Some("s1"));
        assert!(set_secret_in_yaml("- a\n", "s").is_err());
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

    #[test]
    fn test_extract_secret_with_quotes_and_comments() {
        let content_double = "secret: \"my_secret\" # comment\nport: 9090\n";
        assert_eq!(
            extract_secret_from_yaml(content_double),
            Some("my_secret".to_owned())
        );

        let content_single = "secret: 'my_secret' # comment\nport: 9090\n";
        assert_eq!(
            extract_secret_from_yaml(content_single),
            Some("my_secret".to_owned())
        );

        let content_unquoted = "secret: my_secret # comment\nport: 9090\n";
        assert_eq!(
            extract_secret_from_yaml(content_unquoted),
            Some("my_secret".to_owned())
        );
    }

    #[test]
    fn test_extract_mode_spec_colon_space() {
        // `mode:rule` has no space after colon, so in YAML it's a plain scalar "mode:rule" and not key `mode`.
        let content = "mode:rule\n";
        assert_eq!(extract_mode_from_yaml(content), None);
    }

    #[test]
    fn test_extract_tun_enabled_nested_map_override() {
        // `enable: false` under `device` (nested indentation) must be ignored;
        // `enable: true` at root of `tun:` must be matched.
        let content = "tun:\n  device:\n    enable: false\n  enable: true\n";
        assert!(extract_tun_enabled_from_yaml(content));
    }
}
