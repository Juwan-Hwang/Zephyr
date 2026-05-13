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
}
