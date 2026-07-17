/**
 * Unified remote fetching utilities with SSRF protection.
 *
 * This module provides a single, consistent way to perform HTTP requests
 * with proper security measures (SSRF protection, DNS pinning, redirect validation).
 *
 * Security measures aligned with subscription.rs original implementation:
 * - URL scheme validation (http/https only)
 * - Private host detection (localhost, .local, .localhost, private IPs)
 * - Private IP detection using stdlib methods (`is_private`, `is_loopback`, etc.)
 * - DNS resolution validation (public domain → private IP = SSRF block)
 * - DNS pinning for public addresses
 * - Redirect validation (blocks redirects to private hosts/IPs)
 * - Response size limiting (`MAX_RESPONSE_SIZE`)
 * - `.no_proxy()` by default to prevent system proxy leaks
 */
use std::time::Duration;

use super::MAX_RESPONSE_SIZE;
use zephyr_core::config::subscription::{is_private_host, is_private_ip};

/// Configuration for HTTP client building.
#[derive(Debug, Clone)]
pub struct HttpClientConfig {
    pub user_agent: Option<String>,
    pub timeout_secs: u64,
    pub connect_timeout_secs: u64,
    pub proxy_url: Option<String>,
    pub resolve_pin: Option<(String, std::net::SocketAddr)>,
}

impl Default for HttpClientConfig {
    fn default() -> Self {
        Self {
            user_agent: None,
            timeout_secs: 30,
            connect_timeout_secs: 30,
            proxy_url: None,
            resolve_pin: None,
        }
    }
}

/// Format a host:port string, handling IPv6 bracket notation.
fn format_host_port(host: &str, port: u16) -> String {
    if host.contains(':') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    }
}

/// Build an HTTP client with security settings.
///
/// Features:
/// - Redirect validation (blocks redirects to private IPs)
/// - Timeout configuration
/// - Optional proxy support
/// - Optional DNS pinning (`resolve_pin`)
/// - `.no_proxy()` by default to prevent system proxy leaks
pub fn build_http_client(config: HttpClientConfig) -> Result<reqwest::Client, String> {
    let redirect_policy = reqwest::redirect::Policy::custom(|attempt| {
        if attempt.previous().len() > 5 {
            return attempt.error("Too many redirects (max 5)");
        }

        let url = attempt.url().clone();
        let scheme = url.scheme();
        if scheme != "http" && scheme != "https" {
            return attempt.error(format!("Invalid redirect scheme: {scheme}"));
        }

        let host = match url.host_str() {
            Some(h) => h.to_owned(),
            None => return attempt.error("Redirect URL has no host"),
        };

        if is_private_host(&host) {
            return attempt.error(format!("Redirect to private host blocked: {host}"));
        }

        let port = url
            .port()
            .unwrap_or(if scheme == "https" { 443 } else { 80 });
        let host_port = format_host_port(&host, port);
        match std::net::ToSocketAddrs::to_socket_addrs(&host_port) {
            Ok(addrs) => {
                for addr in addrs {
                    if is_private_ip(addr.ip()) {
                        return attempt.error(format!(
                            "Redirect to private IP blocked: {} -> {}",
                            host,
                            addr.ip()
                        ));
                    }
                }
            }
            Err(e) => return attempt.error(format!("Failed to resolve redirect host {host}: {e}")),
        }

        attempt.follow()
    });

    // .no_proxy() by default to prevent system proxy leaks (SSRF attack surface reduction).
    // A proxy is only added if explicitly configured via config.proxy_url.
    let mut client_builder = reqwest::Client::builder()
        .timeout(Duration::from_secs(config.timeout_secs))
        .connect_timeout(Duration::from_secs(config.connect_timeout_secs))
        .redirect(redirect_policy)
        .no_proxy();

    // Add proxy if configured
    if let Some(proxy_url) = config.proxy_url {
        let proxy =
            reqwest::Proxy::all(&proxy_url).map_err(|e| format!("Failed to create proxy: {e}"))?;
        client_builder = client_builder.proxy(proxy);
    }

    // Add DNS pinning if configured
    if let Some((host, addr)) = config.resolve_pin {
        client_builder = client_builder.resolve(&host, addr);
    }

    // Set User-Agent (simple default, no Shadowrocket handling here)
    // Shadowrocket and other custom UA handling is done in subscription.rs
    let ua = config
        .user_agent
        .unwrap_or_else(|| format!("Zephyr/{}", env!("CARGO_PKG_VERSION")));
    client_builder = client_builder.user_agent(ua);

    client_builder
        .build()
        .map_err(|e| format!("HTTP client build failed: {e}"))
}

/// Fetch content from a URL with full security checks.
///
/// This is the main entry point for remote fetching. It handles:
/// - URL validation (SSRF protection)
/// - HTTP client building with security settings
/// - Response size limiting
/// - Timeout handling
///
/// Download strategy (aligned with subscription.rs):
/// 1. Try direct connection first (with DNS pinning for public addresses)
/// 2. If direct fails and proxy is available, try proxy (without DNS pinning)
///
/// The proxy path skips DNS pre-resolve pinning to let the proxy handle DNS
/// resolution. This avoids issues with CDN / geo-balanced IPs and split-horizon
/// DNS where only the proxy can resolve the domain.
///
/// # Arguments
/// * `url` - The URL to fetch
/// * `proxy_port` - Optional local proxy port (for proxied downloads as fallback)
///
/// # Returns
/// * `Ok(String)` - The fetched content as UTF-8 string
/// * `Err(String)` - Error message if fetch failed
pub async fn fetch_url_content(url: &str, proxy_port: Option<u16>) -> Result<String, String> {
    // Basic URL validation (scheme, host format) without DNS resolution
    // DNS resolution is deferred to allow proxy to handle it
    let (host, port, user_entered_private) = validate_url_basic(url)?;

    // Try direct connection first (with DNS pinning for public addresses)
    let direct_result = try_direct_download(url, &host, port, user_entered_private).await;

    match direct_result {
        Ok(content) => Ok(content),
        Err(direct_err) => {
            crate::emit_warn!(
                Subscription,
                SUB_DIRECT_DOWNLOAD_FAILED,
                "Direct download failed: {direct_err}"
            );

            // Try proxy fallback if available
            if let Some(port) = proxy_port.filter(|&p| p > 0) {
                crate::emit_info!(
                    Subscription,
                    SUB_PROXY_RETRY,
                    "Retrying with proxy on port {port}..."
                );
                match try_proxy_download(url, port).await {
                    Ok(content) => Ok(content),
                    Err(proxy_err) => Err(format!("Direct: {direct_err}; Proxy: {proxy_err}")),
                }
            } else {
                Err(direct_err)
            }
        }
    }
}

/// Basic URL validation without DNS resolution.
///
/// Returns `(host, port, user_entered_private)` for further processing.
fn validate_url_basic(url: &str) -> Result<(String, u16, bool), String> {
    let parsed_url = reqwest::Url::parse(url).map_err(|e| format!("Invalid URL: {e}"))?;

    // Only allow http and https schemes
    let scheme = parsed_url.scheme();
    if scheme != "http" && scheme != "https" {
        return Err("Only HTTP and HTTPS URLs are allowed".to_owned());
    }

    // Extract host
    let host = parsed_url
        .host_str()
        .ok_or("URL must have a host")?
        .to_owned();

    let port = parsed_url
        .port()
        .unwrap_or(if scheme == "https" { 443 } else { 80 });

    // Check if user explicitly entered a private/local host
    let user_entered_private = is_private_host(&host);

    Ok((host, port, user_entered_private))
}

/// Try direct download with DNS pinning for public addresses.
async fn try_direct_download(
    url: &str,
    host: &str,
    port: u16,
    user_entered_private: bool,
) -> Result<String, String> {
    // For user-entered private addresses, skip DNS resolution
    // For public addresses, resolve and pin to prevent DNS rebinding
    let resolve_pin = if user_entered_private {
        None
    } else {
        let addr = resolve_and_pin(host, port).await?;
        Some((host.to_owned(), addr))
    };

    let config = HttpClientConfig {
        resolve_pin,
        ..Default::default()
    };
    let client = build_http_client(config)?;
    fetch_body(&client, url).await
}

/// Resolve host and return first valid public address for DNS pinning.
///
/// The port is included in resolution to ensure the returned `SocketAddr`
/// matches the request port (e.g., 443 for HTTPS).
///
/// Security: If ANY resolved address is private, the request is blocked.
/// This prevents DNS rebinding attacks where a public domain resolves to
/// both public and private IPs.
async fn resolve_and_pin(host: &str, port: u16) -> Result<std::net::SocketAddr, String> {
    let host_port = format_host_port(host, port);

    let addrs: Vec<std::net::SocketAddr> = tokio::task::spawn_blocking(move || {
        std::net::ToSocketAddrs::to_socket_addrs(&host_port)
            .map(std::iter::Iterator::collect)
            .map_err(|e| format!("Failed to resolve host: {e}"))
    })
    .await
    .map_err(|e| format!("DNS resolution task failed: {e}"))??;

    // Core validation logic - aligned with subscription.rs validate_public_host_addrs
    let mut resolved_addr = None;

    for addr in &addrs {
        if is_private_ip(addr.ip()) {
            // Public domain resolving to a private IP = SSRF, always block.
            return Err(format!(
                "SSRF protection: host '{}' resolved to private IP {} — access to private/local addresses is not allowed",
                host, addr.ip()
            ));
        }
        if resolved_addr.is_none() {
            resolved_addr = Some(*addr);
        }
    }

    resolved_addr.ok_or_else(|| "Could not resolve any IP address for the host".to_owned())
}

/// Try proxy download without DNS pinning.
///
/// SSRF protection for proxy path:
/// - Initial URL host validated (private host check)
/// - Redirect policy blocks redirects to private hosts/IPs
/// - Proxy-side SSRF is NOT preventable client-side — inherent to proxy architecture
async fn try_proxy_download(url: &str, proxy_port: u16) -> Result<String, String> {
    let proxy_url = format!("http://127.0.0.1:{proxy_port}");

    // No DNS pinning for proxy - let proxy handle DNS resolution
    let config = HttpClientConfig {
        proxy_url: Some(proxy_url),
        resolve_pin: None,
        ..Default::default()
    };
    let client = build_http_client(config)?;
    fetch_body(&client, url).await
}

/// Fetch body from a response with size limiting.
async fn fetch_body(client: &reqwest::Client, url: &str) -> Result<String, String> {
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Download failed: {e}"))?;

    if !response.status().is_success() {
        return Err(format!("Download returned {}", response.status()));
    }

    // Check Content-Length before reading body
    // Use unwrap_or(usize::MAX) so that on 32-bit systems where u64 > usize::MAX,
    // the check correctly triggers an error instead of passing.
    if let Some(len) = response.content_length() {
        if usize::try_from(len).unwrap_or(usize::MAX) > MAX_RESPONSE_SIZE {
            return Err(format!(
                "Response body exceeds maximum size of {MAX_RESPONSE_SIZE} bytes"
            ));
        }
    }

    // Stream read with size limit
    use futures_util::StreamExt as _;

    // Pre-allocate buffer if Content-Length is known
    let content_length = response.content_length();
    let initial_capacity = content_length
        .and_then(|l| usize::try_from(l).ok())
        .unwrap_or(0)
        .min(MAX_RESPONSE_SIZE);
    let mut bytes = Vec::with_capacity(initial_capacity);

    let mut stream = response.bytes_stream();

    while let Some(chunk_result) = stream.next().await {
        let chunk = chunk_result.map_err(|e| format!("Failed to read chunk: {e}"))?;
        if bytes.len() + chunk.len() > MAX_RESPONSE_SIZE {
            return Err(format!(
                "Response exceeded size limit of {MAX_RESPONSE_SIZE} bytes"
            ));
        }
        bytes.extend_from_slice(&chunk);
    }

    // Use lossy UTF-8 conversion for compatibility with malformed remote content
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// Fetch text content from a URL (simple wrapper for backward compatibility).
pub async fn fetch_text(url: String) -> Result<String, String> {
    fetch_url_content(&url, None).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_format_host_port() {
        assert_eq!(format_host_port("example.com", 443), "example.com:443");
        assert_eq!(format_host_port("::1", 80), "[::1]:80");
        assert_eq!(format_host_port("2001:db8::1", 443), "[2001:db8::1]:443");
    }

    #[test]
    fn test_validate_url_basic_rejects_invalid_schemes() {
        assert!(validate_url_basic("ftp://example.com/file").is_err());
        assert!(validate_url_basic("file:///etc/passwd").is_err());
        assert!(validate_url_basic("javascript:alert(1)").is_err());
    }

    #[test]
    fn test_validate_url_basic_extracts_port() {
        match validate_url_basic("http://example.com") {
            Ok((host, port, _)) => {
                assert_eq!(host, "example.com");
                assert_eq!(port, 80);
            }
            Err(_) => unreachable!("http://example.com should be valid"),
        }

        match validate_url_basic("https://example.com") {
            Ok((host, port, _)) => {
                assert_eq!(host, "example.com");
                assert_eq!(port, 443);
            }
            Err(_) => unreachable!("https://example.com should be valid"),
        }

        match validate_url_basic("http://example.com:8080") {
            Ok((host, port, _)) => {
                assert_eq!(host, "example.com");
                assert_eq!(port, 8080);
            }
            Err(_) => unreachable!("http://example.com:8080 should be valid"),
        }
    }

    // -- Snapshot tests for host:port formatting ---------------------------

    #[test]
    fn snapshot_format_host_port_ipv4() {
        insta::assert_snapshot!(format_host_port("192.0.2.1", 443));
    }

    #[test]
    fn snapshot_format_host_port_ipv6_loopback() {
        insta::assert_snapshot!(format_host_port("::1", 80));
    }

    #[test]
    fn snapshot_format_host_port_ipv6_full() {
        insta::assert_snapshot!(format_host_port("2001:db8::1", 443));
    }
}
