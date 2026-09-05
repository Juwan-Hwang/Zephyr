//! Configuration management — platform-agnostic core.
//!
//! This module provides config sanitization, YAML merge, security settings
//! protection, and data types that are shared across desktop and mobile platforms.
//!
//! Platform-specific code (Tauri commands, file system access) stays in src-tauri
//! and calls into these pure functions.

pub mod fetch_util;
pub mod merge;
pub mod overrides_model;
pub mod pipeline_types;
pub mod prism_types;
pub mod proxy_validation;
pub mod sanitizer;
pub mod subscription;
pub mod tun;
pub mod types;

// Re-export key items for convenience
pub use merge::{
    extract_security_settings, merge_yaml, read_config_with_io, restore_security_settings,
    strip_secret_from_yaml, update_config_core, ConfigIo, SecuritySettings,
};
pub use sanitizer::{
    remove_dangerous_keys_internal_pub as remove_dangerous_keys, sanitize_base_filename,
    sanitize_config_file_name, url_decode_complete, validate_path_within_dir,
};
pub use subscription::{
    classify_sub_error, extract_name_from_rules, is_private_host, is_private_ip,
    parse_content_disposition_filename, percent_decode, quote_short_id_values,
    redact_url_in_string, try_decode_base64_content, validate_ambient_proxy_url,
    validate_public_host_addrs, validate_subscription_name, validate_subscription_url_basic,
    validate_subscription_url_with_ip, BatchUpdateItem, BatchUpdateResult, MAX_RESPONSE_SIZE,
};
pub use types::{
    AppPaths, ConfigInfo, ConfigMetadata, NetworkOptimStatus, ProfilesMetadata, ReadLogResult,
};
