//! Shared types, constants, and utility functions for the Prism module.

use serde::{Deserialize, Serialize};

use crate::core_manager::core::config_sanitizer::{sanitize_base_filename, url_decode_complete};

/// Maximum allowed size for user-supplied text inputs (10 MB).
pub const MAX_INPUT_SIZE: usize = 10 * 1024 * 1024;

// ===========================================================================
// Serializable types
// ===========================================================================

#[derive(Serialize)]
pub struct RuleFileInfo {
    pub filename: String,
    pub rule_count: usize,
    pub source: String,
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

/// Validate that a plugin ID is a simple name (no path traversal).
pub fn validate_plugin_id(plugin_id: &str) -> Result<(), String> {
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
        return Err(String::from(
            "Invalid plugin ID: contains unsafe characters or exceeds length limit",
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

    let base = sanitize_base_filename(&preprocessed)?;

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

    let rules: Vec<String> = match source {
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
    // Wrap rules under $append so Prism Engine injects them at the end
    // of the rules array instead of replacing the entire array.
    format!("rules:\n  $append:\n{}\n", rules.join("\n"))
}

/// Replace the policy field in a rule line with {{proxy}} if it's not a built-in policy.
/// This makes imported rules cross-subscription compatible.
///
/// Standard rules: "DOMAIN-SUFFIX,example.com,Proxy" → "DOMAIN-SUFFIX,example.com,{{proxy}}"
/// MATCH/FINAL:   "MATCH,Proxy" → "MATCH,{{proxy}}"
fn replace_policy_with_template(rule: &str, builtin: &[&str]) -> String {
    let parts: Vec<&str> = rule.splitn(4, ',').collect();
    // MATCH/FINAL rules always have the policy at index 1 (regardless of
    // additional options like "no-resolve"). All other rules use index 2.
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
    // Reconstruct: replace only the policy_index field with {{proxy}}
    let mut out = String::new();
    for (i, part) in parts.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push_str(if i == policy_index { "{{proxy}}" } else { part });
    }
    out
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
