//! Shared pipeline for executing scripts with config write-back and hot-reload.

use std::thread;
use std::time::Duration;

use clash_prism_script::{ScriptContext, ScriptRuntime};
use serde_json::json;

use tauri::Manager as _;

use crate::core_manager::ensure_app_storage;
use crate::core_manager::write_file_secure;
use crate::prism::PrismState;
use crate::MihomoState;

// Use eprintln for logging since tracing is not available in this crate
macro_rules! log_error {
    ($($arg:tt)*) => { eprintln!($($arg)*) };
}
macro_rules! log_info {
    ($($arg:tt)*) => { eprintln!($($arg)*) };
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

/// Execute a JavaScript script against the running config with write-back.
///
/// This function:
/// 1. Reads the current running config from `run_config.yaml`
/// 2. Executes the script via `ScriptRuntime::execute_with_write`
/// 3. If config was modified, writes back to `run_config.yaml`
/// 4. Triggers hot-reload via Mihomo REST API
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
    // 1. Read current running config (YAML → JSON)
    let config_str = state.with_ext(|_ext| {
        let paths = ensure_app_storage(&state.app)?;
        std::fs::read_to_string(paths.core_dir.join("run_config.yaml"))
            .map_err(|e| format!("Failed to read running config: {e}"))
    })?;
    let config: serde_json::Value = serde_yaml::from_str(&config_str)
        .map_err(|e| format!("Failed to parse running config as YAML: {e}"))?;

    // 2. Build script context
    let ctx = ScriptContext {
        core_type: "mihomo".to_owned(),
        core_version: String::new(),
        platform: std::env::consts::OS.to_owned(),
        profile_name: String::new(),
    };

    // 3. Execute with write-back
    let runtime = ScriptRuntime::with_context(ctx);
    let result = runtime.execute_with_write(script, script_name, &config);

    // 4. If config was modified, write back + hot-reload
    if result.success && result.config_modified {
        if let Some(modified) = &result.modified_config {
            // Serialize to YAML
            let yaml_str = serde_yaml::to_string(modified)
                .map_err(|e| format!("Failed to serialize config to YAML: {e}"))?;

            // Write to run_config.yaml
            state.with_ext(|_ext| {
                let paths = ensure_app_storage(&state.app)?;
                let run_config_path = paths.core_dir.join("run_config.yaml");
                write_file_secure(&run_config_path, &yaml_str)
                    .map_err(|e| format!("Failed to write run_config.yaml: {e}"))?;
                Ok::<(), String>(())
            })?;

            // Hot-reload via Mihomo REST API (spawn in background thread to avoid blocking UI)
            let state_ref = state.app.state::<MihomoState>();
            let lock = state_ref
                .0
                .lock()
                .map_err(|e| format!("Lock failed: {e}"))?;
            let port = lock.last_port().unwrap_or(9090);
            let secret = lock.last_secret().to_owned();
            drop(lock);

            // Get the run_config.yaml path for the reload request
            let run_config_path = {
                let paths = ensure_app_storage(&state.app)?;
                paths.core_dir.join("run_config.yaml")
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
        }
    }

    // 5. Convert result to PipelineResult
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

    Ok(PipelineResult {
        success: result.success,
        error: result.error,
        duration_us: result.duration_us,
        config_modified: result.config_modified,
        logs,
        patches,
    })
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
    // 1. Read current running config (YAML → JSON)
    let config_str = state.with_ext(|_ext| {
        let paths = ensure_app_storage(&state.app)?;
        std::fs::read_to_string(paths.core_dir.join("run_config.yaml"))
            .map_err(|e| format!("Failed to read running config: {e}"))
    })?;
    let config: serde_json::Value = serde_yaml::from_str(&config_str)
        .map_err(|e| format!("Failed to parse running config as YAML: {e}"))?;

    // 2. Build script context
    let ctx = ScriptContext {
        core_type: "mihomo".to_owned(),
        core_version: String::new(),
        platform: std::env::consts::OS.to_owned(),
        profile_name: String::new(),
    };

    // 3. Execute with write-back (but don't actually write back)
    let runtime = ScriptRuntime::with_context(ctx);
    let result = runtime.execute_with_write(script, script_name, &config);

    // 4. Convert result to PipelineResult (no write-back)
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

    Ok(PipelineResult {
        success: result.success,
        error: result.error,
        duration_us: result.duration_us,
        config_modified: result.config_modified,
        logs,
        patches,
    })
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
    // 1. Read current running config (YAML → JSON)
    let config_str = state.with_ext(|_ext| {
        let paths = ensure_app_storage(&state.app)?;
        std::fs::read_to_string(paths.core_dir.join("run_config.yaml"))
            .map_err(|e| format!("Failed to read running config: {e}"))
    })?;
    let config: serde_json::Value = serde_yaml::from_str(&config_str)
        .map_err(|e| format!("Failed to parse running config as YAML: {e}"))?;

    // 2. Build script context
    let ctx = ScriptContext {
        core_type: "mihomo".to_owned(),
        core_version: String::new(),
        platform: std::env::consts::OS.to_owned(),
        profile_name: String::new(),
    };

    // 3. Execute with write-back
    let runtime = ScriptRuntime::with_context(ctx);
    let result = runtime.execute_with_write(script, script_name, &config);

    // 4. If config was modified, write back (NO hot-reload)
    if result.success && result.config_modified {
        if let Some(modified) = &result.modified_config {
            // Serialize to YAML
            let yaml_str = serde_yaml::to_string(modified)
                .map_err(|e| format!("Failed to serialize config to YAML: {e}"))?;

            // Write to run_config.yaml
            state.with_ext(|_ext| {
                let paths = ensure_app_storage(&state.app)?;
                let run_config_path = paths.core_dir.join("run_config.yaml");
                write_file_secure(&run_config_path, &yaml_str)
                    .map_err(|e| format!("Failed to write run_config.yaml: {e}"))?;
                Ok::<(), String>(())
            })?;
            // No hot-reload here - caller will trigger it once after batch
        }
    }

    // 5. Convert result to PipelineResult
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

    Ok(PipelineResult {
        success: result.success,
        error: result.error,
        duration_us: result.duration_us,
        config_modified: result.config_modified,
        logs,
        patches,
    })
}
