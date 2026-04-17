use serde::Serialize;
use std::path::PathBuf;
use std::process::Child;
use std::sync::atomic::AtomicBool;
use std::sync::Mutex;

// Global TUN mode flag
pub static TUN_MODE_ACTIVE: AtomicBool = AtomicBool::new(false);

// Global lock to prevent concurrent core start operations
pub static CORE_STARTING: AtomicBool = AtomicBool::new(false);

// Global lock to prevent concurrent TUN toggle operations (from both main UI and tray)
pub static TUN_TOGGLING: AtomicBool = AtomicBool::new(false);

#[cfg(target_os = "windows")]
pub const CREATE_NO_WINDOW: u32 = 0x08000000;

pub const MAX_RESPONSE_SIZE: usize = 10 * 1024 * 1024; // 10MB

#[derive(Serialize)]
pub struct ConfigInfo {
    pub name: String,
    #[serde(skip_serializing)]
    pub url: Option<String>,
    pub url_display: Option<String>,
    pub sub_info: Option<String>,
}

pub struct CoreData {
    pub process: Option<Child>,
    pub last_secret: String,
    pub last_config_path: Option<String>,
    pub last_custom_args: Option<Vec<String>>,
    pub last_port: Option<u16>,
    pub last_log_path: Option<String>,
}
pub struct MihomoState(pub Mutex<CoreData>);

#[derive(Clone)]
pub struct AppPaths {
    pub app_data_dir: PathBuf,
    pub core_dir: PathBuf,
    pub profiles_dir: PathBuf,
}

#[derive(serde::Serialize)]
pub struct CoreStartResult {
    pub secret: String,
    pub port: u16,
}

#[derive(serde::Serialize)]
pub struct ReadLogResult {
    pub lines: Vec<String>,
    pub next_offset: u64,
    pub file_size: u64,
    pub has_more: bool,
    /// True when the log file was rotated (new file, smaller than requested offset).
    /// Frontend should reset its buffer and offset on receiving this signal.
    pub rotated: bool,
}

pub mod config_manager;
pub mod config_sanitizer;
pub mod core_log;
pub mod core_process;
pub mod crypto;
pub mod secure_io;
pub mod subscription;
pub mod tun_manager;

// Re-export all public items from submodules so that `pub use core::*` in core_manager.rs works
pub use config_manager::{
    delete_config, get_config_url, list_configs, open_config_folder, read_config_file,
    write_config_file,
};
pub use core_log::read_core_log;
pub use core_process::{
    core_binary_name, ensure_app_storage, ensure_executable, get_core_version, kill_mihomo,
    start_core, stop_core,
};
pub use crypto::is_machine_key_persisted;
pub use secure_io::write_file_secure;
pub use subscription::{download_sub, fetch_text};
pub use tun_manager::{
    disable_tun_cmd, is_tun_mode, is_tun_toggling, kill_all_mihomo_as_root_cmd, release_tun_toggle,
    restart_core_as_root_cmd, set_tun_enabled, set_tun_mode, smart_kill_all_mihomo_as_root,
    try_acquire_tun_toggle,
};

// Re-export test helpers
#[cfg(test)]
pub use config_sanitizer::sanitize_config_file_name_public;
#[cfg(test)]
pub use subscription::is_private_host_public;
