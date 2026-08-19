//! Linux network event listener.

use crate::network_coordinator::types::NetworkChangeReason;
use tokio::sync::mpsc::Sender;

/// Start Linux network state change listener.
pub fn start_linux_listener(_event_tx: Sender<NetworkChangeReason>) {
    // Linux polling fallback is active by default; NetworkManager D-Bus hook can be integrated here.
}
