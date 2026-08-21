//! Network change coordinator and state management.

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
#[allow(clippy::needless_pass_by_value)]
pub async fn get_network_state(app: AppHandle) -> Result<NetworkState, String> {
    let coordinator = app.try_state::<NetworkCoordinatorHandle>();
    // Use cached state only if the coordinator has completed at least one
    // detection. Otherwise fall back to spawn_blocking to avoid returning
    // the initial NetworkState::default() (a fabricated "disconnected" state).
    let cached = coordinator.and_then(|c| c.has_detected().then(|| c.get_current_state()));
    let mut state = match cached {
        Some(s) => s,
        None => match tokio::time::timeout(
            std::time::Duration::from_secs(5),
            tokio::task::spawn_blocking(detect_network_state),
        )
        .await
        {
            Ok(Ok(s)) => s,
            Ok(Err(e)) => return Err(format!("Network detection task failed: {e}")),
            Err(_) => return Err("Network detection timed out after 5s".to_owned()),
        },
    };
    // Mask SSID before exposing to frontend — consistent with masked_network_state_json
    if state.ssid.is_some() {
        state.ssid = Some("***".to_owned());
    }
    Ok(state)
}

/// Tauri command: Trigger a manual network change re-evaluation (e.g. from frontend online event or resume).
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub async fn notify_network_change(app: AppHandle, source: Option<String>) -> Result<(), String> {
    let coordinator = app
        .try_state::<NetworkCoordinatorHandle>()
        .ok_or_else(|| "Network coordinator not registered".to_owned())?;
    /// Maximum length of a caller-supplied source string to prevent unbounded log writes.
    const MAX_SOURCE_LEN: usize = 64;
    let reason = match source.as_deref() {
        Some("browser_online" | "online" | "browser_offline" | "offline") => {
            NetworkChangeReason::OnlineEvent
        }
        Some("resume" | "wake") => NetworkChangeReason::Resume,
        Some("manual") | None => NetworkChangeReason::Manual,
        Some(other) => {
            // Truncate BEFORE sanitizing to avoid unbounded CPU work on
            // large inputs — sanitize_text scans the entire string but
            // the result is only used up to MAX_SOURCE_LEN chars.
            let truncated: String = other.chars().take(MAX_SOURCE_LEN).collect();
            let sanitized = types::sanitize_text(&truncated);
            NetworkChangeReason::NativeEvent(sanitized)
        }
    };
    // Manual and Resume both require forced reconciliation on failure.
    let needs_recovery = matches!(
        reason,
        NetworkChangeReason::Manual | NetworkChangeReason::Resume
    );
    match tokio::time::timeout(
        std::time::Duration::from_secs(5),
        coordinator.notify(reason),
    )
    .await
    {
        Ok(Ok(())) => Ok(()),
        Ok(Err(_)) => {
            // If a Manual/Resume notification was dropped (channel closed),
            // recover by invalidating applied_state and resetting retry
            // counters, matching the timeout recovery in notify_core_started.
            if needs_recovery {
                coordinator.invalidate_applied_state();
                coordinator.reset_retry_counters();
            }
            emit_warn!(
                System,
                SYS_NETWORK_COORDINATOR_ERROR,
                "Network coordinator notify failed — channel closed, event dropped"
            );
            Err("Network coordinator notify failed — channel closed".to_owned())
        }
        Err(_) => {
            if needs_recovery {
                coordinator.invalidate_applied_state();
                coordinator.reset_retry_counters();
            }
            emit_warn!(
                System,
                SYS_NETWORK_COORDINATOR_ERROR,
                "Network coordinator notify timed out after 5s — event dropped"
            );
            Err("Network coordinator notify timed out".to_owned())
        }
    }
}
