use std::path::Path;

/// Maximum recursion depth for YAML processing to prevent stack overflow attacks.
const MAX_YAML_DEPTH: usize = 100;

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
pub(crate) fn remove_dangerous_keys(value: &mut serde_yaml::Value, in_provider_context: bool) {
    remove_dangerous_keys_internal(value, in_provider_context, 0);
}

/// Complete URL decoding for path traversal detection
/// Handles standard percent-encoding, double encoding, and mixed case
pub(crate) fn url_decode_complete(input: &str) -> String {
    let mut result = input.to_owned();

    // Decode iteratively until no more changes (handles nested encoding)
    let mut changed = true;
    let max_iterations = 5; // Prevent infinite loops
    let mut iterations = 0;

    while changed && iterations < max_iterations {
        changed = false;
        iterations += 1;

        // Handle standard percent-encoded characters
        let mut decoded = String::new();
        let chars: Vec<char> = result.chars().collect();
        let mut i = 0;

        while i < chars.len() {
            if chars.get(i) == Some(&'%') && i + 2 < chars.len() {
                // Try to decode %XX
                if let Some(hex_chars) = chars.get(i + 1..i + 3) {
                    let hex: String = hex_chars.iter().collect();
                    if let Ok(byte) = u8::from_str_radix(&hex, 16) {
                        decoded.push(byte as char);
                        i += 3;
                        changed = true;
                        continue;
                    }
                }
            }
            if let Some(c) = chars.get(i) {
                decoded.push(*c);
            }
            i += 1;
        }

        result = decoded;
    }

    result
}

/// Common base filename sanitization shared by config and prism file handlers.
///
/// Performs URL decoding, null byte removal, control character removal,
/// path traversal rejection, directory separator rejection, and length check.
pub(crate) fn sanitize_base_filename(raw: &str) -> Result<String, String> {
    // Step 1: Complete URL decoding to catch all encoded patterns
    let decoded = url_decode_complete(raw);

    // Step 1.5: Check the decoded path for traversal BEFORE extracting the filename.
    if decoded.contains('/') || decoded.contains('\\') {
        return Err("Path traversal detected: directory separators are not allowed".to_owned());
    }
    // Reject bare ".." which is a real parent-directory reference.
    // "file..name" and "..yaml" are safe filenames (no directory separator).
    if decoded == ".." {
        return Err("Path traversal detected: '..' is not allowed".to_owned());
    }

    // Step 2: Extract just the filename
    // Path::new(".").file_name() returns None on Linux, but "." is a valid filename.
    let filename = Path::new(&decoded)
        .file_name()
        .and_then(|f| f.to_str())
        .unwrap_or_else(|| {
            emit_warn!(
                Config,
                CONFIG_PARSE_FAILED,
                "Path::new({decoded:?}).file_name() returned None, using raw input"
            );
            &decoded
        })
        .to_owned();

    // Step 3: Reject null bytes
    if filename.contains('\0') {
        return Err("Invalid character in filename: null byte detected".to_owned());
    }

    // Step 4: Reject control characters
    if filename.chars().any(char::is_control) {
        return Err("Invalid character in filename: control characters not allowed".to_owned());
    }

    // Step 5: Length limit
    if filename.len() > 255 {
        return Err("Filename too long: maximum 255 characters allowed".to_owned());
    }

    Ok(filename)
}

/// Sanitize configuration file name with comprehensive security checks
pub(crate) fn sanitize_config_file_name(config_path: &str) -> Result<String, String> {
    let config_file_name = sanitize_base_filename(config_path)?;

    // Validate extension
    let lower_name = config_file_name.to_lowercase();
    if !lower_name.ends_with(".yaml") && !lower_name.ends_with(".yml") {
        return Err("Invalid file type: only .yaml and .yml files are permitted".to_owned());
    }

    if config_file_name.len() > 255 {
        return Err("Filename too long: maximum 255 characters allowed".to_owned());
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
        return Err(format!(
            "Reserved filename: '{config_file_name}' is not allowed"
        ));
    }

    Ok(config_file_name)
}

/// Validates that the resolved path is within the expected base directory
pub(crate) fn validate_path_within_dir(
    resolved_path: &Path,
    base_dir: &Path,
) -> Result<(), String> {
    // If the file exists, use canonicalize for definitive check
    if resolved_path.exists() {
        let canonical_resolved = resolved_path
            .canonicalize()
            .map_err(|e| format!("Failed to canonicalize resolved path: {e}"))?;
        let canonical_base = base_dir
            .canonicalize()
            .map_err(|e| format!("Failed to canonicalize base directory: {e}"))?;

        if !canonical_resolved.starts_with(&canonical_base) {
            return Err(
                "Path traversal detected: resolved path is outside allowed directory".to_owned(),
            );
        }
    } else {
        // File doesn't exist yet, do string-level validation
        // Convert to string and check for path traversal patterns
        let resolved_str = resolved_path.to_string_lossy();
        let base_str = base_dir.to_string_lossy();

        // Normalize path separators for comparison
        let resolved_normalized = resolved_str.replace('\\', "/");
        let base_normalized = base_str.replace('\\', "/");

        if !resolved_normalized.starts_with(&*base_normalized) {
            return Err(
                "Path traversal detected: resolved path is outside allowed directory".to_owned(),
            );
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
        assert_eq!(sanitize_config_file_name("test.yaml").unwrap(), "test.yaml");
        assert_eq!(sanitize_config_file_name("test.yml").unwrap(), "test.yml");
        assert!(sanitize_config_file_name("../test.yaml").is_err());
        assert!(sanitize_config_file_name("foo/test.yaml").is_err());
        // Path traversal fix: directory separators are always rejected
        // regardless of platform (both '/' and '\' are blocked)
        assert!(sanitize_config_file_name("foo\\test.yaml").is_err());
        assert!(sanitize_config_file_name("test.txt").is_err());
    }

    #[test]
    fn test_sanitize_config_file_name_rejects_path_traversal() {
        assert!(sanitize_config_file_name("..").is_err());
        assert!(sanitize_config_file_name("foo/bar").is_err());
        assert!(sanitize_config_file_name("test\x00.yaml").is_err());
        assert!(sanitize_config_file_name(".test.yaml").is_ok());
        assert!(sanitize_config_file_name("config.backup.yml").is_ok());
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
    fn test_url_decode_triple_encoding() {
        assert_eq!(url_decode_complete("%252541"), "A");
    }

    #[test]
    fn test_url_decode_no_encoding() {
        assert_eq!(url_decode_complete("hello"), "hello");
        assert_eq!(url_decode_complete(""), "");
    }

    #[test]
    fn test_url_decode_incomplete_percent() {
        let result = url_decode_complete("test%");
        assert!(!result.contains('\0'));
    }

    #[test]
    fn test_url_decode_invalid_hex() {
        assert_eq!(url_decode_complete("%GG"), "%GG");
    }

    #[test]
    fn test_url_decode_mixed_case() {
        assert_eq!(url_decode_complete("%3A"), ":");
        assert_eq!(url_decode_complete("%2e"), ".");
    }

    #[test]
    fn test_url_decode_max_iterations() {
        let deep = "%252525252541";
        let result = url_decode_complete(deep);
        assert!(!result.is_empty());
    }

    #[test]
    fn test_sanitize_url_encoded_path_traversal() {
        assert!(sanitize_config_file_name("%2e%2e%2fetc%2fpasswd.yaml").is_err());
        assert!(sanitize_config_file_name("..%2f..%2f..%2ftest.yaml").is_err());
    }

    #[test]
    fn test_sanitize_control_characters() {
        assert!(sanitize_config_file_name("test\x01.yaml").is_err());
        assert!(sanitize_config_file_name("test\x1f.yaml").is_err());
        assert!(sanitize_config_file_name("test\x7f.yaml").is_err());
    }

    #[test]
    fn test_sanitize_filename_too_long() {
        let long_name = "a".repeat(256) + ".yaml";
        assert!(sanitize_config_file_name(&long_name).is_err());
        let ok_name = "a".repeat(250) + ".yaml";
        assert!(sanitize_config_file_name(&ok_name).is_ok());
    }

    #[test]
    fn test_sanitize_windows_reserved_names() {
        assert!(sanitize_config_file_name("CON.yaml").is_err());
        assert!(sanitize_config_file_name("AUX.yaml").is_err());
        assert!(sanitize_config_file_name("NUL.yaml").is_err());
        assert!(sanitize_config_file_name("PRN.yaml").is_err());
        assert!(sanitize_config_file_name("COM1.yaml").is_err());
        assert!(sanitize_config_file_name("LPT1.yaml").is_err());
    }

    #[test]
    fn test_sanitize_empty_string() {
        assert!(sanitize_config_file_name("").is_err());
    }

    #[test]
    fn test_sanitize_hidden_files() {
        assert!(sanitize_config_file_name(".hidden.yaml").is_ok());
    }

    #[test]
    fn test_sanitize_mixed_case_extension() {
        assert!(sanitize_config_file_name("CONFIG.YAML").is_ok());
        assert!(sanitize_config_file_name("test.YML").is_ok());
    }
}
