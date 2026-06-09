//! Smart Proxy Selector — pure scoring and ranking logic.
//!
//! Migrated from `src-tauri/src/prism/smart_commands.rs`.
//! Only pure computation functions; IO (file read/write, state management) stays in platform layer.

use clash_prism_smart::config::SchedulerConfig;
use clash_prism_smart::history::NodeHistory;
use clash_prism_smart::scheduler::AdaptiveScheduler;
use clash_prism_smart::scorer::{DecayConfig, ScoreWeights, SmartScorer};

/// Result of scoring a single node.
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
#[derive(Debug, Clone, serde::Serialize)]
pub struct NodeScoreResult {
    pub node_name: String,
    pub score: f64,
}

/// Result of ranking all nodes.
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
#[derive(Debug, Clone, serde::Serialize)]
pub struct NodeRankEntry {
    pub name: String,
    pub score: f64,
    pub rank: u32,
}

/// Result of selecting the best node.
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
#[derive(Debug, Clone, serde::Serialize)]
pub struct BestNodeResult {
    pub name: String,
    pub score: f64,
    pub success_rate: f64,
    pub p90_latency: f64,
    pub stddev: f64,
    pub record_count: u64,
}

/// Score weights for the smart selector.
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
#[derive(Debug, Clone)]
pub struct SmartScoreWeights {
    pub latency_p90: f64,
    pub success_rate: f64,
    pub stability: f64,
}

impl Default for SmartScoreWeights {
    fn default() -> Self {
        let w = ScoreWeights::default();
        Self {
            latency_p90: w.latency_p90,
            success_rate: w.success_rate,
            stability: w.stability,
        }
    }
}

/// Decay factor for EMA scoring.
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
#[derive(Debug, Clone)]
pub struct SmartDecayConfig {
    pub half_life_hours: f64,
}

impl Default for SmartDecayConfig {
    fn default() -> Self {
        let d = DecayConfig::default();
        Self {
            half_life_hours: d.half_life_hours,
        }
    }
}

/// Score a node given its latency history data.
///
/// This is the pure computation part of `smart_score` from src-tauri.
/// The platform layer is responsible for persisting the result.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn compute_smart_score(
    weights: SmartScoreWeights,
    decay: SmartDecayConfig,
    latency_records: Vec<f64>,
    success_records: Vec<bool>,
) -> f64 {
    let mut history = NodeHistory::new("node");
    for (lat, success) in latency_records.iter().zip(success_records.iter()) {
        history.add_record(*lat, *success);
    }
    let scorer = SmartScorer::with_config(
        ScoreWeights {
            latency_p90: weights.latency_p90,
            success_rate: weights.success_rate,
            stability: weights.stability,
        },
        DecayConfig {
            half_life_hours: decay.half_life_hours,
        },
    );
    scorer.score(&history)
}

/// Rank multiple nodes by their smart score.
///
/// Migrated from `src-tauri/src/prism/smart_commands.rs::smart_rank()`.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn compute_smart_rank(
    weights: SmartScoreWeights,
    decay: SmartDecayConfig,
    node_names: Vec<String>,
    node_latency_records: Vec<Vec<f64>>,
    node_success_records: Vec<Vec<bool>>,
) -> Vec<NodeRankEntry> {
    let scorer = SmartScorer::with_config(
        ScoreWeights {
            latency_p90: weights.latency_p90,
            success_rate: weights.success_rate,
            stability: weights.stability,
        },
        DecayConfig {
            half_life_hours: decay.half_life_hours,
        },
    );

    let mut histories: Vec<NodeHistory> = Vec::with_capacity(node_names.len());
    for (i, name) in node_names.iter().enumerate() {
        let mut history = NodeHistory::new(name);
        if let (Some(latency), Some(success)) =
            (node_latency_records.get(i), node_success_records.get(i))
        {
            for (lat, suc) in latency.iter().zip(success.iter()) {
                history.add_record(*lat, *suc);
            }
        }
        histories.push(history);
    }

    let ranking = scorer.rank(&histories);
    ranking
        .into_iter()
        .map(|(name, score, rank)| NodeRankEntry {
            name,
            score,
            rank: u32::try_from(rank).unwrap_or(u32::MAX),
        })
        .collect()
}

/// Calculate the next adaptive test interval based on network quality.
///
/// Migrated from `src-tauri/src/prism/smart_commands.rs::smart_next_interval()`.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn compute_next_interval(
    network_quality: f64,
    min_interval_secs: u64,
    max_interval_secs: u64,
    base_interval_secs: u64,
) -> u64 {
    let scheduler_config = SchedulerConfig {
        base_interval_secs,
        adaptive: true,
        min_interval_secs: Some(min_interval_secs),
        max_interval_secs: Some(max_interval_secs),
        ..Default::default()
    };
    let scheduler = AdaptiveScheduler::new(scheduler_config);
    scheduler.next_interval(network_quality)
}

/// Validate smart config weights and decay parameters.
///
/// Migrated from `src-tauri/src/prism/smart_commands.rs::smart_validate_config()`.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn validate_smart_config(weights: SmartScoreWeights, decay: SmartDecayConfig) -> Vec<String> {
    let mut errors = Vec::new();
    if weights.latency_p90 < 0.0 || weights.success_rate < 0.0 || weights.stability < 0.0 {
        errors.push("Weights must be non-negative".to_owned());
    }
    if weights.latency_p90 + weights.success_rate + weights.stability <= 0.0 {
        errors.push("Weights must sum to a positive value".to_owned());
    }
    if decay.half_life_hours <= 0.0 {
        errors.push("Half-life must be positive".to_owned());
    }
    errors
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn test_compute_smart_score_basic() {
        let weights = SmartScoreWeights::default();
        let decay = SmartDecayConfig::default();
        let score = compute_smart_score(
            weights,
            decay,
            vec![100.0, 120.0, 110.0],
            vec![true, true, true],
        );
        assert!(score > 0.0, "Score should be positive for good node");
    }

    #[test]
    fn test_compute_smart_score_all_failures() {
        let weights = SmartScoreWeights::default();
        let decay = SmartDecayConfig::default();
        let score = compute_smart_score(
            weights,
            decay,
            vec![0.0, 0.0, 0.0],
            vec![false, false, false],
        );
        assert!(score < 0.5, "Score should be low for failing node");
    }

    #[test]
    fn test_compute_next_interval() {
        let interval = compute_next_interval(0.9, 60, 600, 120);
        assert!(
            (60..=600).contains(&interval),
            "Interval should be within bounds"
        );
    }

    #[test]
    fn test_validate_smart_config_valid() {
        let weights = SmartScoreWeights::default();
        let decay = SmartDecayConfig::default();
        assert!(validate_smart_config(weights, decay).is_empty());
    }

    #[test]
    fn test_validate_smart_config_zero_weights() {
        let weights = SmartScoreWeights {
            latency_p90: 0.0,
            success_rate: 0.0,
            stability: 0.0,
        };
        let decay = SmartDecayConfig::default();
        let errors = validate_smart_config(weights, decay);
        assert!(!errors.is_empty());
    }
}
