//! Windows native network change listener using IP Helper API (`NotifyAddrChange`).

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use tokio::sync::mpsc::Sender;
use windows_sys::Win32::NetworkManagement::IpHelper::NotifyAddrChange;

use crate::network_coordinator::types::NetworkChangeReason;

/// Prevents multiple watcher threads from being spawned if `start_windows_listener`
/// is called more than once. The thread blocks indefinitely inside `NotifyAddrChange`
/// and has no shutdown path, so accumulating threads would be a resource leak.
static WATCHER_STARTED: AtomicBool = AtomicBool::new(false);

/// Spawn a background thread that blocks on Windows `NotifyAddrChange` to detect IP / interface events.
///
/// **Single-call invariant**: This function should be called at most once during the
/// application lifetime. A static `AtomicBool` guard prevents duplicate spawns, but
/// the blocked thread has no shutdown path — it lives for the process lifetime.
pub fn start_windows_listener(event_tx: Sender<NetworkChangeReason>) {
    if WATCHER_STARTED
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        // A watcher thread was already started — do not spawn another.
        return;
    }
    if let Err(e) = std::thread::Builder::new()
        .name("zephyr-win-net-watcher".to_owned())
        .spawn(move || {
            let mut backoff_secs = 2;
            loop {
                let call_start = Instant::now();
                // SAFETY: NotifyAddrChange with NULL overlapped operates in
                // synchronous blocking mode — it does not return until an IP
                // address change occurs.  When overlapped is NULL, the Handle
                // parameter is ignored, so we pass null_mut() for both.
                let ret = unsafe { NotifyAddrChange(std::ptr::null_mut(), std::ptr::null_mut()) };
                if ret == 0 {
                    // Reset backoff on success.
                    backoff_secs = 2;
                    // Floor delay: if NotifyAddrChange returns in under 1s
                    // (e.g. driver/stack condition spinning), sleep the
                    // remainder to prevent CPU spin and channel flooding.
                    let elapsed = call_start.elapsed();
                    if elapsed < Duration::from_secs(1) {
                        std::thread::sleep(Duration::from_secs(1) - elapsed);
                    }
                    let reason =
                        NetworkChangeReason::NativeEvent("windows_notify_addr_change".to_owned());
                    if event_tx.blocking_send(reason).is_err() {
                        // Channel closed, app is shutting down.
                        break;
                    }
                } else {
                    emit_warn!(
                        System,
                        SYS_NETWORK_COORDINATOR_ERROR,
                        "NotifyAddrChange failed (code {}), retrying in {}s",
                        ret,
                        backoff_secs
                    );
                    std::thread::sleep(Duration::from_secs(backoff_secs));
                    // Exponential backoff: cap at 30s to avoid excessive delays.
                    backoff_secs = (backoff_secs * 2).min(30);
                }
            }
        })
    {
        emit_warn!(
            System,
            SYS_NETWORK_COORDINATOR_ERROR,
            "Failed to spawn Windows network watcher thread: {}",
            e
        );
    }
}
