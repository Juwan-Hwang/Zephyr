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

/// Serializes one reload-and-reconcile sequence against the next.
///
/// The epoch a reconciliation acts on is snapshotted when its sequence
/// starts, and any publish in between voids it — by design, so a stale
/// result never overwrites a newer one. Without this lock two sequences
/// overlap freely: the later override's write and reload can complete
/// while the earlier sequence is still confirming, and when the earlier
/// one then publishes, the later one's snapshot is already stale, so
/// its confirmed result is discarded and the tray keeps the earlier
/// state until some unrelated change reconciles again. Holding the
/// sequence end to end means a later sequence snapshots the generation
/// only after the earlier one has published, so its result stands.
static RELOAD_RECONCILE_LOCK: Mutex<()> = Mutex::new(());

/// Hold one reload-and-reconcile sequence (see `RELOAD_RECONCILE_LOCK`)
/// from its generation snapshot through its reconciliation. The Prism
/// host path reloads on its own instead of going through
/// `trigger_hot_reload_and_reconcile_tun`, so it takes the same lock
/// through this accessor on its apply thread, from its snapshot and
/// reload through the confirmation thread it joins: an unserialized
/// host sequence overlapping a pipeline one voids one side's confirmed
/// result exactly like two overlapping pipeline sequences would. The
/// lock is never held across the tray repaint a reconciliation calls
/// for (see `reconcile_tun_with_core`).
pub(crate) fn acquire_reload_reconcile_lock() -> std::sync::MutexGuard<'static, ()> {
    RELOAD_RECONCILE_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

// Use eprintln for logging since tracing is not available in this crate
macro_rules! log_error {
    ($($arg:tt)*) => { emit_error!(Prism, PRISM_SCRIPT_EXEC_FAILED, $($arg)*) };
}
macro_rules! log_info {
    ($($arg:tt)*) => { emit_info!(Prism, PRISM_SCRIPT_INFO, $($arg)*) };
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

/// The endpoint a hot reload talks to: the running core's port and secret,
/// plus the `run_config.yaml` path the reload asks it to load.
fn hot_reload_target(state: &PrismState) -> Result<(u16, String, String), String> {
    let (port, secret) = {
        let mihomo_state = state.app.state::<MihomoState>();
        let lock = mihomo_state
            .0
            .lock()
            .map_err(|e| format!("Lock failed: {e}"))?;
        let port = lock.last_port().unwrap_or(9090);
        let secret = lock.last_secret().to_owned();
        drop(lock);
        (port, secret)
    };

    let paths = ensure_app_storage(&state.app)?;
    let run_config_path_str = paths
        .core_dir
        .join("run_config.yaml")
        .to_string_lossy()
        .to_string();
    Ok((port, secret, run_config_path_str))
}

/// Send `PUT /configs?force=true` with `{"path": "<run_config.yaml>"}` so that
/// Mihomo reloads the config from disk. Blocking: call it from a background
/// thread.
fn send_hot_reload(port: u16, secret: &str, run_config_path: &str) -> Result<(), String> {
    let url = format!("http://127.0.0.1:{port}/configs?force=true");
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(10))
        .no_proxy()
        .build()
        .map_err(|e| format!("HTTP client error: {e}"))?;
    // Mihomo PUT /configs expects {"path": "..."} to reload from file
    let body = serde_json::json!({ "path": run_config_path });
    let resp = client
        .put(&url)
        .header("Authorization", format!("Bearer {secret}"))
        .json(&body)
        .send()
        .map_err(|e| format!("Request failed: {e}"))?;
    if resp.status().is_success() {
        log_info!("[hot-reload] Success: {}", resp.status());
        Ok(())
    } else {
        Err(format!(
            "Failed: {} - {}",
            resp.status(),
            resp.text().unwrap_or_default()
        ))
    }
}

/// Send the hot-reload request and report whether Mihomo accepted it;
/// failures are logged. Blocking: call it from a background thread.
fn perform_hot_reload(port: u16, secret: &str, run_config_path_str: &str) -> bool {
    match send_hot_reload(port, secret, run_config_path_str) {
        Ok(()) => true,
        Err(e) => {
            log_error!("[hot-reload] {e}");
            false
        }
    }
}

/// Trigger a hot-reload request to Mihomo via its REST API.
///
/// Spawns a background thread to avoid blocking the caller.
pub fn trigger_hot_reload(state: &PrismState) -> Result<(), String> {
    let (port, secret, run_config_path_str) = hot_reload_target(state)?;

    thread::spawn(move || {
        perform_hot_reload(port, &secret, &run_config_path_str);
    });

    Ok(())
}

/// Ask the running core which `tun.enable` it has actually applied.
///
/// `GET /configs` reports the config Mihomo is running, so this is the
/// confirmation the TUN toggle flows already wait for before recording a
/// state. Returns `None` when the core cannot be asked or its answer does
/// not carry the flag. Blocking: call it from a background thread.
///
/// The ask is retried a few times with a short pause: this confirmation
/// runs right after a reload the core already accepted, and a single
/// transient failure there would otherwise record nothing, leaving the
/// tray showing the pre-reload state for a core that runs the new one.
/// The file alone never vouches for the core, so the retry asks the core
/// again instead of falling back to it.
pub(crate) fn confirmed_tun_enabled(port: u16, secret: &str) -> Option<bool> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(5))
        .no_proxy()
        .build()
        .ok()?;
    for attempt in 0..3 {
        if attempt > 0 {
            thread::sleep(Duration::from_millis(250));
        }
        let Ok(resp) = client
            .get(format!("http://127.0.0.1:{port}/configs"))
            .header("Authorization", format!("Bearer {secret}"))
            .send()
        else {
            continue;
        };
        if !resp.status().is_success() {
            continue;
        }
        let Ok(body) = resp.json::<serde_json::Value>() else {
            continue;
        };
        if let Some(enabled) = body
            .get("tun")
            .and_then(|tun| tun.get("enable"))
            .and_then(serde_json::Value::as_bool)
        {
            return Some(enabled);
        }
    }
    None
}

/// Hot-reload, then reconcile the live TUN state with the core.
///
/// Like [`trigger_hot_reload`], but once Mihomo accepts the reload the
/// thread asks the core which `tun.enable` it applied and hands that
/// confirmed value to
/// [`reconcile_tun_with_core`](crate::core_manager::core::tun_manager::reconcile_tun_with_core).
/// A reload the core refuses — or whose outcome cannot be confirmed —
/// leaves the live TUN state exactly as it was: the value sitting in
/// `run_config.yaml` alone is never enough to change what the tray
/// reports. The reconciliation only updates the in-memory live state;
/// the saved `tun_enabled` preference is the user's own choice, and an
/// override never rewrites it.
pub fn trigger_hot_reload_and_reconcile_tun(state: &PrismState) -> Result<(), String> {
    let (port, secret, run_config_path_str) = hot_reload_target(state)?;
    let app = state.app.clone();

    thread::spawn(move || {
        // The sequence lock covers the snapshot, the reload, the
        // confirmation and the publication — but not the tray repaint
        // the reconciliation may call for: tray writes wait on the main
        // thread, so holding the lock across them could deadlock
        // against a main-thread caller waiting on this lock. The
        // repaint reads the live state fresh, so running it after the
        // lock is released still paints the newest state.
        let tray_refresh_needed = {
            let _sequence = acquire_reload_reconcile_lock();
            // Snapshot the live-state generation before the reload: a TUN
            // preference recorded while the reload and the confirmation
            // query are in flight voids this reconciliation, even when the
            // recorded value itself did not change.
            let epoch = crate::core_manager::core::tun_manager::live_tun_state_epoch();
            if !perform_hot_reload(port, &secret, &run_config_path_str) {
                false
            } else if let Some(applied) = confirmed_tun_enabled(port, &secret) {
                crate::core_manager::core::tun_manager::reconcile_tun_with_core(
                    &app, applied, epoch,
                )
            } else {
                false
            }
        };
        if tray_refresh_needed {
            crate::core_manager::core::tun_manager::refresh_tray_after_reconcile(&app);
        }
    });

    Ok(())
}

/// Hot-reload, reconcile the live TUN state with the core, and wait for both.
///
/// The awaited counterpart of [`trigger_hot_reload_and_reconcile_tun`], for a
/// caller that acts on the reloaded config right after (restoring a proxy
/// selection must see the reloaded groups) or reports whether the core took it.
pub async fn hot_reload_and_wait(state: &PrismState) -> Result<(), String> {
    let (port, secret, run_config_path) = hot_reload_target(state)?;
    let app = state.app.clone();
    let (result, tray_refresh_needed) = tokio::task::spawn_blocking(move || {
        // Same lock scope as `trigger_hot_reload_and_reconcile_tun`: the
        // tray repaint runs after the lock is released.
        let _sequence = acquire_reload_reconcile_lock();
        let epoch = crate::core_manager::core::tun_manager::live_tun_state_epoch();
        let result = send_hot_reload(port, &secret, &run_config_path);
        let refresh = result.is_ok()
            && confirmed_tun_enabled(port, &secret).is_some_and(|applied| {
                crate::core_manager::core::tun_manager::reconcile_tun_with_core(
                    &app, applied, epoch,
                )
            });
        (result, refresh)
    })
    .await
    .map_err(|e| format!("Hot reload task failed: {e}"))?;
    if tray_refresh_needed {
        crate::core_manager::core::tun_manager::refresh_tray_after_reconcile(&state.app);
    }
    result.inspect_err(|e| {
        log_error!("[hot-reload] {e}");
    })
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
            trigger_hot_reload_and_reconcile_tun(state)?;
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
            trigger_hot_reload_and_reconcile_tun(state)?;
        }
    }

    Ok(results)
}
