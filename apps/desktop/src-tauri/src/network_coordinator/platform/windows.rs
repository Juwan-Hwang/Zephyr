//! Windows native network change listener using IP Helper API (`NotifyAddrChange`).

use std::time::Duration;
use tokio::sync::mpsc::Sender;
use windows_sys::Win32::Foundation::HANDLE;

use crate::network_coordinator::types::NetworkChangeReason;

#[link(name = "iphlpapi")]
extern "system" {
    fn NotifyAddrChange(handle: *mut HANDLE, overlapped: *mut core::ffi::c_void) -> u32;
}

/// Spawn a background thread that blocks on Windows `NotifyAddrChange` to detect IP / interface events.
pub fn start_windows_listener(event_tx: Sender<NetworkChangeReason>) {
    std::thread::Builder::new()
        .name("zephyr-win-net-watcher".to_owned())
        .spawn(move || {
            let mut handle: HANDLE = std::ptr::null_mut();
            loop {
                // SAFETY: NotifyAddrChange with NULL overlapped synchronously blocks until an IP change occurs.
                let ret = unsafe { NotifyAddrChange(&mut handle, std::ptr::null_mut()) };
                if ret == 0 {
                    let reason =
                        NetworkChangeReason::NativeEvent("windows_notify_addr_change".to_owned());
                    if event_tx.blocking_send(reason).is_err() {
                        // Channel closed, app is shutting down
                        break;
                    }
                } else {
                    // Back off briefly before retrying to prevent hot loop on error
                    std::thread::sleep(Duration::from_secs(2));
                }
            }
        })
        .ok();
}
