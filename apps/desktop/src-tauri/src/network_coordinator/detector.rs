//! Network state detector and Wi-Fi SSID sampling.

use std::sync::Mutex;
use std::time::Instant;

use super::types::{InterfaceType, NetworkState};

/// SSID cache TTL — avoids spawning a subprocess on every patch compilation.
const SSID_CACHE_TTL_SECS: u64 = 5;

/// Cached SSID result (including `None`) with the instant it was observed.
static SSID_CACHE: Mutex<Option<(Option<String>, Instant)>> = Mutex::new(None);

/// Detect the current `WiFi` SSID with TTL caching.
#[must_use]
pub fn detect_ssid() -> Option<String> {
    // Fast path: return cached value if still fresh.
    if let Ok(cache) = SSID_CACHE.lock() {
        if let Some((cached, instant)) = cache.as_ref() {
            if instant.elapsed().as_secs() < SSID_CACHE_TTL_SECS {
                return cached.clone();
            }
        }
    }

    let ssid = detect_ssid_uncached();

    // Update cache (best-effort; lock failure is non-fatal).
    if let Ok(mut cache) = SSID_CACHE.lock() {
        *cache = Some((ssid.clone(), Instant::now()));
    }

    ssid
}

/// Explicitly invalidate the SSID cache (e.g. after a network change event).
pub fn invalidate_ssid_cache() {
    if let Ok(mut cache) = SSID_CACHE.lock() {
        *cache = None;
    }
}

/// Classify the current network state based on a detected SSID.
/// Shared by both cached and uncached detection paths.
#[must_use]
fn classify_network_state(ssid: Option<String>) -> NetworkState {
    if let Some(s) = ssid {
        return NetworkState {
            interface_type: InterfaceType::Wifi,
            is_connected: true,
            ssid: Some(s),
        };
    }

    if detect_has_ethernet() {
        return NetworkState {
            interface_type: InterfaceType::Ethernet,
            is_connected: true,
            ssid: None,
        };
    }

    NetworkState {
        interface_type: InterfaceType::None,
        is_connected: false,
        ssid: None,
    }
}

/// Sample the complete current network state with caching.
#[must_use]
pub fn detect_network_state() -> NetworkState {
    classify_network_state(detect_ssid())
}

/// Sample the ground-truth network state without using any cached SSID value.
///
/// Bypasses the TTL cache and directly queries OS interfaces, then updates the
/// cache with the fresh ground truth. Used by the Coordinator on debounce expiration.
#[must_use]
pub fn detect_network_state_uncached() -> NetworkState {
    let ssid = detect_ssid_uncached();

    // Refresh cache with the newly sampled ground truth
    if let Ok(mut cache) = SSID_CACHE.lock() {
        *cache = Some((ssid.clone(), Instant::now()));
    }

    classify_network_state(ssid)
}

/// Platform-specific SSID detection without caching (Windows).
#[cfg(target_os = "windows")]
#[must_use]
pub fn detect_ssid_uncached() -> Option<String> {
    use std::os::windows::process::CommandExt as _;
    let output = std::process::Command::new("netsh")
        .args(["wlan", "show", "interfaces"])
        .creation_flags(crate::core_manager::CREATE_NO_WINDOW)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    // Parse: "    SSID                   : MyWiFi"
    // Skip:  "    BSSID                  : aa:bb:cc:dd:ee:ff"
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .find(|line| line.starts_with("SSID") && !line.starts_with("BSSID"))
        .and_then(|line| line.split_once(':').map(|(_, v)| v.trim().to_owned()))
        .filter(|s| !s.is_empty())
}

/// Platform-specific SSID detection without caching (macOS).
#[cfg(target_os = "macos")]
#[must_use]
pub fn detect_ssid_uncached() -> Option<String> {
    let iface = detect_macos_wifi_iface().unwrap_or_else(|| "en0".to_string());
    let output = std::process::Command::new("networksetup")
        .args(["-getairportnetwork", &iface])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout)
        .strip_prefix("Current Wi-Fi Network: ")
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from)
}

/// Find the macOS Wi-Fi interface via `networksetup -listallhardwareports`.
#[cfg(target_os = "macos")]
fn detect_macos_wifi_iface() -> Option<String> {
    let output = std::process::Command::new("networksetup")
        .args(["-listallhardwareports"])
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    let mut found_wifi = false;
    for line in text.lines().map(str::trim) {
        if found_wifi {
            if let Some(dev) = line.strip_prefix("Device: ") {
                return Some(dev.trim().to_owned());
            }
        }
        if line.starts_with("Hardware Port:") && line.contains("Wi-Fi") {
            found_wifi = true;
        }
    }
    None
}

/// Platform-specific SSID detection without caching (Linux).
#[cfg(target_os = "linux")]
#[must_use]
pub fn detect_ssid_uncached() -> Option<String> {
    if let Ok(output) = std::process::Command::new("nmcli")
        .args(["-t", "-e", "no", "-f", "active,ssid", "dev", "wifi"])
        .output()
    {
        if output.status.success() {
            for line in String::from_utf8_lossy(&output.stdout).lines() {
                // nmcli -t terse format: "active:ssid"
                // SSID can contain colons, so split at most once (splitn(2)).
                let (active, ssid) = line.splitn(2, ':').unwrap_or((line, ""));
                if active.trim() == "yes" {
                    let ssid_trimmed = ssid.trim();
                    if !ssid_trimmed.is_empty() {
                        return Some(ssid_trimmed.to_owned());
                    }
                }
            }
        }
    }

    if let Ok(output) = std::process::Command::new("iwconfig").output() {
        let combined = format!(
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        for line in combined.lines() {
            if let Some(rest) = line.split("ESSID:").nth(1) {
                let trimmed = rest.trim();
                if let Some(stripped) = trimmed.strip_prefix('"') {
                    if let Some(end) = stripped.find('"') {
                        if let Some(ssid) = stripped.get(..end) {
                            if !ssid.is_empty() {
                                return Some(ssid.to_owned());
                            }
                        }
                    }
                }
            }
        }
    }
    None
}

/// Platform-specific SSID detection without caching (fallback).
#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
#[must_use]
pub fn detect_ssid_uncached() -> Option<String> {
    None
}

/// Check if an Ethernet connection is active (Windows).
#[cfg(target_os = "windows")]
fn detect_has_ethernet() -> bool {
    use std::os::windows::process::CommandExt as _;
    let output = std::process::Command::new("netsh")
        .args(["interface", "ipv4", "show", "interfaces"])
        .creation_flags(crate::core_manager::CREATE_NO_WINDOW)
        .output()
        .ok();
    if let Some(out) = output {
        if out.status.success() {
            let text = String::from_utf8_lossy(&out.stdout);
            for line in text.lines() {
                let trimmed = line.trim();
                // netsh table layout: "Idx Met MTU State Name"
                // Tokenize and check the 4th token (State) for "connected".
                let tokens: Vec<&str> = trimmed.split_whitespace().collect();
                if tokens.len() >= 4
                    && tokens.get(3) == Some(&"connected")
                    && (trimmed.contains("Ethernet") || trimmed.contains("以太网"))
                {
                    return true;
                }
            }
        }
    }
    false
}

/// Check if an Ethernet connection is active (macOS).
#[cfg(target_os = "macos")]
fn detect_has_ethernet() -> bool {
    if let Ok(output) = std::process::Command::new("ifconfig").output() {
        if output.status.success() {
            let text = String::from_utf8_lossy(&output.stdout);
            let wifi_iface = detect_macos_wifi_iface().unwrap_or_else(|| "en0".to_owned());
            let mut current: Option<String> = None;
            for line in text.lines() {
                if !line.starts_with(char::is_whitespace) {
                    current = line.split(':').next().map(str::to_owned);
                } else if line.contains("status: active") {
                    if let Some(name) = current.as_deref() {
                        if name.starts_with("en") && name != wifi_iface {
                            return true;
                        }
                    }
                }
            }
        }
    }
    false
}

/// Check if an Ethernet connection is active (Linux).
#[cfg(target_os = "linux")]
fn detect_has_ethernet() -> bool {
    if let Ok(entries) = std::fs::read_dir("/sys/class/net") {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if (name.starts_with("eth") || name.starts_with("en"))
                && !name.starts_with("wlan")
                && !name.starts_with("wl")
            {
                let operstate = entry.path().join("operstate");
                if let Ok(content) = std::fs::read_to_string(operstate) {
                    if content.trim() == "up" {
                        return true;
                    }
                    if content.trim() == "unknown"
                        && std::fs::read_to_string(entry.path().join("carrier"))
                            .is_ok_and(|c| c.trim() == "1")
                    {
                        return true;
                    }
                }
            }
        }
    }
    false
}

/// Check if an Ethernet connection is active (fallback).
#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
fn detect_has_ethernet() -> bool {
    false
}
