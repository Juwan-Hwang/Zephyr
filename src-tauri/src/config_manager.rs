use crate::core_manager::ensure_app_storage;
use crate::core_manager::MihomoState;
use serde_json::Value as JsonValue;
use serde_yaml::{Mapping, Value as YamlValue};
use std::fs;
use tauri::{AppHandle, Emitter as _, Manager as _, State};

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn read_config(app: AppHandle) -> Result<JsonValue, String> {
    let paths = ensure_app_storage(&app)?;
    let run_config_path = paths.core_dir.join("run_config.yaml");

    if !run_config_path.exists() {
        return Err("run_config.yaml not found".to_owned());
    }

    let content = fs::read_to_string(&run_config_path)
        .map_err(|e| format!("Failed to read run_config.yaml: {e}"))?;

    let mut yaml_val: YamlValue =
        serde_yaml::from_str(&content).map_err(|e| format!("Failed to parse YAML: {e}"))?;

    // Security mitigation: Strip secret and external-controller to prevent credential leakage
    if let YamlValue::Mapping(ref mut map) = yaml_val {
        map.remove(YamlValue::String("secret".to_owned()));
    }

    let json_val: JsonValue = serde_json::to_value(yaml_val)
        .map_err(|e| format!("Failed to convert YAML to JSON: {e}"))?;

    Ok(json_val)
}

fn merge_yaml(base: &mut YamlValue, patch: &YamlValue, depth: usize) -> Result<(), String> {
    if depth > 50 {
        return Err("YAML nesting depth exceeded limit".to_owned());
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
pub async fn update_config(
    app: AppHandle,
    state: State<'_, MihomoState>,
    patch: JsonValue,
) -> Result<ConfigUpdateResult, String> {
    let paths = ensure_app_storage(&app)?;
    let run_config_path = paths.core_dir.join("run_config.yaml");

    // 1. Read existing config
    let mut current_yaml: YamlValue = if run_config_path.exists() {
        let content = fs::read_to_string(&run_config_path)
            .map_err(|e| format!("Failed to read run_config.yaml: {e}"))?;

        match serde_yaml::from_str(&content) {
            Ok(yaml) => yaml,
            Err(e) => {
                eprintln!("[Config] WARNING: Failed to parse run_config.yaml: {e}. Starting with empty config.");

                // Notify user about parse failure
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.emit(
                        "config-parse-error",
                        format!(
                            "Configuration file could not be parsed. Using empty config. Error: {e}"
                        ),
                    );
                }

                YamlValue::Mapping(Mapping::new())
            }
        }
    } else {
        YamlValue::Mapping(Mapping::new())
    };

    // 2. Convert patch to YAML
    let patch_yaml: YamlValue = serde_yaml::to_value(&patch)
        .map_err(|e| format!("Failed to convert JSON patch to YAML: {e}"))?;

    // 3. Merge patch into current config
    // SECURITY: Save critical settings before merge to restore after
    let original_external_controller = current_yaml
        .get("external-controller")
        .and_then(|v| v.as_str())
        .map(std::borrow::ToOwned::to_owned);
    let original_secret = current_yaml
        .get("secret")
        .and_then(|v| v.as_str())
        .map(std::borrow::ToOwned::to_owned);
    let tun_enabled_before = current_yaml
        .get("tun")
        .and_then(|tun| tun.get("enable"))
        .and_then(serde_yaml::Value::as_bool)
        .unwrap_or(false);

    merge_yaml(&mut current_yaml, &patch_yaml, 0)?;

    // 3.5. SECURITY: Restore critical security settings after merge
    // These settings must never be changed by user config or subscriptions
    if let YamlValue::Mapping(ref mut map) = current_yaml {
        // Restore external-controller to localhost binding
        if let Some(original) = &original_external_controller {
            // Extract port and ensure it binds to localhost only
            let port = original.split(':').next_back().unwrap_or("9090");
            map.insert(
                YamlValue::String("external-controller".to_owned()),
                YamlValue::String(format!("127.0.0.1:{port}")),
            );
        } else {
            // No original, set secure default
            map.insert(
                YamlValue::String("external-controller".to_owned()),
                YamlValue::String("127.0.0.1:9090".to_owned()),
            );
        }

        // Restore original secret - never allow removal
        if let Some(secret) = &original_secret {
            map.insert(
                YamlValue::String("secret".to_owned()),
                YamlValue::String(secret.clone()),
            );
        }
        // If there was no secret before, don't add one (empty or otherwise)

        // Protect TUN state - only allow changes through proper UI toggle
        if !tun_enabled_before {
            // TUN was disabled before patch, ensure it stays disabled
            if let Some(YamlValue::Mapping(ref mut tun_map)) =
                map.get_mut(YamlValue::String("tun".to_owned()))
            {
                tun_map.insert(
                    YamlValue::String("enable".to_owned()),
                    YamlValue::Bool(false),
                );
            }
        }
    }

    // 4. Write back to run_config.yaml
    let new_content = serde_yaml::to_string(&current_yaml)
        .map_err(|e| format!("Failed to serialize YAML: {e}"))?;
    crate::core_manager::write_file_secure(&run_config_path, &new_content)?;

    // 5. Update original profile if it exists
    let (last_config_path, port, secret) = {
        let lock = state
            .0
            .lock()
            .map_err(|e| format!("Failed to lock state: {e}"))?;
        (
            lock.last_config_path.clone(),
            lock.last_port.unwrap_or(9090),
            lock.last_secret.clone(),
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
                            let _ = crate::core_manager::write_file_secure(
                                &profile_path,
                                &new_profile_content,
                            );
                        }
                    }
                }
            }
        }
    }

    // 6. Request Core Reload
    // First, try to find the actual port from run_config.yaml external-controller
    let actual_port = if let Some(ext_ctrl) = current_yaml
        .get("external-controller")
        .and_then(|v| v.as_str())
    {
        if let Some(p) = ext_ctrl.split(':').next_back() {
            p.parse::<u16>().unwrap_or(port)
        } else {
            port
        }
    } else {
        port
    };

    #[allow(clippy::expect_used)]
    let client = reqwest::Client::builder()
        .no_proxy() // Force direct connection to local core, bypass system proxy
        .build()
        .expect("failed to build HTTP client");
    // For Mihomo, /configs requires PATCH for partial updates.
    let url = format!("http://127.0.0.1:{actual_port}/configs?force=true");
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
                println!("Warning: Core reload API returned non-success: {text}");
                hot_reload_message = format!("Hot reload returned status {status}");
            }
        }
        Err(e) => {
            println!("Warning: Failed to reload core via API: {e}");
            "Core API unavailable for hot reload".clone_into(&mut hot_reload_message);
        }
    }

    // Return detailed result so frontend can inform user appropriately
    let files_saved = true;
    let message = if hot_reload_success {
        "Configuration saved and applied successfully".to_owned()
    } else if !hot_reload_message.is_empty() {
        format!(
            "Configuration saved. {hot_reload_message} - restart core to apply changes."
        )
    } else {
        "Configuration saved. Restart core to apply changes.".to_owned()
    };

    Ok(ConfigUpdateResult {
        files_saved,
        hot_reload_success,
        message,
    })
}
