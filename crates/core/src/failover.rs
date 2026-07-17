//! Failover engine — data types and policy validation.
//!
//! Data types migrated from `src-tauri/src/prism/failover_commands.rs`.
//! The actual failover tracking logic (`check_failover`) is inherently stateful
//! and remains in the platform layer — it cannot be a pure function because
//! `FailoverTracker` must persist across calls for cooldown to work correctly.

use clash_prism_core::failover::NodeFailPolicy;

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

/// Validate failover policy configuration.
#[cfg_attr(feature = "uniffi", uniffi::export)]
#[must_use]
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
}
