use crate::core_manager::MihomoState;
use crate::{persist_settings, SettingsState};
use std::fs::{self, File};
use std::path::PathBuf;
use std::process::Command;
use tauri::{AppHandle, Manager as _, State};
use tauri_plugin_dialog::DialogExt as _;

use super::core_process::ensure_app_storage;
use super::crypto::{
    cleanup_metadata_cache, load_metadata, lock_metadata, read_profile_file, save_metadata,
    write_profile_file, ConfigMetadata, ProfilesMetadata,
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
                user_agent: None,
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
                        let (url, sub_info, last_updated, auto_update_interval, user_agent) =
                            if let Some(meta) = metadata.configs.get(name) {
                                (
                                    meta.url.clone(),
                                    meta.sub_info.clone(),
                                    meta.last_updated,
                                    meta.auto_update_interval,
                                    meta.user_agent.clone(),
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
                                (url, sub_info, None, None, None)
                            };

                        let url_display = url.as_ref().map(|u| mask_url(u));

                        configs.push(ConfigInfo {
                            name: name.to_owned(),
                            url,
                            url_display,
                            sub_info,
                            last_updated,
                            auto_update_interval,
                            user_agent,
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

    let _guard = lock_metadata();
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

    let _guard = lock_metadata();
    let mut metadata = load_metadata(&paths);
    update_metadata_entry(&mut metadata, &safe_name, &app, |entry| {
        entry.auto_update_interval = (interval > 0).then_some(interval);
    });
    save_metadata(&paths, &metadata)?;

    Ok(())
}

/// Update the per-subscription User-Agent override.
/// When `user_agent` is `None` or empty, the subscription falls back to the
/// global `subscription_user_agent` from settings.
#[tauri::command]
pub async fn update_subscription_ua(
    app: AppHandle,
    name: String,
    user_agent: Option<String>,
) -> Result<(), String> {
    let (paths, safe_name) = validate_config_for_update(&app, &name)?;

    let normalized = user_agent
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from);

    if let Some(ua) = normalized.as_ref() {
        if ua.len() > 512 {
            return Err("User-Agent exceeds maximum length of 512 characters".to_owned());
        }
        if !ua.chars().all(|c| c.is_ascii() && !c.is_ascii_control()) {
            return Err("User-Agent contains invalid characters".to_owned());
        }
    }

    let _guard = lock_metadata();
    let mut metadata = load_metadata(&paths);
    update_metadata_entry(&mut metadata, &safe_name, &app, |entry| {
        entry.user_agent.clone_from(&normalized);
    });
    save_metadata(&paths, &metadata)?;

    Ok(())
}

/// Strip `.yaml`/`.yml` 扩展名（大小写不敏感），返回剩余部分；无扩展名则原样返回。
/// 用于配置名比较时忽略扩展名差异（如 "foo.yaml" vs "foo.yml" / "foo.YAML" / "foo.Yaml"）。
/// 在 Windows/macOS 等大小写不敏感文件系统上，扩展名可能是任意大小写组合。
/// 使用 `str::get` 安全切片，避免多字节 UTF-8 字符（如中文）导致字节索引落在字符中间而 panic。
fn strip_yaml_ext(name: &str) -> &str {
    if name.len() >= 5 {
        if let Some(suffix) = name.get(name.len() - 5..) {
            if suffix.eq_ignore_ascii_case(".yaml") {
                // 此时后 5 字节是 ".yaml"，前缀必然是合法 UTF-8 边界
                return &name[..name.len() - 5];
            }
        }
    }
    if name.len() >= 4 {
        if let Some(suffix) = name.get(name.len() - 4..) {
            if suffix.eq_ignore_ascii_case(".yml") {
                return &name[..name.len() - 4];
            }
        }
    }
    name
}

/// 删除配置后检查 `last_config` 是否悬空（指向已删除的文件）。
/// 如果是，重置为第一个可用配置；如果没有任何配置，置为 `None`。
fn cleanup_dangling_last_config(
    app: &AppHandle,
    state: &State<'_, SettingsState>,
    paths: &super::AppPaths,
    deleted_name: &str,
) {
    // 判断 last_config 是否指向已删除的配置（规范化 + strip 扩展名后比较）
    // 提取为闭包便于两段锁内复用，避免 TOCTOU 竞态时第二段锁无条件覆盖并发更新
    let is_same_config = |lc: &str| -> bool {
        if lc == deleted_name {
            return true;
        }
        let norm_lc = sanitize_config_file_name(lc.to_owned())
            .or_else(|_| sanitize_config_file_name(format!("{lc}.yaml")))
            .unwrap_or_default();
        let norm_del = sanitize_config_file_name(deleted_name.to_owned()).unwrap_or_default();
        !norm_lc.is_empty() && strip_yaml_ext(&norm_lc) == strip_yaml_ext(&norm_del)
    };

    // 第一段持锁：只判断是否需要清理，避免在锁内做阻塞 I/O 导致锁竞争
    let needs_cleanup = {
        let settings_guard = state
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        settings_guard
            .last_config
            .as_deref()
            .is_some_and(is_same_config)
    };

    if !needs_cleanup {
        return;
    }

    // 锁外执行阻塞文件系统 I/O：找到第一个可用的配置文件作为替代
    let new_config = super::core_process::first_available_profile(paths).and_then(|p| {
        p.file_name()
            .and_then(|name| name.to_str())
            .map(std::borrow::ToOwned::to_owned)
    });

    // 第二段持锁：再次确认 last_config 仍指向已删除的配置才覆盖，避免并发修改被丢弃
    let (settings_clone, updated) = {
        let mut settings_guard = state
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if settings_guard
            .last_config
            .as_deref()
            .is_some_and(is_same_config)
        {
            settings_guard.last_config = new_config;
            (settings_guard.clone(), true)
        } else {
            (settings_guard.clone(), false)
        }
    };

    if !updated {
        return;
    }

    if let Err(e) = persist_settings(app, &settings_clone) {
        crate::emit_warn!(
            Config,
            CONFIG_PERSIST_FAILED,
            "Failed to persist settings after last_config cleanup: {e}"
        );
    }
    if let Some(name) = &settings_clone.last_config {
        crate::emit_info!(
            Config,
            CONFIG_DANGLING_REF_CLEANED,
            "last_config was dangling (pointed to deleted '{deleted_name}'), reset to '{name}'"
        );
    } else {
        crate::emit_info!(
            Config,
            CONFIG_DANGLING_REF_CLEANED,
            "last_config was dangling (pointed to deleted '{deleted_name}'), reset to None (no profiles left)"
        );
    }
}

#[tauri::command]
#[allow(private_interfaces)]
pub async fn delete_config(
    app: AppHandle,
    state: State<'_, SettingsState>,
    name: String,
) -> Result<String, String> {
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
            let _guard = lock_metadata();
            let mut metadata = load_metadata(&paths);
            metadata.configs.remove(&yml_name);
            save_metadata(&paths, &metadata)?;
            cleanup_dangling_last_config(&app, &state, &paths, &yml_name);
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
    {
        let _guard = lock_metadata();
        let mut metadata = load_metadata(&paths);
        metadata.configs.remove(&clean_name);
        // Also try the original name in case metadata was stored with a different key
        if name != clean_name {
            metadata.configs.remove(&name);
        }
        save_metadata(&paths, &metadata)?;
    }

    // 如果被删除的配置恰好是 last_config 指向的配置，重置为第一个可用配置，
    // 避免悬空指针导致下次冷启动加载到错误的配置。
    cleanup_dangling_last_config(&app, &state, &paths, &clean_name);

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
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        write_config_file_inner(app, config_path, content)
    }))
    .map_err(|payload| {
        let msg = crate::backend_event::panic_to_string(payload);
        crate::emit_error!(
            Config,
            CONFIG_PANIC_GUARD,
            "Panic in write_config_file: {msg}"
        );
        format!("Internal error in write_config_file: {msg}")
    })
    .and_then(std::convert::identity)
}

#[allow(clippy::needless_pass_by_value)]
fn write_config_file_inner(
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
    {
        let _guard = lock_metadata();
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
    }

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

    tauri_plugin_opener::open_path(&logs_dir, None::<&str>)
        .map_err(|e| format!("Failed to open log folder: {e}"))?;

    Ok(logs_dir.to_string_lossy().into_owned())
}

/// Check whether `haystack` contains `needle` using byte-slice windows search.
/// Zero-allocation alternative to `str::contains()` for `&[u8]` data.
fn contains_bytes(haystack: &[u8], needle: &[u8]) -> bool {
    if needle.is_empty() || needle.len() > haystack.len() {
        return false;
    }
    haystack.windows(needle.len()).any(|w| w == needle)
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub async fn export_logs(
    app: AppHandle,
    log_type: String,
    from_date: String,
    to_date: String,
    level: Option<String>,
) -> Result<String, String> {
    let paths = ensure_app_storage(&app)?;
    let logs_base = paths.app_data_dir.join("logs");

    // Collect files based on log_type
    let mut files_to_export: Vec<(String, PathBuf)> = Vec::new(); // (relative_path, absolute_path)

    let mut dirs_to_check = Vec::new();
    if log_type == "app" || log_type == "all" {
        dirs_to_check.push("app");
    }
    if log_type == "core" || log_type == "all" {
        dirs_to_check.push("core");
    }

    for subdir in dirs_to_check {
        let dir = logs_base.join(subdir);
        for path in super::log_writer::collect_log_files(&dir, &from_date, &to_date) {
            let name = path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned();
            files_to_export.push((format!("{subdir}/{name}"), path));
        }
    }

    if files_to_export.is_empty() {
        return Err("No log files found for the selected date range".to_owned());
    }

    // Use dialog to pick save location (async via oneshot channel)
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .add_filter("ZIP", &["zip"])
        .set_file_name("zephyr-logs.zip")
        .save_file(move |path| {
            let _ = tx.send(path);
        });
    let file_path = rx
        .await
        .map_err(|_e| "Dialog cancelled".to_owned())?
        .ok_or_else(|| "Export cancelled".to_owned())?;

    let save_path = file_path
        .as_path()
        .ok_or_else(|| "Invalid save path".to_owned())?
        .to_path_buf();

    // Run heavy zip creation on a dedicated blocking thread
    let level_clone = level.clone();
    tokio::task::spawn_blocking(move || -> Result<String, String> {
        use std::io::Write as _;
        use zip::write::SimpleFileOptions;

        let zip_file =
            File::create(&save_path).map_err(|e| format!("Failed to create zip file: {e}"))?;
        let mut zip_writer = zip::ZipWriter::new(zip_file);
        let zip_options =
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);

        for (relative_path, abs_path) in &files_to_export {
            zip_writer
                .start_file(relative_path.as_str(), zip_options)
                .map_err(|e| format!("Failed to add file to zip: {e}"))?;

            let mut file = File::open(abs_path)
                .map_err(|e| format!("Failed to open log file {abs_path:?}: {e}"))?;

            if let Some(lvl) = &level_clone {
                let lvl_lower = lvl.to_lowercase();
                if lvl_lower.is_empty() || lvl_lower == "all" {
                    std::io::copy(&mut file, &mut zip_writer)
                        .map_err(|e| format!("Failed to copy log file to zip: {e}"))?;
                } else {
                    use std::io::BufRead as _;
                    let mut reader = std::io::BufReader::new(file);
                    let mut buf = Vec::new();
                    let mut lower_buf = Vec::new();
                    // Track whether the current multi-line log entry matched the filter.
                    // Continuation lines (no severity marker) follow their parent entry.
                    let mut current_entry_matched = false;
                    while reader
                        .read_until(b'\n', &mut buf)
                        .map_err(|e| format!("Failed to read line: {e}"))?
                        > 0
                    {
                        // Zero-allocation severity matching: reuse a single buffer,
                        // fill with ASCII-lowercased bytes, then byte-slice windows search.
                        // Search the full line — lower_buf is reused across iterations so
                        // capacity stabilizes quickly with no extra heap allocations.
                        lower_buf.clear();
                        lower_buf.extend(buf.iter().map(u8::to_ascii_lowercase));
                        let search_buf = &lower_buf;

                        // Match severity in three formats:
                        //   plaintext: [fatal], [error], etc.
                        //   logfmt:    level=fatal, level=error, etc.
                        //   JSON:      "level":"fatal", "level": "error", etc.
                        let is_fatal = contains_bytes(search_buf, b"[fatal]")
                            || contains_bytes(search_buf, b"level=fatal")
                            || contains_bytes(search_buf, b"\"level\":\"fatal\"")
                            || contains_bytes(search_buf, b"\"level\": \"fatal\"");
                        let is_error = contains_bytes(search_buf, b"[error]")
                            || contains_bytes(search_buf, b"level=error")
                            || contains_bytes(search_buf, b"\"level\":\"error\"")
                            || contains_bytes(search_buf, b"\"level\": \"error\"");
                        let is_warn = contains_bytes(search_buf, b"[warn]")
                            || contains_bytes(search_buf, b"level=warn")
                            || contains_bytes(search_buf, b"[warning]")
                            || contains_bytes(search_buf, b"level=warning")
                            || contains_bytes(search_buf, b"\"level\":\"warn\"")
                            || contains_bytes(search_buf, b"\"level\": \"warn\"")
                            || contains_bytes(search_buf, b"\"level\":\"warning\"")
                            || contains_bytes(search_buf, b"\"level\": \"warning\"");
                        let is_info = contains_bytes(search_buf, b"[info]")
                            || contains_bytes(search_buf, b"level=info")
                            || contains_bytes(search_buf, b"\"level\":\"info\"")
                            || contains_bytes(search_buf, b"\"level\": \"info\"");
                        let is_debug = contains_bytes(search_buf, b"[debug]")
                            || contains_bytes(search_buf, b"level=debug")
                            || contains_bytes(search_buf, b"\"level\":\"debug\"")
                            || contains_bytes(search_buf, b"\"level\": \"debug\"");
                        let is_trace = contains_bytes(search_buf, b"[trace]")
                            || contains_bytes(search_buf, b"level=trace")
                            || contains_bytes(search_buf, b"\"level\":\"trace\"")
                            || contains_bytes(search_buf, b"\"level\": \"trace\"");

                        // Determine if this line is a new log entry (has any severity marker)
                        // or a continuation line (stack trace, multi-line payload, etc.)
                        let is_new_entry =
                            is_fatal || is_error || is_warn || is_info || is_debug || is_trace;

                        if is_new_entry {
                            current_entry_matched = match lvl_lower.as_str() {
                                "fatal" => is_fatal,
                                "error" => is_fatal || is_error,
                                "warn" => is_fatal || is_error || is_warn,
                                "info" => is_fatal || is_error || is_warn || is_info,
                                "debug" => is_fatal || is_error || is_warn || is_info || is_debug,
                                _ => true,
                            };
                        }
                        // else: continuation line — keep current_entry_matched from parent

                        if current_entry_matched {
                            zip_writer
                                .write_all(&buf)
                                .map_err(|e| format!("Failed to write line to zip: {e}"))?;
                        }
                        buf.clear();
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
    })
    .await
    .map_err(|e| format!("Export task panicked: {e}"))?
}
