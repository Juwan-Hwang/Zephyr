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
    fn sanitize_override_yaml_strips_dangerous_keys() {
        let dirty = r"
script: evil.js
external-controller-unix: /tmp/mihomo.sock
external-ui: /tmp/ui
proxy-providers:
  p1:
    type: http
    url: https://example.com/p1.yaml
    path: /etc/passwd
rules:
  $prepend:
    - DOMAIN,example.com,DIRECT
";
        let clean = sanitize_override_yaml(dirty).expect("should sanitize valid YAML");
        assert!(
            !clean.contains("script:"),
            "script key should be removed: {clean}"
        );
        assert!(
            !clean.contains("external-controller-unix:"),
            "external-controller key should be removed: {clean}"
        );
        assert!(
            !clean.contains("external-ui:"),
            "external-ui key should be removed: {clean}"
        );
        assert!(
            !clean.contains("/etc/passwd"),
            "provider path should be removed: {clean}"
        );
        assert!(
            clean.contains("example.com"),
            "rules should be preserved: {clean}"
        );
    }

    #[test]
    fn sanitize_override_yaml_preserves_clean_yaml() {
        let clean_yaml =
            "# Zephyr Prism Override\nrules:\n  $prepend:\n    - DOMAIN,example.com,DIRECT\n";
        assert_eq!(sanitize_override_yaml(clean_yaml).unwrap(), clean_yaml);
    }

    #[test]
    fn sanitize_override_yaml_rejects_invalid_yaml() {
        assert!(sanitize_override_yaml("rules: [unclosed").is_err());
    }

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
}
