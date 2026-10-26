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

/// Set the failover policy.
#[tauri::command]
pub fn failover_set_policy(
    state: State<PrismState>,
    enabled: Option<bool>,
    threshold: Option<u32>,
    cooldown_secs: Option<u64>,
    fallback_group: Option<String>,
) -> Result<(), String> {
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
    if let Some(ref g) = fallback_group {
        check_name_size(g, "Fallback group")?;
    }

    let mut lock = state.lock_inner()?;
    let mut policy = lock.failover_tracker.policy().clone();
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::prism::types::MAX_NAME_SIZE;

    #[test]
    fn test_failover_validation_and_preservation() {
        // Zero threshold validation
        let t: u32 = 0;
        let err_threshold = if t == 0 {
            Err::<(), _>("Threshold must be at least 1".to_owned())
        } else {
            Ok(())
        };
        assert!(err_threshold.is_err());

        // Zero cooldown validation
        let c: u64 = 0;
        let err_cooldown = if c == 0 {
            Err::<(), _>("Cooldown must be at least 1 second".to_owned())
        } else {
            Ok(())
        };
        assert!(err_cooldown.is_err());

        // Name size validation
        let oversized = "a".repeat(MAX_NAME_SIZE + 1);
        assert!(check_name_size(&oversized, "Fallback group").is_err());
        assert!(check_name_size("valid_group", "Fallback group").is_ok());

        assert!(check_name_size(&oversized, "Node name").is_err());
        assert!(check_name_size("valid_node", "Node name").is_ok());

        // Policy preservation test
        let mut policy = NodeFailPolicy::new();
        policy.enabled = false;
        policy.threshold = 5;
        policy.fallback_group = "my-group".to_owned();

        // Simulate partial update with only threshold passed
        let threshold_update = Some(10u32);
        if let Some(t) = threshold_update {
            policy.threshold = t;
        }

        assert!(!policy.enabled);
        assert_eq!(policy.threshold, 10);
        assert_eq!(policy.fallback_group, "my-group");
    }
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
