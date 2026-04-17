use std::path::Path;

/// Recursively remove dangerous keys from YAML structure to prevent code execution
/// This function is security-critical and used by both production code and tests
pub(crate) fn remove_dangerous_keys(value: &mut serde_yaml::Value, in_provider_context: bool) {
    match value {
        serde_yaml::Value::Mapping(map) => {
            // Always remove script-related keys globally
            // script: can execute arbitrary JavaScript
            // script-path: can load external script files
            for key in ["script", "script-path"] {
                map.remove(serde_yaml::Value::String(key.to_string()));
            }

            // Check if this mapping looks like a provider
            // Providers have 'type' and either 'url' or 'path' fields
            let is_provider = map.contains_key(serde_yaml::Value::String("type".to_string()))
                && (map.contains_key(serde_yaml::Value::String("url".to_string()))
                    || map.contains_key(serde_yaml::Value::String("path".to_string())));

            // Remove 'path' only in provider context to prevent path traversal
            // while allowing legitimate 'path' fields elsewhere
            if in_provider_context || is_provider {
                map.remove(serde_yaml::Value::String("path".to_string()));
            }

            // Recursively process all values in the mapping
            for (_, v) in map.iter_mut() {
                remove_dangerous_keys(v, is_provider);
            }
        }
        serde_yaml::Value::Sequence(seq) => {
            // Recursively process all items in the sequence
            for item in seq.iter_mut() {
                remove_dangerous_keys(item, in_provider_context);
            }
        }
        _ => {}
    }
}

/// Complete URL decoding for path traversal detection
/// Handles standard percent-encoding, double encoding, and mixed case
pub(super) fn url_decode_complete(input: &str) -> String {
    let mut result = input.to_string();

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

/// Sanitize configuration file name with comprehensive security checks
pub(super) fn sanitize_config_file_name(config_path: &str) -> Result<String, String> {
    // Step 1: Complete URL decoding to catch all encoded patterns
    let decoded_path = url_decode_complete(config_path);

    // Step 2: Extract just the filename
    let config_file_name = Path::new(&decoded_path)
        .file_name()
        .ok_or_else(|| "Invalid config path: no filename component".to_string())?
        .to_str()
        .ok_or("Invalid config filename encoding")?
        .to_string();

    // Step 3: Security checks

    // Check for path traversal attempts
    if config_file_name.contains("..") {
        return Err("Path traversal detected: '..' is not allowed".to_string());
    }

    // Check for directory separators
    if config_file_name.contains('/') || config_file_name.contains('\\') {
        return Err("Path traversal detected: directory separators are not allowed".to_string());
    }

    // Check for null bytes (could be used to bypass extension checks)
    if config_file_name.contains('\0') {
        return Err("Invalid character in filename: null byte detected".to_string());
    }

    // Check for control characters
    if config_file_name.chars().any(|c| c.is_control()) {
        return Err("Invalid character in filename: control characters not allowed".to_string());
    }

    // Validate extension
    let lower_name = config_file_name.to_lowercase();
    if !lower_name.ends_with(".yaml") && !lower_name.ends_with(".yml") {
        return Err("Invalid file type: only .yaml and .yml files are permitted".to_string());
    }

    if config_file_name.len() > 255 {
        return Err("Filename too long: maximum 255 characters allowed".to_string());
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
            "Reserved filename: '{}' is not allowed",
            config_file_name
        ));
    }

    Ok(config_file_name)
}

/// Validates that the resolved path is within the expected base directory
pub(super) fn validate_path_within_dir(
    resolved_path: &Path,
    base_dir: &Path,
) -> Result<(), String> {
    // If the file exists, use canonicalize for definitive check
    if resolved_path.exists() {
        let canonical_resolved = resolved_path
            .canonicalize()
            .map_err(|e| format!("Failed to canonicalize resolved path: {}", e))?;
        let canonical_base = base_dir
            .canonicalize()
            .map_err(|e| format!("Failed to canonicalize base directory: {}", e))?;

        if !canonical_resolved.starts_with(&canonical_base) {
            return Err(
                "Path traversal detected: resolved path is outside allowed directory".to_string(),
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
                "Path traversal detected: resolved path is outside allowed directory".to_string(),
            );
        }
    }
    Ok(())
}

#[cfg(test)]
pub fn sanitize_config_file_name_public(config_path: &str) -> Result<String, String> {
    sanitize_config_file_name(config_path)
}
