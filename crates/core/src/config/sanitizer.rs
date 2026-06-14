//! Configuration file sanitizer — platform-agnostic security validation.
//!
//! Migrated from `src-tauri/src/core/config_sanitizer.rs` for cross-platform reuse.

use std::path::Path;

/// Maximum recursion depth for YAML processing to prevent stack overflow attacks.
const MAX_YAML_DEPTH: usize = 100;

#[inline]
fn decode_hex_digit(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
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
            for key in ["script", "script-path"] {
                map.remove(serde_yaml::Value::String(key.to_owned()));
            }

            // Remove Clash-for-Windows legacy keys that have no effect in mihomo
            // but could be used to inject unexpected behavior
            for key in [
                "cfw-bypass",
                "cfw-bypass-domain",
                "cfw-profiles-path",
                "cfw-conn-break-strategy",
                "prepend-proxy-groups",
                "append-proxy-groups",
            ] {
                map.remove(serde_yaml::Value::String(key.to_owned()));
            }

            // Check if this mapping looks like a provider
            // Providers have 'type' and either 'url' or 'path' fields
            let is_provider = map.contains_key(serde_yaml::Value::String("type".to_owned()))
                && (map.contains_key(serde_yaml::Value::String("url".to_owned()))
                    || map.contains_key(serde_yaml::Value::String("path".to_owned())));

            // Remove 'path' only in provider context to prevent path traversal
            // while allowing legitimate 'path' fields elsewhere
            if in_provider_context || is_provider {
                map.remove(serde_yaml::Value::String("path".to_owned()));
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
    serde_yaml::to_string(&value)
        .map_err(|e| crate::error::AppError::ParseError(format!("YAML serialization failed: {e}")))
}

/// Non-FFI version that works directly with serde_yaml::Value (for internal use).
pub fn remove_dangerous_keys_internal_pub(
    value: &mut serde_yaml::Value,
    in_provider_context: bool,
) {
    remove_dangerous_keys_internal(value, in_provider_context, 0);
}

/// Complete URL decoding for path traversal detection
/// Handles standard percent-encoding, double encoding, and mixed case
pub fn url_decode_complete(input: &str) -> String {
    let mut current = input.as_bytes().to_vec();

    for _ in 0..5 {
        let mut changed = false;
        let mut decoded = Vec::with_capacity(current.len());
        let mut i = 0;

        while i < current.len() {
            if current[i] == b'%' && i + 2 < current.len() {
                if let (Some(hi), Some(lo)) = (
                    decode_hex_digit(current[i + 1]),
                    decode_hex_digit(current[i + 2]),
                ) {
                    decoded.push((hi << 4) | lo);
                    i += 3;
                    changed = true;
                    continue;
                }
            }

            decoded.push(current[i]);
            i += 1;
        }

        current = decoded;
        if !changed {
            break;
        }
    }

    String::from_utf8(current).unwrap_or_else(|_| input.to_owned())
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
}
