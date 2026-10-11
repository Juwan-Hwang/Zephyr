//! HTTP client configuration and URL validation — platform-agnostic pure functions.
//!
//! Migrated from `src-tauri/src/core/fetch_util.rs`.
//! Only pure data types and validation functions are here;
//! `build_http_client()` and `fetch_url_content()` stay in src-tauri (reqwest-dependent).

use super::subscription::{
    is_mihomo_fake_ip, is_private_host, is_private_ip, is_single_label_host,
};
use crate::error::AppError;

pub const SSRF_BLOCK_MARKER: &str = "[SSRF_BLOCKED]";
pub const LOCAL_DNS_SSRF_MARKER: &str = "[LOCAL_DNS_SSRF]";

/// Validate an HTTP redirect hop to protect against SSRF.
///
/// Permits redirects to the same `allowed_private_host` configured for direct downloads,
/// while rejecting any redirect to unauthorized private networks, single-label hosts,
/// or synthetic fake-IP addresses.
pub fn check_redirect_target(
    url: &url::Url,
    allowed_private_host: Option<&str>,
) -> Result<(), String> {
    let scheme = url.scheme();
    if scheme != "http" && scheme != "https" {
        return Err(format!("Invalid redirect scheme: {scheme}"));
    }

    let host = match url.host_str() {
        Some(h) => h,
        None => return Err("Redirect URL has no host".to_owned()),
    };

    fn normalize_host(h: &str) -> &str {
        let trimmed = h.trim().trim_end_matches('.');
        trimmed
            .strip_prefix('[')
            .and_then(|s| s.strip_suffix(']'))
            .unwrap_or(trimmed)
    }

    let same_allowed = allowed_private_host
        .is_some_and(|a| normalize_host(a).eq_ignore_ascii_case(normalize_host(host)));

    if !same_allowed && (is_private_host(host) || is_single_label_host(host)) {
        return Err(format!(
            "{SSRF_BLOCK_MARKER} Redirect to private host blocked: {host}"
        ));
    }

    let clean_host = host.trim_matches(['[', ']'].as_slice());
    if let Ok(ip) = clean_host.parse::<std::net::IpAddr>() {
        if is_mihomo_fake_ip(ip) {
            return Err(format!(
                "{SSRF_BLOCK_MARKER} Redirect to fake IP blocked: {host}"
            ));
        }
        if !same_allowed && is_private_ip(ip) {
            return Err(format!(
                "{SSRF_BLOCK_MARKER} Redirect to private IP blocked: {host}"
            ));
        }
    }

    Ok(())
}

/// Configuration for HTTP client building.
///
/// Migrated from `src-tauri/src/core/fetch_util.rs`.
/// The `resolve_pin` field uses a `UrlResolvePin` Record instead of
/// `(String, SocketAddr)` tuple for `UniFFI` compatibility.
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
#[derive(Debug, Clone, Default)]
pub struct HttpClientConfig {
    pub user_agent: Option<String>,
    pub timeout_secs: u64,
    pub connect_timeout_secs: u64,
    pub proxy_url: Option<String>,
    /// DNS pinning: host → IP:port string (e.g., "example.com" → "1.2.3.4:443").
    /// The platform side parses this into a `SocketAddr` for the actual HTTP client.
    pub resolve_pin: Option<UrlResolvePin>,
}

/// DNS resolution pin entry for HTTP client.
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
#[derive(Debug, Clone)]
pub struct UrlResolvePin {
    pub host: String,
    pub addr: String, // "ip:port" format
}

/// Result of basic URL validation.
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
#[derive(Debug, Clone)]
pub struct UrlValidationResult {
    pub host: String,
    pub port: u16,
    pub user_entered_private: bool,
}

/// Format a host:port string, handling IPv6 bracket notation.
///
/// Migrated from `src-tauri/src/core/fetch_util.rs`.
#[cfg_attr(feature = "uniffi", uniffi::export)]
#[must_use]
pub fn format_host_port(host: String, port: u16) -> String {
    let host_str = host.as_str();
    let unbracketed = if host_str.starts_with('[') && host_str.ends_with(']') && host_str.len() >= 2
    {
        &host_str[1..host_str.len() - 1]
    } else {
        host_str
    };
    if unbracketed.contains(':') {
        format!("[{unbracketed}]:{port}")
    } else {
        format!("{unbracketed}:{port}")
    }
}

/// Basic URL validation without DNS resolution.
///
/// Returns host, port, and whether the user entered a private address.
/// Uses `url::Url` instead of `reqwest::Url` for core crate compatibility.
///
/// Migrated from `src-tauri/src/core/fetch_util.rs`.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn validate_url_basic(url: String) -> Result<UrlValidationResult, AppError> {
    let parsed_url =
        url::Url::parse(&url).map_err(|e| AppError::ParseError(format!("Invalid URL: {e}")))?;

    // Only allow http and https schemes
    let scheme = parsed_url.scheme();
    if scheme != "http" && scheme != "https" {
        return Err(AppError::ConfigError(
            "Only HTTP and HTTPS URLs are allowed".to_owned(),
        ));
    }

    // Extract host
    let host = parsed_url
        .host_str()
        .ok_or_else(|| AppError::ParseError("URL must have a host".to_owned()))?
        .to_owned();

    let port = parsed_url
        .port()
        .unwrap_or(if scheme == "https" { 443 } else { 80 });

    // Explicit private IPs, localhost, and private-suffix hostnames (.local, .lan, etc.)
    // are classified as user-entered private destinations.
    let user_entered_private = is_private_host(&host);

    Ok(UrlValidationResult {
        host,
        port,
        user_entered_private,
    })
}

/// Validate that resolved addresses for a public host are all public IPs.
///
/// Returns the first valid address as a string "ip:port" for `UniFFI` compatibility.
/// Migrated from `src-tauri/src/core/fetch_util.rs`.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn validate_public_host_addrs_str(
    host: String,
    addrs: Vec<String>,
) -> Result<UrlResolvePin, AppError> {
    let mut resolved_addr: Option<String> = None;

    for addr_str in &addrs {
        let addr: std::net::SocketAddr = addr_str
            .parse()
            .map_err(|e| AppError::ParseError(format!("Invalid address '{addr_str}': {e}")))?;

        if is_private_ip(addr.ip()) {
            return Err(AppError::NetworkError(format!(
                "SSRF protection: host '{}' resolved to private IP {} — access to private/local addresses is not allowed",
                host, addr.ip()
            )));
        }
        if resolved_addr.is_none() {
            resolved_addr = Some(addr_str.clone());
        }
    }

    let addr = resolved_addr.ok_or_else(|| {
        AppError::NetworkError("Could not resolve any IP address for the host".to_owned())
    })?;

    Ok(UrlResolvePin { host, addr })
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn test_format_host_port() {
        assert_eq!(
            format_host_port("example.com".to_owned(), 443),
            "example.com:443"
        );
        assert_eq!(format_host_port("::1".to_owned(), 80), "[::1]:80");
        assert_eq!(format_host_port("[::1]".to_owned(), 80), "[::1]:80");
        assert_eq!(
            format_host_port("2001:db8::1".to_owned(), 443),
            "[2001:db8::1]:443"
        );
        assert_eq!(
            format_host_port("[2001:db8::1]".to_owned(), 443),
            "[2001:db8::1]:443"
        );
    }

    #[test]
    fn test_validate_url_basic_rejects_invalid_schemes() {
        assert!(validate_url_basic("ftp://example.com/file".to_owned()).is_err());
        assert!(validate_url_basic("file:///etc/passwd".to_owned()).is_err());
        assert!(validate_url_basic("javascript:alert(1)".to_owned()).is_err());
    }

    #[test]
    fn test_validate_url_basic_extracts_port() {
        let r = validate_url_basic("http://example.com".to_owned()).unwrap();
        assert_eq!(r.host, "example.com");
        assert_eq!(r.port, 80);

        let r = validate_url_basic("https://example.com".to_owned()).unwrap();
        assert_eq!(r.port, 443);

        let r = validate_url_basic("http://example.com:8080".to_owned()).unwrap();
        assert_eq!(r.port, 8080);
    }

    #[test]
    fn test_validate_url_basic_private_host() {
        let r = validate_url_basic("http://192.168.1.1/sub".to_owned()).unwrap();
        assert!(r.user_entered_private);

        let r = validate_url_basic("http://example.com/sub".to_owned()).unwrap();
        assert!(!r.user_entered_private);
    }

    #[test]
    fn test_validate_public_host_addrs_str() {
        let r =
            validate_public_host_addrs_str("example.com".to_owned(), vec!["1.2.3.4:80".to_owned()])
                .unwrap();
        assert_eq!(r.host, "example.com");
        assert_eq!(r.addr, "1.2.3.4:80");
    }

    #[test]
    fn test_validate_public_host_addrs_str_rejects_private() {
        let r = validate_public_host_addrs_str(
            "evil.com".to_owned(),
            vec!["192.168.1.1:80".to_owned()],
        );
        assert!(r.is_err());
        let err = r.unwrap_err();
        let msg = match &err {
            AppError::NetworkError(m) => m.clone(),
            AppError::IoError(_)
            | AppError::ConfigError(_)
            | AppError::CryptoError(_)
            | AppError::Cancelled
            | AppError::ParseError(_)
            | AppError::UnknownError(_) => {
                format!("{err}")
            }
        };
        assert!(msg.contains("SSRF protection"));
    }

    #[test]
    fn test_check_redirect_target_allowed_private_host() {
        let u1 = url::Url::parse("http://nas.lan/sub/").unwrap();
        assert!(check_redirect_target(&u1, Some("nas.lan")).is_ok());

        let u2 = url::Url::parse("http://nas.lan./sub/").unwrap();
        assert!(check_redirect_target(&u2, Some("nas.lan")).is_ok());

        let u3 = url::Url::parse("http://192.168.1.1/sub/").unwrap();
        assert!(check_redirect_target(&u3, Some("192.168.1.1")).is_ok());

        // Redirect to a different private host is blocked
        let u_diff = url::Url::parse("http://other.lan/sub/").unwrap();
        let res = check_redirect_target(&u_diff, Some("nas.lan"));
        assert!(res.is_err());
        assert!(res.unwrap_err().contains(SSRF_BLOCK_MARKER));

        // Redirect to a different private IP is blocked
        let u_diff_ip = url::Url::parse("http://192.168.1.2/sub/").unwrap();
        let res_ip = check_redirect_target(&u_diff_ip, Some("192.168.1.1"));
        assert!(res_ip.is_err());
        assert!(res_ip.unwrap_err().contains(SSRF_BLOCK_MARKER));

        // Redirect to public host is allowed
        let u_pub = url::Url::parse("https://example.com/sub/").unwrap();
        assert!(check_redirect_target(&u_pub, None).is_ok());

        // Redirect to fake-IP is always blocked even if nominally specified
        let u_fake = url::Url::parse("http://198.18.0.1/sub/").unwrap();
        let res_fake = check_redirect_target(&u_fake, Some("198.18.0.1"));
        assert!(res_fake.is_err());
        assert!(res_fake
            .unwrap_err()
            .contains("Redirect to fake IP blocked"));
    }
}
