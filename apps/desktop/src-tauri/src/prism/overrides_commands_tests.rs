// ===========================================================================
// overrides_commands_tests.rs — Golden (snapshot) tests for override templates
// ===========================================================================
//
// Tests `default_template_content` which returns the default template
// for JavaScript and PrismYaml override scripts. These templates are
// shown to users when creating new overrides, so format correctness matters.
//
// This file is included from prism/overrides_commands.rs via:
//   #[cfg(test)]
//   #[path = "overrides_commands_tests.rs"]
//   mod overrides_commands_tests;

#[allow(
    clippy::expect_used,
    clippy::unwrap_used,
    clippy::indexing_slicing,
    clippy::panic
)]
mod tests {
    use super::super::{
        check_write_mode, default_template_content, failed_apply_log, lost_by_failed_reload,
        OverrideExt,
    };

    #[test]
    fn js_template() {
        insta::assert_snapshot!(default_template_content(OverrideExt::Js));
    }

    #[test]
    fn prism_yaml_template() {
        insta::assert_snapshot!(default_template_content(OverrideExt::PrismYaml));
    }

    #[test]
    fn dry_run_with_save_only_is_refused() {
        assert!(check_write_mode(Some(true), Some(true)).is_err());
    }

    #[test]
    fn single_write_modes_are_allowed() {
        assert!(check_write_mode(None, None).is_ok());
        assert!(check_write_mode(Some(true), None).is_ok());
        assert!(check_write_mode(Some(false), Some(true)).is_ok());
        assert!(check_write_mode(Some(true), Some(false)).is_ok());
    }

    #[test]
    fn failed_final_reload_spares_live_prism_patches() {
        let mut changed = failed_apply_log("js-1".to_owned(), "JS".to_owned(), String::new());
        changed.success = true;
        changed.config_modified = true;
        changed.error = None;
        let mut prism = changed.clone();
        prism.script_id = "prism-1".to_owned();
        let mut unchanged = changed.clone();
        unchanged.config_modified = false;
        let failed = failed_apply_log("js-2".to_owned(), "JS 2".to_owned(), "boom".to_owned());
        let summary = failed_apply_log(String::new(), "hot-reload".to_owned(), String::new());

        let none = std::collections::HashSet::new();
        assert!(lost_by_failed_reload(&changed, &none));
        assert!(lost_by_failed_reload(&prism, &none));
        assert!(!lost_by_failed_reload(&unchanged, &none));
        assert!(!lost_by_failed_reload(&failed, &none));
        assert!(!lost_by_failed_reload(&summary, &none));

        let live: std::collections::HashSet<String> =
            std::iter::once("prism-1".to_owned()).collect();
        assert!(!lost_by_failed_reload(&prism, &live));
        assert!(lost_by_failed_reload(&changed, &live));
    }
}
