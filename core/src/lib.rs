pub mod config;
pub mod crypto;
pub mod error;
pub mod event;
pub mod failover;
pub mod process;
pub mod rate_limiter;
pub mod smart_selector;
pub mod state;
pub mod updater;

#[cfg(feature = "uniffi")]
uniffi::setup_scaffolding!("zephyr_core");

// ---- 示例导出函数（验证 UniFFI pipeline）----
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn greet(name: String) -> String {
    format!("Hello, {name}! Welcome to Zephyr.")
}
