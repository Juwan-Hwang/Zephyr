//! Failover Commands.

#![allow(clippy::needless_pass_by_value)]

use tauri::State;

use clash_prism_core::failover::{FailoverTracker, NodeFailPolicy};

use crate::prism::types::check_name_size;
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
    check_name_size(&node_name, "Node name")?;
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

/// Validate a partial policy update and merge it onto the current policy.
/// Fields that are not provided keep their current value; a provided empty
/// fallback group clears the group. Kept pure so tests can exercise the
/// merge without a running Tauri state.
fn merge_failover_policy(
    base: &NodeFailPolicy,
    enabled: Option<bool>,
    threshold: Option<u32>,
    cooldown_secs: Option<u64>,
    fallback_group: Option<String>,
) -> Result<NodeFailPolicy, String> {
    if let Some(t) = threshold {
        if t == 0 {
            return Err("Threshold must be at least 1".to_owned());
        }
    }
    if let Some(c) = cooldown_secs {
        if c == 0 {
            return Err("Cooldown must be at least 1 second".to_owned());
        }
    }
    if let Some(g) = &fallback_group {
        check_name_size(g, "Fallback group")?;
    }

    let mut policy = base.clone();
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
    Ok(policy)
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
    let policy = merge_failover_policy(
        &lock.failover_tracker.policy().clone(),
        enabled,
        threshold,
        cooldown_secs,
        fallback_group,
    )?;
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::prism::types::MAX_NAME_SIZE;

    #[test]
    fn test_merge_failover_policy_preserves_unchanged_fields() {
        let mut base = NodeFailPolicy::new();
        base.enabled = false;
        base.threshold = 5;
        base.fallback_group = "my-group".to_owned();

        // Partial update: only the threshold changes.
        let merged =
            merge_failover_policy(&base, None, Some(10), None, None).expect("valid update");
        assert!(!merged.enabled);
        assert_eq!(merged.threshold, 10);
        assert_eq!(merged.fallback_group, "my-group");

        // A provided empty fallback group clears the group.
        let cleared = merge_failover_policy(&base, None, None, None, Some(String::new()))
            .expect("clearing update");
        assert_eq!(cleared.fallback_group, "");

        // Zero values and oversized names are rejected by the merge itself.
        assert!(merge_failover_policy(&base, None, Some(0), None, None).is_err());
        assert!(merge_failover_policy(&base, None, None, Some(0), None).is_err());
        let oversized = "a".repeat(MAX_NAME_SIZE + 1);
        assert!(merge_failover_policy(&base, None, None, None, Some(oversized)).is_err());
        assert!(
            merge_failover_policy(&base, None, None, None, Some("valid_group".to_owned())).is_ok()
        );
    }
}
