// ===========================================================================
// overrides_model_tests.rs — Golden (snapshot) tests for override filenames
// ===========================================================================
//
// Tests the filename generation methods on `OverrideItem`:
//   - content_filename:  `{id}.{ext}`
//   - log_filename:      `{id}.log.json`
//   - patch_filename:    `override_{id}.prism.yaml`
//
// This file is included from prism/overrides/overrides_model.rs via:
//   #[cfg(test)]
//   #[path = "overrides_model_tests.rs"]
//   mod overrides_model_tests;

#[allow(
    clippy::expect_used,
    clippy::unwrap_used,
    clippy::indexing_slicing,
    clippy::panic
)]
mod tests {
    use super::super::{OverrideExt, OverrideItem, OverrideLog, OverrideType};

    fn make_item(id: &str, ext: OverrideExt) -> OverrideItem {
        OverrideItem {
            id: id.to_owned(),
            name: "test".to_owned(),
            r#type: OverrideType::Local,
            ext,
            enabled: true,
            global: true,
            profile_ids: Vec::new(),
            url: None,
            order: 0,
            updated_at: None,
            created_at: 0,
            last_success: None,
            last_error: None,
        }
    }

    #[test]
    fn js_filenames() {
        let item = make_item("abc123", OverrideExt::Js);
        insta::assert_snapshot!("js_content", item.content_filename());
        insta::assert_snapshot!("js_log", item.log_filename());
        insta::assert_snapshot!("js_patch", item.patch_filename());
    }

    #[test]
    fn prism_yaml_filenames() {
        let item = make_item("xyz789", OverrideExt::PrismYaml);
        insta::assert_snapshot!("yaml_content", item.content_filename());
        insta::assert_snapshot!("yaml_log", item.log_filename());
        insta::assert_snapshot!("yaml_patch", item.patch_filename());
    }

    #[test]
    fn reload_outcome_preserves_legacy_logs_and_explicit_skips() {
        let legacy = serde_json::json!({
            "scriptId": "script",
            "scriptName": "Script",
            "executedAt": 0,
            "durationUs": 0,
            "success": true,
            "configModified": true,
            "error": null,
            "logs": []
        });
        let mut log: OverrideLog = serde_json::from_value(legacy).unwrap();
        assert_eq!(log.reloaded, None);
        log.reloaded = Some(false);
        let saved = serde_json::to_value(&log).unwrap();
        assert_eq!(saved["reloaded"], false);
        assert_eq!(saved["success"], true);
    }
}
