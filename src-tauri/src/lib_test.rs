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
        assert_eq!(core_manager::sanitize_config_file_name_public("test.yaml").unwrap(), "test.yaml");
        assert_eq!(core_manager::sanitize_config_file_name_public("test.yml").unwrap(), "test.yml");
        assert_eq!(core_manager::sanitize_config_file_name_public("../test.yaml").unwrap(), "test.yaml");
        assert_eq!(core_manager::sanitize_config_file_name_public("foo/test.yaml").unwrap(), "test.yaml");
        assert_eq!(core_manager::sanitize_config_file_name_public("foo\\test.yaml").unwrap(), "test.yaml");
        assert!(core_manager::sanitize_config_file_name_public("test.txt").is_err());
    }
}