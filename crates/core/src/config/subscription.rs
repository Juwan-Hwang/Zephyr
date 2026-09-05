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
    let host_lower = host.to_lowercase();

    if host_lower == "localhost"
        || host_lower.ends_with(".localhost")
        || host_lower.ends_with(".local")
        || host_lower.ends_with(".internal")
        || host_lower.ends_with(".lan")
        || host_lower.ends_with(".home.arpa")
    {
        return true;
    }

    let unbracketed = host
        .strip_prefix('[')
        .and_then(|h| h.strip_suffix(']'))
        .unwrap_or(host);

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

    for addr in addrs {
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
        return Err(PublicHostAddrError::NoAddresses(
            "Could not resolve any IP address for the host".to_owned(),
        ));
    }

    Ok((host.to_owned(), resolved_addr, false))
}

/// Validate URL scheme, host, and port without DNS resolution.
/// Returns `(host, port, user_entered_private)`.
pub fn validate_subscription_url_basic(url: &str) -> Result<(String, u16, bool), String> {
    let parsed_url = url::Url::parse(url).map_err(|e| format!("Invalid URL: {e}"))?;

    let scheme = parsed_url.scheme();
    if scheme != "http" && scheme != "https" {
        return Err("Only HTTP and HTTPS URLs are allowed".to_owned());
    }

    let host = parsed_url.host_str().ok_or("URL must have a host")?;

    let user_entered_private = is_private_host(host);

    let default_port = if scheme == "https" { 443 } else { 80 };
    let port = parsed_url.port().unwrap_or(default_port);

    Ok((host.to_owned(), port, user_entered_private))
}

/// Validate an ambient environment or system proxy URL.
/// Security: Only permit local loopback proxies (`127.0.0.1` / `localhost` / `::1`)
/// and reject cleartext credentialed `http://` proxies to prevent SSRF and credential leaks.
/// Also supports semicolon/whitespace-separated entries and scheme-prefixed entries
/// commonly found in Windows/macOS/Linux system proxy configurations (e.g. `http=127.0.0.1:7890;https=...`).
#[must_use]
pub fn validate_ambient_proxy_url(raw: &str) -> Option<String> {
    validate_ambient_proxy_url_for_scheme(raw, None)
}

struct AmbientCandidate {
    tag: Option<String>,
    url: String,
}

fn parse_assignment_tag(s: &str) -> Option<(&str, &str)> {
    let (raw_prefix, rest) = s.split_once('=')?;
    let prefix = raw_prefix.trim();
    (!prefix.is_empty() && prefix.chars().all(|c| c.is_ascii_alphanumeric()))
        .then(|| (prefix, rest.trim()))
}

fn map_protocol_tag(prefix: &str) -> Option<(Option<String>, &'static str)> {
    let p_lower = prefix.to_ascii_lowercase();
    match p_lower.as_str() {
        "socks" | "socks5" => Some((Some("socks".to_owned()), "socks5")),
        "socks5h" => Some((Some("socks".to_owned()), "socks5h")),
        "socks4" => Some((Some("socks".to_owned()), "socks4")),
        "socks4a" => Some((Some("socks".to_owned()), "socks4a")),
        "https" => Some((Some("https".to_owned()), "http")),
        "http" => Some((Some("http".to_owned()), "http")),
        "all" => Some((Some("all".to_owned()), "http")),
        _ => None,
    }
}

fn parse_ambient_proxy_segment(segment: &str) -> Option<AmbientCandidate> {
    let mut seg = segment.trim();
    if seg.is_empty() {
        return None;
    }

    // Strip extraneous "http://" or "https://" prefix if followed by a recognized scheme assignment
    // (e.g. "http://http=127.0.0.1:7890"), while preserving valid authenticated URLs
    // (e.g. "https://user:p=ss@127.0.0.1:8443").
    if let Some(rest) = seg
        .strip_prefix("http://")
        .or_else(|| seg.strip_prefix("https://"))
    {
        if let Some((prefix, _)) = parse_assignment_tag(rest) {
            if map_protocol_tag(prefix).is_some() {
                seg = rest;
            }
        }
    }

    // Handle leading scheme assignment prefixes like "http=host:port", "socks=...", "all=..."
    let (tag, default_scheme, inner) = if let Some((prefix, remainder)) = parse_assignment_tag(seg)
    {
        if let Some((mapped_tag, default_scheme)) = map_protocol_tag(prefix) {
            (mapped_tag, default_scheme, remainder)
        } else {
            // Explicit protocol key that is unsupported for HTTP/SOCKS proxies (e.g. "ftp=")
            return None;
        }
    } else {
        (None, "http", seg)
    };

    let candidate = if let Some(rest) = inner.strip_prefix("socks://") {
        format!("socks5://{rest}")
    } else if inner.contains("://") {
        inner.to_owned()
    } else {
        format!("{default_scheme}://{inner}")
    };

    let parsed = url::Url::parse(&candidate).ok()?;
    if !matches!(
        parsed.scheme(),
        "http" | "https" | "socks4" | "socks4a" | "socks5" | "socks5h"
    ) {
        return None;
    }
    let is_loopback = parsed.host_str().is_some_and(|h| {
        if h.eq_ignore_ascii_case("localhost") {
            return true;
        }
        let unbracketed = h.trim_start_matches('[').trim_end_matches(']');
        if let Ok(ip) = unbracketed.parse::<std::net::IpAddr>() {
            ip.is_loopback()
        } else {
            false
        }
    });
    if !is_loopback {
        return None;
    }
    if parsed.port() == Some(0) {
        return None;
    }
    let has_credentials = !parsed.username().is_empty() || parsed.password().is_some();
    if has_credentials && parsed.scheme() == "http" {
        return None;
    }

    Some(AmbientCandidate {
        tag,
        url: candidate,
    })
}

/// Split ambient/system proxy configuration into candidate segments.
/// Standalone URLs with semicolons in credentials (e.g. `user:p;ss@127.0.0.1:8443`) are
/// preserved without incorrect splitting.
fn split_ambient_proxy_segments(raw: &str) -> Vec<&str> {
    let mut segments = Vec::new();
    let mut start = 0;

    for (i, &b) in raw.as_bytes().iter().enumerate() {
        if b == b'\n' || b == b'\r' {
            if let Some(raw_part) = raw.get(start..i) {
                let part = raw_part.trim();
                if !part.is_empty() {
                    segments.push(part);
                }
            }
            start = i.saturating_add(1);
        } else if b == b';' || b == b' ' {
            let remainder = raw.get(i.saturating_add(1)..).unwrap_or("").trim_start();
            let has_scheme_or_tag = [
                "http", "https", "socks", "socks4", "socks4a", "socks5", "socks5h",
            ]
            .iter()
            .any(|tag| {
                remainder
                    .strip_prefix(tag)
                    .is_some_and(|rest| rest.starts_with('=') || rest.starts_with("://"))
            });
            let has_host_prefix = remainder.starts_with("localhost:")
                || remainder
                    .chars()
                    .next()
                    .is_some_and(|c| c.is_ascii_digit() || c == '[');

            let is_separator = if b == b' ' {
                !remainder.is_empty() && (has_scheme_or_tag || has_host_prefix)
            } else {
                let delims = [
                    remainder.find(';'),
                    remainder.find(' '),
                    remainder.find('\n'),
                    remainder.find('\r'),
                ];
                let next_delim = delims
                    .into_iter()
                    .flatten()
                    .min()
                    .unwrap_or(remainder.len());
                let segment_ahead = remainder.get(..next_delim).unwrap_or(remainder);
                let in_userinfo = segment_ahead.contains('@') && !segment_ahead.contains("://");
                !in_userinfo && (has_scheme_or_tag || has_host_prefix)
            };

            if is_separator {
                if let Some(raw_part) = raw.get(start..i) {
                    let part = raw_part.trim();
                    if !part.is_empty() {
                        segments.push(part);
                    }
                }
                start = i.saturating_add(1);
            }
        }
    }

    if let Some(raw_tail) = raw.get(start..) {
        let tail = raw_tail.trim();
        if !tail.is_empty() {
            segments.push(tail);
        }
    }

    segments
}

/// Validate an ambient environment or system proxy configuration, returning all valid loopback proxy candidates
/// ordered by priority for the specified destination scheme.
#[must_use]
pub fn collect_ambient_proxy_urls_for_scheme(
    raw: &str,
    target_scheme: Option<&str>,
) -> Vec<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }

    let segments = split_ambient_proxy_segments(trimmed);
    let candidates: Vec<AmbientCandidate> = if segments.len() <= 1 {
        parse_ambient_proxy_segment(trimmed)
            .or_else(|| {
                segments
                    .first()
                    .copied()
                    .and_then(parse_ambient_proxy_segment)
            })
            .into_iter()
            .collect()
    } else {
        segments
            .into_iter()
            .filter_map(parse_ambient_proxy_segment)
            .collect()
    };

    if candidates.is_empty() {
        return Vec::new();
    }

    let mut result = Vec::new();
    let mut seen = std::collections::HashSet::new();

    let mut push_dedup = |u: &str| {
        if seen.insert(u.to_owned()) {
            result.push(u.to_owned());
        }
    };

    if let Some(target) = target_scheme {
        let t_lower = target.to_ascii_lowercase();
        // 1. Direct scheme match (e.g. tag == "https" when requesting HTTPS)
        for c in candidates
            .iter()
            .filter(|c| c.tag.as_deref() == Some(&t_lower))
        {
            push_dedup(&c.url);
        }
        // 2. "all" match
        for c in candidates
            .iter()
            .filter(|c| c.tag.as_deref() == Some("all"))
        {
            push_dedup(&c.url);
        }
        // 3. "socks" match
        for c in candidates
            .iter()
            .filter(|c| c.tag.as_deref() == Some("socks"))
        {
            push_dedup(&c.url);
        }
        // 4. Unprefixed candidate
        for c in candidates.iter().filter(|c| c.tag.is_none()) {
            push_dedup(&c.url);
        }
    }

    // 5. Any remaining candidates in discovery order
    for c in &candidates {
        push_dedup(&c.url);
    }

    result
}

/// Validate an ambient environment or system proxy URL, selecting candidate matching an optional destination scheme.
#[must_use]
pub fn validate_ambient_proxy_url_for_scheme(
    raw: &str,
    target_scheme: Option<&str>,
) -> Option<String> {
    collect_ambient_proxy_urls_for_scheme(raw, target_scheme)
        .into_iter()
        .next()
}

fn matches_cidr(host_ip: IpAddr, pat: &str) -> bool {
    let Some((ip_str, prefix_str)) = pat.split_once('/') else {
        return false;
    };
    let Ok(prefix_len) = prefix_str.trim().parse::<u32>() else {
        return false;
    };
    match (
        host_ip,
        ip_str
            .trim()
            .trim_matches('[')
            .trim_matches(']')
            .parse::<IpAddr>(),
    ) {
        (IpAddr::V4(target), Ok(IpAddr::V4(net))) => {
            if prefix_len > 32 {
                return false;
            }
            let mask = !((!0u32).checked_shr(prefix_len).unwrap_or(0));
            (u32::from(target) & mask) == (u32::from(net) & mask)
        }
        (IpAddr::V6(target), Ok(IpAddr::V6(net))) => {
            if prefix_len > 128 {
                return false;
            }
            let mask = !((!0u128).checked_shr(prefix_len).unwrap_or(0));
            (u128::from(target) & mask) == (u128::from(net) & mask)
        }
        _ => false,
    }
}

/// Check if a host and optional port match a `NO_PROXY` rule list.
#[must_use]
pub fn matches_no_proxy_rules_with_port(host: &str, port: Option<u16>, no_proxy_val: &str) -> bool {
    if no_proxy_val.is_empty() {
        return false;
    }
    let trimmed_host = host.trim().trim_matches('[').trim_matches(']');
    if trimmed_host.is_empty() {
        return false;
    }
    let host_ip = trimmed_host.parse::<IpAddr>().ok();
    for raw_pat in no_proxy_val.split(|c: char| c == ',' || c.is_ascii_whitespace()) {
        let pat = raw_pat.trim();
        if pat.is_empty() {
            continue;
        }

        if let Some(ip) = host_ip {
            if pat.contains('/') && matches_cidr(ip, pat) {
                return true;
            }
        }

        let (pat_host, pat_port) = if pat.parse::<std::net::Ipv6Addr>().is_ok() {
            (pat, None)
        } else if let Some((h, p)) = pat.rsplit_once(':') {
            if let Ok(parsed_port) = p.parse::<u16>() {
                (h.trim_matches('[').trim_matches(']'), Some(parsed_port))
            } else {
                (pat.trim_matches('[').trim_matches(']'), None)
            }
        } else {
            (pat.trim_matches('[').trim_matches(']'), None)
        };

        if pat_host.is_empty() {
            continue;
        }

        if let Some(rule_port) = pat_port {
            if port != Some(rule_port) {
                continue;
            }
        }

        if pat_host == "*" {
            return true;
        }
        if trimmed_host.eq_ignore_ascii_case(pat_host) {
            return true;
        }
        let domain_suffix = pat_host
            .strip_prefix("*.")
            .or_else(|| pat_host.strip_prefix('.'))
            .unwrap_or(pat_host);
        if trimmed_host.len() > domain_suffix.len()
            && trimmed_host
                .to_ascii_lowercase()
                .ends_with(&domain_suffix.to_ascii_lowercase())
            && trimmed_host
                .as_bytes()
                .get(trimmed_host.len() - domain_suffix.len() - 1)
                == Some(&b'.')
        {
            return true;
        }
    }
    false
}

/// Check if a host matches a `NO_PROXY` rule list.
#[must_use]
pub fn matches_no_proxy_rules(host: &str, no_proxy_val: &str) -> bool {
    matches_no_proxy_rules_with_port(host, None, no_proxy_val)
}

/// Check if a host and optional port match the current process environment `NO_PROXY` / `no_proxy` setting.
#[must_use]
pub fn is_destination_in_no_proxy(host: &str, port: Option<u16>) -> bool {
    if let Ok(val_upper) = std::env::var("NO_PROXY") {
        if matches_no_proxy_rules_with_port(host, port, &val_upper) {
            return true;
        }
    }
    if let Ok(val_lower) = std::env::var("no_proxy") {
        if matches_no_proxy_rules_with_port(host, port, &val_lower) {
            return true;
        }
    }
    false
}

/// Check if a host matches the current process environment `NO_PROXY` / `no_proxy` setting.
#[must_use]
pub fn is_host_in_no_proxy(host: &str) -> bool {
    is_destination_in_no_proxy(host, None)
}

/// Validate URL and its resolved IPs for SSRF protection.
/// Returns `(host, resolved_addr, user_entered_private)`.
pub fn validate_subscription_url_with_ip(
    url: &str,
) -> Result<(String, Option<std::net::SocketAddr>, bool), String> {
    let (host, port, user_entered_private) = validate_subscription_url_basic(url)?;

    if user_entered_private {
        return Ok((host, None, true));
    }

    let addrs: Vec<std::net::SocketAddr> =
        std::net::ToSocketAddrs::to_socket_addrs(&format!("{host}:{port}"))
            .map_err(|e| format!("DNS resolution failed for '{host}': {e}"))?
            .collect();

    validate_public_host_addrs(&host, &addrs).map_err(|e| e.to_string())
}

/// Determine the appropriate error code based on the error message content.
///
/// Migrated from `src-tauri/src/core/subscription.rs`.
#[cfg_attr(feature = "uniffi", uniffi::export)]
#[must_use]
pub fn classify_sub_error(e: String) -> u16 {
    if e.contains("SSRF protection") {
        crate::event::codes::SUB_SSRF_BLOCKED
    } else if e.contains("DNS resolution failed") || e.contains("Could not resolve") {
        crate::event::codes::SUB_DNS_FAILED
    } else if e.contains("Invalid URL")
        || e.contains("Only HTTP")
        || e.contains("must have a host")
        || e.contains("URL must not be empty")
    {
        crate::event::codes::SUB_URL_INVALID
    } else if e.contains("Subscription name")
        || e.contains("Path traversal detected")
        || e.contains("Invalid character in filename")
        || e.contains("Filename too long")
        || e.contains("Reserved filename")
        || e.contains("Invalid file type")
    {
        crate::event::codes::SUB_NAME_INVALID
    } else if e.contains("HTTP ") {
        crate::event::codes::SUB_HTTP_ERROR
    } else if e.contains("timeout") || e.contains("Timeout") {
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

    let is_special_target = |s: &str| {
        matches!(
            s,
            "DIRECT" | "REJECT" | "REJECT-DROP" | "PASS" | "PASS-RULE" | "COMPATIBLE"
        )
    };

    let global_all: Vec<&str> = global_obj
        .and_then(|g| g.get("all"))
        .and_then(|a| a.as_array())
        .map(|arr| arr.iter().filter_map(|v| v.as_str()).collect())
        .unwrap_or_default();

    // 递归解析候选节点/策略组，确保最终生效的叶子节点存在于 proxies 中且不是 DIRECT / REJECT 等特殊目标。
    // 递归深度限制为 8 层以防止配置中存在循环依赖。
    let resolves_to_effective_proxy = |start_name: &str| -> bool {
        let mut curr = start_name;
        for _ in 0..8 {
            if is_special_target(curr) {
                return false;
            }
            if let Some(p_obj) = proxies.get(curr) {
                let p_type = p_obj.get("type").and_then(|t| t.as_str()).unwrap_or("");
                if p_type.eq_ignore_ascii_case("Selector")
                    || p_type.eq_ignore_ascii_case("URLTest")
                    || p_type.eq_ignore_ascii_case("Fallback")
                {
                    if let Some(next_now) = p_obj.get("now").and_then(|n| n.as_str()) {
                        curr = next_now;
                        continue;
                    }
                    return false;
                }
                return true;
            }
            return false;
        }
        false
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
        assert!(is_private_host("127.0.0.1"));
        assert!(is_private_host("10.0.0.1"));
        assert!(is_private_host("192.168.1.1"));
        assert!(is_private_host("172.16.0.1"));
        assert!(is_private_host("::1"));
        assert!(is_private_host("[::1]"));
        assert!(is_private_host("[fd00::1]"));
        assert!(is_private_host("[fe80::1]"));
        assert!(!is_private_host("my.test"));
        assert!(!is_private_host("example.com"));
        assert!(!is_private_host("1.1.1.1"));
        assert!(!is_private_host("8.8.8.8"));
        assert!(!is_private_host("[2606:4700:4700::1111]"));
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
    }

    #[test]
    fn test_validate_invalid_schemes_rejected() {
        assert!(validate_subscription_url_with_ip("ftp://192.168.1.1/sub").is_err());
        assert!(validate_subscription_url_with_ip("file:///etc/passwd").is_err());
        assert!(validate_subscription_url_basic("ftp://192.168.1.1/sub").is_err());
        assert!(validate_subscription_url_basic("file:///etc/passwd").is_err());
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
    fn test_validate_ambient_proxy_url() {
        // Valid loopback proxies
        assert_eq!(
            validate_ambient_proxy_url("http://127.0.0.1:7890"),
            Some("http://127.0.0.1:7890".to_owned())
        );
        assert_eq!(
            validate_ambient_proxy_url("127.0.0.1:7890"),
            Some("http://127.0.0.1:7890".to_owned())
        );
        assert_eq!(
            validate_ambient_proxy_url("http://localhost:7890"),
            Some("http://localhost:7890".to_owned())
        );
        assert_eq!(
            validate_ambient_proxy_url("http://[::1]:7890"),
            Some("http://[::1]:7890".to_owned())
        );
        assert_eq!(
            validate_ambient_proxy_url("socks5://127.0.0.1:1080"),
            Some("socks5://127.0.0.1:1080".to_owned())
        );
        assert_eq!(
            validate_ambient_proxy_url("socks5://user:pass@127.0.0.1:1080"),
            Some("socks5://user:pass@127.0.0.1:1080".to_owned())
        );

        // Multi-scheme and semicolon-separated (common Windows/GNOME proxy formats)
        assert_eq!(
            validate_ambient_proxy_url("http=127.0.0.1:7890;https=127.0.0.1:7890"),
            Some("http://127.0.0.1:7890".to_owned())
        );
        assert_eq!(
            validate_ambient_proxy_url("http=proxy.corp.com:8080;socks=127.0.0.1:1080"),
            Some("socks5://127.0.0.1:1080".to_owned())
        );
        assert_eq!(
            validate_ambient_proxy_url("socks=127.0.0.1:1080"),
            Some("socks5://127.0.0.1:1080".to_owned())
        );
        assert_eq!(
            validate_ambient_proxy_url("http://http=127.0.0.1:7890"),
            Some("http://127.0.0.1:7890".to_owned())
        );

        // Disallowed: Non-loopback IP or external host
        assert_eq!(validate_ambient_proxy_url("http://192.168.1.1:7890"), None);
        assert_eq!(validate_ambient_proxy_url("http://10.0.0.1:7890"), None);
        assert_eq!(
            validate_ambient_proxy_url("http://proxy.example.com:7890"),
            None
        );

        // Disallowed: Cleartext credentials over http://
        assert_eq!(
            validate_ambient_proxy_url("http://user:pass@127.0.0.1:7890"),
            None
        );
        assert_eq!(
            validate_ambient_proxy_url("http://user@localhost:7890"),
            None
        );

        // Disallowed: Unsupported schemes (e.g. ftp://)
        assert_eq!(validate_ambient_proxy_url("ftp://127.0.0.1:21"), None);
        assert_eq!(
            validate_ambient_proxy_url("ftp://127.0.0.1:21;http://127.0.0.1:7890"),
            Some("http://127.0.0.1:7890".to_owned())
        );

        // Disallowed: Empty / whitespace
        assert_eq!(validate_ambient_proxy_url(""), None);
        assert_eq!(validate_ambient_proxy_url("   "), None);

        // Scheme-specific ambient proxy selection (e.g. Windows protocol-specific ProxyServer)
        let multi_proxy = "http=127.0.0.1:8080;https=127.0.0.1:8443;socks=127.0.0.1:1080";
        assert_eq!(
            validate_ambient_proxy_url_for_scheme(multi_proxy, Some("https")),
            Some("http://127.0.0.1:8443".to_owned())
        );
        assert_eq!(
            validate_ambient_proxy_url_for_scheme(multi_proxy, Some("http")),
            Some("http://127.0.0.1:8080".to_owned())
        );
        assert_eq!(
            validate_ambient_proxy_url_for_scheme(multi_proxy, None),
            Some("http://127.0.0.1:8080".to_owned())
        );

        // Fallback to socks when scheme-specific entry is absent
        let socks_fallback = "ftp=127.0.0.1:21;socks=127.0.0.1:1080";
        assert_eq!(
            validate_ambient_proxy_url_for_scheme(socks_fallback, Some("https")),
            Some("socks5://127.0.0.1:1080".to_owned())
        );
    }

    #[test]
    fn test_validate_ambient_proxy_url_ipv6_loopback() {
        let ipv6_proxy = "http=[::1]:7890;https=[::1]:7890";
        assert_eq!(
            validate_ambient_proxy_url_for_scheme(ipv6_proxy, Some("http")),
            Some("http://[::1]:7890".to_owned())
        );
        assert_eq!(
            validate_ambient_proxy_url_for_scheme(ipv6_proxy, Some("https")),
            Some("http://[::1]:7890".to_owned())
        );
        // Test full 127.0.0.0/8 loopback range and localhost
        assert_eq!(
            validate_ambient_proxy_url("http://127.0.0.2:7890"),
            Some("http://127.0.0.2:7890".to_owned())
        );
        assert_eq!(
            validate_ambient_proxy_url("http://localhost:7890"),
            Some("http://localhost:7890".to_owned())
        );
    }

    #[test]
    fn test_validate_ambient_proxy_url_socks_schemes() {
        // SOCKS prefix variants (socks4, socks4a, socks5, socks5h)
        assert_eq!(
            validate_ambient_proxy_url_for_scheme("socks4=127.0.0.1:1080", None),
            Some("socks4://127.0.0.1:1080".to_owned())
        );
        assert_eq!(
            validate_ambient_proxy_url_for_scheme("socks4a=127.0.0.1:1081", None),
            Some("socks4a://127.0.0.1:1081".to_owned())
        );
        assert_eq!(
            validate_ambient_proxy_url_for_scheme("socks5=127.0.0.1:1082", None),
            Some("socks5://127.0.0.1:1082".to_owned())
        );
        assert_eq!(
            validate_ambient_proxy_url_for_scheme("socks5h=127.0.0.1:1083", None),
            Some("socks5h://127.0.0.1:1083".to_owned())
        );
        // Bare socks:// normalized to socks5://
        assert_eq!(
            validate_ambient_proxy_url_for_scheme("socks=socks://127.0.0.1:1080", None),
            Some("socks5://127.0.0.1:1080".to_owned())
        );
        assert_eq!(
            validate_ambient_proxy_url_for_scheme("socks://127.0.0.1:1080", None),
            Some("socks5://127.0.0.1:1080".to_owned())
        );
    }

    #[test]
    fn test_validate_ambient_proxy_url_unknown_prefixes_rejected() {
        assert_eq!(
            validate_ambient_proxy_url_for_scheme("ftp=127.0.0.1:21", None),
            None
        );
        assert_eq!(
            validate_ambient_proxy_url_for_scheme("unknown=127.0.0.1:8080", Some("http")),
            None
        );
        assert_eq!(
            validate_ambient_proxy_url_for_scheme("ftp=127.0.0.1:21;http=127.0.0.1:8080", None),
            Some("http://127.0.0.1:8080".to_owned())
        );
    }

    #[test]
    fn test_validate_ambient_proxy_url_query_param_preserved() {
        assert_eq!(
            validate_ambient_proxy_url("http://127.0.0.1:7890/p?token=abc"),
            Some("http://127.0.0.1:7890/p?token=abc".to_owned())
        );
    }

    #[test]
    fn test_validate_ambient_proxy_url_zero_port_rejected() {
        assert_eq!(validate_ambient_proxy_url("http://127.0.0.1:0"), None);
        assert_eq!(validate_ambient_proxy_url("socks5://127.0.0.1:0"), None);
    }

    #[test]
    fn test_validate_ambient_proxy_url_credentials_with_equals() {
        assert_eq!(
            validate_ambient_proxy_url("socks5://user:p=ss@127.0.0.1:1080"),
            Some("socks5://user:p=ss@127.0.0.1:1080".to_owned())
        );
        assert_eq!(
            validate_ambient_proxy_url("socks5://user:p=ss=word@127.0.0.1:1080"),
            Some("socks5://user:p=ss=word@127.0.0.1:1080".to_owned())
        );
        assert_eq!(
            validate_ambient_proxy_url("https://user:p=ss@127.0.0.1:8443"),
            Some("https://user:p=ss@127.0.0.1:8443".to_owned())
        );
        assert_eq!(
            validate_ambient_proxy_url("socks=socks5://user:p=ss@127.0.0.1:1080"),
            Some("socks5://user:p=ss@127.0.0.1:1080".to_owned())
        );
    }

    #[test]
    fn test_collect_ambient_proxy_urls_for_scheme_multiple_candidates() {
        let multi_proxy = "http=127.0.0.1:8080;https=127.0.0.1:8443;socks=127.0.0.1:1080";
        let candidates = collect_ambient_proxy_urls_for_scheme(multi_proxy, Some("https"));
        assert_eq!(
            candidates,
            vec![
                "http://127.0.0.1:8443".to_owned(),
                "socks5://127.0.0.1:1080".to_owned(),
                "http://127.0.0.1:8080".to_owned(),
            ]
        );
    }

    #[test]
    fn test_collect_ambient_proxy_urls_credentials_with_semicolon() {
        let proxy_with_semicolon = "https://user:p;ss@127.0.0.1:8443";
        let candidates = collect_ambient_proxy_urls_for_scheme(proxy_with_semicolon, Some("https"));
        assert_eq!(
            candidates,
            vec!["https://user:p;ss@127.0.0.1:8443".to_owned()]
        );

        let multi = "https=https://user:p;ss@127.0.0.1:7890;http=127.0.0.1:8443";
        let candidates_multi = collect_ambient_proxy_urls_for_scheme(multi, Some("https"));
        assert_eq!(
            candidates_multi,
            vec![
                "https://user:p;ss@127.0.0.1:7890".to_owned(),
                "http://127.0.0.1:8443".to_owned()
            ]
        );
    }

    #[test]
    fn test_collect_ambient_proxy_urls_with_path_in_multi_entry() {
        let multi = "http=http://127.0.0.1:7890/sub_proxy;https=127.0.0.1:8443";
        let candidates = collect_ambient_proxy_urls_for_scheme(multi, Some("http"));
        assert_eq!(
            candidates,
            vec![
                "http://127.0.0.1:7890/sub_proxy".to_owned(),
                "http://127.0.0.1:8443".to_owned()
            ]
        );
    }

    #[test]
    fn test_public_host_with_public_ip_allowed() {
        let addrs: Vec<std::net::SocketAddr> = vec!["1.2.3.4:80".parse().unwrap()];
        let result = validate_public_host_addrs("example.com", &addrs);
        assert!(result.is_ok());
    }

    #[test]
    fn test_public_host_resolving_to_private_ip_rejected() {
        let addrs: Vec<std::net::SocketAddr> = vec!["192.168.1.1:80".parse().unwrap()];
        let result = validate_public_host_addrs("attacker.com", &addrs);
        assert!(result.is_err());
        assert!(matches!(
            result.unwrap_err(),
            PublicHostAddrError::SsrfBlocked(_)
        ));
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
    fn test_split_ambient_proxy_segments_with_socks5h() {
        let raw = "127.0.0.1:7890 socks5h://127.0.0.1:1080 socks4a://127.0.0.1:1081";
        let segments = split_ambient_proxy_segments(raw);
        assert_eq!(
            segments,
            vec![
                "127.0.0.1:7890",
                "socks5h://127.0.0.1:1080",
                "socks4a://127.0.0.1:1081"
            ]
        );
    }

    #[test]
    fn test_split_ambient_proxy_segments_with_semicolon_in_query() {
        let raw = "http://127.0.0.1:7890/?token=a;b;http=http://127.0.0.1:7891";
        let segments = split_ambient_proxy_segments(raw);
        assert_eq!(
            segments,
            vec![
                "http://127.0.0.1:7890/?token=a;b",
                "http=http://127.0.0.1:7891"
            ]
        );
    }

    #[test]
    fn test_matches_no_proxy_rules() {
        assert!(matches_no_proxy_rules("example.com", "example.com"));
        assert!(matches_no_proxy_rules("sub.example.com", "example.com"));
        assert!(matches_no_proxy_rules("sub.example.com", ".example.com"));
        assert!(matches_no_proxy_rules("any.domain.com", "*"));
        assert!(matches_no_proxy_rules("127.0.0.1", "127.0.0.1,localhost"));
        assert!(matches_no_proxy_rules("localhost", "127.0.0.1,localhost"));
        assert!(!matches_no_proxy_rules(
            "other.com",
            "example.com,localhost"
        ));
        assert!(!matches_no_proxy_rules("notexample.com", "example.com"));

        // Whitespace separation and port-qualified rules
        assert!(matches_no_proxy_rules_with_port(
            "example.com",
            Some(443),
            "example.com:443 other.com:80"
        ));
        assert!(!matches_no_proxy_rules_with_port(
            "example.com",
            Some(80),
            "example.com:443 other.com:80"
        ));
        assert!(matches_no_proxy_rules_with_port(
            "sub.example.com",
            Some(443),
            "example.com:443"
        ));
        assert!(matches_no_proxy_rules_with_port(
            "127.0.0.1",
            Some(8080),
            "127.0.0.1:8080 [::1]:8080"
        ));
        assert!(matches_no_proxy_rules_with_port(
            "::1",
            Some(8080),
            "127.0.0.1:8080 [::1]:8080"
        ));

        // Wildcard rules
        assert!(matches_no_proxy_rules("sub.example.com", "*.example.com"));
        assert!(matches_no_proxy_rules(
            "deep.sub.example.com",
            "*.example.com"
        ));
        assert!(!matches_no_proxy_rules("notexample.com", "*.example.com"));

        // CIDR subnet rules
        assert!(matches_no_proxy_rules("100.64.0.1", "100.64.0.0/10"));
        assert!(matches_no_proxy_rules("100.127.255.254", "100.64.0.0/10"));
        assert!(!matches_no_proxy_rules("100.128.0.1", "100.64.0.0/10"));
        assert!(!matches_no_proxy_rules("192.168.1.1", "100.64.0.0/10"));
        assert!(matches_no_proxy_rules("192.168.1.50", "192.168.0.0/16"));
        assert!(matches_no_proxy_rules("2001:db8::1", "2001:db8::/32"));
        assert!(!matches_no_proxy_rules("2001:db9::1", "2001:db8::/32"));
    }
}
