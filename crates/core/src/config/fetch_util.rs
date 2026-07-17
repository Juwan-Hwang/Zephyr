//! HTTP client configuration and URL validation — platform-agnostic pure functions.
//!
//! Migrated from `src-tauri/src/core/fetch_util.rs`.
//! Only pure data types and validation functions are here;
//! `build_http_client()` and `fetch_url_content()` stay in src-tauri (reqwest-dependent).

use super::subscription::{is_private_host, is_private_ip};
use crate::error::AppError;

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
    if host.contains(':') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
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

    // Check if user explicitly entered a private/local host
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
        assert_eq!(
            format_host_port("2001:db8::1".to_owned(), 443),
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
}
