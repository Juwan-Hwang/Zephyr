use serde::Serialize;
use std::path::PathBuf;
use std::process::Child;
use std::sync::atomic::{AtomicBool, AtomicU32};
use std::sync::Mutex;

// Global TUN mode flag
pub static TUN_MODE_ACTIVE: AtomicBool = AtomicBool::new(false);

// Global lock to prevent concurrent core start operations
pub static CORE_STARTING: AtomicBool = AtomicBool::new(false);

// Global lock to prevent concurrent TUN toggle operations (from both main UI and tray)
pub static TUN_TOGGLING: AtomicBool = AtomicBool::new(false);

// Global log persistence flags
pub static LOG_CORE_ENABLED: AtomicBool = AtomicBool::new(false);
pub static LOG_MAX_FILE_MB: AtomicU32 = AtomicU32::new(50);

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
    /// Per-subscription User-Agent override (exposed to frontend for the edit panel).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_agent: Option<String>,
}

/// The protocol a managed proxy listener speaks.
///
/// An enum rather than a string so the HTTP-only decisions (the system proxy
/// action) cannot be broken by a typo or a drifting literal: a `!= "http"`
/// comparison against a misspelled value would silently accept SOCKS.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProxyScheme {
    /// `mixed-port` / `port`: an HTTP (or mixed) listener.
    Http,
    /// `socks-port`: a SOCKS listener, which cannot serve HTTP proxy requests.
    Socks5h,
}

impl ProxyScheme {
    /// URL scheme for this protocol, as it appears in proxy URLs.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Http => "http",
            Self::Socks5h => "socks5h",
        }
    }

    /// Whether this protocol can serve HTTP proxy requests, which is what the
    /// system proxy settings require.
    #[must_use]
    pub const fn serves_http(self) -> bool {
        matches!(self, Self::Http)
    }
}

/// The managed proxy endpoint: the port the core listens on plus the scheme that
/// listener actually speaks.
///
/// The scheme is not cosmetic. `mixed-port`/`port` speak HTTP, but a
/// configuration that exposes only `socks-port` speaks SOCKS, and advertising
/// such an endpoint as `http://` produces a proxy setting that cannot connect —
/// the copy-env variables and the system proxy would both point HTTP traffic at
/// a SOCKS listener.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProxyEndpoint {
    /// The configured listener port.
    pub port: u16,
    /// The protocol the matched listener speaks.
    pub scheme: ProxyScheme,
}

impl ProxyEndpoint {
    /// A `mixed-port` / `port` listener, which speaks HTTP.
    #[must_use]
    pub const fn http(port: u16) -> Self {
        Self {
            port,
            scheme: ProxyScheme::Http,
        }
    }

    /// A `socks-port` listener.
    #[must_use]
    pub const fn socks5h(port: u16) -> Self {
        Self {
            port,
            scheme: ProxyScheme::Socks5h,
        }
    }

    /// The endpoint as `host:port`, the form system proxy settings take.
    #[must_use]
    pub fn host_port(self) -> String {
        format!("127.0.0.1:{}", self.port)
    }

    /// The endpoint as a proxy URL (`http://127.0.0.1:7890`,
    /// `socks5h://127.0.0.1:7891`), the form HTTP clients and proxy environment
    /// variables take.
    #[must_use]
    pub fn proxy_url(self) -> String {
        format!("{}://{}", self.scheme.as_str(), self.host_port())
    }
}

pub struct CoreData {
    process: Option<Child>,
    last_secret: String,
    last_config_path: Option<String>,
    last_custom_args: Option<Vec<String>>,
    last_port: Option<u16>,
    last_proxy_endpoint: Option<ProxyEndpoint>,
    last_log_path: Option<String>,
    /// Monotonic time when mihomo process was spawned (None if not started).
    started_at: Option<std::time::Instant>,
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
            last_proxy_endpoint: None,
            last_log_path: None,
            started_at: None,
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
    pub const fn last_proxy_endpoint(&self) -> Option<ProxyEndpoint> {
        self.last_proxy_endpoint
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
    pub const fn set_last_proxy_endpoint(&mut self, p: Option<ProxyEndpoint>) {
        self.last_proxy_endpoint = p;
    }
    pub fn set_last_log_path(&mut self, p: Option<String>) {
        self.last_log_path = p;
    }
    #[must_use]
    pub const fn started_at(&self) -> Option<std::time::Instant> {
        self.started_at
    }
    pub const fn set_started_at(&mut self, t: Option<std::time::Instant>) {
        self.started_at = t;
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
    /// The name of the config that was actually loaded.
    /// May differ from the requested config if a fallback occurred.
    /// `None` means a minimal/generated config was used.
    pub active_config: Option<String>,
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
pub mod core_log;
pub mod core_process;
pub mod crypto;
pub mod fetch_util;
pub mod log_writer;
pub mod network_optim;
pub mod secure_io;
pub mod subscription;
pub mod subscription_scheduler;
#[cfg(test)]
pub mod subscription_scheduler_test;
pub mod tun_manager;

// Re-export all public items from submodules so that `pub use core::*` in core_manager.rs works
pub use config_manager::{
    delete_config, export_logs, list_configs, open_config_folder, open_log_folder,
    read_config_file, rename_config, update_config_url, update_subscription_interval,
    update_subscription_ua, write_config_file,
};
pub use core_log::read_core_log;
pub use core_process::{
    core_binary_name, ensure_app_storage, ensure_executable, get_core_exe_path, get_core_uptime,
    get_core_version, kill_mihomo, resolve_app_paths, start_core, stop_core, stop_core_inner,
    DEFAULT_MIXED_PORT,
};
pub use crypto::{
    decrypt_all_profiles, encrypt_all_profiles, is_machine_key_persisted, read_profile_file,
    write_profile_file,
};
pub use secure_io::write_file_secure;
pub use subscription::{download_sub, download_sub_batch, fetch_text};
pub use tun_manager::{
    disable_tun_cmd, grant_linux_tun_permission, init_tun_mode_from_config, is_tun_mode,
    is_tun_toggling, kill_all_mihomo_as_root_cmd, kill_managed_root_mihomo_as_root,
    last_root_core_exe, record_root_core_exe, record_tun_enabled, release_tun_toggle,
    restart_core_as_root_cmd, set_tun_enabled, set_tun_mode, try_acquire_tun_toggle,
};
