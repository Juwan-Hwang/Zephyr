//! Shared types, constants, and utility functions for the Prism module.

use serde::{Deserialize, Serialize};

use zephyr_core::config::sanitizer::{
    sanitize_base_filename, url_decode_complete, RESERVED_DEVICE_NAMES,
};

/// Maximum allowed size for user-supplied text inputs (10 MB).
pub const MAX_INPUT_SIZE: usize = 10 * 1024 * 1024;

/// Maximum allowed size for identifier-like inputs (KV keys, group names,
/// override names). The 10 MB text limit is sized for whole scripts and
/// configs; identifiers stored on every write need a far smaller cap.
pub const MAX_NAME_SIZE: usize = 1024;

// ===========================================================================
// Serializable types
// ===========================================================================

#[derive(Serialize)]
pub struct RuleFileInfo {
    pub filename: String,
    pub rule_count: usize,
    pub source: String,
    /// `false` when the file is parked as `<name>.prism.yaml.disabled`
    /// (see `prism_toggle_group`); `filename` is still the base name.
    pub enabled: bool,
}

#[derive(Serialize, Deserialize)]
pub struct RuleGroup {
    pub name: String,
    pub files: Vec<String>,
}

#[derive(Serialize, Deserialize)]
pub struct RuleGroups {
    pub groups: Vec<RuleGroup>,
}

#[derive(Serialize, Deserialize)]
pub struct PrismSettings {
    pub auto_apply: bool,
}

// ===========================================================================
// Utility functions
// ===========================================================================

/// Reject inputs that exceed `MAX_INPUT_SIZE`.
pub fn check_input_size(input: &str, label: &str) -> Result<(), String> {
    if input.len() > MAX_INPUT_SIZE {
        return Err(format!(
            "{label} too large ({} bytes, max {MAX_INPUT_SIZE} bytes)",
            input.len()
        ));
    }
    Ok(())
}

/// Reject identifier-like inputs that exceed `MAX_NAME_SIZE`.
pub fn check_name_size(input: &str, label: &str) -> Result<(), String> {
    if input.len() > MAX_NAME_SIZE {
        return Err(format!(
            "{label} too large ({} bytes, max {MAX_NAME_SIZE} bytes)",
            input.len()
        ));
    }
    Ok(())
}

/// Validate that a plugin ID is a simple name (no path traversal).
pub fn validate_plugin_id(plugin_id: &str) -> Result<(), String> {
    const MAX_PLUGIN_ID_LEN: usize = 128;

    // Decode URL-encoded characters first to prevent bypass via %2e%2e etc.
    let decoded = url_decode_complete(plugin_id);
    // Trim both ends: a leading dot/space must not smuggle a reserved name
    // (e.g. ".CON") or the plugins directory itself (".") past validation.
    let trimmed = decoded.trim_matches([' ', '.']);

    if trimmed.is_empty()
        || decoded != trimmed
        || decoded.len() > MAX_PLUGIN_ID_LEN
        || decoded.contains('/')
        || decoded.contains('\\')
        || decoded.contains(':')
        || decoded.contains("..")
        || decoded.contains('\0')
        || decoded.chars().any(char::is_control)
    {
        return Err(String::from(
            "Invalid plugin ID: contains unsafe characters or exceeds length limit",
        ));
    }

    // Windows treats a device name followed by an extension as the device
    // itself ("NUL.txt", "CON.json"), so compare the stem before the first dot.
    // Windows ignores trailing spaces when matching device names, so
    // "CON .x" is still CON: trim the stem before comparing.
    let stem = trimmed.split('.').next().unwrap_or(trimmed).trim();
    if RESERVED_DEVICE_NAMES.contains(&stem.to_ascii_uppercase().as_str()) {
        return Err(format!(
            "Invalid plugin ID: '{plugin_id}' is a reserved Windows device name"
        ));
    }

    Ok(())
}

/// Validate that an override ID is a simple identifier (no path traversal).
pub fn validate_override_id(id: &str) -> Result<(), String> {
    const MAX_OVERRIDE_ID_LEN: usize = 128;

    let decoded = url_decode_complete(id);
    let trimmed = decoded.trim_matches([' ', '.']);

    if trimmed.is_empty()
        || decoded != trimmed
        || decoded.len() > MAX_OVERRIDE_ID_LEN
        || decoded.contains('/')
        || decoded.contains('\\')
        || decoded.contains(':')
        || decoded.contains("..")
        || decoded.contains('\0')
        || decoded.chars().any(char::is_control)
    {
        return Err(String::from(
            "Invalid override ID: contains unsafe characters or exceeds length limit",
        ));
    }

    let stem = trimmed.split('.').next().unwrap_or(trimmed).trim();
    if RESERVED_DEVICE_NAMES.contains(&stem.to_ascii_uppercase().as_str()) {
        return Err(format!(
            "Invalid override ID: '{id}' is a reserved Windows device name"
        ));
    }

    Ok(())
}

/// Sanitize a user-supplied filename to prevent path traversal and injection attacks.
///
/// Returns an error if the filename is empty, contains path traversal components,
/// or contains disallowed characters. Does NOT add the `.prism.yaml` extension;
/// callers should use `ensure_prism_ext` afterward when needed.
pub fn sanitize_filename(name: &str) -> Result<String, String> {
    // Pre-process: strip characters that sanitize_base_filename would reject,
    // so they are silently removed instead of causing an error.
    // Prism filenames are always flat (no subdirectories), so directory
    // separators and control characters can be safely stripped.
    let preprocessed: String = name
        .chars()
        .filter(|c| *c != '/' && *c != '\\' && !c.is_control() && *c != '\0')
        .collect();

    let base = sanitize_base_filename(preprocessed).map_err(|e| e.to_string())?;

    if base.is_empty() {
        return Err("Filename must not be empty".to_owned());
    }

    // Prism-specific: only allow alphanumeric, hyphens, underscores, dots,
    // spaces, CJK characters, and parentheses
    let allowed: String = base
        .chars()
        .filter(|c| {
            c.is_ascii_alphanumeric()
                || *c == '-'
                || *c == '_'
                || *c == '.'
                || *c == ' '
                || *c == '('
                || *c == ')'
                || matches!(c, '\u{4e00}'..='\u{9fff}' // CJK Unified Ideographs
                    | '\u{3040}'..='\u{309f}' // Hiragana
                    | '\u{30a0}'..='\u{30ff}' // Katakana
                    | '\u{ac00}'..='\u{d7af}' // Hangul Syllables
                    | '\u{f900}'..='\u{faff}' // CJK Compatibility Ideographs
                )
        })
        .collect();

    if allowed.is_empty() {
        return Err("Filename contains no allowed characters".to_owned());
    }

    Ok(allowed)
}

#[must_use]
/// Ensure the filename ends with `.prism.yaml`.
pub fn ensure_prism_ext(name: &str) -> String {
    if name.ends_with(".prism.yaml") {
        name.to_owned()
    } else {
        format!("{name}.prism.yaml")
    }
}

#[must_use]
/// Count rule lines in a .prism.yaml content string.
/// Rules are top-level sequence items under `rules:` that start with `- ` and
/// contain a comma (the standard Clash/Surge rule format).
pub fn count_rules(content: &str) -> usize {
    let mut in_rules = false;
    let mut count = 0usize;
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed == "rules:" {
            in_rules = true;
            continue;
        }
        if in_rules {
            if trimmed.starts_with("- ") && trimmed.contains(',') {
                count += 1;
            } else if !trimmed.starts_with('#')
                && !trimmed.is_empty()
                && !trimmed.starts_with('-')
                && !trimmed.starts_with('$')
            {
                // Hit a new top-level key — stop counting
                in_rules = false;
            }
        }
    }
    count
}

/// Sanitize a rule filename and resolve its full path within the prism directory.
/// Returns an error if the filename is invalid or doesn't end with `.prism.yaml`.
pub fn resolve_rule_path(
    prism_dir: &std::path::Path,
    filename: &str,
) -> Result<std::path::PathBuf, String> {
    let safe = sanitize_filename(filename)?;
    if !safe.ends_with(".prism.yaml") {
        return Err("Filename must end with .prism.yaml".to_owned());
    }
    Ok(prism_dir.join(&safe))
}

#[must_use]
/// Detect the source format of rule text.
pub fn detect_source(content: &str) -> &'static str {
    let trimmed = content.trim();
    if trimmed.is_empty() {
        return "empty";
    }

    // Performance optimization: Count both Surge and Clash format rule lines
    // in a single pass over lines to avoid iterating over rule text twice.
    let mut surge_count = 0usize;
    let mut clash_count = 0usize;

    for line in trimmed.lines() {
        let t = line.trim();
        if t.is_empty() || t.starts_with('#') {
            continue;
        }
        if t.contains(',') {
            if t.starts_with("- ") {
                clash_count += 1;
            } else if !t.starts_with('-') {
                surge_count += 1;
            }
        }
    }

    if clash_count > surge_count {
        "clash"
    } else if surge_count > 0 {
        "surge"
    } else {
        "unknown"
    }
}

#[must_use]
/// Convert raw rule text (Surge/S-R or Clash format) into .prism.yaml content.
pub fn normalize_to_prism_yaml(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let source = detect_source(trimmed);

    const BUILTIN_POLICIES: &[&str] = &["DIRECT", "REJECT", "PASS"];

    // Performance optimization: Format normalized rule lines directly into a single
    // pre-allocated String buffer to eliminate intermediate Vec<String> allocations and .join("\n").
    let mut output = String::with_capacity(trimmed.len() + 32);
    output.push_str("rules:\n  $append:\n");
    let header_len = output.len();

    if source == "surge" {
        for line in trimmed.lines() {
            let t = line.trim();
            if t.is_empty() || t.starts_with('#') {
                continue;
            }
            output.push_str("  - ");
            let processed = replace_policy_with_template(t, BUILTIN_POLICIES);
            output.push_str(&processed);
            output.push('\n');
        }
    } else {
        for line in trimmed.lines() {
            let t = line.trim();
            if t.is_empty() || t.starts_with('#') {
                continue;
            }
            let processed = replace_policy_with_template(t, BUILTIN_POLICIES);
            if processed.starts_with("- ") {
                output.push_str("  ");
            } else {
                output.push_str("  - ");
            }
            output.push_str(&processed);
            output.push('\n');
        }
    }

    if output.len() == header_len {
        output.push('\n');
    }

    output
}

/// Replace the policy field in a rule line with {{proxy}} if it's not a built-in policy.
/// This makes imported rules cross-subscription compatible.
///
/// Standard rules: "DOMAIN-SUFFIX,example.com,Proxy" → "DOMAIN-SUFFIX,example.com,{{proxy}}"
/// MATCH/FINAL:   "MATCH,Proxy" → "MATCH,{{proxy}}"
///
/// Performance optimization: Uses zero-allocation iterator slicing from splitn(4, ',')
/// and direct String building instead of Vec<&str> heap allocations and array joining.
fn replace_policy_with_template(rule: &str, builtin: &[&str]) -> String {
    let mut iter = rule.splitn(4, ',');
    let p0 = match iter.next() {
        Some(p) => p,
        None => return rule.to_owned(),
    };

    let p0_trimmed = p0.trim();
    let is_match_final =
        p0_trimmed.eq_ignore_ascii_case("MATCH") || p0_trimmed.eq_ignore_ascii_case("FINAL");

    let p1 = match iter.next() {
        Some(p) => p,
        None => return rule.to_owned(),
    };

    if is_match_final {
        let policy = p1.trim();
        if builtin.iter().any(|b| b.eq_ignore_ascii_case(policy)) {
            return rule.to_owned();
        }
        let p2 = iter.next();
        let p3 = iter.next();
        let mut res = String::with_capacity(rule.len() + 8);
        res.push_str(p0);
        res.push_str(",{{proxy}}");
        if let Some(rest2) = p2 {
            res.push(',');
            res.push_str(rest2);
            if let Some(rest3) = p3 {
                res.push(',');
                res.push_str(rest3);
            }
        }
        res
    } else {
        let p2 = match iter.next() {
            Some(p) => p,
            None => return rule.to_owned(),
        };
        let policy = p2.trim();
        if builtin.iter().any(|b| b.eq_ignore_ascii_case(policy)) {
            return rule.to_owned();
        }
        let p3 = iter.next();
        let mut res = String::with_capacity(rule.len() + 8);
        res.push_str(p0);
        res.push(',');
        res.push_str(p1);
        res.push_str(",{{proxy}}");
        if let Some(rest3) = p3 {
            res.push(',');
            res.push_str(rest3);
        }
        res
    }
}

/// Read and parse a JSON file from the prism directory.
/// Returns the default value if the file does not exist.
pub fn read_json<T: serde::de::DeserializeOwned>(
    dir: &std::path::Path,
    filename: &str,
    default: fn() -> T,
) -> Result<T, String> {
    let path = dir.join(filename);
    if !path.exists() {
        return Ok(default());
    }
    let content =
        std::fs::read_to_string(&path).map_err(|e| format!("Failed to read {filename}: {e}"))?;
    serde_json::from_str(&content).map_err(|e| format!("Failed to parse {filename}: {e}"))
}

/// Write a serializable value as pretty-printed JSON to the prism directory.
pub fn write_json<T: serde::Serialize>(
    dir: &std::path::Path,
    filename: &str,
    data: &T,
) -> Result<(), String> {
    let path = dir.join(filename);
    let content = serde_json::to_string_pretty(data)
        .map_err(|e| format!("Failed to serialize {filename}: {e}"))?;
    crate::core_manager::write_file_secure(&path, &content)
}

/// Read and parse groups.json from the prism directory.
pub fn read_groups(prism_dir: &std::path::Path) -> Result<RuleGroups, String> {
    read_json(prism_dir, "groups.json", || RuleGroups {
        groups: Vec::new(),
    })
}

/// Write groups.json to the prism directory.
pub fn write_groups(prism_dir: &std::path::Path, groups: &RuleGroups) -> Result<(), String> {
    write_json(prism_dir, "groups.json", groups)
}

/// Read `auto_apply` from settings.json in prism directory.
pub fn read_prism_settings(prism_dir: &std::path::Path) -> Result<PrismSettings, String> {
    read_json(prism_dir, "settings.json", || PrismSettings {
        auto_apply: false,
    })
}

/// Write settings.json to the prism directory.
pub fn write_prism_settings(
    prism_dir: &std::path::Path,
    settings: &PrismSettings,
) -> Result<(), String> {
    write_json(prism_dir, "settings.json", settings)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_validate_plugin_id_ok() {
        assert!(validate_plugin_id("my-plugin").is_ok());
        assert!(validate_plugin_id("plugin_123").is_ok());
    }

    #[test]
    fn test_validate_plugin_id_unsafe_chars() {
        assert!(validate_plugin_id("../etc/passwd").is_err());
        assert!(validate_plugin_id("plugin:stream").is_err());
        assert!(validate_plugin_id("plugin\r\n").is_err());
        assert!(validate_plugin_id("CON").is_err());
        assert!(validate_plugin_id("nul").is_err());
        assert!(validate_plugin_id("C:").is_err());
        assert!(validate_plugin_id("plugin. ").is_err());
        // Reserved names stay reserved with an extension or leading dot/space.
        assert!(validate_plugin_id("nul.plugin").is_err());
        assert!(validate_plugin_id("CON.txt").is_err());
        assert!(validate_plugin_id("COM1.log").is_err());
        assert!(validate_plugin_id(".CON").is_err());
        assert!(validate_plugin_id(".").is_err());
        assert!(validate_plugin_id("COM0").is_err());
        assert!(validate_plugin_id("LPT0").is_err());
        assert!(validate_plugin_id("COM\u{b9}").is_err());
        assert!(validate_plugin_id("LPT\u{b3}.txt").is_err());
        assert!(validate_plugin_id("CONIN$").is_err());
        assert!(validate_plugin_id("conout$").is_err());
        assert!(validate_plugin_id("CON .x").is_err());
    }

    #[test]
    fn test_validate_override_id() {
        assert!(validate_override_id("550e8400-e29b-41d4-a716-446655440000").is_ok());
        assert!(validate_override_id("custom_override_1").is_ok());
        assert!(validate_override_id("../etc/passwd").is_err());
        assert!(validate_override_id("override:stream").is_err());
        assert!(validate_override_id("override\r\n").is_err());
        assert!(validate_override_id("CON").is_err());
        assert!(validate_override_id("nul.txt").is_err());
    }
}
