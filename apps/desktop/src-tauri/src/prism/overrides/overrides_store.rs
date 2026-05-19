//! Override module — persistence layer.
//!
//! All meta.json mutations (`upsert_item`, `delete_item`, `reorder_items`) are
//! serialized through a global `Mutex` to prevent race conditions when multiple
//! Tauri commands run concurrently on the thread pool.

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use crate::core_manager::write_file_secure;
use crate::prism::overrides::overrides_model::{OverrideItem, OverrideLog, OverrideMeta};
use crate::prism::PrismState;

/// Global mutex that serializes all meta.json read-modify-write operations.
/// This prevents race conditions when concurrent Tauri commands (e.g. toggling
/// two overrides simultaneously) both read the same stale meta.json.
static META_LOCK: Mutex<()> = Mutex::new(());

/// Return the overrides directory, creating it if needed.
pub(crate) fn overrides_dir(state: &PrismState) -> Result<PathBuf, String> {
    state.get_overrides_dir()
}

fn meta_path(state: &PrismState) -> Result<PathBuf, String> {
    Ok(overrides_dir(state)?.join("meta.json"))
}

// ===========================================================================
// Meta CRUD
// ===========================================================================

/// Load all override items from meta.json.
pub fn load_meta(state: &PrismState) -> Result<OverrideMeta, String> {
    let _guard = META_LOCK
        .lock()
        .map_err(|e| format!("Meta lock poisoned: {e}"))?;
    let path = meta_path(state)?;
    if !path.exists() {
        return Ok(OverrideMeta::default());
    }
    let content =
        fs::read_to_string(&path).map_err(|e| format!("Failed to read meta.json: {e}"))?;
    serde_json::from_str(&content).map_err(|e| format!("Failed to parse meta.json: {e}"))
}

/// Save all override items to meta.json.
pub fn save_meta(state: &PrismState, meta: &OverrideMeta) -> Result<(), String> {
    let path = meta_path(state)?;
    let json =
        serde_json::to_string_pretty(meta).map_err(|e| format!("Failed to serialize meta: {e}"))?;
    write_file_secure(&path, &json).map_err(|e| format!("Failed to write meta.json: {e}"))
}

/// Load a single override item by ID.
pub fn load_item(state: &PrismState, id: &str) -> Result<OverrideItem, String> {
    let meta = load_meta(state)?;
    meta.items
        .into_iter()
        .find(|i| i.id == id)
        .ok_or_else(|| format!("Override item not found: {id}"))
}

/// Persist a new or updated override item.
///
/// This operation is atomic with respect to other meta.json mutations thanks
/// to the global `META_LOCK`.
pub fn upsert_item(state: &PrismState, item: OverrideItem) -> Result<(), String> {
    let _guard = META_LOCK
        .lock()
        .map_err(|e| format!("Meta lock poisoned: {e}"))?;
    let mut meta = load_meta_inner(state)?;
    if let Some(pos) = meta.items.iter().position(|i| i.id == item.id) {
        if let Some(existing) = meta.items.get_mut(pos) {
            *existing = item;
        }
    } else {
        meta.items.push(item);
    }
    save_meta_inner(state, &meta)
}

/// Remove an override item and its content file.
///
/// This operation is atomic with respect to other meta.json mutations.
pub fn delete_item(state: &PrismState, id: &str) -> Result<(), String> {
    let item;
    {
        let _guard = META_LOCK
            .lock()
            .map_err(|e| format!("Meta lock poisoned: {e}"))?;
        let mut meta = load_meta_inner(state)?;
        let pos = meta
            .items
            .iter()
            .position(|i| i.id == id)
            .ok_or_else(|| format!("Override item not found: {id}"))?;
        item = meta.items.remove(pos);
        save_meta_inner(state, &meta)?;
    }

    // Delete content file (outside lock — no contention with meta.json)
    let dir = overrides_dir(state)?;
    let content_path = dir.join(item.content_filename());
    if content_path.exists() {
        fs::remove_file(&content_path)
            .map_err(|e| format!("Failed to delete content file: {e}"))?;
    }

    // Delete log file
    let log_path = dir.join(item.log_filename());
    if log_path.exists() {
        fs::remove_file(&log_path).map_err(|e| format!("Failed to delete log file: {e}"))?;
    }

    Ok(())
}

/// Reorder override items by new ID sequence.
///
/// This operation is atomic with respect to other meta.json mutations.
pub fn reorder_items(state: &PrismState, ids: Vec<String>) -> Result<(), String> {
    let _guard = META_LOCK
        .lock()
        .map_err(|e| format!("Meta lock poisoned: {e}"))?;
    let mut meta = load_meta_inner(state)?;
    let mut new_items = Vec::with_capacity(ids.len());
    for (order, id) in ids.into_iter().enumerate() {
        if let Some(pos) = meta.items.iter().position(|i| i.id == id) {
            let mut item = meta.items.remove(pos);
            #[allow(clippy::cast_possible_truncation)]
            {
                item.order = order as u32;
            }
            new_items.push(item);
        }
    }
    // Append any items not in the reorder list (shouldn't happen, but safe)
    for mut item in meta.items {
        #[allow(clippy::cast_possible_truncation)]
        {
            item.order = new_items.len() as u32;
        }
        new_items.push(item);
    }
    meta.items = new_items;
    save_meta_inner(state, &meta)
}

// ===========================================================================
// Content file I/O
// ===========================================================================

/// Read the content file for an override item.
pub fn read_content(state: &PrismState, id: &str) -> Result<String, String> {
    let item = load_item(state, id)?;
    let dir = overrides_dir(state)?;
    let path = dir.join(item.content_filename());
    fs::read_to_string(&path).map_err(|e| format!("Failed to read content: {e}"))
}

/// Write content to an override item's content file.
pub fn write_content(state: &PrismState, id: &str, content: &str) -> Result<(), String> {
    let item = load_item(state, id)?;
    let dir = overrides_dir(state)?;
    let path = dir.join(item.content_filename());
    write_file_secure(&path, content).map_err(|e| format!("Failed to write content: {e}"))
}

// ===========================================================================
// Log persistence
// ===========================================================================

/// Save a log entry to an override item's log file (overwrites existing).
pub fn save_log(state: &PrismState, id: &str, log: &OverrideLog) -> Result<(), String> {
    let dir = overrides_dir(state)?;
    let path = dir.join(format!("{id}.log.json"));
    let json = serde_json::to_string(log).map_err(|e| format!("Failed to serialize log: {e}"))?;
    write_file_secure(&path, &json).map_err(|e| format!("Failed to write log: {e}"))
}

/// Deprecated: Use `save_log` instead. This is an alias for backward compatibility.
#[deprecated(note = "Use `save_log` instead")]
pub fn append_log(state: &PrismState, id: &str, log: &OverrideLog) -> Result<(), String> {
    save_log(state, id, log)
}

/// Read the last execution log for an override item.
pub fn read_log(state: &PrismState, id: &str) -> Result<OverrideLog, String> {
    let dir = overrides_dir(state)?;
    let path = dir.join(format!("{id}.log.json"));
    if !path.exists() {
        return Err("No log found".to_owned());
    }
    let content = fs::read_to_string(&path).map_err(|e| format!("Failed to read log: {e}"))?;
    serde_json::from_str(&content).map_err(|e| format!("Failed to parse log: {e}"))
}

// ===========================================================================
// Internal helpers (no locking — caller must hold META_LOCK)
// ===========================================================================

/// Load meta without acquiring the lock. Caller must already hold `META_LOCK`.
fn load_meta_inner(state: &PrismState) -> Result<OverrideMeta, String> {
    let path = meta_path(state)?;
    if !path.exists() {
        return Ok(OverrideMeta::default());
    }
    let content =
        fs::read_to_string(&path).map_err(|e| format!("Failed to read meta.json: {e}"))?;
    serde_json::from_str(&content).map_err(|e| format!("Failed to parse meta.json: {e}"))
}

/// Save meta without acquiring the lock. Caller must already hold `META_LOCK`.
fn save_meta_inner(state: &PrismState, meta: &OverrideMeta) -> Result<(), String> {
    let path = meta_path(state)?;
    let json =
        serde_json::to_string_pretty(meta).map_err(|e| format!("Failed to serialize meta: {e}"))?;
    write_file_secure(&path, &json).map_err(|e| format!("Failed to write meta.json: {e}"))
}
