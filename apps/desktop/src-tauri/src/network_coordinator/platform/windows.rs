//! Windows native network change listener using IP Helper API (`NotifyAddrChange`).

use std::time::Duration;
use tokio::sync::mpsc::Sender;
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
use windows_sys::Win32::NetworkManagement::IpHelper::NotifyAddrChange;
use windows_sys::Win32::System::IO::OVERLAPPED;

use crate::network_coordinator::types::NetworkChangeReason;

/// Spawn a background thread that blocks on Windows `NotifyAddrChange` to detect IP / interface events.
pub fn start_windows_listener(event_tx: Sender<NetworkChangeReason>) {
    std::thread::Builder::new()
        .name("zephyr-win-net-watcher".to_owned())
        .spawn(move || {
            loop {
                let mut handle: HANDLE = std::ptr::null_mut();
                // SAFETY: NotifyAddrChange with NULL overlapped synchronously blocks
                // until an IP change occurs. On success it stores a valid handle
                // that must be closed to avoid leaking kernel objects.
                let ret = unsafe { NotifyAddrChange(&mut handle, std::ptr::null::<OVERLAPPED>()) };
                if ret == 0 {
                    let reason =
                        NetworkChangeReason::NativeEvent("windows_notify_addr_change".to_owned());
                    if event_tx.blocking_send(reason).is_err() {
                        // Channel closed, app is shutting down.
                        if !handle.is_null() {
                            // SAFETY: `handle` was returned by NotifyAddrChange and is valid.
                            unsafe { CloseHandle(handle) };
                        }
                        break;
                    }
                } else {
                    // Back off briefly before retrying to prevent hot loop on error
                    std::thread::sleep(Duration::from_secs(2));
                }
                // Close the handle returned by NotifyAddrChange to prevent leaks.
                if !handle.is_null() {
                    // SAFETY: `handle` was returned by NotifyAddrChange on success
                    // and is valid. We check for null to handle the error path.
                    unsafe { CloseHandle(handle) };
                }
            }
        })
        .ok();
}
