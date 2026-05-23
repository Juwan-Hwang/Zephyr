//! Shared pipeline for executing scripts with config write-back and hot-reload.

use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use clash_prism_script::{ScriptContext, ScriptRuntime};
use serde_json::json;

use tauri::Manager as _;

use crate::core_manager::ensure_app_storage;
use crate::core_manager::write_file_secure;
use crate::prism::PrismState;
use crate::MihomoState;

/// Global mutex that serializes all `run_config.yaml` read-modify-write operations.
/// This prevents "lost update" race conditions when multiple override executions
/// or profile switches occur concurrently.
pub(crate) static RUN_CONFIG_LOCK: Mutex<()> = Mutex::new(());

// Use eprintln for logging since tracing is not available in this crate
macro_rules! log_error {
    ($($arg:tt)*) => { emit_info!(Prism, PRISM_SCRIPT_ERROR, $($arg)*) };
}
macro_rules! log_info {
    ($($arg:tt)*) => { emit_info!(Prism, PRISM_SCRIPT_ERROR, $($arg)*) };
}

/// Result of executing a script with write-back.
#[derive(Debug, Clone)]
pub struct PipelineResult {
    pub success: bool,
    pub error: Option<String>,
    pub duration_us: u64,
    pub config_modified: bool,
    pub logs: Vec<LogEntry>,
    pub patches: Vec<PatchInfo>,
}

/// Log entry from script execution.
#[derive(Debug, Clone)]
pub struct LogEntry {
    pub level: String,
    pub message: String,
}

/// Patch info from script execution.
#[derive(Debug, Clone)]
pub struct PatchInfo {
    pub op: String,
    pub path: String,
}

/// Trigger a hot-reload request to Mihomo via its REST API.
///
/// Spawns a background thread to avoid blocking the caller. The request sends
/// `PUT /configs?force=true` with `{"path": "<run_config.yaml>"}` so that
/// Mihomo reloads the config from disk.
pub fn trigger_hot_reload(state: &PrismState) -> Result<(), String> {
    let (port, secret, run_config_path) = {
        let mihomo_state = state.app.state::<MihomoState>();
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
                log_error!("[hot-reload] HTTP client error: {e}");
                return;
            }
        };
        // Mihomo PUT /configs expects {"path": "..."} to reload from file
        let body = serde_json::json!({ "path": run_config_path_str });
        match client
            .put(&url)
            .header("Authorization", format!("Bearer {secret}"))
            .json(&body)
            .send()
        {
            Ok(resp) => {
                if resp.status().is_success() {
                    log_info!("[hot-reload] Success: {}", resp.status());
                } else {
                    log_error!(
                        "[hot-reload] Failed: {} - {}",
                        resp.status(),
                        resp.text().unwrap_or_default()
                    );
                }
            }
            Err(e) => {
                log_error!("[hot-reload] Request failed: {e}");
            }
        }
    });

    Ok(())
}

/// Read the current running config from `run_config.yaml` and parse as JSON.
fn read_running_config(state: &PrismState) -> Result<serde_json::Value, String> {
    let config_str = state.with_ext(|_ext| {
        let paths = ensure_app_storage(&state.app)?;
        std::fs::read_to_string(paths.core_dir.join("run_config.yaml"))
            .map_err(|e| format!("Failed to read running config: {e}"))
    })?;
    serde_yaml::from_str(&config_str)
        .map_err(|e| format!("Failed to parse running config as YAML: {e}"))
}

/// Write the modified config back to `run_config.yaml`.
fn write_running_config(state: &PrismState, config: &serde_json::Value) -> Result<(), String> {
    let yaml_str = serde_yaml::to_string(config)
        .map_err(|e| format!("Failed to serialize config to YAML: {e}"))?;
    state.with_ext(|_ext| {
        let paths = ensure_app_storage(&state.app)?;
        let run_config_path = paths.core_dir.join("run_config.yaml");
        write_file_secure(&run_config_path, &yaml_str)
            .map_err(|e| format!("Failed to write run_config.yaml: {e}"))?;
        Ok::<(), String>(())
    })
}

/// Build a script context for the current runtime.
pub(crate) fn build_script_context() -> ScriptContext {
    ScriptContext {
        core_type: "mihomo".to_owned(),
        core_version: String::new(),
        platform: std::env::consts::OS.to_owned(),
        profile_name: String::new(),
    }
}

/// Convert a `clash_prism_script` result into our `PipelineResult`.
fn to_pipeline_result(result: &clash_prism_script::WriteScriptResult) -> PipelineResult {
    let logs: Vec<LogEntry> = result
        .logs
        .iter()
        .map(|l| LogEntry {
            level: format!("{:?}", l.level),
            message: l.message.clone(),
        })
        .collect();
    let patches: Vec<PatchInfo> = result
        .patches
        .iter()
        .map(|p| PatchInfo {
            op: format!("{:?}", p.op),
            path: p.path.clone(),
        })
        .collect();

    PipelineResult {
        success: result.success,
        error: result.error.clone(),
        duration_us: result.duration_us,
        config_modified: result.config_modified,
        logs,
        patches,
    }
}

/// Execute a JavaScript script against the running config with write-back.
///
/// This function:
/// 1. Acquires the global `RUN_CONFIG_LOCK` to prevent concurrent modifications
/// 2. Reads the current running config from `run_config.yaml`
/// 3. Executes the script via `ScriptRuntime::execute_with_write`
/// 4. If config was modified, writes back to `run_config.yaml`
/// 5. Triggers hot-reload via Mihomo REST API
///
/// # Arguments
/// * `state` - The Prism state for accessing app handle and storage
/// * `script` - The JavaScript source code
/// * `script_name` - Name for logging/tracing
///
/// # Returns
/// The pipeline result containing execution status, logs, and patches.
pub fn execute_write_pipeline(
    state: &PrismState,
    script: &str,
    script_name: &str,
) -> Result<PipelineResult, String> {
    // Serialize all run_config.yaml modifications to prevent lost updates
    let _guard = RUN_CONFIG_LOCK
        .lock()
        .map_err(|e| format!("Run config lock poisoned: {e}"))?;

    let config = read_running_config(state)?;

    let runtime = ScriptRuntime::with_context(build_script_context());
    let result = runtime.execute_with_write(script, script_name, &config);

    if result.success && result.config_modified {
        if let Some(modified) = &result.modified_config {
            write_running_config(state, modified)?;
            trigger_hot_reload(state)?;
        }
    }

    Ok(to_pipeline_result(&result))
}

/// Execute a JavaScript script in dry-run mode (no write-back).
///
/// This function:
/// 1. Reads the current running config from `run_config.yaml`
/// 2. Executes the script via `ScriptRuntime::execute_with_write`
/// 3. Returns the result without modifying the config
///
/// # Arguments
/// * `state` - The Prism state for accessing app handle and storage
/// * `script` - The JavaScript source code
/// * `script_name` - Name for logging/tracing
///
/// # Returns
/// The pipeline result containing execution status, logs, and patches.
/// Note: `config_modified` will always be true if the script returns a modified
/// config, but the config is not actually written back.
pub fn execute_test_pipeline(
    state: &PrismState,
    script: &str,
    script_name: &str,
) -> Result<PipelineResult, String> {
    let config = read_running_config(state)?;

    let runtime = ScriptRuntime::with_context(build_script_context());
    let result = runtime.execute_with_write(script, script_name, &config);

    Ok(to_pipeline_result(&result))
}

/// Convert `PipelineResult` to JSON for Tauri IPC response.
#[must_use]
pub fn pipeline_result_to_json(result: &PipelineResult) -> serde_json::Value {
    let logs: Vec<serde_json::Value> = result
        .logs
        .iter()
        .map(|l| {
            json!({
                "level": l.level,
                "message": l.message,
            })
        })
        .collect();
    let patches: Vec<serde_json::Value> = result
        .patches
        .iter()
        .map(|p| json!({ "op": p.op, "path": p.path }))
        .collect();

    json!({
        "success": result.success,
        "error": result.error,
        "duration_us": result.duration_us,
        "config_modified": result.config_modified,
        "logs": logs,
        "patches": patches,
    })
}

/// Execute a JavaScript script against the running config with write-back but NO hot-reload.
///
/// This is used for batch operations where hot-reload should be triggered only once
/// after all scripts have been applied.
///
/// # Arguments
/// * `state` - The Prism state for accessing app handle and storage
/// * `script` - The JavaScript source code
/// * `script_name` - Name for logging/tracing
///
/// # Returns
/// The pipeline result containing execution status, logs, and patches.
pub fn execute_write_pipeline_no_reload(
    state: &PrismState,
    script: &str,
    script_name: &str,
) -> Result<PipelineResult, String> {
    // Serialize all run_config.yaml modifications to prevent lost updates
    let _guard = RUN_CONFIG_LOCK
        .lock()
        .map_err(|e| format!("Run config lock poisoned: {e}"))?;

    let config = read_running_config(state)?;

    let runtime = ScriptRuntime::with_context(build_script_context());
    let result = runtime.execute_with_write(script, script_name, &config);

    if result.success && result.config_modified {
        if let Some(modified) = &result.modified_config {
            write_running_config(state, modified)?;
            // No hot-reload here - caller will trigger it once after batch
        }
    }

    Ok(to_pipeline_result(&result))
}

/// Execute multiple scripts in batch: load config once, apply all scripts in memory,
/// write back once, then optionally trigger hot-reload.
///
/// This avoids redundant I/O when applying multiple overrides sequentially.
///
/// # Arguments
/// * `state` - The Prism state for accessing app handle and storage
/// * `scripts` - Slice of `(script_content, script_name)` tuples
/// * `hot_reload` - Whether to trigger hot-reload after writing
///
/// # Returns
/// A vector of pipeline results, one per script.
pub fn execute_batch_pipeline(
    state: &PrismState,
    scripts: &[(&str, &str)],
    hot_reload: bool,
) -> Result<Vec<PipelineResult>, String> {
    // Serialize all run_config.yaml modifications to prevent lost updates
    let _guard = RUN_CONFIG_LOCK
        .lock()
        .map_err(|e| format!("Run config lock poisoned: {e}"))?;

    // 1. Load config once
    let mut config = read_running_config(state)?;
    let mut any_modified = false;
    let mut results = Vec::with_capacity(scripts.len());

    // 2. Apply each script in memory
    let ctx = build_script_context();
    let runtime = ScriptRuntime::with_context(ctx);
    for (script, name) in scripts {
        let mut result = runtime.execute_with_write(script, name, &config);
        if result.success && result.config_modified {
            if let Some(modified) = result.modified_config.take() {
                config = modified;
                any_modified = true;
            }
        }
        results.push(to_pipeline_result(&result));
    }

    // 3. Write back once if any script modified the config
    if any_modified {
        write_running_config(state, &config)?;
        if hot_reload {
            trigger_hot_reload(state)?;
        }
    }

    Ok(results)
}
