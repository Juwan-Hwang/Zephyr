//! `KvStore` Commands.

#![allow(clippy::needless_pass_by_value)]

use tauri::State;

use crate::prism::types::{check_input_size, check_name_size};
use crate::prism::PrismState;

/// Get a value from the KV store.
#[tauri::command]
pub fn kv_get(state: State<PrismState>, key: String) -> Result<Option<serde_json::Value>, String> {
    // No size check on reads: a key stored by an older version must stay
    // readable (and deletable) however large it is.
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
    // Security: New keys are identifiers, held to the smaller name limit.
    // Reads and deletes stay unchecked so oversized keys stored by older
    // versions can still be fetched and removed.
    check_name_size(&key, "KV key")?;
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
    // No size check on deletes, for the same reason as kv_get.
    let lock = state.lock_inner()?;
    Ok(lock.kv_store.delete(&key))
}

/// List all keys in the KV store.
#[tauri::command]
pub fn kv_keys(state: State<PrismState>) -> Result<Vec<String>, String> {
    let lock = state.lock_inner()?;
    Ok(lock.kv_store.keys())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::prism::types::MAX_INPUT_SIZE;

    #[test]
    fn test_kv_key_size_validation() {
        let oversized_key = "k".repeat(MAX_INPUT_SIZE + 1);
        let res = check_input_size(&oversized_key, "KV key");
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("KV key too large"));

        let valid_key = "valid_key".to_owned();
        assert!(check_input_size(&valid_key, "KV key").is_ok());
    }

    #[test]
    fn test_kv_key_name_size_validation() {
        use crate::prism::types::{check_name_size, MAX_NAME_SIZE};

        let oversized_key = "k".repeat(MAX_NAME_SIZE + 1);
        let res = check_name_size(&oversized_key, "KV key");
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("KV key too large"));

        assert!(check_name_size("valid_key", "KV key").is_ok());
    }
}
