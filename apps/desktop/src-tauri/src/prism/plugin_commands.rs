//! Plugin System — IPC commands.

#![allow(clippy::needless_pass_by_value)]

use tauri::State;

use clash_prism_plugin::permission::PermissionAction;
use clash_prism_plugin::{Hook, Permission};

use crate::prism::types::validate_plugin_id;
use crate::prism::PrismState;

/// Plugin directory: `<prism_workspace>`/plugins/
fn plugins_dir(state: &PrismState) -> Result<std::path::PathBuf, String> {
    let prism_dir = state.get_prism_workspace()?;
    let dir = prism_dir.join("plugins");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Failed to create plugins dir: {e}"))?;
    Ok(dir)
}

#[tauri::command]
pub fn plugin_discover(state: State<PrismState>) -> Result<Vec<serde_json::Value>, String> {
    let discovered = state
        .inner
        .lock()
        .map_err(|e| format!("Lock failed: {e}"))?
        .plugin_loader
        .discover()
        .map_err(|e| format!("Discover failed: {e}"))?;
    Ok(discovered
        .into_iter()
        .filter_map(|m| serde_json::to_value(m).ok())
        .collect())
}

#[tauri::command]
pub fn plugin_load(
    state: State<PrismState>,
    plugin_id: String,
) -> Result<serde_json::Value, String> {
    validate_plugin_id(&plugin_id)?;
    let manifest = {
        let mut lock = state.lock_inner()?;
        lock.plugin_loader
            .load(&plugin_id)
            .map_err(|e| format!("Load failed: {e}"))?;
        lock.plugin_loader
            .loaded_plugins()
            .iter()
            .find(|p| p.manifest.id == plugin_id)
            .ok_or_else(|| format!("Plugin '{plugin_id}' not found after load"))?
            .manifest
            .clone()
    };
    serde_json::to_value(&manifest).map_err(|e| format!("Serialize failed: {e}"))
}

#[tauri::command]
pub fn plugin_unload(state: State<PrismState>, plugin_id: String) -> Result<(), String> {
    validate_plugin_id(&plugin_id)?;
    state
        .inner
        .lock()
        .map_err(|e| format!("Lock failed: {e}"))?
        .plugin_loader
        .unload(&plugin_id);
    Ok(())
}

#[tauri::command]
pub fn plugin_enable(
    state: State<PrismState>,
    plugin_id: String,
    enable: bool,
) -> Result<(), String> {
    validate_plugin_id(&plugin_id)?;
    {
        let mut lock = state.lock_inner()?;
        if enable {
            lock.plugin_loader
                .load(&plugin_id)
                .map_err(|e| format!("Enable failed: {e}"))?;
        } else {
            lock.plugin_loader.unload(&plugin_id);
        }
    }
    Ok(())
}

#[tauri::command]
pub fn plugin_delete(state: State<PrismState>, plugin_id: String) -> Result<(), String> {
    validate_plugin_id(&plugin_id)?;
    {
        let mut lock = state.lock_inner()?;
        lock.plugin_loader.unload(&plugin_id);
    }
    let dir = plugins_dir(&state)?;
    let plugin_path = dir.join(&plugin_id);
    if plugin_path.exists() {
        std::fs::remove_dir_all(&plugin_path).map_err(|e| format!("Delete failed: {e}"))?;
    }
    Ok(())
}

#[tauri::command]
pub fn plugin_list_loaded(state: State<PrismState>) -> Result<Vec<serde_json::Value>, String> {
    Ok(state
        .inner
        .lock()
        .map_err(|e| format!("Lock failed: {e}"))?
        .plugin_loader
        .loaded_plugins()
        .iter()
        .filter_map(|p| serde_json::to_value(&p.manifest).ok())
        .collect())
}

/// Execute a lifecycle hook across all loaded plugins.
#[tauri::command]
pub fn plugin_execute_hook(
    state: State<PrismState>,
    hook_name: String,
    config: serde_json::Value,
    hook_data: serde_json::Value,
) -> Result<Vec<serde_json::Value>, String> {
    let lock = state.lock_inner()?;
    let ids: Vec<&str> = lock
        .plugin_loader
        .loaded_plugins()
        .iter()
        .map(|p| p.manifest.id.as_str())
        .collect();
    let results = lock
        .plugin_loader
        .execute_hook(&ids, &hook_name, &config, Some(&hook_data));
    drop(lock);
    Ok(results
        .into_iter()
        .map(|(plugin_id, r)| {
            serde_json::json!({
                "pluginId": plugin_id,
                "success": r.success,
                "error": r.error,
                "durationUs": r.duration_us,
            })
        })
        .collect())
}

/// List all available lifecycle hooks.
#[tauri::command]
#[must_use]
pub fn plugin_list_hooks() -> Vec<serde_json::Value> {
    Hook::builtin_hooks()
        .into_iter()
        .map(|h| {
            serde_json::json!({
                "name": h.display_name(),
                "isHighFrequency": h.is_high_frequency(),
            })
        })
        .collect()
}

/// Check if an action is permitted by given permissions.
#[tauri::command]
pub fn plugin_check_permission(permissions: Vec<String>, action: String) -> Result<bool, String> {
    // Permission implements serde Deserialize with `#[serde(rename = "config:read")]` etc.
    let perms: Vec<Permission> = permissions
        .iter()
        .filter_map(|s| serde_json::from_value(serde_json::json!(s)).ok())
        .collect();
    // PermissionAction does NOT implement Deserialize — manual match required.
    let pa = match action.as_str() {
        "ConfigRead" | "config_read" => PermissionAction::ConfigRead,
        "ConfigWrite" | "config_write" => PermissionAction::ConfigWrite,
        "ProxyTest" | "proxy_test" => PermissionAction::ProxyTest,
        "ProxySelect" | "proxy_select" => PermissionAction::ProxySelect,
        "StoreRead" | "store_read" => PermissionAction::StoreRead,
        "StoreWrite" | "store_write" => PermissionAction::StoreWrite,
        "NetworkOutbound" | "network_outbound" => PermissionAction::NetworkOutbound,
        "UiNotify" | "ui_notify" => PermissionAction::UiNotify,
        "UiDialog" | "ui_dialog" => PermissionAction::UiDialog,
        "UiPage" | "ui_page" => PermissionAction::UiPage,
        "UiTray" | "ui_tray" => PermissionAction::UiTray,
        _ => return Err(format!("Unknown action: {action}")),
    };
    Ok(clash_prism_plugin::permission::is_permitted(&perms, pa))
}

/// Execute a plugin's entry script directly.
#[tauri::command]
pub fn plugin_execute(
    state: State<PrismState>,
    plugin_id: String,
) -> Result<serde_json::Value, String> {
    validate_plugin_id(&plugin_id)?;

    let config_str = state.with_ext(|_ext| {
        let paths = crate::ensure_app_storage(&state.app)?;
        std::fs::read_to_string(paths.core_dir.join("run_config.yaml"))
            .map_err(|e| format!("Failed to read running config: {e}"))
    })?;
    let config: serde_json::Value = serde_yaml::from_str(&config_str)
        .unwrap_or_else(|_| serde_json::Value::Object(serde_json::Map::new()));

    let result = {
        let lock = state.lock_inner()?;
        lock.plugin_loader
            .execute_plugin(&plugin_id, &config)
            .map_err(|e| format!("Execute failed: {e}"))?
    };

    let logs: Vec<serde_json::Value> = result
        .logs
        .iter()
        .map(|l| {
            serde_json::json!({
                "level": format!("{:?}", l.level),
                "message": l.message,
            })
        })
        .collect();
    Ok(serde_json::json!({
        "success": result.success,
        "error": result.error,
        "durationUs": result.duration_us,
        "logs": logs,
    }))
}

/// List all available permissions with display names.
#[tauri::command]
#[must_use]
pub fn plugin_list_permissions() -> Vec<serde_json::Value> {
    Permission::all()
        .into_iter()
        .map(|p| {
            serde_json::json!({
                "name": p.to_string(),
                "displayName": p.display_name(),
                "allowedForConfigPlugin": p.allowed_for_config_plugin(),
                "allowedForUiExtension": p.allowed_for_ui_extension(),
            })
        })
        .collect()
}
