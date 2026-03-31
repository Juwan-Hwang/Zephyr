//! Tray icon and menu management
//! 
//! This module handles:
//! - Tray icon display and state changes
//! - Context menu with proxy controls
//! - Left-click to show window, right-click to show menu

use tauri::{
    AppHandle, Manager, Emitter,
    menu::{MenuBuilder, MenuItem, PredefinedMenuItem, SubmenuBuilder},
    tray::TrayIconBuilder,
    image::Image,
};
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};

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
pub fn get_tray_menu_state(app: AppHandle) -> Result<TrayMenuState, String> {
    let state = app.state::<TrayState>();
    let guard = state.0.lock().map_err(|_| "Failed to lock tray state")?;
    Ok(guard.clone())
}

/// Update tray menu state
#[tauri::command]
pub fn set_tray_menu_state(app: AppHandle, new_state: TrayMenuState) -> Result<(), String> {
    let tray_state = app.state::<TrayState>();
    let mut guard = tray_state.0.lock().map_err(|_| "Failed to lock tray state")?;
    *guard = new_state;
    Ok(())
}

/// Change tray icon based on mode
#[tauri::command]
pub fn change_tray_icon(app: AppHandle, mode: String) -> Result<(), String> {
    let tray = app
        .tray_by_id("main")
        .ok_or_else(|| "Tray icon not found".to_string())?;

    let icon_bytes: &[u8] = match mode.as_str() {
        "tun" => include_bytes!("../icons/red-icon.png"),
        "sysproxy" => include_bytes!("../icons/yellow-icon.png"),
        _ => include_bytes!("../icons/icon.png"),
    };

    let image = Image::from_bytes(icon_bytes)
        .map_err(|e| format!("Failed to load icon: {}", e))?;

    tray.set_icon(Some(image))
        .map_err(|e| format!("Failed to set icon: {}", e))?;

    Ok(())
}

/// Get current proxy mode for tray status
#[tauri::command]
pub fn get_tray_proxy_status(app: AppHandle) -> Result<String, String> {
    let state = app.state::<MihomoState>();
    let core_running = state.0.lock()
        .map(|guard| guard.process.is_some())
        .unwrap_or(false);
    
    if !core_running {
        return Ok("stopped".to_string());
    }
    
    let sys_proxy_enabled = sys_proxy::get_sys_proxy().unwrap_or(false);
    
    // Check TUN status via core state
    let tray_state = app.state::<TrayState>();
    let tun_enabled = tray_state.0.lock()
        .map(|guard| guard.tun_enabled)
        .unwrap_or(false);
    
    if tun_enabled {
        Ok("tun".to_string())
    } else if sys_proxy_enabled {
        Ok("sysproxy".to_string())
    } else {
        Ok("running".to_string())
    }
}

/// Initialize tray with left-click to show window, right-click for menu
pub fn init_tray(app: &AppHandle) -> Result<(), String> {
    // Build initial simple menu using MenuBuilder
    let show_i = MenuItem::with_id(app, "show", "Show", true, None::<&str>)
        .map_err(|e| format!("Failed to create show menu item: {}", e))?;
    
    let quit_i = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)
        .map_err(|e| format!("Failed to create quit menu item: {}", e))?;
    
    let sep = PredefinedMenuItem::separator(app)
        .map_err(|e| format!("Failed to create separator: {}", e))?;
    
    let menu = MenuBuilder::new(app)
        .item(&show_i)
        .item(&sep)
        .item(&quit_i)
        .build()
        .map_err(|e| format!("Failed to create menu: {}", e))?;
    
    let mut tray_builder = TrayIconBuilder::with_id("main")
        .menu(&menu)
        .show_menu_on_left_click(false) // Don't show menu on left click
        .on_menu_event(|app, event| {
            handle_menu_event(app, event.id.as_ref());
        })
        .on_tray_icon_event(|tray, event| {
            if let tauri::tray::TrayIconEvent::Click { button, .. } = event {
                if button == tauri::tray::MouseButton::Left {
                    // Left click: show main window
                    let app = tray.app_handle();
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
            }
        });

    if let Some(default_icon) = app.default_window_icon() {
        tray_builder = tray_builder.icon(default_icon.clone());
    }

    tray_builder.build(app)
        .map_err(|e| format!("Failed to build tray: {}", e))?;

    Ok(())
}

/// Handle tray menu events
fn handle_menu_event(app: &AppHandle, id: &str) {
    match id {
        "show" => {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }
        "quit" => {
            let state = app.state::<MihomoState>();
            let _ = crate::core_manager::stop_core(app.clone(), state);
            let _ = sys_proxy::clear_sys_proxy();
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
            let _ = app.emit("tray-mode-changed", mode);
        }
        _ => {
            // Handle subscription switching (prefix: sub_)
            if let Some(sub_name) = id.strip_prefix("sub_") {
                let _ = app.emit("tray-subscription-changed", sub_name);
            }
            // Handle proxy switching (prefix: proxy_)
            else if let Some(proxy_name) = id.strip_prefix("proxy_") {
                let parts: Vec<&str> = proxy_name.splitn(2, ':').collect();
                if parts.len() == 2 {
                    let _ = app.emit("tray-proxy-changed", serde_json::json!({
                        "group": parts[0],
                        "proxy": parts[1]
                    }));
                }
            }
        }
    }
}

fn toggle_sys_proxy(app: &AppHandle) {
    let current = sys_proxy::get_sys_proxy().unwrap_or(false);
    
    if current {
        let _ = sys_proxy::disable_sysproxy();
    } else {
        // Get the current proxy port from core state
        let state = app.state::<MihomoState>();
        let port = state.0.lock()
            .map(|guard| guard.last_port.unwrap_or(7890))
            .unwrap_or(7890);
        let server = format!("127.0.0.1:{}", port);
        let _ = sys_proxy::enable_sysproxy(server, None);
    }
    
    // Emit event to frontend
    let _ = app.emit("tray-sysproxy-changed", !current);
}

fn toggle_tun(app: &AppHandle) {
    let state = app.state::<TrayState>();
    let current = state.0.lock()
        .map(|guard| guard.tun_enabled)
        .unwrap_or(false);
    
    // Emit event to frontend to handle TUN toggle
    let _ = app.emit("tray-tun-changed", !current);
}

/// Update tray menu with new configuration
#[tauri::command]
pub fn update_tray_full_menu(
    app: AppHandle,
    show_text: String,
    quit_text: String,
    sys_proxy_text: String,
    tun_text: String,
    rule_text: String,
    global_text: String,
    direct_text: String,
    subscriptions_text: String,
    proxies_text: String,
    sys_proxy_enabled: bool,
    tun_enabled: bool,
    configs: Vec<ConfigInfo>,
    proxy_groups: Vec<ProxyGroupInfo>,
    current_mode: String,
) -> Result<(), String> {
    println!("[Tray] update_tray_full_menu called");
    println!("[Tray] configs count: {}, proxy_groups count: {}", configs.len(), proxy_groups.len());
    
    let tray = app
        .tray_by_id("main")
        .ok_or_else(|| "Tray icon not found".to_string())?;
    
    // Update internal state
    let state = app.state::<TrayState>();
    if let Ok(mut guard) = state.0.lock() {
        guard.sys_proxy_enabled = sys_proxy_enabled;
        guard.tun_enabled = tun_enabled;
        guard.current_mode = current_mode.clone();
    }
    
    // Build menu items
    let show_i = MenuItem::with_id(&app, "show", &show_text, true, None::<&str>)
        .map_err(|e| format!("Failed to create show item: {}", e))?;
    
    let sep1 = PredefinedMenuItem::separator(&app)
        .map_err(|e| format!("Failed to create separator: {}", e))?;
    
    // System Proxy toggle - use MenuItem with circle indicator instead of CheckMenuItem
    let sys_proxy_label = if sys_proxy_enabled { format!("● {}", sys_proxy_text) } else { format!("○ {}", sys_proxy_text) };
    let sys_proxy_i = MenuItem::with_id(&app, "toggle_sysproxy", &sys_proxy_label, true, None::<&str>)
        .map_err(|e| format!("Failed to create sys proxy item: {}", e))?;
    
    // TUN Mode toggle - use MenuItem with circle indicator instead of CheckMenuItem
    let tun_label = if tun_enabled { format!("● {}", tun_text) } else { format!("○ {}", tun_text) };
    let tun_i = MenuItem::with_id(&app, "toggle_tun", &tun_label, true, None::<&str>)
        .map_err(|e| format!("Failed to create tun item: {}", e))?;
    
    // Mode items - use MenuItem with circle indicator
    let mode_sep = PredefinedMenuItem::separator(&app)
        .map_err(|e| format!("Failed to create separator: {}", e))?;
    let rule_label = if current_mode.to_lowercase() == "rule" { format!("● {}", rule_text) } else { format!("○ {}", rule_text) };
    let global_label = if current_mode.to_lowercase() == "global" { format!("● {}", global_text) } else { format!("○ {}", global_text) };
    let direct_label = if current_mode.to_lowercase() == "direct" { format!("● {}", direct_text) } else { format!("○ {}", direct_text) };
    let rule_i = MenuItem::with_id(&app, "mode_rule", &rule_label, true, None::<&str>)
        .map_err(|e| format!("Failed to create rule item: {}", e))?;
    let global_i = MenuItem::with_id(&app, "mode_global", &global_label, true, None::<&str>)
        .map_err(|e| format!("Failed to create global item: {}", e))?;
    let direct_i = MenuItem::with_id(&app, "mode_direct", &direct_label, true, None::<&str>)
        .map_err(|e| format!("Failed to create direct item: {}", e))?;
    
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
    
    // Build separate Subscriptions and Proxies submenus
    let has_configs = !configs.is_empty();
    let has_proxies = !proxy_groups.is_empty();
    
    if has_configs || has_proxies {
        let sub_sep = PredefinedMenuItem::separator(&app)
            .map_err(|e| format!("Failed to create separator: {}", e))?;
        builder = builder.item(&sub_sep);
        
        // Build Subscriptions submenu
        if has_configs {
            let mut sub_menu_builder = SubmenuBuilder::new(&app, &subscriptions_text);
            
            for config in &configs {
                let sub_label = if config.is_active {
                    format!("● {}", config.name)
                } else {
                    format!("○ {}", config.name)
                };
                let switch_id = format!("sub_{}", config.name);
                let item = MenuItem::with_id(&app, &switch_id, &sub_label, true, None::<&str>)
                    .map_err(|e| format!("Failed to create subscription item: {}", e))?;
                sub_menu_builder = sub_menu_builder.item(&item);
            }
            
            let subscriptions_submenu = sub_menu_builder.build()
                .map_err(|e| format!("Failed to build subscriptions submenu: {}", e))?;
            builder = builder.item(&subscriptions_submenu);
        }
        
        // Build Proxies submenu (only show nodes from active subscription)
        if has_proxies {
            let mut proxy_menu_builder = SubmenuBuilder::new(&app, &proxies_text);
            
            for group in &proxy_groups {
                for proxy in group.proxies.iter().take(15) {
                    let id = format!("proxy_{}:{}", group.name, proxy.name);
                    let is_current = proxy.name == group.now;
                    let proxy_label = if is_current { format!("● {}", proxy.name) } else { format!("○ {}", proxy.name) };
                    let item = MenuItem::with_id(&app, &id, &proxy_label, true, None::<&str>)
                        .map_err(|e| format!("Failed to create proxy item: {}", e))?;
                    proxy_menu_builder = proxy_menu_builder.item(&item);
                }
            }
            
            let proxies_submenu = proxy_menu_builder.build()
                .map_err(|e| format!("Failed to build proxies submenu: {}", e))?;
            builder = builder.item(&proxies_submenu);
        }
    }
    
    // Separator and Quit
    let sep2 = PredefinedMenuItem::separator(&app)
        .map_err(|e| format!("Failed to create separator: {}", e))?;
    let quit_i = MenuItem::with_id(&app, "quit", &quit_text, true, None::<&str>)
        .map_err(|e| format!("Failed to create quit item: {}", e))?;
    
    builder = builder.item(&sep2).item(&quit_i);
    
    // Build menu
    let menu = builder.build()
        .map_err(|e| format!("Failed to build menu: {}", e))?;
    
    tray.set_menu(Some(menu))
        .map_err(|e| format!("Failed to set tray menu: {}", e))?;
    
    Ok(())
}

/// Update just the toggle states (lightweight update)
#[tauri::command]
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
