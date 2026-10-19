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
        self.check_at(Instant::now())
    }

    /// `check` against an explicit clock reading, so tests can drive time
    /// deterministically instead of sleeping.
    fn check_at(&mut self, now: Instant) -> Result<(), Duration> {
        let cutoff = now.checked_sub(self.window).unwrap_or_else(|| {
            self.timestamps
                .first()
                .and_then(|t| t.checked_sub(Duration::from_nanos(1)))
                .unwrap_or(now)
        });

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
                        .unwrap_or(self.window)
                        .saturating_add(Duration::from_nanos(1))
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

    /// Fixed clock origin far enough from boot that `now - window` never underflows.
    fn origin() -> Instant {
        Instant::now() + Duration::from_secs(3600)
    }

    #[test]
    fn test_sliding_window_expiration() {
        let window = Duration::from_millis(100);
        let mut bucket = Bucket::new(2, window);
        let t0 = origin();

        assert!(bucket.check_at(t0).is_ok());
        assert!(bucket.check_at(t0).is_ok());
        assert!(bucket.check_at(t0).is_err());

        // Still inside the window right up to its edge.
        assert!(bucket
            .check_at(t0 + window - Duration::from_millis(1))
            .is_err());
        // Both calls expire once the window has passed.
        assert!(bucket
            .check_at(t0 + window + Duration::from_millis(1))
            .is_ok());
    }

    #[test]
    fn test_partial_expiration_pruning() {
        let window = Duration::from_millis(300);
        let mut bucket = Bucket::new(2, window);
        let t0 = origin();
        let t1 = t0 + Duration::from_millis(150);

        assert!(bucket.check_at(t0).is_ok());
        assert!(bucket.check_at(t1).is_ok());
        assert!(bucket.check_at(t1).is_err());

        // Past t0's window but inside t1's: only the first call is pruned.
        let t2 = t0 + Duration::from_millis(350);
        assert!(bucket.check_at(t2).is_ok());
        assert!(bucket.check_at(t2).is_err());
        assert_eq!(bucket.timestamps, vec![t1, t2]);
    }

    #[test]
    fn test_retry_after_duration_calculation() {
        let window = Duration::from_millis(200);
        let mut bucket = Bucket::new(1, window);
        let t0 = origin();

        assert!(bucket.check_at(t0).is_ok());
        let err = bucket.check_at(t0 + Duration::from_millis(50)).unwrap_err();
        // The oldest call expires 150ms later; 1ns is added so the retry lands past it.
        assert_eq!(err, Duration::from_millis(150) + Duration::from_nanos(1));
    }

    #[test]
    fn test_zero_max_calls() {
        let mut limiter = RateLimiter::new();
        limiter.register("test", 0, Duration::from_secs(1));

        let err = limiter.check("test").unwrap_err();
        assert!(err > Duration::from_secs(0));
    }

    #[test]
    fn test_rapid_limit_and_recovery_cycle() {
        let window = Duration::from_millis(50);
        let mut bucket = Bucket::new(1, window);
        let mut now = origin();

        for _ in 0..3 {
            assert!(bucket.check_at(now).is_ok());
            assert!(bucket.check_at(now).is_err());
            now += window + Duration::from_millis(1);
        }
    }
}
