use serde::Serialize;

/// Payload sent to the frontend when a deep link is received.
#[derive(Debug, Clone, Serialize)]
pub struct DeepLinkPayload {
    pub action: String,
    pub url: String,
    pub name: String,
}

/// Maximum length for the `name` parameter in deep links.
const MAX_NAME_LEN: usize = 128;

/// Characters that could enable path traversal, injection, or invalid filenames.
const DANGEROUS_CHARS: &[char] = &[
    '.', '/', '\\', '\0', '\n', '\r',
    // Windows reserved filename characters (cross-platform safety)
    '<', '>', ':', '"', '|', '?', '*',
];

/// Sanitize the `name` parameter: replace dangerous characters, strip trailing
/// whitespace, prefix Windows reserved device names, and truncate.
fn sanitize_name(raw: &str) -> String {
    let sanitized: String = raw
        .chars()
        .map(|c| if DANGEROUS_CHARS.contains(&c) { '_' } else { c })
        .collect();
    // Remove trailing whitespace (invalid in Windows filenames)
    let trimmed = sanitized.trim_end();
    // Prefix underscore if result is a Windows reserved device name
    let result = match trimmed.to_ascii_uppercase().as_str() {
        "CON" | "PRN" | "AUX" | "NUL" | "COM1" | "COM2" | "COM3" | "COM4" | "COM5" | "COM6"
        | "COM7" | "COM8" | "COM9" | "LPT1" | "LPT2" | "LPT3" | "LPT4" | "LPT5" | "LPT6"
        | "LPT7" | "LPT8" | "LPT9" => format!("_{trimmed}"),
        _ => trimmed.to_owned(),
    };
    // Truncate to MAX_NAME_LEN characters
    if result.chars().count() > MAX_NAME_LEN {
        result.chars().take(MAX_NAME_LEN).collect()
    } else {
        result
    }
}

/// Parse a `clash://install-config?url=<encoded>&name=<encoded>` deep link.
///
/// Returns `None` if the URL is malformed or the `url` parameter is not
/// `http://` or `https://`.
///
/// S6: Uses `url::Url::parse()` for protocol validation instead of `starts_with`.
/// S3: Sanitizes the `name` parameter to prevent path traversal attacks.
#[must_use]
pub fn parse_deep_link(raw: &str) -> Option<DeepLinkPayload> {
    let parsed = url::Url::parse(raw).ok()?;

    // S6: Only accept clash:// scheme (validated via url crate)
    if parsed.scheme() != "clash" {
        return None;
    }

    // Action is the host part (e.g. "install-config" in clash://install-config?...)
    let action = parsed.host_str()?.to_owned();

    let params = parsed.query_pairs();

    let mut url_val = None;
    let mut name_val = String::new();

    for (key, value) in params {
        match key.as_ref() {
            "url" => url_val = Some(value.into_owned()),
            "name" => name_val = value.into_owned(),
            _ => {}
        }
    }

    let url = url_val?;

    // Truncate URL to prevent memory abuse
    const MAX_URL_LEN: usize = 2048;
    let safe_url = if url.len() > MAX_URL_LEN {
        // Find the nearest UTF-8 char boundary to avoid panic on multi-byte chars
        let mut end = MAX_URL_LEN;
        while end > 0 && !url.is_char_boundary(end) {
            end -= 1;
        }
        &url[..end]
    } else {
        &url
    };

    // Security: only allow http:// or https:// via proper URL parsing
    // Use url::Url to parse and validate the scheme, preventing @-bypass attacks
    // like http://attacker.com@legitimate.com
    match url::Url::parse(safe_url) {
        Ok(parsed) => {
            if parsed.scheme() != "http" && parsed.scheme() != "https" {
                return None;
            }
            // Additional validation: ensure the URL has a valid host
            parsed.host()?;
        }
        Err(_) => return None,
    }

    // S3: Sanitize name parameter
    let name = sanitize_name(&name_val);

    Some(DeepLinkPayload {
        action,
        url: safe_url.to_owned(),
        name,
    })
}

/// Links held until the main page has its listener: the event is dispatched
/// straight into the page, so one sent while the page is still loading (at
/// startup, or after the window was recreated) would otherwise be dropped.
#[derive(Debug, Default)]
struct DeepLinkQueue {
    page_ready: bool,
    pending: Vec<DeepLinkPayload>,
}

/// At most this many links wait for the page; older ones are dropped first.
const MAX_PENDING: usize = 8;

impl DeepLinkQueue {
    /// Returns the payload when the page can take it now, otherwise keeps it.
    fn offer(&mut self, payload: DeepLinkPayload) -> Option<DeepLinkPayload> {
        if self.page_ready {
            return Some(payload);
        }
        if self.pending.len() >= MAX_PENDING {
            self.pending.remove(0);
        }
        self.pending.push(payload);
        None
    }

    /// The page has its listener: everything held so far goes to it.
    fn take_for_ready_page(&mut self) -> Vec<DeepLinkPayload> {
        self.page_ready = true;
        std::mem::take(&mut self.pending)
    }
}

static QUEUE: std::sync::Mutex<DeepLinkQueue> = std::sync::Mutex::new(DeepLinkQueue {
    page_ready: false,
    pending: Vec::new(),
});

fn queue() -> std::sync::MutexGuard<'static, DeepLinkQueue> {
    QUEUE
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// The main page is being replaced: links wait until the new one asks.
pub fn main_page_gone() {
    queue().page_ready = false;
}

/// Called by the page once its `deep-link` listener is registered; returns
/// the links that arrived before it.
#[tauri::command]
#[must_use]
pub fn take_pending_deep_links() -> Vec<DeepLinkPayload> {
    queue().take_for_ready_page()
}

fn deliver(app: &tauri::AppHandle, payload: DeepLinkPayload) {
    let ready = queue().offer(payload);
    if let Some(payload) = ready {
        crate::backend_event::emit_to_main(app, "deep-link", payload);
    }
}

/// Check command-line arguments for deep link URLs.
/// On Windows, protocol associations pass the URL as a CLI argument.
/// On macOS/Linux, they may also arrive via argv.
pub fn handle_cli_deep_links(app: &tauri::AppHandle) {
    // `args_os`: `args` panics on an argument that is not valid Unicode.
    for arg in std::env::args_os().filter_map(|arg| arg.into_string().ok()) {
        if arg.starts_with("clash://") {
            if let Some(payload) = parse_deep_link(&arg) {
                deliver(app, payload);
            }
        }
    }
}

/// Emit a deep link event to the main window, or hold it until the page
/// is ready. Can be called from any context where we have an `AppHandle`.
pub fn emit_deep_link(app: &tauri::AppHandle, raw_url: &str) {
    if let Some(payload) = parse_deep_link(raw_url) {
        deliver(app, payload);
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    fn link(name: &str) -> DeepLinkPayload {
        DeepLinkPayload {
            action: "install-config".to_owned(),
            url: "https://example.com/sub".to_owned(),
            name: name.to_owned(),
        }
    }

    #[test]
    fn links_wait_for_the_page_and_go_straight_through_after() {
        let mut q = DeepLinkQueue::default();
        assert!(q.offer(link("a")).is_none());
        assert!(q.offer(link("b")).is_none());
        let held: Vec<String> = q
            .take_for_ready_page()
            .into_iter()
            .map(|p| p.name)
            .collect();
        assert_eq!(held, ["a", "b"]);
        assert_eq!(q.offer(link("c")).map(|p| p.name).as_deref(), Some("c"));
        assert!(q.take_for_ready_page().is_empty());
    }

    #[test]
    fn a_replaced_page_holds_links_again_and_keeps_only_the_newest() {
        let mut q = DeepLinkQueue::default();
        let _ = q.take_for_ready_page();
        q.page_ready = false;
        for i in 0..(MAX_PENDING + 2) {
            assert!(q.offer(link(&i.to_string())).is_none());
        }
        let held = q.take_for_ready_page();
        assert_eq!(held.len(), MAX_PENDING);
        assert_eq!(held.first().map(|p| p.name.as_str()), Some("2"));
    }

    #[test]
    fn test_parse_valid_deep_link() {
        let url = "clash://install-config?url=https%3A%2F%2Fexample.com%2Fsub&name=MySub";
        let payload = parse_deep_link(url).unwrap();
        assert_eq!(payload.action, "install-config");
        assert_eq!(payload.url, "https://example.com/sub");
        assert_eq!(payload.name, "MySub");
    }

    #[test]
    fn test_parse_rejects_non_http() {
        let url = "clash://install-config?url=ftp%3A%2F%2Fevil.com&name=Bad";
        assert!(parse_deep_link(url).is_none());
    }

    #[test]
    fn test_parse_rejects_wrong_scheme() {
        let url = "http://install-config?url=https://example.com&name=Bad";
        assert!(parse_deep_link(url).is_none());
    }

    #[test]
    fn test_parse_missing_url_param() {
        let url = "clash://install-config?name=NoUrl";
        assert!(parse_deep_link(url).is_none());
    }

    #[test]
    fn test_sanitize_name_path_traversal() {
        assert_eq!(sanitize_name("../../../etc/passwd"), "_________etc_passwd");
    }

    #[test]
    fn test_sanitize_name_null_and_newlines() {
        assert_eq!(sanitize_name("foo\0bar\nbaz\rcar"), "foo_bar_baz_car");
    }

    #[test]
    fn test_sanitize_name_truncation() {
        let long_name = "a".repeat(200);
        let sanitized = sanitize_name(&long_name);
        assert_eq!(sanitized.chars().count(), 128);
    }

    #[test]
    fn test_sanitize_name_backslash() {
        assert_eq!(sanitize_name("foo\\bar"), "foo_bar");
    }

    // ── parse_deep_link tests (migrated from lib_test.rs) ──────────────────

    #[test]
    fn test_parse_deep_link_basic() {
        let result =
            parse_deep_link("clash://install-config?url=https://example.com/config.yaml&name=test")
                .unwrap();
        assert_eq!(result.url, "https://example.com/config.yaml");
        assert_eq!(result.name, "test");
    }

    #[test]
    fn test_parse_deep_link_url_only() {
        let result =
            parse_deep_link("clash://install-config?url=https://example.com/config.yaml").unwrap();
        assert_eq!(result.url, "https://example.com/config.yaml");
        assert!(result.name.is_empty());
    }

    #[test]
    fn test_parse_deep_link_with_encoded_chars() {
        let result = parse_deep_link(
            "clash://install-config?url=https%3A%2F%2Fexample.com%2Fconfig.yaml&name=my%20config",
        )
        .unwrap();
        assert_eq!(result.url, "https://example.com/config.yaml");
        assert_eq!(result.name, "my config");
    }

    #[test]
    fn test_parse_deep_link_missing_url() {
        let result = parse_deep_link("clash://install-config?name=test");
        assert!(result.is_none());
    }

    #[test]
    fn test_parse_deep_link_empty() {
        let result = parse_deep_link("");
        assert!(result.is_none());
    }

    #[test]
    fn test_parse_deep_link_invalid_scheme() {
        let result = parse_deep_link("https://example.com");
        assert!(result.is_none());
    }

    #[test]
    fn test_parse_deep_link_multiple_params() {
        let result = parse_deep_link(
            "clash://install-config?url=https://example.com/config.yaml&name=test&extra=value",
        )
        .unwrap();
        assert_eq!(result.url, "https://example.com/config.yaml");
        assert_eq!(result.name, "test");
    }

    // -- Snapshot tests for name sanitization ------------------------------

    #[test]
    fn snapshot_sanitize_name_normal() {
        insta::assert_snapshot!(sanitize_name("My Subscription"));
    }

    #[test]
    fn snapshot_sanitize_name_path_traversal() {
        insta::assert_snapshot!(sanitize_name("../../../etc/passwd"));
    }

    #[test]
    fn snapshot_sanitize_name_dangerous_chars() {
        insta::assert_snapshot!(sanitize_name("test<>:\"|?*\0"));
    }

    #[test]
    fn snapshot_sanitize_name_long_name() {
        insta::assert_snapshot!(sanitize_name(&"A".repeat(200)));
    }

    #[test]
    fn snapshot_sanitize_name_reserved_con() {
        insta::assert_snapshot!(sanitize_name("CON"));
    }

    #[test]
    fn snapshot_sanitize_name_reserved_nul_lower() {
        insta::assert_snapshot!(sanitize_name("nul"));
    }

    #[test]
    fn snapshot_sanitize_name_trailing_spaces() {
        insta::assert_snapshot!(sanitize_name("test  "));
    }
}
