#![allow(clippy::unwrap_used)]
#[cfg(test)]
mod tests {
    use crate::core_manager;

    #[test]
    fn test_core_binary_name() {
        let name = core_manager::core_binary_name();
        #[cfg(target_os = "windows")]
        assert_eq!(name, "mihomo.exe");
        #[cfg(not(target_os = "windows"))]
        assert_eq!(name, "mihomo");
    }

    #[test]
    fn test_is_private_host() {
        assert!(core_manager::is_private_host_public("localhost"));
        assert!(core_manager::is_private_host_public("127.0.0.1"));
        assert!(core_manager::is_private_host_public("192.168.1.1"));
        assert!(core_manager::is_private_host_public("10.0.0.1"));
        assert!(!core_manager::is_private_host_public("example.com"));
        assert!(!core_manager::is_private_host_public("8.8.8.8"));
    }

    #[test]
    fn test_sanitize_config_file_name() {
        // Valid filenames should pass through
        assert_eq!(
            core_manager::sanitize_config_file_name_public("test.yaml").unwrap(),
            "test.yaml"
        );
        assert_eq!(
            core_manager::sanitize_config_file_name_public("test.yml").unwrap(),
            "test.yml"
        );
        // Path components are stripped by Path::file_name(), leaving just the filename
        assert_eq!(
            core_manager::sanitize_config_file_name_public("../test.yaml").unwrap(),
            "test.yaml"
        );
        assert_eq!(
            core_manager::sanitize_config_file_name_public("foo/test.yaml").unwrap(),
            "test.yaml"
        );
        // Note: "foo\test.yaml" with backslash is platform-dependent:
        // - Windows: \ is a separator, file_name() extracts "test.yaml" → Ok
        // - Linux:   \ is a valid filename char, NOT a separator, so it's rejected
        // We test both forward slash (portable) and backslash (platform-specific) separately
        #[cfg(target_os = "windows")]
        assert_eq!(
            core_manager::sanitize_config_file_name_public("foo\\test.yaml").unwrap(),
            "test.yaml"
        );
        #[cfg(not(target_os = "windows"))]
        assert!(core_manager::sanitize_config_file_name_public("foo\\test.yaml").is_err());
        // Invalid extension must be rejected
        assert!(core_manager::sanitize_config_file_name_public("test.txt").is_err());
    }

    #[test]
    fn test_sanitize_config_file_name_rejects_path_traversal() {
        // Literal '..' in the filename component (after extraction) is rejected
        assert!(core_manager::sanitize_config_file_name_public("..").is_err());
        // Directory separators in the final filename are rejected
        assert!(core_manager::sanitize_config_file_name_public("foo/bar").is_err());
        // Null bytes rejected
        assert!(core_manager::sanitize_config_file_name_public("test\x00.yaml").is_err());
        // Legitimate filenames with dots (but no separators) should work
        assert!(core_manager::sanitize_config_file_name_public(".test.yaml").is_ok());
        assert!(core_manager::sanitize_config_file_name_public("config.backup.yml").is_ok());
    }

    mod dangerous_keys_tests {
        use crate::core_manager::remove_dangerous_keys;

        #[test]
        fn test_top_level_script_removed() {
            let yaml = "script: test.js\nport: 7890";
            let mut value: serde_yaml::Value = serde_yaml::from_str(yaml).unwrap();
            remove_dangerous_keys(&mut value, false);
            assert!(!value
                .as_mapping()
                .unwrap()
                .contains_key(serde_yaml::Value::String("script".to_owned())));
            assert!(value
                .as_mapping()
                .unwrap()
                .contains_key(serde_yaml::Value::String("port".to_owned())));
        }

        #[test]
        fn test_nested_script_in_proxy_group_removed() {
            let yaml = r"
proxy-groups:
  - name: test
    type: select
    script: malicious.js
    proxies:
      - proxy1
";
            let mut value: serde_yaml::Value = serde_yaml::from_str(yaml).unwrap();
            remove_dangerous_keys(&mut value, false);

            let groups = value.get("proxy-groups").unwrap().as_sequence().unwrap();
            let group = groups.first().unwrap().as_mapping().unwrap();
            assert!(!group.contains_key(serde_yaml::Value::String("script".to_owned())));
            assert!(group.contains_key(serde_yaml::Value::String("name".to_owned())));
        }

        #[test]
        fn test_provider_path_removed() {
            let yaml = r"
proxy-providers:
  my-provider:
    type: http
    url: https://example.com/proxies.yaml
    path: /etc/passwd
    interval: 3600
";
            let mut value: serde_yaml::Value = serde_yaml::from_str(yaml).unwrap();
            remove_dangerous_keys(&mut value, false);

            let providers = value.get("proxy-providers").unwrap().as_mapping().unwrap();
            let provider = providers
                .get(serde_yaml::Value::String("my-provider".to_owned()))
                .unwrap()
                .as_mapping()
                .unwrap();
            assert!(!provider.contains_key(serde_yaml::Value::String("path".to_owned())));
            assert!(provider.contains_key(serde_yaml::Value::String("type".to_owned())));
        }

        #[test]
        fn test_non_provider_path_preserved() {
            let yaml = r#"
tun:
  enable: false
  stack: system
  dns-hijack:
    - any:53
proxies:
  - name: "test"
    type: ss
    server: 127.0.0.1
    port: 8388
"#;
            let mut value: serde_yaml::Value = serde_yaml::from_str(yaml).unwrap();
            remove_dangerous_keys(&mut value, false);

            // These should NOT be removed - not in provider context
            let proxies = value.get("proxies").unwrap().as_sequence().unwrap();
            let proxy = proxies.first().unwrap().as_mapping().unwrap();
            // 'port' is different from 'path', should be preserved
            assert!(proxy.contains_key(serde_yaml::Value::String("port".to_owned())));
        }

        #[test]
        fn test_deeply_nested_script_removed() {
            let yaml = r#"
rules:
  - SCRIPT,test.js,DIRECT
  - MATCH,PROXY
script:
  code: |
    function main() { return "malicious" }
"#;
            let mut value: serde_yaml::Value = serde_yaml::from_str(yaml).unwrap();
            remove_dangerous_keys(&mut value, false);

            assert!(!value
                .as_mapping()
                .unwrap()
                .contains_key(serde_yaml::Value::String("script".to_owned())));
        }

        #[test]
        fn test_script_path_removed() {
            let yaml = r"
script-path: /malicious/script.js
mode: rule
";
            let mut value: serde_yaml::Value = serde_yaml::from_str(yaml).unwrap();
            remove_dangerous_keys(&mut value, false);

            assert!(!value
                .as_mapping()
                .unwrap()
                .contains_key(serde_yaml::Value::String("script-path".to_owned())));
        }

        #[test]
        fn test_provider_without_path_preserved() {
            let yaml = r"
rule-providers:
  my-rules:
    type: http
    url: https://example.com/rules.yaml
    interval: 86400
";
            let mut value: serde_yaml::Value = serde_yaml::from_str(yaml).unwrap();
            remove_dangerous_keys(&mut value, false);

            let providers = value.get("rule-providers").unwrap().as_mapping().unwrap();
            assert!(providers.contains_key(serde_yaml::Value::String("my-rules".to_owned())));
        }
    }
}
