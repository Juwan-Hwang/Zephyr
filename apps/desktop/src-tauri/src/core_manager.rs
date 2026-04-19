#[path = "core/mod.rs"]
pub mod core;

// Re-export all public items from core submodules
pub use core::{
    // core_process
    core_binary_name,
    // config_manager
    delete_config,
    // tun_manager
    disable_tun_cmd,
    // subscription
    download_sub,
    ensure_app_storage,
    ensure_executable,
    fetch_text,
    get_config_url,
    get_core_version,
    init_tun_mode_from_config,
    // crypto
    is_machine_key_persisted,
    is_tun_mode,
    is_tun_toggling,
    kill_all_mihomo_as_root_cmd,
    kill_mihomo,
    list_configs,
    open_config_folder,
    read_config_file,
    // core_log
    read_core_log,
    release_tun_toggle,
    restart_core_as_root_cmd,
    set_tun_enabled,
    set_tun_mode,
    smart_kill_all_mihomo_as_root,
    start_core,
    stop_core,
    try_acquire_tun_toggle,
    write_config_file,
    // secure_io
    write_file_secure,
    // Shared types and constants
    AppPaths,
    ConfigInfo,
    CoreData,
    CoreStartResult,
    MihomoState,
    ReadLogResult,
    // Constants
    CORE_STARTING,
    MAX_RESPONSE_SIZE,
    TUN_MODE_ACTIVE,
    TUN_TOGGLING,
};

// Re-export platform-specific items
#[cfg(target_os = "windows")]
pub use core::CREATE_NO_WINDOW;
