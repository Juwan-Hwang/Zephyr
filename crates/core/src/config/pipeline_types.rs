//! Pipeline execution result types — platform-agnostic.
//!
//! Migrated from `src-tauri/src/prism/pipeline.rs`.
//! Only pure data types and serialization functions are here;
//! actual pipeline execution (script runtime, Tauri state) stays in src-tauri.

use crate::error::AppError;

/// Result of executing a script with write-back.
///
/// Migrated from `src-tauri/src/prism/pipeline.rs`.
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
#[derive(Debug, Clone, serde::Serialize)]
pub struct PipelineResult {
    pub success: bool,
    pub error: Option<String>,
    pub duration_us: u64,
    pub config_modified: bool,
    pub logs: Vec<PipelineLogEntry>,
    pub patches: Vec<PatchInfo>,
}

/// Log entry from script execution.
///
/// Migrated from `src-tauri/src/prism/pipeline.rs`.
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PipelineLogEntry {
    pub level: String,
    pub message: String,
}

/// Patch info from script execution.
///
/// Migrated from `src-tauri/src/prism/pipeline.rs`.
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PatchInfo {
    pub op: String,
    pub path: String,
}

/// Convert a PipelineResult to a JSON string.
///
/// Migrated from `src-tauri/src/prism/pipeline.rs`.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn pipeline_result_to_json(result: PipelineResult) -> Result<String, AppError> {
    serde_json::to_string(&result)
        .map_err(|e| AppError::ParseError(format!("Failed to serialize pipeline result: {e}")))
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn test_pipeline_result_serialization() {
        let result = PipelineResult {
            success: true,
            error: None,
            duration_us: 1234,
            config_modified: true,
            logs: vec![PipelineLogEntry {
                level: "info".to_owned(),
                message: "test".to_owned(),
            }],
            patches: vec![PatchInfo {
                op: "add".to_owned(),
                path: "/rules/-".to_owned(),
            }],
        };
        let json = pipeline_result_to_json(result).unwrap();
        assert!(json.contains("\"success\":true"));
        assert!(json.contains("\"duration_us\":1234"));
    }
}
