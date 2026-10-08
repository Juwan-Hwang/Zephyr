// ===========================================================================
// tray_tests.rs — Golden (snapshot) tests for tray proxy-env formatting
// ===========================================================================
//
// Tests the pure function `format_proxy_env` which generates shell-specific
// proxy environment variable export commands for 5 shell formats:
//   - bash (default, with lowercase + uppercase for Linux/macOS compat)
//   - fish (with lowercase + uppercase)
//   - cmd (Windows-only, case-insensitive — single set only)
//   - powershell (cross-platform, with lowercase + uppercase for macOS/Linux compat)
//   - nushell (cross-platform, with lowercase + uppercase for macOS/Linux compat)
//
// This file is included from tray.rs via:
//   #[cfg(test)]
//   #[path = "tray_tests.rs"]
//   mod tray_tests;

#[allow(
    clippy::expect_used,
    clippy::unwrap_used,
    clippy::indexing_slicing,
    clippy::panic
)]
mod tests {
    use super::super::{format_proxy_env, resolve_proxy_format};
    use crate::core_manager::core::{ProxyEndpoint, ProxyScheme};

    /// The listener these snapshots describe: an HTTP mixed-port endpoint.
    const HTTP_ENDPOINT: ProxyEndpoint = ProxyEndpoint {
        port: 7890,
        scheme: ProxyScheme::Http,
    };

    // ========================================================================
    // Shell format snapshot tests
    // ========================================================================

    #[test]
    fn format_proxy_env_bash() {
        insta::assert_snapshot!(format_proxy_env("bash", HTTP_ENDPOINT));
    }

    #[test]
    fn format_proxy_env_unknown_format() {
        insta::assert_snapshot!(format_proxy_env("unknown", HTTP_ENDPOINT));
    }

    #[test]
    fn format_proxy_env_fish() {
        insta::assert_snapshot!(format_proxy_env("fish", HTTP_ENDPOINT));
    }

    #[test]
    fn format_proxy_env_cmd() {
        insta::assert_snapshot!(format_proxy_env("cmd", HTTP_ENDPOINT));
    }

    #[test]
    fn format_proxy_env_powershell() {
        insta::assert_snapshot!(format_proxy_env("powershell", HTTP_ENDPOINT));
    }

    #[test]
    fn format_proxy_env_nushell() {
        insta::assert_snapshot!(format_proxy_env("nushell", HTTP_ENDPOINT));
    }

    #[test]
    fn format_proxy_env_mixed_case() {
        insta::assert_snapshot!(format_proxy_env("PowerShell", HTTP_ENDPOINT));
    }

    // ========================================================================
    // Scheme is taken from the endpoint, not assumed to be HTTP
    // ========================================================================

    #[test]
    fn format_proxy_env_uses_endpoint_scheme() {
        // A configuration that exposes only `socks-port` has no HTTP listener.
        // Emitting `http://` for it hands the user a proxy that cannot connect,
        // so the SOCKS scheme has to survive into every variable.
        let socks = ProxyEndpoint {
            port: 7892,
            scheme: ProxyScheme::Socks5h,
        };
        let text = format_proxy_env("bash", socks);
        assert!(text.contains("socks5h://127.0.0.1:7892"), "got: {text}");
        assert!(
            !text.contains("http://127.0.0.1:7892"),
            "SOCKS endpoint must not be advertised as HTTP: {text}"
        );

        // The HTTP endpoint keeps producing `http://` on the same port, so the
        // two are distinguished by scheme alone.
        let http = format_proxy_env("bash", HTTP_ENDPOINT);
        assert!(http.contains("http://127.0.0.1:7890"), "got: {http}");
    }

    // ========================================================================
    // resolve_proxy_format: empty format falls back to platform default
    // ========================================================================

    #[test]
    fn resolve_proxy_format_empty_returns_platform_default() {
        // Empty string should resolve to platform-appropriate default.
        let resolved = resolve_proxy_format("");
        if cfg!(target_os = "windows") {
            assert_eq!(resolved, "powershell");
        } else {
            assert_eq!(resolved, "bash");
        }
    }

    #[test]
    fn resolve_proxy_format_non_empty_passes_through() {
        // Non-empty formats should pass through unchanged.
        assert_eq!(resolve_proxy_format("bash"), "bash");
        assert_eq!(resolve_proxy_format("powershell"), "powershell");
        assert_eq!(resolve_proxy_format("custom-format"), "custom-format");
    }
}
