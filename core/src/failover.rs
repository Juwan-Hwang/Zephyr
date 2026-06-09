//! Failover engine — pure failure tracking and policy logic.
//!
//! Migrated from `src-tauri/src/prism/failover_commands.rs`.
//! Only pure computation; IO (state persistence) stays in platform layer.

use clash_prism_core::failover::{FailoverTracker, NodeFailPolicy};

/// Failover policy configuration.
///
/// Migrated from `src-tauri/src/prism/failover_commands.rs`.
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct FailoverPolicyConfig {
    pub enabled: bool,
    pub threshold: u32,
    pub cooldown_secs: u64,
    pub fallback_group: String,
}

impl Default for FailoverPolicyConfig {
    fn default() -> Self {
        let p = NodeFailPolicy::new();
        Self {
            enabled: p.enabled,
            threshold: p.threshold,
            cooldown_secs: p.cooldown.as_secs(),
            fallback_group: p.fallback_group,
        }
    }
}

/// Result of a failover report — suggests a switch action.
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
#[derive(Debug, Clone, serde::Serialize)]
pub struct FailoverAction {
    pub failed_node: String,
    pub failure_count: u32,
    pub target: String,
}

/// Report a proxy test result and check if failover should trigger.
///
/// This is the pure logic part of `failover_report` from src-tauri.
/// Returns a FailoverAction if the node exceeded the failure threshold.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn check_failover(
    policy: FailoverPolicyConfig,
    node_name: String,
    success: bool,
    current_failure_count: u32,
) -> Option<FailoverAction> {
    let mut p = NodeFailPolicy::new();
    p.enabled = policy.enabled;
    p.threshold = policy.threshold;
    p.cooldown = std::time::Duration::from_secs(policy.cooldown_secs);
    p.fallback_group = policy.fallback_group.clone();

    let mut tracker = FailoverTracker::new(p);
    // Replay existing failure count
    for _ in 0..current_failure_count {
        let _ = tracker.report(&node_name, false);
    }
    // Report the new result
    let action = tracker.report(&node_name, success);
    action.map(|a| FailoverAction {
        failed_node: a.failed_node,
        failure_count: a.failure_count,
        target: a.target,
    })
}

/// Validate failover policy configuration.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn validate_failover_policy(config: FailoverPolicyConfig) -> Vec<String> {
    let mut errors = Vec::new();
    if config.threshold == 0 {
        errors.push("Threshold must be at least 1".to_owned());
    }
    if config.cooldown_secs == 0 {
        errors.push("Cooldown must be at least 1 second".to_owned());
    }
    errors
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn test_default_policy() {
        let p = FailoverPolicyConfig::default();
        assert!(p.enabled);
        assert!(p.threshold > 0);
    }

    #[test]
    fn test_validate_policy_valid() {
        let p = FailoverPolicyConfig::default();
        assert!(validate_failover_policy(p).is_empty());
    }

    #[test]
    fn test_validate_policy_zero_threshold() {
        let p = FailoverPolicyConfig {
            threshold: 0,
            ..Default::default()
        };
        let errors = validate_failover_policy(p);
        assert!(!errors.is_empty());
    }

    #[test]
    fn test_check_failover_no_trigger() {
        let policy = FailoverPolicyConfig::default();
        let result = check_failover(policy, "node1".to_owned(), true, 0);
        assert!(result.is_none());
    }

    #[test]
    fn test_check_failover_triggers() {
        let policy = FailoverPolicyConfig {
            threshold: 3,
            ..Default::default()
        };
        // After 3 failures, failover should trigger
        let result = check_failover(policy, "node1".to_owned(), false, 2);
        assert!(result.is_some());
        let action = result.unwrap();
        assert_eq!(action.failed_node, "node1");
    }
}
