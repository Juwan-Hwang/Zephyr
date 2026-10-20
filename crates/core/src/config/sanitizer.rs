//! Configuration file sanitizer — platform-agnostic security validation.
//!
//! Migrated from `src-tauri/src/core/config_sanitizer.rs` for cross-platform reuse.

use std::path::Path;

/// Maximum recursion depth for YAML processing to prevent stack overflow attacks.
const MAX_YAML_DEPTH: usize = 100;

/// Top-level mihomo keys that open or expose an additional control surface.
///
/// The desktop app manages the controller itself (it pins `external-controller`
/// to loopback and injects its own `secret`), so none of these keys is ever
/// legitimately supplied by a subscription, an imported profile, or a patch:
///
/// - `external-controller-unix` / `external-controller-pipe`: the REST API over a
///   unix socket / named pipe, which mihomo serves **without** checking `secret`.
/// - `external-controller-tls`: a second (TLS) listener for the REST API that can
///   bind to any address.
/// - `external-controller-cors`: relaxes the browser origin checks on the API.
/// - `external-doh-server`: a `DoH` endpoint on the controller that does not check
///   `secret`.
/// - `external-ui`, `external-ui-url`, `external-ui-name`: serve (and download)
///   arbitrary web UI content from the controller origin.
pub const CONTROL_PLANE_KEYS: &[&str] = &[
    "external-controller-unix",
    "external-controller-pipe",
    "external-controller-tls",
    "external-controller-cors",
    "external-doh-server",
    "external-ui",
    "external-ui-url",
    "external-ui-name",
];

/// YAML merge key. `serde_yaml` keeps it as a plain key, but mihomo's YAML
/// decoder resolves it, so keys hidden inside a top-level merge source still
/// land at the top level of the effective config.
const YAML_MERGE_KEY: &str = "<<";

/// The string a mapping key resolves to, looking through explicit YAML tags.
///
/// mihomo's YAML decoder resolves `!!str external-controller-unix` (or a
/// custom-tagged scalar) to the plain key, so a key that `serde_yaml` keeps as
/// [`serde_yaml::Value::Tagged`] must be matched by its inner string too.
#[allow(clippy::wildcard_enum_match_arm)]
pub(crate) fn resolved_key_str(key: &serde_yaml::Value) -> Option<&str> {
    match key {
        serde_yaml::Value::String(s) => Some(s.as_str()),
        serde_yaml::Value::Tagged(tagged) => resolved_key_str(&tagged.value),
        _ => None,
    }
}

/// Remove every entry whose (tag-resolved) key is one of `names`.
pub(crate) fn remove_keys_resolved(map: &mut serde_yaml::Mapping, names: &[&str]) {
    map.retain(|k, _| resolved_key_str(k).is_none_or(|s| !names.contains(&s)));
}

/// Remove [`CONTROL_PLANE_KEYS`] from a top-level mapping, following any
/// `<<` merge sources (which mihomo flattens into the same mapping).
fn strip_control_plane_mapping(map: &mut serde_yaml::Mapping, depth: usize) {
    remove_keys_resolved(map, CONTROL_PLANE_KEYS);
    for (key, merge_source) in map.iter_mut() {
        if resolved_key_str(key) == Some(YAML_MERGE_KEY) {
            strip_control_plane_merge_source(merge_source, depth + 1);
        }
    }
}

#[allow(clippy::wildcard_enum_match_arm)]
fn strip_control_plane_merge_source(value: &mut serde_yaml::Value, depth: usize) {
    if depth > MAX_YAML_DEPTH {
        *value = serde_yaml::Value::Null;
        return;
    }
    match value {
        serde_yaml::Value::Mapping(map) => strip_control_plane_mapping(map, depth),
        serde_yaml::Value::Sequence(seq) => {
            for item in seq.iter_mut() {
                strip_control_plane_merge_source(item, depth + 1);
            }
        }
        serde_yaml::Value::Tagged(tagged) => {
            strip_control_plane_merge_source(&mut tagged.value, depth + 1);
        }
        _ => {}
    }
}

/// Remove keys that open unauthenticated or otherwise unmanaged controller
/// surfaces (see [`CONTROL_PLANE_KEYS`]) from the root of a mihomo config.
///
/// These keys are only meaningful at the top level of a config, so only the
/// root mapping (and any `<<` merge sources attached to it) is touched.
/// `external-controller` and `secret` are intentionally left alone: they are
/// managed by [`crate::config::merge::restore_security_settings`] and the
/// desktop runtime-config preparation.
#[allow(clippy::wildcard_enum_match_arm)]
pub fn remove_control_plane_keys(value: &mut serde_yaml::Value) {
    match value {
        serde_yaml::Value::Mapping(map) => strip_control_plane_mapping(map, 0),
        serde_yaml::Value::Tagged(tagged) => remove_control_plane_keys(&mut tagged.value),
        _ => {}
    }
}

#[inline]
const fn decode_hex_digit(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

/// Whether `name` appears in `map` once YAML merge keys are resolved the way
/// mihomo resolves them: a key inherited through `<<` counts, whether the
/// merge source is a single mapping, a sequence of mappings, or a tagged
/// version of either, and merge sources may themselves carry `<<`.
fn merged_mapping_has_key(map: &serde_yaml::Mapping, name: &str, depth: usize) -> bool {
    if map.keys().any(|k| resolved_key_str(k) == Some(name)) {
        return true;
    }
    if depth > MAX_YAML_DEPTH {
        return false;
    }
    map.iter()
        .filter(|(k, _)| resolved_key_str(k) == Some(YAML_MERGE_KEY))
        .any(|(_, source)| merged_value_has_key(source, name, depth + 1))
}

#[allow(clippy::wildcard_enum_match_arm)]
fn merged_value_has_key(value: &serde_yaml::Value, name: &str, depth: usize) -> bool {
    if depth > MAX_YAML_DEPTH {
        return false;
    }
    match value {
        serde_yaml::Value::Mapping(map) => merged_mapping_has_key(map, name, depth + 1),
        serde_yaml::Value::Sequence(seq) => {
            seq.iter().any(|item| merged_value_has_key(item, name, depth + 1))
        }
        serde_yaml::Value::Tagged(tagged) => {
            merged_value_has_key(&tagged.value, name, depth + 1)
        }
        _ => false,
    }
}

/// Internal implementation with depth tracking.
#[allow(clippy::wildcard_enum_match_arm)]
fn remove_dangerous_keys_internal(
    value: &mut serde_yaml::Value,
    in_provider_context: bool,
    depth: usize,
) {
    // Prevent stack overflow from deeply nested YAML structures (Billion Laughs attack).
    // Clear the value entirely to prevent dangerous keys from surviving at depth limit.
    if depth > MAX_YAML_DEPTH {
        *value = serde_yaml::Value::Null;
        return;
    }

    match value {
        serde_yaml::Value::Mapping(map) => {
            // Always remove script-related keys globally
            // script: can execute arbitrary JavaScript
            // script-path: can load external script files
            remove_keys_resolved(map, &["script", "script-path"]);

            // Remove Clash-for-Windows legacy keys that have no effect in mihomo
            // but could be used to inject unexpected behavior
            remove_keys_resolved(
                map,
                &[
                    "cfw-bypass",
                    "cfw-bypass-domain",
                    "cfw-profiles-path",
                    "cfw-conn-break-strategy",
                    "prepend-proxy-groups",
                    "append-proxy-groups",
                ],
            );

            // Check if this mapping looks like a provider
            // Providers have 'type' and either 'url' or 'path' fields
            // (keys are matched through explicit tags such as `!!str path`,
            // which mihomo resolves to the plain key, and keys inherited
            // through a `<<` merge key count too: a provider that inherits
            // 'type' and 'url' but defines 'path' locally is still a provider).
            let has_key = |name: &str| merged_mapping_has_key(map, name, depth);
            let is_provider = has_key("type") && (has_key("url") || has_key("path"));

            // Remove 'path' only in provider context to prevent path traversal
            // while allowing legitimate 'path' fields elsewhere
            if in_provider_context || is_provider {
                remove_keys_resolved(map, &["path"]);
            }

            // Recursively process all values in the mapping
            for (_, v) in map.iter_mut() {
                remove_dangerous_keys_internal(v, is_provider, depth + 1);
            }
        }
        serde_yaml::Value::Sequence(seq) => {
            // Recursively process all items in the sequence
            for item in seq.iter_mut() {
                remove_dangerous_keys_internal(item, in_provider_context, depth + 1);
            }
        }
        serde_yaml::Value::Tagged(tagged) => {
            // A tagged value wraps the real node: mihomo's decoder looks
            // through the tag, so a tagged mapping must be sanitised exactly
            // like the mapping it wraps instead of being skipped.
            remove_dangerous_keys_internal(&mut tagged.value, in_provider_context, depth + 1);
        }
        _ => {}
    }
}

/// Recursively remove dangerous keys from YAML structure to prevent code execution.
/// This function is security-critical and used by both production code and tests.
/// Automatically limits recursion depth to prevent Billion Laughs attacks.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn remove_dangerous_keys(value_json: String) -> Result<String, crate::error::AppError> {
    let mut value: serde_yaml::Value = serde_yaml::from_str(&value_json)
        .map_err(|e| crate::error::AppError::ParseError(format!("Invalid YAML: {e}")))?;
    remove_dangerous_keys_internal(&mut value, false, 0);
    remove_control_plane_keys(&mut value);
    serde_yaml::to_string(&value)
        .map_err(|e| crate::error::AppError::ParseError(format!("YAML serialization failed: {e}")))
}

/// Non-FFI version that works directly with `serde_yaml::Value` (for internal use).
///
/// `value` is treated as the root of a config document, so top-level
/// control-plane keys ([`CONTROL_PLANE_KEYS`]) are removed as well.
pub fn remove_dangerous_keys_internal_pub(
    value: &mut serde_yaml::Value,
    in_provider_context: bool,
) {
    remove_dangerous_keys_internal(value, in_provider_context, 0);
    remove_control_plane_keys(value);
}

/// Complete URL decoding for path traversal detection
/// Handles standard percent-encoding, double encoding, and mixed case
#[must_use]
pub fn url_decode_complete(input: &str) -> String {
    if !input.contains('%') {
        return input.to_owned();
    }

    let mut current = input.as_bytes().to_vec();
    let mut decoded = Vec::with_capacity(current.len());

    for _ in 0..5 {
        let mut changed = false;
        decoded.clear();
        let mut i = 0;

        while let Some(&byte) = current.get(i) {
            if byte == b'%' {
                if let (Some(hi), Some(lo)) = (
                    current.get(i + 1).and_then(|&byte| decode_hex_digit(byte)),
                    current.get(i + 2).and_then(|&byte| decode_hex_digit(byte)),
                ) {
                    decoded.push((hi << 4) | lo);
                    i += 3;
                    changed = true;
                    continue;
                }
            }

            decoded.push(byte);
            i += 1;
        }

        std::mem::swap(&mut current, &mut decoded);
        if !changed {
            break;
        }
        if !current.contains(&b'%') {
            break;
        }
    }

    String::from_utf8(current)
        .unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned())
}

/// Common base filename sanitization shared by config and prism file handlers.
///
/// Performs URL decoding, null byte removal, control character removal,
/// path traversal rejection, directory separator rejection, and length check.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn sanitize_base_filename(raw: String) -> Result<String, crate::error::AppError> {
    // Step 1: Complete URL decoding to catch all encoded patterns
    let decoded = url_decode_complete(&raw);

    // Trim trailing spaces and dots to prevent Windows canonicalization bypasses (e.g. ".. " or ".. .")
    let trimmed = decoded.trim_end_matches([' ', '.']);

    // Step 1.5: Check the decoded path for traversal BEFORE extracting the filename.
    if trimmed.contains('/') || trimmed.contains('\\') {
        return Err(crate::error::AppError::ConfigError(
            "Path traversal detected: directory separators are not allowed".to_owned(),
        ));
    }
    // Reject bare ".." which is a real parent-directory reference.
    if trimmed == ".." {
        return Err(crate::error::AppError::ConfigError(
            "Path traversal detected: '..' is not allowed".to_owned(),
        ));
    }
    // Reject bare "." which is a special current-directory reference.
    if trimmed == "." || trimmed.is_empty() {
        return Err(crate::error::AppError::ConfigError(
            "'.' is not a valid filename".to_owned(),
        ));
    }

    // Step 2: Extract just the filename
    let filename = Path::new(trimmed)
        .file_name()
        .and_then(|f| f.to_str())
        .unwrap_or(trimmed)
        .to_owned();

    // Step 3: Reject null bytes
    if filename.contains('\0') {
        return Err(crate::error::AppError::ConfigError(
            "Invalid character in filename: null byte detected".to_owned(),
        ));
    }

    // Step 4: Reject control characters
    if filename.chars().any(char::is_control) {
        return Err(crate::error::AppError::ConfigError(
            "Invalid character in filename: control characters not allowed".to_owned(),
        ));
    }

    // Step 5: Length limit
    if filename.len() > 255 {
        return Err(crate::error::AppError::ConfigError(
            "Filename too long: maximum 255 characters allowed".to_owned(),
        ));
    }

    Ok(filename)
}

/// Sanitize configuration file name with comprehensive security checks
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn sanitize_config_file_name(config_path: String) -> Result<String, crate::error::AppError> {
    let config_file_name = sanitize_base_filename(config_path)?;

    // Validate extension
    let lower_name = config_file_name.to_lowercase();
    if !lower_name.ends_with(".yaml") && !lower_name.ends_with(".yml") {
        return Err(crate::error::AppError::ConfigError(
            "Invalid file type: only .yaml and .yml files are permitted".to_owned(),
        ));
    }

    if config_file_name.len() > 255 {
        return Err(crate::error::AppError::ConfigError(
            "Filename too long: maximum 255 characters allowed".to_owned(),
        ));
    }

    // Check for reserved Windows names (even on other platforms for consistency)
    let upper_name = config_file_name.to_uppercase();
    let base_name = upper_name
        .trim_end_matches(".YAML")
        .trim_end_matches(".YML");
    let reserved_names = [
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
        "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    if reserved_names.contains(&base_name) {
        return Err(crate::error::AppError::ConfigError(format!(
            "Reserved filename: '{config_file_name}' is not allowed"
        )));
    }

    Ok(config_file_name)
}

/// Validates that the resolved path is within the expected base directory
pub fn validate_path_within_dir(
    resolved_path: &Path,
    base_dir: &Path,
) -> Result<(), crate::error::AppError> {
    // If the file exists, use canonicalize for definitive check
    if resolved_path.exists() {
        let canonical_resolved = resolved_path.canonicalize().map_err(|e| {
            crate::error::AppError::IoError(format!("Failed to canonicalize resolved path: {e}"))
        })?;
        let canonical_base = base_dir.canonicalize().map_err(|e| {
            crate::error::AppError::IoError(format!("Failed to canonicalize base directory: {e}"))
        })?;

        if !canonical_resolved.starts_with(&canonical_base) {
            return Err(crate::error::AppError::ConfigError(
                "Path traversal detected: resolved path is outside allowed directory".to_owned(),
            ));
        }
    } else {
        // File doesn't exist yet, do string-level validation
        let resolved_str = resolved_path.to_string_lossy();
        let base_str = base_dir.to_string_lossy();

        // Normalize path separators for comparison
        let resolved_normalized = resolved_str.replace('\\', "/");
        let base_normalized = base_str.replace('\\', "/");

        if !resolved_normalized.starts_with(&*base_normalized) {
            return Err(crate::error::AppError::ConfigError(
                "Path traversal detected: resolved path is outside allowed directory".to_owned(),
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    fn root_keys(value: &serde_yaml::Value) -> Vec<String> {
        value
            .as_mapping()
            .unwrap()
            .keys()
            .filter_map(|k| resolved_key_str(k).map(str::to_owned))
            .collect()
    }

    #[test]
    fn test_control_plane_keys_removed_when_explicitly_tagged() {
        let yaml = "!!str external-controller-unix: /tmp/mihomo.sock\n\
                    !custom external-doh-server: /dns-query\n\
                    !!str script: evil.js\n\
                    port: 7890\n";
        let mut value: serde_yaml::Value = serde_yaml::from_str(yaml).unwrap();
        remove_dangerous_keys_internal_pub(&mut value, false);
        assert_eq!(root_keys(&value), vec!["port".to_owned()]);
    }

    #[test]
    fn test_control_plane_keys_removed_from_tagged_merge_source() {
        let yaml = "base: &base\n  external-controller-pipe: \\\\.\\pipe\\mihomo\n\
                    !!merge <<: *base\n\
                    port: 7890\n";
        let mut value: serde_yaml::Value = serde_yaml::from_str(yaml).unwrap();
        remove_control_plane_keys(&mut value);
        let (_, merge_source) = value
            .as_mapping()
            .unwrap()
            .iter()
            .find(|(k, _)| resolved_key_str(k) == Some(YAML_MERGE_KEY))
            .unwrap();
        let source = if let serde_yaml::Value::Tagged(t) = merge_source {
            &t.value
        } else {
            merge_source
        };
        assert!(!source
            .as_mapping()
            .unwrap()
            .contains_key(serde_yaml::Value::String(
                "external-controller-pipe".to_owned()
            )));
    }

    #[test]
    fn test_sanitize_config_file_name_valid() {
        assert_eq!(
            sanitize_config_file_name("test.yaml".to_owned()).unwrap(),
            "test.yaml"
        );
        assert_eq!(
            sanitize_config_file_name("test.yml".to_owned()).unwrap(),
            "test.yml"
        );
        assert!(sanitize_config_file_name("../test.yaml".to_owned()).is_err());
        assert!(sanitize_config_file_name("foo/test.yaml".to_owned()).is_err());
        assert!(sanitize_config_file_name("foo\\test.yaml".to_owned()).is_err());
        assert!(sanitize_config_file_name("test.txt".to_owned()).is_err());
    }

    #[test]
    fn test_sanitize_config_file_name_rejects_path_traversal() {
        assert!(sanitize_config_file_name("..".to_owned()).is_err());
        assert!(sanitize_config_file_name("foo/bar".to_owned()).is_err());
        assert!(sanitize_config_file_name("test\x00.yaml".to_owned()).is_err());
        assert!(sanitize_config_file_name(".test.yaml".to_owned()).is_ok());
        assert!(sanitize_config_file_name("config.backup.yml".to_owned()).is_ok());
    }

    #[test]
    fn test_url_decode_standard() {
        assert_eq!(url_decode_complete("%41"), "A");
        assert_eq!(url_decode_complete("%3a"), ":");
        assert_eq!(url_decode_complete("hello%20world"), "hello world");
    }

    #[test]
    fn test_url_decode_double_encoding() {
        assert_eq!(url_decode_complete("%2541"), "A");
        assert_eq!(url_decode_complete("%252541"), "A");
    }

    #[test]
    fn test_remove_dangerous_keys_script() {
        let yaml = "script: test.js\nport: 7890";
        let mut value: serde_yaml::Value = serde_yaml::from_str(yaml).unwrap();
        remove_dangerous_keys_internal_pub(&mut value, false);
        assert!(!value
            .as_mapping()
            .unwrap()
            .contains_key(serde_yaml::Value::String("script".to_owned())));
        assert!(value
            .as_mapping()
            .unwrap()
            .contains_key(serde_yaml::Value::String("port".to_owned())));
    }

    #[test]
    fn test_remove_dangerous_keys_provider_path() {
        let yaml = r"
proxy-providers:
  my-provider:
    type: http
    url: https://example.com/proxies.yaml
    path: /etc/passwd
    interval: 3600
";
        let mut value: serde_yaml::Value = serde_yaml::from_str(yaml).unwrap();
        remove_dangerous_keys_internal_pub(&mut value, false);
        let providers = value.get("proxy-providers").unwrap().as_mapping().unwrap();
        let provider = providers
            .get(serde_yaml::Value::String("my-provider".to_owned()))
            .unwrap()
            .as_mapping()
            .unwrap();
        assert!(!provider.contains_key(serde_yaml::Value::String("path".to_owned())));
        assert!(provider.contains_key(serde_yaml::Value::String("type".to_owned())));
    }

    #[test]
    fn test_provider_path_removed_when_type_and_url_inherited_via_merge_key() {
        let yaml = r"
base: &base
  type: http
  url: https://example.com/proxies.yaml
proxy-providers:
  my-provider:
    <<: *base
    path: /etc/passwd
    interval: 3600
";
        let mut value: serde_yaml::Value = serde_yaml::from_str(yaml).unwrap();
        remove_dangerous_keys_internal_pub(&mut value, false);
        let providers = value.get("proxy-providers").unwrap().as_mapping().unwrap();
        let provider = providers
            .get(serde_yaml::Value::String("my-provider".to_owned()))
            .unwrap()
            .as_mapping()
            .unwrap();
        assert!(
            provider.keys().all(|k| resolved_key_str(k) != Some("path")),
            "path survived merge-key provider detection: {provider:?}"
        );
        // Resolving the merge the way mihomo does must not resurface `path`.
        let mut merged_provider = value
            .get("proxy-providers")
            .and_then(|v| v.get("my-provider"))
            .cloned()
            .unwrap();
        resolve_merges(&mut merged_provider);
        let merged = merged_provider.as_mapping().unwrap();
        assert!(merged.keys().all(|k| resolved_key_str(k) != Some("path")));
        assert_eq!(merged.get("type").unwrap().as_str().unwrap(), "http");
        assert_eq!(merged.get("interval").unwrap().as_i64().unwrap(), 3600);
    }

    fn top_level_keys(value: &serde_yaml::Value) -> Vec<String> {
        value
            .as_mapping()
            .unwrap()
            .keys()
            .filter_map(|k| k.as_str().map(str::to_owned))
            .collect()
    }

    /// Resolve `<<` merge keys the way mihomo's decoder does, including merge
    /// sources that themselves carry `<<` (`apply_merge` is single-level).
    fn resolve_merges(value: &mut serde_yaml::Value) {
        for _ in 0..16 {
            if value.get(YAML_MERGE_KEY).is_none() {
                break;
            }
            value.apply_merge().unwrap();
        }
        assert!(
            value.get(YAML_MERGE_KEY).is_none(),
            "merge chain did not converge"
        );
    }

    fn assert_control_key_stripped(key: &str, value_yaml: &str) {
        let yaml = format!(
            "external-controller: 127.0.0.1:9090\nsecret: s3cret\nmixed-port: 7890\n{key}: {value_yaml}\n"
        );
        // Internal (desktop) entry point.
        let mut value: serde_yaml::Value = serde_yaml::from_str(&yaml).unwrap();
        remove_dangerous_keys_internal_pub(&mut value, false);
        let keys = top_level_keys(&value);
        assert!(!keys.iter().any(|k| k == key), "{key} survived: {keys:?}");
        assert_eq!(
            value.get("external-controller").unwrap().as_str().unwrap(),
            "127.0.0.1:9090"
        );
        assert_eq!(value.get("secret").unwrap().as_str().unwrap(), "s3cret");
        assert_eq!(value.get("mixed-port").unwrap().as_i64().unwrap(), 7890);

        // FFI entry point.
        let out = remove_dangerous_keys(yaml).unwrap();
        let value: serde_yaml::Value = serde_yaml::from_str(&out).unwrap();
        let keys = top_level_keys(&value);
        assert!(
            !keys.iter().any(|k| k == key),
            "{key} survived FFI: {keys:?}"
        );
        assert_eq!(
            value.get("external-controller").unwrap().as_str().unwrap(),
            "127.0.0.1:9090"
        );
        assert_eq!(value.get("secret").unwrap().as_str().unwrap(), "s3cret");
        assert_eq!(value.get("mixed-port").unwrap().as_i64().unwrap(), 7890);
    }

    #[test]
    fn test_tagged_provider_path_is_removed() {
        let yaml = "proxy-providers:\n  p:\n    type: http\n    url: https://example.com/p.yaml\n    !!str path: ../../etc/evil.yaml\n";
        let mut value: serde_yaml::Value = serde_yaml::from_str(yaml).unwrap();
        remove_dangerous_keys_internal_pub(&mut value, false);
        let provider = value
            .get("proxy-providers")
            .and_then(|v| v.get("p"))
            .and_then(serde_yaml::Value::as_mapping)
            .unwrap();
        assert!(
            provider.keys().all(|k| resolved_key_str(k) != Some("path")),
            "tagged path survived: {provider:?}"
        );
        assert!(provider.contains_key("url"));
    }

    #[test]
    fn test_dangerous_keys_removed_inside_tagged_values() {
        let yaml = "proxy-providers:\n  p: !custom {type: http, url: 'https://example.com/p.yaml', path: /etc/passwd}\nwrapper: !custom {script: evil.js, name: keep}\n";
        let mut value: serde_yaml::Value = serde_yaml::from_str(yaml).unwrap();
        remove_dangerous_keys_internal_pub(&mut value, false);
        let out = serde_yaml::to_string(&value).unwrap();
        assert!(!out.contains("/etc/passwd"), "path survived: {out}");
        assert!(!out.contains("script"), "script survived: {out}");
        assert!(out.contains("example.com"), "provider lost: {out}");
        assert!(out.contains("keep"), "benign value lost: {out}");
    }

    #[test]
    fn test_tagged_type_marks_provider() {
        let yaml = "proxy-providers:\n  p:\n    !!str type: file\n    path: ../../etc/evil.yaml\n";
        let mut value: serde_yaml::Value = serde_yaml::from_str(yaml).unwrap();
        remove_dangerous_keys_internal_pub(&mut value, false);
        let provider = value
            .get("proxy-providers")
            .and_then(|v| v.get("p"))
            .and_then(serde_yaml::Value::as_mapping)
            .unwrap();
        assert!(
            !provider.contains_key("path"),
            "path survived: {provider:?}"
        );
    }

    #[test]
    fn test_strips_external_controller_unix() {
        assert_control_key_stripped("external-controller-unix", "/tmp/mihomo.sock");
    }

    #[test]
    fn test_strips_external_controller_pipe() {
        assert_control_key_stripped("external-controller-pipe", r"'\\.\pipe\mihomo'");
    }

    #[test]
    fn test_strips_external_controller_tls() {
        assert_control_key_stripped("external-controller-tls", "0.0.0.0:9443");
    }

    #[test]
    fn test_strips_external_controller_cors() {
        assert_control_key_stripped(
            "external-controller-cors",
            "{allow-origins: ['*'], allow-private-network: true}",
        );
    }

    #[test]
    fn test_strips_external_doh_server() {
        assert_control_key_stripped("external-doh-server", "/dns-query");
    }

    #[test]
    fn test_strips_external_ui() {
        assert_control_key_stripped("external-ui", "/tmp/ui");
    }

    #[test]
    fn test_strips_external_ui_url() {
        assert_control_key_stripped("external-ui-url", "https://example.com/ui.zip");
    }

    #[test]
    fn test_strips_external_ui_name() {
        assert_control_key_stripped("external-ui-name", "evil");
    }

    #[test]
    fn test_control_plane_key_list_is_covered() {
        // Guard: every blacklisted key has a dedicated regression test above.
        assert_eq!(CONTROL_PLANE_KEYS.len(), 8);
    }

    #[test]
    fn test_strips_control_plane_keys_from_merge_sources() {
        let yaml = r"
base: &base
  external-controller-unix: /tmp/a.sock
  external-doh-server: /dns-query
nested: &nested
  <<: *base
  external-ui: /tmp/ui
<<: [*nested, {external-controller-pipe: '\\.\pipe\x', log-level: info}]
mixed-port: 7890
";
        let mut value: serde_yaml::Value = serde_yaml::from_str(yaml).unwrap();
        // Sanity: without sanitizing, resolving the merge exposes the keys.
        let mut unsanitized = value.clone();
        resolve_merges(&mut unsanitized);
        let unsanitized_keys = top_level_keys(&unsanitized);
        for key in [
            "external-controller-unix",
            "external-controller-pipe",
            "external-doh-server",
        ] {
            assert!(
                unsanitized_keys.iter().any(|k| k == key),
                "fixture lacks {key}"
            );
        }

        remove_dangerous_keys_internal_pub(&mut value, false);
        let out = serde_yaml::to_string(&value).unwrap();
        // Applying the merge (as mihomo does) must not resurface any control key.
        let mut merged: serde_yaml::Value = serde_yaml::from_str(&out).unwrap();
        resolve_merges(&mut merged);
        let keys = top_level_keys(&merged);
        for key in CONTROL_PLANE_KEYS {
            assert!(
                !keys.iter().any(|k| k == key),
                "{key} survived merge: {keys:?}"
            );
        }
        assert!(keys.iter().any(|k| k == "log-level"));
        assert!(keys.iter().any(|k| k == "mixed-port"));
    }

    #[test]
    fn test_control_plane_like_keys_below_root_are_untouched() {
        // Only the root mapping is a mihomo config; nested data is left alone.
        let yaml = r"
proxies:
  - name: p
    type: ss
    server: 1.2.3.4
    port: 8388
    external-ui: keep-me
";
        let mut value: serde_yaml::Value = serde_yaml::from_str(yaml).unwrap();
        remove_dangerous_keys_internal_pub(&mut value, false);
        let proxy = value.get("proxies").unwrap().get(0).unwrap();
        assert_eq!(
            proxy.get("external-ui").unwrap().as_str().unwrap(),
            "keep-me"
        );
    }

    #[test]
    fn test_remove_control_plane_keys_ignores_non_mapping_root() {
        let mut value = serde_yaml::Value::String("external-ui".to_owned());
        remove_control_plane_keys(&mut value);
        assert_eq!(value.as_str().unwrap(), "external-ui");
    }
}
