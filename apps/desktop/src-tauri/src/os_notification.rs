use tauri::{command, AppHandle};
use tauri_plugin_notification::NotificationExt as _;

/// Send an OS-level notification.
///
/// Uses the Tauri notification plugin to display a native desktop notification.
/// Title is truncated to 128 characters and body to 1024 characters for safety.
#[command]
#[allow(clippy::needless_pass_by_value)]
pub fn send_notification(app: AppHandle, title: String, body: String) -> Result<(), String> {
    // S1: Truncate title and body to prevent abuse
    let truncated_title = truncate_str(&title, 128);
    let truncated_body = truncate_str(&body, 1024);

    app.notification()
        .builder()
        .title(&truncated_title)
        .body(&truncated_body)
        .id(1)
        .show()
        .map_err(|e| format!("Failed to show notification: {e}"))?;

    Ok(())
}

/// Truncate a string to `max_len` characters. If truncation occurs, appends "...".
fn truncate_str(s: &str, max_len: usize) -> String {
    if s.chars().count() <= max_len {
        s.to_owned()
    } else {
        let truncated: String = s.chars().take(max_len.saturating_sub(3)).collect();
        format!("{truncated}...")
    }
}

#[cfg(test)]
#[path = "os_notification_tests.rs"]
mod os_notification_tests;
