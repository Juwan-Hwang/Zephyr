//! macOS network event listener.

use crate::network_coordinator::types::NetworkChangeReason;
use tokio::sync::mpsc::Sender;

/// Start macOS network state change listener.
pub fn start_macos_listener(_event_tx: Sender<NetworkChangeReason>) {
    // macOS polling fallback is active by default; SCDynamicStore hook can be integrated here.
}
