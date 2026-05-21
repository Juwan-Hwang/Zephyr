//! Override module — Tauri IPC commands.

#![allow(clippy::needless_pass_by_value)]
#![allow(clippy::shadow_reuse)]

use tauri::{Manager as _, State};

use clash_prism_extension::ApplyOptions;

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
        let runtime = clash_prism_script::ScriptRuntime::with_context(
            crate::prism::pipeline::build_script_context(),
        );
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
    // Prism YAML dry-run: not yet supported — return a clear failure
    if item.ext == OverrideExt::PrismYaml {
        return Ok(OverrideLog {
            script_id: item.id.clone(),
            script_name: item.name.clone(),
            executed_at: chrono::Utc::now().timestamp_millis(),
            duration_us: 0,
            success: false,
            config_modified: false,
            error: Some(
                "Prism YAML dry-run validation is not yet supported. Save & Run to test."
                    .to_owned(),
            ),
            logs: vec![LogEntry {
                level: "Warn".to_owned(),
                message: "Prism YAML override: dry-run not supported, use Save & Run instead."
                    .to_owned(),
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
    // Prism YAML overrides are executed via the Prism DSL pipeline
    if item.ext == OverrideExt::PrismYaml {
        return execute_prism_yaml_write(state, item, content);
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

/// Execute a Prism YAML override by writing it to the Prism workspace and applying.
///
/// This writes the Prism YAML content as a patch file in the Prism workspace,
/// then calls `ext.apply()` to compile and apply all patches.
fn execute_prism_yaml_write(
    state: &PrismState,
    item: &OverrideItem,
    content: &str,
) -> Result<OverrideLog, String> {
    use crate::prism::pipeline::RUN_CONFIG_LOCK;

    let _guard = RUN_CONFIG_LOCK
        .lock()
        .map_err(|e| format!("Run config lock poisoned: {e}"))?;

    let start = std::time::Instant::now();

    // Write the override content as a patch file in the Prism workspace
    let prism_dir = crate::prism::prism_data_dir(&state.app)?;
    let patch_filename = item.patch_filename();
    let patch_path = prism_dir.join(&patch_filename);
    write_file_secure(&patch_path, content)
        .map_err(|e| format!("Failed to write Prism patch: {e}"))?;

    // Apply through the Prism extension
    let lock = state
        .inner
        .lock()
        .map_err(|e| format!("Prism lock failed: {e}"))?;
    let ext = lock
        .extension
        .as_ref()
        .ok_or_else(|| "Prism extension not initialized".to_owned())?;
    let result = ext.apply(ApplyOptions::default())?;
    drop(lock);

    let duration_us = u64::try_from(start.elapsed().as_micros()).unwrap_or(u64::MAX);

    // Write the output config back to run_config.yaml and trigger hot-reload
    let paths = crate::core_manager::ensure_app_storage(&state.app)?;
    let run_config_path = paths.core_dir.join("run_config.yaml");
    crate::core_manager::write_file_secure(&run_config_path, &result.output_config)
        .map_err(|e| format!("Failed to write run_config.yaml: {e}"))?;
    crate::prism::pipeline::trigger_hot_reload(state)?;

    Ok(OverrideLog {
        script_id: item.id.clone(),
        script_name: item.name.clone(),
        executed_at: chrono::Utc::now().timestamp_millis(),
        duration_us,
        success: true,
        config_modified: true,
        error: None,
        logs: result
            .trace
            .iter()
            .map(|t| LogEntry {
                level: "info".to_owned(),
                message: format!("{t:?}"),
            })
            .collect(),
    })
}

/// Reorder override items.
#[tauri::command]
pub fn override_reorder(state: State<PrismState>, ids: Vec<String>) -> Result<(), String> {
    overrides_store::reorder_items_atomic(&state, &ids)
}

/// Toggle override enabled/disabled.
#[tauri::command]
pub fn override_toggle(state: State<PrismState>, id: String, enabled: bool) -> Result<(), String> {
    // Use atomic update to avoid read-modify-write race
    let item = overrides_store::update_item(&state, &id, |item| {
        item.enabled = enabled;
    })?;

    // Synchronize Prism workspace patch file for Prism YAML overrides
    if item.ext == OverrideExt::PrismYaml {
        let prism_dir = crate::prism::prism_data_dir(&state.app)
            .map_err(|e| format!("Failed to get prism data dir: {e}"))?;
        let patch_path = prism_dir.join(item.patch_filename());

        if enabled {
            // Re-enable: restore patch file from stored content
            let content = overrides_store::read_content(&state, &id)
                .map_err(|e| format!("Failed to read override content to restore patch: {e}"))?;
            write_file_secure(&patch_path, &content)
                .map_err(|e| format!("Failed to restore patch file: {e}"))?;
        } else {
            // Disable: remove patch so Prism extension stops applying it
            if patch_path.exists() {
                std::fs::remove_file(&patch_path)
                    .map_err(|e| format!("Failed to remove patch file: {e}"))?;
            }
        }
    }

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

    // Execute via write pipeline so the refreshed override takes effect immediately.
    // Using dry-run (execute_override_test) would update the file but leave the
    // running config unchanged, confusing users who expect refresh to apply immediately.
    let log = execute_override_write(&state, &updated_item, &content)?;
    overrides_store::save_log(&state, &id, &log)?;
    Ok(log)
}

/// Apply all enabled overrides to the current config.
///
/// Uses batch pipeline to load config once, apply all scripts in memory,
/// and write back once. Hot-reload is triggered only once after all overrides are applied.
///
/// Scope filtering: Only applies overrides where:
/// - `global == true` (applies to all profiles), OR
/// - `profile_ids` contains the current active profile ID
///
/// Note: This function is async to avoid blocking the UI during script execution.
#[tauri::command]
pub async fn override_apply_all(state: State<'_, PrismState>) -> Result<Vec<OverrideLog>, String> {
    // Get current active profile ID for scope filtering
    let current_profile_id: Option<String> = {
        let mihomo_state = state.app.state::<crate::MihomoState>();
        let lock = match mihomo_state.0.lock() {
            Ok(l) => l,
            Err(e) => {
                eprintln!("[overrides] MihomoState lock poisoned, scope filtering disabled: {e}");
                return Ok(Vec::new());
            }
        };
        lock.last_config_path().map(String::from)
    };

    let meta = overrides_store::load_meta(&state)?;

    // Collect all enabled JS overrides with their content.
    // Pre-execution errors (empty file, read failure) are included in the returned logs
    // so the UI can display them alongside execution results.
    // Scope filtering: global=true OR profile_ids contains current profile.
    let mut scripts: Vec<(String, String, String)> = Vec::new(); // (id, name, content)
    let mut pre_logs: Vec<OverrideLog> = Vec::new();
    for item in meta.items.iter().filter(|i| i.enabled) {
        if item.ext != OverrideExt::Js {
            continue; // Only JS overrides in Phase 1
        }

        // Scope filtering: skip if not global and not matching current profile
        let in_scope = item.global
            || current_profile_id
                .as_ref()
                .is_some_and(|pid| item.profile_ids.contains(pid));
        if !in_scope {
            continue;
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
                if let Err(e) = overrides_store::save_log(&state, &item.id, &log) {
                    eprintln!("[overrides] Failed to save log for '{}': {e}", item.name);
                }
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
                if let Err(e) = overrides_store::save_log(&state, &item.id, &log) {
                    eprintln!("[overrides] Failed to save log for '{}': {e}", item.name);
                }
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
            if let Err(e) = overrides_store::save_log(&state, id, &log) {
                eprintln!("[overrides] Failed to save log for '{id}': {e}");
            }
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
    let proxied_client: Option<reqwest::Client> = if let Some(port) = proxy_port.filter(|&p| p > 0)
    {
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
            Ok(content) => {
                check_input_size(&content, "Remote override content")?;
                return Ok(content);
            }
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

// ═══════════════════════════════════════════════════════════════════════
//  Export / Import
// ═══════════════════════════════════════════════════════════════════════

/// Serializable export entry — metadata + content for a single override.
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportEntry {
    name: String,
    ext: String,
    r#type: String,
    global: bool,
    profile_ids: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    url: Option<String>,
    enabled: bool,
    content: String,
}

/// Export payload with version for forward compatibility.
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportPayload {
    version: u32,
    exported_at: i64,
    items: Vec<ExportEntry>,
}

/// Export all overrides as a JSON file in the `prism/overrides/exports/` directory.
///
/// Returns the absolute path of the written file so the UI can display it.
#[tauri::command]
pub fn override_export(state: State<PrismState>) -> Result<String, String> {
    use chrono::Local;

    let meta = overrides_store::load_meta(&state)?;
    if meta.items.is_empty() {
        return Err("No overrides to export".to_owned());
    }

    let mut entries = Vec::with_capacity(meta.items.len());
    for item in &meta.items {
        let content = match overrides_store::read_content(&state, &item.id) {
            Ok(c) => c,
            Err(e) => {
                eprintln!(
                    "[overrides] Failed to read content for '{}', skipping: {e}",
                    item.name
                );
                continue;
            }
        };
        entries.push(ExportEntry {
            name: item.name.clone(),
            ext: item.ext.file_ext().to_owned(),
            r#type: match item.r#type {
                OverrideType::Local => "local".to_owned(),
                OverrideType::Remote => "remote".to_owned(),
            },
            global: item.global,
            profile_ids: item.profile_ids.clone(),
            url: item.url.clone(),
            enabled: item.enabled,
            content,
        });
    }

    let payload = ExportPayload {
        version: 1,
        exported_at: chrono::Utc::now().timestamp_millis(),
        items: entries,
    };

    let json = serde_json::to_string_pretty(&payload)
        .map_err(|e| format!("Failed to serialize export: {e}"))?;

    // Write to prism/overrides/exports/
    let overrides_dir = overrides_store::overrides_dir(&state)?;
    let exports_dir = overrides_dir.join("exports");
    std::fs::create_dir_all(&exports_dir)
        .map_err(|e| format!("Failed to create exports dir: {e}"))?;

    let filename = format!(
        "zephyr-overrides-{}.json",
        Local::now().format("%Y-%m-%d-%H%M%S")
    );
    let export_path = exports_dir.join(&filename);
    write_file_secure(&export_path, &json)
        .map_err(|e| format!("Failed to write export file: {e}"))?;

    // Return the absolute path as a string for the UI to display
    export_path
        .to_str()
        .map(String::from)
        .ok_or_else(|| "Export path contains invalid UTF-8".to_owned())
}

/// Import overrides from a JSON string (read by the front-end file picker).
///
/// Accepts the raw JSON content of a previously exported file.
/// Creates each override, writes its content, and applies scope/enabled state.
/// Uses batch import for efficiency (single metadata lock for all items).
/// Returns the number of overrides imported.
#[tauri::command]
pub fn override_import(state: State<PrismState>, json: String) -> Result<u32, String> {
    check_input_size(&json, "Import payload")?;

    let payload: ExportPayload =
        serde_json::from_str(&json).map_err(|e| format!("Invalid export file format: {e}"))?;

    if payload.items.is_empty() {
        return Err("Export file contains no overrides".to_owned());
    }

    // Build items with all fields pre-populated (avoids per-item update_item calls)
    let mut items_to_import: Vec<(OverrideItem, String)> = Vec::with_capacity(payload.items.len());

    for entry in &payload.items {
        if entry.name.is_empty() || entry.ext.is_empty() {
            eprintln!("[overrides] Skipping malformed import entry: empty name or ext");
            continue;
        }

        let ext = OverrideExt::from_ext(&entry.ext)
            .ok_or_else(|| format!("Unknown ext in import: {}", entry.ext))?;
        let r#type = match entry.r#type.as_str() {
            "remote" => OverrideType::Remote,
            _ => OverrideType::Local,
        };

        // Pre-populate all fields to avoid redundant update_item call
        let mut item = OverrideItem::new(entry.name.clone(), ext, r#type);
        item.global = entry.global;
        item.profile_ids.clone_from(&entry.profile_ids);
        item.enabled = entry.enabled;
        if let Some(u) = &entry.url {
            item.url = Some(u.clone());
        }

        items_to_import.push((item, entry.content.clone()));
    }

    // Batch import: single metadata lock, then best-effort content writes
    overrides_store::import_items_batch(&state, items_to_import)
}
