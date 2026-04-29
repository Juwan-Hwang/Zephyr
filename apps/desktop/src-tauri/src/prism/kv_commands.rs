//! `KvStore` Commands.

#![allow(clippy::needless_pass_by_value)]

use tauri::State;

use crate::prism::types::check_input_size;
use crate::prism::PrismState;

/// Get a value from the KV store.
#[tauri::command]
pub fn kv_get(state: State<PrismState>, key: String) -> Result<Option<serde_json::Value>, String> {
    let lock = state.lock_inner()?;
    Ok(lock.kv_store.get(&key))
}

/// Set a value in the KV store.
#[tauri::command]
pub fn kv_set(
    state: State<PrismState>,
    key: String,
    value: serde_json::Value,
) -> Result<(), String> {
    let serialized = serde_json::to_string(&value).unwrap_or_default();
    check_input_size(&serialized, "KV value")?;
    state
        .inner
        .lock()
        .map_err(|e| format!("Lock failed: {e}"))?
        .kv_store
        .set(key, value);
    Ok(())
}

/// Delete a key from the KV store.
#[tauri::command]
pub fn kv_delete(state: State<PrismState>, key: String) -> Result<bool, String> {
    let lock = state.lock_inner()?;
    Ok(lock.kv_store.delete(&key))
}

/// List all keys in the KV store.
#[tauri::command]
pub fn kv_keys(state: State<PrismState>) -> Result<Vec<String>, String> {
    let lock = state.lock_inner()?;
    Ok(lock.kv_store.keys())
}
