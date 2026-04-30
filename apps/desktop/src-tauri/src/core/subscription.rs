use base64::{engine::general_purpose::STANDARD as base64_standard, Engine as _};
use std::net::IpAddr;
use std::time::Duration;
use tauri::{AppHandle, Manager as _, State};

use super::config_sanitizer::remove_dangerous_keys;
use super::core_process::ensure_app_storage;
use super::crypto::{load_metadata, save_metadata};
use super::secure_io::write_file_secure;
use super::{MihomoState, MAX_RESPONSE_SIZE};

// ── Pure functions for subscription content sanitization ─────────────────

/// Extract a name from the rules' policy-group field.
/// Scans up to 10 rules, returns the first non-generic policy-group name.
/// Example: `DOMAIN-SUFFIX,abpchina.org,VPN07` → `Some("VPN07")`
/// Returns `None` if rules are empty, unparseable, or all names are generic.
fn extract_name_from_rules(content: &str) -> Option<String> {
    let yaml: serde_yaml::Value = serde_yaml::from_str(content).ok()?;

    let rules_seq = yaml.get("rules").and_then(|r| r.as_sequence())?;

    if rules_seq.is_empty() {
        return None;
    }

    let max_scan = 10.min(rules_seq.len());
    for rule_val in rules_seq.iter().take(max_scan) {
        let rule_str = match rule_val.as_str() {
            Some(s) => s,
            None => continue, // Skip non-string rules (e.g. mappings)
        };

        // Split by comma, take the 3rd field (policy-group name)
        // Format: TYPE,MATCH,policy-group[,options...]
        let name = match rule_str.split(',').nth(2) {
            Some(n) => n.trim(),
            None => continue,
        };

        // Skip generic / built-in names (case-insensitive)
        let upper = name.to_uppercase();
        if upper.is_empty()
            || upper == "DIRECT"
            || upper == "REJECT"
            || upper == "MATCH"
            || upper == "PROXY"
            || upper == "PASS"
            || upper == "DROP"
        {
            continue;
        }

        // Sanity: reasonable length and safe filename characters
        // Allow letters (including CJK), digits, hyphens, underscores, spaces
        if name.len() > 64 {
            continue;
        }
        let is_safe = name
            .chars()
            .all(|c| c.is_alphanumeric() || c == '-' || c == '_' || c.is_ascii_whitespace());
        if !is_safe {
            continue;
        }

        return Some(name.to_owned());
    }

    None
}

/// Parse filename from a Content-Disposition header value.
/// Supports both `filename="name"` and `filename*=UTF-8''encoded_name` (RFC 5987).
fn parse_content_disposition_filename(header_value: &str) -> Option<String> {
    // Try filename*= first (RFC 5987, takes precedence)
    for raw_part in header_value.split(';') {
        let part = raw_part.trim();
        if let Some(raw_encoded) = part.strip_prefix("filename*=") {
            let encoded = raw_encoded.trim_matches('"');
            // Format: charset''percent-encoded-name
            if let Some(name) = encoded.split("''").last() {
                let decoded = percent_decode(name);
                let trimmed = decoded.trim();
                if !trimmed.is_empty() {
                    return Some(trimmed.to_owned());
                }
            }
        }
    }
    // Fallback to filename=
    for raw_part in header_value.split(';') {
        let part = raw_part.trim();
        if let Some(filename) = part.strip_prefix("filename=") {
            let trimmed = filename.trim_matches('"').trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_owned());
            }
        }
    }
    None
}

/// Decode percent-encoded string (e.g. "%E4%B8%AD%E6%96%87" → "中文").
fn percent_decode(input: &str) -> String {
    let mut result = Vec::with_capacity(input.len());
    let bytes = input.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes.get(i) == Some(&b'%') && i + 2 < bytes.len() {
            if let Some(hex) = bytes.get(i + 1..i + 3) {
                if let Ok(byte) = u8::from_str_radix(&String::from_utf8_lossy(hex), 16) {
                    result.push(byte);
                    i += 3;
                    continue;
                }
            }
        }
        if let Some(&b) = bytes.get(i) {
            result.push(b);
        }
        i += 1;
    }
    String::from_utf8(result).unwrap_or_else(|_| input.to_owned())
}

/// Attempt to base64-decode content that does not already contain Clash markers.
/// Returns `Some(decoded)` only if the decoded bytes are valid UTF-8, valid YAML,
/// and contain a `proxies:` key.
fn try_decode_base64_content(content: &str) -> Option<String> {
    let trimmed = content.replace(&['\r', '\n', ' ', '\t'][..], "");
    let decoded_bytes = base64_standard.decode(&trimmed).ok()?;
    let decoded_str = String::from_utf8(decoded_bytes).ok()?;
    (serde_yaml::from_str::<serde_yaml::Value>(&decoded_str).is_ok()
        && decoded_str.contains("proxies:"))
    .then_some(decoded_str)
}

/// Validate and sanitize a subscription name to prevent path traversal and injection attacks.
fn validate_subscription_name(name: &str) -> Result<String, String> {
    if name.is_empty() {
        return Err("Subscription name cannot be empty".to_owned());
    }
    super::config_sanitizer::sanitize_base_filename(name)
}

pub(crate) fn build_http_client(
    user_agent: Option<&str>,
    resolve_pin: Option<(String, std::net::SocketAddr)>,
) -> Result<reqwest::Client, String> {
    build_http_client_with_proxy(user_agent, resolve_pin, None)
}

fn build_http_client_with_proxy(
    user_agent: Option<&str>,
    resolve_pin: Option<(String, std::net::SocketAddr)>,
    proxy_url: Option<String>,
) -> Result<reqwest::Client, String> {
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
        .timeout(Duration::from_secs(30))
        .connect_timeout(Duration::from_secs(30))
        .redirect(redirect_policy)
        .no_proxy();

    if let Some(proxy_url_inner) = proxy_url {
        let proxy = reqwest::Proxy::all(proxy_url_inner)
            .map_err(|e| format!("Failed to create proxy: {e}"))?;
        client_builder = client_builder.proxy(proxy);
    }

    if let Some((host, addr)) = resolve_pin {
        client_builder = client_builder.resolve(&host, addr);
    }

    // Determine User-Agent: use provided UA, or default to Zephyr
    let ua_to_use = match user_agent {
        Some(ua) if !ua.trim().is_empty() => ua.trim().to_owned(),
        _ => {
            // Default Zephyr User-Agent with version
            let version = env!("CARGO_PKG_VERSION");
            format!("Zephyr/{version}")
        }
    };

    // Apply User-Agent and headers based on type
    if ua_to_use.contains("Shadowrocket") {
        let full_ua = "Shadowrocket/3082 CFNetwork/3826.600.41 Darwin/24.6.0 iPhone11,6";
        client_builder = client_builder.user_agent(full_ua).default_headers({
            let mut headers = reqwest::header::HeaderMap::new();
            headers.insert("Accept", reqwest::header::HeaderValue::from_static("*/*"));
            headers.insert(
                "Accept-Language",
                reqwest::header::HeaderValue::from_static("zh-CN,zh-Hans;q=0.9"),
            );
            headers.insert(
                "Cache-Control",
                reqwest::header::HeaderValue::from_static("no-cache"),
            );
            headers
        });
    } else {
        client_builder = client_builder
                .user_agent(&ua_to_use)
                .default_headers({
                    let mut headers = reqwest::header::HeaderMap::new();
                    headers.insert("Accept", reqwest::header::HeaderValue::from_static("text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9"));
                    headers
                });
    }

    client_builder.build().map_err(|e| e.to_string())
}

/// Check if an IP address is private or local
pub(crate) const fn is_private_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ipv4) => {
            ipv4.is_private()
                || ipv4.is_loopback()
                || ipv4.is_link_local()
                || ipv4.is_broadcast()
                || ipv4.is_documentation()
                || ipv4.is_unspecified()
        }
        IpAddr::V6(ipv6) => {
            ipv6.is_loopback() ||
            ipv6.is_unspecified() ||
            (ipv6.segments()[0] & 0xfe00) == 0xfc00 || // Unique Local Address
            (ipv6.segments()[0] & 0xff00) == 0xfe00 // Link Local Address
        }
    }
}

/// Check if a host is a private or local address (SSRF protection)
pub(crate) fn is_private_host(host: &str) -> bool {
    let host_lower = host.to_lowercase();

    // Quick checks for common localnames
    if host_lower == "localhost"
        || host_lower.ends_with(".localhost")
        || host_lower.ends_with(".local")
        || host_lower.ends_with(".test")
        || host_lower.ends_with(".example")
        || host_lower.ends_with(".invalid")
    {
        return true;
    }

    // If it's a direct IP address, check it
    if let Ok(ip) = host.parse::<IpAddr>() {
        return is_private_ip(ip);
    }

    false
}

/// Validate URL and its resolved IPs for SSRF protection
pub(crate) fn validate_subscription_url_with_ip(
    url: &str,
) -> Result<(String, Option<std::net::SocketAddr>), String> {
    let parsed_url = reqwest::Url::parse(url).map_err(|e| format!("Invalid URL: {e}"))?;

    // Only allow http and https schemes
    let scheme = parsed_url.scheme();
    if scheme != "http" && scheme != "https" {
        return Err("Only HTTP and HTTPS URLs are allowed".to_owned());
    }

    // Extract host
    let host = parsed_url.host_str().ok_or("URL must have a host")?;

    if is_private_host(host) {
        return Err("Access to private/local addresses is not allowed".to_owned());
    }

    // Fix Med-3: DNS Rebinding / SSRF TOCTOU
    // Resolve here and return the resolved SocketAddr so we can pin it in reqwest.
    let mut resolved_addr = None;
    // Use the correct port based on URL scheme
    let default_port = if scheme == "https" { 443 } else { 80 };
    let addrs = std::net::ToSocketAddrs::to_socket_addrs(&format!("{host}:{default_port}"))
        .map_err(|e| format!("Failed to resolve host: {e}"))?;

    for addr in addrs {
        if is_private_ip(addr.ip()) {
            return Err("Access to private/local resolved addresses is not allowed".to_owned());
        }
        if resolved_addr.is_none() {
            resolved_addr = Some(addr);
        }
    }

    if resolved_addr.is_none() {
        return Err("Could not resolve any IP address for the host".to_owned());
    }

    Ok((host.to_owned(), resolved_addr))
}

async fn read_response_body(resp: reqwest::Response) -> Result<Vec<u8>, String> {
    if let Some(content_length) = resp.content_length() {
        if usize::try_from(content_length).unwrap_or(0) > MAX_RESPONSE_SIZE {
            return Err(format!(
                "Response too large: {content_length} bytes (max {MAX_RESPONSE_SIZE} bytes)"
            ));
        }
    }

    use futures_util::StreamExt as _;
    let mut bytes = Vec::new();
    let mut stream = resp.bytes_stream();
    while let Some(chunk_result) = stream.next().await {
        let chunk = chunk_result.map_err(|e| format!("Failed to read chunk: {e}"))?;
        if bytes.len() + chunk.len() > MAX_RESPONSE_SIZE {
            return Err(format!(
                "Response exceeded size limit of {MAX_RESPONSE_SIZE} bytes"
            ));
        }
        bytes.extend_from_slice(&chunk);
    }

    Ok(bytes)
}

#[tauri::command]
#[allow(clippy::cognitive_complexity)]
pub async fn download_sub(
    app: AppHandle,
    url: String,
    name: String,
    user_agent: Option<String>,
    overwrite: Option<bool>,
    rate_limiter: State<'_, crate::RateLimiter>,
) -> Result<String, String> {
    let do_overwrite = overwrite.unwrap_or(false);
    // Rate limit: max 1 call per 5 seconds
    crate::rate_limit!(rate_limiter, "download_sub", 5000);

    let safe_name = validate_subscription_name(&name)?;

    let (host, resolved_addr) = validate_subscription_url_with_ip(&url)?;
    let resolve_pin = resolved_addr.map(|addr| (host.clone(), addr));

    let do_download = |client: reqwest::Client, url: String| async move {
        let resp = client.get(&url).send().await.map_err(|e| {
            if e.is_timeout() {
                format!("Request timeout: {e}")
            } else if e.is_connect() {
                format!("Connection failed: {e}")
            } else if e.is_request() {
                format!("Request error: {e}")
            } else if e.is_body() {
                format!("Body error: {e}")
            } else if e.is_decode() {
                format!("Decode error: {e}")
            } else {
                format!("Network error: {e}")
            }
        })?;

        if !resp.status().is_success() {
            let status = resp.status();
            println!("Download failed with status: {status}");
            return Err("Download failed with error status".to_owned());
        }

        if let Some(content_length) = resp.content_length() {
            if usize::try_from(content_length).unwrap_or(0) > MAX_RESPONSE_SIZE {
                return Err(format!(
                    "Response too large: {content_length} bytes (max {MAX_RESPONSE_SIZE} bytes)"
                ));
            }
        }

        let sub_info_header = resp
            .headers()
            .get("subscription-userinfo")
            .and_then(|h| h.to_str().ok())
            .unwrap_or("")
            .to_owned();

        let final_url = resp
            .headers()
            .get("profile-web-page-url")
            .and_then(|h| h.to_str().ok())
            .unwrap_or(&url)
            .to_owned();

        // Try to extract filename from Content-Disposition header
        let disp_filename = resp
            .headers()
            .get("content-disposition")
            .and_then(|h| h.to_str().ok())
            .and_then(parse_content_disposition_filename);

        let bytes = read_response_body(resp).await?;

        Ok::<(Vec<u8>, String, String, Option<String>), String>((
            bytes,
            sub_info_header,
            final_url,
            disp_filename,
        ))
    };

    let mut last_error = String::new();
    let mut result: Option<(Vec<u8>, String, String, Option<String>)> = None;

    // Try direct connection first
    match build_http_client_with_proxy(user_agent.as_deref(), resolve_pin.clone(), None) {
        Ok(client) => match do_download(client, url.clone()).await {
            Ok(data) => result = Some(data),
            Err(e) => {
                println!("[download_sub] Direct connection failed: {e}");
                last_error = e;
            }
        },
        Err(e) => {
            println!("[download_sub] Failed to build direct client: {e}");
            last_error = e;
        }
    }

    if result.is_none() {
        // Get proxy port from state, then immediately release the lock
        let proxy_url = {
            let state = app.state::<MihomoState>();
            let guard = state.0.lock().ok();
            guard.and_then(|g| {
                g.process()
                    .is_some()
                    .then(|| format!("http://127.0.0.1:{}", g.last_port().unwrap_or(7890)))
            })
        };

        if let Some(proxy_url_val) = proxy_url {
            // When using proxy, skip DNS pre-resolve pinning to let the proxy
            // handle DNS resolution (avoids issues with CDN / geo-balanced IPs).
            //
            // SSRF protection coverage for proxy paths:
            // - ✅ Initial URL host validated (private host check before any request)
            // - ✅ Redirect policy blocks redirects to private hosts/IPs
            // - ⚠️  Proxy-side SSRF (proxy resolving to internal IPs) is NOT
            //     preventable client-side — this is inherent to any proxy architecture.
            //     Mitigate by only configuring trusted proxies.
            let client_mihomo =
                build_http_client_with_proxy(user_agent.as_deref(), None, Some(proxy_url_val));
            if let Ok(client) = client_mihomo {
                match do_download(client, url.clone()).await {
                    Ok(data) => result = Some(data),
                    Err(e) => {
                        println!("[download_sub] Mihomo proxy failed: {e}");
                        last_error = e;
                    }
                }
            }
        }
    }

    // Two-tier download strategy: direct → Mihomo proxy.
    // System proxy fallback is intentionally removed to reduce SSRF attack surface.
    // The Mihomo proxy path is trusted (user-configured), while system proxy
    // could be set by any application/malware on the system.
    let (bytes, sub_info_header, final_url, disp_filename) = result.ok_or_else(|| {
        if last_error.is_empty() {
            "Network error occurred during download".to_owned()
        } else {
            last_error
        }
    })?;

    let mut content = String::from_utf8_lossy(&bytes).into_owned();

    if !content.contains("proxies:") && !content.contains("port:") {
        if let Some(decoded) = try_decode_base64_content(&content) {
            content = decoded;
        }
    }

    if content.contains("proxies:") || content.contains("proxy-groups:") {
        match serde_yaml::from_str::<serde_yaml::Value>(&content) {
            Ok(mut yaml_val) => {
                // Use module-level function to remove dangerous keys
                remove_dangerous_keys(&mut yaml_val, false);

                content = serde_yaml::to_string(&yaml_val)
                    .map_err(|e| format!("Failed to serialize sanitized subscription: {e}"))?;
            }
            Err(e) => {
                return Err(format!("Invalid YAML structure in subscription: {e}"));
            }
        }
    } else if !content.trim().starts_with("http") && !content.trim().is_empty() {
        return Err(
            "The subscription content is neither a valid Clash YAML nor a supported node list"
                .to_owned(),
        );
    }

    let paths = ensure_app_storage(&app)?;

    let mut clean_name = if safe_name.ends_with(".yaml") || safe_name.ends_with(".yml") {
        safe_name.clone()
    } else {
        format!("{safe_name}.yaml")
    };

    // Only apply enhanced naming (Content-Disposition / rules) for new subscriptions.
    // When updating (do_overwrite == true), always use the frontend-provided name directly.
    if !do_overwrite {
        let rule_name = extract_name_from_rules(&content);

        // Priority 1: Content-Disposition filename
        if let Some(dfn) = &disp_filename {
            let stem = if dfn.to_lowercase().ends_with(".yaml") {
                &dfn[..dfn.len() - 5]
            } else if dfn.to_lowercase().ends_with(".yml") {
                &dfn[..dfn.len() - 4]
            } else {
                dfn.as_str()
            };
            if !stem.is_empty() && stem.len() <= 64 {
                clean_name = format!("{stem}.yaml");
            }
        }
        // Priority 2: Rule-extracted name
        else if let Some(rn) = &rule_name {
            clean_name = format!("{rn}.yaml");
        }
    }

    clean_name = super::config_sanitizer::sanitize_config_file_name(&clean_name)?;

    // When overwrite is true (updating an existing subscription), write directly.
    // When false (adding a new subscription), auto-append numeric suffix to avoid collisions.
    if !do_overwrite && paths.profiles_dir.join(&clean_name).exists() {
        let stem = clean_name
            .strip_suffix(".yaml")
            .or_else(|| clean_name.strip_suffix(".yml"))
            .unwrap_or(&clean_name);
        let ext = clean_name.strip_prefix(stem).unwrap_or(".yaml");
        let mut max_suffix = 1u32;
        for dir_entry in std::fs::read_dir(&paths.profiles_dir)
            .ok()
            .into_iter()
            .flatten()
        {
            let entry = match dir_entry {
                Ok(e) => e,
                Err(_) => continue,
            };
            if let Some(entry_name) = entry.file_name().to_str() {
                if let Some(suffix_str) = entry_name
                    .strip_prefix(format!("{stem}-").as_str())
                    .and_then(|rest| rest.strip_suffix(ext))
                {
                    if let Ok(n) = suffix_str.parse::<u32>() {
                        max_suffix = max_suffix.max(n + 1);
                    }
                }
            }
        }
        clean_name = format!("{stem}-{max_suffix}{ext}");
    }

    let target_path = paths.profiles_dir.join(&clean_name);
    super::config_sanitizer::validate_path_within_dir(&target_path, &paths.profiles_dir)?;

    let mut metadata = load_metadata(&paths);
    metadata.configs.insert(
        clean_name.clone(),
        super::crypto::ConfigMetadata {
            url: Some(final_url),
            sub_info: if sub_info_header.is_empty() {
                None
            } else {
                Some(sub_info_header)
            },
        },
    );
    let final_content = content;

    // Best-effort atomic config + metadata update (compensating transactions, not ACID):
    //   Overwrite: target -> backup, temp -> target, save_metadata, cleanup backup
    //   New:      temp -> target, save_metadata, remove target on failure
    // Crash between steps may leave .bak.<uuid> residuals — cleaned up at startup.
    let is_overwrite = target_path.exists();

    // Use UUID suffix to avoid conflicts from concurrent updates or crash residuals
    let unique_id = uuid::Uuid::new_v4().to_string()[..8].to_owned();
    let backup_path =
        is_overwrite.then(|| target_path.with_extension(format!("yaml.bak.{unique_id}")));
    let temp_path = target_path.with_extension(format!("yaml.tmp.{unique_id}"));

    // Write new config to temp file
    write_file_secure(&temp_path, &final_content)?;

    // Overwrite: move old config to backup first
    if let Some(bp) = backup_path.as_ref() {
        std::fs::rename(&target_path, bp).map_err(|e| {
            let _ = std::fs::remove_file(&temp_path);
            format!("Failed to backup existing config (update aborted): {e}")
        })?;
    }

    // Move temp to final path (same directory — rename is always atomic, no copy fallback)
    if let Err(e) = std::fs::rename(&temp_path, &target_path) {
        let _ = std::fs::remove_file(&temp_path);
        if let Some(bp) = backup_path.as_ref() {
            if bp.exists() {
                let _ = std::fs::rename(bp, &target_path);
            }
        }
        return Err(format!("Failed to apply config file: {e}"));
    }

    // Save metadata — last step so failure can be cleanly rolled back
    if let Err(e) = save_metadata(&paths, &metadata) {
        // Rollback config to previous state
        let _ = std::fs::remove_file(&target_path);
        if let Some(bp) = backup_path.as_ref() {
            if bp.exists() {
                let _ = std::fs::rename(bp, &target_path);
            }
        }
        return Err(format!("Metadata save failed (config rolled back): {e}"));
    }

    // Success — clean up backup
    if let Some(bp) = backup_path.as_ref() {
        let _ = std::fs::remove_file(bp);
    }

    Ok(format!("Config saved as {clean_name}"))
}

#[tauri::command]
pub async fn fetch_text(url: String) -> Result<String, String> {
    let (host, resolved_addr) = validate_subscription_url_with_ip(&url)?;
    let resolve_pin = resolved_addr.map(|addr| (host, addr));
    let client = build_http_client(None, resolve_pin)?;

    let resp = client.get(&url).send().await.map_err(|e| {
        println!("Fetch failed: {e}");
        "Network error occurred during fetch".to_owned()
    })?;

    if !resp.status().is_success() {
        let status = resp.status();
        println!("Fetch failed with status: {status}");
        return Err("Fetch failed with error status".to_owned());
    }

    let bytes = read_response_body(resp).await?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn test_is_private_ip_v4() {
        assert!(is_private_ip("10.0.0.1".parse().unwrap()));
        assert!(is_private_ip("172.16.0.1".parse().unwrap()));
        assert!(is_private_ip("192.168.1.1".parse().unwrap()));
        assert!(is_private_ip("127.0.0.1".parse().unwrap()));
        assert!(is_private_ip("169.254.1.1".parse().unwrap()));
        assert!(is_private_ip("0.0.0.0".parse().unwrap()));
        assert!(!is_private_ip("8.8.8.8".parse().unwrap()));
        assert!(!is_private_ip("1.1.1.1".parse().unwrap()));
    }

    #[test]
    fn test_is_private_ip_v6() {
        assert!(is_private_ip("::1".parse().unwrap()));
        assert!(is_private_ip("::".parse().unwrap()));
        assert!(is_private_ip("fc00::1".parse().unwrap()));
        assert!(is_private_ip("fe80::1".parse().unwrap()));
        assert!(!is_private_ip("2001:4860:4860::8888".parse().unwrap()));
    }

    #[test]
    fn test_is_private_host() {
        assert!(is_private_host("localhost"));
        assert!(is_private_host("my.localhost"));
        assert!(is_private_host("my.local"));
        assert!(is_private_host("my.test"));
        assert!(is_private_host("my.example"));
        assert!(is_private_host("my.invalid"));
        assert!(is_private_host("127.0.0.1"));
        assert!(is_private_host("10.0.0.1"));
        assert!(!is_private_host("example.com"));
        assert!(!is_private_host("8.8.8.8"));
    }

    #[test]
    fn test_validate_subscription_name() {
        assert!(validate_subscription_name("my-config").is_ok());
        assert!(validate_subscription_name("config.yaml").is_ok());
        assert!(validate_subscription_name("").is_err());
        assert!(validate_subscription_name("../etc/passwd").is_err());
        assert!(validate_subscription_name("foo/bar").is_err());
        assert!(validate_subscription_name("foo\\bar").is_err());
        assert!(validate_subscription_name("a\0b").is_err());
    }

    #[test]
    fn test_try_decode_base64_content() {
        // Valid base64-encoded Clash config
        let yaml = "proxies:\n  - name: test\n    type: ss\n    port: 443";
        let encoded = base64_standard.encode(yaml);
        let result = try_decode_base64_content(&encoded);
        assert!(result.is_some());
        assert!(result.unwrap().contains("proxies:"));

        // Non-base64 content should return None
        assert!(try_decode_base64_content("not base64 at all!!!").is_none());

        // Valid base64 but not YAML should return None
        let not_yaml = base64_standard.encode("just some random text");
        assert!(try_decode_base64_content(&not_yaml).is_none());

        // Valid base64 YAML but no proxies key should return None
        let no_proxies = "some_key: value\nother: thing";
        let encoded_no_proxies = base64_standard.encode(no_proxies);
        assert!(try_decode_base64_content(&encoded_no_proxies).is_none());
    }
}
