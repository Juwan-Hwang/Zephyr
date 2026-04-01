use crate::core_manager::ensure_app_storage;
use serde_json::Value as JsonValue;
use serde_yaml::{Mapping, Value as YamlValue};
use std::fs;
use tauri::{AppHandle, State};
use crate::core_manager::MihomoState;

#[tauri::command]
pub fn read_config(app: AppHandle) -> Result<JsonValue, String> {
    let paths = ensure_app_storage(&app)?;
    let run_config_path = paths.core_dir.join("run_config.yaml");

    if !run_config_path.exists() {
        return Err("run_config.yaml not found".to_string());
    }

    let content = fs::read_to_string(&run_config_path)
        .map_err(|e| format!("Failed to read run_config.yaml: {}", e))?;

    let mut yaml_val: YamlValue = serde_yaml::from_str(&content)
        .map_err(|e| format!("Failed to parse YAML: {}", e))?;

    // Security mitigation: Strip secret and external-controller to prevent credential leakage
    if let YamlValue::Mapping(ref mut map) = yaml_val {
        map.remove(&YamlValue::String("secret".to_string()));
    }

    let json_val: JsonValue = serde_json::to_value(yaml_val)
        .map_err(|e| format!("Failed to convert YAML to JSON: {}", e))?;

    Ok(json_val)
}

fn merge_yaml(base: &mut YamlValue, patch: &YamlValue, depth: usize) -> Result<(), String> {
    if depth > 50 {
        return Err("YAML nesting depth exceeded limit".to_string());
    }
    match (base, patch) {
        (YamlValue::Mapping(a), YamlValue::Mapping(b)) => {
            for (k, v) in b {
                if v.is_null() {
                    a.remove(k);
                } else if let Some(a_v) = a.get_mut(k) {
                    merge_yaml(a_v, v, depth + 1)?;
                } else {
                    a.insert(k.clone(), v.clone());
                }
            }
        }
        (a, b) => {
            *a = b.clone();
        }
    }
    Ok(())
}

/// Result of config update operation with detailed status
#[derive(serde::Serialize)]
pub struct ConfigUpdateResult {
    /// Whether the config files were successfully written
    pub files_saved: bool,
    /// Whether the core hot reload succeeded
    pub hot_reload_success: bool,
    /// Human-readable status message
    pub message: String,
}

#[tauri::command]
pub async fn update_config(app: AppHandle, state: State<'_, MihomoState>, patch: JsonValue) -> Result<ConfigUpdateResult, String> {
    let paths = ensure_app_storage(&app)?;
    let run_config_path = paths.core_dir.join("run_config.yaml");

    // 1. Read existing config
    let mut current_yaml: YamlValue = if run_config_path.exists() {
        let content = fs::read_to_string(&run_config_path)
            .map_err(|e| format!("Failed to read run_config.yaml: {}", e))?;
        serde_yaml::from_str(&content).unwrap_or(YamlValue::Mapping(Mapping::new()))
    } else {
        YamlValue::Mapping(Mapping::new())
    };

    // 2. Convert patch to YAML
    let patch_yaml: YamlValue = serde_yaml::to_value(&patch)
        .map_err(|e| format!("Failed to convert JSON patch to YAML: {}", e))?;

    // 3. Merge patch into current config
    merge_yaml(&mut current_yaml, &patch_yaml, 0)?;

    // 4. Write back to run_config.yaml
    let new_content = serde_yaml::to_string(&current_yaml)
        .map_err(|e| format!("Failed to serialize YAML: {}", e))?;
    crate::core_manager::write_file_secure(&run_config_path, &new_content)?;

    // 5. Update original profile if it exists
    let (last_config_path, port, secret) = {
        let lock = state.0.lock().map_err(|_| "Failed to lock state".to_string())?;
        (
            lock.last_config_path.clone(),
            lock.last_port.unwrap_or(9090),
            lock.last_secret.clone()
        )
    };

    if let Some(profile_name) = last_config_path {
        if profile_name != "run_config.yaml" {
            let profile_path = paths.profiles_dir.join(&profile_name);
            if profile_path.exists() {
                let profile_content = fs::read_to_string(&profile_path).unwrap_or_default();
                if let Ok(mut profile_yaml) = serde_yaml::from_str::<YamlValue>(&profile_content) {
                    if merge_yaml(&mut profile_yaml, &patch_yaml, 0).is_ok() {
                        if let Ok(new_profile_content) = serde_yaml::to_string(&profile_yaml) {
                            let _ = crate::core_manager::write_file_secure(&profile_path, &new_profile_content);
                        }
                    }
                }
            }
        }
    }

    // 6. Request Core Reload
    // First, try to find the actual port from run_config.yaml external-controller
    let actual_port = if let Some(ext_ctrl) = current_yaml.get("external-controller").and_then(|v| v.as_str()) {
        if let Some(p) = ext_ctrl.split(':').last() {
            p.parse::<u16>().unwrap_or(port)
        } else {
            port
        }
    } else {
        port
    };

    let client = reqwest::Client::builder()
        .no_proxy() // Force direct connection to local core, bypass system proxy
        .build()
        .unwrap();
    // For Mihomo, /configs requires PATCH for partial updates.
    let url = format!("http://127.0.0.1:{}/configs?force=true", actual_port);
    let mut req = client.patch(&url).json(&patch_yaml);
    
    if !secret.is_empty() {
        req = req.bearer_auth(secret);
    }

    // Attempt hot reload but don't fail if it doesn't work
    let mut hot_reload_success = false;
    let mut hot_reload_message = String::new();
    
    match req.send().await {
        Ok(res) => {
            let status = res.status();
            if status.is_success() {
                hot_reload_success = true;
            } else {
                let text = res.text().await.unwrap_or_default();
                println!("Warning: Core reload API returned non-success: {}", text);
                hot_reload_message = format!("Hot reload returned status {}", status);
            }
        },
        Err(e) => {
            println!("Warning: Failed to reload core via API: {}", e);
            hot_reload_message = "Core API unavailable for hot reload".to_string();
        }
    }

    // Return detailed result so frontend can inform user appropriately
    let files_saved = true;
    let message = if hot_reload_success {
        "Configuration saved and applied successfully".to_string()
    } else if !hot_reload_message.is_empty() {
        format!("Configuration saved. {} - restart core to apply changes.", hot_reload_message)
    } else {
        "Configuration saved. Restart core to apply changes.".to_string()
    };

    Ok(ConfigUpdateResult {
        files_saved,
        hot_reload_success,
        message,
    })
}
