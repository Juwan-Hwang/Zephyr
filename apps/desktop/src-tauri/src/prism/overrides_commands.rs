//! Override module — Tauri IPC commands.

#![allow(clippy::needless_pass_by_value)]
#![allow(clippy::shadow_reuse)]

use tauri::{Manager as _, State};

use crate::core_manager::write_file_secure;
use crate::prism::overrides::overrides_model::{
    LogEntry, OverrideExt, OverrideItem, OverrideLog, OverrideType,
};
use crate::prism::overrides::overrides_store;
use crate::prism::pipeline::{
    execute_batch_pipeline, execute_test_pipeline, execute_write_pipeline,
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

    // create_item atomically assigns order and persists — no race condition
    overrides_store::create_item(&state, item)
}

/// Update metadata fields of an override item (not content).
#[tauri::command]
pub fn override_update(
    state: State<PrismState>,
    id: String,
    mut name: Option<String>,
    enabled: Option<bool>,
    global: Option<bool>,
    mut profile_ids: Option<Vec<String>>,
    mut url: Option<String>,
) -> Result<OverrideItem, String> {
    // update_item performs read-modify-write within a single lock acquisition,
    // preventing race conditions with concurrent updates.
    overrides_store::update_item(&state, &id, |item| {
        if let Some(n) = name.take() {
            item.name = n;
        }
        if let Some(e) = enabled {
            item.enabled = e;
        }
        if let Some(g) = global {
            item.global = g;
        }
        if let Some(pids) = profile_ids.take() {
            item.profile_ids = pids;
        }
        if let Some(u) = url.take() {
            item.url = Some(u);
        }
    })
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
/// If `dry_run = true`, validates and executes without persisting content or writing config.
/// If `dry_run = false`, persists content, executes, and writes back to config.
/// Returns the execution log.
///
/// Note: This function is async so Tauri runs it on a blocking thread pool,
/// preventing UI freezes during script execution.
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
        if let Err(e) = runtime.validate(&content) {
            return Err(format!("Script validation failed: {e}"));
        }
    }

    let dry = dry_run.unwrap_or(false);

    // Only persist content when NOT in dry-run mode
    if !dry {
        overrides_store::write_content(&state, &id, &content)?;
    }

    // Execute (dry_run or live)
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

/// Reorder override items.
#[tauri::command]
pub fn override_reorder(state: State<PrismState>, ids: Vec<String>) -> Result<(), String> {
    overrides_store::reorder_items(&state, ids)
}

/// Toggle override enabled/disabled.
#[tauri::command]
pub fn override_toggle(state: State<PrismState>, id: String, enabled: bool) -> Result<(), String> {
    // Use atomic update to avoid read-modify-write race
    overrides_store::update_item(&state, &id, |item| {
        item.enabled = enabled;
    })?;
    Ok(())
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
/// Uses the Mihomo mixed proxy port (from Settings) for downloading, falling back
/// to direct download if the proxy port is unavailable.
///
/// Note: This function is async to avoid blocking the UI during network I/O.
#[tauri::command]
pub async fn override_refresh_remote(
    state: State<'_, PrismState>,
    id: String,
) -> Result<OverrideLog, String> {
    let item = overrides_store::load_item(&state, &id)?;
    if item.r#type != OverrideType::Remote {
        return Err("Only remote overrides can be refreshed".to_owned());
    }

    let url = item
        .url
        .as_ref()
        .ok_or("No URL set for remote override")?
        .clone();

    // Get the mixed proxy port from Settings (NOT the API port from MihomoState).
    // MihomoState.last_port is the external-controller API port (e.g. 9090),
    // which cannot proxy HTTP traffic. We need the actual mixed-port.
    let proxy_port = {
        let settings_state = state.app.state::<crate::SettingsState>();
        let lock = settings_state
            .0
            .lock()
            .map_err(|e| format!("Lock failed: {e}"))?;
        lock.mixed_port
    };

    // Download with proxy, falling back to direct if proxy is unavailable
    let content = download_remote_content(&url, proxy_port).await?;

    // Update content
    overrides_store::write_content(&state, &id, &content)?;

    // Update timestamp atomically (returns the updated item)
    let updated_item = overrides_store::update_item(&state, &id, |item| {
        item.updated_at = Some(chrono::Utc::now().timestamp_millis());
    })?;

    // Execute (run in blocking thread since execute_override_test is synchronous)
    let log = execute_override_test(&state, &updated_item, &content)?;
    overrides_store::save_log(&state, &id, &log)?;
    Ok(log)
}

/// Apply all enabled overrides to the current config.
///
/// Uses batch pipeline to load config once, apply all scripts in memory,
/// and write back once. Hot-reload is triggered only once after all overrides are applied.
///
/// Note: This function is async to avoid blocking the UI during script execution.
#[tauri::command]
pub async fn override_apply_all(state: State<'_, PrismState>) -> Result<Vec<OverrideLog>, String> {
    let meta = overrides_store::load_meta(&state)?;

    // Collect all enabled JS overrides with their content.
    // Pre-execution errors (empty file, read failure) are included in the returned logs
    // so the UI can display them alongside execution results.
    let mut scripts: Vec<(String, String, String)> = Vec::new(); // (id, name, content)
    let mut pre_logs: Vec<OverrideLog> = Vec::new();
    for item in meta.items.iter().filter(|i| i.enabled) {
        if item.ext != OverrideExt::Js {
            continue; // Only JS overrides in Phase 1
        }
        let now = chrono::Utc::now().timestamp_millis();
        match overrides_store::read_content(&state, &item.id) {
            Ok(c) if !c.is_empty() => {
                scripts.push((item.id.clone(), item.name.clone(), c));
            }
            Ok(_) => {
                let log = OverrideLog {
                    script_id: item.id.clone(),
                    script_name: item.name.clone(),
                    executed_at: now,
                    duration_us: 0,
                    success: false,
                    config_modified: false,
                    error: Some("Override file is empty".to_owned()),
                    logs: vec![LogEntry {
                        level: "Error".to_owned(),
                        message: "Override content file is empty".to_owned(),
                    }],
                };
                overrides_store::save_log(&state, &item.id, &log).ok();
                pre_logs.push(log);
            }
            Err(e) => {
                let log = OverrideLog {
                    script_id: item.id.clone(),
                    script_name: item.name.clone(),
                    executed_at: now,
                    duration_us: 0,
                    success: false,
                    config_modified: false,
                    error: Some(format!("Failed to read override: {e}")),
                    logs: vec![LogEntry {
                        level: "Error".to_owned(),
                        message: format!("Failed to read override content: {e}"),
                    }],
                };
                overrides_store::save_log(&state, &item.id, &log).ok();
                pre_logs.push(log);
            }
        };
    }

    if scripts.is_empty() {
        return Ok(pre_logs);
    }

    // Use batch pipeline: single load → all scripts in memory → single write → single reload
    let script_refs: Vec<(&str, &str)> = scripts
        .iter()
        .map(|(_, name, content)| (content.as_str(), name.as_str()))
        .collect();

    let results = execute_batch_pipeline(&state, &script_refs, true)?;

    // Convert pipeline results to override logs
    let exec_logs: Vec<OverrideLog> = scripts
        .iter()
        .zip(results.iter())
        .map(|((id, name, _), result)| {
            let log = OverrideLog {
                script_id: id.clone(),
                script_name: name.clone(),
                executed_at: chrono::Utc::now().timestamp_millis(),
                duration_us: result.duration_us,
                success: result.success,
                config_modified: result.config_modified,
                error: result.error.clone(),
                logs: result
                    .logs
                    .iter()
                    .map(|l| LogEntry {
                        level: l.level.clone(),
                        message: l.message.clone(),
                    })
                    .collect(),
            };
            // Persist individual logs (ignore errors)
            overrides_store::save_log(&state, id, &log).ok();
            log
        })
        .collect();

    // Merge pre-execution errors with execution results
    let mut all_logs = pre_logs;
    all_logs.extend(exec_logs);
    Ok(all_logs)
}

/// Download remote content with optional proxy and automatic direct fallback.
///
/// If `proxy_port` is set, tries proxied download first. On failure (proxy down,
/// timeout, connection refused), retries once without proxy. This ensures remote
/// overrides can be refreshed even when the Mihomo core is not running.
async fn download_remote_content(url: &str, proxy_port: Option<u16>) -> Result<String, String> {
    const MAX_REMOTE_SIZE: usize = 10 * 1024 * 1024; // 10 MB limit

    // Build proxied client if port is configured
    let proxied_client: Option<reqwest::Client> = if let Some(port) = proxy_port {
        let proxy = reqwest::Proxy::all(format!("http://127.0.0.1:{port}"))
            .map_err(|e| format!("Failed to create proxy: {e}"))?;
        Some(
            reqwest::Client::builder()
                .proxy(proxy)
                .timeout(std::time::Duration::from_secs(30))
                .build()
                .map_err(|e| format!("HTTP client error: {e}"))?,
        )
    } else {
        None
    };

    // Try proxied first, then fall back to direct
    if let Some(client) = &proxied_client {
        match fetch_body(client, url, MAX_REMOTE_SIZE).await {
            Ok(content) => return Ok(content),
            Err(proxy_err) => {
                eprintln!("[override] Proxy download failed ({proxy_err}), retrying direct...");
            }
        }
    }

    // Direct download (fallback or default)
    let direct_client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("HTTP client error: {e}"))?;
    let content = fetch_body(&direct_client, url, MAX_REMOTE_SIZE).await?;
    check_input_size(&content, "Remote override content")?;
    Ok(content)
}

/// Stream the response body with a hard byte limit.
async fn fetch_body(
    client: &reqwest::Client,
    url: &str,
    max_size: usize,
) -> Result<String, String> {
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Download failed: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("Download returned {}", response.status()));
    }

    use futures_util::StreamExt as _;
    let mut stream = response.bytes_stream();
    let mut buf = Vec::with_capacity(4096);
    while let Some(chunk_result) = stream.next().await {
        let chunk = chunk_result.map_err(|e| format!("Failed to read response: {e}"))?;
        if buf.len() + chunk.len() > max_size {
            return Err(format!("Remote override content exceeds {max_size} bytes"));
        }
        buf.extend_from_slice(&chunk);
    }

    String::from_utf8(buf).map_err(|e| format!("Invalid UTF-8 in remote override: {e}"))
}
