use crate::core_manager::MihomoState;
use std::fs::{self, File};
use std::path::PathBuf;
use std::process::Command;
use tauri::{AppHandle, Manager as _};
use tauri_plugin_dialog::DialogExt as _;

use super::core_process::ensure_app_storage;
use super::crypto::{
    cleanup_metadata_cache, load_metadata, read_profile_file, save_metadata, write_profile_file,
    ConfigMetadata, ProfilesMetadata,
};
use super::secure_io::write_file_secure;
use super::ConfigInfo;
use zephyr_core::config::sanitizer::{sanitize_config_file_name, validate_path_within_dir};

/// Update a field on an existing metadata entry (or create the entry first).
fn update_metadata_entry<F>(
    metadata: &mut ProfilesMetadata,
    safe_name: &str,
    app: &AppHandle,
    update: F,
) where
    F: FnOnce(&mut ConfigMetadata),
{
    let entry = metadata
        .configs
        .entry(safe_name.to_owned())
        .or_insert_with(|| {
            let url = get_config_url(app, safe_name).ok();
            ConfigMetadata {
                url,
                sub_info: None,
                last_updated: None,
                auto_update_interval: None,
            }
        });
    update(entry);
}

/// Common validation for config update commands.
/// Returns sanitized name and app paths if valid.
fn validate_config_for_update(
    app: &AppHandle,
    name: &str,
) -> Result<(super::AppPaths, String), String> {
    let safe_name = sanitize_config_file_name(name.to_owned()).map_err(|e| e.to_string())?;
    if safe_name == "run_config.yaml" {
        return Err("Cannot modify the active temp config".to_owned());
    }
    let paths = ensure_app_storage(app)?;
    let config_path = paths.profiles_dir.join(&safe_name);
    if !config_path.exists() {
        return Err(format!("Config not found: {safe_name}"));
    }
    Ok((paths, safe_name))
}

/// Mask URL for safe display in UI — delegates to [`zephyr_core`].
#[must_use]
pub fn mask_url(url: &str) -> String {
    zephyr_core::config::merge::mask_url(url.to_owned())
}

#[tauri::command]
pub async fn list_configs(app: AppHandle) -> Result<Vec<ConfigInfo>, String> {
    let mut configs = Vec::new();
    let paths = ensure_app_storage(&app)?;

    // Clean up stale metadata entries
    cleanup_metadata_cache(&paths);

    let metadata = load_metadata(&paths);

    if let Ok(entries) = fs::read_dir(&paths.profiles_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path
                .extension()
                .is_some_and(|ext| ext == "yaml" || ext == "yml")
            {
                if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                    if name != "run_config.yaml" {
                        let (url, sub_info, last_updated, auto_update_interval) =
                            if let Some(meta) = metadata.configs.get(name) {
                                (
                                    meta.url.clone(),
                                    meta.sub_info.clone(),
                                    meta.last_updated,
                                    meta.auto_update_interval,
                                )
                            } else {
                                // Fallback to reading old comments
                                let mut url = None;
                                let mut sub_info = None;
                                if let Ok(file) = std::fs::File::open(&path) {
                                    use std::io::{BufRead as _, BufReader};
                                    let reader = BufReader::new(file);
                                    for line in reader.lines().take(50).map_while(Result::ok) {
                                        if line.starts_with("# URL: ") {
                                            url =
                                                Some(line.replace("# URL: ", "").trim().to_owned());
                                        } else if line.starts_with("# SUB_INFO: ") {
                                            sub_info = Some(
                                                line.replace("# SUB_INFO: ", "").trim().to_owned(),
                                            );
                                        }
                                    }
                                }
                                (url, sub_info, None, None)
                            };

                        let url_display = url.as_ref().map(|u| mask_url(u));

                        configs.push(ConfigInfo {
                            name: name.to_owned(),
                            url,
                            url_display,
                            sub_info,
                            last_updated,
                            auto_update_interval,
                        });
                    }
                }
            }
        }
    }
    configs.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(configs)
}

/// Get the full (unmasked) subscription URL for a given config name.
/// Internal use only — NOT exposed as a Tauri command to prevent URL leakage to the frontend.
pub fn get_config_url(app: &AppHandle, name: &str) -> Result<String, String> {
    // Reuse comprehensive sanitization (URL decode, path traversal check, etc.)
    let safe_name = sanitize_config_file_name(name.to_owned()).map_err(|e| e.to_string())?;

    let paths = ensure_app_storage(app)?;
    let metadata = load_metadata(&paths);

    // Look up URL from metadata first
    if let Some(meta) = metadata.configs.get(&safe_name) {
        if let Some(url) = &meta.url {
            return Ok(url.clone());
        }
    }

    // Fallback: read from file comments (legacy format)
    let path = paths.profiles_dir.join(&safe_name);
    if let Ok(file) = std::fs::File::open(&path) {
        use std::io::{BufRead as _, BufReader};
        let reader = BufReader::new(file);
        for line in reader.lines().map_while(Result::ok) {
            if line.starts_with("# URL: ") {
                return Ok(line.replace("# URL: ", "").trim().to_owned());
            }
        }
    }

    Err(format!("No subscription URL found for config: {name}"))
}

/// Update the subscription URL for an existing config in metadata.
#[tauri::command]
pub async fn update_config_url(
    app: AppHandle,
    name: String,
    new_url: String,
) -> Result<(), String> {
    let (paths, safe_name) = validate_config_for_update(&app, &name)?;

    // Trim whitespace before validation and storage
    let trimmed_url = new_url.trim();

    // Structural URL validation
    let parsed = url::Url::parse(trimmed_url).map_err(|e| format!("Invalid URL: {e}"))?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err("URL must use http:// or https://".to_owned());
    }

    let mut metadata = load_metadata(&paths);
    update_metadata_entry(&mut metadata, &safe_name, &app, |entry| {
        entry.url = Some(trimmed_url.to_owned());
    });
    save_metadata(&paths, &metadata)?;

    Ok(())
}

/// Update the auto-update interval for a subscription.
#[tauri::command]
pub async fn update_subscription_interval(
    app: AppHandle,
    name: String,
    interval: u64,
) -> Result<(), String> {
    let (paths, safe_name) = validate_config_for_update(&app, &name)?;

    let mut metadata = load_metadata(&paths);
    update_metadata_entry(&mut metadata, &safe_name, &app, |entry| {
        entry.auto_update_interval = (interval > 0).then_some(interval);
    });
    save_metadata(&paths, &metadata)?;

    Ok(())
}

#[tauri::command]
pub async fn delete_config(app: AppHandle, name: String) -> Result<String, String> {
    let paths = ensure_app_storage(&app)?;

    // Ensure the name has a .yaml extension
    let mut clean_name = if name.ends_with(".yaml") || name.ends_with(".yml") {
        name.clone()
    } else {
        format!("{name}.yaml")
    };

    clean_name = sanitize_config_file_name(clean_name).map_err(|e| e.to_string())?;
    if clean_name == "run_config.yaml" {
        return Err("Cannot delete the active temp config".to_owned());
    }

    let target_path = paths.profiles_dir.join(&clean_name);
    validate_path_within_dir(&target_path, &paths.profiles_dir).map_err(|e| e.to_string())?;

    let file_exists = target_path.exists();

    if !file_exists {
        // Try with .yml extension as well
        let yml_name = name.replace(".yaml", ".yml");
        let yml_path = paths.profiles_dir.join(&yml_name);

        if yml_path.exists() {
            fs::remove_file(&yml_path).map_err(|e| format!("Failed to delete file: {e}"))?;
            let mut metadata = load_metadata(&paths);
            metadata.configs.remove(&yml_name);
            save_metadata(&paths, &metadata)?;
            return Ok(format!("Config {yml_name} deleted"));
        }
        return Err("File does not exist".to_owned());
    }

    // Delete the file first, then update metadata
    // This ensures metadata consistency: if file deletion fails, metadata stays intact
    fs::remove_file(&target_path).map_err(|e| format!("Failed to delete file: {e}"))?;

    // Verify deletion (Windows may report success but file remains if locked)
    if target_path.exists() {
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        fs::remove_file(&target_path).map_err(|e| format!("Failed to delete file: {e}"))?;

        if target_path.exists() {
            return Err("File could not be deleted (locked by another process?)".to_owned());
        }
    }

    // File deleted successfully — now update metadata
    // Use clean_name for metadata removal (matches the actual file key stored)
    let mut metadata = load_metadata(&paths);
    metadata.configs.remove(&clean_name);
    // Also try the original name in case metadata was stored with a different key
    if name != clean_name {
        metadata.configs.remove(&name);
    }
    save_metadata(&paths, &metadata)?;

    Ok(format!("Config {name} deleted"))
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn read_config_file(app: AppHandle, config_path: String) -> Result<String, String> {
    let paths = ensure_app_storage(&app)?;
    let config_file_name = sanitize_config_file_name(config_path).map_err(|e| e.to_string())?;
    let (resolved_path, base_dir) = if config_file_name == "run_config.yaml" {
        (
            paths.core_dir.join(&config_file_name),
            paths.core_dir.clone(),
        )
    } else {
        (
            paths.profiles_dir.join(&config_file_name),
            paths.profiles_dir.clone(),
        )
    };

    validate_path_within_dir(&resolved_path, &base_dir).map_err(|e| e.to_string())?;

    if !resolved_path.exists() {
        return Err("Config file not found".to_owned());
    }

    // run_config.yaml is always plaintext; profile files may be encrypted
    if config_file_name == "run_config.yaml" {
        fs::read_to_string(&resolved_path).map_err(|e| format!("Failed to read config: {e}"))
    } else {
        read_profile_file(&resolved_path)
    }
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn write_config_file(
    app: AppHandle,
    config_path: String,
    content: String,
) -> Result<String, String> {
    let paths = ensure_app_storage(&app)?;
    let config_file_name = sanitize_config_file_name(config_path).map_err(|e| e.to_string())?;
    let (resolved_path, base_dir) = if config_file_name == "run_config.yaml" {
        (
            paths.core_dir.join(&config_file_name),
            paths.core_dir.clone(),
        )
    } else {
        (
            paths.profiles_dir.join(&config_file_name),
            paths.profiles_dir.clone(),
        )
    };

    validate_path_within_dir(&resolved_path, &base_dir).map_err(|e| e.to_string())?;

    // run_config.yaml is always plaintext; profile files may be encrypted
    if config_file_name == "run_config.yaml" {
        write_file_secure(&resolved_path, &content)?;
    } else {
        let encrypt = {
            let settings_state = app.state::<crate::SettingsState>();
            let settings = settings_state
                .0
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            settings.encrypt_configs
        };
        write_profile_file(&resolved_path, &content, encrypt)?;
    }

    Ok("Config saved".to_owned())
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn open_config_folder(app: AppHandle) -> Result<String, String> {
    let paths = ensure_app_storage(&app)?;
    let target = paths.profiles_dir;

    #[cfg(target_os = "windows")]
    {
        Command::new("explorer")
            .arg(&target)
            .spawn()
            .map_err(|e| format!("Failed to open config folder: {e}"))?;
    }

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(&target)
            .spawn()
            .map_err(|e| format!("Failed to open config folder: {e}"))?;
    }

    #[cfg(target_os = "linux")]
    {
        Command::new("xdg-open")
            .arg(&target)
            .spawn()
            .map_err(|e| format!("Failed to open config folder: {e}"))?;
    }

    Ok(target.to_string_lossy().into_owned())
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn rename_config(app: AppHandle, old_name: String, new_name: String) -> Result<String, String> {
    let paths = ensure_app_storage(&app)?;

    // Sanitize old name
    let mut clean_old = if old_name.ends_with(".yaml") || old_name.ends_with(".yml") {
        old_name.clone()
    } else {
        format!("{old_name}.yaml")
    };
    clean_old = sanitize_config_file_name(clean_old).map_err(|e| e.to_string())?;
    if clean_old == "run_config.yaml" {
        return Err("Cannot rename the active temp config".to_owned());
    }

    // Sanitize new name
    let mut clean_new = if new_name.ends_with(".yaml") || new_name.ends_with(".yml") {
        new_name
    } else {
        format!("{new_name}.yaml")
    };
    clean_new = sanitize_config_file_name(clean_new).map_err(|e| e.to_string())?;
    if clean_new == "run_config.yaml" {
        return Err("Cannot use reserved name 'run_config'".to_owned());
    }

    let old_path = paths.profiles_dir.join(&clean_old);
    let new_path = paths.profiles_dir.join(&clean_new);
    validate_path_within_dir(&old_path, &paths.profiles_dir).map_err(|e| e.to_string())?;
    validate_path_within_dir(&new_path, &paths.profiles_dir).map_err(|e| e.to_string())?;

    if !old_path.exists() {
        return Err(format!("Config '{clean_old}' does not exist"));
    }
    if clean_old == clean_new {
        return Err("New name is the same as the current name".to_owned());
    }
    if new_path.exists() {
        return Err(format!("A config named '{clean_new}' already exists"));
    }

    // Rename file
    std::fs::rename(&old_path, &new_path).map_err(|e| format!("Failed to rename config: {e}"))?;

    // Update metadata
    let mut metadata = load_metadata(&paths);
    if let Some(meta) = metadata.configs.remove(&clean_old) {
        metadata.configs.insert(clean_new.clone(), meta);
    }
    // Also try original name in case metadata was stored differently
    if old_name != clean_old {
        if let Some(meta) = metadata.configs.remove(&old_name) {
            metadata.configs.insert(clean_new.clone(), meta);
        }
    }
    save_metadata(&paths, &metadata)?;

    // Update last_config setting if it references the old name
    // Also migrate last_proxy_selection key from old name to new name
    let mut last_config_updated = false;
    {
        let state = app.state::<crate::SettingsState>();
        let mut guard = state
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut dirty = false;

        // Update last_config if it references the old name
        if guard.last_config.as_deref() == Some(&clean_old)
            || guard.last_config.as_deref() == Some(&old_name)
        {
            guard.last_config = Some(clean_new.clone());
            dirty = true;
            last_config_updated = true;
        }

        // Migrate proxy selection key
        let node_to_migrate = guard.last_proxy_selection.remove(&clean_old).or_else(|| {
            if old_name != clean_old {
                guard.last_proxy_selection.remove(&old_name)
            } else {
                None
            }
        });
        if let Some(node) = node_to_migrate {
            guard.last_proxy_selection.insert(clean_new.clone(), node);
            dirty = true;
        }

        // Migrate primary group preference key
        let group_to_migrate = guard
            .primary_group_preference
            .remove(&clean_old)
            .or_else(|| {
                if old_name != clean_old {
                    guard.primary_group_preference.remove(&old_name)
                } else {
                    None
                }
            });
        if let Some(group) = group_to_migrate {
            guard
                .primary_group_preference
                .insert(clean_new.clone(), group);
            dirty = true;
        }

        if dirty {
            let settings = guard.clone();
            drop(guard);
            if let Err(e) = crate::persist_settings(&app, &settings) {
                emit_error!(
                    Config,
                    CONFIG_SAVE_FAILED,
                    "Failed to persist settings: {e}"
                );
            }
        }
    }

    // Sync runtime MihomoState.last_config_path
    if last_config_updated {
        let mihomo = app.state::<MihomoState>();
        if let Ok(mut guard) = mihomo.0.lock() {
            guard.set_last_config_path(Some(clean_new.clone()));
        };
    }

    Ok(format!("Config renamed to {clean_new}"))
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    // ── mask_url tests ─────────────────────────────────────────────────────

    #[test]
    fn test_mask_long_domain() {
        let result =
            mask_url("https://very-long-domain-name.example.com/path/to/config?token=secret");
        assert!(result.contains("***"));
        assert!(!result.contains("very-long-domain-name"));
        assert!(!result.contains("secret"));
    }

    #[test]
    fn test_mask_short_domain() {
        let result = mask_url("https://ab.cd/path");
        assert!(result.contains("***"));
    }

    #[test]
    fn test_mask_invalid_url() {
        let result = mask_url("not-a-url");
        assert_eq!(result, "***");
    }

    #[test]
    fn test_mask_ip_url() {
        let result = mask_url("http://192.168.1.1:7890/api");
        assert!(result.contains("***"));
    }

    #[test]
    fn test_mask_preserves_scheme() {
        let result = mask_url("https://example.com/path");
        assert!(result.starts_with("https://"));
    }

    #[test]
    fn test_mask_http_scheme() {
        let result = mask_url("http://example.com/path");
        assert!(result.starts_with("http://"));
    }

    #[test]
    fn test_mask_hides_path_and_query() {
        let result = mask_url("https://example.com/secret/path?token=abc123");
        assert!(!result.contains("/secret/path"));
        assert!(!result.contains("token=abc123"));
        assert!(result.ends_with("/***"));
    }

    // ── dangerous_keys tests ───────────────────────────────────────────────

    #[test]
    fn test_top_level_script_removed() {
        let yaml = "script: test.js\nport: 7890";
        let mut value: serde_yaml::Value = serde_yaml::from_str(yaml).unwrap();
        zephyr_core::config::sanitizer::remove_dangerous_keys_internal_pub(&mut value, false);
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
    fn test_nested_script_in_proxy_group_removed() {
        let yaml = r"
proxy-groups:
  - name: test
    type: select
    script: malicious.js
    proxies:
      - proxy1
";
        let mut value: serde_yaml::Value = serde_yaml::from_str(yaml).unwrap();
        zephyr_core::config::sanitizer::remove_dangerous_keys_internal_pub(&mut value, false);

        let groups = value.get("proxy-groups").unwrap().as_sequence().unwrap();
        let group = groups.first().unwrap().as_mapping().unwrap();
        assert!(!group.contains_key(serde_yaml::Value::String("script".to_owned())));
        assert!(group.contains_key(serde_yaml::Value::String("name".to_owned())));
    }

    #[test]
    fn test_provider_path_removed() {
        let yaml = r"
proxy-providers:
  my-provider:
    type: http
    url: https://example.com/proxies.yaml
    path: /etc/passwd
    interval: 3600
";
        let mut value: serde_yaml::Value = serde_yaml::from_str(yaml).unwrap();
        zephyr_core::config::sanitizer::remove_dangerous_keys_internal_pub(&mut value, false);

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
    fn test_non_provider_path_preserved() {
        let yaml = r#"
tun:
  enable: false
  stack: system
  dns-hijack:
    - any:53
    - tcp://any:53
proxies:
  - name: "test"
    type: ss
    server: 127.0.0.1
    port: 8388
"#;
        let mut value: serde_yaml::Value = serde_yaml::from_str(yaml).unwrap();
        zephyr_core::config::sanitizer::remove_dangerous_keys_internal_pub(&mut value, false);

        let proxies = value.get("proxies").unwrap().as_sequence().unwrap();
        let proxy = proxies.first().unwrap().as_mapping().unwrap();
        assert!(proxy.contains_key(serde_yaml::Value::String("port".to_owned())));
    }

    #[test]
    fn test_deeply_nested_script_removed() {
        let yaml = r#"
rules:
  - SCRIPT,test.js,DIRECT
  - MATCH,PROXY
script:
  code: |
    function main() { return "malicious" }
"#;
        let mut value: serde_yaml::Value = serde_yaml::from_str(yaml).unwrap();
        zephyr_core::config::sanitizer::remove_dangerous_keys_internal_pub(&mut value, false);

        assert!(!value
            .as_mapping()
            .unwrap()
            .contains_key(serde_yaml::Value::String("script".to_owned())));
    }

    #[test]
    fn test_script_path_removed() {
        let yaml = r"
script-path: /malicious/script.js
mode: rule
";
        let mut value: serde_yaml::Value = serde_yaml::from_str(yaml).unwrap();
        zephyr_core::config::sanitizer::remove_dangerous_keys_internal_pub(&mut value, false);

        assert!(!value
            .as_mapping()
            .unwrap()
            .contains_key(serde_yaml::Value::String("script-path".to_owned())));
    }

    #[test]
    fn test_provider_without_path_preserved() {
        let yaml = r"
rule-providers:
  my-rules:
    type: http
    url: https://example.com/rules.yaml
    interval: 86400
";
        let mut value: serde_yaml::Value = serde_yaml::from_str(yaml).unwrap();
        zephyr_core::config::sanitizer::remove_dangerous_keys_internal_pub(&mut value, false);

        let providers = value.get("rule-providers").unwrap().as_mapping().unwrap();
        assert!(providers.contains_key(serde_yaml::Value::String("my-rules".to_owned())));
    }
}

// ── Log Folder & Export ──────────────────────────────────────────────────────

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn open_log_folder(app: AppHandle) -> Result<String, String> {
    let paths = ensure_app_storage(&app)?;
    let logs_dir = paths.app_data_dir.join("logs");
    fs::create_dir_all(&logs_dir).map_err(|e| format!("Failed to create logs dir: {e}"))?;

    #[cfg(target_os = "windows")]
    {
        Command::new("explorer")
            .arg(&logs_dir)
            .spawn()
            .map_err(|e| format!("Failed to open log folder: {e}"))?;
    }

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(&logs_dir)
            .spawn()
            .map_err(|e| format!("Failed to open log folder: {e}"))?;
    }

    #[cfg(target_os = "linux")]
    {
        Command::new("xdg-open")
            .arg(&logs_dir)
            .spawn()
            .map_err(|e| format!("Failed to open log folder: {e}"))?;
    }

    Ok(logs_dir.to_string_lossy().into_owned())
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn export_logs(
    app: AppHandle,
    log_type: String,
    from_date: String,
    to_date: String,
    level: Option<String>,
) -> Result<String, String> {
    use std::io::Write as _;
    use zip::write::SimpleFileOptions;

    let paths = ensure_app_storage(&app)?;
    let logs_base = paths.app_data_dir.join("logs");

    // Collect files based on log_type
    let mut files_to_export: Vec<(String, PathBuf)> = Vec::new(); // (relative_path, absolute_path)

    if log_type == "app" || log_type == "all" {
        let app_dir = logs_base.join("app");
        for path in super::log_writer::collect_log_files(&app_dir, &from_date, &to_date) {
            let name = path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned();
            files_to_export.push((format!("app/{name}"), path));
        }
    }
    if log_type == "core" || log_type == "all" {
        let core_dir = logs_base.join("core");
        for path in super::log_writer::collect_log_files(&core_dir, &from_date, &to_date) {
            let name = path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned();
            files_to_export.push((format!("core/{name}"), path));
        }
    }

    if files_to_export.is_empty() {
        return Err("No log files found for the selected date range".to_owned());
    }

    // Use dialog to pick save location
    let file_path = app
        .dialog()
        .file()
        .add_filter("ZIP", &["zip"])
        .set_file_name("zephyr-logs.zip")
        .blocking_save_file()
        .ok_or_else(|| "Export cancelled".to_owned())?;

    let save_path = file_path
        .as_path()
        .ok_or_else(|| "Invalid save path".to_owned())?;

    // Create zip
    let zip_file =
        File::create(save_path).map_err(|e| format!("Failed to create zip file: {e}"))?;
    let mut zip_writer = zip::ZipWriter::new(zip_file);
    let zip_options =
        SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);

    for (relative_path, abs_path) in &files_to_export {
        zip_writer
            .start_file(relative_path, zip_options)
            .map_err(|e| format!("Failed to add file to zip: {e}"))?;

        let mut file = File::open(abs_path)
            .map_err(|e| format!("Failed to open log file {abs_path:?}: {e}"))?;

        if let Some(lvl) = &level {
            let lvl_lower = lvl.to_lowercase();
            if lvl_lower.is_empty() || lvl_lower == "all" {
                std::io::copy(&mut file, &mut zip_writer)
                    .map_err(|e| format!("Failed to copy log file to zip: {e}"))?;
            } else {
                use std::io::BufRead as _;
                let reader = std::io::BufReader::new(file);
                for raw_line in reader.lines() {
                    let line = raw_line.map_err(|e| format!("Failed to read line: {e}"))?;
                    let line_lower = line.to_ascii_lowercase();
                    let matched = match lvl_lower.as_str() {
                        "error" => {
                            line_lower.contains("[error]") || line_lower.contains("level=error")
                        }
                        "warn" => {
                            line_lower.contains("[warn]")
                                || line_lower.contains("level=warn")
                                || line_lower.contains("[warning]")
                                || line_lower.contains("level=warning")
                        }
                        "info" => {
                            line_lower.contains("[info]") || line_lower.contains("level=info")
                        }
                        "fatal" => {
                            line_lower.contains("[fatal]") || line_lower.contains("level=fatal")
                        }
                        _ => true,
                    };
                    if matched {
                        zip_writer
                            .write_all(line.as_bytes())
                            .map_err(|e| format!("Failed to write line to zip: {e}"))?;
                        zip_writer
                            .write_all(b"\n")
                            .map_err(|e| format!("Failed to write newline to zip: {e}"))?;
                    }
                }
            }
        } else {
            std::io::copy(&mut file, &mut zip_writer)
                .map_err(|e| format!("Failed to copy log file to zip: {e}"))?;
        }
    }

    zip_writer
        .finish()
        .map_err(|e| format!("Failed to finalize zip: {e}"))?;

    Ok(save_path.to_string_lossy().into_owned())
}
