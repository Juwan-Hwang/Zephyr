//! Windows native network change listener using IP Helper API (`NotifyAddrChange`).

use std::time::Duration;
use tokio::sync::mpsc::Sender;
use windows_sys::Win32::NetworkManagement::IpHelper::NotifyAddrChange;

use crate::network_coordinator::types::NetworkChangeReason;

/// Spawn a background thread that blocks on Windows `NotifyAddrChange` to detect IP / interface events.
pub fn start_windows_listener(event_tx: Sender<NetworkChangeReason>) {
    if let Err(e) = std::thread::Builder::new()
        .name("zephyr-win-net-watcher".to_owned())
        .spawn(move || {
            let mut backoff_secs = 2;
            loop {
                // SAFETY: NotifyAddrChange with NULL overlapped operates in
                // synchronous blocking mode — it does not return until an IP
                // address change occurs.  When overlapped is NULL, the Handle
                // parameter is ignored, so we pass null_mut() for both.
                let ret = unsafe { NotifyAddrChange(std::ptr::null_mut(), std::ptr::null_mut()) };
                if ret == 0 {
                    // Reset backoff on success.
                    backoff_secs = 2;
                    // Floor delay: if NotifyAddrChange returns immediately
                    // (e.g. driver/stack condition), prevent CPU spin and
                    // channel flooding by sleeping at least 1 second.
                    std::thread::sleep(Duration::from_secs(1));
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
