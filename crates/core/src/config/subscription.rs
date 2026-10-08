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
    FakeIpRanges::default().contains(ip)
}

/// Synthetic fake-IP address ranges in effect for the active core configuration.
///
/// Defaults to the built-in Mihomo ranges (`dns.fake-ip-range` /
/// `dns.fake-ip-range6` defaults). When the active profile configures custom
/// ranges, [`FakeIpRanges::from_config_yaml`] loads them so classification stays
/// in sync with the core: a synthetic address that the classifier does not
/// recognize would otherwise be pinned and dialed as if it were a verified
/// public destination.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FakeIpRanges {
    /// `(network bits, prefix length)` pairs.
    v4: Vec<(u32, u8)>,
    /// `(network bits, prefix length)` pairs.
    v6: Vec<(u128, u8)>,
}

impl Default for FakeIpRanges {
    fn default() -> Self {
        Self {
            // 198.18.0.0/15
            v4: vec![(0xc612_0000, 15)],
            // fdfe:dcba:9876::/64
            v6: vec![(0xfdfe_dcba_9876_0000_0000_0000_0000_0000, 64)],
        }
    }
}

impl FakeIpRanges {
    /// Parse the configured ranges from a `run_config.yaml` body.
    ///
    /// Absent, empty, or invalid values fall back to the built-in defaults,
    /// matching Mihomo's own behavior.
    #[must_use]
    pub fn from_config_yaml(content: &str) -> Self {
        let Ok(value) = serde_yaml::from_str::<serde_yaml::Value>(content) else {
            return Self::default();
        };
        let dns = value.get("dns");
        let v4 = dns
            .and_then(|d| d.get("fake-ip-range"))
            .and_then(serde_yaml::Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .and_then(parse_v4_cidr)
            .map(|net| vec![net])
            .unwrap_or_else(|| Self::default().v4);
        let v6 = dns
            .and_then(|d| d.get("fake-ip-range6"))
            .and_then(serde_yaml::Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .and_then(parse_v6_cidr)
            .map(|net| vec![net])
            .unwrap_or_else(|| Self::default().v6);
        Self { v4, v6 }
    }

    /// Whether `host` is an IP literal inside a configured fake-IP range.
    ///
    /// Such a literal is not a destination: it is a synthetic address the core
    /// handed out for some other name. `is_literal_private_host` cannot tell it
    /// from a real private address (the default range is 198.18.0.0/15), so
    /// every caller that exempts private literals must reject these first.
    /// IPv6 literals may keep their URL brackets (`[fdfe:dcba:9876::1]`).
    #[must_use]
    pub fn contains_host_literal(&self, host: &str) -> bool {
        let unbracketed = host
            .strip_prefix('[')
            .and_then(|h| h.strip_suffix(']'))
            .unwrap_or(host);
        unbracketed
            .parse::<IpAddr>()
            .is_ok_and(|ip| self.contains(ip))
    }

    /// Whether `ip` falls inside any configured fake-IP range.
    #[must_use]
    pub fn contains(&self, ip: IpAddr) -> bool {
        match ip {
            IpAddr::V4(ipv4) => {
                let bits = u32::from(ipv4);
                self.v4
                    .iter()
                    .any(|(net, prefix)| v4_in_cidr(bits, *net, *prefix))
            }
            IpAddr::V6(ipv6) => {
                let bits = u128::from(ipv6);
                if self
                    .v6
                    .iter()
                    .any(|(net, prefix)| v6_in_cidr(bits, *net, *prefix))
                {
                    return true;
                }
                // IPv4-mapped IPv6 addresses (::ffff:a.b.c.d) are fake IPs when
                // the mapped address is.
                ipv6.to_ipv4_mapped().is_some_and(|mapped| {
                    let bits = u32::from(mapped);
                    self.v4
                        .iter()
                        .any(|(net, prefix)| v4_in_cidr(bits, *net, *prefix))
                })
            }
        }
    }
}

fn parse_v4_cidr(value: &str) -> Option<(u32, u8)> {
    let (addr_str, prefix_str) = value.split_once('/')?;
    let addr: std::net::Ipv4Addr = addr_str.trim().parse().ok()?;
    let prefix: u8 = prefix_str.trim().parse().ok()?;
    (prefix <= 32).then(|| (u32::from(addr), prefix))
}

fn parse_v6_cidr(value: &str) -> Option<(u128, u8)> {
    let (addr_str, prefix_str) = value.split_once('/')?;
    let addr: std::net::Ipv6Addr = addr_str.trim().parse().ok()?;
    let prefix: u8 = prefix_str.trim().parse().ok()?;
    (prefix <= 128).then(|| (u128::from(addr), prefix))
}

#[must_use]
const fn v4_in_cidr(bits: u32, network: u32, prefix: u8) -> bool {
    if prefix == 0 {
        return true;
    }
    let mask = u32::MAX << (32 - prefix);
    (bits & mask) == (network & mask)
}

#[must_use]
const fn v6_in_cidr(bits: u128, network: u128, prefix: u8) -> bool {
    if prefix == 0 {
        return true;
    }
    let mask = u128::MAX << (128 - prefix);
    (bits & mask) == (network & mask)
}

/// Check if an IP address is private, local, or otherwise not a valid public
/// destination for a direct connection.
///
/// This is the single place that decides "safe to dial as a public host", so it
/// covers reserved space as well as the private ranges, on both address families.
/// Mihomo's default fake-IP range (`198.18.0.0/15`) is included: callers normally
/// recognise those answers as synthetic *before* reaching this check, but under a
/// profile with a custom `dns.fake-ip-range` nothing else would reject one.
#[must_use]
pub fn is_private_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ipv4) => is_unsafe_destination_v4(u32::from(ipv4)),
        IpAddr::V6(ipv6) => is_unsafe_destination_v6(ipv6),
    }
}

/// Whether an IPv6 address is private, local, or not a valid public destination.
fn is_unsafe_destination_v6(ipv6: std::net::Ipv6Addr) -> bool {
    let bits = u128::from(ipv6);

    // Direct properties first. The IPv4-embedding prefixes below include `::/96`,
    // which contains `::` and `::1`; judging those by their embedded address
    // would clear them as `0.0.0.0` / `0.0.0.1` and lose the loopback and
    // unspecified verdicts.
    if ipv6.is_loopback()
        || ipv6.is_unspecified()
        || ipv6.is_multicast()
        // Unique local (fc00::/7) and link-local (fe80::/10).
        || (ipv6.segments()[0] & 0xfe00) == 0xfc00
        || (ipv6.segments()[0] & 0xff00) == 0xfe00
        // Documentation range 2001:db8::/32.
        || v6_in_cidr(bits, 0x2001_0db8_0000_0000_0000_0000_0000_0000, 32)
    {
        return true;
    }

    // Otherwise, for an IPv4-embedding address, decide on the embedded address
    // rather than on the wrapper: `::ffff:169.254.169.254` and
    // `64:ff9b::a9fe:a9fe` are the same destination as the IPv4 address, and
    // must be judged the same way.
    //
    // `to_ipv4()` is deliberately not used: it also folds `::1` into `0.0.0.1`.
    embedded_ipv4(bits)
        .into_iter()
        .flatten()
        .any(is_unsafe_destination_v4)
}

/// The IPv4 destinations an IPv6 address may embed, for every prefix that
/// carries one; empty for any other address. The address is unsafe when any
/// of them is.
///
/// - IPv4-mapped `::ffff:0:0/96`, IPv4-compatible `::/96` and NAT64 well-known
///   `64:ff9b::/96` (RFC 6052): the low 32 bits.
/// - NAT64 local-use `64:ff9b:1::/48` (RFC 8215), deployed either as a /96 inside
///   it or as a /48, and the address alone does not say which. A /48 uses RFC
///   6052's split layout: 16 bits right after the prefix, the reserved `u`
///   octet, the other 16 bits, then a zero suffix. The canonical forms a DNS64
///   synthesizes are unambiguous: a zero `u` octet and suffix is the /48
///   layout, zero bits between the prefix and the low 32 bits is a /96. Any
///   other address could reach either reading depending on the translator, so
///   both are returned.
/// - 6to4 `2002::/16` (RFC 3056): bits 16-47.
/// - Teredo `2001::/32` (RFC 4380): the client address, stored inverted in the
///   low 32 bits.
fn embedded_ipv4(bits: u128) -> [Option<u32>; 2] {
    let low32 = u32::try_from(bits & 0xffff_ffff).unwrap_or(0);
    let field = |shift: u32| u32::try_from((bits >> shift) & 0xffff_ffff).unwrap_or(0);
    if v6_in_cidr(bits, 0x0000_0000_0000_0000_0000_ffff_0000_0000, 96)
        || v6_in_cidr(bits, 0, 96)
        || v6_in_cidr(bits, 0x0064_ff9b_0000_0000_0000_0000_0000_0000, 96)
    {
        return [Some(low32), None];
    }
    if v6_in_cidr(bits, 0x0064_ff9b_0001_0000_0000_0000_0000_0000, 48) {
        let split = ((field(64) & 0xffff) << 16) | (field(40) & 0xffff);
        let split_layout = bits & 0xff00_00ff_ffff_ffff == 0;
        let low_layout = bits & 0xffff_ffff_ffff_0000_0000 == 0;
        return [
            (split_layout || !low_layout).then_some(split),
            (!split_layout).then_some(low32),
        ];
    }
    if v6_in_cidr(bits, 0x2002_0000_0000_0000_0000_0000_0000_0000, 16) {
        return [Some(field(80)), None];
    }
    if v6_in_cidr(bits, 0x2001_0000_0000_0000_0000_0000_0000_0000, 32) {
        return [Some(!low32), None];
    }
    [None, None]
}

/// Whether a raw IPv4 address is private, local, or otherwise not a valid
/// public destination for a direct connection.
///
/// This is the single place that decides "safe to dial as a public host", so it
/// has to cover reserved space as well as the private ranges: a remote
/// subscription server can redirect a download to a *hostname*, and only the
/// resolved addresses are checked. Without the reserved ranges below, a
/// hostname resolving into carrier-grade NAT space is accepted — and that space
/// is where internal tailnets and cloud metadata endpoints live (for example
/// Alibaba Cloud's metadata service at `100.100.100.200`).
fn is_unsafe_destination_v4(bits: u32) -> bool {
    let addr = std::net::Ipv4Addr::from(bits);
    addr.is_private()
        || addr.is_loopback()
        || addr.is_link_local()
        || addr.is_broadcast()
        || addr.is_documentation()
        // "This network" 0.0.0.0/8 (RFC 1122), which includes the unspecified
        // address: never a valid destination, and some stacks route it locally.
        || v4_in_cidr(bits, 0, 8)
        // RFC 2544 benchmarking range 198.18.0.0/15: reserved, never globally
        // routable, and the default Mihomo fake-IP range.
        || v4_in_cidr(bits, 0xc612_0000, 15)
        // RFC 6598 shared address space (carrier-grade NAT): 100.64.0.0/10. Used
        // by Tailscale and cloud metadata services.
        || v4_in_cidr(bits, 0x6440_0000, 10)
        // IETF protocol assignments: 192.0.0.0/24.
        || v4_in_cidr(bits, 0xc000_0000, 24)
        // Multicast: 224.0.0.0/4.
        || v4_in_cidr(bits, 0xe000_0000, 4)
        // Reserved for future use: 240.0.0.0/4 (includes the broadcast address).
        || v4_in_cidr(bits, 0xf000_0000, 4)
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
    validate_public_host_addrs_with_ranges(host, addrs, &FakeIpRanges::default())
}

/// Like [`validate_public_host_addrs`], but classifies synthetic addresses
/// against the active core configuration's fake-IP ranges.
pub fn validate_public_host_addrs_with_ranges(
    host: &str,
    addrs: &[std::net::SocketAddr],
    fake_ip_ranges: &FakeIpRanges,
) -> Result<(String, Option<std::net::SocketAddr>, bool), PublicHostAddrError> {
    let mut resolved_addr = None;
    let mut saw_fake_ip = false;

    for addr in addrs {
        if fake_ip_ranges.contains(addr.ip()) {
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
    // The WHATWG parser silently drops tab/LF/CR anywhere in the input, so a
    // guard on the raw string would check a different URL than the one parsed
    // (`http://\t/sub` parses as `http:///sub`, host `sub`). No valid
    // subscription link contains control characters: reject them outright.
    if trimmed.chars().any(|c| c.is_ascii_control()) {
        return Err("Invalid URL: must not contain control characters".to_owned());
    }
    // WHATWG parsing of special schemes ignores scheme case and missing or extra
    // slashes (`HTTP:///sub`, `http:/sub` both parse with host `sub`), which
    // would turn a malformed URL into an authorized single-label intranet host.
    // Require exactly `//` followed by an authority.
    let lower = trimmed.to_ascii_lowercase();
    if let Some(rest) = lower
        .strip_prefix("http:")
        .or_else(|| lower.strip_prefix("https:"))
    {
        let mut chars = rest.chars();
        let slashes_ok = matches!((chars.next(), chars.next()), (Some('/'), Some('/')));
        if !slashes_ok || matches!(chars.next(), None | Some('/' | '\\')) {
            return Err("URL must have a host".to_owned());
        }
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

    // An explicitly entered single-label name (e.g. `nas`, `router`) is an
    // intranet destination like a private-suffix name: direct-only, pinned to a
    // non-synthetic address, and the only private host its redirects may reach.
    let user_entered_private = is_private_host(host) || is_single_label_host(host);

    let default_port = if scheme == "https" { 443 } else { 80 };
    let port = parsed_url.port().unwrap_or(default_port);

    Ok((host.to_owned(), port, user_entered_private))
}

/// Pick the first non-synthetic address for an explicitly entered
/// private-suffix hostname (authorized direct-only LAN destination).
///
/// Extracted from [`validate_subscription_url_with_ip`] so the fake-IP
/// filtering can be tested without DNS. Returns `None` when every address is
/// synthetic or the list is empty.
#[must_use]
pub fn first_non_fake_addr(
    addrs: &[std::net::SocketAddr],
    fake_ip_ranges: &FakeIpRanges,
) -> Option<std::net::SocketAddr> {
    addrs
        .iter()
        .copied()
        .find(|a| !fake_ip_ranges.contains(a.ip()))
}

/// Validate URL and its resolved IPs for SSRF protection.
/// Returns `(host, resolved_addr, user_entered_private)`.
///
/// Uses the built-in default fake-IP ranges. Callers that can read the active
/// core configuration should use [`validate_subscription_url_with_ip_with_ranges`],
/// otherwise a profile with a custom `dns.fake-ip-range` can have a synthetic
/// address mistaken for a real one.
pub fn validate_subscription_url_with_ip(
    url: &str,
) -> Result<(String, Option<std::net::SocketAddr>, bool), String> {
    validate_subscription_url_with_ip_with_ranges(url, &FakeIpRanges::default())
}

/// [`validate_subscription_url_with_ip`] with the active fake-IP ranges.
///
/// The ranges must come from the same configuration the destination will be
/// reached through: a synthetic address is only recognizable against the range
/// that produced it, so a custom `dns.fake-ip-range` address passed to the
/// default-range variant would be treated as a real destination and pinned.
pub fn validate_subscription_url_with_ip_with_ranges(
    url: &str,
    fake_ip_ranges: &FakeIpRanges,
) -> Result<(String, Option<std::net::SocketAddr>, bool), String> {
    let (host, port, user_entered_private) = validate_subscription_url_basic(url)?;
    if fake_ip_ranges.contains_host_literal(&host) {
        return Err(format!(
            "Invalid URL: synthetic fake-IP address '{host}' cannot be used as a subscription host"
        ));
    }

    if is_literal_private_host(&host) {
        return Ok((host, None, true));
    }

    let addrs: Vec<std::net::SocketAddr> =
        std::net::ToSocketAddrs::to_socket_addrs(&format!("{host}:{port}"))
            .map_err(|e| format!("DNS resolution failed for '{host}': {e}"))?
            .collect();

    if user_entered_private {
        // Explicitly entered private-suffix hostname (e.g. nas.local, router.lan, svc.internal).
        // It is an authorized direct-only LAN destination.
        // Pin the first non-synthetic address and treat as user_entered_private (direct-only).
        let Some(addr) = first_non_fake_addr(&addrs, fake_ip_ranges) else {
            return Err(format!(
                "Private host '{host}' could not be resolved to a non-synthetic IP address"
            ));
        };
        return Ok((host, Some(addr), true));
    }

    validate_public_host_addrs_with_ranges(&host, &addrs, fake_ip_ranges).map_err(|e| e.to_string())
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
/// A message that reports two tiers (`Direct: …; Proxy: …`) carries two
/// failures. Precedence otherwise stays as before — the first matching arm wins,
/// whatever tier it came from — with one exception: a direct-leg SSRF verdict
/// must not mask a proxy-leg failure of a different kind. The download path
/// escalates `Direct DNS returned non-public address` to the proxy *on purpose*
/// (that hop bypasses the direct SSRF check by design), so reporting an ordinary
/// proxy connection failure as `SUB_SSRF_BLOCKED` would tell the user their
/// request was blocked by SSRF protection when it was not.
///
/// When the proxy leg actually ran and failed with text carrying no specific
/// marker — `Download failed: tcp connect error: Connection refused (os error
/// 111)` is the common shape, since none of the markers match a raw transport
/// error — that is still a connection failure rather than a security block, so it
/// is reported as [`SUB_NETWORK_ERROR`].
///
/// Migrated from `src-tauri/src/core/subscription.rs`.
#[cfg_attr(feature = "uniffi", uniffi::export)]
#[must_use]
pub fn classify_sub_error(e: String) -> u16 {
    const TIER_SEPARATOR: &str = "; Proxy: ";
    if let Some(idx) = e.find(TIER_SEPARATOR) {
        let direct_part = &e[..idx];
        let proxy_part = &e[idx + TIER_SEPARATOR.len()..];
        let direct_code = classify_sub_error_message(direct_part);
        let proxy_code = classify_sub_error_message(proxy_part);
        // `skipped` means the proxy leg never issued a request (whatever reason
        // text follows, e.g. a deadline), so the direct leg's diagnosis is still
        // the best answer; a leg that ran and failed did issue one.
        if direct_code == crate::event::codes::SUB_SSRF_BLOCKED
            && proxy_code != crate::event::codes::SUB_SSRF_BLOCKED
            && !proxy_part.trim_start().starts_with("skipped")
        {
            if proxy_code != crate::event::codes::SUB_UPDATE_FAILED {
                return proxy_code;
            }
            return crate::event::codes::SUB_NETWORK_ERROR;
        }
    }
    classify_sub_error_message(&e)
}

#[must_use]
fn classify_sub_error_message(e: &str) -> u16 {
    if e.contains("SSRF protection")
        || e.contains("[SSRF_BLOCKED]")
        || e.contains("SSRF blocked")
        || e.contains("Direct SSRF blocked")
        || e.contains("Proxy SSRF blocked")
        || e.contains("Global-mode SSRF blocked")
        || e.contains("Redirect to private host blocked")
        || e.contains("Redirect to private IP blocked")
        || e.contains("[LOCAL_DNS_SSRF]")
        || e.contains("Direct DNS returned non-public address")
    {
        crate::event::codes::SUB_SSRF_BLOCKED
    } else if e.contains("Invalid URL")
        || e.contains("Only HTTP")
        || e.contains("must have a host")
        || e.contains("URL must not be empty")
    {
        crate::event::codes::SUB_URL_INVALID
    } else if contains_http_status(e) {
        crate::event::codes::SUB_HTTP_ERROR
    } else if e.contains("DNS resolution failed")
        || e.contains("Could not resolve")
        || e.contains("DNS resolution returned no addresses")
        || e.contains("DNS deadline elapsed")
        || e.contains("DNS resolution timed out")
        || e.contains("DNS resolution timeout")
        || e.contains("synthetic fake-IP")
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
    } else if e.contains("timeout")
        || e.contains("Timeout")
        || e.contains("timed out")
        || e.contains("deadline exceeded")
    {
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
    // 使用 visited 集合检测当前路径上的循环依赖，使用 memo 共享已完成的验证结果，避免多分支指数级重复计算。
    fn check_node_resolves_to_proxy(
        name: &str,
        proxies: &serde_json::Map<String, serde_json::Value>,
        visited: &mut std::collections::HashSet<String>,
        memo: &mut std::collections::HashMap<String, bool>,
        depth: usize,
    ) -> (bool, bool) {
        if let Some(&cached) = memo.get(name) {
            return (cached, false);
        }
        if depth > proxies.len().max(16) {
            return (false, true);
        }
        if is_special_target(name) {
            memo.insert(name.to_owned(), false);
            return (false, false);
        }
        if visited.contains(name) {
            return (false, true);
        }
        let Some(p_obj) = proxies.get(name) else {
            memo.insert(name.to_owned(), false);
            return (false, false);
        };
        let p_type = p_obj.get("type").and_then(|t| t.as_str()).unwrap_or("");
        let picks_one_member = p_type.eq_ignore_ascii_case("Selector")
            || p_type.eq_ignore_ascii_case("URLTest")
            || p_type.eq_ignore_ascii_case("Fallback");
        // Classify groups by shape as well as by type: a core fork can report
        // group types this list does not know (e.g. "Smart"), and treating such
        // an entry as a leaf would skip its members, `DIRECT` included.
        let has_members = p_obj.get("all").is_some_and(serde_json::Value::is_array);
        if picks_one_member
            || has_members
            || p_type.eq_ignore_ascii_case("LoadBalance")
            || p_type.eq_ignore_ascii_case("Relay")
        {
            visited.insert(name.to_owned());
            // Every entry of `all` must resolve, for LoadBalance as well as Relay, even
            // when `now` points at a live member. A Relay's chain is only as
            // strong as its weakest member, and a LoadBalance member that
            // resolves to `DIRECT` or is dead is a path out of the group that
            // bypasses the proxy or drops the traffic — so one healthy `now`
            // says nothing about the rest. Skipping them here would let
            // `select_global_candidate` return a group whose traffic can go
            // direct, which is the one thing this function exists to prevent.
            // Unknown group types follow `now` when they report one (like the
            // selecting groups); without it, every member has to resolve.
            let checks_all_members = !picks_one_member
                && (p_type.eq_ignore_ascii_case("Relay")
                    || p_type.eq_ignore_ascii_case("LoadBalance")
                    || p_obj.get("now").and_then(|n| n.as_str()).is_none());
            if checks_all_members {
                if let Some(all_arr) = p_obj.get("all").and_then(|a| a.as_array()) {
                    let members: Vec<&str> = all_arr.iter().filter_map(|v| v.as_str()).collect();
                    if !members.is_empty() {
                        let mut any_cycle = false;
                        let mut all_ok = true;
                        for member in members {
                            let (ok, cycle) = check_node_resolves_to_proxy(
                                member,
                                proxies,
                                visited,
                                memo,
                                depth + 1,
                            );
                            if cycle {
                                any_cycle = true;
                            }
                            if !ok {
                                all_ok = false;
                                break;
                            }
                        }
                        visited.remove(name);
                        if !any_cycle || all_ok {
                            memo.insert(name.to_owned(), all_ok);
                        }
                        return (all_ok, any_cycle);
                    }
                }
            }
            if let Some(next_now) = p_obj.get("now").and_then(|n| n.as_str()) {
                let (res, cycle) =
                    check_node_resolves_to_proxy(next_now, proxies, visited, memo, depth + 1);
                visited.remove(name);
                if !cycle || res {
                    memo.insert(name.to_owned(), res);
                }
                return (res, cycle);
            }
            visited.remove(name);
            memo.insert(name.to_owned(), false);
            return (false, false);
        }
        if p_type.is_empty()
            || p_type.eq_ignore_ascii_case("Direct")
            || p_type.eq_ignore_ascii_case("Reject")
            || p_type.eq_ignore_ascii_case("RejectDrop")
            || p_type.eq_ignore_ascii_case("Pass")
            || p_type.eq_ignore_ascii_case("Pass-Rule")
            || p_type.eq_ignore_ascii_case("Compatible")
        {
            memo.insert(name.to_owned(), false);
            return (false, false);
        }
        let alive = p_obj.get("alive").and_then(serde_json::Value::as_bool) != Some(false);
        memo.insert(name.to_owned(), alive);
        (alive, false)
    }

    let mut memo = std::collections::HashMap::new();
    let mut resolves_to_effective_proxy = |start_name: &str| -> bool {
        let mut visited = std::collections::HashSet::new();
        check_node_resolves_to_proxy(start_name, proxies, &mut visited, &mut memo, 0).0
    };

    let mut is_valid_global_candidate = |s: &str| {
        !global_all.is_empty() && global_all.contains(&s) && resolves_to_effective_proxy(s)
    };

    let active_node = global_now
        .as_deref()
        .filter(|n| is_valid_global_candidate(n))
        .map(std::borrow::ToOwned::to_owned)
        .or_else(|| {
            // Priority 1: Walk GLOBAL's `all` member list in order for groups.
            // This preserves the configuration's group order, where the user's primary group comes first.
            for &member_name in &global_all {
                if member_name == "GLOBAL" || is_special_target(member_name) {
                    continue;
                }
                if let Some(proxy_val) = proxies.get(member_name) {
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
                        if is_valid_global_candidate(member_name) {
                            return Some(member_name.to_owned());
                        }
                    }
                }
            }

            // Priority 2: Fall back to scanning all groups in `proxies` map.
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

            // Priority 3: Look through GLOBAL's member list `all` for the first valid candidate (leaf node).
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
#[allow(clippy::unwrap_used, clippy::panic)]
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
        // RFC 2544 benchmarking range: reserved, never globally routable. It is also
        // Mihomo's default fake-IP range, but `is_private_ip` must reject it on
        // its own so a custom `dns.fake-ip-range` cannot make it look public.
        assert!(is_private_ip("198.18.0.1".parse().unwrap()));
        assert!(is_private_ip("198.19.255.254".parse().unwrap()));
        assert!(is_private_ip("::ffff:198.18.0.1".parse().unwrap()));
        assert!(!is_private_ip("198.17.255.255".parse().unwrap()));
        assert!(!is_private_ip("198.20.0.1".parse().unwrap()));
        // Reserved space that must never be dialled as a public destination.
        // A remote subscription server can redirect to a hostname resolving
        // into these ranges, so only the resolved address is checked.
        for ip in [
            // "This network" 0.0.0.0/8, not only the unspecified address.
            "0.0.0.0",
            "0.1.2.3",
            "0.255.255.255",
            // RFC 6598 carrier-grade NAT (Tailscale, cloud metadata).
            "100.64.0.0",
            "100.100.100.200",
            "100.127.255.255",
            // IETF protocol assignments.
            "192.0.0.1",
            // Multicast.
            "224.0.0.1",
            "239.255.255.250",
            // Reserved for future use.
            "240.0.0.1",
            "255.255.255.255",
        ] {
            assert!(is_private_ip(ip.parse().unwrap()), "{ip} must be blocked");
        }
        // The mapped IPv6 form goes through the same helper.
        assert!(is_private_ip("::ffff:100.100.100.200".parse().unwrap()));
        // Just outside each reserved block stays usable.
        for ip in [
            "100.63.255.255",
            "100.128.0.0",
            "192.0.1.1",
            "223.255.255.255",
        ] {
            assert!(!is_private_ip(ip.parse().unwrap()), "{ip} must stay public");
        }
        assert!(is_mihomo_fake_ip("198.18.0.1".parse().unwrap()));
        assert!(is_mihomo_fake_ip("198.19.255.254".parse().unwrap()));
        assert!(!is_mihomo_fake_ip("8.8.8.8".parse().unwrap()));
        assert!(!is_private_ip("8.8.8.8".parse().unwrap()));
        assert!(!is_private_ip("1.1.1.1".parse().unwrap()));
    }

    #[test]
    fn test_is_private_ip_nat64_local_use() {
        // RFC 6052 /48 layout under the local-use prefix: the IPv4 address is
        // split around the `u` octet, not in the low 32 bits.
        assert!(!is_private_ip("64:ff9b:1:808:8:800::".parse().unwrap()));
        assert!(is_private_ip("64:ff9b:1:a9fe:a9:fe00::".parse().unwrap()));
        // A non-canonical local-use address is judged by both readings: here
        // the low 32 bits say 8.8.8.8, but a /48 translator that ignores the
        // reserved suffix sends it to 10.0.0.1.
        assert!(is_private_ip(
            "64:ff9b:1:a00:0:100:808:808".parse().unwrap()
        ));
        // The canonical /96 form of a public address stays usable.
        assert!(!is_private_ip("64:ff9b:1::808:808".parse().unwrap()));
    }

    #[test]
    fn test_is_private_ip_v6() {
        assert!(is_private_ip("::1".parse().unwrap()));
        assert!(is_private_ip("::".parse().unwrap()));
        assert!(is_private_ip("fc00::1".parse().unwrap()));
        assert!(is_private_ip("fe80::1".parse().unwrap()));
        assert!(!is_private_ip("2001:4860:4860::8888".parse().unwrap()));
        // Multicast and documentation ranges.
        assert!(is_private_ip("ff00::1".parse().unwrap()));
        assert!(is_private_ip("ff02::1".parse().unwrap()));
        assert!(is_private_ip("2001:db8::1".parse().unwrap()));
        // IPv4-embedding prefixes must not walk past the IPv4 rules. Each of
        // these is the same destination as the blocked IPv4 address beside it,
        // so a redirect to any of them reaches the same internal host.
        for ip in [
            // NAT64 well-known prefix: 64:ff9b::a9fe:a9fe == 169.254.169.254,
            // the cloud metadata address.
            "64:ff9b::a9fe:a9fe",
            // NAT64 local-use prefix (RFC 8215), same embedded address.
            "64:ff9b:1::a9fe:a9fe",
            // IPv4-compatible (deprecated) form of the same address.
            "::a9fe:a9fe",
            // A carrier-grade NAT address, which the v4 rules now block.
            "::6440:0001",
        ] {
            assert!(is_private_ip(ip.parse().unwrap()), "{ip} must be blocked");
        }
        // The mapped form of a private v4 address stays blocked.
        assert!(is_private_ip("::ffff:127.0.0.1".parse().unwrap()));
        assert!(is_private_ip("::ffff:10.0.0.1".parse().unwrap()));
        // Embedding prefixes carrying a genuinely public address stay usable,
        // so the rule rejects the destination and not the notation.
        assert!(!is_private_ip("::ffff:8.8.8.8".parse().unwrap()));
        assert!(!is_private_ip("64:ff9b::808:808".parse().unwrap()));
        // 6to4 carries the IPv4 address in bits 16-47; Teredo stores the client
        // address inverted in the low 32 bits.
        assert!(is_private_ip("2002:a9fe:a9fe::".parse().unwrap()));
        assert!(is_private_ip("2002:c0a8:0101::1".parse().unwrap()));
        assert!(!is_private_ip("2002:0808:0808::1".parse().unwrap()));
        assert!(is_private_ip(
            "2001:0:4136:e378:8000:63bf:5601:5efe".parse().unwrap()
        ));
        assert!(!is_private_ip(
            "2001:0:4136:e378:8000:63bf:f7f7:f7f7".parse().unwrap()
        ));
        assert!(!is_private_ip("2606:4700:4700::1111".parse().unwrap()));
        assert!(is_mihomo_fake_ip("::ffff:198.18.0.1".parse().unwrap()));
        assert!(!is_mihomo_fake_ip("::ffff:8.8.8.8".parse().unwrap()));
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

        // The private-suffix fake-IP filtering and pinning decision is covered
        // by `test_first_non_fake_addr` (injected address lists, no live DNS).

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

        let (_, _, user_entered_private) =
            validate_subscription_url_basic("http://nas:8080/sub").unwrap();
        assert!(user_entered_private);
    }

    #[test]
    fn test_validate_invalid_schemes_rejected() {
        assert!(validate_subscription_url_with_ip("ftp://192.168.1.1/sub").is_err());
        assert!(validate_subscription_url_with_ip("file:///etc/passwd").is_err());
        assert!(validate_subscription_url_basic("ftp://192.168.1.1/sub").is_err());
        assert!(validate_subscription_url_basic("file:///etc/passwd").is_err());
        assert!(validate_subscription_url_basic("http:///sub").is_err());
        assert!(validate_subscription_url_basic("HTTP:///sub").is_err());
        assert!(validate_subscription_url_basic("Https:///sub").is_err());
        assert!(validate_subscription_url_basic("http:/sub").is_err());
        assert!(validate_subscription_url_basic("http:sub").is_err());
        assert!(validate_subscription_url_basic("HTTP://nas/sub").is_ok());
        assert!(validate_subscription_url_basic("http://\t/sub").is_err());
        assert!(validate_subscription_url_basic("http://\n/sub").is_err());
        assert!(validate_subscription_url_basic("http://example.com/a\rb").is_err());
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
    fn test_first_non_fake_addr() {
        use super::{first_non_fake_addr, FakeIpRanges};

        // Only fake addresses: rejected.
        let only_fake: Vec<std::net::SocketAddr> = vec!["198.18.0.5:80".parse().unwrap()];
        assert_eq!(
            first_non_fake_addr(&only_fake, &FakeIpRanges::default()),
            None
        );

        // Mixed fake and real: the real address wins.
        let mixed: Vec<std::net::SocketAddr> = vec![
            "198.18.0.5:80".parse().unwrap(),
            "192.168.1.10:80".parse().unwrap(),
        ];
        assert_eq!(
            first_non_fake_addr(&mixed, &FakeIpRanges::default()),
            Some("192.168.1.10:80".parse().unwrap())
        );

        // Empty list: rejected.
        let empty: Vec<std::net::SocketAddr> = Vec::new();
        assert_eq!(first_non_fake_addr(&empty, &FakeIpRanges::default()), None);

        // Custom configured ranges are honored.
        let ranges = FakeIpRanges::from_config_yaml("dns:\n  fake-ip-range: 198.20.0.0/16\n");
        let custom: Vec<std::net::SocketAddr> = vec!["198.20.0.5:80".parse().unwrap()];
        assert_eq!(first_non_fake_addr(&custom, &ranges), None);
        let default_view: Vec<std::net::SocketAddr> = vec!["198.18.0.5:80".parse().unwrap()];
        assert_eq!(
            first_non_fake_addr(&default_view, &ranges),
            Some("198.18.0.5:80".parse().unwrap())
        );
    }

    #[test]
    fn test_validate_subscription_url_with_ranges_uses_active_ranges() {
        use super::validate_subscription_url_with_ip_with_ranges;

        // A literal private IP is accepted without any DNS work and never
        // consults the ranges.
        let literal = match validate_subscription_url_with_ip_with_ranges(
            "http://192.168.1.2/sub",
            &FakeIpRanges::default(),
        ) {
            Ok(v) => v,
            Err(e) => panic!("literal private IP should be accepted: {e}"),
        };
        assert_eq!(literal.0, "192.168.1.2");
        assert!(literal.1.is_none());
        assert!(literal.2);

        // A literal inside a fake-IP range is synthetic, not a private host:
        // rejected for the built-in range and for a custom one.
        assert!(validate_subscription_url_with_ip_with_ranges(
            "http://198.18.0.5/sub",
            &FakeIpRanges::default()
        )
        .is_err());
        let custom_range = FakeIpRanges::from_config_yaml("dns:\n  fake-ip-range: 10.200.0.0/16\n");
        assert!(validate_subscription_url_with_ip_with_ranges(
            "http://10.200.0.5/sub",
            &custom_range
        )
        .is_err());
        assert!(FakeIpRanges::default().contains_host_literal("[fdfe:dcba:9876::1]"));
        assert!(!FakeIpRanges::default().contains_host_literal("[fd00::1]"));
        assert!(!FakeIpRanges::default().contains_host_literal("example.com"));

        // The default ranges recognize the built-in synthetic range; a profile
        // with a custom range must not treat those addresses as real. This is
        // the difference between the two entry points.
        let custom = FakeIpRanges::from_config_yaml("dns:\n  fake-ip-range: 198.20.0.0/16\n");
        let default_only = FakeIpRanges::default();

        let public_default = validate_subscription_url_with_ip_with_ranges(
            "http://public.invalid/sub",
            &default_only,
        );
        // Either DNS fails (no resolver in CI) or the host resolves; both are
        // acceptable. What must never happen is a synthetic address being
        // accepted as public.
        if let Ok((_, Some(addr), false)) = &public_default {
            assert!(
                !default_only.contains(addr.ip()),
                "synthetic address accepted as public: {addr}"
            );
        }

        let public_custom =
            validate_subscription_url_with_ip_with_ranges("http://public.invalid/sub", &custom);
        if let Ok((_, Some(addr), false)) = &public_custom {
            assert!(
                !custom.contains(addr.ip()),
                "synthetic address accepted as public: {addr}"
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

        // IPv6 fake-IP range fdfe:dcba:9876::/64
        let ipv6_fake_addr: std::net::IpAddr = "fdfe:dcba:9876::1".parse().unwrap();
        assert!(is_mihomo_fake_ip(ipv6_fake_addr));
        let v6_fake_addrs: Vec<std::net::SocketAddr> =
            vec!["[fdfe:dcba:9876::1]:80".parse().unwrap()];
        let v6_result = validate_public_host_addrs("ipv6-fake.com", &v6_fake_addrs);
        assert!(v6_result.is_err());
        assert!(matches!(
            v6_result.unwrap_err(),
            PublicHostAddrError::NoAddresses(_)
        ));
    }

    #[test]
    fn test_fake_ip_ranges_from_config_yaml() {
        // Custom ranges replace the built-in defaults.
        let ranges = FakeIpRanges::from_config_yaml(
            "dns:\n  enable: true\n  fake-ip-range: 198.20.0.0/16\n  fake-ip-range6: 2001:db8::/32\n",
        );
        assert!(ranges.contains("198.20.1.2".parse().unwrap()));
        assert!(ranges.contains("2001:db8::1".parse().unwrap()));
        assert!(!ranges.contains("198.18.0.1".parse().unwrap()));
        assert!(!ranges.contains("93.184.216.34".parse().unwrap()));

        // Missing / empty / invalid values fall back to the built-in defaults.
        for config in [
            "port: 7890",
            "dns:\n  enable: true",
            "dns:\n  fake-ip-range: ''",
            "dns:\n  fake-ip-range: not-a-cidr",
            "not: valid: yaml: [",
        ] {
            let fallback = FakeIpRanges::from_config_yaml(config);
            assert!(fallback.contains("198.18.0.1".parse().unwrap()));
            assert!(fallback.contains("198.19.255.254".parse().unwrap()));
            assert!(fallback.contains("fdfe:dcba:9876::1".parse().unwrap()));
            assert!(!fallback.contains("8.8.8.8".parse().unwrap()));
        }

        // IPv4-mapped IPv6 addresses follow the mapped v4 range.
        assert!(FakeIpRanges::default().contains("::ffff:198.18.0.1".parse().unwrap()));
        assert!(!FakeIpRanges::default().contains("::ffff:8.8.8.8".parse().unwrap()));
    }

    #[test]
    fn test_validate_public_host_addrs_with_custom_fake_ip_ranges() {
        let ranges = FakeIpRanges::from_config_yaml("dns:\n  fake-ip-range: 198.20.0.0/16\n");

        // A synthetic address from the custom range is not pinned, and a mixed
        // answer still pins the real public address.
        let only_fake: Vec<std::net::SocketAddr> = vec!["198.20.0.5:443".parse().unwrap()];
        let result = validate_public_host_addrs_with_ranges("x.com", &only_fake, &ranges);
        assert!(matches!(
            result.unwrap_err(),
            PublicHostAddrError::NoAddresses(_)
        ));

        let mixed: Vec<std::net::SocketAddr> = vec![
            "198.20.0.5:443".parse().unwrap(),
            "93.184.216.34:443".parse().unwrap(),
        ];
        let (_, pinned, _) =
            validate_public_host_addrs_with_ranges("x.com", &mixed, &ranges).unwrap();
        assert_eq!(pinned, Some("93.184.216.34:443".parse().unwrap()));

        // A default-range synthetic address is no longer treated as a plain
        // public destination once the active ranges are custom: 198.18.0.0/15
        // is the RFC 2544 benchmarking range, which is reserved and never
        // routable, so pinning it would produce a connection that cannot
        // succeed. It is blocked instead of dialed.
        let default_fake: Vec<std::net::SocketAddr> = vec!["198.18.0.5:443".parse().unwrap()];
        assert!(matches!(
            validate_public_host_addrs_with_ranges("x.com", &default_fake, &ranges),
            Err(PublicHostAddrError::SsrfBlocked(_))
        ));
        // The boundaries of the benchmarking range are covered too.
        for ip in ["198.18.0.0", "198.19.255.255"] {
            let addrs: Vec<std::net::SocketAddr> = vec![format!("{ip}:443").parse().unwrap()];
            assert!(
                matches!(
                    validate_public_host_addrs_with_ranges("x.com", &addrs, &ranges),
                    Err(PublicHostAddrError::SsrfBlocked(_))
                ),
                "{ip} should be blocked"
            );
        }
        // Just below the benchmarking range is ordinary public space and stays usable.
        let outside: Vec<std::net::SocketAddr> = vec!["198.17.255.255:443".parse().unwrap()];
        let (_, pinned, _) =
            validate_public_host_addrs_with_ranges("x.com", &outside, &ranges).unwrap();
        assert_eq!(pinned, Some("198.17.255.255:443".parse().unwrap()));
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
    fn test_select_global_candidate_relay_with_all_without_now() {
        // A Relay whose chain is reported under `all` (no `now`) is usable when
        // every chain member resolves to a live proxy.
        let json = serde_json::json!({
            "GLOBAL": {
                "all": ["Relay-Group"]
            },
            "Relay-Group": {
                "type": "Relay",
                "all": ["Leaf-01"]
            },
            "Leaf-01": {
                "type": "Vmess"
            }
        });
        let proxies = json.as_object().unwrap();
        assert_eq!(
            select_global_candidate(proxies),
            Some(("Relay-Group".to_owned(), None))
        );

        // A dead chain member makes the Relay unusable, so no candidate.
        let dead_json = serde_json::json!({
            "GLOBAL": {
                "all": ["Relay-Group"]
            },
            "Relay-Group": {
                "type": "Relay",
                "all": ["DeadLeaf"]
            },
            "DeadLeaf": {
                "type": "Vmess",
                "alive": false
            }
        });
        let dead_proxies = dead_json.as_object().unwrap();
        assert_eq!(select_global_candidate(dead_proxies), None);
    }

    #[test]
    fn test_select_global_candidate_load_balance_with_a_dead_member() {
        // No `DIRECT` here — both members are real proxy types, one of them just
        // down. The group is still rejected, and deliberately so: LoadBalance
        // picks one member at runtime, so a healthy peer says nothing about the
        // dead one, and a group that may route onto it is not certifiable as
        // "always forwards through a working proxy". The all-members rule that
        // applies to Relay therefore applies here too.
        let json = serde_json::json!({
            "GLOBAL": {
                "all": ["LB-Group"]
            },
            "LB-Group": {
                "type": "LoadBalance",
                "all": ["DeadLeaf", "LiveLeaf"]
            },
            "DeadLeaf": { "type": "Vmess", "alive": false },
            "LiveLeaf": { "type": "Vmess", "alive": true }
        });
        let proxies = json.as_object().unwrap();
        assert_eq!(select_global_candidate(proxies), None);

        // Both members healthy: usable. This is the boundary the dead member
        // above is measured against, so it is worth pinning as well.
        let live_json = serde_json::json!({
            "GLOBAL": {
                "all": ["LB-Group"]
            },
            "LB-Group": {
                "type": "LoadBalance",
                "all": ["LiveA", "LiveB"]
            },
            "LiveA": { "type": "Vmess", "alive": true },
            "LiveB": { "type": "Vmess", "alive": true }
        });
        let live_proxies = live_json.as_object().unwrap();
        assert_eq!(
            select_global_candidate(live_proxies),
            Some(("LB-Group".to_owned(), None))
        );
    }

    #[test]
    fn test_select_global_candidate_load_balance_now_still_checks_all_members() {
        // `now` points at a live proxy, so a check that only followed `now`
        // would accept the group. The other member is `DIRECT`, which is a path
        // out of the group that bypasses the proxy entirely — the group must
        // still be rejected. This is the `now`-present counterpart of
        // `test_select_global_candidate_load_balance_with_a_dead_member`: same
        // rule, reached through a different branch.
        let json = serde_json::json!({
            "GLOBAL": {
                "all": ["LB-Group"]
            },
            "LB-Group": {
                "type": "LoadBalance",
                "now": "LiveLeaf",
                "all": ["LiveLeaf", "DIRECT"]
            },
            "LiveLeaf": { "type": "Vmess", "alive": true }
        });
        let proxies = json.as_object().unwrap();
        assert_eq!(select_global_candidate(proxies), None);

        // Both members real proxies: usable.
        let live_json = serde_json::json!({
            "GLOBAL": {
                "all": ["LB-Group"]
            },
            "LB-Group": {
                "type": "LoadBalance",
                "now": "LiveA",
                "all": ["LiveA", "LiveB"]
            },
            "LiveA": { "type": "Vmess", "alive": true },
            "LiveB": { "type": "Vmess", "alive": true }
        });
        let live_proxies = live_json.as_object().unwrap();
        assert_eq!(
            select_global_candidate(live_proxies),
            Some(("LB-Group".to_owned(), None))
        );
    }

    #[test]
    fn test_select_global_candidate_relay_full_chain_must_resolve() {
        // `now` points at a live hop, but another chain member is dead: the
        // Relay is unusable and must not become a candidate.
        let json = serde_json::json!({
            "GLOBAL": {
                "all": ["Relay-Group"]
            },
            "Relay-Group": {
                "type": "Relay",
                "now": "Leaf-01",
                "all": ["Leaf-01", "Leaf-02"]
            },
            "Leaf-01": { "type": "Vmess" },
            "Leaf-02": { "type": "Vmess", "alive": false }
        });
        let proxies = json.as_object().unwrap();
        assert_eq!(select_global_candidate(proxies), None);

        // Both hops live: usable.
        let live_json = serde_json::json!({
            "GLOBAL": {
                "all": ["Relay-Group"]
            },
            "Relay-Group": {
                "type": "Relay",
                "now": "Leaf-01",
                "all": ["Leaf-01", "Leaf-02"]
            },
            "Leaf-01": { "type": "Vmess" },
            "Leaf-02": { "type": "Vmess" }
        });
        let live_proxies = live_json.as_object().unwrap();
        assert_eq!(
            select_global_candidate(live_proxies),
            Some(("Relay-Group".to_owned(), None))
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
    fn test_select_global_candidate_checks_unknown_group_types_by_members() {
        // An unrecognised group type with `all` but no `now` must not pass as a
        // leaf: its `DIRECT` member would bypass the proxy.
        let no_now = serde_json::json!({
            "GLOBAL": { "all": ["Smart-Group"], "now": "Smart-Group" },
            "Smart-Group": { "type": "Smart", "all": ["DIRECT", "LiveLeaf"] },
            "LiveLeaf": { "type": "Shadowsocks", "alive": true }
        });
        assert_eq!(select_global_candidate(no_now.as_object().unwrap()), None);

        // With `now`, it is followed like a selecting group.
        let now_direct = serde_json::json!({
            "GLOBAL": { "all": ["Smart-Group"], "now": "Smart-Group" },
            "Smart-Group": { "type": "Smart", "now": "DIRECT", "all": ["DIRECT", "LiveLeaf"] },
            "LiveLeaf": { "type": "Shadowsocks", "alive": true }
        });
        assert_eq!(
            select_global_candidate(now_direct.as_object().unwrap()),
            None
        );

        let now_live = serde_json::json!({
            "GLOBAL": { "all": ["Smart-Group"], "now": "Smart-Group" },
            "Smart-Group": { "type": "Smart", "now": "LiveLeaf", "all": ["DIRECT", "LiveLeaf"] },
            "LiveLeaf": { "type": "Shadowsocks", "alive": true }
        });
        assert_eq!(
            select_global_candidate(now_live.as_object().unwrap()),
            Some(("Smart-Group".to_owned(), Some("Smart-Group".to_owned())))
        );
    }

    #[test]
    fn test_select_global_candidate_prefers_global_all_order_over_alphabetical() {
        let json = serde_json::json!({
            "GLOBAL": {
                "all": ["MainProxy", "AppleProxy"],
                "now": "DIRECT"
            },
            "AppleProxy": {
                "type": "Selector",
                "now": "AppleNode",
                "all": ["AppleNode"]
            },
            "AppleNode": {
                "type": "Shadowsocks",
                "alive": true
            },
            "MainProxy": {
                "type": "Selector",
                "now": "MainNode",
                "all": ["MainNode"]
            },
            "MainNode": {
                "type": "Shadowsocks",
                "alive": true
            }
        });
        let proxies = json.as_object().unwrap();
        // In the JSON map, "AppleProxy" sorts before "MainProxy" alphabetically.
        // But GLOBAL.all lists "MainProxy" first, so "MainProxy" must be chosen over "AppleProxy".
        let candidate = select_global_candidate(proxies);
        assert_eq!(
            candidate,
            Some(("MainProxy".to_owned(), Some("DIRECT".to_owned())))
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
            validate_subscription_url_basic("http://\t/sub")
                .err()
                .map(classify_sub_error),
            Some(SUB_URL_INVALID)
        );
        assert_eq!(
            validate_subscription_url_with_ip("http://198.18.0.5/sub")
                .err()
                .map(classify_sub_error),
            Some(SUB_URL_INVALID)
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
            classify_sub_error(
                "DNS resolved to synthetic fake-IP address for 'example.com', cannot pin for direct connection".to_owned()
            ),
            SUB_DNS_FAILED
        );
        assert_eq!(
            classify_sub_error("Proxy SSRF blocked: [SSRF_BLOCKED] private IP".to_owned()),
            SUB_SSRF_BLOCKED
        );
        assert_eq!(
            classify_sub_error(
                "Direct download failed: [SSRF_BLOCKED] DNS resolved to private IP: cdn.test -> 127.0.0.1".to_owned()
            ),
            SUB_SSRF_BLOCKED
        );
        // Two-tier message: the proxy attempt is the final one, so its error
        // decides the code. The direct leg here is the SSRF failure the download
        // path escalates to the proxy on purpose, so letting it win would report
        // a plain proxy connection failure as an SSRF block.
        assert_eq!(
            classify_sub_error(
                "Direct: Direct DNS returned non-public address: DNS resolved to private IP: cdn.test -> 127.0.0.1; Proxy: Connection failed".to_owned()
            ),
            SUB_NETWORK_ERROR
        );
        // A genuine proxy-side SSRF still reports an SSRF block.
        assert_eq!(
            classify_sub_error(
                "Direct: Direct DNS returned non-public address: 127.0.0.1; Proxy: Proxy SSRF blocked: [SSRF_BLOCKED] private IP".to_owned()
            ),
            SUB_SSRF_BLOCKED
        );
        // The realistic shape of an unmapped transport failure: `try_proxy_download`
        // formats `Download failed: {chain}`, and no classifier arm matches a raw
        // reqwest transport error. Without the ran-vs-skipped distinction this
        // fell through to the whole message and the direct leg's SSRF text won.
        assert_eq!(
            classify_sub_error(
                "Direct: Direct DNS returned non-public address: DNS resolved to private IP: cdn.test -> 127.0.0.1; \
                 Proxy: Download failed: tcp connect error: Connection refused (os error 111)"
                    .to_owned()
            ),
            SUB_NETWORK_ERROR
        );
        assert_eq!(
            classify_sub_error(
                "Direct: Direct DNS returned non-public address: 127.0.0.1; \
                 Proxy: Download failed: connection closed before message completed"
                    .to_owned()
            ),
            SUB_NETWORK_ERROR
        );
        // The deadline form still classifies on its own marker.
        assert_eq!(
            classify_sub_error(
                "Direct: Direct DNS returned non-public address: 127.0.0.1; \
                 Proxy: Request deadline exceeded"
                    .to_owned()
            ),
            SUB_UPDATE_TIMEOUT
        );
        // Skipped proxy tier carrying no specific marker: nothing better to
        // report, so the existing classification stands.
        assert_eq!(
            classify_sub_error(
                "Direct: Direct DNS returned non-public address: 127.0.0.1; Proxy: skipped, destination 'cdn.test' could not be verified as public via DNS".to_owned()
            ),
            SUB_SSRF_BLOCKED
        );
    }

    #[test]
    fn test_select_global_candidate_load_balance_diamond_memoization() {
        let mut map = serde_json::Map::new();
        map.insert(
            "Proxy-Leaf".to_owned(),
            serde_json::json!({ "type": "Shadowsocks", "alive": true }),
        );
        map.insert(
            "LB1".to_owned(),
            serde_json::json!({ "type": "LoadBalance", "all": ["Proxy-Leaf"] }),
        );
        map.insert(
            "LB2".to_owned(),
            serde_json::json!({ "type": "LoadBalance", "all": ["Proxy-Leaf"] }),
        );
        map.insert(
            "Top-LB".to_owned(),
            serde_json::json!({ "type": "LoadBalance", "all": ["LB1", "LB2"] }),
        );
        map.insert(
            "GLOBAL".to_owned(),
            serde_json::json!({ "type": "Selector", "all": ["Top-LB"] }),
        );

        assert_eq!(
            select_global_candidate(&map).map(|(c, _)| c),
            Some("Top-LB".to_owned())
        );
    }
}
