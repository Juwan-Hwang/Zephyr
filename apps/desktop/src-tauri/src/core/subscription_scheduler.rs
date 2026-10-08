//! Subscription auto-update scheduler.
//! Runs in background and checks each subscription's individual interval.

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, Manager as _};
use tokio::time::{interval, timeout, MissedTickBehavior};

use super::core_process::ensure_app_storage;
use super::crypto::load_metadata;
use super::subscription::download_sub_inner;
#[allow(unused_imports)]
use crate::{emit_error, emit_info, emit_warn};

/// Download timeout per subscription (15 seconds).
const DOWNLOAD_TIMEOUT_SECS: u64 = 15;

/// Consecutive update passes to defer while a global-mode restore marker stays
/// unreconciled.
///
/// Deferring one pass is right: downloading on top of an unresolved restore
/// applies a configuration the user is about to be moved out of. Deferring
/// *every* pass is not — a restore that keeps failing (a non-global restore
/// leaves `orig_mode` set, so the marker is rewritten and the next pass times
/// out again) would stop scheduled and manual updates indefinitely. The limit
/// trades a bounded number of skipped passes for updates that always resume.
const MAX_RESTORE_DEFERRED_PASSES: usize = 3;

/// Scheduler state shared between the task and external control.
pub struct SchedulerState {
    /// Whether the scheduler is running.
    running: AtomicBool,
    /// Shutdown signal.
    shutdown: AtomicBool,
    /// Guard to prevent concurrent `trigger_auto_update` calls.
    trigger_guard: AtomicBool,
    /// Consecutive passes deferred because a global-mode restore marker could
    /// not be reconciled. Bounds how long a restore that keeps failing can hold
    /// updates up; see [`MAX_RESTORE_DEFERRED_PASSES`].
    restore_deferred: AtomicUsize,
}

impl SchedulerState {
    #[must_use]
    pub const fn new() -> Self {
        Self {
            running: AtomicBool::new(false),
            shutdown: AtomicBool::new(false),
            trigger_guard: AtomicBool::new(false),
            restore_deferred: AtomicUsize::new(0),
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

    /// Record a deferred pass and report how many have happened in a row.
    ///
    /// The counter is reset by [`SchedulerState::clear_restore_deferred`] as soon
    /// as reconciliation succeeds, so it counts consecutive failures.
    pub fn note_restore_deferred(&self) -> usize {
        self.restore_deferred.fetch_add(1, Ordering::SeqCst) + 1
    }

    /// Clear the consecutive-deferral count after a successful reconciliation.
    pub fn clear_restore_deferred(&self) {
        self.restore_deferred.store(0, Ordering::SeqCst);
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
    // Reconcile and restore any un-restored global mode or GLOBAL selection marker left from an abrupt shutdown.
    // Core is not running yet on startup, so CoreUnavailable is expected and silent.
    if super::subscription::reconcile_global_mode_restore(&app).await
        == super::subscription::ReconcileResult::TimedOut
    {
        emit_warn!(
            Core,
            CORE_GLOBAL_RESTORE_FAILED,
            "Timed out during global mode restore reconciliation on startup"
        );
    }

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
                    emit_info!(
                        Subscription,
                        SUB_UPDATE_SUCCESS,
                        "Updated {updated_count} subscription(s)"
                    );
                }
            }
            Err(e) => emit_error!(
                Subscription,
                SUB_UPDATE_FAILED,
                "Error checking subscriptions: {e}"
            ),
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
    // Reconcile any un-restored global mode marker before triggering new subscription downloads.
    //
    // A core that is simply not running leaves the marker for a later pass and
    // downloads must still run, so that is not an error. A *timeout* is
    // different: the marker is still on disk, which means the previous GLOBAL
    // mode and node selection may still be in force. Downloading now would apply
    // a configuration on top of a state the user is about to be moved out of, so
    // this pass is deferred — the next tick retries the reconciliation and, once
    // it succeeds, downloads proceed.
    //
    // `Busy` is not deferred: it means a fallback is in flight or the lock wait
    // expired, and that operation performs the restore itself.
    if super::subscription::reconcile_global_mode_restore_with_deadline(
        app,
        std::time::Instant::now() + std::time::Duration::from_millis(500),
    )
    .await
        == super::subscription::ReconcileResult::TimedOut
    {
        // A restore that keeps failing must not hold updates hostage. A failed
        // non-global restore leaves `orig_mode` set, so reconciliation rewrites
        // the marker and reports `TimedOut` again on the next pass — an
        // unbounded deferral would mean scheduled and manual updates stop
        // working for as long as the restore keeps failing.
        //
        // The marker is *not* cleared here: abandoning it is a decision about
        // routing, and fallback routing may still be active. Updates simply
        // resume against whatever the live core is currently doing, which is the
        // behaviour that predates the deferral, and the next pass retries the
        // reconciliation as usual.
        let deferred = state.note_restore_deferred();
        if deferred >= MAX_RESTORE_DEFERRED_PASSES {
            emit_error!(
                Core,
                CORE_GLOBAL_RESTORE_FAILED,
                "Global mode restore marker still unreconciled after {deferred} passes; \
                 proceeding with updates rather than blocking them indefinitely"
            );
        } else {
            emit_warn!(
                Core,
                CORE_GLOBAL_RESTORE_FAILED,
                "Global mode restore marker not reconciled in time; deferring this scheduled update pass"
            );
            return Err(
                "Deferred subscription update: global mode restore marker is still pending"
                    .to_owned(),
            );
        }
    } else {
        state.clear_restore_deferred();
    }

    let paths = ensure_app_storage(app)?;
    let metadata = load_metadata(&paths);

    // Read global subscription_user_agent from in-memory SettingsState (set by frontend).
    // Per-subscription UA overrides are read from metadata below.
    let global_user_agent: Option<String> = {
        let ss = app.state::<crate::SettingsState>();
        let lock = ss.0.lock();
        match lock {
            Ok(guard) => guard.subscription_user_agent.clone(),
            Err(e) => {
                emit_warn!(
                    Subscription,
                    SUB_UPDATE_FAILED,
                    "Failed to acquire settings lock for user agent: {e}"
                );
                None
            }
        }
    };

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    // Collect subscriptions that need updating, with per-subscription UA override
    let to_update: Vec<(String, String, Option<String>)> = metadata
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
            (elapsed >= interval_secs).then(|| {
                // Per-subscription UA takes precedence over global UA
                let ua = meta
                    .user_agent
                    .as_ref()
                    .filter(|s| !s.is_empty())
                    .cloned()
                    .or_else(|| global_user_agent.clone());
                (name.clone(), url.clone(), ua)
            })
        })
        .collect();

    if to_update.is_empty() {
        return Ok(0);
    }

    // Serialize downloads to avoid metadata.json write races
    // (each download_sub_inner does load_metadata + save_metadata)
    let mut updated = 0;
    for (name, url, per_sub_ua) in to_update {
        // Check shutdown before each download
        if state.should_shutdown() {
            break;
        }

        // Use timeout to prevent hanging on slow servers
        let result = timeout(
            Duration::from_secs(DOWNLOAD_TIMEOUT_SECS),
            download_sub_inner(app, url, name.clone(), per_sub_ua, true),
        )
        .await;

        match result {
            Ok(Ok(_)) => {
                emit_info!(Subscription, SUB_UPDATE_SUCCESS, "Updated {name}");
                updated += 1;
            }
            Ok(Err(e)) => {
                emit_error!(
                    Subscription,
                    SUB_UPDATE_FAILED,
                    "Failed to update {name}: {e}"
                );
            }
            Err(_) => {
                emit_warn!(Subscription, SUB_UPDATE_TIMEOUT, "Timeout updating {name}");
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

    state.running.store(true, Ordering::SeqCst);
    let result = check_and_update_subscriptions(&app, &state).await;
    state.running.store(false, Ordering::SeqCst);

    state.release_trigger();
    result
}
