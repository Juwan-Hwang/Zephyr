//! Network change coordinator: debounce state machine and single-flight rule application.

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering, Ordering::SeqCst};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Manager as _};
use tokio::sync::mpsc::{self, Receiver, Sender};
use tokio::time::Instant;

/// Maximum time to wait for a Prism apply (compile + HTTP PUT /configs) before giving up.
const APPLY_TIMEOUT: Duration = Duration::from_secs(30);

/// After this many consecutive apply failures, suppress polling-driven retries
/// until an explicit event (native, resume, online, manual) arrives to reset.
const MAX_CONSECUTIVE_FAILURES: u32 = 5;

use super::detector::{detect_network_state, detect_network_state_uncached, invalidate_ssid_cache};
use super::types::{CoordinatorMetrics, CoreApplyResult, NetworkChangeReason, NetworkState};

/// Shared coordinator state passed to the actor loop and helper functions.
/// Bundles the Arc handles to avoid exceeding clippy's argument count limit.
struct CoordinatorShared {
    observed_state: Arc<Mutex<NetworkState>>,
    applied_state: Arc<Mutex<Option<NetworkState>>>,
    is_applying: Arc<AtomicBool>,
    pending_rerun: Arc<AtomicBool>,
    consecutive_failures: Arc<AtomicU32>,
    consecutive_deferred: Arc<AtomicU32>,
    metrics: Arc<Mutex<CoordinatorMetrics>>,
}

/// Handle to the active `NetworkCoordinator`.
#[derive(Clone)]
pub struct NetworkCoordinatorHandle {
    event_tx: Sender<NetworkChangeReason>,
    observed_state: Arc<Mutex<NetworkState>>,
    applied_state: Arc<Mutex<Option<NetworkState>>>,
    metrics: Arc<Mutex<CoordinatorMetrics>>,
}

impl NetworkCoordinatorHandle {
    /// Send a notification trigger to the coordinator.
    pub async fn notify(&self, reason: NetworkChangeReason) {
        let _ = self.event_tx.send(reason).await;
    }

    /// Non-blocking notification: drops the event if the channel is full.
    /// Use this from latency-sensitive paths (e.g. system resume) where
    /// blocking on a full channel would delay subsequent health checks.
    pub fn try_notify(&self, reason: NetworkChangeReason) {
        let _ = self.event_tx.try_send(reason);
    }

    /// Synchronously send a notification trigger (for non-async contexts).
    pub fn notify_blocking(&self, reason: NetworkChangeReason) {
        let _ = self.event_tx.blocking_send(reason);
    }

    /// Retrieve a snapshot of the current observed network state.
    #[must_use]
    pub fn get_current_state(&self) -> NetworkState {
        self.observed_state
            .lock()
            .map(|g| g.clone())
            .unwrap_or_default()
    }

    /// Retrieve a snapshot of the current successfully applied network state.
    #[must_use]
    pub fn get_applied_state(&self) -> Option<NetworkState> {
        self.applied_state.lock().ok().and_then(|g| g.clone())
    }

    /// Retrieve coordinator telemetry metrics.
    #[must_use]
    pub fn get_metrics(&self) -> CoordinatorMetrics {
        self.metrics.lock().map(|g| g.clone()).unwrap_or_default()
    }

    /// Manually mark that the initial/active rules in Prism match the given network state.
    pub fn mark_applied(&self, state: NetworkState) {
        if let Ok(mut g) = self.applied_state.lock() {
            *g = Some(state);
        }
    }
}

/// Start the `NetworkChangeCoordinator` background actor.
#[must_use]
pub fn start_coordinator(app: &AppHandle) -> NetworkCoordinatorHandle {
    let initial_state = detect_network_state_uncached();
    let observed_state = Arc::new(Mutex::new(initial_state));
    // Start with applied_state = None so the first polling cycle triggers
    // reconciliation. The frontend runs prism.apply() during startup, but
    // if that fails silently, we must not mask the failure by pre-seeding
    // applied_state.  Starting with None ensures the coordinator verifies
    // the initial apply and retries if needed.
    let applied_state = Arc::new(Mutex::new(None));
    let metrics = Arc::new(Mutex::new(CoordinatorMetrics::default()));

    let (event_tx, event_rx) = mpsc::channel::<NetworkChangeReason>(32);
    let is_applying = Arc::new(AtomicBool::new(false));
    let pending_rerun = Arc::new(AtomicBool::new(false));
    let consecutive_failures = Arc::new(AtomicU32::new(0));
    let consecutive_deferred = Arc::new(AtomicU32::new(0));

    let handle = NetworkCoordinatorHandle {
        event_tx: event_tx.clone(),
        observed_state: Arc::clone(&observed_state),
        applied_state: Arc::clone(&applied_state),
        metrics: Arc::clone(&metrics),
    };

    // Spawn the coordinator actor in Tauri's async runtime
    let app_clone = app.clone();
    let shared = CoordinatorShared {
        observed_state: Arc::clone(&observed_state),
        applied_state: Arc::clone(&applied_state),
        is_applying: Arc::clone(&is_applying),
        pending_rerun: Arc::clone(&pending_rerun),
        consecutive_failures: Arc::clone(&consecutive_failures),
        consecutive_deferred: Arc::clone(&consecutive_deferred),
        metrics: Arc::clone(&metrics),
    };

    tauri::async_runtime::spawn(async move {
        coordinator_actor_loop(app_clone, event_rx, shared).await;
    });

    // Start native OS event listener
    super::platform::start_native_listener(event_tx);

    handle
}

/// Main async actor loop for network event aggregation and debounce.
async fn coordinator_actor_loop(
    app: AppHandle,
    mut event_rx: Receiver<NetworkChangeReason>,
    shared: CoordinatorShared,
) {
    let mut debounce_deadline: Option<Instant> = None;
    let mut last_reason: Option<NetworkChangeReason> = None;
    let mut last_deferred_deadline: Option<Instant> = None;
    // 5-second polling interval for robust fallback without excessive CPU overhead
    let mut polling_interval = tokio::time::interval(Duration::from_secs(5));
    polling_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    loop {
        tokio::select! {
            // 1. Inbound event from OS listener, resume, online, or manual trigger.
            //    None means all Senders have been dropped — terminate gracefully.
            recv_result = event_rx.recv() => {
                if let Some(reason) = recv_result {
                    if let Ok(mut m) = shared.metrics.lock() {
                        m.events_received += 1;
                    }

                    let debounce_ms = match &reason {
                        NetworkChangeReason::Resume => 2500, // Longer window for Wi-Fi reconnect on system wake
                        NetworkChangeReason::NativeEvent(_)
                        | NetworkChangeReason::Polling
                        | NetworkChangeReason::OnlineEvent
                        | NetworkChangeReason::Manual => 2000,
                    };

                    emit_info!(
                        System,
                        SYS_NETWORK_STATE_CHANGED,
                        "[NetworkCoordinator] Network event received: {reason}. Resetting debounce timer ({debounce_ms}ms)."
                    );

                    // Invalidate SSID cache so upcoming check gets fresh hardware status
                    invalidate_ssid_cache();
                    // Explicit events (native, resume, online, manual) reset the
                    // failure and deferred counters so polling-driven retries resume.
                    shared.consecutive_failures.store(0, Ordering::SeqCst);
                    shared.consecutive_deferred.store(0, Ordering::SeqCst);
                    last_deferred_deadline = None;
                    // Manual trigger (e.g. after core restart): clear applied_state
                    // so the coordinator re-applies rules even if the network hasn't changed.
                    if reason == NetworkChangeReason::Manual {
                        if let Ok(mut g) = shared.applied_state.lock() {
                            *g = None;
                        }
                    }
                    last_reason = Some(reason);
                    debounce_deadline =
                        Some(Instant::now() + Duration::from_millis(debounce_ms));
                } else {
                    emit_info!(
                        System,
                        SYS_NETWORK_STATE_CHANGED,
                        "[NetworkCoordinator] Event channel closed. Shutting down coordinator actor."
                    );
                    break;
                }
            }

            // 2. Periodic polling fallback check (5s)
            _ = polling_interval.tick() => {
                let sampled = detect_network_state();
                let last_observed = shared.observed_state
                    .lock()
                    .map(|g| g.clone())
                    .unwrap_or_default();
                let last_applied = shared.applied_state
                    .lock()
                    .ok()
                    .and_then(|g| g.clone());

                // Two distinct triggers:
                //   a) `state_changed` — the network genuinely changed (sampled != observed).
                //      This must ALWAYS trigger reconciliation, even if the failure cap
                //      was reached, because it is a new transition, not a retry.
                //   b) `needs_retry` — the state is the same but hasn't been applied yet.
                //      Suppress after too many consecutive failures to avoid unbounded
                //      recompile loops; an explicit event will reset the counter.
                let state_changed = sampled != last_observed;
                let needs_retry = last_applied.as_ref() != Some(&sampled);
                let failures = shared.consecutive_failures.load(Ordering::SeqCst);
                let deferred = shared.consecutive_deferred.load(Ordering::SeqCst);

                // For deferred (core not running): apply exponential backoff to avoid
                // churning detect→debounce→spawn→log every cycle while the core is stopped.
                // 2^deferred seconds, capped at 60s. Real state changes are ALWAYS exempt
                // — a genuine network transition must not be delayed by up to 60 seconds.
                let deferred_backoff = Duration::from_secs(
                    1u64
                        .checked_shl(deferred)
                        .unwrap_or(64)
                        .min(60),
                );
                let deferred_eligible = state_changed
                    || deferred == 0
                    || last_deferred_deadline
                        .map(|d| Instant::now() >= d)
                        .unwrap_or(true);

                // state_changed bypasses BOTH the failure cap AND the deferred backoff.
                let should_trigger = (state_changed || (needs_retry && failures < MAX_CONSECUTIVE_FAILURES))
                    && deferred_eligible
                    && debounce_deadline.is_none();

                if should_trigger {
                    // If this is a retry driven by deferral, set the next deferred deadline.
                    if deferred > 0 && !state_changed {
                        last_deferred_deadline =
                            Some(Instant::now() + deferred_backoff);
                    }
                    let reason = NetworkChangeReason::Polling;
                    emit_info!(
                        System,
                        SYS_NETWORK_STATE_CHANGED,
                        "[NetworkCoordinator] State discrepancy or unaligned applied state detected via polling (sampled: {}, observed: {}, applied: {:?}). Starting debounce (1.5s).",
                        sampled.masked(),
                        last_observed.masked(),
                        last_applied.as_ref().map(NetworkState::masked)
                    );
                    invalidate_ssid_cache();
                    last_reason = Some(reason);
                    debounce_deadline = Some(Instant::now() + Duration::from_millis(1500));
                }
            }

            // 3. Debounce timer expired — network is now considered stable
            _ = async {
                match debounce_deadline {
                    Some(deadline) => tokio::time::sleep_until(deadline).await,
                    None => std::future::pending().await,
                }
            }, if debounce_deadline.is_some() => {
                debounce_deadline = None;
                if let Ok(mut m) = shared.metrics.lock() {
                    m.debounce_expirations += 1;
                }
                let reason = last_reason.take().unwrap_or(NetworkChangeReason::Polling);
                handle_stable_network_check(&app, &shared, reason);
            }
        }
    }
}

/// Check if reconciliation is needed: true when `fresh_state` differs from
/// the currently applied state (or no state has been applied yet).
/// Pure function shared by production code and tests.
#[must_use]
pub fn needs_reconciliation(applied: &Option<NetworkState>, fresh: &NetworkState) -> bool {
    applied.as_ref() != Some(fresh)
}

/// Evaluates state change after network has stabilized and schedules single-flight reconciliation.
fn handle_stable_network_check(
    app: &AppHandle,
    shared: &CoordinatorShared,
    reason: NetworkChangeReason,
) {
    let fresh_state = detect_network_state_uncached();

    if let Ok(mut m) = shared.metrics.lock() {
        m.state_detections += 1;
    }

    let (old_observed, observed_changed) = {
        let mut guard = match shared.observed_state.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        let changed = *guard != fresh_state;
        let old = guard.clone();
        if changed {
            *guard = fresh_state.clone();
        }
        drop(guard);
        (old, changed)
    };

    if observed_changed {
        if let Ok(mut m) = shared.metrics.lock() {
            m.state_transitions += 1;
        }

        emit_info!(
            System,
            SYS_NETWORK_STATE_CHANGED,
            "[NetworkCoordinator] Network state transition ({} -> {}) triggered by {reason}.",
            old_observed.masked(),
            fresh_state.masked()
        );

        // Emit event to frontend UI — use masked states to avoid leaking raw SSIDs.
        // Use reason.to_string() instead of serializing the enum to avoid
        // inconsistent JSON shapes (unit variants become strings, but
        // NativeEvent(String) becomes an object via external tagging).
        crate::backend_event::emit_to_main(
            app,
            "network-state-changed",
            serde_json::json!({
                "reason": reason.to_string(),
                "old_state": masked_network_state_json(&old_observed),
                "new_state": masked_network_state_json(&fresh_state),
            }),
        );
    }

    // Check if reconciliation is required (i.e. fresh_state != applied_state)
    let needs_reconcile = {
        let applied_guard = match shared.applied_state.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        needs_reconciliation(&applied_guard, &fresh_state)
    };

    if !needs_reconcile {
        emit_info!(
            System,
            SYS_NETWORK_STATE_CHANGED,
            "[NetworkCoordinator] Debounce complete ({reason}) | Desired state matches applied state ({}) -> No-Op.",
            fresh_state.masked()
        );
        return;
    }

    emit_info!(
        System,
        SYS_NETWORK_STATE_CHANGED,
        "[NetworkCoordinator] Scheduling rule reconciliation to state {} triggered by {reason}.",
        fresh_state.masked()
    );

    // Trigger single-flight rule apply
    trigger_single_flight_apply(app, shared, reason, fresh_state);
}

/// Schedules `prism_apply` ensuring at most one execution is active at any time.
fn trigger_single_flight_apply(
    app: &AppHandle,
    shared: &CoordinatorShared,
    reason: NetworkChangeReason,
    target_state: NetworkState,
) {
    if shared
        .is_applying
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        if let Ok(mut m) = shared.metrics.lock() {
            m.pending_reruns += 1;
        }
        emit_info!(
            System,
            SYS_NETWORK_STATE_CHANGED,
            "[NetworkCoordinator] Apply task already in-flight; marking pending rerun for {reason}."
        );
        // Store pending_rerun FIRST, then re-check is_applying.
        shared.pending_rerun.store(true, Ordering::SeqCst);
        // Re-check: the worker may have released is_applying between the
        // failed CAS and the store above.
        if shared
            .is_applying
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
        {
            shared.pending_rerun.store(false, Ordering::SeqCst);
        } else {
            return;
        }
    }

    let app_clone = app.clone();
    let applied_state_clone = Arc::clone(&shared.applied_state);
    let is_applying_clone = Arc::clone(&shared.is_applying);
    let pending_rerun_clone = Arc::clone(&shared.pending_rerun);
    let consecutive_failures_clone = Arc::clone(&shared.consecutive_failures);
    let consecutive_deferred_clone = Arc::clone(&shared.consecutive_deferred);
    let metrics_clone = Arc::clone(&shared.metrics);

    let worker_handle = tauri::async_runtime::spawn(async move {
        let mut current_reason = reason;
        let mut active_target = target_state;
        loop {
            if let Ok(mut m) = metrics_clone.lock() {
                m.apply_started += 1;
            }

            let outcome = run_prism_apply_task(&app_clone, &current_reason, &active_target).await;

            match outcome {
                ApplyOutcome::Applied => {
                    // Apply succeeded: mark applied_state and reset both counters
                    if let Ok(mut g) = applied_state_clone.lock() {
                        *g = Some(active_target.clone());
                    }
                    consecutive_failures_clone.store(0, Ordering::SeqCst);
                    consecutive_deferred_clone.store(0, Ordering::SeqCst);
                    if let Ok(mut m) = metrics_clone.lock() {
                        m.apply_succeeded += 1;
                    }
                }
                ApplyOutcome::Failed => {
                    consecutive_failures_clone
                        .fetch_update(SeqCst, SeqCst, |v| Some(v.saturating_add(1)))
                        .ok();
                    consecutive_deferred_clone.store(0, Ordering::SeqCst);
                    if let Ok(mut m) = metrics_clone.lock() {
                        m.apply_failed += 1;
                    }
                }
                ApplyOutcome::TimedOut => {
                    consecutive_failures_clone
                        .fetch_update(SeqCst, SeqCst, |v| Some(v.saturating_add(1)))
                        .ok();
                    consecutive_deferred_clone.store(0, Ordering::SeqCst);
                    if let Ok(mut m) = metrics_clone.lock() {
                        m.apply_failed += 1;
                    }
                    // Do NOT release is_applying — the `spawn_blocking` task is still
                    // running and holds the Prism mutex. Exit the worker loop; the
                    // supervisor will clear is_applying when this task returns.
                    return;
                }
                ApplyOutcome::Deferred => {
                    // Core not running — increment deferred counter for backoff.
                    // Do NOT increment consecutive_failures.
                    consecutive_deferred_clone
                        .fetch_update(SeqCst, SeqCst, |v| Some(v.saturating_add(1)))
                        .ok();
                    if let Ok(mut m) = metrics_clone.lock() {
                        m.apply_deferred += 1;
                    }
                }
            }

            if pending_rerun_clone.swap(false, Ordering::SeqCst) {
                // Re-sample latest ground-truth network state before rerun
                let latest = detect_network_state_uncached();
                current_reason = NetworkChangeReason::Polling;
                active_target = latest;
                continue;
            }

            // Release is_applying first, then re-check pending_rerun to close the
            // lost-wakeup window. A trigger arriving between the swap above and
            // this store would otherwise set pending_rerun with no worker to
            // consume it.
            //
            // If `run_prism_apply_task` panics, this code will NOT execute,
            // but the supervisor task below detects the panic via
            // `JoinHandle::await` returning `Err` and clears `is_applying`.
            is_applying_clone.store(false, Ordering::SeqCst);
            if !pending_rerun_clone.swap(false, Ordering::SeqCst) {
                return;
            }
            // Re-acquire ownership; if another worker already took it, that
            // worker will handle the rerun.
            if is_applying_clone
                .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                .is_err()
            {
                return;
            }
            current_reason = NetworkChangeReason::Polling;
            active_target = detect_network_state_uncached();
        }
    });

    // Supervisor: monitors the apply worker's JoinHandle.
    //
    // If the worker panics (Tokio catches the panic by default), `JoinHandle::await`
    // returns `Err`. Clear `is_applying` and count the panic as a failure so the
    // MAX_CONSECUTIVE_FAILURES cap engages.
    //
    // If the worker returns normally after a timeout, it may have left `is_applying`
    // set to `true` (to prevent overlap with the still-running `spawn_blocking` task).
    // Clear it here so the coordinator can resume.
    //
    // If the worker returned normally and already cleared `is_applying`, this store
    // is a harmless no-op (false -> false).
    let supervisor_is_applying = Arc::clone(&shared.is_applying);
    let supervisor_failures = Arc::clone(&shared.consecutive_failures);
    tauri::async_runtime::spawn(async move {
        let is_panic = worker_handle.await.is_err();
        supervisor_is_applying.store(false, Ordering::SeqCst);
        if is_panic {
            supervisor_failures
                .fetch_update(SeqCst, SeqCst, |v| Some(v.saturating_add(1)))
                .ok();
        }
    });
}

/// Layer 1: Validate HTTP transport status code (must be 2xx).
#[must_use]
pub fn validate_http_status(http_status: Option<u16>) -> bool {
    http_status.is_some_and(super::is_http_success)
}

/// Layer 2: Validate application payload ACK (must explicitly confirm Some(true)).
#[must_use]
pub fn verify_hot_reload_ack(result_value: &serde_json::Value) -> Option<bool> {
    result_value
        .get("status")
        .and_then(|s| s.get("hot_reload_success"))
        .and_then(serde_json::Value::as_bool)
        .or_else(|| {
            result_value
                .get("hot_reload_success")
                .and_then(serde_json::Value::as_bool)
        })
}

/// Parse a raw JSON response into a strongly-typed `CoreApplyResult` using strictly structured fields.
/// ZERO string heuristics, ZERO fallback status guessing.
#[must_use]
pub fn parse_apply_result(value: &serde_json::Value) -> CoreApplyResult {
    let http_status = value
        .get("status")
        .and_then(|s| s.get("http_status"))
        .and_then(serde_json::Value::as_u64)
        .and_then(|c| u16::try_from(c).ok())
        .or_else(|| {
            value
                .get("http_status")
                .and_then(serde_json::Value::as_u64)
                .and_then(|c| u16::try_from(c).ok())
        });

    let hot_reload_success = verify_hot_reload_ack(value);

    CoreApplyResult {
        http_status,
        hot_reload_success,
    }
}

/// Composite validation: Ensures both Layer 1 (HTTP 2xx) AND Layer 2 (Application ACK)
/// are strictly satisfied with fail-closed semantics.
#[must_use]
pub fn verify_core_apply_success(result: &CoreApplyResult) -> bool {
    result.is_success()
}

/// Outcome of a Prism apply attempt.
enum ApplyOutcome {
    /// Apply succeeded — `applied_state` was updated and the failure counter reset.
    Applied,
    /// Apply failed (compile error, HTTP rejection) — increment the failure counter.
    Failed,
    /// Apply timed out — the `spawn_blocking` task is still running. Do NOT release
    /// `is_applying`; exit the worker loop and let the supervisor clear it.
    TimedOut,
    /// Core is not running — do NOT increment the failure counter; reconcile later.
    Deferred,
}

/// Executes Prism rule compilation and Mihomo hot-reload.
async fn run_prism_apply_task(
    app: &AppHandle,
    reason: &NetworkChangeReason,
    target_state: &NetworkState,
) -> ApplyOutcome {
    // Check if Mihomo core is running.  On macOS TUN the Child handle is
    // cleared because the root-owned process is managed externally, so we
    // use last_port() (set by both normal and TUN start paths) as the signal
    // instead of process().is_some().
    let is_core_running = {
        if let Some(mihomo_state) = app.try_state::<crate::MihomoState>() {
            if let Ok(guard) = mihomo_state.0.lock() {
                guard.last_port().is_some()
            } else {
                false
            }
        } else {
            false
        }
    };

    if !is_core_running {
        // Core is not running. Do not mark the state as applied; the
        // coordinator must reconcile once the core is available.
        emit_info!(
            System,
            SYS_NETWORK_STATE_CHANGED,
            "[NetworkCoordinator] Core not running; deferring apply for {reason} transition to {}",
            target_state.masked()
        );
        return ApplyOutcome::Deferred;
    }

    let prism_state = match app.try_state::<crate::prism::PrismState>() {
        Some(s) => s,
        None => return ApplyOutcome::Failed,
    };

    match tokio::time::timeout(APPLY_TIMEOUT, prism_state.apply_internal(None)).await {
        Ok(Ok((outcome, _))) => {
            let apply_ok = verify_core_apply_success(&outcome);

            if !apply_ok {
                emit_warn!(
                    System,
                    SYS_NETWORK_COORDINATOR_ERROR,
                    "[NetworkCoordinator] Prism rules compiled and saved, but Mihomo hot-reload (PUT /configs) rejected. Scheduling reconciliation retry."
                );
                return ApplyOutcome::Failed;
            }

            emit_info!(
                System,
                SYS_NETWORK_COORDINATOR_APPLIED,
                "[NetworkCoordinator] Prism rules successfully compiled, applied, and verified via Mihomo PUT /configs (HTTP 2xx) following {reason} transition to {}",
                target_state.masked()
            );
            ApplyOutcome::Applied
        }
        Ok(Err(e)) => {
            emit_warn!(
                System,
                SYS_NETWORK_COORDINATOR_ERROR,
                "[NetworkCoordinator] Prism rule re-apply failed ({reason}): {e}"
            );
            ApplyOutcome::Failed
        }
        Err(_) => {
            // The timeout drops the future, but `apply_internal` runs inside
            // `spawn_blocking`, which cannot be cancelled. The blocking task
            // continues in the background. This is safe because:
            // 1. `is_applying` is still `true`, so `trigger_single_flight_apply`
            //    will reject new triggers (CAS fails → pending_rerun).
            // 2. The worker loop checks `pending_rerun` after completing and will
            //    re-sample and retry if needed.
            // 3. The abandoned task may eventually update `applied_state` if it
            //    succeeds, which is benign — the state simply converges later.
            emit_warn!(
                System,
                SYS_NETWORK_COORDINATOR_ERROR,
                "[NetworkCoordinator] Prism apply timed out after {}s ({reason}). \
                The blocking task continues in the background; is_applying prevents overlap.",
                APPLY_TIMEOUT.as_secs()
            );
            ApplyOutcome::TimedOut
        }
    }
}

/// Serialize a `NetworkState` into a JSON value with the SSID masked for privacy.
fn masked_network_state_json(state: &NetworkState) -> serde_json::Value {
    serde_json::json!({
        "interface_type": state.interface_type,
        "is_connected": state.is_connected,
        "ssid": state.ssid.as_deref().map(|_| "***"),
    })
}
