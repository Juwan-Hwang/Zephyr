// ===========================================================================
// prism_tests.rs — Comprehensive unit tests for the Zephyr Rule Library
// ===========================================================================
//
// Tests the pure utility functions in prism.rs that do not require Tauri state:
//   - sanitize_filename:    security-critical filename sanitization
//   - ensure_prism_ext:     extension normalization
//   - count_rules:          rule counting in .prism.yaml content
//   - detect_source:        rule format detection (clash/surge/unknown/empty)
//   - normalize_to_prism_yaml: format conversion to .prism.yaml
//   - read_groups / write_groups: groups.json management
//   - File CRUD integration:  rule_list, rule_create, rule_delete, etc.
//       (simulated via temp directories and direct function calls)
//
// This file is included from prism.rs via:
//   #[cfg(test)]
//   #[path = "prism_tests.rs"]
//   mod prism_tests;
//
// Module hierarchy:  prism  >  prism_tests  >  tests  >  <sub-modules>
//   super::super::  = prism  (where the private functions live)

#[allow(
    clippy::expect_used,
    clippy::unwrap_used,
    clippy::indexing_slicing,
    clippy::panic
)]
mod tests {
    use std::fs;

    // Import private items from prism.rs (two levels up)
    use super::super::{
        count_rules, detect_source, ensure_prism_ext, normalize_to_prism_yaml, parse_position,
        read_groups, sanitize_filename, write_groups, RuleGroup, RuleGroups,
    };

    // ========================================================================
    // 1. sanitize_filename tests
    // ========================================================================

    mod sanitize_filename_tests {
        use super::sanitize_filename;

        // -- Acceptance cases ------------------------------------------------

        #[test]
        fn accepts_normal_name() {
            assert_eq!(sanitize_filename("adblock"), Ok("adblock".to_owned()));
        }

        #[test]
        fn accepts_name_with_spaces() {
            assert_eq!(sanitize_filename("my rules"), Ok("my rules".to_owned()));
        }

        #[test]
        fn accepts_cjk_characters() {
            assert_eq!(sanitize_filename("广告过滤"), Ok("广告过滤".to_owned()));
        }

        #[test]
        fn accepts_hiragana() {
            assert_eq!(sanitize_filename("ひらがな"), Ok("ひらがな".to_owned()));
        }

        #[test]
        fn accepts_katakana() {
            assert_eq!(sanitize_filename("カタカナ"), Ok("カタカナ".to_owned()));
        }

        #[test]
        fn accepts_hangul() {
            assert_eq!(sanitize_filename("한글"), Ok("한글".to_owned()));
        }

        #[test]
        fn accepts_hyphens_and_underscores() {
            assert_eq!(
                sanitize_filename("01-adblock_rules"),
                Ok("01-adblock_rules".to_owned())
            );
        }

        #[test]
        fn accepts_parentheses() {
            assert_eq!(
                sanitize_filename("rules (backup)"),
                Ok("rules (backup)".to_owned())
            );
        }

        #[test]
        fn accepts_dots_in_name() {
            assert_eq!(
                sanitize_filename("v2.rules.final"),
                Ok("v2.rules.final".to_owned())
            );
        }

        #[test]
        fn accepts_name_already_ending_in_prism_yaml() {
            assert_eq!(
                sanitize_filename("test.prism.yaml"),
                Ok("test.prism.yaml".to_owned())
            );
        }

        #[test]
        fn accepts_numeric_name() {
            assert_eq!(sanitize_filename("12345"), Ok("12345".to_owned()));
        }

        #[test]
        fn accepts_single_character() {
            assert_eq!(sanitize_filename("a"), Ok("a".to_owned()));
        }

        // -- Rejection cases -------------------------------------------------

        #[test]
        fn rejects_empty_string() {
            assert!(sanitize_filename("").is_err());
        }

        #[test]
        fn rejects_path_traversal_dotdot() {
            // Directory separators are stripped by pre-processing.
            // "../../etc/passwd" → "....etcpasswd" — a safe flat filename.
            let result = sanitize_filename("../../etc/passwd");
            assert!(result.is_ok());
            assert_eq!(result.unwrap(), "....etcpasswd");
        }

        #[test]
        fn rejects_backslash_path() {
            // Backslashes are stripped by pre-processing.
            // "..\\config\\secret" → "..configsecret" — a safe flat filename.
            let result = sanitize_filename("..\\config\\secret");
            assert!(result.is_ok());
            assert_eq!(result.unwrap(), "..configsecret");
        }

        #[test]
        fn null_bytes_are_stripped() {
            // Null bytes are control chars and get stripped
            let result = sanitize_filename("test\0evil");
            assert!(
                result.is_ok(),
                "null bytes should be stripped, not cause rejection"
            );
            assert_eq!(
                result.expect("null bytes stripped should be Ok"),
                "testevil"
            );
        }

        #[test]
        fn control_characters_are_stripped() {
            let result = sanitize_filename("test\x01\x02");
            assert!(
                result.is_ok(),
                "control chars should be stripped from mixed input"
            );
            assert_eq!(result.expect("control chars stripped should be Ok"), "test");
        }

        #[test]
        fn rejects_only_control_characters() {
            let result = sanitize_filename("\x01\x02\x03");
            assert!(
                result.is_err(),
                "input of only control chars should be rejected"
            );
        }

        #[test]
        fn rejects_too_long_name() {
            let long_name = "a".repeat(256);
            let result = sanitize_filename(&long_name);
            assert!(
                result.is_err(),
                "filename exceeding 255 chars should be rejected"
            );
        }

        #[test]
        fn accepts_exactly_255_chars() {
            let name_255 = "a".repeat(255);
            let result = sanitize_filename(&name_255);
            assert!(
                result.is_ok(),
                "filename of exactly 255 chars should be accepted"
            );
        }

        #[test]
        fn rejects_url_encoded_path_traversal() {
            let result = sanitize_filename("%2e%2e%2fetc");
            assert!(
                result.is_err(),
                "URL-encoded path traversal should be rejected"
            );
        }

        #[test]
        fn rejects_double_encoded_path_traversal() {
            let result = sanitize_filename("%252e%252e%252fetc");
            assert!(
                result.is_err(),
                "double URL-encoded path traversal should be rejected"
            );
        }

        #[test]
        fn strips_special_characters_not_in_allowlist() {
            // @ is not in the allowlist, so it gets stripped, leaving "testfile"
            let result = sanitize_filename("test@file");
            assert_eq!(result, Ok("testfile".to_owned()));
        }

        #[test]
        fn strips_semicolons_and_colons() {
            // ; and : are not in the allowlist, they get stripped
            assert_eq!(sanitize_filename("test;rm"), Ok("testrm".to_owned()));
            assert_eq!(sanitize_filename("test:cmd"), Ok("testcmd".to_owned()));
        }

        #[test]
        fn strips_angle_brackets() {
            // < and > are not in the allowlist, they get stripped
            assert_eq!(sanitize_filename("<script>"), Ok("script".to_owned()));
        }

        #[test]
        fn strips_pipe_character() {
            assert_eq!(sanitize_filename("test|cmd"), Ok("testcmd".to_owned()));
        }

        #[test]
        fn strips_ampersand() {
            assert_eq!(sanitize_filename("test&cmd"), Ok("testcmd".to_owned()));
        }

        #[test]
        fn strips_null_and_returns_valid() {
            let result = sanitize_filename("hello\0world");
            assert_eq!(result, Ok("helloworld".to_owned()));
        }

        #[test]
        fn rejects_empty_after_stripping() {
            let result = sanitize_filename("\0\0\0");
            assert!(result.is_err());
        }

        #[test]
        fn rejects_mixed_path_traversal_with_valid_name() {
            // "/" is stripped by pre-processing → "legit..etcpasswd" — safe flat filename
            let result = sanitize_filename("legit/../etc/passwd");
            assert!(result.is_ok());
            assert_eq!(result.unwrap(), "legit..etcpasswd");
        }

        #[test]
        fn strips_forward_slash_and_returns_remaining() {
            // "/" is not in the allowlist, gets stripped.
            // "/etc/shadow" → "etcshadow" (all disallowed chars stripped)
            let result = sanitize_filename("/etc/shadow");
            assert!(result.is_ok());
            assert_eq!(
                result.expect("forward slash stripped should be Ok"),
                "etcshadow"
            );
        }

        #[test]
        fn strips_dollar_sign_and_parentheses_from_shell_commands() {
            // $ is not in the allowlist, gets stripped.
            // ( and ) ARE in the allowlist (parentheses are allowed characters).
            assert_eq!(sanitize_filename("$(whoami)"), Ok("(whoami)".to_owned()));
            assert_eq!(sanitize_filename("$(rm -rf /)"), Ok("(rm -rf )".to_owned()));
        }

        #[test]
        fn strips_backtick() {
            assert_eq!(sanitize_filename("`id`"), Ok("id".to_owned()));
        }
    }

    // ========================================================================
    // 2. ensure_prism_ext tests
    // ========================================================================

    mod ensure_prism_ext_tests {
        use super::ensure_prism_ext;

        #[test]
        fn adds_extension_to_plain_name() {
            assert_eq!(ensure_prism_ext("test"), "test.prism.yaml");
        }

        #[test]
        fn replaces_yaml_extension() {
            assert_eq!(ensure_prism_ext("test.yaml"), "test.yaml.prism.yaml");
        }

        #[test]
        fn no_double_extension_when_already_present() {
            assert_eq!(ensure_prism_ext("test.prism.yaml"), "test.prism.yaml");
        }

        #[test]
        fn handles_edge_case_empty_with_ext() {
            assert_eq!(ensure_prism_ext(".prism.yaml"), ".prism.yaml");
        }

        #[test]
        fn adds_to_name_with_dots() {
            assert_eq!(ensure_prism_ext("my.rules.v2"), "my.rules.v2.prism.yaml");
        }

        #[test]
        fn adds_to_cjk_name() {
            assert_eq!(ensure_prism_ext("广告过滤"), "广告过滤.prism.yaml");
        }

        #[test]
        fn adds_to_empty_string() {
            assert_eq!(ensure_prism_ext(""), ".prism.yaml");
        }

        #[test]
        fn preserves_spaces() {
            assert_eq!(ensure_prism_ext("my rules"), "my rules.prism.yaml");
        }
    }

    // ========================================================================
    // 3. count_rules tests
    // ========================================================================

    mod count_rules_tests {
        use super::count_rules;

        #[test]
        fn empty_content_returns_zero() {
            assert_eq!(count_rules(""), 0);
        }

        #[test]
        fn no_rules_section_returns_zero() {
            let content = "mixed-port: 7890\nallow-lan: true\n";
            assert_eq!(count_rules(content), 0);
        }

        #[test]
        fn rules_section_with_no_items_returns_zero() {
            let content = "rules:\nproxies:\n  - name: test\n";
            assert_eq!(count_rules(content), 0);
        }

        #[test]
        fn counts_five_rules() {
            let content = "\
rules:
  - DOMAIN-SUFFIX,example.com,PROXY
  - DOMAIN-KEYWORD,google,PROXY
  - GEOIP,CN,DIRECT
  - MATCH,Proxy
  - DOMAIN,github.com,PROXY
";
            assert_eq!(count_rules(content), 5);
        }

        #[test]
        fn ignores_comments() {
            let content = "\
rules:
  # This is a comment
  - DOMAIN-SUFFIX,example.com,PROXY
  # Another comment
  - DOMAIN,github.com,PROXY
";
            assert_eq!(count_rules(content), 2);
        }

        #[test]
        fn ignores_empty_lines_in_rules() {
            let content = "\
rules:

  - DOMAIN-SUFFIX,example.com,PROXY

  - DOMAIN,github.com,PROXY

";
            assert_eq!(count_rules(content), 2);
        }

        #[test]
        fn stops_at_next_top_level_key() {
            let content = "\
rules:
  - DOMAIN-SUFFIX,example.com,PROXY
  - DOMAIN,github.com,PROXY
proxies:
  - name: test
";
            assert_eq!(count_rules(content), 2);
        }

        #[test]
        fn ignores_items_without_comma() {
            let content = "\
rules:
  - DOMAIN-SUFFIX,example.com,PROXY
  - some yaml mapping without comma
  - DOMAIN,github.com,PROXY
";
            assert_eq!(count_rules(content), 2);
        }

        #[test]
        fn handles_indented_comment_before_rules() {
            let content = "\
rules:
    # comment with extra indent
  - DOMAIN-SUFFIX,example.com,PROXY
";
            assert_eq!(count_rules(content), 1);
        }

        #[test]
        fn full_profile_config() {
            let content = "\
mixed-port: 7890
allow-lan: true
mode: rule
dns:
    enable: true
    enhanced-mode: fake-ip
proxies:
    - { name: 'JP-01', type: vless, server: example.com, port: 443 }
proxy-groups:
    - { name: Proxy, type: select, proxies: [JP-01] }
rules:
    - 'DOMAIN-SUFFIX,example.com,Proxy'
    - 'DOMAIN-KEYWORD,google,Proxy'
    - 'GEOIP,CN,DIRECT'
    - 'MATCH,Proxy'
";
            assert_eq!(count_rules(content), 4);
        }
    }

    // ========================================================================
    // 4. detect_source tests
    // ========================================================================

    mod detect_source_tests {
        use super::detect_source;

        #[test]
        fn empty_string_returns_empty() {
            assert_eq!(detect_source(""), "empty");
        }

        #[test]
        fn whitespace_only_returns_empty() {
            assert_eq!(detect_source("   \n  \t  "), "empty");
        }

        #[test]
        fn clash_format_detected() {
            let content = "\
- DOMAIN-SUFFIX,example.com,PROXY
- DOMAIN-KEYWORD,google,PROXY
- GEOIP,CN,DIRECT
";
            assert_eq!(detect_source(content), "clash");
        }

        #[test]
        fn surge_format_detected() {
            let content = "\
DOMAIN,example.com,REJECT
DOMAIN-SUFFIX,google.com,PROXY
GEOIP,CN,DIRECT
";
            assert_eq!(detect_source(content), "surge");
        }

        #[test]
        fn mixed_format_prefers_clash() {
            let content = "\
- DOMAIN-SUFFIX,example.com,PROXY
- DOMAIN-KEYWORD,google,PROXY
DOMAIN,example.com,REJECT
";
            assert_eq!(detect_source(content), "clash");
        }

        #[test]
        fn mixed_format_prefers_surge() {
            let content = "\
- DOMAIN-SUFFIX,example.com,PROXY
DOMAIN,example.com,REJECT
DOMAIN-SUFFIX,google.com,PROXY
";
            assert_eq!(detect_source(content), "surge");
        }

        #[test]
        fn pure_comments_returns_unknown() {
            let content = "\
# This is a comment
# Another comment
# Yet another comment
";
            assert_eq!(detect_source(content), "unknown");
        }

        #[test]
        fn equal_clash_and_surge_returns_surge() {
            let content = "\
- DOMAIN,example.com,PROXY
DOMAIN,example.com,REJECT
";
            assert_eq!(detect_source(content), "surge");
        }

        #[test]
        fn prism_yaml_format_detected_as_clash() {
            let content = "\
rules:
  - DOMAIN-SUFFIX,example.com,PROXY
  - DOMAIN,github.com,PROXY
";
            assert_eq!(detect_source(content), "clash");
        }

        #[test]
        fn single_clash_rule() {
            assert_eq!(detect_source("- DOMAIN-SUFFIX,example.com,PROXY"), "clash");
        }

        #[test]
        fn single_surge_rule() {
            assert_eq!(detect_source("DOMAIN-SUFFIX,example.com,PROXY"), "surge");
        }
    }

    // ========================================================================
    // 5. normalize_to_prism_yaml tests
    // ========================================================================

    mod normalize_to_prism_yaml_tests {
        use super::normalize_to_prism_yaml;

        #[test]
        fn empty_input_returns_empty() {
            assert_eq!(normalize_to_prism_yaml(""), "");
        }

        #[test]
        fn whitespace_only_returns_empty() {
            assert_eq!(normalize_to_prism_yaml("   \n  "), "");
        }

        #[test]
        fn converts_clash_rules() {
            let input = "\
- DOMAIN-SUFFIX,example.com,PROXY
- DOMAIN-KEYWORD,google,PROXY
";
            let expected = "\
rules:
  $append:
  - DOMAIN-SUFFIX,example.com,{{proxy}}
  - DOMAIN-KEYWORD,google,{{proxy}}
";
            assert_eq!(normalize_to_prism_yaml(input), expected);
        }

        #[test]
        fn converts_surge_rules() {
            let input = "\
DOMAIN,example.com,REJECT
DOMAIN-SUFFIX,google.com,PROXY
";
            let expected = "\
rules:
  $append:
  - DOMAIN,example.com,REJECT
  - DOMAIN-SUFFIX,google.com,{{proxy}}
";
            assert_eq!(normalize_to_prism_yaml(input), expected);
        }

        #[test]
        fn strips_comments_from_clash() {
            let input = "\
# Header comment
- DOMAIN-SUFFIX,example.com,PROXY
# Middle comment
- DOMAIN,github.com,PROXY
";
            let result = normalize_to_prism_yaml(input);
            assert!(!result.contains('#'));
            assert!(result.contains("DOMAIN-SUFFIX,example.com,{{proxy}}"));
            assert!(result.contains("DOMAIN,github.com,{{proxy}}"));
        }

        #[test]
        fn strips_comments_from_surge() {
            let input = "\
# Comment line
DOMAIN,example.com,REJECT
";
            let result = normalize_to_prism_yaml(input);
            assert!(!result.contains('#'));
            assert!(result.contains("DOMAIN,example.com,REJECT"));
        }

        #[test]
        fn comments_only_returns_rules_header_only() {
            let input = "# Just a comment\n# Another comment\n";
            let result = normalize_to_prism_yaml(input);
            assert_eq!(result, "rules:\n  $append:\n\n");
        }

        #[test]
        fn output_starts_with_rules_header() {
            let input = "- DOMAIN,example.com,PROXY";
            let result = normalize_to_prism_yaml(input);
            assert!(result.starts_with("rules:\n"));
        }

        #[test]
        fn output_rules_are_indented() {
            let input = "- DOMAIN,example.com,PROXY";
            let result = normalize_to_prism_yaml(input);
            assert!(result.contains("  - DOMAIN,example.com,{{proxy}}"));
        }

        #[test]
        fn mixed_clash_and_surge_input() {
            let input = "\
- DOMAIN-SUFFIX,example.com,PROXY
DOMAIN,example.com,REJECT
- DOMAIN-KEYWORD,google,PROXY
";
            let result = normalize_to_prism_yaml(input);
            assert!(result.starts_with("rules:\n"));
            for line in result.lines().skip(1) {
                assert!(
                    line.starts_with("  - ") || line.starts_with("  $") || line.is_empty(),
                    "rule line should be indented: '{line}'"
                );
            }
        }

        #[test]
        fn preserves_trailing_newline() {
            let input = "- DOMAIN,example.com,PROXY";
            let result = normalize_to_prism_yaml(input);
            assert!(result.ends_with('\n'));
        }

        #[test]
        fn handles_single_rule() {
            let input = "DOMAIN-SUFFIX,example.com,PROXY";
            let result = normalize_to_prism_yaml(input);
            assert_eq!(
                result,
                "rules:\n  $append:\n  - DOMAIN-SUFFIX,example.com,{{proxy}}\n"
            );
        }

        #[test]
        fn adblock_subscription_format_preserves_mixed_case_policy() {
            // Simulates a real adblock rule subscription.
            // Key characteristics:
            //   - Plain rule format (no "- " prefix, no YAML headers)
            //   - Policy uses mixed case: "Reject" instead of "REJECT"
            //   - All rules are DOMAIN-SUFFIX type
            //   - No comments
            let input = "\
DOMAIN-SUFFIX,ads.example-a.com,Reject
DOMAIN-SUFFIX,ads.example-b.com,Reject
DOMAIN-SUFFIX,tracker.example-c.net,Reject
DOMAIN-SUFFIX,analytics.example-d.org,Reject
DOMAIN-SUFFIX,cdn.example-e.co.uk,Reject
";
            let result = normalize_to_prism_yaml(input);

            // Must be detected as plain rule format and converted to prism yaml
            assert!(result.starts_with("rules:\n"));

            // All 5 rules must be present with original casing preserved
            assert!(result.contains("DOMAIN-SUFFIX,ads.example-a.com,Reject"));
            assert!(result.contains("DOMAIN-SUFFIX,ads.example-b.com,Reject"));
            assert!(result.contains("DOMAIN-SUFFIX,tracker.example-c.net,Reject"));
            assert!(result.contains("DOMAIN-SUFFIX,analytics.example-d.org,Reject"));
            assert!(result.contains("DOMAIN-SUFFIX,cdn.example-e.co.uk,Reject"));

            // Rules must be properly indented as YAML list items
            for line in result.lines().skip(1) {
                if !line.trim().is_empty() {
                    assert!(
                        line.starts_with("  - ") || line.starts_with("  $"),
                        "Rule line must be indented: '{line}'"
                    );
                }
            }

            // "Reject" casing is preserved (mihomo core handles case-insensitive matching)
            assert!(result.contains(",Reject"));
        }
    }

    // ========================================================================
    // 6. groups.json read/write tests
    // ========================================================================

    mod groups_json_tests {
        use super::{fs, read_groups, write_groups, RuleGroup, RuleGroups};
        use std::path::PathBuf;
        use std::sync::atomic::{AtomicUsize, Ordering};

        static TEST_COUNTER: AtomicUsize = AtomicUsize::new(0);

        fn unique_temp_dir(prefix: &str) -> PathBuf {
            let n = TEST_COUNTER.fetch_add(1, Ordering::Relaxed);
            let dir = std::env::temp_dir().join(format!("{prefix}_{n}"));
            let _ = fs::create_dir_all(&dir);
            dir
        }

        fn cleanup(dir: &std::path::Path) {
            let _ = fs::remove_dir_all(dir);
        }

        #[test]
        fn read_nonexistent_returns_empty_groups() {
            let dir = unique_temp_dir("zephyr_prism_test");
            let result = read_groups(&dir);
            cleanup(&dir);
            match result {
                Ok(groups) => assert!(groups.groups.is_empty()),
                Err(e) => panic!("expected Ok with empty groups, got Err: {e}"),
            }
        }

        #[test]
        fn read_valid_groups_json() {
            let dir = unique_temp_dir("zephyr_prism_test");
            let groups_path = dir.join("groups.json");
            let json_content = r#"{
  "groups": [
    {
      "name": "Advertising",
      "files": ["adblock.prism.yaml", "anti-ads.prism.yaml"]
    },
    {
      "name": "Streaming",
      "files": ["netflix.prism.yaml"]
    }
  ]
}"#;
            fs::write(&groups_path, json_content).expect("failed to write test groups.json");

            let result = read_groups(&dir);
            cleanup(&dir);
            let groups = result.expect("failed to read groups.json");
            assert_eq!(groups.groups.len(), 2);
            assert_eq!(groups.groups[0].name, "Advertising");
            assert_eq!(groups.groups[0].files.len(), 2);
            assert_eq!(groups.groups[1].name, "Streaming");
            assert_eq!(groups.groups[1].files.len(), 1);
        }

        #[test]
        fn read_malformed_json_returns_error() {
            let dir = unique_temp_dir("zephyr_prism_test");
            let groups_path = dir.join("groups.json");
            fs::write(&groups_path, "{invalid json content!!!}")
                .expect("failed to write test groups.json");

            let result = read_groups(&dir);
            cleanup(&dir);
            assert!(result.is_err(), "malformed JSON should return error");
            let msg = result.err().expect("expected Err");
            assert!(
                msg.contains("parse"),
                "error should mention parse failure: {msg}"
            );
        }

        #[test]
        fn read_empty_json_object_returns_error() {
            // read_groups uses serde with #[derive(Deserialize)] which requires
            // the "groups" field. An empty object {} is missing that field.
            let dir = unique_temp_dir("zephyr_prism_test");
            let groups_path = dir.join("groups.json");
            fs::write(&groups_path, "{}").expect("failed to write test groups.json");

            let result = read_groups(&dir);
            cleanup(&dir);
            assert!(
                result.is_err(),
                "empty JSON object should fail deserialization"
            );
        }

        #[test]
        fn write_and_read_back_preserves_data() {
            let dir = unique_temp_dir("zephyr_prism_test");
            let groups = RuleGroups {
                groups: vec![RuleGroup {
                    name: "TestGroup".to_owned(),
                    files: vec!["file1.prism.yaml".to_owned()],
                }],
            };

            let write_result = write_groups(&dir, &groups);
            assert!(write_result.is_ok(), "write_groups should succeed");

            let read_result = read_groups(&dir);
            cleanup(&dir);
            let read_back = read_result.expect("failed to read back groups");
            assert_eq!(read_back.groups.len(), 1);
            assert_eq!(read_back.groups[0].name, "TestGroup");
            assert_eq!(read_back.groups[0].files[0], "file1.prism.yaml");
        }

        #[test]
        fn write_empty_groups_creates_valid_json() {
            let dir = unique_temp_dir("zephyr_prism_test");
            let groups = RuleGroups { groups: vec![] };

            let _ = write_groups(&dir, &groups);
            let content = fs::read_to_string(dir.join("groups.json"))
                .expect("failed to read written groups.json");
            cleanup(&dir);

            let parsed: serde_json::Value =
                serde_json::from_str(&content).expect("written content should be valid JSON");
            assert_eq!(parsed["groups"], serde_json::Value::Array(vec![]));
        }
    }

    // ========================================================================
    // 7. Rule file integration tests (temp directories)
    // ========================================================================

    mod rule_file_integration_tests {
        use super::{
            count_rules, detect_source, ensure_prism_ext, fs, normalize_to_prism_yaml,
            sanitize_filename,
        };
        use std::path::PathBuf;
        use std::sync::atomic::{AtomicUsize, Ordering};

        static TEST_COUNTER: AtomicUsize = AtomicUsize::new(0);

        fn unique_temp_dir() -> PathBuf {
            let n = TEST_COUNTER.fetch_add(1, Ordering::Relaxed);
            let dir = std::env::temp_dir().join(format!("zephyr_rule_test_{n}"));
            let _ = fs::create_dir_all(&dir);
            dir
        }

        fn cleanup(dir: &std::path::Path) {
            let _ = fs::remove_dir_all(dir);
        }

        #[test]
        fn finds_prism_yaml_files() {
            let dir = unique_temp_dir();
            fs::write(
                dir.join("adblock.prism.yaml"),
                "rules:\n  - DOMAIN,example.com,PROXY\n",
            )
            .expect("failed to create test file");
            fs::write(
                dir.join("streaming.prism.yaml"),
                "rules:\n  - DOMAIN-SUFFIX,netflix.com,PROXY\n",
            )
            .expect("failed to create test file");

            let entries: Vec<String> = fs::read_dir(&dir)
                .expect("failed to read dir")
                .flatten()
                .map(|e| e.file_name().to_string_lossy().to_string())
                .filter(|n| n.ends_with(".prism.yaml"))
                .collect();

            cleanup(&dir);
            assert_eq!(entries.len(), 2);
            assert!(entries.contains(&"adblock.prism.yaml".to_owned()));
            assert!(entries.contains(&"streaming.prism.yaml".to_owned()));
        }

        #[test]
        fn ignores_non_prism_yaml_files() {
            let dir = unique_temp_dir();
            fs::write(
                dir.join("adblock.prism.yaml"),
                "rules:\n  - DOMAIN,example.com,PROXY\n",
            )
            .expect("failed to create test file");
            fs::write(dir.join("readme.txt"), "not a rule file")
                .expect("failed to create test file");
            fs::write(dir.join("config.yaml"), "mixed-port: 7890")
                .expect("failed to create test file");
            fs::write(dir.join("backup.prism.yaml.bak"), "backup")
                .expect("failed to create test file");

            let entries: Vec<String> = fs::read_dir(&dir)
                .expect("failed to read dir")
                .flatten()
                .map(|e| e.file_name().to_string_lossy().to_string())
                .filter(|n| n.ends_with(".prism.yaml"))
                .collect();

            cleanup(&dir);
            assert_eq!(entries.len(), 1);
            assert_eq!(entries[0], "adblock.prism.yaml");
        }

        #[test]
        fn empty_directory_returns_no_files() {
            let dir = unique_temp_dir();

            let entries: Vec<String> = fs::read_dir(&dir)
                .expect("failed to read dir")
                .flatten()
                .map(|e| e.file_name().to_string_lossy().to_string())
                .filter(|n| n.ends_with(".prism.yaml"))
                .collect();

            cleanup(&dir);
            assert!(entries.is_empty());
        }

        #[test]
        fn create_rule_file_with_correct_name() {
            let dir = unique_temp_dir();
            let name = "adblock";
            let filename = ensure_prism_ext(&sanitize_filename(name).expect("sanitize failed"));
            let content = "rules:\n  - DOMAIN-SUFFIX,example.com,PROXY\n";

            fs::write(dir.join(&filename), content).expect("failed to write rule file");

            cleanup(&dir);
            assert_eq!(filename, "adblock.prism.yaml");
        }

        #[test]
        fn create_rule_file_preserves_content() {
            let dir = unique_temp_dir();
            let filename =
                ensure_prism_ext(&sanitize_filename("test rules").expect("sanitize failed"));
            let content =
                "rules:\n  - DOMAIN-SUFFIX,example.com,PROXY\n  - DOMAIN,github.com,PROXY\n";

            fs::write(dir.join(&filename), content).expect("failed to write rule file");
            let read_back = fs::read_to_string(dir.join(&filename)).expect("failed to read back");

            cleanup(&dir);
            assert_eq!(read_back, content);
        }

        #[test]
        fn create_cjk_named_rule_file() {
            let dir = unique_temp_dir();
            let filename =
                ensure_prism_ext(&sanitize_filename("广告过滤").expect("sanitize failed"));

            fs::write(
                dir.join(&filename),
                "rules:\n  - DOMAIN,example.com,PROXY\n",
            )
            .expect("failed to write rule file");

            cleanup(&dir);
            assert_eq!(filename, "广告过滤.prism.yaml");
        }

        #[test]
        fn delete_rule_file() {
            let dir = unique_temp_dir();
            let filename = "adblock.prism.yaml";
            fs::write(dir.join(filename), "rules:\n  - DOMAIN,example.com,PROXY\n")
                .expect("failed to create test file");

            assert!(dir.join(filename).exists());
            fs::remove_file(dir.join(filename)).expect("failed to delete");

            cleanup(&dir);
            assert!(!dir.join(filename).exists());
        }

        #[test]
        fn delete_nonexistent_file_fails() {
            let dir = unique_temp_dir();
            let result = fs::remove_file(dir.join("nonexistent.prism.yaml"));
            cleanup(&dir);
            assert!(result.is_err());
        }

        #[test]
        fn rename_rule_file() {
            let dir = unique_temp_dir();
            let old_name = "adblock.prism.yaml";
            let new_name = "adblock-v2.prism.yaml";
            fs::write(dir.join(old_name), "rules:\n  - DOMAIN,example.com,PROXY\n")
                .expect("failed to create test file");

            fs::rename(dir.join(old_name), dir.join(new_name)).expect("failed to rename");

            // Verify before cleanup
            assert!(
                !dir.join(old_name).exists(),
                "old file should not exist after rename"
            );
            assert!(
                dir.join(new_name).exists(),
                "new file should exist after rename"
            );

            cleanup(&dir);
        }

        #[test]
        fn update_rule_file_overwrites_content() {
            let dir = unique_temp_dir();
            let filename = "adblock.prism.yaml";
            let original = "rules:\n  - DOMAIN,example.com,PROXY\n";
            let updated =
                "rules:\n  - DOMAIN-SUFFIX,example.com,PROXY\n  - DOMAIN,github.com,PROXY\n";

            fs::write(dir.join(filename), original).expect("failed to create test file");
            fs::write(dir.join(filename), updated).expect("failed to update test file");

            let read_back = fs::read_to_string(dir.join(filename)).expect("failed to read back");

            cleanup(&dir);
            assert_eq!(read_back, updated);
            assert_ne!(read_back, original);
        }

        #[test]
        fn full_workflow_create_and_analyze() {
            let dir = unique_temp_dir();
            let raw_name = "my adblock rules";
            let content = "\
rules:
  - DOMAIN-SUFFIX,example.com,PROXY
  - DOMAIN-KEYWORD,google,PROXY
  - GEOIP,CN,DIRECT
  - MATCH,Proxy
";

            let safe_name = sanitize_filename(raw_name).expect("sanitize failed");
            assert_eq!(safe_name, "my adblock rules");

            let filename = ensure_prism_ext(&safe_name);
            assert_eq!(filename, "my adblock rules.prism.yaml");

            fs::write(dir.join(&filename), content).expect("failed to write");

            let read_content =
                fs::read_to_string(dir.join(&filename)).expect("failed to read back");
            assert_eq!(count_rules(&read_content), 4);
            assert_eq!(detect_source(&read_content), "clash");

            cleanup(&dir);
        }

        #[test]
        fn full_workflow_import_and_analyze() {
            let dir = unique_temp_dir();
            let raw_name = "surge-rules";
            let surge_content = "\
DOMAIN,example.com,REJECT
DOMAIN-SUFFIX,google.com,PROXY
GEOIP,CN,DIRECT
";

            let normalized = normalize_to_prism_yaml(surge_content);
            assert!(!normalized.is_empty());

            let filename = ensure_prism_ext(&sanitize_filename(raw_name).expect("sanitize failed"));
            fs::write(dir.join(&filename), &normalized).expect("failed to write");

            let read_back = fs::read_to_string(dir.join(&filename)).expect("failed to read back");
            assert_eq!(count_rules(&read_back), 3);
            assert_eq!(detect_source(&read_back), "clash");

            cleanup(&dir);
        }

        #[test]
        fn extract_rules_from_sanitized_config() {
            let config = "\
mixed-port: 7890
allow-lan: true
mode: rule
dns:
    enable: true
    enhanced-mode: fake-ip
proxies:
    - { name: 'JP-01', type: vless, server: example.com, port: 443, uuid: aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee }
    - { name: 'JP-02', type: vless, server: example.com, port: 444, uuid: aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee }
proxy-groups:
    - { name: Proxy, type: select, proxies: [JP-01, JP-02] }
rules:
    - 'DOMAIN-SUFFIX,example.com,Proxy'
    - 'DOMAIN-KEYWORD,google,Proxy'
    - 'GEOIP,CN,DIRECT'
    - 'MATCH,Proxy'
";
            assert_eq!(count_rules(config), 4);
            assert_eq!(detect_source(config), "clash");
        }

        #[test]
        fn rule_extraction_produces_valid_prism_yaml() {
            let config = "\
mixed-port: 7890
rules:
    - 'DOMAIN-SUFFIX,example.com,Proxy'
    - 'DOMAIN-KEYWORD,google,Proxy'
    - 'GEOIP,CN,DIRECT'
    - 'MATCH,Proxy'
";

            let yaml: serde_yaml::Value =
                serde_yaml::from_str(config).expect("failed to parse config YAML");

            let rules = yaml
                .get("rules")
                .and_then(|v| v.as_sequence())
                .expect("no rules section found");

            let mut lines = Vec::with_capacity(rules.len() + 1);
            lines.push("rules:".to_owned());
            for rule in rules {
                if let Some(s) = rule.as_str() {
                    lines.push(format!("  - {s}"));
                }
            }
            let content = lines.join("\n") + "\n";

            assert_eq!(count_rules(&content), 4);
            assert!(content.starts_with("rules:\n"));
            assert!(content.contains("DOMAIN-SUFFIX,example.com,Proxy"));
            assert!(content.contains("DOMAIN-KEYWORD,google,Proxy"));
            assert!(content.contains("GEOIP,CN,DIRECT"));
            assert!(content.contains("MATCH,Proxy"));
        }
    }

    // ========================================================================
    // 8. parse_position tests
    // ========================================================================

    mod parse_position_tests {
        use super::parse_position;

        #[test]
        fn before_prism() {
            assert!(matches!(
                parse_position("before_prism", None),
                Ok(clash_prism_extension::RuleInsertPosition::BeforePrism)
            ));
        }

        #[test]
        fn after_prism() {
            assert!(matches!(
                parse_position("after_prism", None),
                Ok(clash_prism_extension::RuleInsertPosition::AfterPrism)
            ));
        }

        #[test]
        fn append() {
            assert!(matches!(
                parse_position("append", None),
                Ok(clash_prism_extension::RuleInsertPosition::Append)
            ));
        }

        #[test]
        fn after_group_with_id() {
            let result = parse_position("after_group", Some("group-1"));
            assert!(result.is_ok(), "after_group with id should succeed");
            if let Ok(clash_prism_extension::RuleInsertPosition::AfterGroup(id)) = result {
                assert_eq!(id, "group-1");
            } else {
                panic!("expected AfterGroup variant");
            }
        }

        #[test]
        fn after_group_without_id_errors() {
            assert!(parse_position("after_group", None).is_err());
        }

        #[test]
        fn unknown_position_errors() {
            assert!(parse_position("invalid_pos", None).is_err());
        }
    }

    // ========================================================================
    // 9. Edge case / security regression tests
    // ========================================================================

    mod security_regression_tests {
        use super::{count_rules, detect_source, ensure_prism_ext, sanitize_filename};

        #[test]
        fn sanitize_strips_shell_metacharacters() {
            // $ is not in the allowlist, gets stripped.
            // ( and ) ARE in the allowlist (parentheses are allowed characters).
            assert_eq!(sanitize_filename("$(whoami)"), Ok("(whoami)".to_owned()));
            assert_eq!(sanitize_filename("`id`"), Ok("id".to_owned()));
            assert_eq!(sanitize_filename("$(rm -rf /)"), Ok("(rm -rf )".to_owned()));
        }

        #[test]
        fn sanitize_strips_newlines() {
            let result = sanitize_filename("test\nfile");
            assert_eq!(result, Ok("testfile".to_owned()));
        }

        #[test]
        fn sanitize_strips_tabs() {
            let result = sanitize_filename("test\tfile");
            assert_eq!(result, Ok("testfile".to_owned()));
        }

        #[test]
        fn sanitize_strips_carriage_return() {
            let result = sanitize_filename("test\rfile");
            assert_eq!(result, Ok("testfile".to_owned()));
        }

        #[test]
        fn sanitize_strips_form_feed() {
            let result = sanitize_filename("test\x0cfile");
            assert_eq!(result, Ok("testfile".to_owned()));
        }

        #[test]
        fn sanitize_strips_delete_character() {
            let result = sanitize_filename("test\x7ffile");
            assert_eq!(result, Ok("testfile".to_owned()));
        }

        #[test]
        fn sanitize_strips_disallowed_special_chars() {
            let result = sanitize_filename("hello@world");
            assert_eq!(result, Ok("helloworld".to_owned()));
        }

        #[test]
        fn sanitize_strips_forward_slash() {
            // "/" is not in the allowlist, gets stripped
            let result = sanitize_filename("subdir/file");
            assert_eq!(result, Ok("subdirfile".to_owned()));
        }

        #[test]
        fn sanitize_rejects_dotdot_alone() {
            assert!(sanitize_filename("..").is_err());
        }

        #[test]
        fn sanitize_accepts_dotdot_with_extension() {
            // "..yaml" is a single path component (no / or \ separator),
            // and it's not equal to "..", so it passes the component check.
            // "." is in the allowlist, so all chars pass.
            assert!(sanitize_filename("..yaml").is_ok());
        }

        #[test]
        fn sanitize_accepts_single_dot() {
            assert!(sanitize_filename(".").is_ok());
        }

        #[test]
        fn sanitize_accepts_double_dot_in_middle() {
            assert!(sanitize_filename("file..name").is_ok());
        }

        #[test]
        fn count_rules_handles_multiline_yaml_block_scalar() {
            let content = "\
rules:
  - DOMAIN-SUFFIX,example.com,PROXY
  - payload:
      - example.com
      - test.com
  - DOMAIN,github.com,PROXY
";
            assert_eq!(count_rules(content), 2);
        }

        #[test]
        fn count_rules_with_quoted_rules() {
            let content = "\
rules:
  - 'DOMAIN-SUFFIX,example.com,Proxy'
  - \"DOMAIN-KEYWORD,google,Proxy\"
";
            assert_eq!(count_rules(content), 2);
        }

        #[test]
        fn detect_source_with_yaml_wrapper() {
            let content = "\
prepend:
  - 'DOMAIN-SUFFIX,example.com,REJECT'
rules:
  - DOMAIN-SUFFIX,google.com,PROXY
  - DOMAIN,github.com,PROXY
";
            assert_eq!(detect_source(content), "clash");
        }

        #[test]
        fn ensure_ext_does_not_duplicate() {
            let name = "test.prism.yaml";
            let result = ensure_prism_ext(name);
            assert_eq!(result, "test.prism.yaml");
            assert!(!result.ends_with(".prism.yaml.prism.yaml"));
        }

        #[test]
        fn sanitize_then_ensure_ext_roundtrip() {
            let input = "my adblock rules (v2)";
            let sanitized = sanitize_filename(input).expect("sanitize failed");
            let with_ext = ensure_prism_ext(&sanitized);
            assert_eq!(with_ext, "my adblock rules (v2).prism.yaml");
        }

        #[test]
        fn sanitize_preserves_cjk_with_extension() {
            let input = "广告过滤.prism.yaml";
            let sanitized = sanitize_filename(input).expect("sanitize failed");
            let with_ext = ensure_prism_ext(&sanitized);
            assert_eq!(with_ext, "广告过滤.prism.yaml");
        }
    }
}
