//! Shared pipeline for executing scripts with config write-back and hot-reload.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use clash_prism_script::{ScriptContext, ScriptRuntime};
use serde_json::json;

use tauri::AppHandle;
use tauri::Manager as _;

use crate::core_manager::core::secure_io::write_file_secure_atomic;
use crate::core_manager::ensure_app_storage;
use crate::prism::PrismState;
use crate::MihomoState;

/// Global mutex that serializes all `run_config.yaml` read-modify-write operations.
/// This prevents "lost update" race conditions when multiple override executions
/// or profile switches occur concurrently.
pub(crate) static RUN_CONFIG_LOCK: Mutex<()> = Mutex::new(());

/// Number of core starts currently in progress (see [`CoreStartGuard`]).
/// A Prism write that lands while a start is replacing `run_config.yaml`
/// would re-write the file with the previous run's port/secret and fail
/// the startup health check — the new core reads the old secret while
/// the check presents the new one. Both `hot_reload_target` and the
/// Prism host's apply path fail closed while this is non-zero; the
/// caller retries once the start has published the new child. A
/// counter (not a bool) so two overlapping starts cannot clear each
/// other's flag.
static CORE_START_COUNT: AtomicUsize = AtomicUsize::new(0);

/// Whether a core start/restart is currently in progress.
pub(crate) fn core_start_in_progress() -> bool {
    CORE_START_COUNT.load(Ordering::SeqCst) > 0
}

/// RAII guard: mark a core start in progress from `select_runtime_config`
/// writing the new `run_config.yaml` until the new child is published in
/// core state. Cleared on drop, so every failure path releases it too.
/// The guard only gates `hot_reload_target` and the Prism host's apply
/// path — a refused reload errors and its caller retries.
#[must_use]
pub(crate) struct CoreStartGuard;

impl CoreStartGuard {
    pub(crate) fn acquire() -> Self {
        CORE_START_COUNT.fetch_add(1, Ordering::SeqCst);
        Self
    }
}

impl Drop for CoreStartGuard {
    fn drop(&mut self) {
        CORE_START_COUNT.fetch_sub(1, Ordering::SeqCst);
    }
}

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
fn hot_reload_target(app: &AppHandle) -> Result<(u16, String, String), String> {
    // Fail closed while a core start is in progress: the start is
    // replacing `run_config.yaml` with fresh credentials (see
    // `CORE_START_COUNT`) — a write here would re-write the file with
    // the previous run's port/secret and fail the startup health check.
    if core_start_in_progress() {
        return Err("Hot reload refused: a core start is in progress".to_owned());
    }
    let (port, secret) = {
        let mihomo_state = app.state::<MihomoState>();
        let lock = mihomo_state
            .0
            .lock()
            .map_err(|e| format!("Lock failed: {e}"))?;
        // Fail closed while the core has not published its controller
        // yet (first start, before the health check passes): falling
        // back to 9090 / a stale secret here would write the prepared
        // credentials away and fail the startup health check.
        let Some(port) = lock.last_port() else {
            return Err(
                "Hot reload refused: the core has not published its controller port yet".to_owned(),
            );
        };
        let secret = lock.last_secret().to_owned();
        drop(lock);
        (port, secret)
    };

    let paths = ensure_app_storage(app)?;
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
    let (port, secret, run_config_path_str) = hot_reload_target(&state.app)?;

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
    // Read here to report a missing target to the caller; read again under
    // the sequence lock, since a core restart while queued changes them.
    hot_reload_target(&state.app)?;
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
            let target = hot_reload_target(&app);
            if let Err(e) = &target {
                log_error!("[hot-reload] {e}");
            }
            let Ok((port, secret, run_config_path_str)) = target else {
                return;
            };
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
    let app = state.app.clone();
    let result = tokio::task::spawn_blocking(move || {
        // Same lock scope as `trigger_hot_reload_and_reconcile_tun`: the
        // tray repaint runs after the lock is released, still on this
        // blocking thread (it can shell out and waits on the main thread,
        // so it must not tie up an async worker).
        let (result, tray_refresh_needed) = {
            let _sequence = acquire_reload_reconcile_lock();
            let epoch = crate::core_manager::core::tun_manager::live_tun_state_epoch();
            // Read under the lock: a core restart while this waited for it
            // changes the port and secret.
            let target = hot_reload_target(&app);
            let result = target.as_ref().map_err(Clone::clone).and_then(
                |(port, secret, run_config_path)| send_hot_reload(*port, secret, run_config_path),
            );
            let refresh = result.is_ok()
                && target.as_ref().is_ok_and(|(port, secret, _)| {
                    confirmed_tun_enabled(*port, secret).is_some_and(|applied| {
                        crate::core_manager::core::tun_manager::reconcile_tun_with_core(
                            &app, applied, epoch,
                        )
                    })
                });
            (result, refresh)
        };
        if tray_refresh_needed {
            crate::core_manager::core::tun_manager::refresh_tray_after_reconcile(&app);
        }
        result
    })
    .await
    .map_err(|e| format!("Hot reload task failed: {e}"))?;
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

/// Restore provider `path` / `script-path` entries the script did not
/// change. The sanitizer above strips them from every provider — it
/// cannot tell a script-added path from one already in the running
/// config — but `prepare_runtime_config` only strips control-plane
/// keys, so a `type: file` provider placed by hand, or copied in by
/// a legacy migration, legitimately carries its path in
/// `run_config.yaml`. A script run must not delete it: the provider
/// would fail on the next hot reload, until a restart regenerates the
/// config from the profile. Only providers the script left exactly as
/// they were get their paths back: a provider the script touched (a
/// path added, changed, or removed, or anything else about it) keeps
/// the stripped result, because its path is then the script's doing.
fn restore_unchanged_provider_paths(
    stripped: &mut serde_json::Value,
    modified: &serde_json::Value,
    before: &serde_json::Value,
) {
    for section in ["proxy-providers", "rule-providers"] {
        let Some(stripped_providers) = stripped
            .get_mut(section)
            .and_then(serde_json::Value::as_object_mut)
        else {
            continue;
        };
        let Some(before_providers) = before.get(section).and_then(serde_json::Value::as_object)
        else {
            continue;
        };
        let Some(modified_providers) = modified.get(section).and_then(serde_json::Value::as_object)
        else {
            continue;
        };
        for (name, provider) in stripped_providers.iter_mut() {
            let Some(before_provider) = before_providers.get(name) else {
                continue;
            };
            // Only when the script left this provider exactly as it
            // was: any other change means the path is the script's.
            if modified_providers.get(name) != Some(before_provider) {
                continue;
            }
            let (Some(provider_obj), Some(before_obj)) =
                (provider.as_object_mut(), before_provider.as_object())
            else {
                continue;
            };
            for key in ["path", "script-path"] {
                if !provider_obj.contains_key(key) {
                    if let Some(value) = before_obj.get(key) {
                        provider_obj.insert(key.to_owned(), value.clone());
                    }
                }
            }
        }
    }
}

/// Write the modified config back to `run_config.yaml`, through a temporary
/// file: a failed write leaves the previous config whole, since the reload
/// that follows a failed batch (for the Prism patches before it) loads it.
fn write_running_config(
    state: &PrismState,
    config: &serde_json::Value,
    before: &serde_json::Value,
) -> Result<(), String> {
    // A script may add an unauthenticated control surface (such as
    // `external-controller-unix`) to the running config; the strip in
    // `prepare_runtime_config` never sees script output, so filter it
    // here, before the config is written back and hot-reloaded. The
    // strip only removes the unauthenticated surfaces — the TCP
    // `external-controller` / `secret` are left alone there, because
    // `prepare_runtime_config` re-injects the managed values right
    // after. This writer has no such step, so a script that sets
    // `external-controller` to `0.0.0.0:9090` and clears `secret`
    // would reach the reload as-is. Restore the managed values here
    // instead: the written config always carries the controller the
    // app itself uses, never the script's.
    let mut stripped = config.clone();
    zephyr_core::config::sanitizer::remove_control_plane_keys_json(&mut stripped);
    // Same rule as the `apply_config` path: also strip provider `path`
    // / `script-path` keys a script may have added, mirroring the
    // import sanitizer — otherwise a provider path inside the core
    // directory would be kept and reloaded, and mihomo would load it.
    zephyr_core::config::sanitizer::remove_dangerous_keys_json(&mut stripped);
    // A provider path the script did not touch is not the script's to
    // remove (see above): put back exactly the ones that were already
    // there, unchanged.
    restore_unchanged_provider_paths(&mut stripped, config, before);
    let (port, secret, _) = hot_reload_target(&state.app)?;
    if let Some(obj) = stripped.as_object_mut() {
        obj.insert(
            "external-controller".to_owned(),
            serde_json::json!(format!("127.0.0.1:{port}")),
        );
        obj.insert("secret".to_owned(), serde_json::json!(secret));
    }
    let yaml_str = serde_yaml::to_string(&stripped)
        .map_err(|e| format!("Failed to serialize config to YAML: {e}"))?;
    // Re-check immediately before the write: a start that began during
    // the strip/serialize above would have its fresh credentials
    // overwritten by this write (the values above were read before it
    // began). The check inside `hot_reload_target` is already just
    // before the injection, so this only covers the serialize step.
    if core_start_in_progress() {
        return Err("Hot reload refused: a core start is in progress".to_owned());
    }
    state.with_ext(|_ext| {
        let paths = ensure_app_storage(&state.app)?;
        let run_config_path = paths.core_dir.join("run_config.yaml");
        write_file_secure_atomic(&run_config_path, &yaml_str)
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
            write_running_config(state, modified, &config)?;
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
            write_running_config(state, modified, &config)?;
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
    // The config before any script ran: the write-back restores
    // provider paths the scripts left untouched against this, not
    // against the in-memory result of an earlier script.
    let before = config.clone();
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
        write_running_config(state, &config, &before)?;
        if hot_reload {
            trigger_hot_reload_and_reconcile_tun(state)?;
        }
    }

    Ok(results)
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use serde_json::json;

    fn file_provider(path: &str) -> serde_json::Value {
        json!({ "type": "file", "path": path, "interval": 3600 })
    }

    #[test]
    fn restore_unchanged_provider_paths_restores_untouched_path() {
        let before =
            json!({ "proxy-providers": { "local": file_provider("/profiles/local.yaml") } });
        let modified = before.clone();
        let mut stripped = modified.clone();
        stripped["proxy-providers"]["local"]
            .as_object_mut()
            .unwrap()
            .remove("path");
        restore_unchanged_provider_paths(&mut stripped, &modified, &before);
        assert_eq!(
            stripped["proxy-providers"]["local"]["path"],
            json!("/profiles/local.yaml")
        );
    }

    #[test]
    fn restore_unchanged_provider_paths_ignores_script_added_path() {
        let before = json!({ "proxy-providers": { "local": { "type": "http", "url": "https://example.com/list.yaml", "interval": 3600 } } });
        let mut modified = before.clone();
        modified["proxy-providers"]["local"]["path"] = json!("/tmp/evil.yaml");
        let mut stripped = modified.clone();
        stripped["proxy-providers"]["local"]
            .as_object_mut()
            .unwrap()
            .remove("path");
        restore_unchanged_provider_paths(&mut stripped, &modified, &before);
        assert!(stripped["proxy-providers"]["local"].get("path").is_none());
    }

    #[test]
    fn restore_unchanged_provider_paths_ignores_changed_provider() {
        let before =
            json!({ "proxy-providers": { "local": file_provider("/profiles/local.yaml") } });
        let mut modified = before.clone();
        modified["proxy-providers"]["local"]["path"] = json!("/profiles/other.yaml");
        let mut stripped = modified.clone();
        stripped["proxy-providers"]["local"]
            .as_object_mut()
            .unwrap()
            .remove("path");
        restore_unchanged_provider_paths(&mut stripped, &modified, &before);
        assert!(stripped["proxy-providers"]["local"].get("path").is_none());
    }

    #[test]
    fn restore_unchanged_provider_paths_keeps_script_removed_path_removed() {
        let before =
            json!({ "proxy-providers": { "local": file_provider("/profiles/local.yaml") } });
        let mut modified = before.clone();
        modified["proxy-providers"]["local"]
            .as_object_mut()
            .unwrap()
            .remove("path");
        let mut stripped = modified.clone();
        restore_unchanged_provider_paths(&mut stripped, &modified, &before);
        assert!(stripped["proxy-providers"]["local"].get("path").is_none());
    }
}
