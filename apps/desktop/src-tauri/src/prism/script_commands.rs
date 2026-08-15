//! Script Engine — IPC commands (sandbox, limits, permissions).

#![allow(clippy::needless_pass_by_value)]

use tauri::State;

use clash_prism_script::{SandboxConfig, ScriptContext, ScriptRuntime};

use crate::prism::pipeline::{execute_write_pipeline, pipeline_result_to_json};
use crate::prism::types::check_input_size;
use crate::prism::PrismState;

/// Execute a JavaScript script inside the Prism sandbox.
///
/// The script receives the running Mihomo configuration as context and can
/// read (but not modify) proxy/state data. Resource limits (execution time,
/// memory, string length, loop iterations, recursion depth) are enforced by
/// the `ScriptLimits` configuration.
///
/// Rate-limited: 10 calls per 10 seconds.
#[tauri::command]
pub fn script_execute(
    state: State<PrismState>,
    script: String,
    script_name: String,
) -> Result<serde_json::Value, String> {
    state.check_rate_limit("script_execute")?;
    check_input_size(&script, "Script")?;
    let config_str = state.with_ext(|_ext| {
        // Read running config directly from disk
        let paths = crate::ensure_app_storage(&state.app)?;
        std::fs::read_to_string(paths.core_dir.join("run_config.yaml"))
            .map_err(|e| format!("Failed to read running config: {e}"))
    })?;
    let config: serde_json::Value = serde_yaml::from_str(&config_str)
        .unwrap_or_else(|_| serde_json::Value::Object(serde_json::Map::new()));

    let ctx = ScriptContext {
        core_type: "mihomo".to_owned(),
        core_version: String::new(),
        platform: std::env::consts::OS.to_owned(),
        profile_name: String::new(),
    };

    let runtime = ScriptRuntime::with_context(ctx);
    let result = runtime.execute(&script, &script_name, &config);

    // ScriptResult fields don't all implement Serialize; convert manually
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
    let value = serde_json::json!({
        "success": result.success,
        "error": result.error,
        "duration_us": result.duration_us,
        "logs": logs,
    });
    Ok(value)
}

/// Execute a JavaScript override script inside the Prism sandbox.
///
/// The script receives the running Mihomo configuration as context and can
/// **modify** it via `main(config)`. The modified config is written back to
/// `run_config.yaml` and hot-reloaded via the Mihomo REST API.
///
/// Rate-limited: 5 calls per 10 seconds.
///
/// Note: This function is synchronous internally but declared as async to allow
/// Tauri to run it on a blocking thread, preventing UI freezes during script execution.
#[tauri::command]
pub async fn script_execute_write(
    state: State<'_, PrismState>,
    script: String,
    script_name: String,
) -> Result<serde_json::Value, String> {
    state.check_rate_limit("script_execute_write")?;
    check_input_size(&script, "Script")?;

    // Tauri automatically runs async commands on a blocking thread pool,
    // so we can call the synchronous pipeline directly without blocking the UI.
    let result = execute_write_pipeline(&state, &script, &script_name)?;
    Ok(pipeline_result_to_json(&result))
}

#[tauri::command]
pub fn script_validate(script: String) -> Result<bool, String> {
    let runtime = ScriptRuntime::new();
    match runtime.validate(&script) {
        Ok(()) => Ok(true),
        Err(_) => Ok(false), // Validation returns error message, script is unsafe
    }
}

/// Get the current sandbox configuration.
#[tauri::command]
pub fn script_get_sandbox(state: State<PrismState>) -> Result<serde_json::Value, String> {
    let (an, af, ac, aw) = {
        let lock = state.lock_inner()?;
        let sb = &lock.sandbox_config;
        let result = (
            sb.allow_network,
            sb.allow_filesystem,
            sb.allow_child_process,
            sb.allow_workers,
        );
        drop(lock);
        result
    };
    Ok(serde_json::json!({
        "allowNetwork": an,
        "allowFilesystem": af,
        "allowChildProcess": ac,
        "allowWorkers": aw,
    }))
}

/// Minimum and maximum bounds for script limits (defense-in-depth against resource exhaustion and misconfiguration).
pub const MIN_EXECUTION_TIME_MS: u64 = 100;
pub const MAX_EXECUTION_TIME_MS: u64 = 300_000; // 5 minutes
pub const MIN_MEMORY_BYTES: usize = 1024 * 1024; // 1 MB
pub const MAX_MEMORY_BYTES: usize = 512 * 1024 * 1024; // 512 MB
pub const MIN_LOOP_ITERATIONS: u64 = 1_000;
pub const MAX_LOOP_ITERATIONS: u64 = 10_000_000;
pub const MIN_RECURSION_DEPTH: u32 = 8;
pub const MAX_RECURSION_DEPTH: u32 = 512;

/// Set the sandbox configuration.
/// Security: This is a sensitive operation that weakens script isolation.
/// Changes are logged for audit purposes.
#[tauri::command]
pub fn script_set_sandbox(
    state: State<PrismState>,
    allow_network: bool,
    allow_filesystem: bool,
    allow_child_process: bool,
    allow_workers: bool,
) -> Result<(), String> {
    let mut lock = state.lock_inner()?;
    let prev_fs = lock.sandbox_config.allow_filesystem;
    let prev_cp = lock.sandbox_config.allow_child_process;
    lock.sandbox_config.allow_network = allow_network;
    lock.sandbox_config.allow_filesystem = allow_filesystem;
    lock.sandbox_config.allow_child_process = allow_child_process;
    lock.sandbox_config.allow_workers = allow_workers;
    drop(lock);

    // High-visibility security audit logging for sensitive permission grants
    let newly_elevated = (!prev_fs && allow_filesystem) || (!prev_cp && allow_child_process);
    if newly_elevated {
        emit_warn!(Prism, PRISM_SANDBOX_CHANGED,
            "[SECURITY WARNING] High-privilege script sandbox permissions granted: filesystem={allow_filesystem}, child_process={allow_child_process}, network={allow_network}, workers={allow_workers}"
        );
    } else {
        emit_info!(Prism, PRISM_SANDBOX_CHANGED,
            "[SECURITY] Script sandbox config updated: network={allow_network}, filesystem={allow_filesystem}, child_process={allow_child_process}, workers={allow_workers}"
        );
    }
    Ok(())
}

/// Get the current script resource limits.
#[tauri::command]
pub fn script_get_limits(state: State<PrismState>) -> Result<serde_json::Value, String> {
    let (et, mm, os, le, ss, sc, sl, mi, mr) = {
        let lock = state.lock_inner()?;
        let l = &lock.script_limits;
        let result = (
            l.max_execution_time_ms,
            l.max_memory_bytes,
            l.max_output_size_bytes,
            l.max_log_entries,
            l.max_script_size_bytes,
            l.max_config_bytes,
            l.max_string_length,
            l.max_loop_iterations,
            l.max_recursion_depth,
        );
        drop(lock);
        result
    };
    Ok(serde_json::json!({
        "maxExecutionTimeMs": et,
        "maxMemoryBytes": mm,
        "maxOutputSizeBytes": os,
        "maxLogEntries": le,
        "maxScriptSizeBytes": ss,
        "maxConfigBytes": sc,
        "maxStringLength": sl,
        "maxLoopIterations": mi,
        "maxRecursionDepth": mr,
    }))
}

/// Validate script limits boundaries.
pub(crate) fn validate_script_limits(
    max_execution_time_ms: Option<u64>,
    max_memory_bytes: Option<usize>,
    max_loop_iterations: Option<u64>,
    max_recursion_depth: Option<u32>,
) -> Result<(), String> {
    if let Some(v) = max_execution_time_ms {
        if !(MIN_EXECUTION_TIME_MS..=MAX_EXECUTION_TIME_MS).contains(&v) {
            return Err(format!(
                "max_execution_time_ms must be between {MIN_EXECUTION_TIME_MS}ms and {MAX_EXECUTION_TIME_MS}ms (got {v})"
            ));
        }
    }
    if let Some(v) = max_memory_bytes {
        if !(MIN_MEMORY_BYTES..=MAX_MEMORY_BYTES).contains(&v) {
            return Err(format!(
                "max_memory_bytes must be between {MIN_MEMORY_BYTES} bytes (1MB) and {MAX_MEMORY_BYTES} bytes (512MB) (got {v})"
            ));
        }
    }
    if let Some(v) = max_loop_iterations {
        if !(MIN_LOOP_ITERATIONS..=MAX_LOOP_ITERATIONS).contains(&v) {
            return Err(format!(
                "max_loop_iterations must be between {MIN_LOOP_ITERATIONS} and {MAX_LOOP_ITERATIONS} (got {v})"
            ));
        }
    }
    if let Some(v) = max_recursion_depth {
        if !(MIN_RECURSION_DEPTH..=MAX_RECURSION_DEPTH).contains(&v) {
            return Err(format!(
                "max_recursion_depth must be between {MIN_RECURSION_DEPTH} and {MAX_RECURSION_DEPTH} (got {v})"
            ));
        }
    }
    Ok(())
}

/// Set the script resource limits with strict boundary validation.
#[tauri::command]
pub fn script_set_limits(
    state: State<PrismState>,
    max_execution_time_ms: Option<u64>,
    max_memory_bytes: Option<usize>,
    max_loop_iterations: Option<u64>,
    max_recursion_depth: Option<u32>,
) -> Result<(), String> {
    validate_script_limits(
        max_execution_time_ms,
        max_memory_bytes,
        max_loop_iterations,
        max_recursion_depth,
    )?;

    let mut lock = state.lock_inner()?;
    if let Some(v) = max_execution_time_ms {
        lock.script_limits.max_execution_time_ms = v;
    }
    if let Some(v) = max_memory_bytes {
        lock.script_limits.max_memory_bytes = v;
    }
    if let Some(v) = max_loop_iterations {
        lock.script_limits.max_loop_iterations = v;
    }
    if let Some(v) = max_recursion_depth {
        lock.script_limits.max_recursion_depth = v;
    }
    drop(lock);
    Ok(())
}

/// Grant sandbox permissions to a specific plugin.
#[tauri::command]
pub fn script_grant_plugin(
    state: State<PrismState>,
    plugin_id: String,
    allow_network: bool,
    allow_filesystem: bool,
) -> Result<(), String> {
    let mut lock = state.lock_inner()?;
    let mut plugin_config = SandboxConfig::strict();
    plugin_config.allow_network = allow_network;
    plugin_config.allow_filesystem = allow_filesystem;
    lock.sandbox_config.grant(&plugin_id, plugin_config);
    drop(lock);
    Ok(())
}

/// Revoke sandbox permissions for a specific plugin.
#[tauri::command]
pub fn script_revoke_plugin(state: State<PrismState>, plugin_id: String) -> Result<(), String> {
    let mut lock = state.lock_inner()?;
    lock.sandbox_config.revoke(&plugin_id);
    drop(lock);
    Ok(())
}

/// Check if a plugin has a specific sandbox permission.
#[tauri::command]
pub fn script_check_plugin_permission(
    state: State<PrismState>,
    plugin_id: String,
    permission: String,
) -> Result<bool, String> {
    let lock = state.lock_inner()?;
    let sp = match permission.as_str() {
        "network" => clash_prism_script::sandbox::SandboxPermission::Network,
        "filesystem" => clash_prism_script::sandbox::SandboxPermission::Filesystem,
        "child_process" => clash_prism_script::sandbox::SandboxPermission::ChildProcess,
        "workers" => clash_prism_script::sandbox::SandboxPermission::Workers,
        _ => return Err(format!("Unknown sandbox permission: {permission}")),
    };
    Ok(lock.sandbox_config.is_plugin_permitted(&plugin_id, sp))
}

/// Get the sandbox safety status.
#[tauri::command]
pub fn script_is_sandbox_safe(state: State<PrismState>) -> Result<bool, String> {
    let lock = state.lock_inner()?;
    Ok(lock.sandbox_config.is_safe())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_validate_script_limits_valid() {
        assert!(validate_script_limits(Some(5000), Some(52428800), Some(100000), Some(32)).is_ok());
        assert!(validate_script_limits(Some(MIN_EXECUTION_TIME_MS), None, None, None).is_ok());
        assert!(validate_script_limits(Some(MAX_EXECUTION_TIME_MS), None, None, None).is_ok());
        assert!(validate_script_limits(None, Some(MIN_MEMORY_BYTES), None, None).is_ok());
        assert!(validate_script_limits(None, Some(MAX_MEMORY_BYTES), None, None).is_ok());
        assert!(validate_script_limits(None, None, Some(MIN_LOOP_ITERATIONS), None).is_ok());
        assert!(validate_script_limits(None, None, Some(MAX_LOOP_ITERATIONS), None).is_ok());
        assert!(validate_script_limits(None, None, None, Some(MIN_RECURSION_DEPTH)).is_ok());
        assert!(validate_script_limits(None, None, None, Some(MAX_RECURSION_DEPTH)).is_ok());
    }

    #[test]
    fn test_validate_script_limits_zero_or_underflow() {
        assert!(validate_script_limits(Some(0), None, None, None).is_err());
        assert!(validate_script_limits(Some(99), None, None, None).is_err());
        assert!(validate_script_limits(None, Some(0), None, None).is_err());
        assert!(validate_script_limits(None, Some(1024 * 1024 - 1), None, None).is_err());
        assert!(validate_script_limits(None, None, Some(0), None).is_err());
        assert!(validate_script_limits(None, None, Some(999), None).is_err());
        assert!(validate_script_limits(None, None, None, Some(0)).is_err());
        assert!(validate_script_limits(None, None, None, Some(7)).is_err());
    }

    #[test]
    fn test_validate_script_limits_overflow() {
        assert!(validate_script_limits(Some(MAX_EXECUTION_TIME_MS + 1), None, None, None).is_err());
        assert!(validate_script_limits(None, Some(MAX_MEMORY_BYTES + 1), None, None).is_err());
        assert!(validate_script_limits(None, None, Some(MAX_LOOP_ITERATIONS + 1), None).is_err());
        assert!(validate_script_limits(None, None, None, Some(MAX_RECURSION_DEPTH + 1)).is_err());
    }
}
