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
        sanitize_override_yaml, single_apply_reload_error, validate_override_url, OverrideExt,
    };

    #[test]
    fn validate_override_url_accepts_valid_http_https() {
        assert_eq!(
            validate_override_url("https://example.com/script.js").unwrap(),
            "https://example.com/script.js"
        );
        assert_eq!(
            validate_override_url("  http://example.org/rules.yaml  ").unwrap(),
            "http://example.org/rules.yaml"
        );
    }

    #[test]
    fn validate_override_url_rejects_invalid_schemes() {
        let err = validate_override_url("file:///etc/passwd").unwrap_err();
        assert!(err.contains("http:// or https://"), "unexpected error: {err}");

        let err = validate_override_url("ftp://example.com/file").unwrap_err();
        assert!(err.contains("http:// or https://"), "unexpected error: {err}");

        let err = validate_override_url("javascript:alert(1)").unwrap_err();
        assert!(err.contains("http:// or https://"), "unexpected error: {err}");
    }

    #[test]
    fn validate_override_url_rejects_empty_or_oversized() {
        let err = validate_override_url("   ").unwrap_err();
        assert!(err.contains("cannot be empty"), "unexpected error: {err}");

        let long_url = format!("https://example.com/{}", "a".repeat(2040));
        let err = validate_override_url(&long_url).unwrap_err();
        assert!(err.contains("exceeds maximum length"), "unexpected error: {err}");
    }

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

    #[test]
    fn single_apply_reports_a_refused_reload() {
        assert_eq!(single_apply_reload_error(None), None);
        assert_eq!(single_apply_reload_error(Some(204)), None);
        let refused = single_apply_reload_error(Some(400)).unwrap();
        assert!(refused.contains("refused the reload (HTTP 400)"));
        assert!(refused.contains("next reload"));
        let unanswered = single_apply_reload_error(Some(0)).unwrap();
        assert!(unanswered.contains("did not answer the reload"));
    }
}
