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
    // Security: Keys are identifiers, held to the smaller name limit — but
    // only when creating one. Updating the value of a key that already
    // exists (however oversized a name an older version stored) stays
    // allowed, like reads and deletes. The existence check and the write
    // share one lock, so a concurrent delete cannot slip a new oversized
    // key past the check.
    let serialized = serde_json::to_string(&value).unwrap_or_default();
    check_input_size(&serialized, "KV value")?;
    let lock = state.lock_inner()?;
    if lock.kv_store.get(&key).is_none() {
        check_name_size(&key, "KV key")?;
    }
    lock.kv_store.set(key, value);
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
    fn test_kv_value_size_validation() {
        // kv_set validates the serialized value with the text-size limit;
        // keys are covered by test_kv_key_name_size_validation below.
        let oversized_value = "v".repeat(MAX_INPUT_SIZE + 1);
        let res = check_input_size(&oversized_value, "KV value");
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("KV value too large"));

        assert!(check_input_size("valid_value", "KV value").is_ok());
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
