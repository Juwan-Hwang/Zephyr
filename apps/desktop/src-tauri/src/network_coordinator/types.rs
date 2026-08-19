//! Network state and coordinator data structures.

use serde::{Deserialize, Serialize};

/// Strip control, bidi-override, bidi-mark, zero-width, and BOM characters
/// from a string to prevent log injection and text reordering via crafted inputs.
#[must_use]
pub fn sanitize_text(input: &str) -> String {
    input
        .chars()
        .filter(|c| {
            !c.is_control()
                && !matches!(
                    c,
                    '\u{2028}'
                        | '\u{2029}'
                        | '\u{200B}'
                        | '\u{200C}'
                        | '\u{200D}'
                        | '\u{200E}'
                        | '\u{200F}'
                        | '\u{061C}'
                )
                && !('\u{202A}'..='\u{202E}').contains(c)
                && !('\u{2066}'..='\u{2069}').contains(c)
                && *c != '\u{FEFF}'
        })
        .collect()
}

/// Type of network interface currently active.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InterfaceType {
    /// Wireless 802.11 Wi-Fi connection
    Wifi,
    /// Wired 802.3 Ethernet connection
    Ethernet,
    /// Cellular / Mobile broadband connection
    Cellular,
    /// Other / Virtual / VPN interface
    Other,
    /// No active network interface detected
    None,
}

impl std::fmt::Display for InterfaceType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Wifi => write!(f, "wifi"),
            Self::Ethernet => write!(f, "ethernet"),
            Self::Cellular => write!(f, "cellular"),
            Self::Other => write!(f, "other"),
            Self::None => write!(f, "none"),
        }
    }
}

/// Snapshot of the system's current network connectivity state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NetworkState {
    /// Primary active interface type.
    pub interface_type: InterfaceType,
    /// Whether the host has network connectivity.
    pub is_connected: bool,
    /// Wi-Fi SSID name (if connected via Wi-Fi).
    pub ssid: Option<String>,
}

impl Default for NetworkState {
    fn default() -> Self {
        Self {
            interface_type: InterfaceType::None,
            is_connected: false,
            ssid: None,
        }
    }
}

impl NetworkState {
    /// Check if the network state represents a valid connected Wi-Fi with non-empty SSID.
    #[must_use]
    pub fn is_wifi(&self) -> bool {
        self.is_connected
            && self.interface_type == InterfaceType::Wifi
            && self.ssid.as_deref().is_some_and(|ssid| !ssid.is_empty())
    }

    /// Return a privacy-redacted representation of the network state suitable for diagnostic logs.
    #[must_use]
    pub fn masked(&self) -> String {
        match (&self.interface_type, &self.ssid) {
            (InterfaceType::Wifi, Some(ssid)) => {
                let masked_ssid = mask_ssid(ssid);
                format!("Wifi({masked_ssid})")
            }
            (itype, _) => format!("{itype}"),
        }
    }
}

/// Mask SSID for diagnostic log privacy (e.g. "`MyHomeNetwork`" -> "`My***rk`").
/// Strips control, bidi-override, zero-width, and BOM characters before masking
/// to prevent log injection and text reordering via crafted SSIDs.
fn mask_ssid(ssid: &str) -> String {
    let chars: Vec<char> = sanitize_text(ssid).chars().collect();
    let len = chars.len();
    if len <= 2 {
        "***".to_owned()
    } else if len <= 6 {
        let first = chars.first().copied().unwrap_or('*');
        format!("{first}***")
    } else {
        let first: String = chars.iter().take(2).collect();
        let last: String = chars
            .iter()
            .rev()
            .take(2)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        format!("{first}***{last}")
    }
}

/// Telemetry metrics for the Network Change Coordinator.
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CoordinatorMetrics {
    /// Total raw events received across all sources.
    pub events_received: u64,
    /// Number of times the debounce window successfully stabilized and expired.
    pub debounce_expirations: u64,
    /// Total uncached hardware state queries performed.
    pub state_detections: u64,
    /// Number of transitions where observed network state changed.
    pub state_transitions: u64,
    /// Number of Prism rule applications initiated.
    pub apply_started: u64,
    /// Number of Prism rule applications completed successfully.
    pub apply_succeeded: u64,
    /// Number of Prism rule applications that encountered an error.
    pub apply_failed: u64,
    /// Number of applies deferred because the core was not running (not counted as failures).
    pub apply_deferred: u64,
    /// Number of coalesced rerun requests scheduled.
    pub pending_reruns: u64,
}

/// Reason / trigger source for network state re-evaluation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NetworkChangeReason {
    /// OS native event (e.g. IP interface change, WLAN notification)
    NativeEvent(String),
    /// Low-frequency periodic polling heartbeat
    Polling,
    /// System resume from sleep / suspend
    Resume,
    /// Frontend browser window.online event
    OnlineEvent,
    /// User or frontend manual refresh request
    Manual,
}

impl std::fmt::Display for NetworkChangeReason {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NativeEvent(src) => write!(f, "native_event({src})"),
            Self::Polling => write!(f, "polling"),
            Self::Resume => write!(f, "resume"),
            Self::OnlineEvent => write!(f, "online_event"),
            Self::Manual => write!(f, "manual"),
        }
    }
}

/// Strongly-typed outcome of a Mihomo core rule application.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CoreApplyResult {
    /// HTTP transport status code returned by Mihomo REST API (None if connection failed or unknown).
    pub http_status: Option<u16>,
    /// Application payload acknowledgement confirming hot-reload success (None if missing/unknown).
    pub hot_reload_success: Option<bool>,
}

/// Check whether an HTTP status code is a 2xx success.
/// Shared by `CoreApplyResult::is_success`, `validate_http_status`,
/// `PrismState::apply_internal`, and `ZephyrPrismHost::apply_config`.
#[must_use]
pub fn is_http_success(code: u16) -> bool {
    (200..=299).contains(&code)
}

impl CoreApplyResult {
    /// Check whether rule application was completely successful at both transport and application layers.
    /// Follows strict fail-closed semantics: requires `http_status` in `200..=299` AND `hot_reload_success == Some(true)`.
    #[must_use]
    pub fn is_success(&self) -> bool {
        matches!(
            (self.http_status, self.hot_reload_success),
            (Some(code), Some(true)) if is_http_success(code)
        )
    }
}
