//! Override module — Tauri IPC commands.

#![allow(clippy::needless_pass_by_value)]
#![allow(clippy::shadow_reuse)]

use tauri::{Manager as _, State};

use crate::core_manager::ensure_app_storage;
use crate::core_manager::write_file_secure;
use crate::prism::overrides::overrides_model::{
    LogEntry, OverrideExt, OverrideItem, OverrideLog, OverrideType,
};
use crate::prism::overrides::overrides_store;
use crate::prism::pipeline::{
    execute_test_pipeline, execute_write_pipeline, execute_write_pipeline_no_reload,
};
use crate::prism::types::check_input_size;
use crate::prism::PrismState;

/// List all override items, sorted by order.
#[tauri::command]
pub fn override_list(state: State<PrismState>) -> Result<Vec<OverrideItem>, String> {
    let meta = overrides_store::load_meta(&state)?;
    let mut items = meta.items;
    items.sort_by_key(|i| i.order);
    Ok(items)
}

/// Create a new override item and allocate a content file.
#[tauri::command]
pub fn override_create(
    state: State<PrismState>,
    name: String,
    ext: String,
    r#type: String,
    url: Option<String>,
) -> Result<OverrideItem, String> {
    let ext = OverrideExt::from_ext(&ext).ok_or_else(|| format!("Unknown ext: {ext}"))?;
    let r#type = match r#type.as_str() {
        "local" => OverrideType::Local,
        "remote" => OverrideType::Remote,
        _ => return Err(format!("Unknown type: {type}")),
    };

    let mut item = OverrideItem::new(name, ext, r#type);
    if r#type == OverrideType::Remote {
        item.global = true;
    }
    if let Some(u) = url {
        item.url = Some(u);
    }

    // Allocate order: put at end
    let meta = overrides_store::load_meta(&state)?;
    #[allow(clippy::cast_possible_truncation)]
    {
        item.order = meta.items.len() as u32;
    }

    // Create content file with default template
    let dir = overrides_store::overrides_dir(&state)?;
    let content_path = dir.join(item.content_filename());
    let default_content = match item.ext {
        OverrideExt::Js => {
            r"// Zephyr Override Script
// API: config.get(path), config.set(path, value), log.*, utils.*

function main(config) {
    log.info('Override executed');
    return config;
}
"
        }
        OverrideExt::PrismYaml => {
            r#"# Zephyr Prism Override
# Supports: $override, $prepend, $append, $filter, $transform, $remove, $default
# Conditions: __when__, Variables: __vars__, Dependencies: __after__

# Example: prepend rules
# rules:
#   $prepend:
#     - "DOMAIN-SUFFIX,google.com,DIRECT"
"#
        }
    };
    write_file_secure(&content_path, default_content)
        .map_err(|e| format!("Failed to create content file: {e}"))?;

    overrides_store::upsert_item(&state, item.clone())?;
    Ok(item)
}

/// Update metadata fields of an override item (not content).
#[tauri::command]
pub fn override_update(
    state: State<PrismState>,
    id: String,
    name: Option<String>,
    enabled: Option<bool>,
    global: Option<bool>,
    profile_ids: Option<Vec<String>>,
    url: Option<String>,
) -> Result<OverrideItem, String> {
    let mut item = overrides_store::load_item(&state, &id)?;
    if let Some(n) = name {
        item.name = n;
    }
    if let Some(e) = enabled {
        item.enabled = e;
    }
    if let Some(g) = global {
        item.global = g;
    }
    if let Some(pids) = profile_ids {
        item.profile_ids = pids;
    }
    if let Some(u) = url {
        item.url = Some(u);
    }
    overrides_store::upsert_item(&state, item.clone())?;
    Ok(item)
}

/// Delete an override item and its content/log files.
#[tauri::command]
pub fn override_delete(state: State<PrismState>, id: String) -> Result<(), String> {
    overrides_store::delete_item(&state, &id)
}

/// Get the content of an override script.
#[tauri::command]
pub fn override_get_content(state: State<PrismState>, id: String) -> Result<String, String> {
    overrides_store::read_content(&state, &id)
}

/// Save content to an override and optionally test-execute it.
///
/// If `dry_run = true`, executes without writing back to the config.
/// If `dry_run = false`, executes and writes back (calls `script_execute_write`).
/// Returns the execution log.
///
/// Note: This function is synchronous internally but declared as async to allow
/// Tauri to run it on a blocking thread, preventing UI freezes during script execution.
#[tauri::command]
pub async fn override_set_content(
    state: State<'_, PrismState>,
    id: String,
    content: String,
    dry_run: Option<bool>,
) -> Result<OverrideLog, String> {
    check_input_size(&content, "Override content")?;

    let item = overrides_store::load_item(&state, &id)?;

    // Validate the content
    if item.ext == OverrideExt::Js {
        let runtime = clash_prism_script::ScriptRuntime::new();
        let valid = runtime.validate(&content).is_ok();
        if !valid {
            return Err("Script validation failed: potentially unsafe code".to_owned());
        }
    }

    // Save content
    overrides_store::write_content(&state, &id, &content)?;

    // Execute (dry_run or live)
    // Tauri automatically runs async commands on a blocking thread pool,
    // so we can call the synchronous execution directly without blocking the UI.
    let dry = dry_run.unwrap_or(false);
    let log = if dry {
        execute_override_test(&state, &item, &content)?
    } else {
        execute_override_write(&state, &item, &content)?
    };

    // Persist log
    overrides_store::save_log(&state, &id, &log)?;

    Ok(log)
}

/// Test-execute an override script without modifying config.
fn execute_override_test(
    state: &PrismState,
    item: &OverrideItem,
    content: &str,
) -> Result<OverrideLog, String> {
    // Prism YAML is executed via the Prism DSL engine
    if item.ext == OverrideExt::PrismYaml {
        return Ok(OverrideLog {
            script_id: item.id.clone(),
            script_name: item.name.clone(),
            executed_at: chrono::Utc::now().timestamp_millis(),
            duration_us: 0,
            success: true,
            config_modified: false,
            error: None,
            logs: vec![LogEntry {
                level: "Info".to_owned(),
                message: "Prism YAML override executed (dry-run mode not yet supported)".to_owned(),
            }],
        });
    }

    let result = execute_test_pipeline(state, content, &item.name)?;

    Ok(OverrideLog {
        script_id: item.id.clone(),
        script_name: item.name.clone(),
        executed_at: chrono::Utc::now().timestamp_millis(),
        duration_us: result.duration_us,
        success: result.success,
        config_modified: result.config_modified,
        error: result.error,
        logs: result
            .logs
            .iter()
            .map(|l| LogEntry {
                level: l.level.clone(),
                message: l.message.clone(),
            })
            .collect(),
    })
}

/// Execute an override script and write back to config if modified.
fn execute_override_write(
    state: &PrismState,
    item: &OverrideItem,
    content: &str,
) -> Result<OverrideLog, String> {
    // Prism YAML overrides must be executed via the Prism DSL pipeline
    if item.ext == OverrideExt::PrismYaml {
        return Err(
            "Prism YAML overrides must be executed via the Prism DSL pipeline (prism_apply), \
             not via override_set_content. For JS overrides, use this command."
                .to_owned(),
        );
    }

    let result = execute_write_pipeline(state, content, &item.name)?;

    Ok(OverrideLog {
        script_id: item.id.clone(),
        script_name: item.name.clone(),
        executed_at: chrono::Utc::now().timestamp_millis(),
        duration_us: result.duration_us,
        success: result.success,
        config_modified: result.config_modified,
        error: result.error,
        logs: result
            .logs
            .iter()
            .map(|l| LogEntry {
                level: l.level.clone(),
                message: l.message.clone(),
            })
            .collect(),
    })
}

/// Execute an override script without triggering hot-reload.
/// Returns (log, `config_modified`) tuple.
fn execute_override_write_no_reload(
    state: &PrismState,
    item: &OverrideItem,
    content: &str,
) -> Result<(OverrideLog, bool), String> {
    // Prism YAML overrides must be executed via the Prism DSL pipeline
    if item.ext == OverrideExt::PrismYaml {
        return Err(
            "Prism YAML overrides must be executed via the Prism DSL pipeline (prism_apply), \
             not via override_set_content. For JS overrides, use this command."
                .to_owned(),
        );
    }

    let result = execute_write_pipeline_no_reload(state, content, &item.name)?;

    let log = OverrideLog {
        script_id: item.id.clone(),
        script_name: item.name.clone(),
        executed_at: chrono::Utc::now().timestamp_millis(),
        duration_us: result.duration_us,
        success: result.success,
        config_modified: result.config_modified,
        error: result.error,
        logs: result
            .logs
            .iter()
            .map(|l| LogEntry {
                level: l.level.clone(),
                message: l.message.clone(),
            })
            .collect(),
    };

    Ok((log, result.config_modified))
}

/// Trigger a single hot-reload request to Mihomo.
fn trigger_hot_reload(state: &PrismState) -> Result<(), String> {
    use std::thread;
    use std::time::Duration;

    let (port, secret, run_config_path) = {
        let mihomo_state = state.app.state::<crate::MihomoState>();
        let lock = mihomo_state
            .0
            .lock()
            .map_err(|e| format!("Lock failed: {e}"))?;
        let port = lock.last_port().unwrap_or(9090);
        let secret = lock.last_secret().to_owned();
        drop(lock);

        let paths = ensure_app_storage(&state.app)?;
        let run_config_path = paths.core_dir.join("run_config.yaml");
        (port, secret, run_config_path)
    };

    let run_config_path_str = run_config_path.to_string_lossy().to_string();

    thread::spawn(move || {
        let url = format!("http://127.0.0.1:{port}/configs?force=true");
        let client = match reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(10))
            .no_proxy()
            .build()
        {
            Ok(c) => c,
            Err(e) => {
                eprintln!("[hot-reload] HTTP client error: {e}");
                return;
            }
        };
        let body = serde_json::json!({ "path": run_config_path_str });
        match client
            .put(&url)
            .header("Authorization", format!("Bearer {secret}"))
            .json(&body)
            .send()
        {
            Ok(resp) => {
                if resp.status().is_success() {
                    eprintln!("[hot-reload] Success: {}", resp.status());
                } else {
                    eprintln!(
                        "[hot-reload] Failed: {} - {}",
                        resp.status(),
                        resp.text().unwrap_or_default()
                    );
                }
            }
            Err(e) => {
                eprintln!("[hot-reload] Request failed: {e}");
            }
        }
    });

    Ok(())
}

/// Reorder override items.
#[tauri::command]
pub fn override_reorder(state: State<PrismState>, ids: Vec<String>) -> Result<(), String> {
    overrides_store::reorder_items(&state, ids)
}

/// Toggle override enabled/disabled.
#[tauri::command]
pub fn override_toggle(state: State<PrismState>, id: String, enabled: bool) -> Result<(), String> {
    let mut item = overrides_store::load_item(&state, &id)?;
    item.enabled = enabled;
    overrides_store::upsert_item(&state, item)
}

/// Test-execute an override without saving content.
#[tauri::command]
pub fn override_test(state: State<PrismState>, id: String) -> Result<OverrideLog, String> {
    let item = overrides_store::load_item(&state, &id)?;
    let content = overrides_store::read_content(&state, &id)?;
    let log = execute_override_test(&state, &item, &content)?;
    overrides_store::save_log(&state, &id, &log)?;
    Ok(log)
}

/// Download and refresh a remote override.
///
/// Note: This function is async to avoid blocking the UI during network I/O.
#[tauri::command]
pub async fn override_refresh_remote(
    state: State<'_, PrismState>,
    id: String,
) -> Result<OverrideLog, String> {
    let mut item = overrides_store::load_item(&state, &id)?;
    if item.r#type != OverrideType::Remote {
        return Err("Only remote overrides can be refreshed".to_owned());
    }

    let url = item.url.as_ref().ok_or("No URL set for remote override")?.clone();

    // Get port from MihomoState (more reliable than parsing config)
    let port = {
        let mihomo_state = state.app.state::<crate::MihomoState>();
        let lock = mihomo_state
            .0
            .lock()
            .map_err(|e| format!("Lock failed: {e}"))?;
        lock.last_port().unwrap_or(7890)
    };

    // Download via Mihomo proxy using async reqwest
    let proxy = reqwest::Proxy::all(format!("http://127.0.0.1:{port}"))
        .map_err(|e| format!("Failed to create proxy: {e}"))?;
    let client = reqwest::Client::builder()
        .proxy(proxy)
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("HTTP client error: {e}"))?;

    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Download failed: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("Download returned {}", response.status()));
    }
    let content = response
        .text()
        .await
        .map_err(|e| format!("Failed to read response: {e}"))?;

    // Update content
    overrides_store::write_content(&state, &id, &content)?;

    // Update timestamp
    item.updated_at = Some(chrono::Utc::now().timestamp_millis());
    overrides_store::upsert_item(&state, item)?;

    // Execute (run in blocking thread since execute_override_test is synchronous)
    let item2 = overrides_store::load_item(&state, &id)?;
    let log = execute_override_test(&state, &item2, &content)?;
    overrides_store::save_log(&state, &id, &log)?;
    Ok(log)
}

/// Apply all enabled overrides to the current config.
///
/// Note: This function is async to avoid blocking the UI during script execution.
/// Hot-reload is triggered only once after all overrides are applied.
#[tauri::command]
pub async fn override_apply_all(state: State<'_, PrismState>) -> Result<Vec<OverrideLog>, String> {
    let meta = overrides_store::load_meta(&state)?;
    let mut logs = Vec::new();
    let mut config_modified = false;

    for item in meta.items.iter().filter(|i| i.enabled) {
        if item.ext != OverrideExt::Js {
            continue; // Only JS overrides in Phase 1
        }
        let content = overrides_store::read_content(&state, &item.id).unwrap_or_default();
        if content.is_empty() {
            continue;
        }
        match execute_override_write_no_reload(&state, item, &content) {
            Ok((log, modified)) => {
                overrides_store::save_log(&state, &item.id, &log).ok();
                logs.push(log);
                if modified {
                    config_modified = true;
                }
            }
            Err(e) => {
                let log = OverrideLog {
                    script_id: item.id.clone(),
                    script_name: item.name.clone(),
                    executed_at: chrono::Utc::now().timestamp_millis(),
                    duration_us: 0,
                    success: false,
                    config_modified: false,
                    error: Some(e),
                    logs: Vec::new(),
                };
                overrides_store::save_log(&state, &item.id, &log).ok();
                logs.push(log);
            }
        }
    }

    // Trigger hot-reload once after all overrides are applied
    if config_modified {
        trigger_hot_reload(&state)?;
    }

    Ok(logs)
}
