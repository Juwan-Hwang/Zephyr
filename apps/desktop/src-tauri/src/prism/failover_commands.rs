//! Failover Commands.

#![allow(clippy::needless_pass_by_value)]

use tauri::State;

use clash_prism_core::failover::{FailoverTracker, NodeFailPolicy};

use crate::prism::PrismState;

/// Report a proxy test result to the failover engine.
///
/// If the node fails and exceeds the configured threshold, returns a
/// suggested failover action (`{ failedNode, failureCount, target }`).
/// The caller is responsible for actually switching the proxy.
#[tauri::command]
pub fn failover_report(
    state: State<PrismState>,
    node_name: String,
    success: bool,
) -> Result<Option<serde_json::Value>, String> {
    let mut lock = state.lock_inner()?;
    let action = lock.failover_tracker.report(&node_name, success);
    drop(lock);
    Ok(action.map(|a| {
        serde_json::json!({
            "failedNode": a.failed_node,
            "failureCount": a.failure_count,
            "target": a.target,
        })
    }))
}

/// Get the current failover policy.
#[tauri::command]
pub fn failover_get_policy(state: State<PrismState>) -> Result<serde_json::Value, String> {
    let p = {
        let lock = state.lock_inner()?;
        lock.failover_tracker.policy().clone()
    };
    Ok(serde_json::json!({
        "enabled": p.enabled,
        "threshold": p.threshold,
        "cooldownSecs": p.cooldown.as_secs(),
        "fallbackGroup": p.fallback_group,
    }))
}

/// Set the failover policy.
#[tauri::command]
pub fn failover_set_policy(
    state: State<PrismState>,
    enabled: Option<bool>,
    threshold: Option<u32>,
    cooldown_secs: Option<u64>,
    fallback_group: Option<String>,
) -> Result<(), String> {
    let mut lock = state.lock_inner()?;
    let mut policy = NodeFailPolicy::new();
    if let Some(e) = enabled {
        policy.enabled = e;
    }
    if let Some(t) = threshold {
        policy.threshold = t;
    }
    if let Some(c) = cooldown_secs {
        policy.cooldown = std::time::Duration::from_secs(c);
    }
    if let Some(g) = fallback_group {
        policy.fallback_group = g;
    }
    lock.failover_tracker = FailoverTracker::new(policy);
    drop(lock);
    Ok(())
}

/// Get the failure count for a specific node.
#[tauri::command]
pub fn failover_failure_count(state: State<PrismState>, node_name: String) -> Result<u32, String> {
    let lock = state.lock_inner()?;
    Ok(lock.failover_tracker.failure_count(&node_name))
}

/// Reset all failover counts.
#[tauri::command]
pub fn failover_reset(state: State<PrismState>) -> Result<(), String> {
    let mut lock = state.lock_inner()?;
    lock.failover_tracker.reset_all();
    drop(lock);
    Ok(())
}
