//! Override module — persistence layer.
//!
//! All meta.json mutations (`create_item`, `update_item`,
//! `delete_item`, `reorder_items`) are serialized through a global `Mutex`
//! to prevent race conditions when multiple Tauri commands run concurrently
//! on the thread pool.

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
    load_meta_inner(state)
}

/// Load a single override item by ID.
pub fn load_item(state: &PrismState, id: &str) -> Result<OverrideItem, String> {
    let meta = load_meta(state)?;
    meta.items
        .into_iter()
        .find(|i| i.id == id)
        .ok_or_else(|| format!("Override item not found: {id}"))
}

/// Create a new override item with an auto-assigned order atomically.
///
/// All reads and writes to meta.json happen within a single lock acquisition,
/// eliminating the order-assignment race condition between concurrent creates.
pub fn create_item(state: &PrismState, mut item: OverrideItem) -> Result<OverrideItem, String> {
    let _guard = META_LOCK
        .lock()
        .map_err(|e| format!("Meta lock poisoned: {e}"))?;
    let mut meta = load_meta_inner(state)?;
    // Use max existing order + 1 to avoid duplicates after deletions
    item.order = meta
        .items
        .iter()
        .map(|i| i.order)
        .max()
        .map_or(0, |m| m + 1);
    meta.items.push(item.clone());
    save_meta_inner(state, &meta)?;
    Ok(item)
}

/// Update specific fields of an existing override item atomically.
///
/// The `update_fn` closure is called with the mutable item while holding the lock,
/// so no other thread can read or write meta.json until the update is complete.
pub fn update_item<F>(
    state: &PrismState,
    id: &str,
    mut update_fn: F,
) -> Result<OverrideItem, String>
where
    F: FnMut(&mut OverrideItem),
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
    let item = meta
        .items
        .get_mut(pos)
        .ok_or_else(|| format!("Override item not found: {id}"))?;
    update_fn(item);
    let updated = item.clone();
    save_meta_inner(state, &meta)?;
    Ok(updated)
}

/// Remove an override item and its content file.
///
/// This operation is atomic with respect to other meta.json mutations.
/// The entire operation (metadata removal + file deletion) is performed within
/// a single lock acquisition to prevent race conditions and ghost entries.
/// File deletion is best-effort; failures are logged but not returned as errors.
pub fn delete_item(state: &PrismState, id: &str) -> Result<(), String> {
    let _guard = META_LOCK
        .lock()
        .map_err(|e| format!("Meta lock poisoned: {e}"))?;
    let mut meta = load_meta_inner(state)?;

    let pos = meta
        .items
        .iter()
        .position(|i| i.id == id)
        .ok_or_else(|| format!("Override item not found: {id}"))?;
    let item = meta.items.remove(pos);

    // Delete files (best effort) after metadata removal
    let dir = overrides_dir(state)?;
    let _ = fs::remove_file(dir.join(item.content_filename()));
    let _ = fs::remove_file(dir.join(item.log_filename()));

    save_meta_inner(state, &meta)
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
    // Handle empty file gracefully (return default instead of error)
    if content.trim().is_empty() {
        return Ok(OverrideMeta::default());
    }
    serde_json::from_str(&content).map_err(|e| format!("Failed to parse meta.json: {e}"))
}

/// Save meta without acquiring the lock. Caller must already hold `META_LOCK`.
fn save_meta_inner(state: &PrismState, meta: &OverrideMeta) -> Result<(), String> {
    let path = meta_path(state)?;
    let json =
        serde_json::to_string_pretty(meta).map_err(|e| format!("Failed to serialize meta: {e}"))?;
    write_file_secure(&path, &json).map_err(|e| format!("Failed to write meta.json: {e}"))
}
