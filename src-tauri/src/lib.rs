pub mod config_manager;
pub mod core_manager;
pub mod deep_link;
pub mod global_shortcut;
pub mod os_notification;
pub mod sys_proxy;
pub mod tray;
pub mod updater;
pub mod uwp_loopback;

use config_manager::{read_config, update_config};
use core_manager::{
    delete_config, disable_tun_cmd, download_sub, ensure_app_storage, fetch_text, get_config_url,
    get_core_version, kill_all_mihomo_as_root_cmd, kill_mihomo, list_configs, open_config_folder,
    read_config_file, restart_core_as_root_cmd, set_tun_enabled, smart_kill_all_mihomo_as_root,
    start_core, stop_core, write_config_file, CoreData, MihomoState,
};
use global_shortcut::ShortcutRegistry;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use sys_proxy::{clear_sys_proxy, disable_sysproxy, enable_sysproxy, get_sys_proxy};
use tauri::Manager as _;
#[cfg(desktop)]
use tauri_plugin_autostart::Builder as AutostartBuilder;
use tray::{change_tray_icon, init_tray, update_tray_full_menu, TrayState};
use updater::{
    get_latest_client_version, get_latest_client_versions, get_latest_version, update_client,
    update_core, update_geo_data,
};
use uwp_loopback::exempt_uwp_apps;

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

    /// Check if a command can be executed (returns true if allowed, false if rate limited)
    /// Also cleans up expired entries to prevent unbounded memory growth
    #[allow(clippy::expect_used)]
    pub fn check_rate_limit(&self, command: &str, min_interval_ms: u64) -> bool {
        let mut calls = self.calls.lock().expect("rate limiter mutex not poisoned");
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
            return Err(format!("{} rate limited, please wait", $cmd));
        }
    };
}

#[derive(Serialize, Deserialize, Clone, Default)]
struct Settings {
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
}

struct SettingsState(Arc<Mutex<Settings>>);

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
    if let Ok(mut guard) = state.0.lock() {
        *guard = settings.clone();
    }
    let path = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {e}"))?;
    if !path.exists() {
        fs::create_dir_all(&path).map_err(|e| format!("Failed to create config dir: {e}"))?;
    }
    let file_path = path.join("settings.json");
    let json_str = serde_json::to_string(&settings)
        .map_err(|e| format!("Failed to serialize settings: {e}"))?;
    fs::write(&file_path, json_str).map_err(|e| format!("Failed to write settings.json: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        let _ = fs::set_permissions(&file_path, fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn show_main_window(window: tauri::Window) {
    let _ = window.show();
    let _ = window.set_focus();
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
        .map(|guard| guard.process.is_some())
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

#[tauri::command]
fn get_app_version() -> String {
    env!("CARGO_PKG_VERSION").to_owned()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
// rust-analyzer cannot resolve proc-macro `tauri::generate_context!()` without OUT_DIR at IDE analysis time.
// This is a false positive — cargo build/clippy sets OUT_DIR correctly and compiles fine.
#[allow(rust_analyzer::proc_macro_unresolved)]
pub fn run() {
    // Setup panic hook to cleanup child processes
    let default_panic = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        eprintln!("[PANIC] Application panicked, cleaning up child processes...");
        // Kill all mihomo processes on panic
        crate::core_manager::kill_mihomo();
        default_panic(info);
    }));

    let mut builder = tauri::Builder::default();

    #[cfg(desktop)]
    {
        builder = builder.plugin(AutostartBuilder::new().build());
    }

    builder = builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .manage(MihomoState(Mutex::new(CoreData {
            process: None,
            last_secret: String::new(),
            last_config_path: None,
            last_custom_args: None,
            last_port: None,
            last_log_path: None,
        })))
        .manage(TrayState::default())
        .manage(RateLimiter::new())
        .manage(ShortcutRegistry::default())
        .setup(|app| {
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

            ensure_app_storage(app.handle())?;
            let config_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
            let settings_file = config_dir.join("settings.json");
            let settings = if settings_file.exists() {
                let content = fs::read_to_string(settings_file).unwrap_or_default();
                serde_json::from_str::<Settings>(&content).unwrap_or_default()
            } else {
                Settings {
                    close_to_tray: true, // 默认开启
                    auto_update: false,
                    auto_update_client: false,
                    autostart: false,
                    theme: None,
                    last_config: None,
                    custom_args: Vec::new(),
                    dns_nameservers: None,
                    dns_fallbacks: None,
                }
            };
            app.manage(SettingsState(Arc::new(Mutex::new(settings))));

            // Init Tray using the new tray module
            init_tray(app.handle())?;

            // Handle deep link URLs from command-line arguments
            // (protocol associations on Windows/macOS pass URLs via argv)
            deep_link::handle_cli_deep_links(app.handle());

            Ok(())
        })
        .on_window_event(|window, event| {
            #[allow(clippy::wildcard_enum_match_arm)]
            match event {
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    let settings_state = window.state::<SettingsState>();
                    let close_to_tray = settings_state
                        .0
                        .lock()
                        .map(|guard| guard.close_to_tray)
                        .unwrap_or(true);

                    if close_to_tray {
                        api.prevent_close();
                        let _ = window.hide();
                    } else {
                        kill_mihomo();
                        let _ = clear_sys_proxy();
                        let app = window.app_handle();
                        app.cleanup_before_exit();
                        app.exit(0);
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
                                        let target_path =
                                            storage_paths.profiles_dir.join(file_name);
                                        if core_manager::write_file_secure(&target_path, &content)
                                            .is_ok()
                                        {
                                            imported_count += 1;
                                        }
                                    }
                                }
                            }
                        }
                        if imported_count > 0 {
                            use tauri::Emitter as _;
                            let _ = window.emit("profiles-imported", imported_count);
                        }
                    }
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            start_core,
            stop_core,
            list_configs,
            get_config_url,
            download_sub,
            delete_config,
            get_latest_version,
            update_core,
            enable_sysproxy,
            disable_sysproxy,
            get_sys_proxy,
            get_settings,
            save_settings,
            get_core_version,
            exempt_uwp_apps,
            read_config_file,
            write_config_file,
            open_config_folder,
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
            // OS notification command (rate-limited wrapper)
            rate_limited_send_notification,
            get_app_version,
        ]);

    #[allow(clippy::expect_used)]
    let app = builder
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|_handle, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            kill_mihomo();
            // Smart kill: only prompts for password if there's actually a root mihomo running
            let _ = smart_kill_all_mihomo_as_root();
        }
    });
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
