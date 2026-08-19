//! Platform-specific native network event listeners.

use crate::network_coordinator::types::NetworkChangeReason;
use tokio::sync::mpsc::Sender;

#[cfg(target_os = "windows")]
pub mod windows;

#[cfg(target_os = "macos")]
pub mod macos;

#[cfg(target_os = "linux")]
pub mod linux;

/// Start the native OS network change listener thread (if supported on this platform).
pub fn start_native_listener(event_tx: Sender<NetworkChangeReason>) {
    #[cfg(target_os = "windows")]
    {
        windows::start_windows_listener(event_tx);
    }

    #[cfg(target_os = "macos")]
    {
        macos::start_macos_listener(event_tx);
    }

    #[cfg(target_os = "linux")]
    {
        linux::start_linux_listener(event_tx);
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        let _ = event_tx;
    }
}
