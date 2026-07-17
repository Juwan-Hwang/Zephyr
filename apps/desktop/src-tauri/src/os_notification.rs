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
    // Only inspect the first max_len+1 chars to decide if truncation is needed,
    // avoiding a full scan of long strings. Use saturating_add to guard against
    // overflow when max_len == usize::MAX.
    if s.chars().take(max_len.saturating_add(1)).count() <= max_len {
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
