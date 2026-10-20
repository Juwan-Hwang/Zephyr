//! Tray icon and menu management
//!
//! This module handles:
//! - Tray icon display and state changes
//! - Context menu with proxy controls
//! - Left-click to show window, right-click to show menu

use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use tauri::{
    image::Image,
    menu::{MenuBuilder, MenuItem, PredefinedMenuItem, SubmenuBuilder},
    tray::TrayIconBuilder,
    AppHandle, Manager as _,
};

use crate::core_manager::core::ProxyEndpoint;
use crate::core_manager::MihomoState;
use crate::sys_proxy;

/// Tray menu state for tracking check states
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TrayMenuState {
    pub sys_proxy_enabled: bool,
    pub tun_enabled: bool,
    pub current_mode: String,
    pub active_config: Option<String>,
    pub active_proxy: Option<String>,
    /// i18n labels for `rebuild_tray_menu_from_state` (lightweight mode)
    #[serde(default)]
    pub labels: TrayLabels,
}

/// Localized labels stored in `TrayMenuState` so the Rust-side
/// `rebuild_tray_menu_from_state` can display the correct language
/// even when the frontend/WebView is not available (lightweight mode).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrayLabels {
    pub show: String,
    pub quit: String,
    pub sys_proxy: String,
    pub tun_mode: String,
    pub rule: String,
    pub global: String,
    pub direct: String,
    pub copy_env: String,
}

impl Default for TrayLabels {
    fn default() -> Self {
        Self {
            show: "Show Zephyr".to_owned(),
            quit: "Quit".to_owned(),
            sys_proxy: "System Proxy".to_owned(),
            tun_mode: "TUN Mode".to_owned(),
            rule: "Rule".to_owned(),
            global: "Global".to_owned(),
            direct: "Direct".to_owned(),
            copy_env: "Copy Proxy Env".to_owned(),
        }
    }
}

/// Wrapper for tray state to work with Tauri's State
pub struct TrayState(pub Arc<Mutex<TrayMenuState>>);

impl Default for TrayState {
    fn default() -> Self {
        Self(Arc::new(Mutex::new(TrayMenuState::default())))
    }
}

/// Configuration info for subscription list
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConfigInfo {
    pub name: String,
    pub is_active: bool,
}

/// Proxy group info for tray menu
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProxyGroupInfo {
    pub name: String,
    #[serde(rename = "type")]
    pub group_type: String,
    pub now: String,
    pub proxies: Vec<ProxyInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProxyInfo {
    pub name: String,
    #[serde(rename = "alive")]
    pub is_alive: Option<bool>,
}

/// Get current tray state
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn get_tray_menu_state(app: AppHandle) -> Result<TrayMenuState, String> {
    let state = app.state::<TrayState>();
    let guard = state
        .0
        .lock()
        .map_err(|e| format!("Failed to lock tray state: {e}"))?;
    Ok(guard.clone())
}

/// Update tray menu state
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn set_tray_menu_state(app: AppHandle, new_state: TrayMenuState) -> Result<(), String> {
    let tray_state = app.state::<TrayState>();
    let mut guard = tray_state
        .0
        .lock()
        .map_err(|e| format!("Failed to lock tray state: {e}"))?;
    *guard = new_state;
    drop(guard);
    Ok(())
}

/// The last claimed tray icon update: its generation, together with the
/// mode that claim asked for, in a single lock-protected record so the
/// two are never read or written apart. A refresh reads the proxy status
/// slowly (it can shell out), so it snapshots the generation first and
/// claims the next one — under the same lock, leaving the record
/// untouched when the snapshot is stale — only if no other writer (a
/// proxy toggle, the frontend, init) has claimed one in the meantime;
/// otherwise its now-stale icon would land on top of the fresher one.
///
/// Claiming alone cannot order the icon writes themselves: `set_icon`
/// runs on the main thread and waits for it, so holding a lock across
/// it could deadlock against a main-thread caller waiting for the same
/// lock, and a writer can still be mid-apply when a newer claim lands.
/// After applying, a writer that finds a newer claim re-applies that
/// claim's mode. The correction is sent after its own stale write, and
/// the newer writer's write lands either before it (the correction
/// repeats the same icon) or after it (it wins directly): either way
/// the last write on the tray is the newest claimed mode. The lock is
/// only ever held for the record update itself, never across `set_icon`.
static TRAY_ICON_CLAIM: Mutex<(u64, String)> = Mutex::new((0, String::new()));

fn lock_tray_icon_claim() -> std::sync::MutexGuard<'static, (u64, String)> {
    TRAY_ICON_CLAIM
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Record `mode` as the newest claim and publish its generation.
fn claim_tray_icon(mode: &str) -> u64 {
    let mut claim = lock_tray_icon_claim();
    claim.0 += 1;
    mode.clone_into(&mut claim.1);
    claim.0
}

/// The newest claim: its generation and the mode it asked for.
fn claimed_tray_icon() -> (u64, String) {
    let claim = lock_tray_icon_claim();
    (claim.0, claim.1.clone())
}

/// Pick the idle (no proxy mode active) tray icon for the current platform.
///
/// - macOS: a pure-black template image. The system tints template images
///   to match the menu bar, so it must be applied with
///   `set_icon_as_template(true)`.
/// - Windows: a plain glyph on transparency — ink for light taskbars, white
///   for dark ones. The taskbar follows the *system* colour mode
///   (`SystemUsesLightTheme` in the registry), which Windows keeps separate
///   from the *app* colour mode that `window.theme()` reports, so the
///   registry value is the source of truth here.
/// - Other platforms: the full app icon tile, as before.
// Not a `const fn` on Windows, where the body reads the registry at
// runtime; the lint only sees the constant-looking fallback body on
// platforms where the other branches are compiled out.
#[allow(clippy::missing_const_for_fn)]
fn idle_tray_icon(app: &AppHandle) -> (&'static [u8], bool) {
    #[cfg(target_os = "macos")]
    {
        let _ = app;
        (include_bytes!("../icons/tray-idle-template.png"), true)
    }
    #[cfg(target_os = "windows")]
    {
        if windows_taskbar_uses_dark_mode(app) {
            (include_bytes!("../icons/tray-idle-dark.png"), false)
        } else {
            (include_bytes!("../icons/tray-idle-light.png"), false)
        }
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = app;
        #[allow(clippy::large_include_file)]
        let bytes: &[u8] = include_bytes!("../icons/icon.png");
        (bytes, false)
    }
}

/// The taskbar colour mode from the registry, when it can be read:
/// `Some(true)` for a light taskbar, `Some(false)` for a dark one.
#[cfg(target_os = "windows")]
fn system_uses_light_theme() -> Option<bool> {
    winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER)
        .open_subkey(r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize")
        .and_then(|key| key.get_value::<u32, _>("SystemUsesLightTheme"))
        .ok()
        .map(|value| value == 1)
}

/// Whether the Windows taskbar is in dark mode.
///
/// Reads `SystemUsesLightTheme` from the Personalize key. When the value
/// cannot be read, fall back to the main window's theme (the app colour
/// mode — not always the taskbar's, but the closest available signal),
/// and then to light: consumer editions of Windows 11 ship with a light
/// taskbar by default (only the commercial editions default to dark).
#[cfg(target_os = "windows")]
fn windows_taskbar_uses_dark_mode(app: &AppHandle) -> bool {
    match system_uses_light_theme() {
        Some(light) => !light,
        None => app
            .get_webview_window("main")
            .and_then(|window| window.theme().ok())
            .is_some_and(|theme| theme == tauri::Theme::Dark),
    }
}

/// Apply the tray icon for `mode`: "tun", "sysproxy", or idle for anything else.
pub fn apply_tray_icon(app: &AppHandle, mode: &str) -> Result<(), String> {
    // Claim the newest generation: any refresh still holding an older
    // snapshot will now skip applying its stale result.
    let generation = claim_tray_icon(mode);
    apply_tray_icon_reconciled(app, generation, mode)
}

/// Apply the icon for a claim, then keep re-applying the newest claimed
/// mode for as long as newer claims landed while an apply was in flight,
/// so a stale write never stays on the tray (see `TRAY_ICON_CLAIM`).
fn apply_tray_icon_reconciled(
    app: &AppHandle,
    mut generation: u64,
    initial_mode: &str,
) -> Result<(), String> {
    let mut mode = initial_mode.to_owned();
    loop {
        let result = apply_tray_icon_now(app, &mode);
        let (latest_generation, latest_mode) = claimed_tray_icon();
        if latest_generation == generation {
            return result;
        }
        generation = latest_generation;
        mode = latest_mode;
    }
}

fn apply_tray_icon_now(app: &AppHandle, mode: &str) -> Result<(), String> {
    let tray = app
        .tray_by_id("main")
        .ok_or_else(|| "Tray icon not found".to_owned())?;

    #[allow(clippy::large_include_file)]
    let (icon_bytes, as_template): (&[u8], bool) = match mode {
        "tun" => (include_bytes!("../icons/tray-tun.png"), false),
        "sysproxy" => (include_bytes!("../icons/tray-proxy.png"), false),
        _ => idle_tray_icon(app),
    };

    let image = Image::from_bytes(icon_bytes).map_err(|e| format!("Failed to load icon: {e}"))?;

    tray.set_icon(Some(image))
        .map_err(|e| format!("Failed to set icon: {e}"))?;

    // Template images only exist on macOS. The coloured state icons must
    // explicitly leave template mode again, otherwise the system would
    // tint them monochrome.
    #[cfg(target_os = "macos")]
    tray.set_icon_as_template(as_template)
        .map_err(|e| format!("Failed to set icon template mode: {e}"))?;
    #[cfg(not(target_os = "macos"))]
    let _ = as_template;

    Ok(())
}

/// Re-read the proxy status and re-apply the tray icon for it, unless a
/// newer icon update landed while the status was being read. Callers run
/// this off the window event thread (see the theme handler in lib.rs):
/// the status lookup can shell out, but that gap must not let this
/// refresh overwrite a fresher icon with the mode it read earlier.
pub fn refresh_tray_icon(app: &AppHandle) {
    let snapshot = lock_tray_icon_claim().0;
    let mode = get_tray_proxy_status(app.clone()).unwrap_or_else(|_| "default".to_owned());
    // Claim the next generation only if it is still the snapshot's, under
    // the same lock that records the mode: a fresher writer that claimed
    // in the meantime keeps its record untouched, so this stale refresh
    // leaves nothing behind that a later correction could apply.
    let generation = {
        let mut claim = lock_tray_icon_claim();
        if claim.0 != snapshot {
            return;
        }
        claim.0 += 1;
        mode.clone_into(&mut claim.1);
        claim.0
    };
    let _ = apply_tray_icon_reconciled(app, generation, &mode);
}

/// Watch the Windows taskbar colour mode for the app's whole lifetime.
///
/// The window-event handlers in `lib.rs` cannot cover a taskbar-only
/// change while the main window is hidden to the tray or destroyed in
/// lightweight mode — exactly when the tray icon is the only visible
/// surface — because both handlers need an event from that window. This
/// watcher is app-level instead: it polls the registry value (a cheap
/// local read) and refreshes the icon when the value flips. The refresh
/// goes through the same generation claim as every other icon update,
/// so it never overwrites a fresher mode.
#[cfg(target_os = "windows")]
pub fn watch_windows_taskbar_theme(app: AppHandle) {
    std::thread::spawn(move || {
        let mut last = system_uses_light_theme();
        loop {
            std::thread::sleep(std::time::Duration::from_secs(2));
            let current = system_uses_light_theme();
            if current.is_some() && current != last {
                last = current;
                refresh_tray_icon(&app);
            }
        }
    });
}

/// Change tray icon based on mode
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn change_tray_icon(app: AppHandle, mode: String) -> Result<(), String> {
    apply_tray_icon(&app, mode.as_str())
}

/// Get current proxy mode for tray status
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn get_tray_proxy_status(app: AppHandle) -> Result<String, String> {
    // TUN-aware: a macOS root TUN core has no `Child` handle.
    if !crate::core_manager::core::subscription::is_core_running(&app) {
        return Ok("stopped".to_owned());
    }

    let sys_proxy_enabled = sys_proxy::get_sys_proxy().unwrap_or(false);

    // Check the live TUN state: the TUN commands record the running
    // core's state in the settings state as soon as the core confirms a
    // change, and an override hot-reload records its confirmed state as
    // the live override that outranks it. `run_config.yaml` can lag
    // behind that record — the flows that apply TUN to the core
    // themselves record it without rewriting the file, which then only
    // catches up at the next core start — and a refresh reading the
    // file would restore the pre-toggle icon. The file is only the
    // fallback for when no live state has been recorded.
    let tun_enabled = effective_tun_enabled(&app);

    if tun_enabled {
        Ok("tun".to_owned())
    } else if sys_proxy_enabled {
        Ok("sysproxy".to_owned())
    } else {
        Ok("running".to_owned())
    }
}

/// The TUN state recorded for the running core, when one has been
/// recorded this session (or loaded from the saved preference at
/// startup, which the core start that follows is driven by).
///
/// A live override the running core confirmed after an override
/// hot-reload outranks the saved preference: the preference is the
/// user's own choice for the *next* start, while the override is what
/// this core is actually running.
fn live_tun_enabled(app: &AppHandle) -> Option<bool> {
    if let Some(live) = crate::core_manager::core::tun_manager::live_tun_override() {
        return Some(live);
    }
    let settings_state = app.state::<crate::SettingsState>();
    let guard = settings_state
        .0
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    guard.tun_enabled
}

/// The TUN state every tray status and icon consumer agrees on: the
/// live recorded state when there is one, otherwise the state in
/// `run_config.yaml` (what the running core was last made to load).
/// `TrayState.tun_enabled` is only the frontend-fed menu state and can
/// diverge from both, so icon and status decisions must not read it.
pub(crate) fn effective_tun_enabled(app: &AppHandle) -> bool {
    live_tun_enabled(app).unwrap_or_else(|| get_tun_status_from_config(app).unwrap_or(false))
}

/// Get TUN status from config file
/// `run_config.yaml` is what Mihomo loaded at core start, so it only
/// reflects the state as of that start
fn get_tun_status_from_config(app: &AppHandle) -> Result<bool, String> {
    let paths = crate::core_manager::ensure_app_storage(app)?;
    let run_config_path = paths.core_dir.join("run_config.yaml");

    if !run_config_path.exists() {
        return Ok(false);
    }

    let content = std::fs::read_to_string(&run_config_path)
        .map_err(|e| format!("Failed to read run_config.yaml: {e}"))?;

    let yaml: serde_yaml::Value =
        serde_yaml::from_str(&content).map_err(|e| format!("Failed to parse YAML: {e}"))?;

    // Check tun.enable in config
    Ok(yaml
        .get("tun")
        .and_then(|tun| tun.get("enable"))
        .and_then(serde_yaml::Value::as_bool)
        .unwrap_or(false))
}

/// Initialize tray with left-click to show window, right-click for menu
pub fn init_tray(app: &AppHandle) -> Result<(), String> {
    // Build initial simple menu using MenuBuilder
    let show_i = MenuItem::with_id(app, "show", "Show", true, None::<&str>)
        .map_err(|e| format!("Failed to create show menu item: {e}"))?;

    let quit_i = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)
        .map_err(|e| format!("Failed to create quit menu item: {e}"))?;

    let sep = PredefinedMenuItem::separator(app)
        .map_err(|e| format!("Failed to create separator: {e}"))?;

    let menu = MenuBuilder::new(app)
        .item(&show_i)
        .item(&sep)
        .item(&quit_i)
        .build()
        .map_err(|e| format!("Failed to create menu: {e}"))?;

    let mut tray_builder = TrayIconBuilder::with_id("main")
        .menu(&menu)
        .show_menu_on_left_click(false) // Don't show menu on left click
        .on_menu_event(|app, event| {
            handle_menu_event(app, event.id.as_ref());
        })
        .on_tray_icon_event(|tray, event| {
            if let tauri::tray::TrayIconEvent::Click { button, .. } = event {
                if button == tauri::tray::MouseButton::Left {
                    // Left click: show or recreate main window
                    let app = tray.app_handle();
                    show_or_recreate_window(app);
                }
            }
        });

    if let Some(default_icon) = app.default_window_icon() {
        tray_builder = tray_builder.icon(default_icon.clone());
    }

    tray_builder
        .build(app)
        .map_err(|e| format!("Failed to build tray: {e}"))?;

    // Start from the platform's idle icon (template image on macOS,
    // theme-matched glyph on Windows) instead of the window icon.
    let _ = apply_tray_icon(app, "default");

    Ok(())
}

/// Show the main window, or recreate it if it was destroyed (lightweight mode)
/// or if the webview is dead (detected via stale heartbeat).
fn show_or_recreate_window(app: &AppHandle) {
    crate::show_or_recreate_main_window(app);
}

/// Resolve the shell format, falling back to a platform-appropriate default when empty.
///
/// - Empty string → `"powershell"` on Windows, `"bash"` elsewhere.
/// - Non-empty string → returned as-is (caller normalizes case via `format_proxy_env`).
#[must_use]
pub(crate) const fn resolve_proxy_format(format: &str) -> &str {
    if format.is_empty() {
        if cfg!(target_os = "windows") {
            "powershell"
        } else {
            "bash"
        }
    } else {
        format
    }
}

/// Format proxy environment variables for the given shell format and port.
///
/// Linux/macOS shells export both lowercase and uppercase proxy variables
/// for maximum CLI tool compatibility (curl/wget read lowercase, Go reads uppercase).
/// cmd is Windows-only (case-insensitive, single set).
/// PowerShell/NuShell are cross-platform; on macOS/Linux env vars are case-sensitive,
/// so both lowercase and uppercase are set for compatibility.
#[must_use]
pub(crate) fn format_proxy_env(format: &str, endpoint: ProxyEndpoint) -> String {
    // Use the scheme the listener actually speaks. A configuration exposing only
    // `socks-port` has no HTTP listener, so emitting `http://` variables here
    // would hand the user a proxy setting that cannot connect.
    let proxy = endpoint.proxy_url();
    match format.to_ascii_lowercase().as_str() {
        "fish" => format!(
            "set -x http_proxy {proxy}; set -x https_proxy {proxy}; set -x all_proxy {proxy}; set -x HTTP_PROXY {proxy}; set -x HTTPS_PROXY {proxy}; set -x ALL_PROXY {proxy}"
        ),
        "cmd" => format!(
            "set http_proxy={proxy}&set https_proxy={proxy}&set all_proxy={proxy}"
        ),
        "powershell" => format!(
            "$env:http_proxy=\"{proxy}\"; $env:https_proxy=\"{proxy}\"; $env:all_proxy=\"{proxy}\"; $env:HTTP_PROXY=\"{proxy}\"; $env:HTTPS_PROXY=\"{proxy}\"; $env:ALL_PROXY=\"{proxy}\""
        ),
        "nushell" => format!(
            "$env.http_proxy = \"{proxy}\"; $env.https_proxy = \"{proxy}\"; $env.all_proxy = \"{proxy}\"; $env.HTTP_PROXY = \"{proxy}\"; $env.HTTPS_PROXY = \"{proxy}\"; $env.ALL_PROXY = \"{proxy}\""
        ),
        _ => format!(
            "export http_proxy={proxy} https_proxy={proxy} all_proxy={proxy} HTTP_PROXY={proxy} HTTPS_PROXY={proxy} ALL_PROXY={proxy}"
        ),
    }
}

/// Copy proxy environment variables to clipboard.
/// Used by the tray "Copy Proxy Env" menu item.
/// Handles clipboard write directly in Rust — on Linux, `WebKit2GTK`
/// requires window focus for navigator.clipboard, which isn't guaranteed
/// when clicking from the tray menu.
fn copy_proxy_env_to_clipboard(app: &AppHandle) -> Result<(), String> {
    // Get copy_env_format from settings
    let settings_state = app.state::<crate::SettingsState>();
    let format = settings_state
        .0
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .copy_env_format
        .clone();

    // Get the managed proxy endpoint (port *and* scheme) from core state
    let mihomo_state = app.state::<MihomoState>();
    let endpoint = mihomo_state
        .0
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .last_proxy_endpoint()
        .ok_or_else(|| "No managed proxy endpoint is configured; nothing to copy".to_owned())?;

    // Resolve format: fall back to platform-appropriate default if empty
    let resolved_format = resolve_proxy_format(&format);
    let text = format_proxy_env(resolved_format, endpoint);

    // Write to clipboard using arboard (cross-platform)
    let mut cb = arboard::Clipboard::new().map_err(|e| format!("Clipboard access failed: {e}"))?;
    cb.set_text(text)
        .map_err(|e| format!("Clipboard write failed: {e}"))?;

    // Emit to frontend for notification (optional — ignored if no WebView)
    crate::backend_event::emit_to_main(app, "tray-copy-env-done", ());
    Ok(())
}

/// Handle tray menu events
fn handle_menu_event(app: &AppHandle, id: &str) {
    match id {
        "show" => {
            show_or_recreate_window(app);
        }
        "quit" => {
            // Signal that this is an explicit exit, so ExitRequested won't block it
            if let Some(flag) = app.try_state::<crate::ExplicitExitFlag>() {
                flag.0.store(true, std::sync::atomic::Ordering::SeqCst);
            }
            let state = app.state::<MihomoState>();
            let _ = crate::core_manager::stop_core_inner(app, &state);
            if let Err(e) = sys_proxy::clear_sys_proxy(app) {
                emit_warn!(
                    System,
                    SYS_PROXY_FAILED,
                    "Failed to clear system proxy on exit: {e}"
                );
            }
            app.cleanup_before_exit();
            app.exit(0);
        }
        "toggle_sysproxy" => {
            toggle_sys_proxy(app);
        }
        "toggle_tun" => {
            toggle_tun(app);
        }
        "mode_rule" | "mode_global" | "mode_direct" => {
            let mode = id.strip_prefix("mode_").unwrap_or("rule");
            crate::backend_event::emit_to_main(app, "tray-mode-changed", mode);
        }
        "copy_env" => {
            let app_handle = app.clone();
            tauri::async_runtime::spawn_blocking(move || {
                if let Err(e) = copy_proxy_env_to_clipboard(&app_handle) {
                    eprintln!("[tray] Failed to copy proxy env: {e}");
                    crate::backend_event::emit_to_main(&app_handle, "tray-copy-env-failed", e);
                }
            });
        }
        _ => {
            // Handle subscription switching (prefix: sub_)
            if let Some(sub_name) = id.strip_prefix("sub_") {
                crate::backend_event::emit_to_main(app, "tray-subscription-changed", sub_name);
            }
            // Handle proxy switching (prefix: proxy_)
            else if let Some(proxy_name) = id.strip_prefix("proxy_") {
                let parts: Vec<&str> = proxy_name.splitn(2, ':').collect();
                if parts.len() == 2 {
                    if let (Some(group), Some(proxy)) = (parts.first(), parts.get(1)) {
                        crate::backend_event::emit_to_main(
                            app,
                            "tray-proxy-changed",
                            serde_json::json!({
                                "group": group,
                                "proxy": proxy
                            }),
                        );
                    }
                }
            }
        }
    }
}

fn toggle_sys_proxy(app: &AppHandle) {
    let current = sys_proxy::get_sys_proxy().unwrap_or(false);
    let new_state = !current;

    let result = if current {
        sys_proxy::disable_sysproxy(app.clone())
    } else {
        // Get the managed proxy endpoint (port *and* scheme) from core state
        // (not the API port)
        let state = app.state::<MihomoState>();
        let (endpoint, has_profile, running) = {
            let lock = state
                .0
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            (
                lock.last_proxy_endpoint(),
                lock.last_config_path().is_some(),
                lock.started_at().is_some(),
            )
        };
        if !running {
            // The profile path is also empty before the core has ever started: say
            // what is actually wrong instead of asking for a subscription.
            emit_error!(
                System,
                SYS_PROXY_TOGGLE_FAILED,
                "System proxy not enabled: the core is not running"
            );
            rebuild_tray_menu_from_state(app);
            return;
        }
        if !has_profile {
            // The core runs the built-in direct-only config: there is no subscription to
            // route through. Refuse here too, since in close-to-tray mode no WebView is
            // around to undo the switch.
            emit_error!(
                System,
                SYS_PROXY_TOGGLE_FAILED,
                "System proxy not enabled: add a subscription first"
            );
            rebuild_tray_menu_from_state(app);
            return;
        }
        let Some(proxy_endpoint) = endpoint else {
            // No managed proxy endpoint: enabling the OS proxy would point it at
            // an unmanaged default port with nothing listening.
            //
            // `error`, not `warn`: the frontend only surfaces `error`/`fatal`
            // events as a toast, so a warning leaves the user clicking a menu
            // item that silently refuses and does nothing.
            emit_error!(
                System,
                SYS_PROXY_TOGGLE_FAILED,
                "System proxy not enabled: no managed proxy endpoint is configured"
            );
            rebuild_tray_menu_from_state(app);
            return;
        };
        // `enable_sysproxy` takes a bare `host:port` and applies it to the HTTP,
        // HTTPS *and* SOCKS settings alike (networksetup on macOS, gsettings on
        // Linux). A SOCKS-only endpoint has no HTTP listener, so enabling it here
        // would advertise it as the system HTTP proxy and break every HTTP
        // request made outside the app.
        //
        // Configuring only the SOCKS settings instead is not an option: most
        // browsers on these platforms ignore the system SOCKS setting, so that
        // would leave the user believing the system proxy is on while their HTTP
        // traffic still goes direct. An explicit refusal is honest.
        if !proxy_endpoint.scheme.serves_http() {
            emit_error!(
                System,
                SYS_PROXY_TOGGLE_FAILED,
                "System proxy not enabled: the managed core exposes only a SOCKS listener. \
                 Enable a mixed or HTTP port in the profile to use the system proxy."
            );
            rebuild_tray_menu_from_state(app);
            return;
        }
        sys_proxy::enable_sysproxy(app.clone(), proxy_endpoint.host_port(), None)
    };

    if let Err(e) = result {
        emit_error!(
            System,
            SYS_PROXY_TOGGLE_FAILED,
            "Failed to toggle system proxy: {e}"
        );
        // Operation failed — do not update state, rebuild menu with current state
        rebuild_tray_menu_from_state(app);
        return;
    }

    // Operation succeeded — update tray state, icon, and menu
    let tray_state = app.state::<TrayState>();
    let mut guard = tray_state
        .0
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    guard.sys_proxy_enabled = new_state;
    drop(guard);
    let tun_enabled = effective_tun_enabled(app);

    let icon_mode = if tun_enabled {
        "tun"
    } else if new_state {
        "sysproxy"
    } else {
        "default"
    };
    let _ = change_tray_icon(app.clone(), icon_mode.to_owned());

    rebuild_tray_menu_from_state(app);

    // Also emit to frontend (will be ignored if no WebView, which is fine)
    crate::backend_event::emit_to_main(app, "tray-sysproxy-changed", new_state);
}

fn toggle_tun(app: &AppHandle) {
    // Rate limit: prevent concurrent TUN toggles (same protection as main UI)
    if !crate::core_manager::try_acquire_tun_toggle() {
        // TUN is already being toggled, ignore duplicate click
        return;
    }

    let state = app.state::<TrayState>();
    let current = state
        .0
        .lock()
        .map(|guard| guard.tun_enabled)
        .unwrap_or(false);

    // Emit event to frontend to handle TUN toggle
    // The lock will be released by the frontend via release_tun_toggle command
    crate::backend_event::emit_to_main(app, "tray-tun-changed", !current);
}

/// Parameters for [`update_tray_full_menu`].
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrayMenuParams {
    pub show_text: String,
    pub quit_text: String,
    pub sys_proxy_text: String,
    pub tun_text: String,
    pub rule_text: String,
    pub global_text: String,
    pub direct_text: String,
    pub subscriptions_text: String,
    pub proxies_text: String,
    pub copy_env_text: String,
    pub sys_proxy_enabled: bool,
    pub tun_enabled: bool,
    pub configs: Vec<ConfigInfo>,
    pub proxy_groups: Vec<ProxyGroupInfo>,
    pub current_mode: String,
}

/// Update tray menu with new configuration
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn update_tray_full_menu(app: AppHandle, params: TrayMenuParams) -> Result<(), String> {
    let tray = app
        .tray_by_id("main")
        .ok_or_else(|| "Tray icon not found".to_owned())?;

    // Update internal state
    let state = app.state::<TrayState>();
    let mut guard = state
        .0
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    guard.sys_proxy_enabled = params.sys_proxy_enabled;
    guard.tun_enabled = params.tun_enabled;
    guard.current_mode.clone_from(&params.current_mode);
    // Store i18n labels for rebuild_tray_menu_from_state (lightweight mode)
    guard.labels = TrayLabels {
        show: params.show_text.clone(),
        quit: params.quit_text.clone(),
        sys_proxy: params.sys_proxy_text.clone(),
        tun_mode: params.tun_text.clone(),
        rule: params.rule_text.clone(),
        global: params.global_text.clone(),
        direct: params.direct_text.clone(),
        copy_env: params.copy_env_text.clone(),
    };
    drop(guard);

    // Build menu items
    let show_i = MenuItem::with_id(&app, "show", &params.show_text, true, None::<&str>)
        .map_err(|e| format!("Failed to create show item: {e}"))?;

    let sep1 = PredefinedMenuItem::separator(&app)
        .map_err(|e| format!("Failed to create separator: {e}"))?;

    // System Proxy toggle - use MenuItem with circle indicator instead of CheckMenuItem
    let sys_proxy_label = if params.sys_proxy_enabled {
        format!("● {}", params.sys_proxy_text)
    } else {
        format!("○ {}", params.sys_proxy_text)
    };
    let sys_proxy_i = MenuItem::with_id(
        &app,
        "toggle_sysproxy",
        &sys_proxy_label,
        true,
        None::<&str>,
    )
    .map_err(|e| format!("Failed to create sys proxy item: {e}"))?;

    // TUN Mode toggle - use MenuItem with circle indicator instead of CheckMenuItem
    let tun_label = if params.tun_enabled {
        format!("● {}", params.tun_text)
    } else {
        format!("○ {}", params.tun_text)
    };
    let tun_i = MenuItem::with_id(&app, "toggle_tun", &tun_label, true, None::<&str>)
        .map_err(|e| format!("Failed to create tun item: {e}"))?;

    // Mode items - use MenuItem with circle indicator
    let mode_sep = PredefinedMenuItem::separator(&app)
        .map_err(|e| format!("Failed to create separator: {e}"))?;
    let rule_label = if params.current_mode.to_lowercase() == "rule" {
        format!("● {}", params.rule_text)
    } else {
        format!("○ {}", params.rule_text)
    };
    let global_label = if params.current_mode.to_lowercase() == "global" {
        format!("● {}", params.global_text)
    } else {
        format!("○ {}", params.global_text)
    };
    let direct_label = if params.current_mode.to_lowercase() == "direct" {
        format!("● {}", params.direct_text)
    } else {
        format!("○ {}", params.direct_text)
    };
    let rule_i = MenuItem::with_id(&app, "mode_rule", &rule_label, true, None::<&str>)
        .map_err(|e| format!("Failed to create rule item: {e}"))?;
    let global_i = MenuItem::with_id(&app, "mode_global", &global_label, true, None::<&str>)
        .map_err(|e| format!("Failed to create global item: {e}"))?;
    let direct_i = MenuItem::with_id(&app, "mode_direct", &direct_label, true, None::<&str>)
        .map_err(|e| format!("Failed to create direct item: {e}"))?;

    // Build main menu items
    let mut builder = MenuBuilder::new(&app)
        .item(&show_i)
        .item(&sep1)
        .item(&sys_proxy_i)
        .item(&tun_i)
        .item(&mode_sep)
        .item(&rule_i)
        .item(&global_i)
        .item(&direct_i);

    // Build Copy Proxy Env menu item
    let env_sep = PredefinedMenuItem::separator(&app)
        .map_err(|e| format!("Failed to create separator: {e}"))?;
    let copy_env_i = MenuItem::with_id(&app, "copy_env", &params.copy_env_text, true, None::<&str>)
        .map_err(|e| format!("Failed to create copy env item: {e}"))?;

    builder = builder.item(&env_sep).item(&copy_env_i);

    // Build separate Subscriptions and Proxies submenus
    let has_configs = !params.configs.is_empty();
    let has_proxies = !params.proxy_groups.is_empty();

    if has_configs || has_proxies {
        let sub_sep = PredefinedMenuItem::separator(&app)
            .map_err(|e| format!("Failed to create separator: {e}"))?;
        builder = builder.item(&sub_sep);

        // Build Subscriptions submenu
        if has_configs {
            let mut sub_menu_builder = SubmenuBuilder::new(&app, &params.subscriptions_text);

            for config in &params.configs {
                let sub_label = if config.is_active {
                    format!("● {}", config.name)
                } else {
                    format!("○ {}", config.name)
                };
                let switch_id = format!("sub_{}", config.name);
                let item = MenuItem::with_id(&app, &switch_id, &sub_label, true, None::<&str>)
                    .map_err(|e| format!("Failed to create subscription item: {e}"))?;
                sub_menu_builder = sub_menu_builder.item(&item);
            }

            let subscriptions_submenu = sub_menu_builder
                .build()
                .map_err(|e| format!("Failed to build subscriptions submenu: {e}"))?;
            builder = builder.item(&subscriptions_submenu);
        }

        // Build Proxies submenu (only show nodes from active subscription)
        if has_proxies {
            let mut proxy_menu_builder = SubmenuBuilder::new(&app, &params.proxies_text);

            for group in &params.proxy_groups {
                for proxy in group.proxies.iter().take(15) {
                    let id = format!("proxy_{}:{}", group.name, proxy.name);
                    let is_current = proxy.name == group.now;
                    let proxy_label = if is_current {
                        format!("● {}", proxy.name)
                    } else {
                        format!("○ {}", proxy.name)
                    };
                    let item = MenuItem::with_id(&app, &id, &proxy_label, true, None::<&str>)
                        .map_err(|e| format!("Failed to create proxy item: {e}"))?;
                    proxy_menu_builder = proxy_menu_builder.item(&item);
                }
            }

            let proxies_submenu = proxy_menu_builder
                .build()
                .map_err(|e| format!("Failed to build proxies submenu: {e}"))?;
            builder = builder.item(&proxies_submenu);
        }
    }

    // Separator and Quit
    let sep2 = PredefinedMenuItem::separator(&app)
        .map_err(|e| format!("Failed to create separator: {e}"))?;
    let quit_i = MenuItem::with_id(&app, "quit", &params.quit_text, true, None::<&str>)
        .map_err(|e| format!("Failed to create quit item: {e}"))?;

    builder = builder.item(&sep2).item(&quit_i);

    // Build menu
    let menu = builder
        .build()
        .map_err(|e| format!("Failed to build menu: {e}"))?;

    tray.set_menu(Some(menu))
        .map_err(|e| format!("Failed to set tray menu: {e}"))?;

    Ok(())
}

/// Update just the toggle states (lightweight update)
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn update_tray_toggle_states(
    app: AppHandle,
    sys_proxy_enabled: bool,
    tun_enabled: bool,
    current_mode: String,
) -> Result<(), String> {
    // Update internal state
    let state = app.state::<TrayState>();
    if let Ok(mut guard) = state.0.lock() {
        guard.sys_proxy_enabled = sys_proxy_enabled;
        guard.tun_enabled = tun_enabled;
        guard.current_mode = current_mode;
    }

    Ok(())
}

/// Rebuild tray menu from current `TrayState` (works without WebView/frontend).
/// Used when tray operations happen in lightweight mode or when the frontend
/// is not available to provide full menu data.
#[allow(clippy::doc_markdown)]
fn rebuild_tray_menu_from_state(app: &AppHandle) {
    let tray_state = app.state::<TrayState>();
    let guard = tray_state
        .0
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let sys_on = guard.sys_proxy_enabled;
    let tun_on = guard.tun_enabled;
    let mode = if guard.current_mode.is_empty() {
        "rule".to_owned()
    } else {
        guard.current_mode.clone()
    };
    let labels = guard.labels.clone();
    drop(guard);

    let tray = match app.tray_by_id("main") {
        Some(t) => t,
        None => return,
    };

    let show_i = match MenuItem::with_id(app, "show", &labels.show, true, None::<&str>) {
        Ok(i) => i,
        Err(_) => return,
    };
    let sep1 = match PredefinedMenuItem::separator(app) {
        Ok(s) => s,
        Err(_) => return,
    };

    let sys_label = if sys_on {
        format!("● {}", labels.sys_proxy)
    } else {
        format!("○ {}", labels.sys_proxy)
    };
    let sys_i = match MenuItem::with_id(app, "toggle_sysproxy", &sys_label, true, None::<&str>) {
        Ok(i) => i,
        Err(_) => return,
    };

    let tun_label = if tun_on {
        format!("● {}", labels.tun_mode)
    } else {
        format!("○ {}", labels.tun_mode)
    };
    let tun_i = match MenuItem::with_id(app, "toggle_tun", &tun_label, true, None::<&str>) {
        Ok(i) => i,
        Err(_) => return,
    };

    let mode_sep = match PredefinedMenuItem::separator(app) {
        Ok(s) => s,
        Err(_) => return,
    };
    let rule_label = if mode.to_lowercase() == "rule" {
        format!("● {}", labels.rule)
    } else {
        format!("○ {}", labels.rule)
    };
    let global_label = if mode.to_lowercase() == "global" {
        format!("● {}", labels.global)
    } else {
        format!("○ {}", labels.global)
    };
    let direct_label = if mode.to_lowercase() == "direct" {
        format!("● {}", labels.direct)
    } else {
        format!("○ {}", labels.direct)
    };
    let rule_i = match MenuItem::with_id(app, "mode_rule", &rule_label, true, None::<&str>) {
        Ok(i) => i,
        Err(_) => return,
    };
    let global_i = match MenuItem::with_id(app, "mode_global", &global_label, true, None::<&str>) {
        Ok(i) => i,
        Err(_) => return,
    };
    let direct_i = match MenuItem::with_id(app, "mode_direct", &direct_label, true, None::<&str>) {
        Ok(i) => i,
        Err(_) => return,
    };

    // Copy Proxy Env menu item
    let env_sep = match PredefinedMenuItem::separator(app) {
        Ok(s) => s,
        Err(_) => return,
    };
    let copy_env_i = match MenuItem::with_id(app, "copy_env", &labels.copy_env, true, None::<&str>)
    {
        Ok(i) => i,
        Err(_) => return,
    };

    let sep2 = match PredefinedMenuItem::separator(app) {
        Ok(s) => s,
        Err(_) => return,
    };
    let quit_i = match MenuItem::with_id(app, "quit", &labels.quit, true, None::<&str>) {
        Ok(i) => i,
        Err(_) => return,
    };

    let menu = MenuBuilder::new(app)
        .item(&show_i)
        .item(&sep1)
        .item(&sys_i)
        .item(&tun_i)
        .item(&mode_sep)
        .item(&rule_i)
        .item(&global_i)
        .item(&direct_i)
        .item(&env_sep)
        .item(&copy_env_i)
        .item(&sep2)
        .item(&quit_i)
        .build();

    if let Ok(m) = menu {
        let _ = tray.set_menu(Some(m));
    }
}

#[cfg(test)]
#[path = "tray_tests.rs"]
mod tray_tests;
