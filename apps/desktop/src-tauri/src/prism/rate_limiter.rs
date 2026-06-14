//! Simple sliding-window rate limiter for IPC commands.
//!
//! Tracks call timestamps per command key and rejects calls that exceed
//! the configured limit within the time window.

use std::collections::HashMap;
use std::time::{Duration, Instant};

/// Per-key rate limit configuration.
struct Bucket {
    /// Maximum number of calls allowed within `window`.
    max_calls: u32,
    /// Sliding time window.
    window: Duration,
    /// Timestamps of recent calls (kept sorted, pruned on check).
    timestamps: Vec<Instant>,
}

impl Bucket {
    const fn new(max_calls: u32, window: Duration) -> Self {
        Self {
            max_calls,
            window,
            timestamps: Vec::new(),
        }
    }

    /// Returns `Ok(())` if the call is allowed, `Err(retry_after)` if rate-limited.
    fn check(&mut self) -> Result<(), Duration> {
        let now = Instant::now();
        let cutoff = now - self.window;

        let first_valid = self.timestamps.partition_point(|&t| t <= cutoff);
        if first_valid > 0 {
            self.timestamps.drain(..first_valid);
        }

        if self.timestamps.len() >= self.max_calls as usize {
            // Calculate when the oldest entry expires
            let retry_after = self
                .timestamps
                .first()
                .map(|&t| {
                    t.checked_add(self.window)
                        .and_then(|t_limit| t_limit.checked_duration_since(now))
                        .unwrap_or_default()
                        + Duration::from_nanos(1)
                })
                .unwrap_or(Duration::from_secs(1));
            Err(retry_after)
        } else {
            self.timestamps.push(now);
            Ok(())
        }
    }
}

/// Multi-key rate limiter.
pub struct RateLimiter {
    buckets: HashMap<&'static str, Bucket>,
}

impl RateLimiter {
    /// Create a new rate limiter with no rules configured.
    pub fn new() -> Self {
        Self {
            buckets: HashMap::new(),
        }
    }

    /// Register a rate limit rule for a command key.
    pub fn register(&mut self, key: &'static str, max_calls: u32, window: Duration) {
        self.buckets.insert(key, Bucket::new(max_calls, window));
    }

    /// Check if a call to `key` is allowed. Returns `Ok(())` or `Err(retry_after)`.
    /// If no rule is registered for `key`, always allows.
    pub fn check(&mut self, key: &str) -> Result<(), Duration> {
        if let Some(bucket) = self.buckets.get_mut(key) {
            bucket.check()
        } else {
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_within_limit() {
        let mut limiter = RateLimiter::new();
        limiter.register("test", 3, Duration::from_secs(1));

        assert!(limiter.check("test").is_ok());
        assert!(limiter.check("test").is_ok());
        assert!(limiter.check("test").is_ok());
    }

    #[test]
    fn rejects_over_limit() {
        let mut limiter = RateLimiter::new();
        limiter.register("test", 2, Duration::from_secs(1));

        assert!(limiter.check("test").is_ok());
        assert!(limiter.check("test").is_ok());
        assert!(limiter.check("test").is_err());
    }

    #[test]
    fn unregistered_key_always_allows() {
        let mut limiter = RateLimiter::new();
        assert!(limiter.check("unknown").is_ok());
    }

    #[test]
    fn different_keys_independent() {
        let mut limiter = RateLimiter::new();
        limiter.register("a", 1, Duration::from_secs(1));

        assert!(limiter.check("a").is_ok());
        assert!(limiter.check("a").is_err()); // a is rate-limited
        assert!(limiter.check("b").is_ok()); // b is not
    }
}
