//! Rule Library — File CRUD, Import, and Extraction commands.

#![allow(clippy::needless_pass_by_value)]

use tauri::State;

use crate::core_manager::core::config_sanitizer::remove_dangerous_keys;
use crate::core_manager::core::subscription::validate_subscription_url_with_ip;
use crate::core_manager::core::MAX_RESPONSE_SIZE;
use crate::core_manager::write_file_secure;
use crate::prism::types::{
    check_input_size, count_rules, detect_source, ensure_prism_ext, normalize_to_prism_yaml,
    resolve_rule_path, sanitize_filename, RuleFileInfo,
};
use crate::prism::PrismState;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt as _;

#[tauri::command]
pub fn open_prism_folder(state: State<PrismState>) -> Result<String, String> {
    let prism_dir = state.get_prism_workspace()?;

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(&prism_dir)
            .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
            .spawn()
            .map_err(|e| format!("Failed to open prism folder: {e}"))?;
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&prism_dir)
            .spawn()
            .map_err(|e| format!("Failed to open prism folder: {e}"))?;
    }

    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&prism_dir)
            .spawn()
            .map_err(|e| format!("Failed to open prism folder: {e}"))?;
    }

    Ok(prism_dir.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn rule_list(state: State<PrismState>) -> Result<Vec<RuleFileInfo>, String> {
    let prism_dir = state.get_prism_workspace()?;
    let entries =
        std::fs::read_dir(&prism_dir).map_err(|e| format!("Failed to read prism dir: {e}"))?;

    let mut files = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.ends_with(".prism.yaml") {
            let content = std::fs::read_to_string(entry.path()).unwrap_or_default();
            files.push(RuleFileInfo {
                filename: name,
                rule_count: count_rules(&content),
                source: detect_source(&content).to_owned(),
            });
        }
    }
    files.sort_by(|a, b| a.filename.cmp(&b.filename));
    Ok(files)
}

#[tauri::command]
pub fn rule_read(state: State<PrismState>, filename: String) -> Result<String, String> {
    let prism_dir = state.get_prism_workspace()?;
    let path = resolve_rule_path(&prism_dir, &filename)?;
    std::fs::read_to_string(&path).map_err(|e| format!("Failed to read rule file: {e}"))
}

#[tauri::command]
pub fn rule_create(
    state: State<PrismState>,
    name: String,
    content: String,
) -> Result<String, String> {
    check_input_size(&content, "Rule content")?;
    let prism_dir = state.get_prism_workspace()?;
    let filename = ensure_prism_ext(&sanitize_filename(&name)?);
    let path = prism_dir.join(&filename);
    if path.exists() {
        return Err(format!("Rule file '{filename}' already exists"));
    }
    write_file_secure(&path, &content)?;
    Ok(filename)
}

#[tauri::command]
pub fn rule_update(
    state: State<PrismState>,
    filename: String,
    content: String,
) -> Result<(), String> {
    check_input_size(&content, "Rule content")?;
    let prism_dir = state.get_prism_workspace()?;
    let path = resolve_rule_path(&prism_dir, &filename)?;
    if !path.exists() {
        return Err(format!("Rule file '{filename}' not found"));
    }
    write_file_secure(&path, &content)
}

#[tauri::command]
pub fn rule_delete(state: State<PrismState>, filename: String) -> Result<(), String> {
    let prism_dir = state.get_prism_workspace()?;
    let path = resolve_rule_path(&prism_dir, &filename)?;
    if !path.exists() {
        return Err(format!("Rule file '{filename}' not found"));
    }
    std::fs::remove_file(&path).map_err(|e| format!("Failed to delete rule file: {e}"))?;

    // Remove the file from any groups
    let safe = sanitize_filename(&filename)?;
    let mut groups = super::types::read_groups(&prism_dir)?;
    for group in &mut groups.groups {
        group.files.retain(|f| f != &safe);
    }
    super::types::write_groups(&prism_dir, &groups)?;

    Ok(())
}

#[tauri::command]
pub fn rule_rename(
    state: State<PrismState>,
    old_filename: String,
    new_filename: String,
) -> Result<String, String> {
    let prism_dir = state.get_prism_workspace()?;
    let safe_old = sanitize_filename(&old_filename)?;
    if !safe_old.ends_with(".prism.yaml") {
        return Err("Old filename must end with .prism.yaml".to_owned());
    }
    let safe_new = ensure_prism_ext(&sanitize_filename(&new_filename)?);
    let old_path = prism_dir.join(&safe_old);
    let new_path = prism_dir.join(&safe_new);

    if !old_path.exists() {
        return Err(format!("Rule file '{safe_old}' not found"));
    }
    if new_path.exists() && safe_old != safe_new {
        return Err(format!("Rule file '{safe_new}' already exists"));
    }

    std::fs::rename(&old_path, &new_path)
        .map_err(|e| format!("Failed to rename rule file: {e}"))?;

    // Update group references
    let mut groups = super::types::read_groups(&prism_dir)?;
    for group in &mut groups.groups {
        for file in &mut group.files {
            if *file == safe_old {
                file.clone_from(&safe_new);
            }
        }
    }
    super::types::write_groups(&prism_dir, &groups)?;

    Ok(safe_new)
}

// ===========================================================================
// Rule extraction from profile
// ===========================================================================

#[tauri::command]
pub fn rule_extract_from_profile(
    state: State<PrismState>,
    profile_id: String,
    name: String,
) -> Result<String, String> {
    let raw = state.with_ext(|ext| ext.read_raw_profile(&profile_id))?;

    // Parse YAML and extract rules section
    let yaml: serde_yaml::Value =
        serde_yaml::from_str(&raw).map_err(|e| format!("Failed to parse profile YAML: {e}"))?;

    let rules = yaml
        .get("rules")
        .and_then(|v| v.as_sequence())
        .ok_or_else(|| "No 'rules' section found in profile".to_owned())?;

    if rules.is_empty() {
        return Err("Profile has no rules".to_owned());
    }

    // Build .prism.yaml content with $append DSL so Prism Engine
    // injects rules at the end instead of replacing the entire array.
    // Replace proxy group names with {{proxy}} for cross-subscription reuse.
    // Built-in policies (DIRECT, REJECT, PASS) are kept as-is.
    const BUILTIN_POLICIES: &[&str] = &["DIRECT", "REJECT", "PASS"];
    let mut lines = Vec::with_capacity(rules.len() + 5);
    // Mark as disabled by default so the context menu doesn't show a false "checked"
    // state before the user explicitly applies the rule.
    lines.push("__when__:".to_owned());
    lines.push("  enabled: false".to_owned());
    lines.push(String::new());
    lines.push("rules:".to_owned());
    lines.push("  $append:".to_owned());
    for rule in rules {
        if let Some(s) = rule.as_str() {
            // Rule format: TYPE,MATCH,POLICY[,opts]
            // Replace the 3rd field (policy) with {{proxy}} unless it's a built-in
            let parts: Vec<&str> = s.splitn(4, ',').collect();
            if parts.len() >= 3 {
                let policy = parts.get(2).map(|p| p.trim()).unwrap_or("");
                if BUILTIN_POLICIES
                    .iter()
                    .any(|b| b.eq_ignore_ascii_case(policy))
                {
                    lines.push(format!("    - {s}"));
                } else {
                    // Reconstruct with {{proxy}} as the policy
                    let mut rebuilt = String::new();
                    if let Some(p0) = parts.first() {
                        rebuilt.push_str(p0);
                    }
                    rebuilt.push(',');
                    if let Some(p1) = parts.get(1) {
                        rebuilt.push_str(p1);
                    }
                    rebuilt.push_str(",{{proxy}}");
                    let mut line = String::from("    - ");
                    line.push_str(&rebuilt);
                    if let Some(opts) = parts.get(3) {
                        line.push(',');
                        line.push_str(opts);
                    }
                    lines.push(line);
                }
            } else {
                lines.push(format!("    - {s}"));
            }
        }
    }
    let content = lines.join("\n") + "\n";

    // Write the file
    let prism_dir = state.get_prism_workspace()?;
    let filename = ensure_prism_ext(&sanitize_filename(&name)?);
    let path = prism_dir.join(&filename);
    if path.exists() {
        return Err(format!("Rule file '{filename}' already exists"));
    }
    write_file_secure(&path, &content)?;
    Ok(filename)
}

// ===========================================================================
// Rule Import
// ===========================================================================

#[tauri::command]
pub fn rule_import_text(
    state: State<PrismState>,
    text: String,
    name: String,
) -> Result<String, String> {
    let content = normalize_to_prism_yaml(&text);
    if content.is_empty() {
        return Err("No valid rules found in input text".to_owned());
    }

    // Strip dangerous keys from imported YAML
    let mut yaml_value: serde_yaml::Value =
        serde_yaml::from_str(&content).map_err(|e| format!("Invalid YAML: {e}"))?;
    remove_dangerous_keys(&mut yaml_value, false);
    let safe_content =
        serde_yaml::to_string(&yaml_value).map_err(|e| format!("Failed to serialize: {e}"))?;

    let prism_dir = state.get_prism_workspace()?;
    let filename = ensure_prism_ext(&sanitize_filename(&name)?);
    let path = prism_dir.join(&filename);
    if path.exists() {
        return Err(format!("Rule file '{filename}' already exists"));
    }
    write_file_secure(&path, &safe_content)?;
    Ok(filename)
}

#[tauri::command]
pub fn rule_import_file(
    state: State<PrismState>,
    file_path: String,
    name: String,
) -> Result<String, String> {
    // C-2: Validate and restrict the file path
    let path = std::path::Path::new(&file_path);

    // Resolve to absolute canonical path
    let resolved = path
        .canonicalize()
        .map_err(|e| format!("File not found or invalid path: {e}"))?;

    // Verify the resolved path is NOT inside the prism directory
    let prism_dir = state.get_prism_workspace()?;
    let prism_canonical = prism_dir
        .canonicalize()
        .unwrap_or_else(|_| prism_dir.clone());
    if resolved.starts_with(&prism_canonical) {
        return Err("Cannot import files from the prism directory".to_owned());
    }

    // Verify the file has a reasonable extension
    const ALLOWED_EXTENSIONS: &[&str] = &["yaml", "yml", "conf", "txt", "list"];
    let has_valid_ext = resolved
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ALLOWED_EXTENSIONS.contains(&ext));
    if !has_valid_ext {
        return Err("File must have a .yaml, .yml, .conf, .txt, or .list extension".to_owned());
    }

    // Check file size (max 10MB)
    let metadata =
        std::fs::metadata(&resolved).map_err(|e| format!("Failed to read file metadata: {e}"))?;
    if metadata.len() > MAX_RESPONSE_SIZE as u64 {
        return Err(format!(
            "File exceeds maximum size of {MAX_RESPONSE_SIZE} bytes"
        ));
    }

    let raw =
        std::fs::read_to_string(&resolved).map_err(|e| format!("Failed to read file: {e}"))?;

    let content = normalize_to_prism_yaml(&raw);
    if content.is_empty() {
        return Err("No valid rules found in file".to_owned());
    }

    // Strip dangerous keys from imported YAML
    let mut yaml_value: serde_yaml::Value =
        serde_yaml::from_str(&content).map_err(|e| format!("Invalid YAML: {e}"))?;
    remove_dangerous_keys(&mut yaml_value, false);
    let safe_content =
        serde_yaml::to_string(&yaml_value).map_err(|e| format!("Failed to serialize: {e}"))?;

    let filename = ensure_prism_ext(&sanitize_filename(&name)?);
    let target = prism_dir.join(&filename);
    if target.exists() {
        return Err(format!("Rule file '{filename}' already exists"));
    }
    write_file_secure(&target, &safe_content)?;
    Ok(filename)
}

#[tauri::command]
/// Import rules from a remote URL.
///
/// Validates the URL scheme and resolves DNS to prevent SSRF attacks.
/// The resolved IP is pinned to prevent DNS rebinding between validation
/// and the actual HTTP request. Response body is limited to 10 MB.
///
/// Rate-limited: 5 calls per 10 seconds.
pub async fn rule_import_url(
    state: State<'_, PrismState>,
    url: String,
    name: String,
) -> Result<String, String> {
    state.check_rate_limit("rule_import_url")?;
    // C-3: Validate URL scheme and resolve DNS to prevent SSRF (rebinding/TOCTOU)
    let (validated_host, resolved_addr, user_entered_private) =
        validate_subscription_url_with_ip(&url)?;

    // For user-entered private addresses, skip DNS pinning.
    // For public addresses, pin resolved IP to prevent DNS rebinding.
    let resolve_pin = if user_entered_private {
        None
    } else {
        resolved_addr.map(|addr| (validated_host, addr))
    };

    // M-3: Add connection and read timeouts (async client)
    let client = crate::core_manager::core::subscription::build_http_client(None, resolve_pin)
        .map_err(|e| format!("HTTP client build failed: {e}"))?;

    let res = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Failed to download: {e}"))?;

    if !res.status().is_success() {
        return Err(format!("HTTP error: {}", res.status()));
    }

    // M-4: Check Content-Length header before reading body, reject if > 10MB
    if let Some(len) = res.content_length() {
        if usize::try_from(len).unwrap_or(0) > MAX_RESPONSE_SIZE {
            return Err(format!(
                "Response body exceeds maximum size of {MAX_RESPONSE_SIZE} bytes"
            ));
        }
    }

    // Read response with byte limit
    let bytes = res
        .bytes()
        .await
        .map_err(|e| format!("Failed to read response body: {e}"))?;

    if bytes.len() > MAX_RESPONSE_SIZE {
        return Err(format!(
            "Response body exceeds maximum size of {MAX_RESPONSE_SIZE} bytes"
        ));
    }

    let raw = String::from_utf8(bytes.to_vec())
        .map_err(|e| format!("Response body is not valid UTF-8: {e}"))?;

    let content = normalize_to_prism_yaml(&raw);
    if content.is_empty() {
        return Err("No valid rules found in downloaded content".to_owned());
    }

    // Strip dangerous keys from imported YAML
    let mut yaml_value: serde_yaml::Value =
        serde_yaml::from_str(&content).map_err(|e| format!("Invalid YAML: {e}"))?;
    remove_dangerous_keys(&mut yaml_value, false);
    let safe_content =
        serde_yaml::to_string(&yaml_value).map_err(|e| format!("Failed to serialize: {e}"))?;

    let prism_dir = state.get_prism_workspace()?;
    let filename = ensure_prism_ext(&sanitize_filename(&name)?);
    let target = prism_dir.join(&filename);
    if target.exists() {
        return Err(format!("Rule file '{filename}' already exists"));
    }
    write_file_secure(&target, &safe_content)?;
    Ok(filename)
}
