// desktop crate 非 FFI 库，覆盖 workspace 的 needless_pass_by_value = "allow"。
// core/core-ffi 是 FFI 库需要 allow，desktop 用源码级属性重新启用 deny。
#![deny(clippy::needless_pass_by_value)]
// 测试模块中允许 unwrap/expect/indexing/panic，避免在每个测试文件重复 #[allow]。
#![cfg_attr(
    test,
    allow(
        clippy::unwrap_used,
        clippy::expect_used,
        clippy::indexing_slicing,
        clippy::panic
    )
)]

#[macro_use]
pub mod backend_event;
pub mod backup;
pub mod config_manager;
pub mod core_event_bridge;
pub mod core_manager;
pub mod deep_link;
pub mod global_shortcut;
pub mod minisign_verify;
pub mod network_coordinator;
pub mod os_notification;
pub mod prism;
pub mod sys_proxy;
pub mod tray;
pub mod updater;
pub mod uwp_loopback;
#[cfg(target_os = "windows")]
pub mod webview_recovery;

use config_manager::{read_config, update_config};
use core_manager::core::subscription_scheduler::start_scheduler;
use core_manager::{
    decrypt_all_profiles, delete_config, disable_tun_cmd, download_sub, download_sub_batch,
    encrypt_all_profiles, ensure_app_storage, export_logs, fetch_text, get_core_uptime,
    get_core_version, grant_linux_tun_permission, init_tun_mode_from_config,
    is_machine_key_persisted, kill_all_mihomo_as_root_cmd, kill_mihomo, list_configs,
    open_config_folder, open_log_folder, read_config_file, rename_config, restart_core_as_root_cmd,
    set_tun_enabled, smart_kill_all_mihomo_as_root, start_core, stop_core, update_config_url,
    update_subscription_interval, update_subscription_ua, write_config_file, CoreData, MihomoState,
};
use global_shortcut::ShortcutRegistry;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use sys_proxy::{
    clear_sys_proxy, disable_sysproxy, enable_sysproxy, get_sys_proxy, has_sysproxy_ownership,
    restore_sys_proxy,
};
use tauri::Manager as _;
#[cfg(desktop)]
use tauri_plugin_autostart::Builder as AutostartBuilder;
use tauri_plugin_window_state::WindowExt as _;
use tray::{change_tray_icon, init_tray, update_tray_full_menu, TrayState};
use updater::{
    get_latest_client_version, get_latest_client_versions, get_latest_version, update_client,
    update_core, update_geo_data,
};
use uwp_loopback::exempt_uwp_apps;

/// Window state aspects to persist across sessions.
///
/// Excludes `FULLSCREEN` and `DECORATIONS` — the app uses custom frameless
/// decorations (`decorations: false`) and does not support fullscreen mode.
const WINDOW_STATE_FLAGS: tauri_plugin_window_state::StateFlags =
    tauri_plugin_window_state::StateFlags::SIZE
        .union(tauri_plugin_window_state::StateFlags::POSITION)
        .union(tauri_plugin_window_state::StateFlags::MAXIMIZED);

/// Rate limiter for Tauri commands
pub struct RateLimiter {
    calls: Mutex<HashMap<String, Instant>>,
}

impl Default for RateLimiter {
    fn default() -> Self {
        Self::new()
    }
}

impl RateLimiter {
    #[must_use]
    pub fn new() -> Self {
        Self {
            calls: Mutex::new(HashMap::new()),
        }
    }

    /// Reset rate limit for a specific command (e.g. after core stops)
    pub fn reset(&self, command: &str) {
        let mut calls = self
            .calls
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        calls.remove(command);
    }

    /// Check if a command can be executed (returns true if allowed, false if rate limited)
    /// Also cleans up expired entries to prevent unbounded memory growth
    pub fn check_rate_limit(&self, command: &str, min_interval_ms: u64) -> bool {
        let mut calls = self
            .calls
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let now = Instant::now();

        // Clean up entries older than 1 minute to prevent unbounded growth
        calls.retain(|_, last_call| now.duration_since(*last_call) < Duration::from_secs(60));

        if let Some(last_call) = calls.get(command) {
            let elapsed = now.duration_since(*last_call);
            if elapsed < Duration::from_millis(min_interval_ms) {
                return false;
            }
        }

        calls.insert(command.to_owned(), now);
        true
    }
}

/// Macro to simplify rate limiting in commands
#[macro_export]
macro_rules! rate_limit {
    ($limiter:expr, $cmd:expr, $ms:expr) => {
        if !$limiter.check_rate_limit($cmd, $ms) {
            let msg = format!(
                "{} rate limited (min {}ms interval), please wait",
                $cmd, $ms
            );
            emit_warn!(Core, CORE_START_FAILED, "RateLimit: {msg}");
            return Err(msg);
        }
    };
}

#[derive(Serialize, Deserialize, Clone, Default)]
pub(crate) struct Settings {
    close_to_tray: bool,
    auto_update: bool,
    #[serde(default)]
    auto_update_client: bool,
    autostart: bool,
    theme: Option<String>,
    last_config: Option<String>,
    #[serde(default)]
    custom_args: Vec<String>,
    #[serde(default)]
    dns_nameservers: Option<Vec<String>>,
    #[serde(default)]
    dns_fallbacks: Option<Vec<String>>,
    #[serde(default)]
    auto_apply: bool,
    #[serde(default)]
    ui_scale: f64,
    #[serde(default)]
    config_order: Vec<String>,
    /// Per-profile last selected proxy (v2: group + node).
    /// Key: profile filename (e.g., "my-sub.yaml")
    /// Value: JSON string { "group": "...", "node": "..." }
    /// Legacy format: plain node name string (auto-migrated on read)
    #[serde(default)]
    last_proxy_selection: std::collections::HashMap<String, String>,
    /// Per-profile preferred primary group name.
    /// Key: profile filename, Value: group name
    #[serde(default)]
    primary_group_preference: std::collections::HashMap<String, String>,
    /// Custom User-Agent for subscription downloads (used by scheduler).
    /// Set by frontend when user configures a fake client UA.
    #[serde(default)]
    subscription_user_agent: Option<String>,
    /// Hide proxy nodes that are unavailable (timeout) in the proxy list.
    #[serde(default)]
    hide_timeout_nodes: bool,
    // --- Global user preferences (applied to all profiles) ---
    /// Proxy mode: rule, global, or direct.
    #[serde(default)]
    mode: Option<String>,
    /// TUN mode enabled.
    #[serde(default)]
    tun_enabled: Option<bool>,
    /// Mixed port for HTTP/SOCKS proxy.
    #[serde(default)]
    mixed_port: Option<u16>,
    /// SOCKS port.
    #[serde(default)]
    socks_port: Option<u16>,
    /// HTTP port (currently read-only; `mixed_port` covers HTTP+SOCKS).
    /// Reserved for future use if separate HTTP port UI is needed.
    #[serde(default)]
    http_port: Option<u16>,
    /// IPv6 enabled.
    #[serde(default)]
    ipv6: Option<bool>,
    /// Allow LAN access.
    #[serde(default)]
    allow_lan: Option<bool>,
    /// Unified delay test.
    #[serde(default)]
    unified_delay: Option<bool>,
    /// DNS rewrite enabled.
    #[serde(default)]
    dns_rewrite_enabled: Option<bool>,
    /// Theme mode: light, dark, or auto.
    #[serde(default)]
    theme_mode: Option<String>,
    /// App window opacity (0-100).
    #[serde(default)]
    app_opacity: Option<u8>,
    /// Node list scroll mode.
    #[serde(default)]
    node_scroll: Option<bool>,
    /// Failover: auto-switch on consecutive proxy failures.
    #[serde(default)]
    failover_enabled: bool,
    /// Auto-apply network optimizations on startup.
    #[serde(default)]
    network_optim_auto_apply: bool,
    /// Lightweight mode: when `close_to_tray` is also enabled, closing the window
    /// immediately destroys the `WebView` to free memory. Tray click recreates it.
    /// Has no effect when `close_to_tray` is disabled (app exits on close).
    #[serde(default)]
    lightweight_mode: bool,
    /// Silent start: when enabled, the main window stays hidden on launch
    /// (tray icon only). The user can show the window by clicking the tray icon.
    #[serde(default)]
    silent_start: bool,
    /// Encrypt profile YAML files with the machine key.
    /// When enabled, config files are AES-256-GCM encrypted on disk and
    /// cannot be used on another machine. When toggled, existing files are
    /// immediately encrypted/decrypted.
    #[serde(default)]
    encrypt_configs: bool,
    // --- Log persistence settings ---
    /// Persist app events (`emit_error/warn/info`) to disk.
    #[serde(default)]
    log_app_enabled: bool,
    /// Persist mihomo core stdout/stderr to disk.
    #[serde(default)]
    log_core_enabled: bool,
    /// Days to keep log files (both app and core).
    #[serde(default = "default_log_retention_days")]
    log_retention_days: u32,
    /// Max single log file size in MB.
    #[serde(default = "default_log_max_file_mb")]
    log_max_file_mb: u32,
    /// Shell format for copying proxy environment variables.
    /// Values: "bash", "fish", "cmd", "powershell", "nushell".
    #[serde(default = "default_copy_env_format")]
    copy_env_format: String,
    /// Home page mode: "minimal" (default) or "console".
    /// Controls which layout is shown when the user navigates to the home page.
    #[serde(default)]
    home_page_mode: Option<String>,

    /// Settings schema version for automatic migration.
    /// Increment when breaking changes are made to the Settings struct.
    /// On load, if the stored version < `CURRENT_SCHEMA_VERSION`, migration
    /// functions are applied in sequence. Missing field defaults to 0
    /// (pre-migration era), so the first load of an old config triggers
    /// the full migration chain.
    #[serde(default)]
    schema_version: u32,
}

const fn default_log_retention_days() -> u32 {
    3
}
const fn default_log_max_file_mb() -> u32 {
    50
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Settings schema version & automatic migration system
// ═══════════════════════════════════════════════════════════════════════════════

/// Current settings schema version.
///
/// Bump this number whenever a breaking change is made to the `Settings`
/// struct that requires programmatic migration of existing user data.
/// Each bump must be accompanied by a new migration function registered
/// in `migrate_settings`.
const CURRENT_SCHEMA_VERSION: u32 = 1;

/// Run the settings migration chain.
///
/// If the stored `schema_version` is older than `CURRENT_SCHEMA_VERSION`,
/// apply each migration function in sequence (v0→v1, v1→v2, …).
///
/// Handle a corrupt settings.json: back it up, persist defaults, and return them.
///
/// This is called when JSON parsing or Settings deserialization fails.
/// The corrupt file is renamed to `settings.corrupt.<timestamp>.json`
/// so the user can recover their data manually if needed.
fn handle_corrupt_settings(settings_file: &Path, error: impl std::fmt::Display) -> Settings {
    eprintln!("[Settings] Failed to parse settings.json: {error}");
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let backup_path = settings_file.with_extension(format!("corrupt.{ts}.json"));
    if let Err(e) = std::fs::rename(settings_file, &backup_path) {
        eprintln!("[Settings] Failed to back up corrupt settings: {e}");
    } else {
        eprintln!("[Settings] Corrupt settings backed up to {backup_path:?}");
    }
    let default_settings = Settings {
        close_to_tray: true,
        log_retention_days: default_log_retention_days(),
        log_max_file_mb: default_log_max_file_mb(),
        copy_env_format: default_copy_env_format(),
        schema_version: CURRENT_SCHEMA_VERSION,
        ..Default::default()
    };
    // Persist the default settings immediately so a valid settings.json
    // always exists on disk, even if the user exits without saving.
    if let Ok(json_str) = serde_json::to_string(&default_settings) {
        let _ = core_manager::write_file_secure(settings_file, &json_str);
    }
    default_settings
}

/// On any migration failure: back up the original `settings.json` to
/// `settings.json.pre-migration.<timestamp>`, reset to `Settings::default()`
/// with `CURRENT_SCHEMA_VERSION`, and log a warning. This guarantees the
/// app always starts with a usable config — the user never gets locked
/// out by a corrupt migration.
pub(crate) fn migrate_settings(mut settings: Settings, settings_file: &Path) -> Settings {
    // Fast path: already up to date
    if settings.schema_version >= CURRENT_SCHEMA_VERSION {
        return settings;
    }

    let start_version = settings.schema_version;

    // Migration v0 → v1: normalize legacy `last_proxy_selection` entries.
    //
    // Before the schema system existed, `last_proxy_selection` values could
    // be either:
    //   - Legacy: plain node name string (e.g., "JP-Tokyo-01")
    //   - v2: JSON string { "group": "...", "node": "..." }
    //
    // This migration wraps any plain-string values into the v2 JSON format.
    // If the value is already valid JSON, it's left untouched.
    if settings.schema_version < 1 {
        let mut migrated_count = 0;
        #[allow(clippy::iter_over_hash_type)]
        for value in settings.last_proxy_selection.values_mut() {
            // Try to parse as JSON object containing "node" — if it succeeds,
            // it's already v2.  We must check for Object specifically because
            // JSON primitives like `1234`, `true`, or `null` would otherwise
            // pass `from_str::<Value>` and skip migration incorrectly.
            if let Ok(serde_json::Value::Object(map)) =
                serde_json::from_str::<serde_json::Value>(value)
            {
                if map.contains_key("node") {
                    continue;
                }
            }
            // Wrap plain string into v2 format
            let v2 = serde_json::json!({
                "group": null,
                "node": value.as_str(),
            });
            *value = v2.to_string();
            migrated_count += 1;
        }
        if migrated_count > 0 {
            eprintln!(
                "[Settings] Migration v0→v1: normalized {migrated_count} legacy proxy selection entries"
            );
        }
        settings.schema_version = 1;
    }

    // Future migrations go here:
    // if settings.schema_version < 2 { ... settings.schema_version = 2; }

    // Persist the migrated settings
    settings.schema_version = CURRENT_SCHEMA_VERSION;
    let json_str = match serde_json::to_string_pretty(&settings) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[Settings] Failed to serialize migrated settings: {e}");
            return Settings {
                schema_version: CURRENT_SCHEMA_VERSION,
                close_to_tray: true,
                ..Default::default()
            };
        }
    };
    if let Err(e) = core_manager::write_file_secure(settings_file, &json_str) {
        // The original settings file was successfully parsed (it is NOT
        // corrupt), so we must NOT rename it away — that would leave the
        // app with no settings.json on the next launch, causing the user
        // to lose all their settings. Just log the error; the in-memory
        // migrated settings are still returned and will be used for this
        // session. The next save_settings call will retry persistence.
        eprintln!("[Settings] Failed to persist migrated settings: {e}");
    }

    eprintln!(
        "[Settings] Migration complete: v{start_version} → v{}",
        settings.schema_version
    );

    settings
}

fn default_copy_env_format() -> String {
    if cfg!(target_os = "windows") {
        "powershell".to_owned()
    } else {
        "bash".to_owned()
    }
}

impl Settings {
    /// Extract global preferences for runtime config injection.
    pub fn to_global_prefs(&self) -> crate::core_manager::core::core_process::GlobalPreferences {
        crate::core_manager::core::core_process::GlobalPreferences {
            mode: self.mode.clone(),
            tun_enabled: self.tun_enabled,
            mixed_port: self.mixed_port,
            socks_port: self.socks_port,
            http_port: self.http_port,
            ipv6: self.ipv6,
            allow_lan: self.allow_lan,
            unified_delay: self.unified_delay,
        }
    }
}

pub(crate) struct SettingsState(pub(crate) Arc<Mutex<Settings>>);

/// Flag to signal that the user explicitly requested exit (tray "Quit" or
/// close button with `close_to_tray` disabled). Prevents `ExitRequested`
/// from blocking the shutdown.
pub(crate) struct ExplicitExitFlag(pub(crate) Arc<std::sync::atomic::AtomicBool>);

/// Tracks webview liveness via a heartbeat from the frontend (Layer 2).
///
/// Uses a lock-free `AtomicI64` storing Unix-millis of the last heartbeat.
/// If the heartbeat goes stale (> `HEARTBEAT_TIMEOUT_SECS`), the webview is
/// considered dead (e.g. `WebView2` crash on a non-Windows platform, or
/// Layer 1 missed an event) and the window will be recreated on the next
/// show attempt.
///
/// This is a pure fallback — Layer 1 (`ProcessFailed`) handles the 95% case
/// with millisecond latency. The heartbeat only fires when Layer 1 is absent
/// (non-Windows) or silently fails.
pub(crate) struct WebviewHealth {
    /// Unix-millis timestamp of the last heartbeat from the frontend.
    /// Updated atomically — no mutex, no allocation, nanosecond-level cost.
    ///
    /// Sentinel: `i64::MIN` means "explicitly invalidated" (written only by
    /// `invalidate_heartbeat()` after window destroy). The initial value is
    /// `monotonic_ms()` (app startup time, always ≥ 1), so the cold-start
    /// window before the first frontend heartbeat arrives is not mistaken for
    /// a dead webview.
    pub last_heartbeat_ms: AtomicI64,
    /// Idempotent reconstruction gate. When `true`, a reconstruction is
    /// already in progress and concurrent callers should skip.
    /// Toggled via `compare_exchange` for lock-free mutual exclusion.
    pub reconstructing: std::sync::atomic::AtomicBool,
}

impl Default for WebviewHealth {
    fn default() -> Self {
        Self {
            // Initialise to app-startup time so the cold-start window
            // (before the first heartbeat arrives) is not falsely judged dead.
            last_heartbeat_ms: AtomicI64::new(monotonic_ms()),
            reconstructing: std::sync::atomic::AtomicBool::new(false),
        }
    }
}

/// Heartbeat send interval (frontend side): 15 seconds.
///
/// Deliberately lazy — Layer 1 handles instant recovery, so the heartbeat
/// only needs to catch the rare case where Layer 1 is absent or fails.
/// At 15 s, that's ~5 760 IPC calls/day — negligible.
pub(crate) const HEARTBEAT_INTERVAL_SECS: u64 = 15;

/// Consecutive missed heartbeats before declaring the webview dead.
///
/// 3 × 15 s = 45 s worst-case detection latency. Tolerates one or two
/// transient IPC hiccups without false-positive recreation.
pub(crate) const HEARTBEAT_MISSED_THRESHOLD: u64 = 3;

/// Effective timeout: `HEARTBEAT_INTERVAL_SECS * HEARTBEAT_MISSED_THRESHOLD`.
pub(crate) const HEARTBEAT_TIMEOUT_SECS: u64 = HEARTBEAT_INTERVAL_SECS * HEARTBEAT_MISSED_THRESHOLD;

/// Monotonic milliseconds since application startup.
///
/// Uses `Instant` (monotonic clock) instead of `SystemTime` to be immune
/// to system clock adjustments (NTP sync, timezone changes, manual resets,
/// CMOS battery failure). This is critical because `SystemTime` jumping
/// backward could make `monotonic_ms()` return `0` — the sentinel for
/// "invalidated heartbeat" — triggering an infinite window recreation loop.
///
/// The returned value is always ≥ 1 (never `0`, the sentinel).
pub(crate) fn monotonic_ms() -> i64 {
    static START: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();
    let startup = *START.get_or_init(Instant::now);
    let millis = Instant::now()
        .saturating_duration_since(startup)
        .as_millis();
    i64::try_from(millis).unwrap_or(i64::MAX).max(1)
}

/// Atomically update the heartbeat timestamp.
pub(crate) fn touch_heartbeat(app: &tauri::AppHandle) {
    if let Some(health) = app.try_state::<WebviewHealth>() {
        health
            .last_heartbeat_ms
            .store(monotonic_ms(), Ordering::Relaxed);
    }
}

/// Mark the heartbeat as stale (e.g. after window destroy or `WebView2` crash).
///
/// This is the **only** place that writes `i64::MIN` — the sentinel for
/// "explicitly invalidated". `is_webview_alive` checks `last == i64::MIN`
/// **before** any other logic (including the hidden-window shortcut), so
/// the window is guaranteed to be recreated on the next show attempt or
/// crash recovery path.
///
/// Called from:
/// - `webview_recovery::handle_process_failed` (before `recreate_window`)
/// - `WindowEvent::Destroyed` handler (when the main window is gone)
///
/// `i64::MIN` is used instead of `0` to avoid a collision with the 10s
/// grace period calculation (`monotonic_ms() - 35_000`) which could
/// theoretically be `0` exactly 35s after startup.
pub(crate) fn invalidate_heartbeat(app: &tauri::AppHandle) {
    if let Some(health) = app.try_state::<WebviewHealth>() {
        health.last_heartbeat_ms.store(i64::MIN, Ordering::Relaxed);
    }
}

/// Reset the heartbeat to a grace-period value.
///
/// When a hidden window is surfaced (tray click, single-instance, etc.),
/// the browser engine was throttling JS timers while hidden, so the
/// heartbeat timestamp may be stale.  This function sets the heartbeat to
/// a value that is stale but within the grace window, so `is_webview_alive()`
/// returns `true` for `grace_ms` milliseconds — giving the frontend time to
/// resume heartbeating before Layer 2 considers the webview dead.
pub(crate) fn reset_heartbeat_grace(app: &tauri::AppHandle) {
    if let Some(health) = app.try_state::<WebviewHealth>() {
        let timeout_ms = i64::try_from(HEARTBEAT_TIMEOUT_SECS)
            .ok()
            .and_then(|t| t.checked_mul(1000))
            .unwrap_or(45_000);
        let grace_ms = 20_000;
        health
            .last_heartbeat_ms
            .store(monotonic_ms() - timeout_ms + grace_ms, Ordering::Relaxed);
    }
}

/// Try to acquire the reconstruction gate.
///
/// Returns `true` if this caller "wins" and should proceed with
/// reconstruction. Returns `false` if another caller is already
/// reconstructing — the caller should silently skip.
///
/// The gate is released by [`release_reconstruct_gate`].
pub(crate) fn try_acquire_reconstruct_gate(app: &tauri::AppHandle) -> bool {
    if let Some(health) = app.try_state::<WebviewHealth>() {
        health
            .reconstructing
            .compare_exchange(false, true, Ordering::Acquire, Ordering::Relaxed)
            .is_ok()
    } else {
        true
    }
}

/// Release the reconstruction gate after reconstruction finishes.
pub(crate) fn release_reconstruct_gate(app: &tauri::AppHandle) {
    if let Some(health) = app.try_state::<WebviewHealth>() {
        health.reconstructing.store(false, Ordering::Release);
    }
}

/// Check whether the webview is alive based on the last heartbeat timestamp.
///
/// Returns `false` if the heartbeat has been explicitly invalidated via
/// [`invalidate_heartbeat`] (sentinel `i64::MIN`), even if the window is
/// currently hidden — this ensures crash recovery proceeds during
/// hidden-to-tray crashes.
///
/// Otherwise returns `true` if the heartbeat is recent (< `HEARTBEAT_TIMEOUT_SECS`),
/// if the window is currently hidden (browser engine throttles JS timers
/// when hidden, so the heartbeat naturally stops), or if the health state
/// is not yet registered.
pub(crate) fn is_webview_alive(app: &tauri::AppHandle) -> bool {
    if let Some(health) = app.try_state::<WebviewHealth>() {
        let last = health.last_heartbeat_ms.load(Ordering::Relaxed);
        // Check the explicit invalidation sentinel FIRST — before the
        // hidden-window shortcut below.  Otherwise, if `WebView2` crashes
        // while the window is hidden-to-tray, invalidate_heartbeat() would
        // set the sentinel but is_webview_alive() would short-circuit to
        // `true` at the hidden check, causing recreate_window() to skip
        // recreation and leaving a transparent zombie window.
        if last == i64::MIN {
            return false;
        }
        // If the window is hidden, the browser engine throttles JS timers,
        // so the heartbeat will naturally stop. Treat the webview as alive
        // to avoid false-positive recreation when showing.
        if let Some(window) = app.get_webview_window("main") {
            if !window.is_visible().unwrap_or(true) {
                return true;
            }
        }
        let elapsed_ms = monotonic_ms() - last;
        let timeout_ms = i64::try_from(HEARTBEAT_TIMEOUT_SECS)
            .ok()
            .and_then(|t| t.checked_mul(1000))
            .unwrap_or(i64::MAX);
        elapsed_ms < timeout_ms
    } else {
        // No health state registered — assume alive to avoid false-positive
        // recreation during early startup.
        true
    }
}

/// Show or recreate the main window, detecting dead webviews.
///
/// This is the unified entry point for all "show window" paths:
/// - `show_main_window` command (called from frontend)
/// - Tray icon click
/// - Single-instance plugin (second launch)
///
/// If the window exists but the webview heartbeat is stale (`WebView2` crash
/// not caught by Layer 1, or non-Windows platform), the zombie window is
/// destroyed and a fresh one is created.
pub(crate) fn show_or_recreate_main_window(app: &tauri::AppHandle) {
    // Fast path: window exists and webview is alive — just show it.
    if let Some(window) = app.get_webview_window("main") {
        let was_visible = window.is_visible().unwrap_or(true);
        if is_webview_alive(app) {
            let _ = window.show();
            let _ = window.set_focus();
            // Only apply the grace period when the window was previously
            // hidden — if it was already visible, the heartbeat is current and
            // artificially aging it could cause false-positive recreation.
            if !was_visible {
                reset_heartbeat_grace(app);
            }
            return;
        }
    }

    // Slow path: window missing or webview dead.
    // Acquire the reconstruction gate BEFORE destroying the zombie window.
    // If another caller already holds the gate, we must not destroy the
    // existing window — otherwise the app is left in a windowless state.
    if !try_acquire_reconstruct_gate(app) {
        emit_info!(
            System,
            SYS_RECONSTRUCTION_SKIPPED,
            "Reconstruction already in progress — skipping"
        );
        return;
    }

    // Double-check: another caller may have already recreated the window
    // while we were waiting for the gate.
    if let Some(window) = app.get_webview_window("main") {
        let was_visible = window.is_visible().unwrap_or(true);
        if is_webview_alive(app) {
            let _ = window.show();
            let _ = window.set_focus();
            // Same conditional grace period as the fast path above.
            if !was_visible {
                reset_heartbeat_grace(app);
            }
            release_reconstruct_gate(app);
            return;
        }
    }

    // Destroy zombie if it exists (now safe — we hold the gate).
    if let Some(window) = app.get_webview_window("main") {
        emit_info!(
            System,
            SYS_HEARTBEAT_STALE,
            "Webview heartbeat stale — recreating window"
        );
        let _ = window.destroy();
    }

    match recreate_main_window(app) {
        Ok(window) => {
            // `recreate_main_window()` internally calls `touch_heartbeat()`
            // which clears the `i64::MIN` sentinel, preventing a queued
            // `recreate_window` closure from destroying this new window.
            let _ = window.show();
            let _ = window.set_focus();
        }
        Err(e) => {
            emit_error!(
                System,
                SYS_WINDOW_RECREATE_FAILED,
                "Failed to recreate main window: {e}"
            );
        }
    }
    release_reconstruct_gate(app);
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn get_settings(state: tauri::State<SettingsState>) -> Settings {
    state
        .0
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone()
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn save_settings(
    app: tauri::AppHandle,
    state: tauri::State<SettingsState>,
    settings: Settings,
) -> Result<(), String> {
    {
        let mut guard = state
            .0
            .lock()
            .map_err(|e| format!("Settings lock failed: {e}"))?;
        *guard = settings.clone();
    }
    persist_settings(&app, &settings)
}

/// Atomically patch a subset of settings fields.
/// Accepts a JSON object of partial updates and merges them into the
/// existing settings under the Mutex lock, then persists.
/// This avoids the Read-Modify-Write race condition of GET + SAVE.
/// Only valid field types are applied; malformed values are ignored and
/// deserialization failures are logged to stderr.
#[tauri::command]
#[allow(clippy::needless_pass_by_value, clippy::cognitive_complexity)]
fn patch_settings(
    app: tauri::AppHandle,
    state: tauri::State<SettingsState>,
    patch: serde_json::Value,
) -> Result<(), String> {
    let updated = {
        let mut guard = state
            .0
            .lock()
            .map_err(|e| format!("Settings lock failed: {e}"))?;
        let mut modified = false;
        if let serde_json::Value::Object(map) = &patch {
            // Validate encrypt_configs before mutating state to prevent inconsistent in-memory state
            if let Some(v) = map.get("encrypt_configs") {
                if matches!(serde_json::from_value::<bool>(v.clone()), Ok(true))
                    && !is_machine_key_persisted()
                {
                    return Err("Cannot enable config encryption: machine key is not persisted. Encrypted data would be lost on restart.".to_owned());
                }
            }
            macro_rules! patch_field {
                ($field:ident) => {
                    if let Some(v) = map.get(stringify!($field)) {
                        if let Ok(val) = serde_json::from_value(v.clone()) {
                            guard.$field = val;
                            modified = true;
                        } else {
                            emit_warn!(
                                Core,
                                CORE_START_FAILED,
                                "failed to deserialize field '{}': {:?}",
                                stringify!($field),
                                v
                            );
                        }
                    }
                };
            }
            patch_field!(theme);
            patch_field!(mode);
            patch_field!(tun_enabled);
            patch_field!(mixed_port);
            patch_field!(socks_port);
            patch_field!(http_port);
            patch_field!(ipv6);
            patch_field!(allow_lan);
            patch_field!(unified_delay);
            patch_field!(dns_rewrite_enabled);
            patch_field!(theme_mode);
            patch_field!(app_opacity);
            patch_field!(node_scroll);
            patch_field!(failover_enabled);
            patch_field!(network_optim_auto_apply);
            patch_field!(encrypt_configs);
            patch_field!(log_app_enabled);
            patch_field!(log_core_enabled);
            patch_field!(log_retention_days);
            patch_field!(log_max_file_mb);
            patch_field!(copy_env_format);
            // Validate home_page_mode: only accept 'minimal', 'console', or null (reset to default)
            if let Some(v) = map.get("home_page_mode") {
                if v.is_null() {
                    guard.home_page_mode = None;
                    modified = true;
                } else if let Ok(val) = serde_json::from_value::<String>(v.clone()) {
                    if val == "minimal" || val == "console" {
                        guard.home_page_mode = Some(val);
                        modified = true;
                    } else {
                        emit_warn!(
                            Core,
                            CORE_START_FAILED,
                            "rejected invalid home_page_mode: {:?}",
                            val
                        );
                    }
                } else {
                    emit_warn!(
                        Core,
                        CORE_START_FAILED,
                        "rejected non-string home_page_mode: {:?}",
                        v
                    );
                }
            }
        }
        if !modified {
            return Ok(());
        }

        // Handle encrypt_configs toggle: batch encrypt/decrypt profile files
        if patch.get("encrypt_configs").is_some() {
            let paths = ensure_app_storage(&app)
                .map_err(|e| format!("Failed to resolve app paths: {e}"))?;
            if guard.encrypt_configs {
                if let Err(e) = encrypt_all_profiles(&paths.profiles_dir) {
                    emit_warn!(
                        Core,
                        CORE_START_FAILED,
                        "Failed to encrypt some profiles: {e}"
                    );
                }
            } else if let Err(e) = decrypt_all_profiles(&paths.profiles_dir) {
                emit_warn!(
                    Core,
                    CORE_START_FAILED,
                    "Failed to decrypt some profiles: {e}"
                );
            }
        }

        // Handle log_app_enabled toggle: initialize writer or deactivate persistence
        if patch.get("log_app_enabled").is_some() {
            if guard.log_app_enabled {
                let paths = ensure_app_storage(&app)
                    .map_err(|e| format!("Failed to resolve app paths: {e}"))?;
                let app_log_dir = paths.app_data_dir.join("logs").join("app");
                if !backend_event::is_app_log_active() {
                    backend_event::init_app_log_writer(app_log_dir, guard.log_max_file_mb);
                } else {
                    backend_event::set_app_log_active(true);
                }
            } else {
                backend_event::set_app_log_active(false);
            }
        }

        // Handle log_core_enabled toggle
        if patch.get("log_core_enabled").is_some() {
            core_manager::core::LOG_CORE_ENABLED
                .store(guard.log_core_enabled, std::sync::atomic::Ordering::Relaxed);
        }

        // Update max file size if changed
        if patch.get("log_max_file_mb").is_some() {
            core_manager::core::LOG_MAX_FILE_MB
                .store(guard.log_max_file_mb, std::sync::atomic::Ordering::Relaxed);
            backend_event::set_app_log_max_file_mb(guard.log_max_file_mb);
        }

        guard.clone()
    };
    persist_settings(&app, &updated)
}

/// Atomically update a single proxy selection entry in settings.
/// Avoids the Read-Modify-Write race condition of fetching all settings,
/// mutating, and saving back.
/// v2: stores { group, node } as JSON; `group_name` is optional for backward compat.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn update_proxy_selection(
    app: tauri::AppHandle,
    state: tauri::State<SettingsState>,
    profile_name: String,
    node_name: String,
    group_name: Option<String>,
) -> Result<(), String> {
    // Validate inputs to prevent settings bloat from webview
    let safe_name = zephyr_core::config::sanitizer::sanitize_config_file_name(profile_name)
        .map_err(|e| e.to_string())?;
    if safe_name.len() > 256
        || node_name.len() > 256
        || group_name.as_ref().is_some_and(|g| g.len() > 256)
    {
        return Err("Profile name, node name or group name too long".to_owned());
    }
    let value = serde_json::json!({
        "node": node_name,
        "group": group_name,
    })
    .to_string();
    let settings = {
        let mut guard = state
            .0
            .lock()
            .map_err(|e| format!("Settings lock failed: {e}"))?;
        guard.last_proxy_selection.insert(safe_name, value);
        guard.clone()
    };
    persist_settings(&app, &settings)
}

/// Atomically update the primary group preference for a profile.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn update_primary_group_preference(
    app: tauri::AppHandle,
    state: tauri::State<SettingsState>,
    profile_name: String,
    group_name: String,
) -> Result<(), String> {
    let safe_name = zephyr_core::config::sanitizer::sanitize_config_file_name(profile_name)
        .map_err(|e| e.to_string())?;
    if safe_name.len() > 256 || group_name.len() > 256 {
        return Err("Profile name or group name too long".to_owned());
    }
    let settings = {
        let mut guard = state
            .0
            .lock()
            .map_err(|e| format!("Settings lock failed: {e}"))?;
        guard.primary_group_preference.insert(safe_name, group_name);
        guard.clone()
    };
    persist_settings(&app, &settings)
}

/// Atomically update the subscription User-Agent in settings.
/// Avoids Read-Modify-Write race condition.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn update_subscription_user_agent(
    app: tauri::AppHandle,
    state: tauri::State<SettingsState>,
    user_agent: Option<String>,
) -> Result<(), String> {
    let settings = {
        let mut guard = state
            .0
            .lock()
            .map_err(|e| format!("Settings lock failed: {e}"))?;
        guard.subscription_user_agent = user_agent.filter(|s| !s.is_empty());
        guard.clone()
    };
    persist_settings(&app, &settings)
}

/// Atomically update the last active config name in settings.
/// Avoids the Read-Modify-Write race condition of `GET_SETTINGS` → modify → `SAVE_SETTINGS`.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn update_last_config(
    app: tauri::AppHandle,
    state: tauri::State<SettingsState>,
    config_name: String,
) -> Result<(), String> {
    let safe_name = zephyr_core::config::sanitizer::sanitize_config_file_name(config_name)
        .map_err(|e| e.to_string())?;
    if safe_name.len() > 256 {
        return Err("Config name too long".to_owned());
    }
    let settings = {
        let mut guard = state
            .0
            .lock()
            .map_err(|e| format!("Settings lock failed: {e}"))?;
        guard.last_config = Some(safe_name);
        guard.clone()
    };
    persist_settings(&app, &settings)
}

/// Persist settings to settings.json (without touching in-memory state).
/// Used by `rename_config` to persist `last_config` changes.
///
/// NOTE: Settings are stored as plaintext JSON. Do NOT add sensitive fields
/// (tokens, passwords, API keys) to the `Settings` struct — use `crypto.rs`
/// obfuscation or the system keychain instead.
pub(crate) fn persist_settings(app: &tauri::AppHandle, settings: &Settings) -> Result<(), String> {
    let paths = core_manager::resolve_app_paths(app)?;
    let path = paths.app_data_dir;
    if !path.exists() {
        fs::create_dir_all(&path).map_err(|e| format!("Failed to create config dir: {e}"))?;
    }
    let file_path = path.join("settings.json");
    let json_str = serde_json::to_string(settings)
        .map_err(|e| format!("Failed to serialize settings: {e}"))?;
    core_manager::write_file_secure(&file_path, &json_str)
        .map_err(|e| format!("Failed to write settings.json: {e}"))?;
    Ok(())
}

/// Frontend heartbeat — called periodically by `main.js` to signal that
/// the webview is alive (Layer 2). If this stops arriving (3 consecutive
/// missed = 45 s), `is_webview_alive` returns `false` and the next
/// `show_main_window` / tray click will recreate the window.
///
/// Implementation: a single `AtomicI64` store — no lock, no allocation,
/// nanosecond-level cost.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn heartbeat(state: tauri::State<WebviewHealth>) {
    state
        .last_heartbeat_ms
        .store(monotonic_ms(), Ordering::Relaxed);
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn show_main_window(app: tauri::AppHandle) {
    show_or_recreate_main_window(&app);
}

/// Recreate the main window with the same configuration as `tauri.conf.json`.
/// Dimensions and properties mirror the config-defined window so that the
/// recreated window is visually identical to the original.
///
/// The `on_page_load` callback re-arms the `WebView2` crash recovery handler
/// (Layer 1) once the new webview finishes loading — this covers both the
/// initial creation and every subsequent recreation.
pub(crate) fn recreate_main_window(
    app: &tauri::AppHandle,
) -> Result<tauri::WebviewWindow, tauri::Error> {
    // Touch heartbeat immediately so that a show request arriving during
    // page load doesn't mistake the fresh webview for a dead one (which
    // would cause an infinite destroy→recreate loop). The `on_page_load`
    // callback will touch again once the page finishes loading.
    touch_heartbeat(app);

    #[cfg_attr(not(target_os = "windows"), allow(unused_variables))]
    let armed = std::sync::atomic::AtomicBool::new(false);
    let window_builder =
        tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::App("index.html".into()))
            .title("Zephyr")
            .inner_size(860.0, 620.0)
            .min_inner_size(720.0, 540.0)
            .center()
            .decorations(false)
            .visible(false)
            .on_page_load(move |webview_window, payload| {
                if payload.event() == tauri::webview::PageLoadEvent::Finished {
                    #[cfg(target_os = "windows")]
                    {
                        if !armed.swap(true, Ordering::Relaxed) {
                            if let Err(e) = webview_recovery::arm_crash_recovery(&webview_window) {
                                emit_error!(
                                    System,
                                    SYS_CRASH_RECOVERY_ARM_FAILED,
                                    "Failed to arm crash recovery: {e}"
                                );
                            }
                        }
                    }
                    // Reset heartbeat timestamp so Layer 2 doesn't falsely
                    // detect the fresh webview as dead during initialisation.
                    touch_heartbeat(webview_window.app_handle());
                }
            });

    #[cfg(not(target_os = "macos"))]
    #[allow(clippy::shadow_reuse)]
    let window_builder = window_builder.transparent(true);

    let window = window_builder.build()?;
    // Restore saved window state (position, size, maximized) if available.
    // Called while the window is still invisible to prevent a visual flash
    // from the default position/size before the saved state is applied.
    let _ = window.restore_state(WINDOW_STATE_FLAGS);
    Ok(window)
}

/// Get current system proxy and core status for tray state determination
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn get_tray_status(app: tauri::AppHandle) -> String {
    // Check if core is running
    let state = app.state::<MihomoState>();
    let core_running = state
        .0
        .lock()
        .map(|guard| guard.process().is_some())
        .unwrap_or(false);

    if !core_running {
        // Core not running, return default state
        return "default".to_owned();
    }

    // Check system proxy status using existing function
    let sys_proxy_enabled = sys_proxy::get_sys_proxy().unwrap_or(false);

    // Check TUN status from tray state
    let tun_enabled = app
        .state::<TrayState>()
        .0
        .lock()
        .map(|guard| guard.tun_enabled)
        .unwrap_or(false);

    if tun_enabled {
        return "tun".to_owned();
    }

    if sys_proxy_enabled {
        return "sysproxy".to_owned();
    }

    "default".to_owned()
}

// ---------------------------------------------------------------------------
// S5: Rate-limited wrappers for security-sensitive commands
// ---------------------------------------------------------------------------

#[tauri::command]
async fn rate_limited_send_notification(
    app: tauri::AppHandle,
    state: tauri::State<'_, RateLimiter>,
    title: String,
    body: String,
) -> Result<(), String> {
    rate_limit!(state, "send_notification", 1000);
    os_notification::send_notification(app, title, body)
}

#[tauri::command]
async fn rate_limited_register_shortcut(
    app: tauri::AppHandle,
    rate_limiter: tauri::State<'_, RateLimiter>,
    shortcut_state: tauri::State<'_, global_shortcut::ShortcutRegistry>,
    action: String,
    accelerator: String,
) -> Result<(), String> {
    rate_limit!(rate_limiter, "register_shortcut", 500);
    global_shortcut::register_shortcut(app, shortcut_state, action, accelerator)
}

#[tauri::command]
async fn rate_limited_unregister_shortcut(
    app: tauri::AppHandle,
    rate_limiter: tauri::State<'_, RateLimiter>,
    shortcut_state: tauri::State<'_, global_shortcut::ShortcutRegistry>,
    action: String,
) -> Result<(), String> {
    rate_limit!(rate_limiter, "unregister_shortcut", 500);
    global_shortcut::unregister_shortcut(app, shortcut_state, action)
}

/// Frontend log forwarding command.
///
/// Receives log entries from the frontend (console errors, toast
/// notifications, uncaught exceptions, unhandled Promise rejections) and
/// writes them to the app log via `emit_backend_event`.
///
/// The `source` parameter determines the error code:
/// - `"console"`       → `FRONTEND_CONSOLE`      (default)
/// - `"notification"` → `FRONTEND_NOTIFICATION`
/// - `"uncaught"`      → `FRONTEND_UNCAUGHT`
/// - `"rejection"`     → `FRONTEND_REJECTION`
///
/// **No backend-side rate limiting** -- the frontend (`frontend-log.js`)
/// already enforces a comprehensive limiter (50 non-error + 100 error
/// entries per 5 s window with content-hash dedup). A previous 5 ms
/// minimum-interval limiter here dropped legitimate startup logs that
/// arrived 1-2 ms apart (e.g. `get_settings` then `calling start_core`).
#[tauri::command]
#[allow(clippy::needless_pass_by_value, clippy::unnecessary_wraps)]
fn write_frontend_log(level: String, source: String, message: String) -> Result<(), String> {
    use crate::backend_event::codes;
    let code = match source.as_str() {
        "notification" => codes::FRONTEND_NOTIFICATION,
        "uncaught" => codes::FRONTEND_UNCAUGHT,
        "rejection" => codes::FRONTEND_REJECTION,
        _ => codes::FRONTEND_CONSOLE,
    };
    // Cap message length to prevent unbounded disk writes from oversized
    // stack traces or stringified circular objects. 16 KiB is generous
    // for any realistic log entry while protecting the log file.
    // Use is_char_boundary to avoid panicking when the cutoff lands
    // inside a multibyte UTF-8 character (e.g., CJK, emoji).
    const MAX_MESSAGE_LEN: usize = 16 * 1024;
    const TRUNCATION_SUFFIX: &str = "… [truncated]";
    let capped_message = if message.len() > MAX_MESSAGE_LEN {
        let mut end = MAX_MESSAGE_LEN - TRUNCATION_SUFFIX.len();
        while !message.is_char_boundary(end) {
            end -= 1;
        }
        format!("{}{}", &message[..end], TRUNCATION_SUFFIX)
    } else {
        message
    };
    crate::backend_event::write_frontend_log(&level, code, &capped_message);
    Ok(())
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn get_app_version() -> String {
    env!("CARGO_PKG_VERSION").to_owned()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
/// Expose portable mode status to the frontend
#[tauri::command]
fn get_portable_mode() -> bool {
    crate::core_manager::core::core_process::is_portable_mode()
}

/// Set UI scale factor (1.0 = 100%, 1.25 = 125%, etc.)
/// Persists to settings.json and returns the new scale value.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn set_ui_scale(app: tauri::AppHandle, scale: f64) -> Result<f64, String> {
    if !(0.5..=2.0).contains(&scale) {
        return Err("Scale must be between 0.5 and 2.0".to_owned());
    }
    let settings_state = app.state::<SettingsState>();
    let mut settings = settings_state.0.lock().map_err(|e| e.to_string())?;
    settings.ui_scale = scale;
    let settings_clone = settings.clone();
    drop(settings);
    persist_settings(&app, &settings_clone)?;
    Ok(scale)
}

// rust-analyzer cannot resolve proc-macro `tauri::generate_context!()` without OUT_DIR at IDE analysis time.
// This is a false positive — cargo build/clippy sets OUT_DIR correctly and compiles fine.
#[allow(rust_analyzer::proc_macro_unresolved)]
pub fn run() {
    #[cfg(target_os = "linux")]
    {
        let has_dri_access = std::fs::read_dir("/dev/dri")
            .map(|entries| {
                entries.flatten().any(|entry| {
                    let path = entry.path();
                    path.file_name()
                        .and_then(|n| n.to_str().map(|s| s.starts_with("render")))
                        .unwrap_or(false)
                        && std::fs::OpenOptions::new()
                            .read(true)
                            .write(true)
                            .open(&path)
                            .is_ok()
                })
            })
            .unwrap_or(false);

        if has_dri_access {
            if std::env::var("WEBKIT_FORCE_COMPOSITING_MODE").is_err() {
                // SAFETY: Called at application startup before any threads are spawned.
                unsafe {
                    std::env::set_var("WEBKIT_FORCE_COMPOSITING_MODE", "1");
                }
            }
        } else if std::env::var("WEBKIT_DISABLE_DMABUF_RENDERER").is_err() {
            // SAFETY: Same as above, single-threaded context.
            unsafe {
                std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
            }
        }

        if (std::env::var("WAYLAND_DISPLAY").is_ok()
            || std::env::var("XDG_SESSION_TYPE").as_deref() == Ok("wayland"))
            && std::env::var("GDK_BACKEND").is_err()
        {
            // SAFETY: Same as above, single-threaded context.
            unsafe {
                std::env::set_var("GDK_BACKEND", "wayland,x11");
            }
        }
    }

    // Setup panic hook to cleanup child processes
    let default_panic = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        emit_error!(
            Core,
            CORE_CRASHED,
            "Application panicked, cleaning up child processes..."
        );
        // Kill all mihomo processes on panic
        crate::core_manager::kill_mihomo();
        default_panic(info);
    }));

    // Flag to distinguish "user explicitly quit" from "window destroyed by lightweight mode".
    // When true, ExitRequested should NOT be prevented.
    let explicit_exit = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let explicit_exit_run = Arc::clone(&explicit_exit);

    let mut builder =
        tauri::Builder::default().manage(ExplicitExitFlag(Arc::clone(&explicit_exit)));

    #[cfg(desktop)]
    {
        // Skip autostart plugin in portable mode (path is not fixed)
        if !crate::core_manager::core::core_process::is_portable_mode() {
            builder = builder.plugin(AutostartBuilder::new().build());
        }
    }

    builder = builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(WINDOW_STATE_FLAGS)
                .build(),
        );

    // Single instance detection: only enabled in release builds.
    // In debug builds (pnpm run dev), multiple instances are allowed for testing.
    #[cfg(all(desktop, not(debug_assertions)))]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            // Focus the existing window, or recreate it if the webview is dead.
            show_or_recreate_main_window(app);
            // Forward deep link arguments from the second instance to the first.
            for arg in args {
                if arg.starts_with("clash://") {
                    deep_link::emit_deep_link(app, &arg);
                }
            }
        }));
    }

    builder = builder
        .manage(MihomoState(Mutex::new(CoreData::new())))
        .manage(TrayState::default())
        .manage(RateLimiter::new())
        .manage(ShortcutRegistry::default())
        .manage(WebviewHealth::default())
        .setup(|app| {
            backend_event::init_app_handle(app.handle());
            core_event_bridge::install_core_event_bridge();

            // Set AppUserModelId on Windows so notifications show "Zephyr" instead of "Windows PowerShell"
            #[cfg(target_os = "windows")]
            {
                use std::ffi::OsStr;
                use std::os::windows::ffi::OsStrExt as _;
                let app_id: Vec<u16> = OsStr::new("com.zephyr.desktop")
                    .encode_wide()
                    .chain(std::iter::once(0))
                    .collect();
                // SAFETY: SetCurrentProcessExplicitAppUserModelID is a Windows API that
                // takes a null-terminated wide string pointer. app_id is constructed with
                // a trailing zero via .chain(std::iter::once(0)), so it is valid.
                unsafe {
                    windows_sys::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID(
                        app_id.as_ptr(),
                    );
                }
            }

            let paths = ensure_app_storage(app.handle())?;
            // Initialize redaction paths for error message sanitization
            backend_event::init_redact_paths(
                paths.core_dir.to_str().unwrap_or(""),
                paths.profiles_dir.to_str().unwrap_or(""),
            );
            // Initialize TUN mode flag from config (before tray init so icon is correct)
            let _ = init_tun_mode_from_config(app.handle());
            let paths = core_manager::resolve_app_paths(app.handle())?;
            let config_dir = paths.app_data_dir;
            let settings_file = config_dir.join("settings.json");
            let settings = if settings_file.exists() {
                match fs::read_to_string(&settings_file) {
                    Ok(content) => {
                        // Deserialize to Value first, then convert to Settings.
                        // This allows migrate_settings to handle schema upgrades
                        // even if a future breaking change would prevent direct
                        // deserialization into Settings.
                        match serde_json::from_str::<serde_json::Value>(&content) {
                            Ok(v) => match serde_json::from_value::<Settings>(v) {
                                Ok(s) => migrate_settings(s, &settings_file),
                                Err(e) => handle_corrupt_settings(&settings_file, e),
                            },
                            Err(e) => handle_corrupt_settings(&settings_file, e),
                        }
                    }
                    Err(e) => {
                        // Read failure (transient I/O, permission, etc.) — do
                        // NOT treat as corruption. Return defaults without
                        // touching the file so the user's settings survive.
                        eprintln!("[Settings] Failed to read settings.json: {e}");
                        Settings {
                            close_to_tray: true,
                            log_retention_days: default_log_retention_days(),
                            log_max_file_mb: default_log_max_file_mb(),
                            copy_env_format: default_copy_env_format(),
                            schema_version: CURRENT_SCHEMA_VERSION,
                            ..Default::default()
                        }
                    }
                }
            } else {
                Settings {
                    close_to_tray: true, // 默认开启
                    ui_scale: 1.0,
                    log_retention_days: default_log_retention_days(),
                    log_max_file_mb: default_log_max_file_mb(),
                    copy_env_format: default_copy_env_format(),
                    schema_version: CURRENT_SCHEMA_VERSION,
                    ..Default::default()
                }
            };

            // Run automatic settings migration if needed
            let migrated_settings = migrate_settings(settings, &settings_file);

            app.manage(SettingsState(Arc::new(Mutex::new(migrated_settings))));

            // Initialize app log writer if log persistence is enabled
            {
                let settings_state = app.state::<SettingsState>();
                let guard = settings_state.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
                if guard.log_app_enabled {
                    let app_log_dir = config_dir.join("logs").join("app");
                    let app_log_dir_clone = app_log_dir.clone();
                    let retention_days = guard.log_retention_days;
                    std::thread::spawn(move || {
                        core_manager::core::log_writer::cleanup_old_logs(&app_log_dir_clone, retention_days);
                    });
                    backend_event::init_app_log_writer(app_log_dir, guard.log_max_file_mb);
                }
                if guard.log_core_enabled {
                    let core_log_dir = config_dir.join("logs").join("core");
                    let _ = fs::create_dir_all(&core_log_dir);
                    let retention_days = guard.log_retention_days;
                    std::thread::spawn(move || {
                        core_manager::core::log_writer::cleanup_old_logs(&core_log_dir, retention_days);
                    });
                    core_manager::core::LOG_CORE_ENABLED.store(true, std::sync::atomic::Ordering::Relaxed);
                    core_manager::core::LOG_MAX_FILE_MB.store(guard.log_max_file_mb, std::sync::atomic::Ordering::Relaxed);
                }
            }

            // Initialize Prism Engine extension
            app.manage(prism::PrismState::new(app.handle()));

            // Start subscription auto-update scheduler (each sub has its own interval in metadata)
            let scheduler_state = start_scheduler(app.handle().clone());
            app.manage(scheduler_state);

            // Start Network Change Coordinator (SSID/interface monitoring & single-flight auto-apply)
            let coordinator_handle = network_coordinator::start_coordinator(app.handle());
            app.manage(coordinator_handle);

            // Init Tray using the new tray module
            init_tray(app.handle())?;

            // Handle deep link URLs from command-line arguments
            // (protocol associations on Windows/macOS pass URLs via argv)
            deep_link::handle_cli_deep_links(app.handle());

            // Arm Layer 1 crash recovery for the initial window (created by
            // tauri.conf.json). `recreate_main_window` arms it via `on_page_load`,
            // but the initial window bypasses that path.
            #[cfg(target_os = "windows")]
            {
                if let Some(window) = app.get_webview_window("main") {
                    if let Err(e) = webview_recovery::arm_crash_recovery(&window) {
                        emit_error!(
                            System,
                            SYS_CRASH_RECOVERY_ARM_INITIAL,
                            "Failed to arm crash recovery for initial window: {e}"
                        );
                    }
                }
            }

            Ok(())
        })
        .on_window_event(move |window, event| {
            #[allow(clippy::wildcard_enum_match_arm)]
            match event {
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    let settings_state = window.state::<SettingsState>();
                    let (close_to_tray, lightweight_mode) = settings_state
                        .0
                        .lock()
                        .map(|guard| (guard.close_to_tray, guard.lightweight_mode))
                        .unwrap_or((true, false));

                    if close_to_tray {
                        api.prevent_close();
                        if lightweight_mode {
                            // Lightweight mode: destroy the WebView to free memory.
                            // The app stays alive in the tray because we prevent
                            // exit on ExitRequested. Tray click recreates the window.
                            let _ = window.destroy();
                        } else {
                            let _ = window.hide();
                        }
                    } else {
                        // User explicitly wants to quit
                        explicit_exit.store(true, std::sync::atomic::Ordering::SeqCst);
                        kill_mihomo();
                        let app = window.app_handle();
                        let _ = clear_sys_proxy(app);
                        app.cleanup_before_exit();
                        app.exit(0);
                    }
                }
tauri::WindowEvent::Destroyed => {
// Only invalidate the heartbeat if the main window is
// actually gone.  This prevents an asynchronous destroy
// event from the old window from invalidating the
// heartbeat of a newly recreated window.
if window.app_handle().get_webview_window("main").is_none() {
invalidate_heartbeat(window.app_handle());
}
}
                tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) => {
                    let app = window.app_handle();
                    if let Ok(storage_paths) = core_manager::ensure_app_storage(app) {
                        let mut imported_count = 0;
                        for path in paths {
                            let ext = std::path::Path::new(&path)
                                .extension()
                                .and_then(|e| e.to_str())
                                .unwrap_or("")
                                .to_lowercase();
                            if ext == "yaml" || ext == "yml" {
                                if let Ok(content) = std::fs::read_to_string(path) {
                                    if let Some(file_name) = std::path::Path::new(&path)
                                        .file_name()
                                        .and_then(|n| n.to_str())
                                    {
                                        // Sanitize file name to prevent path traversal
                                        let safe_name = match zephyr_core::config::sanitizer::sanitize_config_file_name(file_name.to_owned()) {
                                            Ok(name) => name,
                                            Err(_) => continue,
                                        };
                                        let target_path =
                                            storage_paths.profiles_dir.join(&safe_name);
                                        // Validate path stays within profiles dir
                                        if zephyr_core::config::sanitizer::validate_path_within_dir(&target_path, &storage_paths.profiles_dir).is_err() {
                                            continue;
                                        }
                                        // Sanitize dangerous keys (same as subscription import)
                                        let mut yaml_value: serde_yaml::Value = serde_yaml::from_str(&content)
                                            .unwrap_or(serde_yaml::Value::Null);
                                        zephyr_core::config::sanitizer::remove_dangerous_keys_internal_pub(&mut yaml_value, false);
                                        let sanitized_content = serde_yaml::to_string(&yaml_value)
                                            .unwrap_or(content);
                                        if core_manager::write_file_secure(&target_path, &sanitized_content)
                                            .is_ok()
                                        {
                                            imported_count += 1;
                                        }
                                    }
                                }
                            }
                        }
                        if imported_count > 0 {
                            crate::backend_event::emit_to_main(app, "profiles-imported", imported_count);
                        }
                    }
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_portable_mode,
            set_ui_scale,
            start_core,
            stop_core,
            list_configs,
            update_config_url,
            update_subscription_interval,
            update_subscription_ua,
            download_sub,
            download_sub_batch,
            delete_config,
            rename_config,
            get_latest_version,
            update_core,
            enable_sysproxy,
            disable_sysproxy,
            get_sys_proxy,
            has_sysproxy_ownership,
            restore_sys_proxy,
            get_settings,
            save_settings,
            patch_settings,
            update_proxy_selection,
            update_primary_group_preference,
            update_subscription_user_agent,
            update_last_config,
            get_core_version,
            get_core_uptime,
            exempt_uwp_apps,
            read_config_file,
            write_config_file,
            open_config_folder,
            open_log_folder,
            export_logs,
            show_main_window,
            change_tray_icon,
            get_tray_status,
            update_tray_full_menu,
            read_config,
            update_config,
            update_geo_data,
            get_latest_client_versions,
            get_latest_client_version,
            update_client,
            fetch_text,
            restart_core_as_root_cmd,
            set_tun_enabled,
            kill_all_mihomo_as_root_cmd,
            disable_tun_cmd,
            grant_linux_tun_permission,
            core_manager::core::tun_manager::apply_windows_tcp_optimizations,
            // Network Optimization commands
            core_manager::core::network_optim::apply_network_optimizations,
            core_manager::core::network_optim::revert_network_optimizations,
            core_manager::core::network_optim::check_network_optimizations_status,
            // Re-export tray commands
            tray::get_tray_menu_state,
            tray::set_tray_menu_state,
            tray::get_tray_proxy_status,
            tray::update_tray_toggle_states,
            // Core commands — full path required for generate_handler! macro (__cmd_ symbol resolution)
            core_manager::core::crypto::is_machine_key_persisted,
            core_manager::core::tun_manager::release_tun_toggle,
            core_manager::core::core_log::read_core_log,
            // Global shortcut commands (rate-limited wrappers)
            rate_limited_register_shortcut,
            rate_limited_unregister_shortcut,
            // Backup & restore
            backup::export_backup,
            backup::import_backup,
            // OS notification command (rate-limited wrapper)
            rate_limited_send_notification,
            get_app_version,
            heartbeat,
write_frontend_log,
            // Prism Engine commands
            prism::prism_apply,
            prism::prism_status,
            prism::prism_list_rules,
            prism::prism_preview_rules,
            prism::prism_get_last_trace,
            prism::prism_is_prism_rule,
            prism::prism_insert_rule,
            prism::prism_insert_rule_str,
            prism::prism_toggle_group,
            prism::prism_trace_report,
            prism::prism_trace_report_text,
            prism::prism_validate_config,
            prism::prism_list_profiles,
            prism::prism_get_core_info,
            prism::prism_start_watching,
            prism::prism_stop_watching,
            prism::prism_is_watching,
            prism::prism_get_stats,
            prism::prism_read_raw_profile,
            prism::prism_rebuild,
            // Rule Library (R2) commands
            prism::open_prism_folder,
            prism::rule_list,
            prism::rule_read,
            prism::rule_create,
            prism::rule_update,
            prism::rule_delete,
            prism::rule_rename,
            prism::rule_extract_from_profile,
            prism::rule_import_text,
            prism::rule_import_file,
            prism::rule_import_url,
            prism::rule_group_list,
            prism::rule_group_create,
            prism::rule_group_rename,
            prism::rule_group_delete,
            prism::rule_group_move,
            prism::rule_get_auto_apply,
            prism::rule_set_auto_apply,
            // Plugin System commands
            prism::plugin_discover,
            prism::plugin_load,
            prism::plugin_unload,
            prism::plugin_enable,
            prism::plugin_delete,
            prism::plugin_list_loaded,
            // Script Engine commands
            prism::script_execute,
            prism::script_validate,
            prism::script_execute_write,
            // Override System commands
            prism::override_list,
            prism::override_create,
            prism::override_update,
            prism::override_delete,
            prism::override_get_content,
            prism::override_set_content,
            prism::override_reorder,
            prism::override_toggle,
            prism::override_test,
            prism::override_refresh_remote,
            prism::override_apply_all,
            prism::override_export,
            prism::override_import,
            // Smart Proxy Selector commands
            prism::smart_score,
            prism::smart_config,
            prism::smart_config_save,
            prism::smart_next_interval,
            prism::smart_rank,
            prism::smart_select_best,
            prism::smart_clear_history,
            // Smart additional
            prism::smart_score_at,
            prism::smart_validate_config,
            prism::smart_scheduler_config,
            core_manager::core::subscription_scheduler::get_scheduler_status,
            core_manager::core::subscription_scheduler::trigger_auto_update,
            prism::smart_trim_history,
            // Failover
            prism::failover_report,
            prism::failover_get_policy,
            prism::failover_set_policy,
            prism::failover_failure_count,
            prism::failover_reset,
            // KvStore
            prism::kv_get,
            prism::kv_set,
            prism::kv_delete,
            prism::kv_keys,
            // Trace advanced
            prism::trace_statistics,
            prism::trace_filter_by_source,
            // Plugin additional
            prism::plugin_execute_hook,
            prism::plugin_list_hooks,
            prism::plugin_check_permission,
            prism::plugin_execute,
            prism::plugin_list_permissions,
            // Script additional
            prism::script_get_sandbox,
            prism::script_set_sandbox,
            prism::script_get_limits,
            prism::script_set_limits,
            prism::script_grant_plugin,
            prism::script_revoke_plugin,
            prism::script_check_plugin_permission,
            prism::script_is_sandbox_safe,
            // Network Coordinator commands
            network_coordinator::get_network_state,
            network_coordinator::notify_network_change,
        ]);

    #[allow(clippy::expect_used)]
    let app = builder
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(move |handle, event| {
        match event {
            tauri::RunEvent::ExitRequested { api, .. } => {
                // Prevent the app from exiting when all windows are closed
                // (lightweight mode destroys the WebView, close-to-tray hides it).
                // Only allow exit when the user explicitly quits (tray "Quit" or
                // close button with close_to_tray disabled).
                if !explicit_exit_run.load(std::sync::atomic::Ordering::SeqCst) {
                    api.prevent_exit();
                }
            }
            tauri::RunEvent::Exit => {
                // Signal scheduler to shutdown gracefully
                if let Some(scheduler_state) = handle
                    .try_state::<Arc<core_manager::core::subscription_scheduler::SchedulerState>>()
                {
                    scheduler_state.shutdown();
                }
                kill_mihomo();
                // Smart kill: only prompts for password if there's actually a root mihomo running
                let _ = smart_kill_all_mihomo_as_root();
            }
            tauri::RunEvent::Resumed => {
                // System woke up from sleep. The mihomo core's TCP connections
                // are likely stale or dead. Spawn an async task to:
                // 1. Probe the core API (health check).
                // 2. If unreachable, restart the core with the last-known config.
                let app_handle = handle.clone();
                tauri::async_runtime::spawn(async move {
                    handle_system_resume(&app_handle).await;
                });
            }
            tauri::RunEvent::Ready
            | tauri::RunEvent::MainEventsCleared
            | tauri::RunEvent::WindowEvent { .. }
            | tauri::RunEvent::WebviewEvent { .. }
            | tauri::RunEvent::MenuEvent(_)
            | tauri::RunEvent::TrayIconEvent(_)
            | _ => {}
        }
    });
}

/// Handle system resume from sleep.
///
/// After waking from sleep, the mihomo core's TCP connections are often stale
/// or dead. This function:
/// 1. Reads the last-known core port from `MihomoState`.
/// 2. Probes the core API via a lightweight TCP connect.
/// 3. If unreachable after 3 attempts (3s), restarts the core using the
///    last-known config path and custom args.
///
/// All steps emit backend events so the frontend can show status.
async fn handle_system_resume(app: &tauri::AppHandle) {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::Duration;
    use tokio::io::AsyncReadExt as _;
    use tokio::io::AsyncWriteExt as _;
    use tokio::net::TcpStream;

    /// Guard: prevents concurrent resume handlers from racing.
    /// Multiple `Resumed` events can fire in rapid succession on some OSes.
    static RESUME_IN_PROGRESS: AtomicBool = AtomicBool::new(false);
    if RESUME_IN_PROGRESS.swap(true, Ordering::SeqCst) {
        return; // Another resume handler is already running.
    }

    /// Drop guard: resets the flag when the handler completes (or panics).
    struct ResumeGuard;
    impl Drop for ResumeGuard {
        fn drop(&mut self) {
            RESUME_IN_PROGRESS.store(false, Ordering::SeqCst);
        }
    }
    let _guard = ResumeGuard;

    crate::emit_info!(
        System,
        SYS_RESUMED_HEALTH_CHECK,
        "System resumed from sleep — checking core health"
    );

    // Notify Network Change Coordinator that system woke from sleep.
    // Use try_notify (non-blocking) so a full channel cannot delay the
    // subsequent resume health check.
    if let Some(coordinator) = app.try_state::<network_coordinator::NetworkCoordinatorHandle>() {
        coordinator.try_notify(network_coordinator::NetworkChangeReason::Resume);
    }

    // Read the last-known core port + config from MihomoState.
    let (port, config_path, custom_args) = {
        let state = app.state::<MihomoState>();
        let guard = state
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        (
            guard.last_port(),
            guard.last_config_path().map(str::to_owned),
            guard.last_custom_args().map(<[String]>::to_vec),
        )
    };

    let Some(core_port) = port else {
        // Core was never started — nothing to do.
        return;
    };

    // Probe: try TCP connect + HTTP request, 3 attempts with 1s delay.
    // Each operation has a 2s timeout to avoid hanging if the OS accepts
    // connections but the process is frozen (common after sleep/wake).
    let request =
        format!("GET / HTTP/1.1\r\nHost: 127.0.0.1:{core_port}\r\nConnection: close\r\n\r\n");
    let mut healthy = false;
    for i in 0..3 {
        let connect_result = tokio::time::timeout(
            Duration::from_secs(2),
            TcpStream::connect((std::net::Ipv4Addr::new(127, 0, 0, 1), core_port)),
        )
        .await;

        if let Ok(Ok(mut stream)) = connect_result {
            let write_result =
                tokio::time::timeout(Duration::from_secs(2), stream.write_all(request.as_bytes()))
                    .await;
            if matches!(write_result, Ok(Ok(()))) {
                let mut buf = [0u8; 128];
                let read_result =
                    tokio::time::timeout(Duration::from_secs(2), stream.read(&mut buf)).await;
                if let Ok(Ok(n)) = read_result {
                    let resp = buf.get(..n).unwrap_or(&[]);
                    if resp.starts_with(b"HTTP/1.1 200")
                        || resp.starts_with(b"HTTP/1.1 401")
                        || resp.starts_with(b"HTTP/1.0 200")
                        || resp.starts_with(b"HTTP/1.0 401")
                    {
                        healthy = true;
                        break;
                    }
                }
            }
        }
        // Skip the sleep on the final iteration to reduce restart downtime.
        if i < 2 {
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    }

    if healthy {
        crate::emit_info!(
            System,
            SYS_RESUMED_CORE_HEALTHY,
            "Core health check passed after resume — no action needed"
        );
        return;
    }

    // Core is unresponsive — restart it.
    // start_core_inner already handles stopping the old core process
    // via spawn_blocking internally, so no manual stop is needed here.
    crate::emit_warn!(
        System,
        SYS_RESUMED_CORE_RESTART,
        "Core unresponsive after resume — restarting"
    );

    // Restart with the last-known config.
    let config = config_path.unwrap_or_else(|| "config.yaml".to_owned());
    let args = custom_args.unwrap_or_default();
    let state = app.state::<MihomoState>();
    if let Err(e) = core_manager::core::core_process::start_core_inner(
        app.clone(),
        state,
        config,
        false,
        args,
        None,
        Some(true), // Force restart: the old process may still be alive but unresponsive
    )
    .await
    {
        crate::emit_error!(
            System,
            SYS_RESUMED_CORE_RESTART,
            "Failed to restart core after resume: {e}"
        );
    } else {
        // Core restarted successfully. start_core_inner already notifies the
        // coordinator with a Manual event, so no duplicate notification here.
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread;
    use std::time::Duration;

    #[test]
    fn test_rate_limiter_allows_first_call() {
        let limiter = RateLimiter::new();
        assert!(limiter.check_rate_limit("test_cmd", 1000));
    }

    #[test]
    fn test_rate_limiter_blocks_rapid_calls() {
        let limiter = RateLimiter::new();
        assert!(limiter.check_rate_limit("rapid_cmd", 500));
        assert!(!limiter.check_rate_limit("rapid_cmd", 500));
    }

    #[test]
    fn test_rate_limiter_allows_after_interval() {
        let limiter = RateLimiter::new();
        assert!(limiter.check_rate_limit("delayed_cmd", 50));
        assert!(!limiter.check_rate_limit("delayed_cmd", 50));
        thread::sleep(Duration::from_millis(60));
        assert!(limiter.check_rate_limit("delayed_cmd", 50));
    }

    #[test]
    fn test_rate_limiter_different_keys_independent() {
        let limiter = RateLimiter::new();
        assert!(limiter.check_rate_limit("cmd_a", 500));
        assert!(limiter.check_rate_limit("cmd_b", 500));
        assert!(!limiter.check_rate_limit("cmd_a", 500));
        assert!(!limiter.check_rate_limit("cmd_b", 500));
        assert!(limiter.check_rate_limit("cmd_c", 500));
    }
}
