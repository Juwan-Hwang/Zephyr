//! YAML merge logic and security settings protection — platform-agnostic.
//!
//! Migrated from `src-tauri/src/config_manager.rs` for cross-platform reuse.

use serde_json::Value as JsonValue;
use serde_yaml::{Mapping, Value as YamlValue};

use super::sanitizer::{
    remove_control_plane_keys, remove_dangerous_keys_internal_pub, remove_keys_resolved,
    resolved_key_str,
};

// ── Security settings extraction / restoration (pure functions) ─────────

/// Security-critical settings that must be preserved across config updates.
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SecuritySettings {
    pub external_controller: Option<String>,
    pub secret: Option<String>,
    pub tun_enabled: bool,
}

/// The value of the entry of mapping `yaml` whose key names `name`, also one
/// written with a local tag (`!custom tun`), which mihomo reads the same.
fn resolved_get<'a>(yaml: &'a YamlValue, name: &str) -> Option<&'a YamlValue> {
    yaml.as_mapping()?
        .iter()
        .find(|(k, _)| resolved_key_str(k) == Some(name))
        .map(|(_, v)| v)
}

/// Extract security-critical settings from a YAML value before merge.
pub fn extract_security_settings(yaml: &YamlValue) -> SecuritySettings {
    SecuritySettings {
        external_controller: resolved_get(yaml, "external-controller")
            .and_then(|v| v.as_str())
            .map(std::borrow::ToOwned::to_owned),
        secret: resolved_get(yaml, "secret")
            .and_then(|v| v.as_str())
            .map(std::borrow::ToOwned::to_owned),
        tun_enabled: resolved_get(yaml, "tun")
            .and_then(|tun| resolved_get(tun, "enable"))
            .and_then(serde_yaml::Value::as_bool)
            .unwrap_or(false),
    }
}

/// Restore security-critical settings into a YAML mapping after merge.
///
/// Besides pinning `external-controller` / `secret`, this also drops any
/// controller surface the app does not manage (unix socket / named pipe /
/// TLS listeners, CORS, the `DoH` server, external UI), since those either bypass
/// `secret` or widen the controller's exposure.
pub fn restore_security_settings(yaml: &mut YamlValue, settings: &SecuritySettings) {
    remove_control_plane_keys(yaml);
    // A tagged root (`!cfg {...}`) is still the config: a patch merges into
    // it, so the pinning below has to reach it too (`as_mapping_mut` looks
    // through the tag).
    let Some(map) = yaml.as_mapping_mut() else {
        return;
    };

    // The app-managed values below replace any existing entry, including one
    // written with an explicit tag (`!!str secret`) that mihomo resolves to the
    // same key; otherwise both would survive and the config would carry two
    // conflicting controller/secret settings.
    remove_keys_resolved(map, &["external-controller"]);
    if settings.secret.is_some() {
        remove_keys_resolved(map, &["secret"]);
    }

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

    // Protect TUN state - only allow changes through proper UI toggle. Every
    // `tun` entry counts, a tagged one (`!custom tun`) too, and so does a
    // tagged `enable` inside it.
    if !settings.tun_enabled {
        for (key, value) in map.iter_mut() {
            if resolved_key_str(key) != Some("tun") {
                continue;
            }
            // `as_mapping_mut` looks through a tag (`!m`) on the value.
            if let Some(tun_map) = value.as_mapping_mut() {
                remove_keys_resolved(tun_map, &["enable"]);
                tun_map.insert(
                    YamlValue::String("enable".to_owned()),
                    YamlValue::Bool(false),
                );
            }
        }
    }
}

/// Remove the `secret` field from a YAML value to prevent credential leakage:
/// also one written with a tag (`!custom secret`), and also from a tagged
/// root.
pub fn strip_secret_from_yaml(yaml: &mut YamlValue) {
    if let Some(map) = yaml.as_mapping_mut() {
        remove_keys_resolved(map, &["secret"]);
    }
}

/// The key of `map` written with a local tag (`!custom mode`) that names the
/// same entry as `key`. mihomo reads such a key as the plain name, so a patch
/// must change that entry rather than add a second one beside it. Only
/// looked up when the plain key is missing.
fn tagged_twin(map: &Mapping, key: &YamlValue) -> Option<YamlValue> {
    let name = resolved_key_str(key)?;
    map.keys()
        .find(|k| matches!(k, YamlValue::Tagged(_)) && resolved_key_str(k) == Some(name))
        .cloned()
}

/// Remove `key` from `map`, and an entry with a local tag that names it too.
fn remove_entry(map: &mut Mapping, key: &YamlValue) {
    map.remove(key);
    while let Some(twin) = tagged_twin(map, key) {
        map.remove(&twin);
    }
}

/// Recursively merge a patch into a base YAML value.
/// Null values in the patch remove the corresponding key from base.
/// A key the base writes with a local tag is the same key.
pub fn merge_yaml(base: &mut YamlValue, patch: &YamlValue, depth: usize) -> Result<(), String> {
    if depth > 50 {
        return Err("YAML nesting depth exceeded limit".to_owned());
    }
    match (base, patch) {
        (YamlValue::Mapping(a), YamlValue::Mapping(b)) => {
            for (k, v) in b {
                if v.is_null() {
                    remove_entry(a, k);
                } else if let Some(a_v) = a.get_mut(k) {
                    merge_yaml(a_v, v, depth + 1)?;
                } else if let Some(a_v) = tagged_twin(a, k).and_then(|twin| a.get_mut(&twin)) {
                    merge_yaml(a_v, v, depth + 1)?;
                } else {
                    a.insert(k.clone(), v.clone());
                }
            }
        }
        // A tagged mapping (`tun: !custom {...}`) is still that mapping: the
        // patch goes into it and the tag stays.
        (YamlValue::Tagged(tagged), b @ YamlValue::Mapping(_))
            if matches!(tagged.value, YamlValue::Mapping(_)) =>
        {
            merge_yaml(&mut tagged.value, b, depth + 1)?;
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
                    remove_entry(a, &k);
                } else if let Some(a_v) = a.get_mut(&k) {
                    merge_yaml_owned(a_v, v, depth + 1)?;
                } else if let Some(a_v) = tagged_twin(a, &k).and_then(|twin| a.get_mut(&twin)) {
                    merge_yaml_owned(a_v, v, depth + 1)?;
                } else {
                    a.insert(k, v);
                }
            }
        }
        // As in merge_yaml: the patch goes into a tagged mapping.
        (YamlValue::Tagged(tagged), b @ YamlValue::Mapping(_))
            if matches!(tagged.value, YamlValue::Mapping(_)) =>
        {
            merge_yaml_owned(&mut tagged.value, b, depth + 1)?;
        }
        (a, b) => {
            *a = b;
        }
    }
    Ok(())
}

/// Drop every `<<` merge key from a patch, at any depth. The app's pages
/// never send one; a merge source would bring in values (`tun.enable`) that
/// the security restore checks only as plain entries. A patch nested deeper
/// than the merge allows is refused.
#[allow(clippy::wildcard_enum_match_arm)]
fn strip_patch_merge_keys(value: &mut YamlValue, depth: usize) -> Result<(), String> {
    if depth > 50 {
        return Err("YAML nesting depth exceeded limit".to_owned());
    }
    match value {
        YamlValue::Mapping(map) => {
            remove_keys_resolved(map, &["<<"]);
            map.iter_mut()
                .try_for_each(|(_, child)| strip_patch_merge_keys(child, depth + 1))
        }
        YamlValue::Sequence(seq) => seq
            .iter_mut()
            .try_for_each(|item| strip_patch_merge_keys(item, depth + 1)),
        YamlValue::Tagged(tagged) => strip_patch_merge_keys(&mut tagged.value, depth + 1),
        _ => Ok(()),
    }
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
    // A patch sets config keys. Anything but an object would replace the
    // whole config instead of merging into it.
    if !patch.is_object() {
        return Err("Config patch must be an object of config keys".to_owned());
    }

    // 1. Read existing config
    let mut current_yaml: YamlValue = if io.path_exists(run_config_path) {
        let content = io.read_to_string(run_config_path)?;
        serde_yaml::from_str(&content)
            .map_err(|e| format!("Failed to parse run_config.yaml: {e}"))?
    } else {
        YamlValue::Mapping(Mapping::new())
    };

    // 2. Convert patch to YAML
    let mut patch_yaml: YamlValue = serde_yaml::to_value(patch)
        .map_err(|e| format!("Failed to convert JSON patch to YAML: {e}"))?;
    strip_patch_merge_keys(&mut patch_yaml, 0)?;

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

/// Appends masked URL directly into `out` without intermediate heap allocations.
///
/// Optimization:
/// - Accepts `&str` to avoid allocating `String`s for URL substrings.
/// - Slices borrowed sub-slices for prefix and suffix instead of collecting into `String`.
/// - Writes directly into `out` buffer instead of multiple `format!()` intermediate allocations.
pub fn format_masked_url_to(url_str: &str, out: &mut String) -> bool {
    if let Ok(parsed) = url::Url::parse(url_str) {
        let host = parsed.host_str().unwrap_or("???");
        let char_count = host.chars().count();
        out.push_str(parsed.scheme());
        out.push_str("://");

        if char_count > 6 {
            // Find UTF-8 byte boundary for first 3 chars
            let prefix_end = host
                .char_indices()
                .nth(3)
                .map_or(host.len(), |(idx, _)| idx);
            // Find UTF-8 byte boundary for last 3 chars
            let suffix_start = host
                .char_indices()
                .nth(char_count - 3)
                .map_or(0, |(idx, _)| idx);

            out.push_str(&host[..prefix_end]);
            out.push_str("***");
            out.push_str(&host[suffix_start..]);
        } else {
            out.push_str("***");
        }
        out.push_str("/***");
        true
    } else {
        out.push_str("***");
        false
    }
}

/// Mask URL for safe display in UI (hide sensitive host, path, and query parts)
#[cfg_attr(feature = "uniffi", uniffi::export)]
#[must_use]
pub fn mask_url(url: String) -> String {
    let mut out = String::with_capacity(32);
    format_masked_url_to(&url, &mut out);
    out
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
    fn merge_changes_an_entry_written_with_a_local_tag() {
        let mut base: YamlValue =
            serde_yaml::from_str("!custom mode: rule\n!custom log-level: info\nport: 7890")
                .unwrap();
        let patch: YamlValue = serde_yaml::from_str("mode: global\nlog-level: null").unwrap();
        merge_yaml(&mut base, &patch, 0).unwrap();
        let map = base.as_mapping().unwrap();
        let modes: Vec<_> = map
            .iter()
            .filter(|(k, _)| resolved_key_str(k) == Some("mode"))
            .map(|(_, v)| v.as_str().unwrap())
            .collect();
        assert_eq!(modes, ["global"]);
        assert!(map.keys().all(|k| resolved_key_str(k) != Some("log-level")));

        let mut owned: YamlValue = serde_yaml::from_str("!custom mode: rule").unwrap();
        merge_yaml_owned(&mut owned, serde_yaml::from_str("mode: direct").unwrap(), 0).unwrap();
        assert_eq!(owned.as_mapping().unwrap().len(), 1);
        assert_eq!(
            owned
                .as_mapping()
                .unwrap()
                .values()
                .next()
                .unwrap()
                .as_str(),
            Some("direct")
        );
    }

    #[test]
    fn merge_goes_into_a_tagged_mapping_and_keeps_its_tag() {
        let source =
            "!custom tun: !conf\n  enable: false\n  stack: system\ndns: !conf\n  ipv6: false\n";
        let patch: YamlValue =
            serde_yaml::from_str("tun:\n  stack: gvisor\ndns:\n  listen: 0.0.0.0:1053").unwrap();
        let check = |merged: &YamlValue| {
            let map = merged.as_mapping().unwrap();
            for (name, kept, changed, value) in [
                ("tun", "enable", "stack", "gvisor"),
                ("dns", "ipv6", "listen", "0.0.0.0:1053"),
            ] {
                let entry = map
                    .iter()
                    .find(|(k, _)| resolved_key_str(k) == Some(name))
                    .map(|(_, v)| v)
                    .unwrap();
                let tagged_inner = if let YamlValue::Tagged(tagged) = entry {
                    tagged.value.as_mapping()
                } else {
                    None
                };
                assert!(tagged_inner.is_some(), "{name} lost its tag: {entry:?}");
                let inner = tagged_inner.unwrap();
                assert!(
                    inner.contains_key(&YamlValue::String(kept.to_owned())),
                    "{name}.{kept} dropped"
                );
                assert_eq!(
                    inner
                        .get(&YamlValue::String(changed.to_owned()))
                        .and_then(YamlValue::as_str),
                    Some(value)
                );
            }
        };
        let mut base: YamlValue = serde_yaml::from_str(source).unwrap();
        merge_yaml(&mut base, &patch, 0).unwrap();
        check(&base);
        let mut owned: YamlValue = serde_yaml::from_str(source).unwrap();
        merge_yaml_owned(&mut owned, patch, 0).unwrap();
        check(&owned);
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

    // -- Snapshot tests for URL masking -----------------------------------

    #[test]
    fn snapshot_mask_url_https() {
        insta::assert_snapshot!(mask_url("https://example.com/path?token=abc".to_owned()));
    }

    #[test]
    fn snapshot_mask_url_http_long_host() {
        insta::assert_snapshot!(mask_url("http://subdomain.example.com/path".to_owned()));
    }

    #[test]
    fn snapshot_mask_url_short_host() {
        insta::assert_snapshot!(mask_url("https://ab.co/path".to_owned()));
    }

    #[test]
    fn snapshot_mask_url_invalid() {
        insta::assert_snapshot!(mask_url("not-a-url".to_owned()));
    }

    #[test]
    fn snapshot_mask_url_unicode_host() {
        insta::assert_snapshot!(mask_url("https://例子.测试.com/path".to_owned()));
    }

    // -- Control-plane keys -------------------------------------------------

    struct MemIo {
        content: std::cell::RefCell<Option<String>>,
    }

    impl ConfigIo for MemIo {
        fn read_to_string(&self, _path: &std::path::Path) -> Result<String, String> {
            self.content
                .borrow()
                .clone()
                .ok_or_else(|| "missing".to_owned())
        }
        fn write_file(&self, _path: &std::path::Path, content: &str) -> Result<(), String> {
            *self.content.borrow_mut() = Some(content.to_owned());
            Ok(())
        }
        fn path_exists(&self, _path: &std::path::Path) -> bool {
            self.content.borrow().is_some()
        }
    }

    const CONTROL_SAMPLES: &[(&str, &str)] = &[
        ("external-controller-unix", "\"/tmp/mihomo.sock\""),
        (
            "external-controller-pipe",
            "\"\\\\\\\\.\\\\pipe\\\\mihomo\"",
        ),
        ("external-controller-tls", "\"0.0.0.0:9443\""),
        ("external-controller-cors", "{\"allow-origins\": [\"*\"]}"),
        ("external-doh-server", "\"/dns-query\""),
        ("external-ui", "\"/tmp/ui\""),
        ("external-ui-url", "\"https://example.com/ui.zip\""),
        ("external-ui-name", "\"evil\""),
    ];

    #[test]
    fn test_control_samples_cover_blacklist() {
        let sample_keys: Vec<&str> = CONTROL_SAMPLES.iter().map(|(k, _)| *k).collect();
        for key in crate::config::sanitizer::CONTROL_PLANE_KEYS {
            assert!(sample_keys.contains(key), "no merge test for {key}");
        }
    }

    #[test]
    fn test_update_config_core_strips_control_plane_keys_from_patch() {
        for (key, json_value) in CONTROL_SAMPLES {
            let io = MemIo {
                content: std::cell::RefCell::new(Some(
                    "external-controller: 127.0.0.1:9090\nsecret: s3cret\nmixed-port: 7890\n"
                        .to_owned(),
                )),
            };
            let patch: JsonValue = serde_json::from_str(&format!(
                "{{\"{key}\": {json_value}, \"mode\": \"global\"}}"
            ))
            .unwrap();
            let (yaml, port) =
                update_config_core(&io, std::path::Path::new("run_config.yaml"), &patch).unwrap();
            assert!(yaml.get(*key).is_none(), "{key} survived patch merge");
            assert_eq!(yaml["mode"].as_str().unwrap(), "global");
            assert_eq!(
                yaml["external-controller"].as_str().unwrap(),
                "127.0.0.1:9090"
            );
            assert_eq!(yaml["secret"].as_str().unwrap(), "s3cret");
            assert_eq!(port, "9090");
            let written = io.content.borrow().clone().unwrap();
            assert!(
                !written.contains(&format!("{key}:")),
                "{key} written to disk"
            );
        }
    }

    #[test]
    fn test_update_config_core_drops_merge_keys_from_patch() {
        let io = MemIo {
            content: std::cell::RefCell::new(Some(
                "external-controller: 127.0.0.1:9090\ntun:\n  enable: false\n".to_owned(),
            )),
        };
        let patch = serde_json::json!({
            "<<": { "tun": { "enable": true } },
            "dns": { "<<": { "enable": true }, "ipv6": true },
        });
        let (yaml, _) =
            update_config_core(&io, std::path::Path::new("run_config.yaml"), &patch).unwrap();
        assert!(yaml.get("<<").is_none());
        assert!(yaml["dns"].get("<<").is_none());
        assert_eq!(yaml["dns"]["ipv6"].as_bool(), Some(true));
        assert_eq!(yaml["tun"]["enable"].as_bool(), Some(false));
        assert!(!io.content.borrow().clone().unwrap().contains("<<"));
    }

    #[test]
    fn test_update_config_core_keeps_a_tagged_disabled_tun_off() {
        for original in [
            "external-controller: 127.0.0.1:9090\n!custom tun:\n  enable: false\n",
            "external-controller: 127.0.0.1:9090\ntun:\n  !!str enable: false\n",
            "external-controller: 127.0.0.1:9090\n!custom tun: !m\n  enable: false\n",
        ] {
            let io = MemIo {
                content: std::cell::RefCell::new(Some(original.to_owned())),
            };
            let patch = serde_json::json!({ "tun": { "enable": true, "stack": "mixed" } });
            let (yaml, _) =
                update_config_core(&io, std::path::Path::new("run_config.yaml"), &patch).unwrap();
            let enables: Vec<_> = resolved_get(&yaml, "tun")
                .unwrap()
                .as_mapping()
                .unwrap()
                .iter()
                .filter(|(k, _)| resolved_key_str(k) == Some("enable"))
                .map(|(_, v)| v.as_bool())
                .collect();
            assert_eq!(enables, vec![Some(false)], "{original}");
            assert!(!extract_security_settings(&yaml).tun_enabled, "{original}");
        }
    }

    #[test]
    fn test_update_config_core_refuses_a_patch_that_is_not_an_object() {
        let original = "mode: rule\nmixed-port: 7890\n";
        for patch in [
            serde_json::json!(["mode", "global"]),
            serde_json::json!("mode: global"),
            serde_json::json!(7),
            serde_json::json!(null),
        ] {
            let io = MemIo {
                content: std::cell::RefCell::new(Some(original.to_owned())),
            };
            assert!(
                update_config_core(&io, std::path::Path::new("run_config.yaml"), &patch).is_err(),
                "{patch} must be refused"
            );
            assert_eq!(io.content.borrow().as_deref(), Some(original));
        }
    }

    #[test]
    fn test_update_config_core_strips_control_plane_keys_from_existing_file() {
        for (key, json_value) in CONTROL_SAMPLES {
            let io = MemIo {
                content: std::cell::RefCell::new(Some(format!(
                    "external-controller: 127.0.0.1:9090\nsecret: s3cret\n{key}: {json_value}\n"
                ))),
            };
            let patch = serde_json::json!({"mode": "rule"});
            let (yaml, _) =
                update_config_core(&io, std::path::Path::new("run_config.yaml"), &patch).unwrap();
            assert!(
                yaml.get(*key).is_none(),
                "{key} survived from existing file"
            );
            assert_eq!(yaml["secret"].as_str().unwrap(), "s3cret");
            let written = io.content.borrow().clone().unwrap();
            assert!(
                !written.contains(key),
                "{key} was written back to disk: {written}"
            );
        }
    }

    #[test]
    fn test_update_config_core_pins_the_controller_of_a_tagged_root() {
        let io = MemIo {
            content: std::cell::RefCell::new(Some(
                "!cfg\nexternal-controller: 127.0.0.1:9090\nsecret: s3cret\nmode: rule\n"
                    .to_owned(),
            )),
        };
        let patch = serde_json::json!({
            "external-controller": "0.0.0.0:9999",
            "secret": "",
            "mode": "global",
        });
        let (yaml, port) =
            update_config_core(&io, std::path::Path::new("run_config.yaml"), &patch).unwrap();
        assert!(matches!(yaml, YamlValue::Tagged(_)), "{yaml:?}");
        assert_eq!(yaml["external-controller"].as_str(), Some("127.0.0.1:9090"));
        assert_eq!(yaml["secret"].as_str(), Some("s3cret"));
        assert_eq!(yaml["mode"].as_str(), Some("global"));
        assert_eq!(port, "9090");
        let written = io.content.borrow().clone().unwrap();
        assert!(!written.contains("0.0.0.0"), "{written}");
    }

    #[test]
    fn test_strip_secret_reaches_a_tagged_root_and_a_tagged_key() {
        for original in [
            "!cfg\nsecret: s3cret\nmode: rule\n",
            "!custom secret: s3cret\nmode: rule\n",
        ] {
            let mut yaml: YamlValue = serde_yaml::from_str(original).unwrap();
            strip_secret_from_yaml(&mut yaml);
            let text = serde_yaml::to_string(&yaml).unwrap();
            assert!(!text.contains("s3cret"), "{original} -> {text}");
            assert_eq!(yaml["mode"].as_str(), Some("rule"), "{original}");
        }
    }

    #[test]
    fn test_restore_security_settings_replaces_tagged_controller_and_secret() {
        let mut yaml: YamlValue = serde_yaml::from_str(
            "!!str external-controller: 0.0.0.0:9090\n!!str secret: attacker\nport: 7890\n",
        )
        .unwrap();
        let settings = SecuritySettings {
            external_controller: Some("127.0.0.1:9090".to_owned()),
            secret: Some("mysecret".to_owned()),
            tun_enabled: false,
        };
        restore_security_settings(&mut yaml, &settings);
        let map = yaml.as_mapping().unwrap();
        let resolved = |name: &str| {
            map.iter()
                .filter(|(k, _)| super::super::sanitizer::resolved_key_str(k) == Some(name))
                .map(|(_, v)| v.as_str().unwrap().to_owned())
                .collect::<Vec<_>>()
        };
        assert_eq!(resolved("external-controller"), vec!["127.0.0.1:9090"]);
        assert_eq!(resolved("secret"), vec!["mysecret"]);
        assert_eq!(yaml["port"].as_i64().unwrap(), 7890);
    }

    #[test]
    fn test_restore_security_settings_strips_control_plane_keys() {
        for (key, json_value) in CONTROL_SAMPLES {
            let mut yaml: YamlValue = serde_yaml::from_str(&format!(
                "external-controller: 0.0.0.0:9090\nport: 7890\n{key}: {json_value}\n"
            ))
            .unwrap();
            let settings = SecuritySettings {
                external_controller: Some("127.0.0.1:9090".to_owned()),
                secret: Some("mysecret".to_owned()),
                tun_enabled: false,
            };
            restore_security_settings(&mut yaml, &settings);
            assert!(yaml.get(*key).is_none(), "{key} survived restore");
            assert_eq!(
                yaml["external-controller"].as_str().unwrap(),
                "127.0.0.1:9090"
            );
            assert_eq!(yaml["secret"].as_str().unwrap(), "mysecret");
            assert_eq!(yaml["port"].as_i64().unwrap(), 7890);
        }
    }
}
