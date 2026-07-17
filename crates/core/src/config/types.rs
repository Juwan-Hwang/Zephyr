//! Configuration data types — platform-agnostic.
//!
//! Migrated from `src-tauri/src/core/mod.rs` and `src-tauri/src/core/crypto.rs`.

use std::collections::HashMap;

/// Metadata for a single config profile (subscription URL, update info, etc.)
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct ConfigMetadata {
    pub url: Option<String>,
    pub sub_info: Option<String>,
    #[serde(default)]
    pub last_updated: Option<u64>,
    #[serde(default)]
    pub auto_update_interval: Option<u64>,
    /// Per-subscription User-Agent override. When set, used instead of the global
    /// `subscription_user_agent` for downloading/updating this subscription.
    #[serde(default)]
    pub user_agent: Option<String>,
}

/// Collection of metadata for all config profiles, stored encrypted on disk.
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
#[derive(serde::Serialize, serde::Deserialize, Default)]
pub struct ProfilesMetadata {
    pub configs: HashMap<String, ConfigMetadata>,
}

/// Summary info for a config profile shown in the UI.
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
#[derive(serde::Serialize, Clone)]
pub struct ConfigInfo {
    pub name: String,
    #[serde(skip_serializing)]
    pub url: Option<String>,
    pub url_display: Option<String>,
    pub sub_info: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_updated: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auto_update_interval: Option<u64>,
}

/// Network optimization status — migrated from `src-tauri/src/core/network_optim.rs`.
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
#[derive(serde::Serialize, Clone)]
pub struct NetworkOptimStatus {
    pub applied: bool,
    pub details: String,
}

/// Application paths — migrated from `src-tauri/src/core/mod.rs`.
/// `PathBuf` is represented as String for `UniFFI` compatibility.
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
#[derive(Debug, Clone, serde::Serialize)]
pub struct AppPaths {
    pub app_data_dir: String,
    pub core_dir: String,
    pub profiles_dir: String,
}

/// Log read result — migrated from `src-tauri/src/core/mod.rs`.
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
#[derive(Debug, Clone, serde::Serialize)]
pub struct ReadLogResult {
    pub lines: Vec<String>,
    pub next_offset: u64,
    pub file_size: u64,
    pub has_more: bool,
    pub rotated: bool,
}
