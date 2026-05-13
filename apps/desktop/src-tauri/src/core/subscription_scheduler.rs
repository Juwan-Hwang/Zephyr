//! Subscription auto-update scheduler.
//! Runs in background and checks each subscription's individual interval.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tauri::AppHandle;
use tokio::time::{interval, MissedTickBehavior};

use super::core_process::ensure_app_storage;
use super::crypto::{load_metadata, save_metadata};
use super::subscription::download_sub_inner;

/// Scheduler state shared between the task and external control.
pub struct SchedulerState {
    /// Whether the scheduler is running.
    running: AtomicBool,
    /// Shutdown signal.
    shutdown: AtomicBool,
}

impl SchedulerState {
    pub fn new() -> Self {
        Self {
            running: AtomicBool::new(false),
            shutdown: AtomicBool::new(false),
        }
    }

    /// Check if scheduler is currently running.
    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::Relaxed)
    }

    /// Signal the scheduler to shutdown.
    pub fn shutdown(&self) {
        self.shutdown.store(true, Ordering::Relaxed);
    }

    /// Check if shutdown was requested.
    pub fn should_shutdown(&self) -> bool {
        self.shutdown.load(Ordering::Relaxed)
    }
}

impl Default for SchedulerState {
    fn default() -> Self {
        Self::new()
    }
}

/// Start the subscription auto-update scheduler.
/// Each subscription has its own interval stored in metadata.
pub fn start_scheduler(app: AppHandle) -> Arc<SchedulerState> {
    let state = Arc::new(SchedulerState::new());

    // Spawn the scheduler task
    let state_clone = state.clone();
    let app_clone = app.clone();

    let spawn_result = tokio::runtime::Handle::try_current().map(|handle| {
        handle.spawn(async move {
            run_scheduler_loop(app_clone, state_clone).await;
        });
    });

    if let Err(e) = spawn_result {}

    state
}

/// Main scheduler loop - checks each subscription individually.
async fn run_scheduler_loop(app: AppHandle, state: Arc<SchedulerState>) {
    let mut check_interval = interval(Duration::from_secs(60)); // Check every minute
    check_interval.set_missed_tick_behavior(MissedTickBehavior::Skip);

    loop {
        if state.should_shutdown() {
            state.running.store(false, Ordering::Relaxed);
            return;
        }

        state.running.store(true, Ordering::Relaxed);

        // Check all subscriptions for updates
        match check_and_update_subscriptions(&app).await {
            Ok(updated_count) => if updated_count > 0 {},
            Err(e) => {}
        }

        // Wait for next check
        check_interval.tick().await;
    }
}

/// Check each subscription and update if its interval has passed.
async fn check_and_update_subscriptions(app: &AppHandle) -> Result<usize, String> {
    let paths = ensure_app_storage(app)?;
    let mut metadata = load_metadata(&paths);

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let mut updated = 0;
    let mut needs_save = false;

    for (name, meta) in metadata.configs.iter_mut() {
        // Skip if no URL or no interval set
        let Some(url) = &meta.url else { continue };
        let Some(interval_secs) = meta.auto_update_interval else {
            continue;
        };
        if interval_secs == 0 {
            continue;
        }

        // Calculate time since last update
        let last_updated = meta.last_updated.unwrap_or(0);
        let elapsed = now.saturating_sub(last_updated);

        // Only update if interval has passed
        if elapsed >= interval_secs {
            match download_sub_inner(app, url.clone(), name.clone(), None, false).await {
                Ok(_) => {
                    meta.last_updated = Some(now);
                    updated += 1;
                    needs_save = true;
                }
                Err(e) => {}
            }
        }
    }

    // Save updated metadata
    if needs_save {
        save_metadata(&paths, &metadata)?;
    }

    Ok(updated)
}

/// Command to get scheduler status.
#[tauri::command]
pub fn get_scheduler_status(state: tauri::State<Arc<SchedulerState>>) -> serde_json::Value {
    serde_json::json!({
        "running": state.is_running(),
    })
}

/// Command to trigger immediate update (for testing).
#[tauri::command]
pub async fn trigger_auto_update(app: AppHandle) -> Result<usize, String> {
    check_and_update_subscriptions(&app).await
}
