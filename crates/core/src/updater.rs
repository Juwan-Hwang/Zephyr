//! Updater pure functions and types — migrated from `src-tauri/src/updater.rs`.
//!
//! Only pure validation/selection functions and data types are migrated.
//! Network I/O (reqwest, download, extract) remains in src-tauri.

use crate::error::AppError;
use serde::{Deserialize, Serialize};

/// Trusted hosts for core updates - GitHub only for security
const TRUSTED_HOSTS: [&str; 3] = [
    "github.com",
    "api.github.com",
    "objects.githubusercontent.com",
];

// ── Data types ────────────────────────────────────────────────────────────

/// Platform tags for asset selection.
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
#[derive(Debug, Clone)]
pub struct PlatformTags {
    pub os_tag: String,
    pub arch_tag: String,
}

#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
#[derive(Debug, Deserialize, Serialize)]
pub struct UpdateInfo {
    pub version: String,
    pub download_url: String,
}

#[derive(Debug, Deserialize)]
pub struct GithubRelease {
    pub tag_name: String,
    pub assets: Vec<GithubAsset>,
    pub body: Option<String>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct GithubAsset {
    pub name: String,
    pub digest: Option<String>,
}

#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
#[derive(Clone, Serialize)]
pub struct CoreDownloadStatus {
    pub status_text: String,
    pub progress: u8,
}

#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
#[derive(Serialize)]
pub struct ClientVersions {
    pub verge: String,
    pub mihomo_party: String,
    pub flclash: String,
}

#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
#[derive(Debug, Serialize)]
pub struct ClientUpdateInfo {
    pub version: String,
    pub download_url: String,
    pub release_notes: String,
    pub download_digest: Option<String>,
}

// ── Pure functions ────────────────────────────────────────────────────────

/// Strip a leading 'v' or 'V' prefix from a version tag.
#[must_use]
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn strip_version_prefix(tag: &str) -> String {
    tag.strip_prefix('v')
        .or_else(|| tag.strip_prefix('V'))
        .unwrap_or(tag)
        .to_owned()
}

/// Get the current platform tags for asset selection.
///
/// Supports desktop (windows/macos/linux) and mobile (android/ios) platforms.
/// Mihomo releases use naming convention: `mihomo-{os_tag}-{arch_tag}`
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn current_platform_tags() -> Result<PlatformTags, AppError> {
    let os = std::env::consts::OS;
    let arch = std::env::consts::ARCH;
    let os_tag = match os {
        "windows" => "windows",
        "macos" => "darwin",
        "linux" => "linux",
        "freebsd" => "freebsd",
        "openbsd" => "openbsd",
        "netbsd" => "netbsd",
        "dragonfly" => "dragonfly",
        "android" => "android",
        "ios" => "darwin", // iOS uses darwin-arm64 tag in mihomo releases
        _ => return Err(AppError::ConfigError(format!("Unsupported OS: {os}"))),
    };
    let arch_tag = match arch {
        "x86_64" => "amd64",
        "aarch64" => "arm64",
        "x86" => "386",
        "arm" => "armv7",
        "mips" => "mips-softfloat",
        "mips64" => "mips64",
        "mips64el" => "mips64le",
        "mipsel" => "mipsle-hardfloat",
        "riscv64" => "riscv64",
        "s390x" => "s390x",
        "loongarch64" => "loongarch64",
        _ => return Err(AppError::ConfigError(format!("Unsupported ARCH: {arch}"))),
    };
    Ok(PlatformTags {
        os_tag: os_tag.to_owned(),
        arch_tag: arch_tag.to_owned(),
    })
}

/// Build the download URL for a GitHub release asset.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn build_asset_download_url(version: &str, asset_name: &str) -> String {
    format!("https://github.com/MetaCubeX/mihomo/releases/download/{version}/{asset_name}")
}

/// Check if a URL points to a trusted update host.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn is_trusted_update_url(url: &str) -> bool {
    if let Ok(parsed) = url::Url::parse(url) {
        if let Some(host) = parsed.host_str() {
            return TRUSTED_HOSTS
                .iter()
                .any(|&h| host == h || host.ends_with(&format!(".{h}")));
        }
    }
    false
}

/// Select the best core release asset for the current platform.
pub fn select_release_asset(assets: &[GithubAsset]) -> Result<&GithubAsset, AppError> {
    let tags = current_platform_tags()?;
    let key = format!("mihomo-{}-{}", tags.os_tag, tags.arch_tag);
    let is_windows = tags.os_tag == "windows";
    let mut candidates = assets
        .iter()
        .filter(|a| a.name.contains(&key) && (a.name.ends_with(".zip") || a.name.ends_with(".gz")))
        .collect::<Vec<_>>();
    if is_windows {
        candidates.sort_by_key(|a| if a.name.contains("compatible") { 0 } else { 1 });
    }
    candidates.into_iter().next().ok_or_else(|| {
        AppError::ConfigError(format!(
            "Could not find release asset for {}-{}",
            tags.os_tag, tags.arch_tag
        ))
    })
}

/// Validates that a version string follows the semantic versioning pattern.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn validate_version_format(version: &str) -> bool {
    if !version.starts_with('v') {
        return false;
    }

    if version.len() < 3 || version.len() > 25 {
        return false;
    }

    // Security: reject path traversal and special characters
    if version.contains("..")
        || version.contains('/')
        || version.contains('\\')
        || version.contains('\0')
        || version.contains('<')
        || version.contains('>')
        || version.contains('|')
        || version.contains('&')
        || version.contains(';')
        || version.contains('$')
        || version.contains('`')
        || version.contains('\n')
        || version.contains('\r')
    {
        return false;
    }

    let version_part = &version[1..];
    let (main_version, _pre_release) = if let Some(idx) = version_part.find('-') {
        (&version_part[..idx], Some(&version_part[idx + 1..]))
    } else {
        (version_part, None)
    };

    let parts: Vec<&str> = main_version.split('.').collect();
    if parts.len() != 3 {
        return false;
    }

    for part in parts {
        if part.is_empty() || !part.chars().all(|c| c.is_ascii_digit()) {
            return false;
        }
    }

    true
}

/// Parse a GitHub release download URL to extract version and asset name.
/// Only allows official MetaCubeX/mihomo GitHub releases.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn parse_github_release_info(url: &str) -> Option<Vec<String>> {
    let parsed = url::Url::parse(url).ok()?;
    if parsed.host_str() != Some("github.com") {
        return None;
    }

    let segments: Vec<&str> = parsed.path_segments()?.collect();

    if segments.len() >= 5
        && segments.first().is_some_and(|s| *s == "MetaCubeX")
        && segments.get(1).is_some_and(|s| *s == "mihomo")
        && segments.get(2).is_some_and(|s| *s == "releases")
        && segments.get(3).is_some_and(|s| *s == "download")
    {
        let version = segments.get(4).map(|s| (*s).to_owned()).unwrap_or_default();
        let asset_name = segments.get(5).map(|s| (*s).to_owned()).unwrap_or_default();

        if !validate_version_format(&version) {
            return None;
        }

        let asset_lower = asset_name.to_lowercase();
        if !asset_lower.starts_with("mihomo-") {
            return None;
        }
        if !asset_lower.ends_with(".zip") && !asset_lower.ends_with(".gz") {
            return None;
        }
        if asset_name.contains("..")
            || asset_name.contains('/')
            || asset_name.contains('\\')
            || asset_name.contains('\0')
            || asset_name.contains('<')
            || asset_name.contains('>')
        {
            return None;
        }

        return Some(vec![version, asset_name]);
    }
    None
}

/// Determine the expected asset extension for the current platform.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn platform_asset_extensions() -> Vec<String> {
    if cfg!(target_os = "windows") {
        vec![".exe".to_owned(), ".msi".to_owned()]
    } else if cfg!(target_os = "macos") {
        vec![".dmg".to_owned()]
    } else {
        vec![".AppImage".to_owned(), ".deb".to_owned()]
    }
}

/// Select the best installer asset from a GitHub release for the current platform.
pub fn select_client_asset(assets: &[GithubAsset]) -> Result<&GithubAsset, AppError> {
    let extensions = platform_asset_extensions();
    let target_triple = format!(
        "{}-{}",
        if std::env::consts::OS == "macos" {
            "darwin"
        } else {
            std::env::consts::OS
        },
        if std::env::consts::ARCH == "x86_64" {
            "x86_64"
        } else if std::env::consts::ARCH == "aarch64" {
            "aarch64"
        } else {
            std::env::consts::ARCH
        }
    );

    // First pass: try to find an asset matching the target triple
    for asset in assets {
        let lower = asset.name.to_lowercase();
        if extensions.iter().any(|ext| lower.ends_with(ext)) && lower.contains(&target_triple) {
            return Ok(asset);
        }
    }

    // Second pass: any asset with a matching extension
    for asset in assets {
        let lower = asset.name.to_lowercase();
        if extensions.iter().any(|ext| lower.ends_with(ext)) {
            return Ok(asset);
        }
    }

    Err(AppError::ConfigError(
        "No suitable installer asset found for this platform".to_owned(),
    ))
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn test_strip_lowercase_v() {
        assert_eq!(strip_version_prefix("v1.18.0"), "1.18.0");
    }

    #[test]
    fn test_strip_uppercase_v() {
        assert_eq!(strip_version_prefix("V1.18.0"), "1.18.0");
    }

    #[test]
    fn test_no_prefix() {
        assert_eq!(strip_version_prefix("1.18.0"), "1.18.0");
    }

    #[test]
    fn test_empty() {
        assert_eq!(strip_version_prefix(""), "");
    }

    #[test]
    fn test_only_v() {
        assert_eq!(strip_version_prefix("v"), "");
    }

    #[test]
    fn test_only_uppercase_v() {
        assert_eq!(strip_version_prefix("V"), "");
    }

    #[test]
    fn test_lowercase_v_priority_over_uppercase() {
        assert_eq!(strip_version_prefix("vV1.0"), "V1.0");
    }

    #[test]
    fn test_validate_version_format_valid() {
        assert!(validate_version_format("v1.18.0"));
        assert!(validate_version_format("v0.0.1"));
        assert!(validate_version_format("v10.20.30"));
    }

    #[test]
    fn test_validate_version_format_invalid() {
        assert!(!validate_version_format("1.18.0")); // no v prefix
        assert!(!validate_version_format("v1.18")); // only 2 parts
        assert!(!validate_version_format("v1.18.0/../../../etc/passwd")); // path traversal
        assert!(!validate_version_format("v1.18.0;rm -rf /")); // injection
    }

    #[test]
    fn test_is_trusted_update_url_github() {
        assert!(is_trusted_update_url(
            "https://github.com/MetaCubeX/mihomo/releases/download/v1.18.0/mihomo-linux-amd64.gz"
        ));
    }

    #[test]
    fn test_is_trusted_update_url_untrusted() {
        assert!(!is_trusted_update_url("https://evil.com/malware"));
    }

    #[test]
    fn test_build_asset_download_url() {
        let url = build_asset_download_url("v1.18.0", "mihomo-linux-amd64.gz");
        assert_eq!(
            url,
            "https://github.com/MetaCubeX/mihomo/releases/download/v1.18.0/mihomo-linux-amd64.gz"
        );
    }

    // -- Snapshot tests ----------------------------------------------------

    #[test]
    fn snapshot_build_asset_url_linux() {
        insta::assert_snapshot!(build_asset_download_url(
            "v1.18.0",
            "mihomo-linux-amd64-v1.18.0.gz"
        ));
    }

    #[test]
    fn snapshot_build_asset_url_windows() {
        insta::assert_snapshot!(build_asset_download_url(
            "v1.19.28",
            "mihomo-windows-amd64-v3-v1.19.28.zip"
        ));
    }

    #[test]
    fn snapshot_build_asset_url_arm64() {
        insta::assert_snapshot!(build_asset_download_url(
            "v1.20.1",
            "mihomo-darwin-arm64-v1.20.1.gz"
        ));
    }
}
