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
use zephyr_core::config::subscription::{
    is_literal_private_host, is_mihomo_fake_ip, is_private_host, is_private_ip,
    is_single_label_host, validate_public_host_addrs, PublicHostAddrError,
};

/// Marker embedded in error messages when a request or redirect is blocked by SSRF protection.
pub const SSRF_BLOCK_MARKER: &str = "[SSRF_BLOCKED]";

/// Error type distinguishing security policy rejections (SSRF) from transient transport failures.
#[derive(Debug)]
pub enum DownloadError {
    Ssrf(String),
    LocalDnsSsrf(String),
    Transport(String),
}

impl std::fmt::Display for DownloadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Ssrf(msg) | Self::LocalDnsSsrf(msg) | Self::Transport(msg) => write!(f, "{msg}"),
        }
    }
}

impl std::error::Error for DownloadError {}

/// Check if an error message indicates an SSRF policy rejection.
#[must_use]
pub fn is_ssrf_error(err: &str) -> bool {
    err.contains(SSRF_BLOCK_MARKER)
        || err.contains("SSRF protection")
        || err.contains("Redirect to private")
}

/// Configuration for HTTP client building.
#[derive(Debug, Clone)]
pub struct HttpClientConfig {
    pub user_agent: Option<String>,
    pub timeout_secs: u64,
    pub connect_timeout_secs: u64,
    pub proxy_url: Option<String>,
    pub resolve_pin: Option<(String, std::net::SocketAddr)>,
    pub allowed_private_host: Option<String>,
}

impl Default for HttpClientConfig {
    fn default() -> Self {
        Self {
            user_agent: None,
            timeout_secs: 30,
            connect_timeout_secs: 30,
            proxy_url: None,
            resolve_pin: None,
            allowed_private_host: None,
        }
    }
}

/// Format a host:port string, handling IPv6 bracket notation.
fn format_host_port(host: &str, port: u16) -> String {
    let unbracketed = if host.starts_with('[') && host.ends_with(']') && host.len() >= 2 {
        &host[1..host.len() - 1]
    } else {
        host
    };
    if unbracketed.contains(':') {
        format!("[{unbracketed}]:{port}")
    } else {
        format!("{unbracketed}:{port}")
    }
}

/// 全局 DNS 信号量，限制并发阻塞式 DNS 解析任务最多为 32 个，防止并发刷新时占满 Tokio 阻塞线程池。
pub static DNS_SEMAPHORE: std::sync::LazyLock<std::sync::Arc<tokio::sync::Semaphore>> =
    std::sync::LazyLock::new(|| std::sync::Arc::new(tokio::sync::Semaphore::new(32)));

/// Resolve a redirect destination before a shared deadline and reject empty results.
pub(crate) async fn resolve_host_addrs_before_deadline(
    host: &str,
    port: u16,
    deadline: tokio::time::Instant,
) -> Result<Vec<std::net::SocketAddr>, String> {
    let permit = tokio::time::timeout_at(deadline, DNS_SEMAPHORE.clone().acquire_owned())
        .await
        .map_err(|_elapsed| format!("DNS deadline elapsed while resolving '{host}'"))?
        .map_err(|e| format!("DNS semaphore acquisition failed: {e}"))?;

    let host_port = format_host_port(host, port);
    let (tx, rx) = tokio::sync::oneshot::channel();
    let handle = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let result = std::net::ToSocketAddrs::to_socket_addrs(&host_port)
            .map(std::iter::Iterator::collect::<Vec<_>>);
        let _ = tx.send(result);
    });
    drop(handle);

    let res = tokio::time::timeout_at(deadline, rx).await;

    let addrs = res
        .map_err(|_timeout| format!("DNS resolution timed out for '{host}'"))?
        .map_err(|_join_err| format!("DNS resolution task ended unexpectedly for '{host}'"))?
        .map_err(|e| format!("DNS resolution failed for '{host}': {e}"))?;
    if addrs.is_empty() {
        return Err(format!("DNS resolution returned no addresses for '{host}'"));
    }
    Ok(addrs)
}

type DnsBoxError = Box<dyn std::error::Error + Send + Sync>;

/// Safe DNS resolver that rejects private addresses at connection time.
#[derive(Clone, Default, Debug)]
pub struct SafeDnsResolver {
    /// Host explicitly entered by user as private/LAN destination.
    pub allowed_private_host: Option<String>,
}

impl reqwest::dns::Resolve for SafeDnsResolver {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        let allowed = self.allowed_private_host.clone();
        Box::pin(async move {
            let raw_host = name.as_str().trim_end_matches('.');
            let host = raw_host.to_owned();
            let is_allowed = allowed
                .as_deref()
                .is_some_and(|a| a.trim_end_matches('.').eq_ignore_ascii_case(&host));

            if let Ok(ip) = host.parse::<std::net::IpAddr>() {
                if !is_allowed && is_mihomo_fake_ip(ip) {
                    return Err(Box::new(std::io::Error::other(format!(
                        "DNS resolved to synthetic fake-IP for '{host}'; destination cannot be verified for direct connection"
                    ))) as DnsBoxError);
                }
                if !is_allowed && is_private_ip(ip) {
                    return Err(Box::new(std::io::Error::new(
                        std::io::ErrorKind::PermissionDenied,
                        format!("{SSRF_BLOCK_MARKER} Connection to private IP blocked: {ip}"),
                    )) as DnsBoxError);
                }
                let addr = std::net::SocketAddr::new(ip, 0);
                let addrs: Box<dyn Iterator<Item = std::net::SocketAddr> + Send> =
                    Box::new(std::iter::once(addr));
                return Ok(addrs);
            }

            if !is_allowed
                && (is_single_label_host(&host)
                    || (is_private_host(&host) && is_literal_private_host(&host)))
            {
                return Err(Box::new(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    format!("{SSRF_BLOCK_MARKER} Connection to private host blocked: {host}"),
                )) as DnsBoxError);
            }

            let permit = match tokio::time::timeout(
                Duration::from_secs(5),
                DNS_SEMAPHORE.clone().acquire_owned(),
            )
            .await
            {
                Ok(Ok(p)) => p,
                Ok(Err(e)) => {
                    return Err(Box::new(std::io::Error::other(format!(
                        "DNS semaphore acquisition error: {e}"
                    ))) as DnsBoxError);
                }
                Err(_) => {
                    return Err(Box::new(std::io::Error::new(
                        std::io::ErrorKind::TimedOut,
                        format!("DNS semaphore acquisition timed out for '{host}'"),
                    )) as DnsBoxError);
                }
            };

            let host_port = format_host_port(&host, 0);
            let (tx, rx) = tokio::sync::oneshot::channel();
            let handle = tokio::task::spawn_blocking(move || {
                let _permit = permit;
                let res = std::net::ToSocketAddrs::to_socket_addrs(&host_port)
                    .map(std::iter::Iterator::collect::<Vec<_>>);
                let _ = tx.send(res);
            });
            drop(handle);

            let res = tokio::time::timeout(Duration::from_secs(5), rx).await;

            let addrs = match res {
                Ok(Ok(Ok(addrs))) => addrs,
                Ok(Ok(Err(e))) => {
                    return Err(Box::new(e) as DnsBoxError);
                }
                Ok(Err(_)) => {
                    return Err(Box::new(std::io::Error::new(
                        std::io::ErrorKind::TimedOut,
                        format!("DNS resolution task cancelled for '{host}'"),
                    )) as DnsBoxError);
                }
                Err(_) => {
                    return Err(Box::new(std::io::Error::new(
                        std::io::ErrorKind::TimedOut,
                        format!("DNS resolution timed out for '{host}'"),
                    )) as DnsBoxError);
                }
            };

            let mut resolved_addrs = Vec::new();
            for addr in addrs {
                if !is_allowed && is_mihomo_fake_ip(addr.ip()) {
                    return Err(Box::new(std::io::Error::other(format!(
                        "DNS resolved to synthetic fake-IP for '{host}'; destination cannot be verified for direct connection"
                    ))) as DnsBoxError);
                }
                if !is_allowed && is_private_ip(addr.ip()) {
                    return Err(Box::new(std::io::Error::new(
                        std::io::ErrorKind::PermissionDenied,
                        format!(
                            "{SSRF_BLOCK_MARKER} DNS resolved to private IP: {} -> {}",
                            host,
                            addr.ip()
                        ),
                    )) as DnsBoxError);
                }
                resolved_addrs.push(addr);
            }

            if resolved_addrs.is_empty() {
                return Err(Box::new(std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    format!("No IP addresses found for {host}"),
                )) as DnsBoxError);
            }

            let iter: Box<dyn Iterator<Item = std::net::SocketAddr> + Send> =
                Box::new(resolved_addrs.into_iter());
            Ok(iter)
        })
    }
}

/// Custom redirect policy shared between direct and proxied HTTP client builders.
///
/// Strictly enforces SSRF protections on each redirect hop.
pub(crate) fn safe_redirect_policy() -> reqwest::redirect::Policy {
    reqwest::redirect::Policy::custom(move |attempt| {
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

        if is_private_host(&host) || is_single_label_host(&host) {
            return attempt.error(format!(
                "{SSRF_BLOCK_MARKER} Redirect to private host blocked: {host}"
            ));
        }

        let clean_host = host.trim_matches(['[', ']'].as_slice());
        if let Ok(ip) = clean_host.parse::<std::net::IpAddr>() {
            if is_mihomo_fake_ip(ip) {
                return attempt.error(format!(
                    "{SSRF_BLOCK_MARKER} Redirect to fake IP blocked: {host}"
                ));
            }
            if is_private_ip(ip) {
                return attempt.error(format!(
                    "{SSRF_BLOCK_MARKER} Redirect to private IP blocked: {host}"
                ));
            }
        }

        attempt.follow()
    })
}

/// Build a configured reqwest HTTP client with:
/// - Custom redirect policy (max 5 hops, SSRF protection against private IPs)
/// - Strict timeouts
/// - Custom DNS resolver (`SafeDnsResolver`) for direct connections
/// - Optional DNS pinning (`resolve_pin`)
/// - `.no_proxy()` by default to prevent system proxy leaks
pub fn build_http_client(config: HttpClientConfig) -> Result<reqwest::Client, String> {
    // .no_proxy() by default to prevent system proxy leaks (SSRF attack surface reduction).
    // A proxy is only added if explicitly configured via config.proxy_url.
    let mut client_builder = reqwest::Client::builder()
        .timeout(Duration::from_secs(config.timeout_secs))
        .connect_timeout(Duration::from_secs(config.connect_timeout_secs))
        .redirect(safe_redirect_policy())
        .no_proxy();

    // Register safe connection-time DNS resolver for direct clients only
    if config.proxy_url.is_none() {
        client_builder = client_builder.dns_resolver(std::sync::Arc::new(SafeDnsResolver {
            allowed_private_host: config.allowed_private_host.clone(),
        }));
    } else {
        // Disable automatic redirects on proxied clients to enforce hop-by-hop destination validation
        client_builder = client_builder.redirect(reqwest::redirect::Policy::none());
    }

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

/// Helper to extract configured proxy endpoint from running core config.
pub(crate) fn managed_proxy_endpoint(app: &tauri::AppHandle) -> Option<(u16, &'static str)> {
    if super::subscription::is_core_running(app) {
        super::resolve_app_paths(app).ok().and_then(|paths| {
            let run_config_path = paths.core_dir.join("run_config.yaml");
            let content = std::fs::read_to_string(&run_config_path).ok()?;
            super::core_process::extract_configured_proxy_endpoint(&content)
        })
    } else {
        None
    }
}

/// Verdict from proxy DNS pre-flight verification.
#[derive(Debug)]
pub(crate) enum ProxyDnsVerdict {
    /// Destination resolved to private or synthetic address.
    Private(String),
    /// Destination could not be verified as public via DNS.
    Unverified,
    /// Destination was confirmed as a public IP.
    Public,
}

/// Concurrently check local DNS and proxy (Mihomo) DNS to classify destination eligibility.
pub(crate) async fn check_proxy_dns_destination(
    app: Option<&tauri::AppHandle>,
    host: &str,
    port: u16,
    deadline: tokio::time::Instant,
) -> Result<ProxyDnsVerdict, String> {
    let rem = deadline.saturating_duration_since(tokio::time::Instant::now());
    if rem.is_zero() {
        return Err("Request deadline exceeded".to_owned());
    }

    let local_budget = Duration::from_millis(1000).min(rem);
    let local_dns_future =
        resolve_host_addrs_before_deadline(host, port, tokio::time::Instant::now() + local_budget);

    let proxy_budget = Duration::from_millis(1500).min(rem);
    let proxy_dns_future = async {
        if let Some(app_handle) = app {
            super::subscription::check_mihomo_dns_is_private(app_handle, host, proxy_budget).await
        } else {
            None
        }
    };

    let (local_dns_res, mihomo_dns) = tokio::join!(local_dns_future, proxy_dns_future);

    if mihomo_dns == Some(true) {
        return Ok(ProxyDnsVerdict::Private(
            "resolved to private IP via proxy DNS".to_owned(),
        ));
    }

    if mihomo_dns != Some(false) {
        if let Ok(local_addrs) = &local_dns_res {
            if let Err(zephyr_core::config::PublicHostAddrError::SsrfBlocked(e)) =
                zephyr_core::config::subscription::validate_public_host_addrs(host, local_addrs)
            {
                return Ok(ProxyDnsVerdict::Private(format!(
                    "resolved to private IP: {e}"
                )));
            }
        }
    }

    let host_verified_public = mihomo_dns == Some(false);

    if host_verified_public {
        Ok(ProxyDnsVerdict::Public)
    } else {
        Ok(ProxyDnsVerdict::Unverified)
    }
}

/// Verify that a candidate host for proxy fallback resolves to a verified public destination.
///
/// Returns `Ok(())` on positive public confirmation, or [`DownloadError`] on rejection or failure.
pub(crate) async fn verify_proxy_destination(
    app: Option<&tauri::AppHandle>,
    host: &str,
    port: u16,
    deadline: tokio::time::Instant,
) -> Result<(), DownloadError> {
    let clean_host = host.trim_matches(['[', ']'].as_slice());
    if let Ok(ip) = clean_host.parse::<std::net::IpAddr>() {
        if is_mihomo_fake_ip(ip) || is_private_ip(ip) {
            return Err(DownloadError::Ssrf(format!(
                "{SSRF_BLOCK_MARKER} '{host}' is a private or synthetic IP address"
            )));
        }
        return Ok(());
    }

    match check_proxy_dns_destination(app, host, port, deadline).await {
        Ok(ProxyDnsVerdict::Public) => Ok(()),
        Ok(ProxyDnsVerdict::Private(detail)) => Err(DownloadError::Ssrf(format!(
            "SSRF protection: Domain '{host}' {detail}"
        ))),
        Ok(ProxyDnsVerdict::Unverified) => Err(DownloadError::Transport(format!(
            "destination '{host}' could not be verified as public via DNS"
        ))),
        Err(e) => Err(DownloadError::Transport(e)),
    }
}

/// Fetch content from a URL via HTTP(S) with proxy fallback support.
///
/// Tries direct connection first; if that fails and a proxy is available,
/// retries through the proxy.
///
/// # Arguments
/// * `url` - The URL to fetch
/// * `proxy_port` - Optional proxy port (from settings)
/// * `app` - Optional `AppHandle` to look up runtime core proxy port and check core status
///
/// # Returns
/// * `Ok(String)` - The response body as a string
/// * `Err(String)` - Error message if fetch failed
pub async fn fetch_url_content(
    url: &str,
    proxy_port: Option<u16>,
    app: Option<&tauri::AppHandle>,
) -> Result<String, String> {
    let trimmed_url = url.trim();
    // Basic URL validation (scheme, host format) without DNS resolution
    // DNS resolution is deferred to allow proxy to handle it
    let (host, port, _user_entered_private) = validate_url_basic(trimmed_url)?;
    let trusted_private_literal = is_literal_private_host(&host);
    let user_entered_private = is_private_host(&host);

    let overall_deadline = tokio::time::Instant::now() + Duration::from_secs(30);

    let is_single_label = zephyr_core::config::is_single_label_host(&host);
    let core_running = app.is_some_and(super::subscription::is_core_running);
    let proxy_possible = !user_entered_private
        && !is_single_label
        && (proxy_port.is_some_and(|p| p > 0 && core_running)
            || app.and_then(managed_proxy_endpoint).is_some());

    let (direct_deadline, direct_conn_timeout_secs) = if proxy_possible {
        // Reserve ample budget for proxy tier. Fast-fail direct connection on blocked domains
        // with 3s connect timeout and 10s request window.
        let direct_budget = Duration::from_secs(10);
        let deadline = (tokio::time::Instant::now() + direct_budget).min(overall_deadline);
        (deadline, 3)
    } else {
        let remaining = overall_deadline.saturating_duration_since(tokio::time::Instant::now());
        let secs = remaining.as_secs().max(1);
        (overall_deadline, secs)
    };

    // Try direct connection first (with DNS pinning for public and private-suffix hostnames).
    let direct_result = try_direct_download(
        trimmed_url,
        &host,
        port,
        trusted_private_literal,
        user_entered_private,
        direct_deadline,
        direct_conn_timeout_secs,
    )
    .await;

    match direct_result {
        Ok(content) => Ok(content),
        Err(DownloadError::Ssrf(direct_err)) => {
            crate::emit_warn!(
                Subscription,
                SUB_DIRECT_DOWNLOAD_FAILED,
                "Direct download failed (SSRF blocked): {direct_err}"
            );

            // Connect-time or redirect SSRF rejection is a security policy decision,
            // not a transient transport failure or sinkhole. Reject immediately instead of retrying through proxy.
            Err(direct_err)
        }
        Err(DownloadError::LocalDnsSsrf(direct_err))
        | Err(DownloadError::Transport(direct_err)) => {
            crate::emit_warn!(
                Subscription,
                SUB_DIRECT_DOWNLOAD_FAILED,
                "Direct download failed: {direct_err}"
            );

            // Exclude single-label non-IP hostnames from proxy fallback (matches subscription downloader)
            let is_single_label = zephyr_core::config::is_single_label_host(&host);

            // Private-suffix names and single-label hosts remain direct-only.
            if !user_entered_private && !is_single_label {
                let remaining =
                    overall_deadline.saturating_duration_since(tokio::time::Instant::now());
                if remaining < Duration::from_millis(500) {
                    return Err(format!(
                        "Direct: {direct_err}; Proxy: skipped due to deadline exhaustion"
                    ));
                }

                let core_running = app.is_some_and(super::subscription::is_core_running);
                let effective_proxy_endpoint = proxy_port
                    .filter(|&p| p > 0 && core_running)
                    .map(|p| (p, "http"))
                    .or_else(|| app.and_then(managed_proxy_endpoint));
                if let Some((proxy_port_num, scheme)) = effective_proxy_endpoint {
                    if let Err(e) =
                        verify_proxy_destination(app, &host, port, overall_deadline).await
                    {
                        return match e {
                            DownloadError::Ssrf(msg) | DownloadError::LocalDnsSsrf(msg) => Err(msg),
                            DownloadError::Transport(msg) => {
                                Err(format!("Direct: {direct_err}; Proxy: skipped, {msg}"))
                            }
                        };
                    }

                    // Note on proxy-tier DNS rebinding residual risk:
                    // Direct connections pin the validated IP address to eliminate DNS rebinding.
                    // For proxied requests through Mihomo's mixed port, standard HTTP proxy semantics
                    // delegate resolution to the proxy core to preserve remote DNS routing and virtual
                    // hosting. Pre-connection check via Mihomo's /dns/query API validates that the
                    // domain does not resolve to private/local addresses before the request is issued.
                    // The residual risk of a fast-flux DNS rebinding race between pre-check and Mihomo's
                    // internal connection is an accepted design trade-off for proxy compatibility.
                    crate::emit_info!(
                        Subscription,
                        SUB_PROXY_RETRY,
                        "Retrying with proxy on port {proxy_port_num} ({scheme})..."
                    );
                    match try_proxy_download(
                        trimmed_url,
                        proxy_port_num,
                        scheme,
                        app,
                        overall_deadline,
                    )
                    .await
                    {
                        Ok(content) => Ok(content),
                        Err(proxy_err) => Err(format!("Direct: {direct_err}; Proxy: {proxy_err}")),
                    }
                } else {
                    Err(direct_err)
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
    zephyr_core::config::subscription::validate_subscription_url_basic(url)
}

/// Try direct download with DNS pinning for public and private-suffix hostnames.
async fn try_direct_download(
    url: &str,
    host: &str,
    port: u16,
    trusted_private_literal: bool,
    user_entered_private: bool,
    deadline: tokio::time::Instant,
    conn_timeout_secs: u64,
) -> Result<String, DownloadError> {
    let private_suffix_host = user_entered_private && !trusted_private_literal;
    let resolve_pin = if trusted_private_literal {
        None
    } else if private_suffix_host {
        let addrs = resolve_host_addrs_before_deadline(host, port, deadline)
            .await
            .map_err(DownloadError::Transport)?;
        let valid_addr = addrs
            .into_iter()
            .find(|addr| !is_mihomo_fake_ip(addr.ip()))
            .ok_or_else(|| {
                DownloadError::Transport(format!(
                    "Private host '{host}' resolved only to synthetic fake-IP addresses"
                ))
            })?;
        Some((host.to_owned(), valid_addr))
    } else {
        let addr = resolve_and_pin(host, port, deadline).await?;
        Some((host.to_owned(), addr))
    };

    let allowed_private_host = user_entered_private.then(|| host.to_owned());

    let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
    let timeout_secs = remaining.as_secs().max(1);

    let config = HttpClientConfig {
        resolve_pin,
        allowed_private_host,
        timeout_secs,
        connect_timeout_secs: conn_timeout_secs.min(timeout_secs),
        ..Default::default()
    };
    let client = build_http_client(config).map_err(DownloadError::Transport)?;
    fetch_body(&client, url, deadline, false, None).await
}

/// Resolve host and return first valid public address for DNS pinning.
///
/// The port is included in resolution to ensure the returned `SocketAddr`
/// matches the request port (e.g., 443 for HTTPS).
///
/// Security: If ANY resolved address is private, the request is blocked.
/// This prevents DNS rebinding attacks where a public domain resolves to
/// both public and private IPs.
async fn resolve_and_pin(
    host: &str,
    port: u16,
    deadline: tokio::time::Instant,
) -> Result<std::net::SocketAddr, DownloadError> {
    let addrs = resolve_host_addrs_before_deadline(host, port, deadline)
        .await
        .map_err(DownloadError::Transport)?;

    match validate_public_host_addrs(host, &addrs) {
        Ok((_, Some(addr), _)) => Ok(addr),
        Ok((_, None, _)) => Err(DownloadError::Transport(
            "Could not resolve any IP address for the host".to_owned(),
        )),
        Err(PublicHostAddrError::SsrfBlocked(msg)) => Err(DownloadError::LocalDnsSsrf(format!(
            "{SSRF_BLOCK_MARKER} {msg}"
        ))),
        Err(PublicHostAddrError::NoAddresses(msg)) => Err(DownloadError::Transport(msg)),
        Err(e) => Err(DownloadError::Transport(e.to_string())),
    }
}

/// Try proxy download without DNS pinning.
///
/// SSRF protection for proxy path:
/// - Initial URL host validated (private host check)
/// - Redirect policy blocks redirects to private hosts/IPs
/// - Proxy-side SSRF is NOT preventable client-side — inherent to proxy architecture
async fn try_proxy_download(
    url: &str,
    proxy_port: u16,
    proxy_scheme: &str,
    app: Option<&tauri::AppHandle>,
    deadline: tokio::time::Instant,
) -> Result<String, String> {
    let proxy_url = format!("{proxy_scheme}://127.0.0.1:{proxy_port}");
    let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
    if remaining.is_zero() {
        return Err("Download deadline exceeded before proxy attempt".to_owned());
    }
    let timeout_secs = remaining.as_secs().max(1);

    // No DNS pinning for proxy - let proxy handle DNS resolution
    let config = HttpClientConfig {
        proxy_url: Some(proxy_url),
        resolve_pin: None,
        timeout_secs,
        connect_timeout_secs: timeout_secs,
        ..Default::default()
    };
    let client = build_http_client(config)?;
    fetch_body(&client, url, deadline, true, app)
        .await
        .map_err(|e| e.to_string())
}

/// Format an error and its source chain into a combined string.
pub(crate) fn format_error_chain(e: &(dyn std::error::Error + 'static)) -> String {
    let mut messages = Vec::new();
    let mut current = Some(e);
    while let Some(error) = current {
        let msg = error.to_string();
        if !messages.contains(&msg) {
            messages.push(msg);
        }
        current = error.source();
    }
    messages.join(": ")
}

#[derive(Debug)]
pub(crate) enum RedirectHopError {
    Ssrf(String),
    Transport(String),
}

/// Validates a single redirect hop for scheme, destination IP safety, and DNS verification.
/// Concurrently checks local DNS and proxy DNS on proxied hops to avoid stalls.
pub(crate) async fn validate_redirect_hop(
    current_url: &str,
    location_header: &str,
    is_proxied: bool,
    app: Option<&tauri::AppHandle>,
    deadline: tokio::time::Instant,
) -> Result<reqwest::Url, RedirectHopError> {
    let parsed_base =
        reqwest::Url::parse(current_url).map_err(|e| RedirectHopError::Transport(e.to_string()))?;
    let next_url = parsed_base
        .join(location_header)
        .map_err(|e| RedirectHopError::Transport(e.to_string()))?;

    if next_url.scheme() != "http" && next_url.scheme() != "https" {
        return Err(RedirectHopError::Ssrf(format!(
            "{SSRF_BLOCK_MARKER} Invalid redirect scheme: {}",
            next_url.scheme()
        )));
    }

    let next_host = next_url.host_str().ok_or_else(|| {
        RedirectHopError::Ssrf(format!("{SSRF_BLOCK_MARKER} Redirect URL has no host"))
    })?;

    if is_private_host(next_host) || is_single_label_host(next_host) {
        return Err(RedirectHopError::Ssrf(format!(
            "{SSRF_BLOCK_MARKER} Redirect to private host blocked: {next_host}"
        )));
    }

    let clean_next_host = next_host.trim_matches(['[', ']'].as_slice());
    if let Ok(ip) = clean_next_host.parse::<std::net::IpAddr>() {
        if is_private_ip(ip) || is_mihomo_fake_ip(ip) {
            return Err(RedirectHopError::Ssrf(format!(
                "{SSRF_BLOCK_MARKER} Redirect to private IP blocked: {next_host}"
            )));
        }
        return Ok(next_url);
    }

    let port = next_url.port_or_known_default().unwrap_or(80);

    if is_proxied {
        match check_proxy_dns_destination(app, next_host, port, deadline).await {
            Ok(ProxyDnsVerdict::Public) => {}
            Ok(ProxyDnsVerdict::Private(detail)) => {
                return Err(RedirectHopError::Ssrf(format!(
                    "{SSRF_BLOCK_MARKER} Redirect destination '{next_host}' {detail}"
                )));
            }
            Ok(ProxyDnsVerdict::Unverified) => {
                return Err(RedirectHopError::Transport(format!(
                    "Redirect destination could not be verified as public via DNS: {next_host}"
                )));
            }
            Err(e) => return Err(RedirectHopError::Transport(e)),
        }
    } else {
        let addrs = resolve_host_addrs_before_deadline(next_host, port, deadline)
            .await
            .map_err(|e| {
                RedirectHopError::Transport(format!(
                    "Redirect destination could not be validated via DNS: {e}"
                ))
            })?;
        match validate_public_host_addrs(next_host, &addrs) {
            Ok(_) => {}
            Err(PublicHostAddrError::SsrfBlocked(e)) => {
                return Err(RedirectHopError::Ssrf(format!(
                    "{SSRF_BLOCK_MARKER} Redirect destination resolved to private IP: {e}"
                )));
            }
            Err(e) => return Err(RedirectHopError::Transport(e.to_string())),
        }
    }

    Ok(next_url)
}

/// Fetch body from a response with size limiting.
async fn fetch_body(
    client: &reqwest::Client,
    url: &str,
    deadline: tokio::time::Instant,
    is_proxied: bool,
    app: Option<&tauri::AppHandle>,
) -> Result<String, DownloadError> {
    let mut current_url = url.to_owned();
    let mut redirect_count = 0;
    let response = loop {
        let request = client.get(&current_url).send();
        let resp = tokio::time::timeout_at(deadline, request)
            .await
            .map_err(|_elapsed| DownloadError::Transport("Request deadline exceeded".to_owned()))?
            .map_err(|e| {
                let chain = format_error_chain(&e);
                let msg = format!("Download failed: {chain}");
                if is_ssrf_error(&chain) {
                    DownloadError::Ssrf(msg)
                } else {
                    DownloadError::Transport(msg)
                }
            })?;

        if resp.status().is_redirection() {
            if redirect_count >= 5 {
                return Err(DownloadError::Transport(
                    "Too many redirects (max 5)".to_owned(),
                ));
            }
            redirect_count += 1;
            let loc = resp
                .headers()
                .get(reqwest::header::LOCATION)
                .ok_or_else(|| {
                    DownloadError::Transport("Redirect missing Location header".to_owned())
                })?
                .to_str()
                .map_err(|_err| {
                    DownloadError::Transport("Invalid Location header encoding".to_owned())
                })?;
            let next_url = validate_redirect_hop(&current_url, loc, is_proxied, app, deadline)
                .await
                .map_err(|e| match e {
                    RedirectHopError::Ssrf(msg) => DownloadError::Ssrf(msg),
                    RedirectHopError::Transport(msg) => DownloadError::Transport(msg),
                })?;
            current_url = next_url.to_string();
            continue;
        }

        break resp;
    };

    if !response.status().is_success() {
        return Err(DownloadError::Transport(format!(
            "Download returned {}",
            response.status()
        )));
    }

    // Check Content-Length before reading body
    // Use unwrap_or(usize::MAX) so that on 32-bit systems where u64 > usize::MAX,
    // the check correctly triggers an error instead of passing.
    if let Some(len) = response.content_length() {
        if usize::try_from(len).unwrap_or(usize::MAX) > MAX_RESPONSE_SIZE {
            return Err(DownloadError::Transport(format!(
                "Response body exceeds maximum size of {MAX_RESPONSE_SIZE} bytes"
            )));
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

    while let Some(chunk_result) = tokio::time::timeout_at(deadline, stream.next())
        .await
        .map_err(|_elapsed| {
            DownloadError::Transport("Download deadline exceeded during body read".to_owned())
        })?
    {
        let chunk = chunk_result
            .map_err(|e| DownloadError::Transport(format!("Failed to read chunk: {e}")))?;
        if bytes.len() + chunk.len() > MAX_RESPONSE_SIZE {
            return Err(DownloadError::Transport(format!(
                "Response exceeded size limit of {MAX_RESPONSE_SIZE} bytes"
            )));
        }
        bytes.extend_from_slice(&chunk);
    }

    // Use lossy UTF-8 conversion for compatibility with malformed remote content
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// Fetch text content from a URL (simple wrapper for backward compatibility).
pub async fn fetch_text(url: String) -> Result<String, String> {
    fetch_url_content(&url, None, None).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_format_host_port() {
        assert_eq!(format_host_port("example.com", 443), "example.com:443");
        assert_eq!(format_host_port("::1", 80), "[::1]:80");
        assert_eq!(format_host_port("[::1]", 80), "[::1]:80");
        assert_eq!(format_host_port("2001:db8::1", 443), "[2001:db8::1]:443");
        assert_eq!(format_host_port("[2001:db8::1]", 443), "[2001:db8::1]:443");
    }

    #[test]
    fn test_validate_url_basic_rejects_invalid_schemes() {
        assert!(validate_url_basic("ftp://example.com/file").is_err());
        assert!(validate_url_basic("file:///etc/passwd").is_err());
        assert!(validate_url_basic("javascript:alert(1)").is_err());
    }

    #[test]
    fn test_private_suffix_is_not_trusted_as_private_literal() {
        assert!(!is_literal_private_host("nas.local"));
        assert!(!is_literal_private_host("service.internal"));
        assert!(is_private_host("nas.local"));
        assert!(is_private_host("service.internal"));
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

    #[test]
    fn test_is_ssrf_error_detection() {
        assert!(is_ssrf_error(
            "[SSRF_BLOCKED] Redirect to private host blocked: 127.0.0.1"
        ));
        assert!(is_ssrf_error(
            "SSRF protection: host 'attacker.com' resolved to private IP"
        ));
        assert!(is_ssrf_error("Redirect to private host blocked: localhost"));
        assert!(!is_ssrf_error("connection refused"));
        assert!(!is_ssrf_error("timed out"));
    }

    #[test]
    fn test_download_error_display() {
        let err = DownloadError::Ssrf("blocked".to_owned());
        assert_eq!(err.to_string(), "blocked");
        let err = DownloadError::LocalDnsSsrf("dns sinkholed".to_owned());
        assert_eq!(err.to_string(), "dns sinkholed");
        let err = DownloadError::Transport("connection reset".to_owned());
        assert_eq!(err.to_string(), "connection reset");
    }
}
