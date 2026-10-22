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
        check_write_mode, default_template_content, sanitize_override_yaml, OverrideExt,
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
    fn sanitize_override_yaml_strips_dangerous_keys() {
        let input = "script: evil.js\nexternal-controller-pipe: '\\\\.\\pipe\\evil'\nrules:\n  $append:\n    - DOMAIN,example.com,DIRECT\n";
        let sanitized = sanitize_override_yaml(input).expect("valid YAML");
        assert!(!sanitized.contains("script"));
        assert!(!sanitized.contains("external-controller-pipe"));
        assert!(sanitized.contains("DOMAIN,example.com,DIRECT"));
    }

    #[test]
    fn sanitize_override_yaml_preserves_clean_content() {
        let input = "rules:\n  $prepend:\n    - DOMAIN-SUFFIX,google.com,DIRECT\n";
        let sanitized = sanitize_override_yaml(input).expect("valid YAML");
        assert_eq!(sanitized, input);
    }

    #[test]
    fn sanitize_override_yaml_rejects_invalid_yaml() {
        let input = "rules: [unclosed\n";
        assert!(sanitize_override_yaml(input).is_err());
    }
}
