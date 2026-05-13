//! Subscription auto-update scheduler.
//! Runs in background and checks each subscription's individual interval.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, Manager as _};
use tokio::time::{interval, timeout, MissedTickBehavior};

use super::core_process::ensure_app_storage;
use super::crypto::load_metadata;
use super::subscription::download_sub_inner;

/// Download timeout per subscription (15 seconds).
const DOWNLOAD_TIMEOUT_SECS: u64 = 15;

/// Scheduler state shared between the task and external control.
pub struct SchedulerState {
    /// Whether the scheduler is running.
    running: AtomicBool,
    /// Shutdown signal.
    shutdown: AtomicBool,
    /// Guard to prevent concurrent `trigger_auto_update` calls.
    trigger_guard: AtomicBool,
}

impl SchedulerState {
    #[must_use]
    pub const fn new() -> Self {
        Self {
            running: AtomicBool::new(false),
            shutdown: AtomicBool::new(false),
            trigger_guard: AtomicBool::new(false),
        }
    }

    /// Check if scheduler is currently running.
    #[must_use]
    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }

    /// Signal the scheduler to shutdown.
    pub fn shutdown(&self) {
        self.shutdown.store(true, Ordering::SeqCst);
    }

    /// Check if shutdown was requested.
    #[must_use]
    pub fn should_shutdown(&self) -> bool {
        self.shutdown.load(Ordering::SeqCst)
    }

    /// Try to acquire trigger guard. Returns true if acquired.
    pub fn try_acquire_trigger(&self) -> bool {
        self.trigger_guard
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
    }

    /// Release trigger guard.
    pub fn release_trigger(&self) {
        self.trigger_guard.store(false, Ordering::SeqCst);
    }
}

impl Default for SchedulerState {
    fn default() -> Self {
        Self::new()
    }
}

/// Start the subscription auto-update scheduler.
/// Each subscription has its own interval stored in metadata.
#[must_use]
pub fn start_scheduler(app: AppHandle) -> Arc<SchedulerState> {
    let state = Arc::new(SchedulerState::new());

    // Spawn the scheduler task using Tauri's async runtime (always available)
    let state_clone = Arc::clone(&state);

    tauri::async_runtime::spawn(async move {
        run_scheduler_loop(app, state_clone).await;
    });

    state
}

/// Main scheduler loop - checks each subscription individually.
async fn run_scheduler_loop(app: AppHandle, state: Arc<SchedulerState>) {
    let mut check_interval = interval(Duration::from_secs(60)); // Check every minute
    check_interval.set_missed_tick_behavior(MissedTickBehavior::Skip);

    // Wait for first tick to avoid immediate execution on startup
    // (interval's first tick completes immediately)
    check_interval.tick().await;

    loop {
        // Check shutdown before starting work
        if state.should_shutdown() {
            state.running.store(false, Ordering::SeqCst);
            return;
        }

        // Acquire trigger guard to prevent concurrent execution with trigger_auto_update
        if !state.try_acquire_trigger() {
            // Another instance is running, skip this cycle
            check_interval.tick().await;
            continue;
        }

        state.running.store(true, Ordering::SeqCst);

        // Check all subscriptions for updates
        match check_and_update_subscriptions(&app, &state).await {
            Ok(updated_count) => {
                if updated_count > 0 {
                    println!("[Scheduler] Updated {updated_count} subscription(s)");
                }
            }
            Err(e) => eprintln!("[Scheduler] Error checking subscriptions: {e}"),
        }

        state.running.store(false, Ordering::SeqCst);

        // Release trigger guard
        state.release_trigger();

        // Check shutdown again before waiting
        if state.should_shutdown() {
            state.running.store(false, Ordering::SeqCst);
            return;
        }

        // Wait for next check
        check_interval.tick().await;
    }
}

/// Check each subscription and update if its interval has passed.
/// Downloads are serialized to avoid metadata.json write races.
async fn check_and_update_subscriptions(
    app: &AppHandle,
    state: &Arc<SchedulerState>,
) -> Result<usize, String> {
    let paths = ensure_app_storage(app)?;
    let metadata = load_metadata(&paths);

    // Read subscription_user_agent from in-memory SettingsState (set by frontend)
    let user_agent: Option<String> = {
        let settings_state = app.state::<crate::SettingsState>();
        settings_state
            .0
            .lock()
            .ok()
            .and_then(|guard| guard.subscription_user_agent.clone())
    };

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    // Collect subscriptions that need updating
    let to_update: Vec<(String, String)> = metadata
        .configs
        .iter()
        .filter_map(|(name, meta)| {
            // Skip if no URL or no interval set
            let url = meta.url.as_ref()?;
            let interval_secs = meta.auto_update_interval.filter(|&s| s > 0)?;

            // Skip if file doesn't exist (stale metadata entry)
            if !paths.profiles_dir.join(name).exists() {
                return None;
            }

            // Calculate time since last update
            let last_updated = meta.last_updated.unwrap_or(0);
            let elapsed = now.saturating_sub(last_updated);

            // Only include if interval has passed
            (elapsed >= interval_secs).then(|| (name.clone(), url.clone()))
        })
        .collect();

    if to_update.is_empty() {
        return Ok(0);
    }

    // Serialize downloads to avoid metadata.json write races
    // (each download_sub_inner does load_metadata + save_metadata)
    let mut updated = 0;
    for (name, url) in to_update {
        // Check shutdown before each download
        if state.should_shutdown() {
            break;
        }

        // Use timeout to prevent hanging on slow servers
        let result = timeout(
            Duration::from_secs(DOWNLOAD_TIMEOUT_SECS),
            download_sub_inner(app, url, name.clone(), user_agent.clone(), true),
        )
        .await;

        match result {
            Ok(Ok(_)) => {
                println!("[Scheduler] Updated {name}");
                updated += 1;
            }
            Ok(Err(e)) => {
                eprintln!("[Scheduler] Failed to update {name}: {e}");
            }
            Err(_) => {
                eprintln!("[Scheduler] Timeout updating {name}");
            }
        }
    }

    Ok(updated)
}

/// Command to get scheduler status.
#[tauri::command]
#[must_use]
#[allow(clippy::needless_pass_by_value)]
pub fn get_scheduler_status(state: tauri::State<Arc<SchedulerState>>) -> serde_json::Value {
    serde_json::json!({
        "running": state.is_running(),
    })
}

/// Command to trigger immediate update (for testing).
/// Rate-limited: only one concurrent call allowed.
#[tauri::command]
pub async fn trigger_auto_update(
    app: AppHandle,
    state: tauri::State<'_, Arc<SchedulerState>>,
) -> Result<usize, String> {
    // Rate limit: only one concurrent trigger allowed
    if !state.try_acquire_trigger() {
        return Err("Auto-update already in progress".to_owned());
    }

    let result = check_and_update_subscriptions(&app, &state).await;

    state.release_trigger();
    result
}
