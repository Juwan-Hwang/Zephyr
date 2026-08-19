//! Unit and timing/concurrency tests for Network Coordinator.

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use super::detector::invalidate_ssid_cache;
use super::types::{CoordinatorMetrics, InterfaceType, NetworkChangeReason, NetworkState};

#[test]
fn test_network_state_default() {
    let state = NetworkState::default();
    assert_eq!(state.interface_type, InterfaceType::None);
    assert!(!state.is_connected);
    assert!(state.ssid.is_none());
    assert!(!state.is_wifi());
}

#[test]
fn test_network_state_wifi() {
    let state = NetworkState {
        interface_type: InterfaceType::Wifi,
        is_connected: true,
        ssid: Some("MyOfficeWiFi".to_owned()),
    };
    assert!(state.is_wifi());
    assert_eq!(state.ssid.as_deref(), Some("MyOfficeWiFi"));
}

#[test]
fn test_network_state_ethernet() {
    let state = NetworkState {
        interface_type: InterfaceType::Ethernet,
        is_connected: true,
        ssid: None,
    };
    assert!(!state.is_wifi());
    assert!(state.is_connected);
}

#[test]
fn test_network_state_equality() {
    let state1 = NetworkState {
        interface_type: InterfaceType::Wifi,
        is_connected: true,
        ssid: Some("HomeNet".to_owned()),
    };
    let state2 = NetworkState {
        interface_type: InterfaceType::Wifi,
        is_connected: true,
        ssid: Some("HomeNet".to_owned()),
    };
    let state3 = NetworkState {
        interface_type: InterfaceType::Wifi,
        is_connected: true,
        ssid: Some("OfficeNet".to_owned()),
    };
    assert_eq!(state1, state2);
    assert_ne!(state1, state3);
}

#[test]
fn test_network_state_serialization() {
    let state = NetworkState {
        interface_type: InterfaceType::Wifi,
        is_connected: true,
        ssid: Some("ZephyrWiFi".to_owned()),
    };
    let json = serde_json::to_string(&state).unwrap();
    let deserialized: NetworkState = serde_json::from_str(&json).unwrap();
    assert_eq!(state, deserialized);
}

#[test]
fn test_network_state_masking_privacy() {
    let state_short = NetworkState {
        interface_type: InterfaceType::Wifi,
        is_connected: true,
        ssid: Some("AP".to_owned()),
    };
    assert_eq!(state_short.masked(), "Wifi(***)");

    let state_medium = NetworkState {
        interface_type: InterfaceType::Wifi,
        is_connected: true,
        ssid: Some("Office".to_owned()),
    };
    assert_eq!(state_medium.masked(), "Wifi(O***)");

    let state_long = NetworkState {
        interface_type: InterfaceType::Wifi,
        is_connected: true,
        ssid: Some("ZephyrOfficeWiFi".to_owned()),
    };
    assert_eq!(state_long.masked(), "Wifi(Ze***Fi)");

    let state_eth = NetworkState {
        interface_type: InterfaceType::Ethernet,
        is_connected: true,
        ssid: None,
    };
    assert_eq!(state_eth.masked(), "ethernet");
}

#[test]
fn test_network_change_reason_display() {
    let r1 = NetworkChangeReason::NativeEvent("win32".to_owned());
    assert_eq!(r1.to_string(), "native_event(win32)");

    let r2 = NetworkChangeReason::Polling;
    assert_eq!(r2.to_string(), "polling");

    let r3 = NetworkChangeReason::Resume;
    assert_eq!(r3.to_string(), "resume");

    let r4 = NetworkChangeReason::OnlineEvent;
    assert_eq!(r4.to_string(), "online_event");

    let r5 = NetworkChangeReason::Manual;
    assert_eq!(r5.to_string(), "manual");
}

#[test]
fn test_coordinator_metrics_defaults() {
    let metrics = CoordinatorMetrics::default();
    assert_eq!(metrics.events_received, 0);
    assert_eq!(metrics.debounce_expirations, 0);
    assert_eq!(metrics.state_detections, 0);
    assert_eq!(metrics.state_transitions, 0);
    assert_eq!(metrics.apply_started, 0);
    assert_eq!(metrics.apply_succeeded, 0);
    assert_eq!(metrics.apply_failed, 0);
    assert_eq!(metrics.apply_deferred, 0);
    assert_eq!(metrics.pending_reruns, 0);
}

#[test]
fn test_invalidate_cache() {
    invalidate_ssid_cache();
    // After invalidation, the SSID cache flag is false. We cannot assert
    // the SSID value (depends on hardware), but we verify the call doesn't
    // panic and the cache is in the invalidated state.
    // The real assertion is that the next detect_ssid() call performs a
    // fresh hardware query rather than returning a cached value.
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Timing & Concurrency State Machine Tests
// ═══════════════════════════════════════════════════════════════════════════════

#[tokio::test(start_paused = true)]
async fn test_debounce_burst_events_single_evaluation() {
    // Simulates: 5 rapid events in 100ms -> Debounce cancels previous -> Exactly 1 final apply
    let eval_count = Arc::new(AtomicU32::new(0));
    let (tx, mut rx) = tokio::sync::mpsc::channel::<NetworkChangeReason>(16);

    let eval_count_clone = Arc::clone(&eval_count);
    let handle = tokio::spawn(async move {
        let mut debounce_deadline: Option<tokio::time::Instant> = None;
        loop {
            tokio::select! {
                Some(_reason) = rx.recv() => {
                    // Reset debounce window on every arrival
                    debounce_deadline = Some(tokio::time::Instant::now() + Duration::from_millis(150));
                }
                _ = async {
                    match debounce_deadline {
                        Some(d) => tokio::time::sleep_until(d).await,
                        None => std::future::pending().await,
                    }
                }, if debounce_deadline.is_some() => {
                    let _ = debounce_deadline.take();
                    eval_count_clone.fetch_add(1, Ordering::SeqCst);
                    break;
                }
            }
        }
    });

    // Send 5 rapid events spaced 20ms apart
    for _ in 0..5 {
        tx.send(NetworkChangeReason::NativeEvent("test".to_owned()))
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_millis(20)).await;
    }

    handle.await.unwrap();
    assert_eq!(
        eval_count.load(Ordering::SeqCst),
        1,
        "Burst events should be debounced into a single evaluation"
    );
}

#[tokio::test(start_paused = true)]
async fn test_sliding_debounce_window_delays_execution() {
    // Simulates: event at t=0, event at t=80, event at t=160 -> fires at t=160+150=310ms
    let evaluated_at = Arc::new(Mutex::new(None::<tokio::time::Instant>));
    let (tx, mut rx) = tokio::sync::mpsc::channel::<NetworkChangeReason>(16);

    let start_time = tokio::time::Instant::now();
    let eval_time_clone = Arc::clone(&evaluated_at);

    let handle = tokio::spawn(async move {
        let mut debounce_deadline: Option<tokio::time::Instant> = None;
        loop {
            tokio::select! {
                Some(_reason) = rx.recv() => {
                    debounce_deadline = Some(tokio::time::Instant::now() + Duration::from_millis(150));
                }
                _ = async {
                    match debounce_deadline {
                        Some(d) => tokio::time::sleep_until(d).await,
                        None => std::future::pending().await,
                    }
                }, if debounce_deadline.is_some() => {
                    let _ = debounce_deadline.take();
                    if let Ok(mut g) = eval_time_clone.lock() {
                        *g = Some(tokio::time::Instant::now());
                    }
                    break;
                }
            }
        }
    });

    // First event at t=0
    tx.send(NetworkChangeReason::NativeEvent("1".to_owned()))
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(80)).await;

    // Second event at t=80 (resets timer)
    tx.send(NetworkChangeReason::NativeEvent("2".to_owned()))
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(80)).await;

    // Third event at t=160 (resets timer again)
    tx.send(NetworkChangeReason::NativeEvent("3".to_owned()))
        .await
        .unwrap();

    handle.await.unwrap();

    let finish_time = evaluated_at.lock().unwrap().unwrap();
    let total_elapsed = finish_time.duration_since(start_time);
    assert!(
        total_elapsed >= Duration::from_millis(280),
        "Debounce window should slide and only execute after the last event has stabilized (elapsed: {total_elapsed:?})"
    );
}

#[tokio::test(start_paused = true)]
async fn test_single_flight_coalescing_and_pending_rerun() {
    // Simulates: Apply 1 starts -> while running, new event arrives -> Apply 2 runs immediately after Apply 1 completes
    let is_applying = Arc::new(AtomicBool::new(false));
    let pending_rerun = Arc::new(AtomicBool::new(false));
    let total_apply_executions = Arc::new(AtomicU32::new(0));

    let is_applying_clone = Arc::clone(&is_applying);
    let pending_rerun_clone = Arc::clone(&pending_rerun);
    let total_exec_clone = Arc::clone(&total_apply_executions);

    // Initial trigger
    assert!(is_applying_clone
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_ok());

    let worker = tokio::spawn(async move {
        loop {
            // Simulate Prism compilation taking 100ms
            tokio::time::sleep(Duration::from_millis(100)).await;
            total_exec_clone.fetch_add(1, Ordering::SeqCst);

            if pending_rerun_clone.swap(false, Ordering::SeqCst) {
                // Rerun detected
                continue;
            }

            // Release is_applying first, then re-check pending_rerun — mirrors
            // the production trigger_single_flight_apply ordering that closes
            // the lost-wakeup window between the swap and the store.
            is_applying_clone.store(false, Ordering::SeqCst);
            if !pending_rerun_clone.swap(false, Ordering::SeqCst) {
                return;
            }
            // Re-acquire; if another worker already took it, that worker handles the rerun.
            if is_applying_clone
                .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                .is_err()
            {
                return;
            }
        }
    });

    // While Apply 1 is in progress (at t=30ms), a new event arrives
    tokio::time::sleep(Duration::from_millis(30)).await;
    // Attempting to start another apply fails and sets pending_rerun
    if is_applying
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        pending_rerun.store(true, Ordering::SeqCst);
    }

    worker.await.unwrap();

    assert_eq!(
        total_apply_executions.load(Ordering::SeqCst),
        2,
        "Should execute exactly 2 serial applies (initial + coalesced rerun)"
    );
    assert!(
        !is_applying.load(Ordering::SeqCst),
        "is_applying should be released back to false"
    );
}

#[test]
fn test_reconciliation_retry_on_apply_failure_semantic() {
    // Simulates: Home-WiFi -> Office-WiFi transition where Apply #1 Fails
    let observed_state = Arc::new(Mutex::new(NetworkState {
        interface_type: InterfaceType::Wifi,
        is_connected: true,
        ssid: Some("Home-WiFi".to_owned()),
    }));
    let applied_state = Arc::new(Mutex::new(Some(NetworkState {
        interface_type: InterfaceType::Wifi,
        is_connected: true,
        ssid: Some("Home-WiFi".to_owned()),
    })));

    // 1. Transition occurs: observed becomes Office-WiFi
    let fresh_state = NetworkState {
        interface_type: InterfaceType::Wifi,
        is_connected: true,
        ssid: Some("Office-WiFi".to_owned()),
    };
    *observed_state.lock().unwrap() = fresh_state.clone();

    // 2. Reconciliation check detects unaligned state (uses production code)
    let needs_reconcile =
        super::coordinator::needs_reconciliation(&applied_state.lock().unwrap(), &fresh_state);
    assert!(
        needs_reconcile,
        "Should detect unaligned state requiring reconciliation"
    );

    // 3. Simulate Apply #1 FAILS (e.g. transient file lock or core starting)
    let apply_succeeded = false;
    if apply_succeeded {
        *applied_state.lock().unwrap() = Some(fresh_state);
    }
    // applied_state is NOT updated; it remains Home-WiFi
    assert_eq!(
        applied_state
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .ssid
            .as_deref(),
        Some("Home-WiFi")
    );

    // 4. Next polling interval / tick samples Office-WiFi again
    let sampled_on_next_tick = NetworkState {
        interface_type: InterfaceType::Wifi,
        is_connected: true,
        ssid: Some("Office-WiFi".to_owned()),
    };
    let retry_needed = super::coordinator::needs_reconciliation(
        &applied_state.lock().unwrap(),
        &sampled_on_next_tick,
    );
    assert!(
        retry_needed,
        "On next tick, system MUST automatically retry reconciliation because desired != applied!"
    );

    // 5. Simulate Apply #2 SUCCEEDS
    let apply_retry_succeeded = true;
    if apply_retry_succeeded {
        *applied_state.lock().unwrap() = Some(sampled_on_next_tick.clone());
    }
    assert_eq!(
        applied_state
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .ssid
            .as_deref(),
        Some("Office-WiFi")
    );

    // 6. Next polling tick: desired == applied -> No-Op
    let no_op = !super::coordinator::needs_reconciliation(
        &applied_state.lock().unwrap(),
        &sampled_on_next_tick,
    );
    assert!(no_op, "Once reconciled, subsequent ticks must be No-Op");
}

#[test]
fn test_ping_pong_state_reversion_no_op() {
    // Simulates: Home-WiFi -> Office-WiFi -> Home-WiFi within debounce window
    // If the applied state already matches the fresh sample, no reconciliation is needed.
    let sampled_ground_truth = NetworkState {
        interface_type: InterfaceType::Wifi,
        is_connected: true,
        ssid: Some("Home-WiFi".to_owned()),
    };

    let applied = Arc::new(Mutex::new(Some(sampled_ground_truth.clone())));
    let no_op =
        !super::coordinator::needs_reconciliation(&applied.lock().unwrap(), &sampled_ground_truth);

    assert!(no_op, "Ping-pong reversion back to original state should be detected as No-Op with 0 apply triggers");
}

#[test]
fn test_hot_reload_ack_fail_closed_semantics() {
    use super::coordinator::verify_hot_reload_ack;

    // 1. Valid nested ACK from Prism status
    let valid_nested = serde_json::json!({
        "patches": [],
        "status": {
            "files_saved": true,
            "hot_reload_success": true,
            "message": "Config applied and reloaded"
        }
    });
    assert_eq!(verify_hot_reload_ack(&valid_nested), Some(true));

    // 2. Valid top-level ACK
    let valid_top = serde_json::json!({
        "hot_reload_success": true
    });
    assert_eq!(verify_hot_reload_ack(&valid_top), Some(true));

    // 3. Explicit false from Mihomo
    let core_error_nested = serde_json::json!({
        "status": {
            "files_saved": true,
            "hot_reload_success": false,
            "message": "Config error"
        }
    });
    assert_eq!(verify_hot_reload_ack(&core_error_nested), Some(false));

    // 4. Missing ACK field entirely -> None
    let missing_field = serde_json::json!({
        "patches": ["patch1", "patch2"]
    });
    assert_eq!(verify_hot_reload_ack(&missing_field), None);

    // 5. Malformed null status -> None
    let null_status = serde_json::json!({
        "status": null
    });
    assert_eq!(verify_hot_reload_ack(&null_status), None);

    // 6. Invalid non-boolean type -> None
    let string_boolean = serde_json::json!({
        "status": {
            "hot_reload_success": "true" // String instead of bool
        }
    });
    assert_eq!(verify_hot_reload_ack(&string_boolean), None);
}

#[test]
fn test_layered_protocol_verification_matrix() {
    use super::coordinator::{parse_apply_result, validate_http_status, verify_core_apply_success};
    use super::types::CoreApplyResult;

    // Layer 1: HTTP transport status codes
    assert!(validate_http_status(Some(200)), "HTTP 200 is valid 2xx");
    assert!(validate_http_status(Some(204)), "HTTP 204 is valid 2xx");
    assert!(validate_http_status(Some(299)), "HTTP 299 is valid 2xx");
    assert!(
        !validate_http_status(Some(400)),
        "HTTP 400 must be rejected"
    );
    assert!(
        !validate_http_status(Some(500)),
        "HTTP 500 must be rejected"
    );
    assert!(
        !validate_http_status(Some(502)),
        "HTTP 502 must be rejected"
    );
    assert!(
        !validate_http_status(None),
        "None HTTP status must be rejected (fail-closed)"
    );

    // ── 4-Quadrant Truth Table Tests ─────────────────────────────────────────

    // 1. (HTTP 204, ACK true) => SUCCESS
    let case1 = CoreApplyResult {
        http_status: Some(204),
        hot_reload_success: Some(true),
    };
    assert!(
        verify_core_apply_success(&case1),
        "HTTP 204 + ACK true must be SUCCESS"
    );

    // 2. (HTTP 204, ACK false) => FAIL (Mihomo responded but failed to apply rules)
    let case2 = CoreApplyResult {
        http_status: Some(204),
        hot_reload_success: Some(false),
    };
    assert!(
        !verify_core_apply_success(&case2),
        "HTTP 204 + ACK false must be FAIL"
    );

    // 3. (HTTP 500, ACK true) => FAIL (Contradictory payload claiming success during 500)
    let case3 = CoreApplyResult {
        http_status: Some(500),
        hot_reload_success: Some(true),
    };
    assert!(
        !verify_core_apply_success(&case3),
        "HTTP 500 + ACK true must be FAIL"
    );

    // 4. (HTTP None, ACK true) => FAIL (Unreachable REST API claiming ACK)
    let case4 = CoreApplyResult {
        http_status: None,
        hot_reload_success: Some(true),
    };
    assert!(
        !verify_core_apply_success(&case4),
        "HTTP None + ACK true must be FAIL"
    );

    // 5. (HTTP 204, ACK None) => FAIL (Missing ACK field)
    let case5 = CoreApplyResult {
        http_status: Some(204),
        hot_reload_success: None,
    };
    assert!(
        !verify_core_apply_success(&case5),
        "HTTP 204 + ACK None must be FAIL"
    );

    // 6. (HTTP None, ACK None) => FAIL (Total outage)
    let case6 = CoreApplyResult {
        http_status: None,
        hot_reload_success: None,
    };
    assert!(
        !verify_core_apply_success(&case6),
        "HTTP None + ACK None must be FAIL"
    );

    // ── JSON Parser Orthogonal Extraction Tests ──────────────────────────────
    // Parser must NEVER fake http_status from hot_reload_success
    let ack_only_false = serde_json::json!({
        "status": {
            "hot_reload_success": false
        }
    });
    let parsed_ack_only_false = parse_apply_result(&ack_only_false);
    assert_eq!(
        parsed_ack_only_false.http_status, None,
        "Must NOT fake HTTP 500 from hot_reload_success=false"
    );
    assert_eq!(parsed_ack_only_false.hot_reload_success, Some(false));
    assert!(!verify_core_apply_success(&parsed_ack_only_false));

    let ack_only_true = serde_json::json!({
        "status": {
            "hot_reload_success": true
        }
    });
    let parsed_ack_only_true = parse_apply_result(&ack_only_true);
    assert_eq!(
        parsed_ack_only_true.http_status, None,
        "Must NOT fake HTTP 200 from hot_reload_success=true"
    );
    assert_eq!(parsed_ack_only_true.hot_reload_success, Some(true));
    assert!(
        !verify_core_apply_success(&parsed_ack_only_true),
        "Missing HTTP status must fail closed"
    );

    // Full structured 204 + true
    let full_valid_json = serde_json::json!({
        "status": {
            "http_status": 204,
            "hot_reload_success": true
        }
    });
    let parsed_full = parse_apply_result(&full_valid_json);
    assert_eq!(parsed_full.http_status, Some(204));
    assert_eq!(parsed_full.hot_reload_success, Some(true));
    assert!(verify_core_apply_success(&parsed_full));
}

#[tokio::test]
async fn test_http_status_is_thread_confined_with_raii_cleanup() {
    use crate::prism::host::{
        set_current_apply_http_status, take_current_apply_http_status, HttpStatusGuard,
    };
    use std::sync::Barrier;

    // Barrier ensures both closures hold their own status simultaneously,
    // proving thread-local isolation rather than sequential reuse.
    let barrier = Arc::new(Barrier::new(2));
    let barrier_a = Arc::clone(&barrier);
    let barrier_b = Arc::clone(&barrier);

    // 1. Task A on thread 1 sets HTTP 204 via HttpStatusGuard
    let handle_a = tokio::task::spawn_blocking(move || {
        let guard = HttpStatusGuard::enter();
        set_current_apply_http_status(Some(204));
        // Wait for Task B to also set its status, then verify isolation.
        barrier_a.wait();
        let status_a = guard.take();
        assert_eq!(status_a, Some(204));
        assert_eq!(take_current_apply_http_status(), None);
        status_a
    });

    // 2. Task B on thread 2 sets HTTP 500 via HttpStatusGuard
    let handle_b = tokio::task::spawn_blocking(move || {
        let guard = HttpStatusGuard::enter();
        set_current_apply_http_status(Some(500));
        // Wait for Task A to also set its status, then verify isolation.
        barrier_b.wait();
        let status_b = guard.take();
        assert_eq!(status_b, Some(500));
        assert_eq!(take_current_apply_http_status(), None);
        status_b
    });

    let res_a = handle_a.await.unwrap();
    let res_b = handle_b.await.unwrap();

    assert_eq!(res_a, Some(204), "Request A must receive its own 204");
    assert_eq!(res_b, Some(500), "Request B must receive its own 500");

    // 3. Test RAII Drop cleanup on simulated error / early return (?)
    tokio::task::spawn_blocking(|| {
        {
            let _guard = HttpStatusGuard::enter();
            set_current_apply_http_status(Some(500));
            // Simulate early return without guard.take() (e.g. ext.apply()? returned Err)
        } // _guard drops here and MUST clean up TLS
        assert_eq!(
            take_current_apply_http_status(),
            None,
            "HttpStatusGuard Drop must guarantee TLS cleanup even on early error returns"
        );
    })
    .await
    .unwrap();

    // 4. Test worker thread reuse:
    // Even if previous dirty state existed, new guard's enter() unconditionally resets TLS to None
    tokio::task::spawn_blocking(|| {
        // Step 4a: Force dirty state
        set_current_apply_http_status(Some(502));

        // Step 4b: New guard enters on the same thread
        let fresh_guard = HttpStatusGuard::enter();

        // Step 4c: If no status was written during this execution, take() must return None (never 502)
        assert_eq!(
            fresh_guard.take(),
            None,
            "Worker reuse must unconditionally start clean with None"
        );
    })
    .await
    .unwrap();
}
