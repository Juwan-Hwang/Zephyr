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
///
/// The returned string is guaranteed to be at most `max_len` characters long.
/// When `max_len <= 3`, only a prefix of "..." is returned to honor the limit.
fn truncate_str(s: &str, max_len: usize) -> String {
    // If the string has at most `max_len` chars, no truncation is needed.
    // `nth(max_len)` returns None when the string is shorter than max_len+1 chars,
    // which is cheaper than counting all chars.
    if s.chars().nth(max_len).is_none() {
        s.to_owned()
    } else if max_len <= 3 {
        // For very small limits, return only the ellipsis prefix to honor max_len.
        "...".chars().take(max_len).collect()
    } else {
        let truncated: String = s.chars().take(max_len - 3).collect();
        format!("{truncated}...")
    }
}

#[cfg(test)]
#[path = "os_notification_tests.rs"]
mod os_notification_tests;
