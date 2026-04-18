use serde::Serialize;
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{command, AppHandle, Emitter, Manager, State};
use tauri_plugin_global_shortcut::{
    GlobalShortcutExt, Shortcut, ShortcutState,
};

/// Maximum number of global shortcuts allowed.
const MAX_SHORTCUTS: usize = 20;

/// Payload sent to the frontend when a global shortcut is triggered.
#[derive(Debug, Clone, Serialize)]
pub struct ShortcutPayload {
    pub action: String,
}

/// Internal state tracking registered shortcuts.
pub struct ShortcutRegistry(Mutex<HashMap<String, String>>);

impl Default for ShortcutRegistry {
    fn default() -> Self {
        Self(Mutex::new(HashMap::new()))
    }
}

/// Register a global shortcut.
///
/// `action` is a human-readable identifier (e.g. "toggle-window").
/// `accelerator` is a Tauri shortcut string (e.g. "CmdOrCtrl+Shift+Z").
const MAX_ACTION_LEN: usize = 64;
const MAX_ACCELERATOR_LEN: usize = 128;

#[command]
pub async fn register_shortcut(
    app: AppHandle,
    state: State<'_, ShortcutRegistry>,
    action: String,
    accelerator: String,
) -> Result<(), String> {
    // Input validation
    if action.len() > MAX_ACTION_LEN {
        return Err(format!("Action too long (max {} chars)", MAX_ACTION_LEN));
    }
    if accelerator.len() > MAX_ACCELERATOR_LEN {
        return Err(format!("Accelerator too long (max {} chars)", MAX_ACCELERATOR_LEN));
    }

    // S2: Enforce maximum shortcut count
    {
        let map = state.0.lock().map_err(|e| format!("Failed to lock state: {}", e))?;
        if map.len() >= MAX_SHORTCUTS && !map.contains_key(&action) {
            return Err(format!(
                "Maximum number of shortcuts ({}) reached. Unregister a shortcut first.",
                MAX_SHORTCUTS
            ));
        }
    }

    let shortcut: Shortcut = accelerator
        .parse::<Shortcut>()
        .map_err(|e| format!("Invalid shortcut: {}", e))?;

    // Unregister previous binding for this action if any
    if let Ok(map) = state.0.lock() {
        if let Some(old_accel) = map.get(&action).cloned() {
            if let Ok(old_shortcut) = old_accel.parse::<Shortcut>() {
                let _ = app.global_shortcut().unregister(old_shortcut);
            }
        }
    }

    let action_clone = action.clone();
    app.global_shortcut()
        .on_shortcut(shortcut, move |_app_handle, _shortcut, event| {
            if event.state() == ShortcutState::Pressed {
                if let Some(window) = _app_handle.get_webview_window("main") {
                    let _ = window.emit(
                        "global-shortcut",
                        ShortcutPayload {
                            action: action_clone.clone(),
                        },
                    );
                }
            }
        })
        .map_err(|e| format!("Failed to register shortcut: {}", e))?;

    state
        .0
        .lock()
        .map_err(|e| format!("Failed to lock state: {}", e))?
        .insert(action, accelerator);
    Ok(())
}

/// Unregister a previously registered global shortcut by action name.
#[command]
pub async fn unregister_shortcut(
    app: AppHandle,
    state: State<'_, ShortcutRegistry>,
    action: String,
) -> Result<(), String> {
    let accelerator = state
        .0
        .lock()
        .map_err(|e| format!("Failed to lock state: {}", e))?
        .remove(&action)
        .ok_or_else(|| format!("Shortcut '{}' not registered", action))?;

    let shortcut: Shortcut = accelerator
        .parse()
        .map_err(|e| format!("Invalid shortcut: {}", e))?;

    app.global_shortcut()
        .unregister(shortcut)
        .map_err(|e| format!("Failed to unregister shortcut: {}", e))?;

    Ok(())
}
