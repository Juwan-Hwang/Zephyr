//! Simple sliding-window rate limiter — migrated from `src-tauri/src/prism/rate_limiter.rs`.
//!
//! Entire file is pure logic with no platform dependencies.

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

        // Prune expired timestamps
        self.timestamps.retain(|&t| t > cutoff);

        if self.timestamps.len() >= self.max_calls as usize {
            // Calculate when the oldest entry expires
            let retry_after = self
                .timestamps
                .first()
                .map(|&t| t.duration_since(now) + Duration::from_nanos(1))
                .unwrap_or(Duration::from_secs(1));
            Err(retry_after)
        } else {
            self.timestamps.push(now);
            Ok(())
        }
    }
}

/// Multi-key rate limiter.
#[cfg_attr(feature = "uniffi", derive(uniffi::Object))]
pub struct RateLimiter {
    buckets: Arc<std::sync::Mutex<HashMap<String, Bucket>>>,
}

use std::sync::Arc;

#[cfg_attr(feature = "uniffi", uniffi::export)]
impl RateLimiter {
    /// Create a new rate limiter with no rules configured.
    #[cfg_attr(feature = "uniffi", uniffi::constructor)]
    pub fn new() -> Self {
        Self {
            buckets: Arc::new(std::sync::Mutex::new(HashMap::new())),
        }
    }

    /// Register a rate limit rule for a command key.
    pub fn register(&self, key: String, max_calls: u32, window_ms: u64) {
        let mut buckets = self.buckets.lock().unwrap();
        buckets.insert(
            key,
            Bucket::new(max_calls, Duration::from_millis(window_ms)),
        );
    }

    /// Check if a call to `key` is allowed. Returns true if allowed, false if rate-limited.
    /// If no rule is registered for `key`, always allows.
    pub fn check(&self, key: &str) -> bool {
        let mut buckets = self.buckets.lock().unwrap();
        if let Some(bucket) = buckets.get_mut(key) {
            bucket.check().is_ok()
        } else {
            true
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_within_limit() {
        let limiter = RateLimiter::new();
        limiter.register("test".to_owned(), 3, 1000);

        assert!(limiter.check("test"));
        assert!(limiter.check("test"));
        assert!(limiter.check("test"));
    }

    #[test]
    fn rejects_over_limit() {
        let limiter = RateLimiter::new();
        limiter.register("test".to_owned(), 2, 1000);

        assert!(limiter.check("test"));
        assert!(limiter.check("test"));
        assert!(!limiter.check("test"));
    }

    #[test]
    fn unregistered_key_always_allows() {
        let limiter = RateLimiter::new();
        assert!(limiter.check("unknown"));
    }

    #[test]
    fn different_keys_independent() {
        let limiter = RateLimiter::new();
        limiter.register("a".to_owned(), 1, 1000);

        assert!(limiter.check("a"));
        assert!(!limiter.check("a")); // a is rate-limited
        assert!(limiter.check("b")); // b is not
    }
}
