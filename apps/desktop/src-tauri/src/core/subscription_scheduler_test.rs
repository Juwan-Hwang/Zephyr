//! Tests for subscription auto-update scheduler.

#[cfg(test)]
mod tests {
    use super::super::subscription_scheduler::SchedulerState;

    #[test]
    fn test_scheduler_state_new() {
        let state = SchedulerState::new();
        assert!(!state.is_running());
        assert!(!state.should_shutdown());
    }

    #[test]
    fn test_scheduler_state_default() {
        let state = SchedulerState::default();
        assert!(!state.is_running());
        assert!(!state.should_shutdown());
    }

    #[test]
    fn test_scheduler_state_running() {
        let state = SchedulerState::new();
        assert!(!state.is_running());
    }

    #[test]
    fn test_scheduler_state_shutdown() {
        let state = SchedulerState::new();

        assert!(!state.should_shutdown());

        state.shutdown();
        assert!(state.should_shutdown());
    }

    #[test]
    fn test_trigger_guard() {
        let state = SchedulerState::new();

        // First acquire should succeed
        assert!(state.try_acquire_trigger());

        // Second acquire should fail (already held)
        assert!(!state.try_acquire_trigger());

        // Release and acquire again
        state.release_trigger();
        assert!(state.try_acquire_trigger());

        // Clean up
        state.release_trigger();
    }

    #[test]
    fn test_trigger_guard_is_mutex_like() {
        use std::sync::Arc;
        use std::thread;

        let state = Arc::new(SchedulerState::new());
        let state2 = Arc::clone(&state);

        // Acquire in main thread
        assert!(state.try_acquire_trigger());

        // Try to acquire from another thread should fail
        let handle = thread::spawn(move || state2.try_acquire_trigger());
        assert!(!handle.join().unwrap());

        // Release and try again
        state.release_trigger();
        let state3 = Arc::clone(&state);
        let handle2 = thread::spawn(move || {
            let ok = state3.try_acquire_trigger();
            if ok {
                state3.release_trigger();
            }
            ok
        });
        assert!(handle2.join().unwrap());
    }
}
