//! Core Prism Engine IPC commands.

#![allow(clippy::needless_pass_by_value)]

use tauri::State;

use clash_prism_extension::{ApplyOptions, PrismExtension, RuleInsertPosition};

use super::types::MAX_INPUT_SIZE;
use crate::core_manager::core::core_process;
use crate::prism::PrismState;

/// Helper: parse `RuleInsertPosition` from a frontend string.
pub(crate) fn parse_position(
    position: &str,
    group_id: Option<&str>,
) -> Result<RuleInsertPosition, String> {
    match position {
        "before_prism" => Ok(RuleInsertPosition::BeforePrism),
        "after_prism" => Ok(RuleInsertPosition::AfterPrism),
        "append" => Ok(RuleInsertPosition::Append),
        "after_group" => {
            let id =
                group_id.ok_or_else(|| "after_group requires a group_id parameter".to_owned())?;
            Ok(RuleInsertPosition::AfterGroup(id.to_owned()))
        }
        other => Err(format!("Unknown position: {other}")),
    }
}

/// Apply Prism rule engine changes to the running Mihomo configuration.
///
/// Compiles all `.prism.yaml` rule files, merges patches into the active
/// config, and hot-reloads via the Mihomo REST API. Runs in a blocking
/// thread pool to avoid starving other IPC commands during compilation
/// of large rule sets (65k+ rules).
///
/// Returns `{ patches, annotations, trace }` describing what was changed.
#[tauri::command]
pub async fn prism_apply(
    state: State<'_, PrismState>,
    options: Option<ApplyOptions>,
) -> Result<serde_json::Value, String> {
    let opts = options.unwrap_or_default();
    let inner = std::sync::Arc::clone(&state.inner);
    // Run in blocking thread pool to avoid occupying Tauri's async command threads.
    // This allows other invoke() calls (e.g. proxy toggle, settings) to proceed
    // while Prism compiles large rule sets.
    tokio::task::spawn_blocking(move || {
        let mut lock = inner.lock().map_err(|e| format!("Lock failed: {e}"))?;
        let ext = lock
            .extension
            .as_ref()
            .ok_or_else(|| "Prism not initialized".to_owned())?;
        let result = ext.apply(opts)?;
        // Cache trace for fast lookup by handleViewChanges / prism_get_last_trace.
        if let Ok(val) = serde_json::to_value(&result.trace) {
            lock.last_trace = val.as_array().cloned().unwrap_or_default();
        }
        drop(lock);
        serde_json::to_value(result).map_err(|e| format!("Serialize failed: {e}"))
    })
    .await
    .map_err(|e| format!("Task join failed: {e}"))?
}

#[tauri::command]
pub fn prism_status(state: State<PrismState>) -> Result<serde_json::Value, String> {
    state.with_ext(|ext| {
        serde_json::to_value(ext.status()).map_err(|e| format!("Serialize failed: {e}"))
    })
}

#[tauri::command]
pub fn prism_list_rules(state: State<PrismState>) -> Result<serde_json::Value, String> {
    state.with_ext(|ext| {
        let rules = ext.list_rules()?;
        serde_json::to_value(rules).map_err(|e| format!("Serialize failed: {e}"))
    })
}

#[tauri::command]
pub fn prism_preview_rules(
    state: State<PrismState>,
    patch_id: String,
) -> Result<serde_json::Value, String> {
    state.with_ext(|ext| {
        let diff = ext.preview_rules(&patch_id)?;
        serde_json::to_value(diff).map_err(|e| format!("Serialize failed: {e}"))
    })
}

/// Return the cached trace from the last `prism_apply` call.
/// This is a lightweight read-only operation — no recompilation.
#[tauri::command]
pub fn prism_get_last_trace(state: State<PrismState>) -> Result<serde_json::Value, String> {
    let lock = state
        .inner
        .lock()
        .map_err(|e| format!("Lock failed: {e}"))?;
    serde_json::to_value(&lock.last_trace).map_err(|e| format!("Serialize failed: {e}"))
}

#[tauri::command]
pub fn prism_is_prism_rule(
    state: State<PrismState>,
    index: usize,
) -> Result<serde_json::Value, String> {
    state.with_ext(|ext| {
        let info = ext.is_prism_rule(index)?;
        serde_json::to_value(info).map_err(|e| format!("Serialize failed: {e}"))
    })
}

#[tauri::command]
pub fn prism_insert_rule(
    state: State<PrismState>,
    rule: serde_json::Value,
    position: String,
    group_id: Option<String>,
) -> Result<usize, String> {
    state.with_ext(|ext| {
        let pos = parse_position(&position, group_id.as_deref())?;
        ext.insert_rule(rule, &pos)
    })
}

#[tauri::command]
pub fn prism_insert_rule_str(
    state: State<PrismState>,
    rule_text: String,
    position: String,
    group_id: Option<String>,
) -> Result<usize, String> {
    state.with_ext(|ext| {
        let pos = parse_position(&position, group_id.as_deref())?;
        ext.insert_rule_str(&rule_text, &pos)
    })
}

#[tauri::command]
pub fn prism_toggle_group(
    state: State<PrismState>,
    group_id: String,
    enabled: bool,
) -> Result<bool, String> {
    state.with_ext(|ext| ext.toggle_group(&group_id, enabled))
}

#[tauri::command]
pub fn prism_trace_report(
    state: State<PrismState>,
    patch_id: String,
) -> Result<serde_json::Value, String> {
    state.with_ext(|ext| {
        let trace = ext.get_trace(&patch_id)?;
        serde_json::to_value(trace).map_err(|e| format!("Serialize failed: {e}"))
    })
}

#[tauri::command]
pub fn prism_trace_report_text(state: State<PrismState>) -> Result<String, String> {
    state.with_ext(PrismExtension::trace_report)
}

#[tauri::command]
pub fn prism_validate_config(state: State<PrismState>, config: String) -> Result<bool, String> {
    if config.len() > MAX_INPUT_SIZE {
        return Err(format!(
            "Config too large ({} bytes, max {} bytes)",
            config.len(),
            MAX_INPUT_SIZE
        ));
    }
    state.with_ext(|ext| ext.validate_config(&config))
}

#[tauri::command]
pub fn prism_list_profiles(state: State<PrismState>) -> Result<serde_json::Value, String> {
    state.with_ext(|ext| {
        let profiles = ext.list_profiles()?;
        serde_json::to_value(profiles).map_err(|e| format!("Serialize failed: {e}"))
    })
}

#[tauri::command]
pub fn prism_get_core_info(state: State<PrismState>) -> Result<serde_json::Value, String> {
    state.with_ext(|ext| {
        let info = ext.get_core_info()?;
        serde_json::to_value(info).map_err(|e| format!("Serialize failed: {e}"))
    })
}

#[tauri::command]
pub fn prism_start_watching(
    state: State<PrismState>,
    debounce_ms: Option<u64>,
) -> Result<(), String> {
    state.with_ext(|ext| ext.start_watching(debounce_ms.unwrap_or(500)))
}

#[tauri::command]
pub fn prism_stop_watching(state: State<PrismState>) -> Result<(), String> {
    state.with_ext(|ext| {
        ext.stop_watching();
        Ok(())
    })
}

#[tauri::command]
pub fn prism_is_watching(state: State<PrismState>) -> Result<bool, String> {
    state.with_ext(|ext| Ok(ext.is_watching()))
}

#[tauri::command]
pub fn prism_get_stats(state: State<PrismState>) -> Result<serde_json::Value, String> {
    state.with_ext(|ext| {
        let stats = ext.get_stats()?;
        serde_json::to_value(stats).map_err(|e| format!("Serialize failed: {e}"))
    })
}

#[tauri::command]
pub fn prism_read_raw_profile(
    state: State<PrismState>,
    profile_id: String,
) -> Result<String, String> {
    state.with_ext(|ext| ext.read_raw_profile(&profile_id))
}

/// Rebuild: reset `run_config.yaml` to the original subscription profile, then
/// re-apply all patches from scratch. This ensures that toggling rule files
/// (via `__when__.profile` or `enabled: false`) produces a clean result —
/// previously appended rules from disabled/skipped patches are properly removed.
#[tauri::command]
pub async fn prism_rebuild(
    state: State<'_, PrismState>,
    options: Option<ApplyOptions>,
) -> Result<serde_json::Value, String> {
    let opts = options.unwrap_or_default();
    let inner = std::sync::Arc::clone(&state.inner);
    let app = state.app.clone();

    // Read the original profile config before entering spawn_blocking
    // (AppHandle::state() is not available inside spawn_blocking closures)
    let (raw_profile, current_secret, global_prefs) = {
        let mihomo = tauri::Manager::state::<crate::core_manager::MihomoState>(&app);
        let lock = mihomo.0.lock().map_err(|e| format!("Lock failed: {e}"))?;
        let config_path = lock
            .last_config_path()
            .ok_or_else(|| "No active profile".to_owned())?
            .to_owned();
        let secret = lock.last_secret().to_owned();
        drop(lock);

        let paths = crate::core_manager::ensure_app_storage(&app)?;
        let profile_file = paths.profiles_dir.join(&config_path);
        let content = std::fs::read_to_string(&profile_file)
            .map_err(|e| format!("Failed to read profile '{config_path}': {e}"))?;

        // Read global preferences for injection
        let settings_state = tauri::Manager::state::<crate::SettingsState>(&app);
        let settings_lock = settings_state
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let prefs = settings_lock.to_global_prefs();
        drop(settings_lock);

        (content, secret, Some(prefs))
    };

    tokio::task::spawn_blocking(move || {
        // Step 1: Write the original profile config to run_config.yaml (clean base),
        // then re-inject secret & external-controller (prepare_runtime_config does both).
        {
            let paths = crate::core_manager::ensure_app_storage(&app)?;
            let run_config_path = paths.core_dir.join("run_config.yaml");

            // Use prepare_runtime_config to inject secret + external-controller
            // into the raw profile, just like start_core does.
            let (prepared, _port) = core_process::prepare_runtime_config(
                &raw_profile,
                &current_secret,
                global_prefs.as_ref(),
            )
            .ok_or_else(|| "Failed to prepare runtime config".to_owned())?;
            crate::core_manager::write_file_secure(&run_config_path, &prepared)?;
        }

        // Step 2: Apply all patches on the clean base
        let lock = inner.lock().map_err(|e| format!("Lock failed: {e}"))?;
        let ext = lock
            .extension
            .as_ref()
            .ok_or_else(|| "Prism not initialized".to_owned())?;
        let result = ext.apply(opts)?;
        drop(lock);

        serde_json::to_value(result).map_err(|e| format!("Serialize failed: {e}"))
    })
    .await
    .map_err(|e| format!("Task join failed: {e}"))?
}
