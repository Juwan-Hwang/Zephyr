//! Trace Advanced Commands.

#![allow(clippy::needless_pass_by_value)]

use tauri::State;

use crate::prism::PrismState;

/// Get trace statistics for the last compilation.
#[tauri::command]
pub fn trace_statistics(state: State<PrismState>) -> Result<serde_json::Value, String> {
    state.with_ext(|ext| {
        let stats = ext.get_stats()?;
        serde_json::to_value(stats).map_err(|e| format!("Serialize failed: {e}"))
    })
}

/// Get trace statistics.
#[tauri::command]
pub fn trace_filter_by_source(state: State<PrismState>) -> Result<serde_json::Value, String> {
    state.with_ext(|ext| {
        let stats = ext.get_stats()?;
        serde_json::to_value(stats).map_err(|e| format!("Serialize failed: {e}"))
    })
}
