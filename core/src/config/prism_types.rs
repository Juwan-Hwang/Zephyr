//! Prism rule types and utility functions — migrated from `src-tauri/src/prism/types.rs`.
//!
//! Only pure functions and data types are migrated.
//! File I/O functions (read_json, write_json, etc.) remain in src-tauri.

use serde::{Deserialize, Serialize};

use super::sanitizer::{sanitize_base_filename, url_decode_complete};
use crate::error::AppError;

/// Maximum allowed size for user-supplied text inputs (10 MB).
pub const MAX_INPUT_SIZE: usize = 10 * 1024 * 1024;

// ── Data types ────────────────────────────────────────────────────────────

#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
#[derive(Serialize)]
pub struct RuleFileInfo {
    pub filename: String,
    pub rule_count: u64,
    pub source: String,
}

#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
#[derive(Serialize, Deserialize)]
pub struct RuleGroup {
    pub name: String,
    pub files: Vec<String>,
}

#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
#[derive(Serialize, Deserialize)]
pub struct RuleGroups {
    pub groups: Vec<RuleGroup>,
}

#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
#[derive(Serialize, Deserialize)]
pub struct PrismSettings {
    pub auto_apply: bool,
}

// ── Utility functions ─────────────────────────────────────────────────────

/// Reject inputs that exceed `MAX_INPUT_SIZE`.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn check_input_size(input: &str, label: &str) -> Result<(), AppError> {
    if input.len() > MAX_INPUT_SIZE {
        return Err(AppError::ParseError(format!(
            "{label} too large ({} bytes, max {MAX_INPUT_SIZE} bytes)",
            input.len()
        )));
    }
    Ok(())
}

/// Validate that a plugin ID is a simple name (no path traversal).
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn validate_plugin_id(plugin_id: &str) -> Result<(), AppError> {
    const MAX_PLUGIN_ID_LEN: usize = 128;
    // Decode URL-encoded characters first to prevent bypass via %2e%2e etc.
    let decoded = url_decode_complete(plugin_id);
    if decoded.is_empty()
        || decoded.len() > MAX_PLUGIN_ID_LEN
        || decoded.contains('/')
        || decoded.contains('\\')
        || decoded.contains("..")
        || decoded.contains('\0')
    {
        return Err(AppError::ConfigError(
            "Invalid plugin ID: contains unsafe characters or exceeds length limit".to_owned(),
        ));
    }
    Ok(())
}

/// Sanitize a user-supplied filename to prevent path traversal and injection attacks.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn sanitize_filename(name: &str) -> Result<String, AppError> {
    // Pre-process: strip characters that sanitize_base_filename would reject,
    // so they are silently removed instead of causing an error.
    let preprocessed: String = name
        .chars()
        .filter(|c| *c != '/' && *c != '\\' && !c.is_control() && *c != '\0')
        .collect();

    let base = sanitize_base_filename(preprocessed)?;

    if base.is_empty() {
        return Err(AppError::ConfigError(
            "Filename must not be empty".to_owned(),
        ));
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
        return Err(AppError::ConfigError(
            "Filename contains no allowed characters".to_owned(),
        ));
    }

    Ok(allowed)
}

/// Ensure the filename ends with `.prism.yaml`.
#[must_use]
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn ensure_prism_ext(name: &str) -> String {
    if name.ends_with(".prism.yaml") {
        name.to_owned()
    } else {
        format!("{name}.prism.yaml")
    }
}

/// Count rule lines in a .prism.yaml content string.
#[must_use]
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn count_rules(content: &str) -> u64 {
    let mut in_rules = false;
    let mut count = 0u64;
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

/// Detect the source format of rule text.
#[must_use]
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn detect_source(content: &str) -> String {
    let trimmed = content.trim();
    if trimmed.is_empty() {
        return "empty".to_owned();
    }
    // Surge / S-R format: lines like "DOMAIN,example.com,REJECT"
    let surge_count = trimmed
        .lines()
        .filter(|l| {
            let t = l.trim();
            !t.is_empty() && !t.starts_with('#') && t.contains(',') && !t.starts_with('-')
        })
        .count();
    // Clash format: lines like "- DOMAIN,example.com,REJECT"
    let clash_count = trimmed
        .lines()
        .filter(|l| {
            let t = l.trim();
            t.starts_with("- ") && t.contains(',')
        })
        .count();
    if clash_count > surge_count {
        "clash".to_owned()
    } else if surge_count > 0 {
        "surge".to_owned()
    } else {
        "unknown".to_owned()
    }
}

/// Convert raw rule text (Surge/S-R or Clash format) into .prism.yaml content.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn normalize_to_prism_yaml(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let source = detect_source(trimmed);

    const BUILTIN_POLICIES: &[&str] = &["DIRECT", "REJECT", "PASS"];

    let rules: Vec<String> = match source.as_str() {
        "surge" => trimmed
            .lines()
            .filter(|l| {
                let t = l.trim();
                !t.is_empty() && !t.starts_with('#')
            })
            .map(|l| {
                format!(
                    "  - {}",
                    replace_policy_with_template(l.trim(), BUILTIN_POLICIES)
                )
            })
            .collect(),
        _ => trimmed
            .lines()
            .filter(|l| {
                let t = l.trim();
                !t.is_empty() && !t.starts_with('#')
            })
            .map(|l| {
                let t = l.trim();
                let processed = replace_policy_with_template(t, BUILTIN_POLICIES);
                if processed.starts_with("- ") {
                    format!("  {processed}")
                } else {
                    format!("  - {processed}")
                }
            })
            .collect(),
    };
    format!("rules:\n  $append:\n{}\n", rules.join("\n"))
}

/// Replace the policy field in a rule line with {{proxy}} if it's not a built-in policy.
fn replace_policy_with_template(rule: &str, builtin: &[&str]) -> String {
    let parts: Vec<&str> = rule.splitn(4, ',').collect();
    let is_match_final = parts
        .first()
        .is_some_and(|t| t.eq_ignore_ascii_case("MATCH") || t.eq_ignore_ascii_case("FINAL"));
    let policy_index = if is_match_final {
        1
    } else if parts.len() >= 3 {
        2
    } else {
        return rule.to_owned();
    };
    let policy = parts.get(policy_index).map(|p| p.trim()).unwrap_or("");
    if builtin.iter().any(|b| b.eq_ignore_ascii_case(policy)) {
        return rule.to_owned();
    }
    parts
        .iter()
        .enumerate()
        .map(|(i, part)| if i == policy_index { "{{proxy}}" } else { part })
        .collect::<Vec<_>>()
        .join(",")
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn test_check_input_size_ok() {
        assert!(check_input_size("hello", "test").is_ok());
    }

    #[test]
    fn test_check_input_size_too_large() {
        let big = "x".repeat(MAX_INPUT_SIZE + 1);
        assert!(check_input_size(&big, "test").is_err());
    }

    #[test]
    fn test_validate_plugin_id_ok() {
        assert!(validate_plugin_id("my-plugin").is_ok());
    }

    #[test]
    fn test_validate_plugin_id_traversal() {
        assert!(validate_plugin_id("../etc/passwd").is_err());
    }

    #[test]
    fn test_sanitize_filename_simple() {
        assert_eq!(sanitize_filename("test-rule").unwrap(), "test-rule");
    }

    #[test]
    fn test_sanitize_filename_traversal() {
        // Pre-processing removes / and \, so the result is a sanitized name, not an error.
        // The dots are preserved but the path separators are removed, making it safe.
        let result = sanitize_filename("../../etc/passwd").unwrap();
        assert!(!result.contains('/'));
        assert!(!result.contains('\\'));
    }

    #[test]
    fn test_ensure_prism_ext_with_ext() {
        assert_eq!(ensure_prism_ext("test.prism.yaml"), "test.prism.yaml");
    }

    #[test]
    fn test_ensure_prism_ext_without_ext() {
        assert_eq!(ensure_prism_ext("test"), "test.prism.yaml");
    }

    #[test]
    fn test_count_rules() {
        let content = "rules:\n  - DOMAIN,example.com,REJECT\n  - DOMAIN-SUFFIX,test.com,DIRECT\n";
        assert_eq!(count_rules(content), 2);
    }

    #[test]
    fn test_detect_source_surge() {
        let content = "DOMAIN,example.com,REJECT\nDOMAIN-SUFFIX,test.com,DIRECT\n";
        assert_eq!(detect_source(content), "surge");
    }

    #[test]
    fn test_detect_source_clash() {
        let content = "- DOMAIN,example.com,REJECT\n- DOMAIN-SUFFIX,test.com,DIRECT\n";
        assert_eq!(detect_source(content), "clash");
    }

    #[test]
    fn test_normalize_to_prism_yaml() {
        let raw = "DOMAIN,example.com,REJECT\nDOMAIN-SUFFIX,test.com,Proxy\n";
        let result = normalize_to_prism_yaml(raw);
        assert!(result.starts_with("rules:"));
        assert!(result.contains("{{proxy}}"));
        assert!(result.contains("REJECT"));
    }
}
