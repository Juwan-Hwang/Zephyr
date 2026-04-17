#[path = "core/mod.rs"]
pub(crate) mod core;

// Re-export all public items from core submodules
pub use core::{
    // Shared types and constants
    AppPaths, ConfigInfo, CoreData, CoreStartResult, MihomoState, ReadLogResult,
    // Constants
    CORE_STARTING, MAX_RESPONSE_SIZE, TUN_MODE_ACTIVE, TUN_TOGGLING,
    // secure_io
    write_file_secure,
    // crypto
    is_machine_key_persisted,
    // tun_manager
    disable_tun_cmd, is_tun_mode, is_tun_toggling, kill_all_mihomo_as_root_cmd,
    release_tun_toggle, restart_core_as_root_cmd, set_tun_enabled, set_tun_mode,
    smart_kill_all_mihomo_as_root, try_acquire_tun_toggle,
    // core_process
    core_binary_name, ensure_app_storage, ensure_executable, get_core_version, kill_mihomo,
    start_core, stop_core,
    // core_log
    read_core_log,
    // config_manager
    delete_config, get_config_url, list_configs, open_config_folder, read_config_file,
    write_config_file,
    // subscription
    download_sub, fetch_text,
};

// Re-export crate-visible items
#[cfg(test)]
pub(crate) use core::config_sanitizer::remove_dangerous_keys;

// Re-export platform-specific items
#[cfg(target_os = "windows")]
pub use core::CREATE_NO_WINDOW;

// Re-export test helpers
#[cfg(test)]
pub use core::sanitize_config_file_name_public;
#[cfg(test)]
pub use core::is_private_host_public;
