//! Proxy server address validation — migrated from `src-tauri/src/sys_proxy.rs`.
//!
//! Only the pure validation/parsing functions are migrated.
//! Platform-specific proxy enable/disable logic remains in src-tauri.

use std::net::IpAddr;

use crate::error::AppError;

/// Parsed host and port from a proxy server string.
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
#[derive(Clone, Debug)]
pub struct HostPort {
    pub host: String,
    pub port: String,
}

/// Validates that the proxy server address is a valid local address.
/// This prevents proxy hijacking by ensuring only loopback addresses are allowed.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn validate_proxy_server(server: &str) -> Result<(), AppError> {
    if server.is_empty() {
        return Err(AppError::ConfigError(
            "Proxy server address cannot be empty".to_owned(),
        ));
    }
    if server.len() > 512 {
        return Err(AppError::ConfigError(
            "Proxy server address too long".to_owned(),
        ));
    }
    if server.contains('\n') || server.contains('\r') || server.contains('\0') {
        return Err(AppError::ConfigError(
            "Proxy server address contains invalid characters".to_owned(),
        ));
    }

    // Parse host and port from server string
    let hp = parse_host_port(server)?;

    // Reject port 0 — OS would assign a random port, causing confusion
    if hp.port == "0" {
        return Err(AppError::ConfigError(
            "Port 0 is not allowed (OS would assign a random port)".to_owned(),
        ));
    }

    // Validate that host is a loopback address
    // First try to parse as IP address directly
    if let Ok(ip) = hp.host.parse::<IpAddr>() {
        if !ip.is_loopback() {
            return Err(AppError::ConfigError(
                "Only loopback addresses (127.0.0.1, ::1) are allowed for security reasons"
                    .to_owned(),
            ));
        }
        return Ok(());
    }

    // Handle special hostname cases
    let host_lower = hp.host.to_lowercase();
    if host_lower == "localhost" {
        return Ok(());
    }

    // Reject any other hostname that's not localhost
    // This prevents attacks like "127.0.0.1.evil.com"
    Err(AppError::ConfigError(format!(
        "Invalid proxy host '{}': only localhost, 127.0.0.1, or ::1 are allowed",
        hp.host
    )))
}

/// Parse host and port from a proxy server string.
/// Handles formats: "host:port", "[ipv6]:port", "localhost:port"
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn parse_host_port(server: &str) -> Result<HostPort, AppError> {
    if server.is_empty() {
        return Err(AppError::ConfigError(
            "Proxy server address cannot be empty".to_owned(),
        ));
    }

    // Handle IPv6 literal with port, e.g. [::1]:8080
    if server.starts_with('[') {
        if let Some(end_bracket) = server.rfind(']') {
            let host = server[1..end_bracket].to_owned();
            let remainder = &server[end_bracket + 1..];
            if let Some(port_str) = remainder.strip_prefix(':') {
                let port = port_str.trim().to_owned();
                if !port.is_empty() {
                    // Validate port is a valid number
                    if port.parse::<u16>().is_err() {
                        return Err(AppError::ParseError(format!("Invalid port number: {port}")));
                    }
                    return Ok(HostPort { host, port });
                }
            }
        }
        return Err(AppError::ParseError(
            "Invalid IPv6 proxy format, expected [host]:port".to_owned(),
        ));
    }

    // Handle IPv4 or hostname
    if let Some(last_colon) = server.rfind(':') {
        let host = server[..last_colon].trim().to_owned();
        let port = server[last_colon + 1..].trim().to_owned();
        if !host.is_empty() && !port.is_empty() {
            // Validate port is a valid number
            if port.parse::<u16>().is_err() {
                return Err(AppError::ParseError(format!("Invalid port number: {port}")));
            }
            return Ok(HostPort { host, port });
        }
    }

    Err(AppError::ParseError(
        "Invalid proxy server format, expected host:port".to_owned(),
    ))
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn test_validate_proxy_loopback_ipv4() {
        assert!(validate_proxy_server("127.0.0.1:7890").is_ok());
    }

    #[test]
    fn test_validate_proxy_loopback_ipv6() {
        assert!(validate_proxy_server("[::1]:7890").is_ok());
    }

    #[test]
    fn test_validate_proxy_localhost() {
        assert!(validate_proxy_server("localhost:7890").is_ok());
    }

    #[test]
    fn test_validate_proxy_rejects_public_ip() {
        assert!(validate_proxy_server("8.8.8.8:7890").is_err());
        assert!(validate_proxy_server("192.168.1.1:7890").is_err());
        assert!(validate_proxy_server("10.0.0.1:7890").is_err());
    }

    #[test]
    fn test_validate_proxy_rejects_empty() {
        assert!(validate_proxy_server("").is_err());
    }

    #[test]
    fn test_validate_proxy_rejects_too_long() {
        let long_addr = "localhost:".to_owned() + &"a".repeat(600);
        assert!(validate_proxy_server(&long_addr).is_err());
    }

    #[test]
    fn test_validate_proxy_rejects_newlines() {
        assert!(validate_proxy_server("127.0.0.1:7890\nInjected: true").is_err());
        assert!(validate_proxy_server("127.0.0.1:7890\r\nEvil").is_err());
        assert!(validate_proxy_server("127.0.0.1:7890\0null").is_err());
    }

    #[test]
    fn test_validate_proxy_rejects_non_localhost_hostname() {
        assert!(validate_proxy_server("proxy.example.com:7890").is_err());
        assert!(validate_proxy_server("127.0.0.1.evil.com:7890").is_err());
    }

    #[test]
    fn test_validate_proxy_invalid_format() {
        assert!(validate_proxy_server("not-a-valid-address").is_err());
        assert!(validate_proxy_server(":7890").is_err());
        assert!(validate_proxy_server("127.0.0.1:").is_err());
        assert!(validate_proxy_server("127.0.0.1:abc").is_err());
    }

    #[test]
    fn test_parse_host_port_ipv4() {
        let hp = parse_host_port("127.0.0.1:7890").unwrap();
        assert_eq!(hp.host, "127.0.0.1");
        assert_eq!(hp.port, "7890");
    }

    #[test]
    fn test_parse_host_port_ipv6() {
        let hp = parse_host_port("[::1]:8080").unwrap();
        assert_eq!(hp.host, "::1");
        assert_eq!(hp.port, "8080");
    }

    #[test]
    fn test_parse_host_port_with_spaces() {
        let hp = parse_host_port("  localhost : 7890  ").unwrap();
        assert_eq!(hp.host, "localhost");
        assert_eq!(hp.port, "7890");
    }

    #[test]
    fn test_parse_host_port_empty() {
        assert!(parse_host_port("").is_err());
    }

    #[test]
    fn test_parse_host_port_invalid_ipv6() {
        assert!(parse_host_port("[::1]").is_err());
        assert!(parse_host_port("[::1]:").is_err());
        assert!(parse_host_port("[::1]:abc").is_err());
    }
}
