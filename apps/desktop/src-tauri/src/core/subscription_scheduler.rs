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
    /// Reset by [`SchedulerState::clear_restore_deferred`] whenever
    /// reconciliation returns something other than `TimedOut` — including
    /// `CoreUnavailable` (the core is not running; downloads still run) and
    /// `Busy` (a fallback holds the lock and restores itself). So this counts
    /// consecutive timeouts on passes that had an update due, not only full
    /// failures.
    ///
    /// Shared by the scheduler loop and the manual `trigger_auto_update` command,
    /// since both go through `check_and_update_subscriptions`: a manual "update
    /// now" while the marker stays unreconciled consumes part of the budget. That
    /// only shortens the time before updates resume, never changes what happens
    /// once the bound is passed.
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
            Err(e) => {
                // A deferred pass already reported itself at the point the
                // decision was made. Re-reporting it here would log the same
                // event twice and as an error, for something that is a
                // deliberate pause which clears on its own.
                if e != RESTORE_DEFERRAL_ERROR {
                    emit_error!(
                        Subscription,
                        SUB_UPDATE_FAILED,
                        "Error checking subscriptions: {e}"
                    );
                }
            }
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

/// Error text for a pass deferred because the global-mode restore marker is
/// still unreconciled.
///
/// Shared by the scheduler loop and the manual trigger, so the loop can tell a
/// deferral apart from a real failure and not report it a second time. The
/// manual trigger does surface it: nothing was downloaded, so answering
/// "0 updated" would be as untrue as calling it a failure.
const RESTORE_DEFERRAL_ERROR: &str =
    "Deferred subscription update: global mode restore marker is still pending";

/// Collect the subscriptions due for an update, with per-subscription UA override.
///
/// Metadata can hold two keys for the same file (a case-variant alias
/// left by an earlier overwrite), and both pass the `exists()` check
/// below on a case-insensitive volume. Group by filesystem identity
/// first and keep, per file, the record stored under the spelling
/// the file actually has on disk: an alias can carry a stale URL and
/// interval, and downloading from it would also delete the current
/// record. Only when no candidate matches the on-disk spelling is
/// the first one seen kept.
///
/// A record with no URL or a zero interval still groups: it claims
/// its file so a stale alias cannot win it — but it never downloads
/// itself, so the due-check below drops it. (Skipping such records
/// before grouping let a stale alias win the file and download over
/// the disabled profile.) The due-check then runs on the winning
/// record's values, so a stale alias can neither trigger a download
/// of its old URL nor suppress the current record's own schedule.
/// One metadata record competing for a file: (name, url, user agent,
/// auto-update interval in seconds, last update timestamp).
type SubscriptionCandidate = (String, Option<String>, Option<String>, u64, u64);

fn collect_due_subscription_updates(
    metadata: &super::crypto::ProfilesMetadata,
    profiles_dir: &std::path::Path,
    global_user_agent: &Option<String>,
    now: u64,
) -> Vec<(String, String, Option<String>)> {
    let mut by_file: std::collections::HashMap<std::path::PathBuf, SubscriptionCandidate> =
        std::collections::HashMap::new();
    // Sort by name first: HashMap iteration order is arbitrary per
    // process, and the alias fallback below keeps the first one seen,
    // so an unsorted pass would pick a different winner on different
    // runs. The lexicographically smallest alias wins deterministically.
    let mut entries: Vec<_> = metadata.configs.iter().collect();
    entries.sort_by_key(|(a, _)| *a);
    for (name, meta) in entries {
        // No URL or no interval does not skip the record here:
        // it still groups below, so it can claim its file and keep
        // a stale alias from winning it — the due-check at the end
        // drops it, so it never downloads itself.
        let url = meta.url.clone();
        let interval_secs = meta.auto_update_interval.unwrap_or(0);

        // Skip if the entry itself is gone (stale metadata entry),
        // or if it is a dangling symlink: there is no target to
        // update, and the download below would replace the link
        // itself with a regular file — `exists()` follows the link,
        // so no backup is taken and a rollback would have nothing
        // to restore.
        let entry = profiles_dir.join(name);
        if entry.symlink_metadata().is_err() || (!entry.exists() && entry.is_symlink()) {
            continue;
        }

        // Group by directory-entry identity, not by resolved target:
        // a symlink entry is its own subscription (own URL and
        // interval), so `alias.yaml -> target.yaml` must not group
        // with the target — canonicalizing both onto one key would
        // silently drop one of them, and the winner would rewrite
        // the shared file with its own URL. Regular files still
        // canonicalize, so NFC/NFD spellings of one entry group.
        let resolved = {
            let joined = profiles_dir.join(name);
            if joined
                .symlink_metadata()
                .is_ok_and(|m| m.file_type().is_symlink())
            {
                // Group by the on-disk spelling, not the requested
                // one: two case variants of one symlink entry (on a
                // case-insensitive volume the same directory entry)
                // would otherwise group apart and download the same
                // subscription twice, the second rewrite winning by
                // chance. `actual_entry_name` returns the link's own
                // spelling for a symlink, never its target's.
                profiles_dir.join(super::config_manager::actual_entry_name(profiles_dir, name))
            } else {
                joined.canonicalize().unwrap_or(joined)
            }
        };
        // Per-subscription UA takes precedence over global UA
        let ua = meta
            .user_agent
            .as_ref()
            .filter(|s| !s.is_empty())
            .cloned()
            .or_else(|| global_user_agent.clone());
        let on_disk = super::config_manager::actual_entry_name(profiles_dir, name);
        let candidate = (
            name.clone(),
            url,
            ua,
            interval_secs,
            meta.last_updated.unwrap_or(0),
        );
        match by_file.get(&resolved) {
            None => {
                by_file.insert(resolved, candidate);
            }
            Some(existing) => {
                // The on-disk spelling wins over another spelling;
                // between two spellings of the same file the first
                // one seen stays (entries are sorted by name above,
                // so the smallest spelling wins deterministically —
                // neither is more current than the other).
                if on_disk == *name && existing.0 != on_disk {
                    by_file.insert(resolved, candidate);
                }
            }
        }
    }
    by_file
        .into_values()
        .filter_map(|(name, url_opt, ua, interval_secs, last_updated)| {
            // The winner may be a disabled record (no URL, or a
            // zero interval): it claimed the file in the grouping
            // above precisely so a stale alias cannot win it — but
            // it must not itself trigger a download.
            let url = url_opt?;
            if interval_secs == 0 {
                return None;
            }
            // Only include if interval has passed
            let elapsed = now.saturating_sub(last_updated);
            (elapsed >= interval_secs).then_some((name, url, ua))
        })
        .collect()
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
    // `Busy` is not deferred: it means a fallback is in flight, and that
    // fallback performs the restore itself. An expired lock wait reports
    // `TimedOut` and is deferred like any other timeout.
    //
    // The reconciliation runs on every pass, but a timeout only counts as a
    // deferred pass when something is actually due: idle ticks must not use up
    // the deferral budget before the first update that it exists to hold back.
    let restore_timed_out = super::subscription::reconcile_global_mode_restore_with_deadline(
        app,
        std::time::Instant::now() + std::time::Duration::from_millis(500),
    )
    .await
        == super::subscription::ReconcileResult::TimedOut;
    if !restore_timed_out {
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

    // Collect subscriptions that need updating, with per-subscription UA override.
    let to_update =
        collect_due_subscription_updates(&metadata, &paths.profiles_dir, &global_user_agent, now);

    if to_update.is_empty() {
        return Ok(0);
    }

    if restore_timed_out {
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
        if deferred <= MAX_RESTORE_DEFERRED_PASSES {
            emit_warn!(
                Core,
                CORE_GLOBAL_RESTORE_FAILED,
                "Global mode restore marker not reconciled in time; deferring this update pass"
            );
            return Err(RESTORE_DEFERRAL_ERROR.to_owned());
        }
        if deferred == MAX_RESTORE_DEFERRED_PASSES + 1 {
            // Reported once, at error level, when the bound is first passed: the
            // timeout condition persists, so repeating it on every tick would
            // bury every other error in the log. The counter is deliberately not
            // reset here — it only resets on a successful reconcile — so later
            // passes take the `warn` arm and the error does not recur until the
            // state actually recovers.
            emit_error!(
                Core,
                CORE_GLOBAL_RESTORE_FAILED,
                "Global mode restore marker still unreconciled after {MAX_RESTORE_DEFERRED_PASSES} \
                 deferred passes; proceeding with updates rather than blocking them indefinitely"
            );
        } else {
            // Past the bound: updates are already proceeding every pass, so this
            // is a reminder rather than the turning point.
            emit_warn!(
                Core,
                CORE_GLOBAL_RESTORE_FAILED,
                "Global mode restore marker still unreconciled; continuing updates"
            );
        }
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

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::super::crypto::{ConfigMetadata, ProfilesMetadata};
    use super::collect_due_subscription_updates;

    fn meta_entry(
        url: Option<&str>,
        interval: Option<u64>,
        last_updated: Option<u64>,
    ) -> ConfigMetadata {
        ConfigMetadata {
            url: url.map(str::to_owned),
            auto_update_interval: interval,
            last_updated,
            ..Default::default()
        }
    }

    fn temp_profiles_dir(tag: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("zephyr_test_sched_{tag}_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn disabled_record_does_not_block_other_files() {
        let dir = temp_profiles_dir("disabled_other");
        std::fs::write(dir.join("a.yaml"), "port: 7890\n").unwrap();
        std::fs::write(dir.join("b.yaml"), "port: 7891\n").unwrap();
        let mut metadata = ProfilesMetadata::default();
        metadata
            .configs
            .insert("a.yaml".to_owned(), meta_entry(None, None, None));
        metadata.configs.insert(
            "b.yaml".to_owned(),
            meta_entry(Some("https://example.com/b"), Some(60), Some(0)),
        );
        let due = collect_due_subscription_updates(&metadata, &dir, &None, 1000);
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].0, "b.yaml");
        assert_eq!(due[0].1, "https://example.com/b");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn disabled_on_disk_record_blocks_stale_alias() {
        let dir = temp_profiles_dir("disabled_alias");
        // The on-disk spelling is the first write on a case-insensitive
        // volume; on a case-sensitive one the two spellings are
        // distinct files.
        std::fs::write(dir.join("WORK.yaml"), "port: 7890\n").unwrap();
        std::fs::write(dir.join("Work.yaml"), "port: 7890\n").unwrap();
        let same_file =
            dir.join("WORK.yaml").canonicalize().ok() == dir.join("Work.yaml").canonicalize().ok();
        let mut metadata = ProfilesMetadata::default();
        metadata
            .configs
            .insert("WORK.yaml".to_owned(), meta_entry(None, None, None));
        metadata.configs.insert(
            "Work.yaml".to_owned(),
            meta_entry(Some("https://example.com/stale"), Some(60), Some(0)),
        );
        let due = collect_due_subscription_updates(&metadata, &dir, &None, 1000);
        if same_file {
            // The disabled on-disk record claims the file, so the
            // stale alias must not trigger a download of its old URL.
            assert!(due.is_empty(), "stale alias won the file: {due:?}");
        } else {
            // Distinct files: the disabled one drops out, the enabled
            // one updates.
            assert_eq!(due.len(), 1);
            assert_eq!(due[0].0, "Work.yaml");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn on_disk_record_wins_over_stale_alias() {
        let dir = temp_profiles_dir("ondisk_wins");
        std::fs::write(dir.join("WORK.yaml"), "port: 7890\n").unwrap();
        std::fs::write(dir.join("Work.yaml"), "port: 7890\n").unwrap();
        let same_file =
            dir.join("WORK.yaml").canonicalize().ok() == dir.join("Work.yaml").canonicalize().ok();
        let mut metadata = ProfilesMetadata::default();
        metadata.configs.insert(
            "WORK.yaml".to_owned(),
            meta_entry(Some("https://example.com/current"), Some(60), Some(0)),
        );
        metadata.configs.insert(
            "Work.yaml".to_owned(),
            meta_entry(Some("https://example.com/stale"), Some(60), Some(0)),
        );
        let mut due = collect_due_subscription_updates(&metadata, &dir, &None, 1000);
        if same_file {
            assert_eq!(due.len(), 1);
            assert_eq!(due[0].0, "WORK.yaml");
            assert_eq!(due[0].1, "https://example.com/current");
        } else {
            // Distinct files: both update; the grouping order is
            // arbitrary, so sort before asserting.
            due.sort_by(|a, b| a.0.cmp(&b.0));
            assert_eq!(due.len(), 2);
            assert_eq!(due[0].0, "WORK.yaml");
            assert_eq!(due[1].0, "Work.yaml");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
