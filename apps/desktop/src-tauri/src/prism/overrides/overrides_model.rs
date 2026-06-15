//! Override module — data model.

use serde::{Deserialize, Serialize};

/// Extension format of an override script.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OverrideExt {
    Js,
    PrismYaml,
}

impl OverrideExt {
    #[must_use]
    pub const fn file_ext(&self) -> &'static str {
        match self {
            Self::Js => "js",
            Self::PrismYaml => "prism.yaml",
        }
    }

    #[must_use]
    pub fn from_ext(s: &str) -> Option<Self> {
        match s {
            "js" => Some(Self::Js),
            "prism.yaml" | "yaml" | "yml" => Some(Self::PrismYaml),
            _ => None,
        }
    }
}

/// Source type of an override.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OverrideType {
    Local,
    Remote,
}

/// A single override item.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverrideItem {
    pub id: String,
    pub name: String,
    pub r#type: OverrideType,
    pub ext: OverrideExt,
    pub enabled: bool,
    /// If true, applies to all subscriptions. `profile_ids` is ignored.
    pub global: bool,
    /// Subscription IDs this override applies to. Empty means global-only.
    pub profile_ids: Vec<String>,
    /// Remote URL (only for type = Remote).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// Sorting order (lower = earlier in pipeline).
    pub order: u32,
    /// Last fetch/update timestamp (Unix ms). For remote overrides.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<i64>,
    pub created_at: i64,
    /// Last execution result: true = success, false = failed, None = never executed.
    /// Populated by override_list; not persisted in meta.json.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_success: Option<bool>,
}

impl OverrideItem {
    #[must_use]
    pub fn new(name: String, ext: OverrideExt, r#type: OverrideType) -> Self {
        let now = chrono::Utc::now().timestamp_millis();
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            name,
            r#type,
            ext,
            enabled: true,
            global: true,
            profile_ids: Vec::new(),
            url: None,
            order: 0,
            updated_at: None,
            created_at: now,
            last_success: None,
        }
    }

    /// Returns the filename for this override's content file.
    #[must_use]
    pub fn content_filename(&self) -> String {
        format!("{}.{}", self.id, self.ext.file_ext())
    }

    /// Returns the filename for this override's log file.
    #[must_use]
    pub fn log_filename(&self) -> String {
        format!("{}.log.json", self.id)
    }

    /// Returns the filename used for the generated Prism workspace patch file.
    ///
    /// Only relevant for `OverrideExt::PrismYaml` overrides.
    #[must_use]
    pub fn patch_filename(&self) -> String {
        format!("override_{}.prism.yaml", self.id)
    }
}

/// Meta file stored at `overrides/meta.json`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct OverrideMeta {
    /// Override items sorted by `order`.
    pub items: Vec<OverrideItem>,
}

/// Execution log entry for a single override run.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverrideLog {
    pub script_id: String,
    pub script_name: String,
    pub executed_at: i64,
    pub duration_us: u64,
    pub success: bool,
    pub config_modified: bool,
    pub error: Option<String>,
    pub logs: Vec<LogEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogEntry {
    pub level: String,
    pub message: String,
}
