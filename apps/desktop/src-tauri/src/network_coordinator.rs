//! Network change coordinator and state management.

#![allow(clippy::needless_pass_by_value)]

pub mod coordinator;
pub mod detector;
pub mod platform;
pub mod types;

#[cfg(test)]
mod tests;

pub use coordinator::{start_coordinator, NetworkCoordinatorHandle};
pub use detector::{
    detect_network_state, detect_network_state_uncached, detect_ssid, invalidate_ssid_cache,
};
pub use types::{
    is_http_success, CoordinatorMetrics, CoreApplyResult, InterfaceType, NetworkChangeReason,
    NetworkState,
};

use tauri::{AppHandle, Manager as _};

/// Tauri command: Query the current network connectivity snapshot.
/// Returns the SSID masked for privacy, consistent with the `network-state-changed` event.
#[tauri::command]
pub fn get_network_state(app: AppHandle) -> Result<NetworkState, String> {
    if let Some(coordinator) = app.try_state::<NetworkCoordinatorHandle>() {
        let mut state = coordinator.get_current_state();
        // Mask SSID before exposing to frontend — consistent with masked_network_state_json
        if state.ssid.is_some() {
            state.ssid = Some("***".to_owned());
        }
        Ok(state)
    } else {
        let mut state = detect_network_state();
        if state.ssid.is_some() {
            state.ssid = Some("***".to_owned());
        }
        Ok(state)
    }
}

/// Tauri command: Trigger a manual network change re-evaluation (e.g. from frontend online event or resume).
#[tauri::command]
pub async fn notify_network_change(app: AppHandle, source: Option<String>) -> Result<(), String> {
    if let Some(coordinator) = app.try_state::<NetworkCoordinatorHandle>() {
        /// Maximum length of a caller-supplied source string to prevent unbounded log writes.
        const MAX_SOURCE_LEN: usize = 64;
        let reason = match source.as_deref() {
            Some("browser_online" | "online" | "browser_offline" | "offline") => {
                NetworkChangeReason::OnlineEvent
            }
            Some("resume" | "wake") => NetworkChangeReason::Resume,
            Some("manual") | None => NetworkChangeReason::Manual,
            Some(other) => {
                // Sanitize: strip control chars (including newlines) to prevent
                // log injection, then truncate to MAX_SOURCE_LEN at a char boundary.
                let sanitized: String = other
                    .chars()
                    .filter(|c| !c.is_control() && *c != '\u{2028}' && *c != '\u{2029}')
                    .take(MAX_SOURCE_LEN)
                    .collect();
                NetworkChangeReason::NativeEvent(sanitized)
            }
        };
        coordinator.notify(reason).await;
    }
    Ok(())
}
