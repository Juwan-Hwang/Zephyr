//! Script Engine — IPC commands (sandbox, limits, permissions).

#![allow(clippy::needless_pass_by_value)]

use tauri::State;

use clash_prism_script::{SandboxConfig, ScriptContext, ScriptRuntime};

use crate::prism::types::check_input_size;
use crate::prism::PrismState;

#[tauri::command]
pub fn script_execute(
    state: State<PrismState>,
    script: String,
    script_name: String,
) -> Result<serde_json::Value, String> {
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

/// Set the sandbox configuration.
#[tauri::command]
pub fn script_set_sandbox(
    state: State<PrismState>,
    allow_network: bool,
    allow_filesystem: bool,
    allow_child_process: bool,
    allow_workers: bool,
) -> Result<(), String> {
    let mut lock = state.lock_inner()?;
    lock.sandbox_config.allow_network = allow_network;
    lock.sandbox_config.allow_filesystem = allow_filesystem;
    lock.sandbox_config.allow_child_process = allow_child_process;
    lock.sandbox_config.allow_workers = allow_workers;
    drop(lock);
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

/// Set the script resource limits.
#[tauri::command]
pub fn script_set_limits(
    state: State<PrismState>,
    max_execution_time_ms: Option<u64>,
    max_memory_bytes: Option<usize>,
    max_loop_iterations: Option<u64>,
    max_recursion_depth: Option<u32>,
) -> Result<(), String> {
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
