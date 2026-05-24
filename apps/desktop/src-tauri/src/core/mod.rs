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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_updated: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auto_update_interval: Option<u64>,
}

pub struct CoreData {
    process: Option<Child>,
    last_secret: String,
    last_config_path: Option<String>,
    last_custom_args: Option<Vec<String>>,
    last_port: Option<u16>,
    last_log_path: Option<String>,
}

impl Default for CoreData {
    fn default() -> Self {
        Self::new()
    }
}

impl CoreData {
    #[must_use]
    pub const fn new() -> Self {
        Self {
            process: None,
            last_secret: String::new(),
            last_config_path: None,
            last_custom_args: None,
            last_port: None,
            last_log_path: None,
        }
    }

    #[must_use]
    pub const fn process(&self) -> Option<&std::process::Child> {
        self.process.as_ref()
    }
    pub const fn process_mut(&mut self) -> Option<&mut std::process::Child> {
        self.process.as_mut()
    }
    #[must_use]
    pub const fn take_process(&mut self) -> Option<Child> {
        self.process.take()
    }
    #[must_use]
    pub fn last_secret(&self) -> &str {
        &self.last_secret
    }
    #[must_use]
    pub fn last_config_path(&self) -> Option<&str> {
        self.last_config_path.as_deref()
    }
    #[must_use]
    pub fn last_custom_args(&self) -> Option<&[String]> {
        self.last_custom_args.as_deref()
    }
    #[must_use]
    pub const fn last_port(&self) -> Option<u16> {
        self.last_port
    }
    #[must_use]
    pub fn last_log_path(&self) -> Option<&str> {
        self.last_log_path.as_deref()
    }

    pub fn set_process(&mut self, p: Option<Child>) {
        self.process = p;
    }
    pub fn set_last_secret(&mut self, s: String) {
        self.last_secret = s;
    }
    pub fn set_last_config_path(&mut self, p: Option<String>) {
        self.last_config_path = p;
    }
    pub fn set_last_custom_args(&mut self, a: Option<Vec<String>>) {
        self.last_custom_args = a;
    }
    pub const fn set_last_port(&mut self, p: Option<u16>) {
        self.last_port = p;
    }
    pub fn set_last_log_path(&mut self, p: Option<String>) {
        self.last_log_path = p;
    }
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
pub mod fetch_util;
pub mod secure_io;
pub mod subscription;
pub mod subscription_scheduler;
#[cfg(test)]
pub mod subscription_scheduler_test;
pub mod tun_manager;

// Re-export all public items from submodules so that `pub use core::*` in core_manager.rs works
pub use config_manager::{
    delete_config, list_configs, open_config_folder, read_config_file, rename_config,
    update_config_url, update_subscription_interval, write_config_file,
};
pub use core_log::read_core_log;
pub use core_process::{
    core_binary_name, ensure_app_storage, ensure_executable, get_core_exe_path, get_core_version,
    kill_mihomo, resolve_app_paths, start_core, stop_core, stop_core_inner,
};
pub use crypto::is_machine_key_persisted;
pub use secure_io::write_file_secure;
pub use subscription::{download_sub, download_sub_batch, fetch_text};
pub use tun_manager::{
    disable_tun_cmd, init_tun_mode_from_config, is_tun_mode, is_tun_toggling,
    kill_all_mihomo_as_root_cmd, release_tun_toggle, restart_core_as_root_cmd, set_tun_enabled,
    set_tun_mode, smart_kill_all_mihomo_as_root, try_acquire_tun_toggle,
};
