//! Smart Proxy Selector — IPC commands.

#![allow(clippy::needless_pass_by_value)]

use std::collections::HashMap;

use tauri::State;

use clash_prism_smart::history::NodeHistory;
use clash_prism_smart::{AdaptiveScheduler, SmartConfig, SmartScorer};

use crate::core_manager::write_file_secure;
use crate::prism::PrismState;

/// Build a `SmartScorer` from the current smart.toml config.
fn build_scorer(state: &PrismState) -> Result<SmartScorer, String> {
    let config = state.read_smart_config()?;
    Ok(SmartScorer::with_config(
        config.score.weights,
        config.score.decay,
    ))
}

/// Record a latency test result and compute the node's smart score.
///
/// Uses an EMA (Exponential Moving Average) model with configurable weights:
/// - P90 latency (default 0.4)
/// - Success rate (default 0.4)
/// - Stability / inverse stddev (default 0.2)
///
/// The result is persisted to `prism/smart_history.json`.
#[tauri::command]
pub fn smart_score(
    state: State<PrismState>,
    node_name: String,
    latency_ms: f64,
    success: bool,
) -> Result<f64, String> {
    let scorer = build_scorer(&state)?;
    let prism_dir = state.get_prism_workspace()?;

    let mut lock = state.lock_inner()?;

    // Get or create history for this node
    let history = lock
        .node_histories
        .entry(node_name.clone())
        .or_insert_with(|| NodeHistory::new(&node_name));

    // Accumulate the new record
    history.add_record(latency_ms, success);

    // Calculate score using full history
    let score = scorer.score(history);

    // Persist to disk (outside the lock)
    let histories = lock.node_histories.clone();
    drop(lock);
    super::PrismInner::persist_histories(&histories, &prism_dir);

    Ok(score)
}

#[tauri::command]
pub fn smart_config(state: State<PrismState>) -> Result<serde_json::Value, String> {
    let config = state.read_smart_config()?;
    let mut val = serde_json::to_value(config).map_err(|e| format!("Serialize failed: {e}"))?;

    // Inject `enabled` field — SmartConfig struct doesn't have it,
    // but the frontend relies on it to control score badge visibility.
    // Only inject when the key explicitly exists in smart.toml;
    // otherwise the frontend falls back to localStorage.
    let prism_dir = state.get_prism_workspace()?;
    let config_path = prism_dir.join("smart.toml");
    if config_path.exists() {
        let toml_str = std::fs::read_to_string(&config_path).unwrap_or_default();
        if let Some(line) = toml_str.lines().find(|l| l.starts_with("enabled")) {
            let enabled = line
                .strip_prefix("enabled")
                .map(str::trim)
                .and_then(|s| s.strip_prefix('='))
                .map(str::trim)
                .map(|s| s == "true")
                .unwrap_or(false);
            if let Some(obj) = val.as_object_mut() {
                obj.insert("enabled".to_owned(), serde_json::Value::Bool(enabled));
            }
        }
    }

    Ok(val)
}

#[tauri::command]
pub fn smart_config_save(
    state: State<PrismState>,
    config_json: serde_json::Value,
) -> Result<(), String> {
    // Extract `enabled` before deserializing (SmartConfig doesn't have it)
    let enabled = config_json
        .get("enabled")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);

    let config: SmartConfig =
        serde_json::from_value(config_json).map_err(|e| format!("Invalid config JSON: {e}"))?;
    let mut toml_str =
        toml::to_string_pretty(&config).map_err(|e| format!("Failed to serialize to TOML: {e}"))?;

    // Prepend `enabled = true/false` as a top-level TOML key
    toml_str = format!("enabled = {enabled}\n{toml_str}");

    let prism_dir = state.get_prism_workspace()?;
    let config_path = prism_dir.join("smart.toml");
    write_file_secure(&config_path, &toml_str)
        .map_err(|e| format!("Failed to write smart.toml: {e}"))
}

/// Calculate the next adaptive test interval based on current network quality.
///
/// Returns seconds until the next latency test. Higher `network_quality` (0–1)
/// yields longer intervals; poor quality triggers more frequent testing.
#[tauri::command]
pub fn smart_next_interval(
    state: State<PrismState>,
    network_quality: f64,
    min_interval: u64,
    max_interval: u64,
) -> Result<u64, String> {
    let smart_config = state.read_smart_config()?;
    let mut scheduler_config = smart_config.scheduler;
    // Allow caller to override min/max; fall back to smart.toml values
    scheduler_config.min_interval_secs = Some(min_interval);
    scheduler_config.max_interval_secs = Some(max_interval);
    let scheduler = AdaptiveScheduler::new(scheduler_config);
    Ok(scheduler.next_interval(network_quality))
}

/// Rank all nodes with history by their smart score.
/// Returns `Vec<{ name, score, rank }>` sorted by score descending.
#[tauri::command]
pub fn smart_rank(state: State<PrismState>) -> Result<Vec<serde_json::Value>, String> {
    let scorer = build_scorer(&state)?;

    let lock = state.lock_inner()?;

    if lock.node_histories.is_empty() {
        return Ok(vec![]);
    }

    // Compute ranking inside the lock to avoid cloning all histories
    let histories: Vec<NodeHistory> = lock.node_histories.values().cloned().collect();
    let ranking = scorer.rank(&histories);
    drop(lock);

    let result: Vec<serde_json::Value> = ranking
        .into_iter()
        .map(|(name, score, rank)| {
            serde_json::json!({
                "name": name,
                "score": score,
                "rank": rank,
            })
        })
        .collect();

    Ok(result)
}

/// Select the best node based on smart score.
/// Returns `{ name, score }` or null if no history exists.
#[tauri::command]
pub fn smart_select_best(state: State<PrismState>) -> Result<Option<serde_json::Value>, String> {
    let scorer = build_scorer(&state)?;

    let lock = state.lock_inner()?;

    if lock.node_histories.is_empty() {
        return Ok(None);
    }

    // Compute inside the lock to avoid cloning all histories
    let histories: Vec<NodeHistory> = lock.node_histories.values().cloned().collect();
    match scorer.select_best(&histories) {
        Some(node) => {
            let score = scorer.score(node);
            drop(lock);
            Ok(Some(serde_json::json!({
                "name": node.name,
                "score": score,
                "successRate": node.success_rate,
                "p90Latency": node.p90_latency,
                "stddev": node.latency_stddev,
                "recordCount": node.latency_records.len(),
            })))
        }
        None => Ok(None),
    }
}

/// Clear all smart history data.
#[tauri::command]
pub fn smart_clear_history(state: State<PrismState>) -> Result<(), String> {
    let prism_dir = state.get_prism_workspace()?;
    let mut lock = state.lock_inner()?;
    lock.node_histories.clear();
    drop(lock);
    // Write empty histories outside the lock
    super::PrismInner::persist_histories(&HashMap::new(), &prism_dir);
    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════
//  Additional Smart Commands
// ═══════════════════════════════════════════════════════════════════════

/// Score a node at a specific point in time (for historical analysis).
#[tauri::command]
pub fn smart_score_at(
    state: State<PrismState>,
    node_name: String,
    timestamp_ms: i64,
) -> Result<f64, String> {
    let lock = state.lock_inner()?;
    let found = lock.node_histories.get(&node_name).cloned();
    drop(lock);
    let history = found.ok_or_else(|| format!("No history for node '{node_name}'"))?;
    let scorer = SmartScorer::new();
    let now = chrono::DateTime::from_timestamp_millis(timestamp_ms)
        .ok_or_else(|| "Invalid timestamp".to_owned())?
        .with_timezone(&chrono::Utc);
    Ok(scorer.score_at(&history, now))
}

/// Validate the current smart config. Returns errors if any.
#[tauri::command]
pub fn smart_validate_config(state: State<PrismState>) -> Result<Vec<String>, String> {
    let config = state.read_smart_config()?;
    match config.validate() {
        Ok(()) => Ok(vec![]),
        Err(errors) => Ok(errors),
    }
}

/// Get the adaptive scheduler config.
#[tauri::command]
pub fn smart_scheduler_config(state: State<PrismState>) -> Result<serde_json::Value, String> {
    let config = state.read_smart_config()?;
    let sc = &config.scheduler;
    Ok(serde_json::json!({
        "baseIntervalSecs": sc.base_interval_secs,
        "adaptive": sc.adaptive,
        "maxIntervalSecs": sc.max_interval_secs,
        "minIntervalSecs": sc.min_interval_secs,
    }))
}

/// Trim node history to `max_records`.
#[tauri::command]
pub fn smart_trim_history(state: State<PrismState>, max_records: usize) -> Result<(), String> {
    let mut lock = state.lock_inner()?;
    let keys: Vec<String> = lock.node_histories.keys().cloned().collect();
    for key in keys {
        if let Some(history) = lock.node_histories.get_mut(&key) {
            history.trim(max_records);
        }
    }
    drop(lock);
    Ok(())
}
