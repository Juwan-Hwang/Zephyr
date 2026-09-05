//! Subscription content processing — platform-agnostic pure functions.
//!
//! Migrated from `src-tauri/src/core/subscription.rs` for cross-platform reuse.
//! Network I/O (reqwest, Tauri `AppHandle`) stays in src-tauri.

use base64::Engine as _;
use std::net::IpAddr;

/// Maximum response size for subscription downloads (10 MB).
pub const MAX_RESPONSE_SIZE: usize = 10 * 1024 * 1024;

#[inline]
const fn decode_hex_digit(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

// ── Pure functions for subscription content sanitization ─────────────────

/// Quote `short-id` values in YAML content before parsing.
/// This prevents YAML from interpreting hex-like values (e.g., "34010e92") as scientific notation.
pub fn quote_short_id_values(content: &str) -> String {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let re = RE.get_or_init(|| {
        match regex::Regex::new(r#"(?:^|\n)(\s*short-id:\s*)([^\s"'\n][^\s\n]*)"#) {
            Ok(re) => re,
            Err(e) => unreachable!("short-id regex is statically valid: {e}"),
        }
    });
    re.replace_all(content, |caps: &regex::Captures| {
        let prefix = &caps[1];
        let value = &caps[2];
        let newline = if caps[0].starts_with('\n') { "\n" } else { "" };
        format!("{newline}{prefix}\"{value}\"")
    })
    .into_owned()
}

/// Extract a name from the rules' policy-group field.
/// Scans up to 10 rules, returns the first non-generic policy-group name.
#[must_use]
pub fn extract_name_from_rules(content: &str) -> Option<String> {
    let yaml: serde_yaml::Value = serde_yaml::from_str(content).ok()?;

    let rules_seq = yaml.get("rules").and_then(|r| r.as_sequence())?;

    if rules_seq.is_empty() {
        return None;
    }

    let max_scan = 10.min(rules_seq.len());
    for rule_val in rules_seq.iter().take(max_scan) {
        let rule_str = match rule_val.as_str() {
            Some(s) => s,
            None => continue,
        };

        let name = match rule_str.split(',').nth(2) {
            Some(n) => n.trim(),
            None => continue,
        };

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
#[must_use]
pub fn parse_content_disposition_filename(header_value: &str) -> Option<String> {
    // Try filename*= first (RFC 5987, takes precedence)
    for raw_part in header_value.split(';') {
        let part = raw_part.trim();
        if let Some(raw_encoded) = part.strip_prefix("filename*=") {
            let encoded = raw_encoded.trim_matches('"');
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
#[must_use]
pub fn percent_decode(input: &str) -> String {
    if !input.contains('%') {
        return input.to_owned();
    }

    let mut result = Vec::with_capacity(input.len());
    let bytes = input.as_bytes();
    let mut i = 0;
    while let Some(&byte) = bytes.get(i) {
        if byte == b'%' {
            if let (Some(hi), Some(lo)) = (
                bytes.get(i + 1).and_then(|&byte| decode_hex_digit(byte)),
                bytes.get(i + 2).and_then(|&byte| decode_hex_digit(byte)),
            ) {
                result.push((hi << 4) | lo);
                i += 3;
                continue;
            }
        }
        result.push(byte);
        i += 1;
    }
    String::from_utf8(result).unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned())
}

/// Attempt to base64-decode content that does not already contain Clash markers.
/// Returns `Some(decoded)` only if the decoded bytes are valid UTF-8, valid YAML,
/// and contain a `proxies:` key (required for a valid Clash config).
pub fn try_decode_base64_content(content: &str) -> Option<String> {
    let mut trimmed = Vec::with_capacity(content.len());
    trimmed.extend(
        content
            .bytes()
            .filter(|&byte| !matches!(byte, b'\r' | b'\n' | b' ' | b'\t')),
    );
    let decoded_bytes = base64::engine::general_purpose::STANDARD
        .decode(&trimmed)
        .ok()?;
    let decoded_str = String::from_utf8(decoded_bytes).ok()?;
    let yaml_val: serde_yaml::Value = serde_yaml::from_str(&decoded_str).ok()?;
    let has_proxies = yaml_val
        .get("proxies")
        .is_some_and(serde_yaml::Value::is_sequence);
    has_proxies.then_some(decoded_str)
}

#[inline]
#[must_use]
pub fn is_mihomo_fake_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ipv4) => (std::net::Ipv4Addr::new(198, 18, 0, 0)
            ..=std::net::Ipv4Addr::new(198, 19, 255, 255))
            .contains(&ipv4),
        IpAddr::V6(_) => false,
    }
}

/// Check if an IP address is private or local
#[must_use]
pub fn is_private_ip(ip: IpAddr) -> bool {
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
            // Only convert IPv4-mapped IPv6 addresses (::ffff:x.x.x.x)
            // to prevent bypass via mapped addresses.
            // Do NOT use to_ipv4() which also converts ::1 → 0.0.0.1 etc.
            let octets = ipv6.octets();
            let is_ipv4_mapped =
                octets[0..10] == [0; 10] && octets[10] == 0xff && octets[11] == 0xff;
            if is_ipv4_mapped {
                if let Some(ipv4) = ipv6.to_ipv4() {
                    return ipv4.is_private()
                        || ipv4.is_loopback()
                        || ipv4.is_link_local()
                        || ipv4.is_broadcast()
                        || ipv4.is_documentation()
                        || ipv4.is_unspecified();
                }
            }
            ipv6.is_loopback()
                || ipv6.is_unspecified()
                || (ipv6.segments()[0] & 0xfe00) == 0xfc00
                || (ipv6.segments()[0] & 0xff00) == 0xfe00
        }
    }
}

/// Check if a host is a private or local address (SSRF protection)
#[must_use]
pub fn is_private_host(host: &str) -> bool {
    let trimmed = host.trim();
    if trimmed.is_empty() {
        return false;
    }
    let normalized = trimmed.trim_end_matches('.');
    if normalized.is_empty() {
        return false;
    }
    let host_lower = normalized.to_lowercase();

    if host_lower == "localhost"
        || host_lower.ends_with(".localhost")
        || host_lower.ends_with(".local")
        || host_lower.ends_with(".internal")
        || host_lower.ends_with(".intranet")
        || host_lower.ends_with(".private")
        || host_lower.ends_with(".lan")
        || host_lower == "home.arpa"
        || host_lower.ends_with(".home.arpa")
        || host_lower.ends_with(".home")
        || host_lower.ends_with(".corp")
    {
        return true;
    }

    let unbracketed = normalized
        .strip_prefix('[')
        .and_then(|h| h.strip_suffix(']'))
        .unwrap_or(normalized);

    if let Ok(ip) = unbracketed.parse::<IpAddr>() {
        return is_private_ip(ip);
    }

    false
}

/// Check if a host is a single-label non-IP host (e.g. "myhost", "router").
/// Single-label hosts are strictly direct-only to prevent internal SSRF via proxies.
#[must_use]
pub fn is_single_label_host(host: &str) -> bool {
    let trimmed = host.trim();
    let normalized = trimmed.trim_end_matches('.');
    let unbracketed = normalized
        .strip_prefix('[')
        .and_then(|h| h.strip_suffix(']'))
        .unwrap_or(normalized);
    !unbracketed.contains('.') && unbracketed.parse::<IpAddr>().is_err()
}

/// Check if a host is a literal private IP address or localhost.
/// Unlike `is_private_host`, this returns false for private domain name suffixes
/// (.internal, .lan, etc.) so domain names are still subject to DNS resolution and
/// destination IP validation rather than being treated as pre-trusted addresses.
#[must_use]
pub fn is_literal_private_host(host: &str) -> bool {
    let trimmed = host.trim();
    if trimmed.is_empty() {
        return false;
    }
    let normalized = trimmed.trim_end_matches('.');
    if normalized.is_empty() {
        return false;
    }
    let host_lower = normalized.to_lowercase();

    if host_lower == "localhost" || host_lower.ends_with(".localhost") {
        return true;
    }

    let unbracketed = normalized
        .strip_prefix('[')
        .and_then(|h| h.strip_suffix(']'))
        .unwrap_or(normalized);

    if let Ok(ip) = unbracketed.parse::<IpAddr>() {
        return is_private_ip(ip);
    }

    false
}

/// Validate and sanitize a subscription name to prevent path traversal and injection attacks.
pub fn validate_subscription_name(name: &str) -> Result<String, crate::error::AppError> {
    if name.is_empty() {
        return Err(crate::error::AppError::ConfigError(
            "Subscription name cannot be empty".to_owned(),
        ));
    }
    crate::config::sanitizer::sanitize_base_filename(name.to_owned())
}

/// Dedicated error type for public host address validation, distinguishing SSRF policy blocks
/// from transient or empty DNS lookup results.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PublicHostAddrError {
    SsrfBlocked(String),
    NoAddresses(String),
    Other(String),
}

impl std::fmt::Display for PublicHostAddrError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::SsrfBlocked(msg) | Self::NoAddresses(msg) | Self::Other(msg) => {
                write!(f, "{msg}")
            }
        }
    }
}

impl std::error::Error for PublicHostAddrError {}

/// Core validation logic for a public host's resolved addresses.
/// Extracted so tests can inject mock DNS results without real DNS.
pub fn validate_public_host_addrs(
    host: &str,
    addrs: &[std::net::SocketAddr],
) -> Result<(String, Option<std::net::SocketAddr>, bool), PublicHostAddrError> {
    let mut resolved_addr = None;
    let mut saw_fake_ip = false;

    for addr in addrs {
        if is_mihomo_fake_ip(addr.ip()) {
            saw_fake_ip = true;
            continue;
        }
        if is_private_ip(addr.ip()) {
            return Err(PublicHostAddrError::SsrfBlocked(format!(
                "SSRF protection: host '{host}' resolved to private IP {} — access to private/local addresses is not allowed. \
                 If this is a trusted internal subscription, enter the private address directly (e.g. http://192.168.x.x) instead of using a domain name.",
                addr.ip()
            )));
        }
        if resolved_addr.is_none() {
            resolved_addr = Some(*addr);
        }
    }

    if resolved_addr.is_none() {
        if saw_fake_ip {
            return Err(PublicHostAddrError::NoAddresses(format!(
                "DNS resolved to synthetic fake-IP address for '{host}', cannot pin for direct connection"
            )));
        }
        return Err(PublicHostAddrError::NoAddresses(
            "Could not resolve any IP address for the host".to_owned(),
        ));
    }

    Ok((host.to_owned(), resolved_addr, false))
}

/// Validate URL scheme, host, and port without DNS resolution.
/// Returns `(host, port, user_entered_private)`.
pub fn validate_subscription_url_basic(url: &str) -> Result<(String, u16, bool), String> {
    let trimmed = url.trim();
    if trimmed.starts_with("http:///") || trimmed.starts_with("https:///") {
        return Err("URL must have a host".to_owned());
    }

    let parsed_url = url::Url::parse(trimmed).map_err(|e| format!("Invalid URL: {e}"))?;

    let scheme = parsed_url.scheme();
    if scheme != "http" && scheme != "https" {
        return Err("Only HTTP and HTTPS URLs are allowed".to_owned());
    }

    let host = parsed_url.host_str().ok_or("URL must have a host")?;
    if host.trim().is_empty() {
        return Err("URL must have a host".to_owned());
    }

    let user_entered_private = is_private_host(host);

    let default_port = if scheme == "https" { 443 } else { 80 };
    let port = parsed_url.port().unwrap_or(default_port);

    Ok((host.to_owned(), port, user_entered_private))
}

/// Validate URL and its resolved IPs for SSRF protection.
/// Returns `(host, resolved_addr, user_entered_private)`.
pub fn validate_subscription_url_with_ip(
    url: &str,
) -> Result<(String, Option<std::net::SocketAddr>, bool), String> {
    let (host, port, user_entered_private) = validate_subscription_url_basic(url)?;
    let trusted_private_literal = is_literal_private_host(&host);

    if trusted_private_literal {
        return Ok((host, None, true));
    }

    let addrs: Vec<std::net::SocketAddr> =
        std::net::ToSocketAddrs::to_socket_addrs(&format!("{host}:{port}"))
            .map_err(|e| format!("DNS resolution failed for '{host}': {e}"))?
            .collect();

    if user_entered_private {
        // Explicitly entered private-suffix hostname (e.g. nas.local, router.lan, svc.internal).
        // It is an authorized direct-only LAN destination.
        // Pin the first resolved address and treat as user_entered_private (direct-only).
        let first_addr = addrs.first().copied();
        return Ok((host, first_addr, true));
    }

    validate_public_host_addrs(&host, &addrs).map_err(|e| e.to_string())
}

fn contains_http_status(e: &str) -> bool {
    e.match_indices("HTTP ").any(|(i, _)| {
        e.as_bytes()
            .get(i + 5..i + 8)
            .is_some_and(|d| d.iter().all(u8::is_ascii_digit))
    })
}

/// Determine the appropriate error code based on the error message content.
///
/// Migrated from `src-tauri/src/core/subscription.rs`.
#[cfg_attr(feature = "uniffi", uniffi::export)]
#[must_use]
pub fn classify_sub_error(e: String) -> u16 {
    if e.contains("SSRF protection")
        || e.contains("[SSRF_BLOCKED]")
        || e.contains("SSRF blocked")
        || e.contains("Direct SSRF blocked")
        || e.contains("Proxy SSRF blocked")
        || e.contains("Global-mode SSRF blocked")
        || e.contains("Redirect to private host blocked")
        || e.contains("Redirect to private IP blocked")
    {
        crate::event::codes::SUB_SSRF_BLOCKED
    } else if e.contains("Invalid URL")
        || e.contains("Only HTTP")
        || e.contains("must have a host")
        || e.contains("URL must not be empty")
    {
        crate::event::codes::SUB_URL_INVALID
    } else if contains_http_status(&e) {
        crate::event::codes::SUB_HTTP_ERROR
    } else if e.contains("DNS resolution failed")
        || e.contains("Could not resolve")
        || e.contains("DNS resolution returned no addresses")
        || e.contains("DNS deadline elapsed")
        || e.contains("DNS resolution timed out")
        || e.contains("DNS resolution timeout")
    {
        crate::event::codes::SUB_DNS_FAILED
    } else if e.contains("Subscription name")
        || e.contains("Path traversal detected")
        || e.contains("Invalid character in filename")
        || e.contains("Filename too long")
        || e.contains("Reserved filename")
        || e.contains("Invalid file type")
    {
        crate::event::codes::SUB_NAME_INVALID
    } else if e.contains("timeout") || e.contains("Timeout") || e.contains("timed out") {
        crate::event::codes::SUB_UPDATE_TIMEOUT
    } else if e.contains("Response too large") || e.contains("exceeded size limit") {
        crate::event::codes::SUB_RESPONSE_TOO_LARGE
    } else if e.contains("Invalid YAML")
        || e.contains("YAML structure")
        || e.contains("neither a valid Clash YAML")
    {
        crate::event::codes::SUB_YAML_INVALID
    } else if e.contains("Connection failed")
        || e.contains("Network error")
        || e.contains("Request error")
        || e.contains("Direct:")
        || e.contains("Proxy:")
    {
        crate::event::codes::SUB_NETWORK_ERROR
    } else {
        crate::event::codes::SUB_UPDATE_FAILED
    }
}

/// Strip query parameters, username, and password from any http(s) URL in a string.
///
/// This prevents leaking subscription tokens to logs and frontend.
/// Migrated from `src-tauri/src/core/subscription.rs`.
#[cfg_attr(feature = "uniffi", uniffi::export)]
#[must_use]
pub fn redact_url_in_string(s: String) -> String {
    if !s.contains("http") {
        return s;
    }

    let mut result = String::with_capacity(s.len());
    let mut start_idx = 0;
    while start_idx < s.len() {
        let remaining = &s[start_idx..];
        let found_http = remaining.find("http://");
        let found_https = remaining.find("https://");
        let found_offset = found_http.into_iter().chain(found_https).min();
        let Some(offset) = found_offset else {
            result.push_str(remaining);
            break;
        };
        let start = start_idx + offset;
        result.push_str(&s[start_idx..start]);
        // Find end of URL (whitespace or end of string)
        let mut url_end = s[start..]
            .find(|c: char| c.is_whitespace())
            .map(|pos| start + pos)
            .unwrap_or(s.len());
        // Trim trailing punctuation/delimiters that are likely not part of the URL
        while url_end > start {
            let last_char = s[..url_end].chars().next_back();
            if let Some(c) = last_char {
                if matches!(
                    c,
                    ')' | ']' | '}' | '>' | '"' | '\'' | ',' | '.' | ';' | ':'
                ) {
                    url_end -= c.len_utf8();
                } else {
                    break;
                }
            } else {
                break;
            }
        }
        let url_str = &s[start..url_end];
        if url::Url::parse(url_str).is_ok() {
            let redacted = crate::config::merge::mask_url(url_str.to_owned());
            result.push_str(&redacted);
            start_idx = url_end;
        } else {
            let is_https = s[start..].starts_with("https://");
            let skip_len = if is_https { 5 } else { 4 };
            result.push_str(&s[start..start + skip_len]);
            start_idx = start + skip_len;
        }
    }
    result
}

/// Batch update result for a single subscription.
/// Migrated from `src-tauri/src/core/subscription.rs`.
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
#[derive(Debug, Clone, serde::Serialize)]
pub struct BatchUpdateResult {
    pub name: String,
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Input item for batch subscription update.
/// Migrated from `src-tauri/src/core/subscription.rs`.
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
#[derive(Debug, Clone, serde::Deserialize)]
pub struct BatchUpdateItem {
    /// If None, the URL is resolved internally from metadata.
    pub url: Option<String>,
    pub name: String,
}

/// 从 mihomo /proxies 返回的字典中提取全局模式候选节点及当前 GLOBAL 选中项。
/// 纯函数，便于独立单元测试。
pub fn select_global_candidate(
    proxies: &serde_json::Map<String, serde_json::Value>,
) -> Option<(String, Option<String>)> {
    let global_obj = proxies.get("GLOBAL");
    let global_now = global_obj
        .and_then(|g| g.get("now"))
        .and_then(|n| n.as_str())
        .map(std::borrow::ToOwned::to_owned);

    fn is_special_target(s: &str) -> bool {
        matches!(
            s,
            "DIRECT" | "REJECT" | "REJECT-DROP" | "PASS" | "PASS-RULE" | "COMPATIBLE"
        )
    }

    let global_all: Vec<&str> = global_obj
        .and_then(|g| g.get("all"))
        .and_then(|a| a.as_array())
        .map(|arr| arr.iter().filter_map(|v| v.as_str()).collect())
        .unwrap_or_default();

    // 递归解析候选节点/策略组，确保最终生效的叶子节点存在于 proxies 中且不是 DIRECT / REJECT 等特殊目标。
    // 使用 visited 集合检测循环依赖，支持任意深度的无环策略组链路与嵌套策略组递归验证。
    fn check_node_resolves_to_proxy(
        name: &str,
        proxies: &serde_json::Map<String, serde_json::Value>,
        visited: &mut std::collections::HashSet<String>,
        depth: usize,
    ) -> bool {
        if depth > proxies.len().max(16) {
            return false;
        }
        if is_special_target(name) {
            return false;
        }
        if !visited.insert(name.to_owned()) {
            return false;
        }
        let Some(p_obj) = proxies.get(name) else {
            return false;
        };
        let p_type = p_obj.get("type").and_then(|t| t.as_str()).unwrap_or("");
        if p_type.eq_ignore_ascii_case("Selector")
            || p_type.eq_ignore_ascii_case("URLTest")
            || p_type.eq_ignore_ascii_case("Fallback")
            || p_type.eq_ignore_ascii_case("LoadBalance")
            || p_type.eq_ignore_ascii_case("Relay")
        {
            if let Some(next_now) = p_obj.get("now").and_then(|n| n.as_str()) {
                return check_node_resolves_to_proxy(next_now, proxies, visited, depth + 1);
            }
            if p_type.eq_ignore_ascii_case("LoadBalance") {
                if let Some(all_arr) = p_obj.get("all").and_then(|a| a.as_array()) {
                    let members: Vec<&str> = all_arr.iter().filter_map(|v| v.as_str()).collect();
                    if !members.is_empty() {
                        return members.iter().all(|member| {
                            let mut branch_visited = visited.clone();
                            check_node_resolves_to_proxy(
                                member,
                                proxies,
                                &mut branch_visited,
                                depth + 1,
                            )
                        });
                    }
                }
            }
            return false;
        }
        if p_type.is_empty()
            || p_type.eq_ignore_ascii_case("Direct")
            || p_type.eq_ignore_ascii_case("Reject")
            || p_type.eq_ignore_ascii_case("RejectDrop")
            || p_type.eq_ignore_ascii_case("Pass")
            || p_type.eq_ignore_ascii_case("Pass-Rule")
            || p_type.eq_ignore_ascii_case("Compatible")
        {
            return false;
        }
        p_obj.get("alive").and_then(serde_json::Value::as_bool) != Some(false)
    }

    let resolves_to_effective_proxy = |start_name: &str| -> bool {
        let mut visited = std::collections::HashSet::new();
        check_node_resolves_to_proxy(start_name, proxies, &mut visited, 0)
    };

    let is_valid_global_candidate = |s: &str| {
        !global_all.is_empty() && global_all.contains(&s) && resolves_to_effective_proxy(s)
    };

    let active_node = global_now
        .as_deref()
        .filter(|n| is_valid_global_candidate(n))
        .map(std::borrow::ToOwned::to_owned)
        .or_else(|| {
            // Priority 1: Check active `now` of common selector/urltest/fallback groups.
            // If the group's `now` is in GLOBAL.all and resolves to a real proxy, prefer it.
            // If not, but the group itself is in GLOBAL.all and resolves to a real proxy, use the group name.
            for (name, proxy_val) in proxies {
                if name == "GLOBAL" || is_special_target(name) {
                    continue;
                }
                let p_type = proxy_val.get("type").and_then(|t| t.as_str()).unwrap_or("");
                if p_type.eq_ignore_ascii_case("Selector")
                    || p_type.eq_ignore_ascii_case("URLTest")
                    || p_type.eq_ignore_ascii_case("Fallback")
                {
                    if let Some(now) = proxy_val.get("now").and_then(|n| n.as_str()) {
                        if is_valid_global_candidate(now) {
                            return Some(now.to_owned());
                        }
                    }
                    if is_valid_global_candidate(name) {
                        return Some(name.clone());
                    }
                }
            }

            // Priority 2: Look through GLOBAL's member list `all` for the first valid candidate.
            // This ensures the chosen node or group is recognized as a valid GLOBAL member
            // by Mihomo's PUT /proxies/GLOBAL API and actually routes through an active proxy.
            for &member_name in &global_all {
                if is_valid_global_candidate(member_name) {
                    return Some(member_name.to_owned());
                }
            }

            None
        })?;

    Some((active_node, global_now))
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
        assert!(!is_private_ip("198.18.0.1".parse().unwrap()));
        assert!(!is_private_ip("198.19.255.254".parse().unwrap()));
        assert!(is_mihomo_fake_ip("198.18.0.1".parse().unwrap()));
        assert!(is_mihomo_fake_ip("198.19.255.254".parse().unwrap()));
        assert!(!is_mihomo_fake_ip("8.8.8.8".parse().unwrap()));
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
        assert!(is_private_host("service.internal"));
        assert!(is_private_host("router.lan"));
        assert!(is_private_host("device.home.arpa"));
        assert!(is_private_host("home.arpa"));
        assert!(is_private_host("127.0.0.1"));
        assert!(is_private_host("10.0.0.1"));
        assert!(is_private_host("192.168.1.1"));
        assert!(is_private_host("172.16.0.1"));
        assert!(is_private_host("::1"));
        assert!(is_private_host("[::1]"));
        assert!(is_private_host("[fd00::1]"));
        assert!(is_private_host("[fe80::1]"));
        assert!(is_private_host("nas.corp"));
        assert!(is_private_host("gateway.home"));
        assert!(!is_private_host("router"));
        assert!(!is_private_host("intranet"));
        assert!(!is_private_host("my.test"));
        assert!(!is_private_host("example.com"));
        assert!(!is_private_host("1.1.1.1"));
        assert!(!is_private_host("8.8.8.8"));
        assert!(!is_private_host("[2606:4700:4700::1111]"));
    }

    #[test]
    fn test_is_literal_private_host() {
        assert!(is_literal_private_host("localhost"));
        assert!(is_literal_private_host("my.localhost"));
        assert!(is_literal_private_host("127.0.0.1"));
        assert!(is_literal_private_host("10.0.0.1"));
        assert!(is_literal_private_host("192.168.1.1"));
        assert!(is_literal_private_host("172.16.0.1"));
        assert!(is_literal_private_host("::1"));
        assert!(is_literal_private_host("[::1]"));
        assert!(is_literal_private_host("[fd00::1]"));
        assert!(is_literal_private_host("[fe80::1]"));

        // Domain names must return false so they undergo DNS resolution and destination-IP validation
        assert!(!is_literal_private_host("service.internal"));
        assert!(!is_literal_private_host("router.lan"));
        assert!(!is_literal_private_host("device.home.arpa"));
        assert!(!is_literal_private_host("home.arpa"));
        assert!(!is_literal_private_host("my.local"));
        assert!(!is_literal_private_host("nas.corp"));
        assert!(!is_literal_private_host("gateway.home"));
        assert!(!is_literal_private_host("example.com"));
        assert!(!is_literal_private_host("8.8.8.8"));
    }

    #[test]
    fn test_is_private_host_trailing_dots_and_empty() {
        assert!(is_private_host("service.internal."));
        assert!(is_private_host("service.internal.."));
        assert!(is_private_host("router.lan."));
        assert!(is_private_host("router.lan..."));
        assert!(is_private_host("localhost."));
        assert!(is_private_host("localhost.."));
        assert!(is_private_host("127.0.0.1.."));
        assert!(is_literal_private_host("localhost.."));
        assert!(is_literal_private_host("127.0.0.1.."));
        assert!(is_single_label_host("myhost.."));
        assert!(!is_private_host(""));
        assert!(!is_private_host("   "));
        assert!(!is_private_host("."));
        assert!(!is_private_host(".."));
    }

    #[test]
    fn test_try_decode_base64_content() {
        let yaml = "proxies:\n  - name: test\n    type: ss\n    port: 443";
        let encoded = base64::engine::general_purpose::STANDARD.encode(yaml);
        let result = try_decode_base64_content(&encoded);
        assert!(result.is_some());
        assert!(result.unwrap().contains("proxies:"));

        assert!(try_decode_base64_content("not base64 at all!!!").is_none());

        let not_yaml = base64::engine::general_purpose::STANDARD.encode("just some random text");
        assert!(try_decode_base64_content(&not_yaml).is_none());
    }

    #[test]
    fn test_quote_short_id_values_simple() {
        let yaml = r"short-id: abc123";
        let result = quote_short_id_values(yaml);
        assert_eq!(result, r#"short-id: "abc123""#);
    }

    #[test]
    fn test_quote_short_id_values_hex_like() {
        let yaml = r"short-id: 34010e92";
        let result = quote_short_id_values(yaml);
        assert_eq!(result, r#"short-id: "34010e92""#);
    }

    #[test]
    fn test_quote_short_id_values_already_quoted() {
        let yaml = r#"short-id: "abc123""#;
        let result = quote_short_id_values(yaml);
        assert_eq!(result, r#"short-id: "abc123""#);
    }

    #[test]
    fn test_validate_subscription_name() {
        assert!(validate_subscription_name("my-config").is_ok());
        assert!(validate_subscription_name("").is_err());
        assert!(validate_subscription_name("../etc/passwd").is_err());
    }

    #[test]
    fn test_validate_private_ip_allowed() {
        let result = validate_subscription_url_with_ip("http://192.168.1.2/sub");
        assert!(result.is_ok());
        let (_, resolved_addr, user_entered_private) = result.unwrap();
        assert!(resolved_addr.is_none());
        assert!(user_entered_private);

        let result_suffix = validate_subscription_url_with_ip("http://nas.local:8080/sub");
        if let Ok((host, resolved_addr, is_private)) = result_suffix {
            assert_eq!(host, "nas.local");
            assert!(resolved_addr.is_some());
            assert!(is_private);
        }

        let result_local = validate_subscription_url_basic("http://nas.local:8080/sub");
        assert!(result_local.is_ok());
        let (host, port, user_entered_private) = result_local.unwrap();
        assert_eq!(host, "nas.local");
        assert_eq!(port, 8080);
        assert!(user_entered_private);

        let result_internal = validate_subscription_url_basic("http://service.internal:8080/sub");
        assert!(result_internal.is_ok());
        let (_, _, user_entered_private) = result_internal.unwrap();
        assert!(user_entered_private);
    }

    #[test]
    fn test_validate_invalid_schemes_rejected() {
        assert!(validate_subscription_url_with_ip("ftp://192.168.1.1/sub").is_err());
        assert!(validate_subscription_url_with_ip("file:///etc/passwd").is_err());
        assert!(validate_subscription_url_basic("ftp://192.168.1.1/sub").is_err());
        assert!(validate_subscription_url_basic("file:///etc/passwd").is_err());
        assert!(validate_subscription_url_basic("http:///sub").is_err());
        assert!(validate_subscription_url_with_ip("http:///sub").is_err());
    }

    #[test]
    fn test_validate_subscription_url_basic_success() {
        let (host, port, private) =
            validate_subscription_url_basic("https://blocked-domain.example.com/sub?token=123")
                .unwrap();
        assert_eq!(host, "blocked-domain.example.com");
        assert_eq!(port, 443);
        assert!(!private);

        let (host, port, private) =
            validate_subscription_url_basic("http://192.168.1.100:8080/sub").unwrap();
        assert_eq!(host, "192.168.1.100");
        assert_eq!(port, 8080);
        assert!(private);

        let (host, port, private) =
            validate_subscription_url_basic("http://localhost:9090/sub").unwrap();
        assert_eq!(host, "localhost");
        assert_eq!(port, 9090);
        assert!(private);

        let (host, port, private) =
            validate_subscription_url_basic("http://[::1]:8080/sub").unwrap();
        assert_eq!(host, "[::1]");
        assert_eq!(port, 8080);
        assert!(private);
    }

    #[test]
    fn test_public_host_with_public_ip_allowed() {
        let addrs: Vec<std::net::SocketAddr> = vec!["1.2.3.4:80".parse().unwrap()];
        let result = validate_public_host_addrs("example.com", &addrs);
        assert!(result.is_ok());
    }

    #[test]
    fn test_public_host_resolving_to_private_ip_rejected() {
        let sinkhole_ips = [
            "192.168.1.1:80",
            "10.0.0.1:80",
            "172.16.0.1:80",
            "127.0.0.1:80",
            "0.0.0.0:80",
            "169.254.169.254:80",
            "[::1]:80",
            "[fc00::1]:80",
            "[fe80::1]:80",
        ];
        for ip in sinkhole_ips {
            let addrs: Vec<std::net::SocketAddr> = vec![ip.parse().unwrap()];
            let result = validate_public_host_addrs("attacker.com", &addrs);
            assert!(
                result.is_err(),
                "Expected sinkhole IP {ip} to be rejected as SSRF"
            );
            assert!(
                matches!(result.unwrap_err(), PublicHostAddrError::SsrfBlocked(_)),
                "Expected SsrfBlocked for sinkhole IP {ip}"
            );
        }
    }

    #[test]
    fn test_public_host_resolving_to_fake_ip_not_pinned_nor_ssrf() {
        let addrs: Vec<std::net::SocketAddr> = vec!["198.18.0.1:80".parse().unwrap()];
        let result = validate_public_host_addrs("blocked.com", &addrs);
        assert!(result.is_err());
        assert!(matches!(
            result.unwrap_err(),
            PublicHostAddrError::NoAddresses(_)
        ));

        // If mixed with a real public IP, pins the real public IP
        let mixed_addrs: Vec<std::net::SocketAddr> = vec![
            "198.18.0.1:80".parse().unwrap(),
            "93.184.216.34:80".parse().unwrap(),
        ];
        let mixed_result = validate_public_host_addrs("example.com", &mixed_addrs);
        assert!(mixed_result.is_ok());
        let (_, pinned, _) = mixed_result.unwrap();
        assert_eq!(pinned, Some("93.184.216.34:80".parse().unwrap()));
    }

    #[test]
    fn test_parse_content_disposition_filename() {
        assert_eq!(
            parse_content_disposition_filename(r#"attachment; filename="config.yaml""#),
            Some("config.yaml".to_owned())
        );
        assert_eq!(
            parse_content_disposition_filename("attachment; filename*=UTF-8''%E9%85%8D%E7%BD%AE"),
            Some("配置".to_owned())
        );
        assert_eq!(parse_content_disposition_filename("no filename here"), None);
    }

    // -- Snapshot tests for subscription content processing ----------------

    #[test]
    fn snapshot_quote_short_id_simple() {
        insta::assert_snapshot!(quote_short_id_values("short-id: abc123"));
    }

    #[test]
    fn snapshot_quote_short_id_hex_like() {
        insta::assert_snapshot!(quote_short_id_values("short-id: 34010e92"));
    }

    #[test]
    fn snapshot_quote_short_id_multiple() {
        insta::assert_snapshot!(quote_short_id_values(
            "proxies:\n  - name: test-1\n    short-id: abc123\n  - name: test-2\n    short-id: def456"
        ));
    }

    #[test]
    fn snapshot_percent_decode_ascii() {
        insta::assert_snapshot!(percent_decode("hello%20world"));
    }

    #[test]
    fn snapshot_percent_decode_utf8() {
        insta::assert_snapshot!(percent_decode("%E4%B8%AD%E6%96%87"));
    }

    #[test]
    fn snapshot_percent_decode_no_encoding() {
        insta::assert_snapshot!(percent_decode("plain text"));
    }

    #[test]
    fn snapshot_redact_url_in_string_single() {
        insta::assert_snapshot!(redact_url_in_string(
            "Fetching config from https://example.com/sub?token=secret123".to_owned()
        ));
    }

    #[test]
    fn snapshot_redact_url_in_string_multiple() {
        insta::assert_snapshot!(redact_url_in_string(
            "First http://a.com/config then https://b.com/sub2 done".to_owned()
        ));
    }

    #[test]
    fn snapshot_redact_url_in_string_no_url() {
        insta::assert_snapshot!(redact_url_in_string("Just a plain message".to_owned()));
    }

    #[test]
    fn test_select_global_candidate_special_targets_only() {
        let json = serde_json::json!({
            "GLOBAL": {
                "all": ["DIRECT", "REJECT", "REJECT-DROP", "PASS-RULE"],
                "now": "PASS-RULE"
            }
        });
        let proxies = json.as_object().unwrap();
        assert_eq!(select_global_candidate(proxies), None);
    }

    #[test]
    fn test_select_global_candidate_cycle_resolution() {
        let json = serde_json::json!({
            "GLOBAL": {
                "all": ["GroupA"],
                "now": "GroupA"
            },
            "GroupA": {
                "type": "Selector",
                "now": "GroupB"
            },
            "GroupB": {
                "type": "Selector",
                "now": "GroupA"
            }
        });
        let proxies = json.as_object().unwrap();
        assert_eq!(select_global_candidate(proxies), None);
    }

    #[test]
    fn test_select_global_candidate_nested_selector() {
        let json = serde_json::json!({
            "GLOBAL": {
                "all": ["ProxyGroup"],
                "now": "ProxyGroup"
            },
            "ProxyGroup": {
                "type": "Selector",
                "now": "HK-01"
            },
            "HK-01": {
                "type": "Shadowsocks"
            }
        });
        let proxies = json.as_object().unwrap();
        assert_eq!(
            select_global_candidate(proxies),
            Some(("ProxyGroup".to_owned(), Some("ProxyGroup".to_owned())))
        );
    }

    #[test]
    fn test_select_global_candidate_prefers_active_now_if_in_all() {
        let json = serde_json::json!({
            "GLOBAL": {
                "all": ["HK-01", "US-01"],
                "now": "DIRECT"
            },
            "AutoGroup": {
                "type": "Selector",
                "now": "US-01"
            },
            "HK-01": {
                "type": "Vmess"
            },
            "US-01": {
                "type": "Vmess"
            }
        });
        let proxies = json.as_object().unwrap();
        assert_eq!(
            select_global_candidate(proxies),
            Some(("US-01".to_owned(), Some("DIRECT".to_owned())))
        );
    }

    #[test]
    fn test_select_global_candidate_fallback_to_global_all_member() {
        let json = serde_json::json!({
            "GLOBAL": {
                "all": ["DIRECT", "JP-01"],
                "now": "DIRECT"
            },
            "JP-01": {
                "type": "Trojan"
            }
        });
        let proxies = json.as_object().unwrap();
        assert_eq!(
            select_global_candidate(proxies),
            Some(("JP-01".to_owned(), Some("DIRECT".to_owned())))
        );
    }

    #[test]
    fn test_select_global_candidate_empty_global_all() {
        let json = serde_json::json!({
            "GLOBAL": {
                "all": [],
                "now": "DIRECT"
            },
            "CustomSelector": {
                "type": "Selector",
                "now": "Node-A"
            },
            "Node-A": {
                "type": "Shadowsocks"
            }
        });
        let proxies = json.as_object().unwrap();
        assert_eq!(select_global_candidate(proxies), None);
    }

    #[test]
    fn test_select_global_candidate_unknown_leaf_rejected() {
        let json = serde_json::json!({
            "GLOBAL": {
                "all": ["GhostNode"],
                "now": "GhostNode"
            }
        });
        let proxies = json.as_object().unwrap();
        assert_eq!(select_global_candidate(proxies), None);
    }

    #[test]
    fn test_select_global_candidate_rejects_custom_named_non_proxy_types() {
        let json = serde_json::json!({
            "GLOBAL": {
                "all": ["MyDirect", "MyReject", "MyCompatible", "ValidNode"],
                "now": "MyDirect"
            },
            "MyDirect": {
                "type": "Direct"
            },
            "MyReject": {
                "type": "Reject"
            },
            "MyCompatible": {
                "type": "Compatible"
            },
            "ValidNode": {
                "type": "Shadowsocks"
            }
        });
        let proxies = json.as_object().unwrap();
        assert_eq!(
            select_global_candidate(proxies),
            Some(("ValidNode".to_owned(), Some("MyDirect".to_owned())))
        );
    }

    #[test]
    fn test_select_global_candidate_load_balance_and_relay() {
        let json = serde_json::json!({
            "GLOBAL": {
                "all": ["LB-Group", "Relay-Group"],
                "now": "LB-Group"
            },
            "LB-Group": {
                "type": "LoadBalance",
                "now": "DIRECT"
            },
            "Relay-Group": {
                "type": "Relay",
                "now": "Leaf-01"
            },
            "Leaf-01": {
                "type": "Vmess"
            }
        });
        let proxies = json.as_object().unwrap();
        assert_eq!(
            select_global_candidate(proxies),
            Some(("Relay-Group".to_owned(), Some("LB-Group".to_owned())))
        );
    }

    #[test]
    fn test_select_global_candidate_load_balance_without_now() {
        let mixed_json = serde_json::json!({
            "GLOBAL": {
                "all": ["LB-Group"],
                "now": "LB-Group"
            },
            "LB-Group": {
                "type": "LoadBalance",
                "all": ["DIRECT", "DeadNode", "LiveLeaf"]
            },
            "DeadNode": {
                "type": "Shadowsocks",
                "alive": false
            },
            "LiveLeaf": {
                "type": "Shadowsocks",
                "alive": true
            }
        });
        let mixed_proxies = mixed_json.as_object().unwrap();
        assert_eq!(select_global_candidate(mixed_proxies), None);

        let valid_json = serde_json::json!({
            "GLOBAL": {
                "all": ["LB-Group"],
                "now": "LB-Group"
            },
            "LB-Group": {
                "type": "LoadBalance",
                "all": ["LiveLeaf1", "LiveLeaf2"]
            },
            "LiveLeaf1": {
                "type": "Shadowsocks",
                "alive": true
            },
            "LiveLeaf2": {
                "type": "Shadowsocks",
                "alive": true
            }
        });
        let valid_proxies = valid_json.as_object().unwrap();
        assert_eq!(
            select_global_candidate(valid_proxies),
            Some(("LB-Group".to_owned(), Some("LB-Group".to_owned())))
        );

        // LoadBalance containing a nested Selector that selects DIRECT must be rejected
        let nested_direct_json = serde_json::json!({
            "GLOBAL": {
                "all": ["LB-Group"],
                "now": "LB-Group"
            },
            "LB-Group": {
                "type": "LoadBalance",
                "all": ["NestedSelector", "LiveLeaf"]
            },
            "NestedSelector": {
                "type": "Selector",
                "now": "DIRECT",
                "all": ["DIRECT", "LiveLeaf"]
            },
            "LiveLeaf": {
                "type": "Shadowsocks",
                "alive": true
            }
        });
        let nested_direct_proxies = nested_direct_json.as_object().unwrap();
        assert_eq!(select_global_candidate(nested_direct_proxies), None);

        // LoadBalance containing a nested Selector that selects a live proxy node must succeed
        let nested_valid_json = serde_json::json!({
            "GLOBAL": {
                "all": ["LB-Group"],
                "now": "LB-Group"
            },
            "LB-Group": {
                "type": "LoadBalance",
                "all": ["NestedSelector", "LiveLeaf"]
            },
            "NestedSelector": {
                "type": "Selector",
                "now": "LiveLeaf2",
                "all": ["DIRECT", "LiveLeaf2"]
            },
            "LiveLeaf": {
                "type": "Shadowsocks",
                "alive": true
            },
            "LiveLeaf2": {
                "type": "Shadowsocks",
                "alive": true
            }
        });
        let nested_valid_proxies = nested_valid_json.as_object().unwrap();
        assert_eq!(
            select_global_candidate(nested_valid_proxies),
            Some(("LB-Group".to_owned(), Some("LB-Group".to_owned())))
        );
    }

    #[test]
    fn test_select_global_candidate_ignores_dead_leaf() {
        let json = serde_json::json!({
            "GLOBAL": {
                "all": ["DeadNode", "LiveNode"],
                "now": "DIRECT"
            },
            "DeadNode": {
                "type": "Shadowsocks",
                "alive": false
            },
            "LiveNode": {
                "type": "Shadowsocks",
                "alive": true
            }
        });
        let proxies = json.as_object().unwrap();
        assert_eq!(
            select_global_candidate(proxies),
            Some(("LiveNode".to_owned(), Some("DIRECT".to_owned())))
        );
    }

    #[test]
    fn test_select_global_candidate_deep_acyclic_chain() {
        let mut map = serde_json::Map::new();
        // Create a chain of 10 nested Selectors: S0 -> S1 -> ... -> S9 -> Leaf (> 8 links)
        for i in 0..10 {
            let next = if i == 9 {
                "RealLeaf".to_owned()
            } else {
                format!("S{}", i + 1)
            };
            map.insert(
                format!("S{i}"),
                serde_json::json!({
                    "type": "Selector",
                    "now": next,
                    "all": [next]
                }),
            );
        }
        map.insert(
            "RealLeaf".to_owned(),
            serde_json::json!({
                "type": "Shadowsocks",
                "alive": true
            }),
        );
        map.insert(
            "GLOBAL".to_owned(),
            serde_json::json!({
                "type": "Selector",
                "now": "S0",
                "all": ["S0"]
            }),
        );

        assert_eq!(
            select_global_candidate(&map)
                .as_ref()
                .map(|(c, _)| c.as_str()),
            Some("S0")
        );
    }

    #[test]
    fn test_classify_sub_error() {
        use crate::event::codes::*;
        assert_eq!(
            classify_sub_error("SSRF protection: Direct download blocked".to_owned()),
            SUB_SSRF_BLOCKED
        );
        assert_eq!(
            classify_sub_error("Invalid URL: Only HTTP and HTTPS URLs are allowed".to_owned()),
            SUB_URL_INVALID
        );
        assert_eq!(
            classify_sub_error(
                "Direct DNS: DNS resolution failed; Proxy: HTTP 404 Not Found".to_owned()
            ),
            SUB_HTTP_ERROR
        );
        assert_eq!(
            classify_sub_error(
                "Direct DNS: DNS resolution failed; Proxy: Connection failed".to_owned()
            ),
            SUB_DNS_FAILED
        );
        assert_eq!(
            classify_sub_error("Subscription name cannot be empty".to_owned()),
            SUB_NAME_INVALID
        );
        assert_eq!(
            classify_sub_error("Request timed out".to_owned()),
            SUB_UPDATE_TIMEOUT
        );
        assert_eq!(
            classify_sub_error("DNS resolution returned no addresses for host".to_owned()),
            SUB_DNS_FAILED
        );
        assert_eq!(
            classify_sub_error("DNS deadline elapsed while resolving host".to_owned()),
            SUB_DNS_FAILED
        );
        assert_eq!(
            classify_sub_error("Direct DNS: DNS resolution timed out for 'x' (1.5s)".to_owned()),
            SUB_DNS_FAILED
        );
        assert_eq!(
            classify_sub_error("DNS resolution timeout for host".to_owned()),
            SUB_DNS_FAILED
        );
        assert_eq!(
            classify_sub_error("Proxy SSRF blocked: [SSRF_BLOCKED] private IP".to_owned()),
            SUB_SSRF_BLOCKED
        );
    }
}
