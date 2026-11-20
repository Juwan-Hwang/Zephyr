#[path = "core/mod.rs"]
pub mod core;

// Re-export all public items from core submodules
pub use core::{
    // core_process
    core_binary_name,
    decrypt_all_profiles,
    // config_manager
    delete_config,
    // tun_manager
    disable_tun_cmd,
    // subscription
    download_sub,
    download_sub_batch,
    encrypt_all_profiles,
    ensure_app_storage,
    ensure_executable,
    export_logs,
    fetch_text,
    get_core_exe_path,
    get_core_uptime,
    get_core_version,
    grant_linux_tun_permission,
    init_tun_mode_from_config,
    // crypto
    is_machine_key_persisted,
    is_tun_mode,
    is_tun_toggling,
    kill_all_mihomo_as_root_cmd,
    kill_managed_root_mihomo_as_root,
    kill_mihomo,
    list_configs,
    open_config_folder,
    open_log_folder,
    read_config_file,
    // core_log
    read_core_log,
    read_profile_file,
    record_tun_enabled,
    release_tun_toggle,
    rename_config,
    resolve_app_paths,
    restart_core_as_root_cmd,
    save_profile_file,
    set_tun_enabled,
    set_tun_mode,
    start_core,
    stop_core,
    stop_core_inner,
    try_acquire_tun_toggle,
    update_config_url,
    update_profile_file,
    update_subscription_interval,
    update_subscription_ua,
    write_config_file,
    // secure_io
    write_file_secure,
    write_profile_file,
    // Shared types and constants
    AppPaths,
    ConfigInfo,
    CoreData,
    CoreStartResult,
    MihomoState,
    ReadLogResult,
    // Constants
    CORE_STARTING,
    DEFAULT_MIXED_PORT,
    MAX_RESPONSE_SIZE,
    TUN_MODE_ACTIVE,
    TUN_TOGGLING,
};

// Re-export platform-specific items
#[cfg(target_os = "windows")]
pub use core::CREATE_NO_WINDOW;

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn test_core_manager_start_core_reexport_and_binary_name() {
        let binary_name = core_binary_name();
        #[cfg(target_os = "windows")]
        assert_eq!(binary_name, "zephyr-mihomo.exe");
        #[cfg(not(target_os = "windows"))]
        assert_eq!(binary_name, "zephyr-mihomo");
    }

    #[test]
    fn test_core_manager_mihomo_state_initialization() {
        let state = MihomoState(std::sync::Mutex::new(CoreData::new()));
        let lock = state.0.lock().unwrap();
        assert!(lock.process().is_none());
        assert!(lock.last_secret().is_empty());
        assert!(lock.last_config_path().is_none());
        assert!(lock.last_port().is_none());
        assert!(lock.started_at().is_none());
        drop(lock);
    }
}
