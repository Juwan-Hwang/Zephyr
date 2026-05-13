pub mod config_manager;
pub mod core_manager;
pub mod deep_link;
pub mod global_shortcut;
pub mod os_notification;
pub mod prism;
pub mod sys_proxy;
pub mod tray;
pub mod updater;
pub mod uwp_loopback;

use config_manager::{read_config, update_config};
use core_manager::core::subscription_scheduler::start_scheduler;
use core_manager::{
    delete_config, disable_tun_cmd, download_sub, download_sub_batch, ensure_app_storage,
    fetch_text, get_core_version, init_tun_mode_from_config, kill_all_mihomo_as_root_cmd,
    kill_mihomo, list_configs, open_config_folder, read_config_file, rename_config,
    restart_core_as_root_cmd, set_tun_enabled, smart_kill_all_mihomo_as_root, start_core,
    stop_core, update_config_url, update_subscription_interval, write_config_file, CoreData,
    MihomoState,
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
            eprintln!("[RateLimit] {msg}");
            return Err(msg);
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
    #[serde(default)]
    auto_apply: bool,
    #[serde(default)]
    ui_scale: f64,
    #[serde(default)]
    config_order: Vec<String>,
    /// Per-profile last selected proxy node.
    /// Key: profile filename (e.g., "my-sub.yaml")
    /// Value: proxy node name (e.g., "香港01")
    #[serde(default)]
    last_proxy_selection: std::collections::HashMap<String, String>,
    /// Custom User-Agent for subscription downloads (used by scheduler).
    /// Set by frontend when user configures a fake client UA.
    #[serde(default)]
    subscription_user_agent: Option<String>,
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
    {
        let mut guard = state
            .0
            .lock()
            .map_err(|e| format!("Settings lock failed: {e}"))?;
        *guard = settings.clone();
    }
    persist_settings(&app, &settings)
}

/// Atomically update a single proxy selection entry in settings.
/// Avoids the Read-Modify-Write race condition of fetching all settings,
/// mutating, and saving back.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn update_proxy_selection(
    app: tauri::AppHandle,
    state: tauri::State<SettingsState>,
    profile_name: String,
    node_name: String,
) -> Result<(), String> {
    let settings = {
        let mut guard = state
            .0
            .lock()
            .map_err(|e| format!("Settings lock failed: {e}"))?;
        guard.last_proxy_selection.insert(profile_name, node_name);
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

#[tauri::command]
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
        .manage(MihomoState(Mutex::new(CoreData::new())))
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
            // Initialize TUN mode flag from config (before tray init so icon is correct)
            let _ = init_tun_mode_from_config(app.handle());
            let paths = core_manager::resolve_app_paths(app.handle())?;
            let config_dir = paths.app_data_dir;
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
                    auto_apply: false,
                    ui_scale: 1.0,
                    config_order: Vec::new(),
                    last_proxy_selection: std::collections::HashMap::new(),
                    subscription_user_agent: None,
                }
            };
            app.manage(SettingsState(Arc::new(Mutex::new(settings))));

            // Initialize Prism Engine extension
            app.manage(prism::PrismState::new(app.handle()));

            // Start subscription auto-update scheduler (each sub has its own interval in metadata)
            let scheduler_state = start_scheduler(app.handle().clone());
            app.manage(scheduler_state);

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
                                        // Sanitize file name to prevent path traversal
                                        let safe_name = match core_manager::core::config_sanitizer::sanitize_config_file_name(file_name) {
                                            Ok(name) => name,
                                            Err(_) => continue,
                                        };
                                        let target_path =
                                            storage_paths.profiles_dir.join(&safe_name);
                                        // Validate path stays within profiles dir
                                        if core_manager::core::config_sanitizer::validate_path_within_dir(&target_path, &storage_paths.profiles_dir).is_err() {
                                            continue;
                                        }
                                        // Sanitize dangerous keys (same as subscription import)
                                        let mut yaml_value: serde_yaml::Value = serde_yaml::from_str(&content)
                                            .unwrap_or(serde_yaml::Value::Null);
                                        core_manager::core::config_sanitizer::remove_dangerous_keys(&mut yaml_value, false);
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
                            use tauri::Emitter as _;
                            let _ = window.emit("profiles-imported", imported_count);
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
            download_sub,
            download_sub_batch,
            delete_config,
            rename_config,
            get_latest_version,
            update_core,
            enable_sysproxy,
            disable_sysproxy,
            get_sys_proxy,
            get_settings,
            save_settings,
            update_proxy_selection,
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
        ]);

    #[allow(clippy::expect_used)]
    let app = builder
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|handle, event| {
        if matches!(event, tauri::RunEvent::Exit) {
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
