/**
 * Unified remote fetching utilities with SSRF protection.
 *
 * This module provides a single, consistent way to perform HTTP requests
 * with proper security measures (SSRF protection, DNS pinning, redirect validation).
 */
use std::time::Duration;

use super::MAX_RESPONSE_SIZE;

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

/// Check if a host is a private/local address.
fn is_private_host(host: &str) -> bool {
    // Check for localhost variations
    if host.eq_ignore_ascii_case("localhost")
        || host.eq_ignore_ascii_case("127.0.0.1")
        || host.starts_with("127.")
        || host == "::1"
        || host == "[::1]"
    {
        return true;
    }

    // Check for private IP ranges
    if let Ok(ip) = host.parse::<std::net::IpAddr>() {
        return is_private_ip(ip);
    }

    false
}

/// Check if an IP address is private.
fn is_private_ip(ip: std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(ipv4) => {
            let octets = ipv4.octets();
            // 10.0.0.0/8
            octets[0] == 10
            // 172.16.0.0/12
            || (octets[0] == 172 && octets[1] >= 16 && octets[1] <= 31)
            // 192.168.0.0/16
            || (octets[0] == 192 && octets[1] == 168)
            // 127.0.0.0/8 (loopback)
            || octets[0] == 127
            // 169.254.0.0/16 (link-local)
            || (octets[0] == 169 && octets[1] == 254)
            // 100.64.0.0/10 (carrier-grade NAT)
            || (octets[0] == 100 && octets[1] >= 64 && octets[1] <= 127)
        }
        std::net::IpAddr::V6(ipv6) => {
            let segments = ipv6.segments();
            // ::1 (loopback)
            segments == [0, 0, 0, 0, 0, 0, 0, 1]
            // fe80::/10 (link-local)
            || (segments[0] & 0xffc0) == 0xfe80
            // fc00::/7 (unique local)
            || (segments[0] & 0xfe00) == 0xfc00
        }
    }
}

/// Validate a URL for SSRF protection.
///
/// Returns:
/// - `Ok((host, resolved_addr, user_entered_private))` if valid
/// - `Err(String)` if invalid or SSRF detected
///
/// Security:
/// - Only allows http/https schemes
/// - Blocks public domains that resolve to private IPs (DNS rebinding)
/// - Allows user-entered private addresses (for local networks)
pub fn validate_url(url: &str) -> Result<(String, Option<std::net::SocketAddr>, bool), String> {
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

    // Check if user explicitly entered a private/local host
    let user_entered_private = is_private_host(&host);

    if user_entered_private {
        // User explicitly typed a private address
        // Allow it, but return None for resolved_addr (no DNS pinning)
        return Ok((host, None, true));
    }

    // Host is a public domain — resolve and verify all IPs are public
    let default_port = if scheme == "https" { 443 } else { 80 };
    let addrs: Vec<std::net::SocketAddr> =
        std::net::ToSocketAddrs::to_socket_addrs(&format!("{host}:{default_port}"))
            .map_err(|e| format!("Failed to resolve host: {e}"))?
            .collect();

    let mut resolved_addr = None;
    for addr in &addrs {
        if is_private_ip(addr.ip()) {
            // Public domain resolving to a private IP = SSRF, always block
            return Err("Access to private/local resolved addresses is not allowed".to_owned());
        }
        if resolved_addr.is_none() {
            resolved_addr = Some(*addr);
        }
    }

    if resolved_addr.is_none() {
        return Err("Could not resolve any IP address for the host".to_owned());
    }

    Ok((host, resolved_addr, false))
}

/// Build an HTTP client with security settings.
///
/// Features:
/// - Redirect validation (blocks redirects to private IPs)
/// - Timeout configuration
/// - Optional proxy support
/// - Optional DNS pinning (`resolve_pin`)
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
        match std::net::ToSocketAddrs::to_socket_addrs(&format!("{host}:{port}")) {
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

    let mut client_builder = reqwest::Client::builder()
        .timeout(Duration::from_secs(config.timeout_secs))
        .connect_timeout(Duration::from_secs(config.connect_timeout_secs))
        .redirect(redirect_policy);

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
/// # Arguments
/// * `url` - The URL to fetch
/// * `proxy_port` - Optional local proxy port (for proxied downloads)
///
/// # Returns
/// * `Ok(String)` - The fetched content as UTF-8 string
/// * `Err(String)` - Error message if fetch failed
pub async fn fetch_url_content(url: &str, proxy_port: Option<u16>) -> Result<String, String> {
    // Validate URL (SSRF protection + DNS resolution)
    let (host, resolved_addr, user_entered_private) = validate_url(url)?;

    // Configure DNS pinning for public addresses
    let resolve_pin = if user_entered_private {
        None
    } else {
        resolved_addr.map(|addr| (host, addr))
    };

    // Try proxied download first if proxy port is provided
    if let Some(port) = proxy_port.filter(|&p| p > 0) {
        let proxy_url = format!("http://127.0.0.1:{port}");
        let config = HttpClientConfig {
            proxy_url: Some(proxy_url),
            resolve_pin: resolve_pin.clone(),
            ..Default::default()
        };
        let client = build_http_client(config)?;

        match fetch_body(&client, url).await {
            Ok(content) => return Ok(content),
            Err(proxy_err) => {
                // Log proxy failure and fall back to direct download
                eprintln!(
                    "[fetch_url_content] Proxy download failed ({proxy_err}), retrying direct..."
                );
            }
        }
    }

    // Direct download (fallback or default)
    let config = HttpClientConfig {
        resolve_pin,
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
    if let Some(len) = response.content_length() {
        if usize::try_from(len).unwrap_or(0) > MAX_RESPONSE_SIZE {
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
    fn test_is_private_host() {
        assert!(is_private_host("localhost"));
        assert!(is_private_host("127.0.0.1"));
        assert!(is_private_host("192.168.1.1"));
        assert!(is_private_host("10.0.0.1"));
        assert!(!is_private_host("8.8.8.8"));
        assert!(!is_private_host("example.com"));
    }

    #[test]
    fn test_validate_url_rejects_invalid_schemes() {
        assert!(validate_url("ftp://example.com/file").is_err());
        assert!(validate_url("file:///etc/passwd").is_err());
        assert!(validate_url("javascript:alert(1)").is_err());
    }

    #[test]
    fn test_validate_url_accepts_http_https() {
        // Note: This will fail if example.com doesn't resolve, but that's fine for the test
        let result = validate_url("https://example.com/path");
        // We can't assert Ok() because DNS might fail in test environment
        // But we can assert it's not the scheme error
        if let Err(e) = result {
            assert!(!e.contains("Only HTTP and HTTPS"));
        }
    }
}
