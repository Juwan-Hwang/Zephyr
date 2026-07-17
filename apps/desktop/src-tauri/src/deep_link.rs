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

/// Characters that could enable path traversal or injection attacks.
const DANGEROUS_CHARS: &[char] = &['.', '/', '\\', '\0', '\n', '\r'];

/// Sanitize the `name` parameter: replace dangerous characters and truncate.
fn sanitize_name(raw: &str) -> String {
    let sanitized: String = raw
        .chars()
        .map(|c| if DANGEROUS_CHARS.contains(&c) { '_' } else { c })
        .collect();
    // Truncate to MAX_NAME_LEN characters
    if sanitized.chars().count() > MAX_NAME_LEN {
        sanitized.chars().take(MAX_NAME_LEN).collect()
    } else {
        sanitized
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

/// Check command-line arguments for deep link URLs.
/// On Windows, protocol associations pass the URL as a CLI argument.
/// On macOS/Linux, they may also arrive via argv.
pub fn handle_cli_deep_links(app: &tauri::AppHandle) {
    let args: Vec<String> = std::env::args().collect();
    for arg in &args {
        if arg.starts_with("clash://") {
            if let Some(payload) = parse_deep_link(arg) {
                crate::backend_event::emit_to_main(app, "deep-link", payload);
            }
        }
    }
}

/// Emit a deep link event to the main window.
/// Can be called from any context where we have an `AppHandle`.
pub fn emit_deep_link(app: &tauri::AppHandle, raw_url: &str) {
    if let Some(payload) = parse_deep_link(raw_url) {
        crate::backend_event::emit_to_main(app, "deep-link", payload);
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

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
}
