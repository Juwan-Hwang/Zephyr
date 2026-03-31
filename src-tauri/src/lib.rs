pub mod core_manager;
pub mod updater;
pub mod sys_proxy;
pub mod uwp_loopback;
pub mod config_manager;
pub mod tray;

use core_manager::{ensure_app_storage, start_core, stop_core, list_configs, download_sub, delete_config, get_core_version, MihomoState, CoreData, read_config_file, write_config_file, open_config_folder, fetch_text};
use updater::{get_latest_version, update_core, update_geo_data, get_latest_client_versions};
use sys_proxy::{enable_sysproxy, disable_sysproxy, get_sys_proxy, clear_sys_proxy};
use config_manager::{read_config, update_config};
use uwp_loopback::exempt_uwp_apps;
use tray::{init_tray, TrayState, change_tray_icon, update_tray_full_menu};
use std::sync::{Mutex, Arc};
use tauri::Manager;
use serde::{Deserialize, Serialize};
use std::fs;
#[cfg(desktop)]
use tauri_plugin_autostart::Builder as AutostartBuilder;

#[derive(Serialize, Deserialize, Clone, Default)]
struct Settings {
    close_to_tray: bool,
    auto_update: bool,
    autostart: bool,
    theme: Option<String>,
    last_config: Option<String>,
    #[serde(default)]
    custom_args: Vec<String>,
}

struct SettingsState(Arc<Mutex<Settings>>);

#[tauri::command]
fn get_settings(state: tauri::State<SettingsState>) -> Settings {
    state.0.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

#[tauri::command]
fn save_settings(app: tauri::AppHandle, state: tauri::State<SettingsState>, settings: Settings) -> Result<(), String> {
    if let Ok(mut guard) = state.0.lock() {
        *guard = settings.clone();
    }
    let path = app.path().app_data_dir().map_err(|e| format!("Failed to get app data dir: {}", e))?;
    if !path.exists() {
        fs::create_dir_all(&path).map_err(|e| format!("Failed to create config dir: {}", e))?;
    }
    let file_path = path.join("settings.json");
    let json_str = serde_json::to_string(&settings).map_err(|e| format!("Failed to serialize settings: {}", e))?;
    fs::write(&file_path, json_str).map_err(|e| format!("Failed to write settings.json: {}", e))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&file_path, fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

#[tauri::command]
fn show_main_window(window: tauri::Window) {
    let _ = window.show();
    let _ = window.set_focus();
}

/// Get current system proxy and core status for tray state determination
#[tauri::command]
fn get_tray_status(app: tauri::AppHandle) -> Result<String, String> {
    // Check if core is running
    let state = app.state::<MihomoState>();
    let core_running = state.0.lock()
        .map(|guard| guard.process.is_some())
        .unwrap_or(false);
    
    if !core_running {
        // Core not running, return default state
        return Ok("default".to_string());
    }
    
    // Check system proxy status using existing function
    let sys_proxy_enabled = sys_proxy::get_sys_proxy().unwrap_or(false);
    
    // Check TUN status from tray state
    let tun_enabled = app.state::<TrayState>()
        .0.lock()
        .map(|guard| guard.tun_enabled)
        .unwrap_or(false);
    
    if tun_enabled {
        return Ok("tun".to_string());
    }
    
    if sys_proxy_enabled {
        return Ok("sysproxy".to_string());
    }
    
    Ok("default".to_string())
}

#[cfg(test)]
mod lib_test;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    #[cfg(desktop)]
    {
        builder = builder.plugin(AutostartBuilder::new().build());
    }

    builder = builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(MihomoState(Mutex::new(CoreData {
            process: None,
            last_secret: String::new(),
            last_config_path: None,
            last_custom_args: None,
            last_port: None,
        })))
        .manage(TrayState::default())
        .setup(|app| {
            ensure_app_storage(app.handle()).map_err(|e| e.to_string())?;
            let config_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
            let settings_file = config_dir.join("settings.json");
            let settings = if settings_file.exists() {
                let content = fs::read_to_string(settings_file).unwrap_or_default();
                serde_json::from_str::<Settings>(&content).unwrap_or_default()
            } else {
                Settings {
                    close_to_tray: true, // 默认开启
                    auto_update: false,
                    autostart: false,
                    theme: None,
                    last_config: None,
                    custom_args: Vec::new(),
                }
            };
            app.manage(SettingsState(Arc::new(Mutex::new(settings.clone()))));

            // Init Tray using the new tray module
            init_tray(app.handle()).map_err(|e| e.to_string())?;

            Ok(())
        })
        .on_window_event(|window, event| {
            match event {
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    let settings_state = window.state::<SettingsState>();
                    let close_to_tray = settings_state.0.lock()
                        .map(|guard| guard.close_to_tray)
                        .unwrap_or(true);

                    if close_to_tray {
                        api.prevent_close();
                        let _ = window.hide();
                    } else {
                        let app = window.app_handle().clone();
                        let state = window.state::<MihomoState>();
                        let _ = stop_core(app.clone(), state);
                        let _ = clear_sys_proxy();
                        app.cleanup_before_exit();
                        app.exit(0);
                    }
                }
                tauri::WindowEvent::DragDrop(drop_event) => {
                    if let tauri::DragDropEvent::Drop { paths, .. } = drop_event {
                        let app = window.app_handle();
                        if let Ok(storage_paths) = core_manager::ensure_app_storage(app) {
                            let mut imported_count = 0;
                            for path in paths {
                                let ext = std::path::Path::new(&path).extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
                                if ext == "yaml" || ext == "yml" {
                                    if let Ok(content) = std::fs::read_to_string(&path) {
                                        if let Some(file_name) = std::path::Path::new(&path).file_name().and_then(|n| n.to_str()) {
                                            let target_path = storage_paths.profiles_dir.join(file_name);
                                            if core_manager::write_file_secure(&target_path, &content).is_ok() {
                                                imported_count += 1;
                                            }
                                        }
                                    }
                                }
                            }
                            if imported_count > 0 {
                                use tauri::Emitter;
                                let _ = window.emit("profiles-imported", imported_count);
                            }
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
            fetch_text,
            // Re-export tray commands
            tray::get_tray_menu_state,
            tray::set_tray_menu_state,
            tray::get_tray_proxy_status,
            tray::update_tray_toggle_states,
        ]);

    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
