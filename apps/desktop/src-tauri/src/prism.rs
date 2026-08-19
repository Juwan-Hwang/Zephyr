//! Prism Engine integration — Tauri command layer.
//!
//! All 77 commands are thin wrappers around the Clash Prism crates.
//! `needless_pass_by_value` is allowed at module level because every
//! `#[tauri::command]` receives `tauri::State<T>` by value (Tauri's
//! required signature), which clippy otherwise flags.

#![allow(clippy::needless_pass_by_value)]

use std::sync::{Arc, Mutex};

use tauri::AppHandle;

use clash_prism_core::failover::{FailoverTracker, NodeFailPolicy};
use clash_prism_extension::PrismExtension;
use clash_prism_plugin::PluginLoader;
use clash_prism_script::limits::ScriptLimits;
use clash_prism_script::{KvStore, SandboxConfig};
use clash_prism_smart::SmartConfig;

use crate::backend_event::{codes, lock_critical, BackendModule};
use crate::core_manager::ensure_app_storage;

// ---------------------------------------------------------------------------
// Sub-modules
// ---------------------------------------------------------------------------

mod commands_core;
mod failover_commands;
pub(crate) mod host;
mod kv_commands;
pub mod overrides;
pub mod pipeline;
mod plugin_commands;
mod rate_limiter;
mod rule_groups;
mod rule_library;
mod script_commands;
pub mod smart_commands;
pub mod smart_state;
mod trace_commands;
pub mod types;

// ---------------------------------------------------------------------------
// Re-exports — all `#[tauri::command]` pub fns are re-exported here so that
// `lib.rs` can reference them as `prism::<cmd>`.
// ---------------------------------------------------------------------------

pub use commands_core::*;
pub use failover_commands::*;
pub use kv_commands::*;
pub use overrides::*;
pub use plugin_commands::*;
pub use rule_groups::*;
pub use rule_library::*;
pub use script_commands::*;
pub use smart_commands::*;
pub use trace_commands::*;
pub use types::*;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/// Return the `prism/` data directory, creating it if needed.
pub(crate) fn prism_data_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let paths = ensure_app_storage(app)?;
    let dir = paths.app_data_dir.join("prism");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Failed to create prism dir: {e}"))?;
    Ok(dir)
}

// ---------------------------------------------------------------------------
// PrismState — wraps PrismExtension for Tauri managed state
// ---------------------------------------------------------------------------

pub struct PrismState {
    pub(crate) inner: Arc<Mutex<PrismInner>>,
    pub(crate) app: AppHandle,
    /// New smart state with async persistence
    pub smart_state: Option<smart_state::SmartState>,
}

pub(crate) struct PrismInner {
    extension: Option<PrismExtension<host::ZephyrPrismHost>>,
    /// Failover tracker for automatic node switching on failures.
    failover_tracker: FailoverTracker,
    /// Key-value store for scripts and plugins.
    kv_store: Arc<KvStore>,
    /// Persistent plugin loader — retains loaded plugin state across calls.
    plugin_loader: PluginLoader,
    /// Script sandbox configuration.
    sandbox_config: SandboxConfig,
    /// Script resource limits.
    script_limits: ScriptLimits,
    /// Cached trace from the last `apply()` call.
    /// Used by `prism_get_last_trace` to avoid re-compilation.
    last_trace: Vec<serde_json::Value>,
    /// Per-command rate limiter.
    rate_limiter: rate_limiter::RateLimiter,
}

impl PrismState {
    #[must_use]
    pub fn new(app: &AppHandle) -> Self {
        let host = host::ZephyrPrismHost::new(app.clone());
        let extension = PrismExtension::new(host);

        let prism_dir = ensure_app_storage(app)
            .ok()
            .map(|paths| paths.app_data_dir.join("prism"));

        // Initialize SmartState using tauri::async_runtime::block_on
        // This works regardless of whether a tokio runtime is already active
        let smart_state = prism_dir.as_ref().and_then(|dir| {
            std::fs::create_dir_all(dir).ok()?;
            let config = smart_state::SmartStateConfig::new(dir);
            match tauri::async_runtime::block_on(async {
                smart_state::SmartState::init(config).await
            }) {
                Ok(state) => Some(state),
                Err(e) => {
                    emit_error!(
                        Prism,
                        PRISM_APPLY_FAILED,
                        "Failed to initialize SmartState: {e}"
                    );
                    None
                }
            }
        });

        Self {
            inner: Arc::new(Mutex::new(PrismInner {
                extension: Some(extension),
                failover_tracker: FailoverTracker::new(NodeFailPolicy::new()),
                kv_store: {
                    let db_path = prism_dir.as_ref().map(|p| p.join("kv_store.db"));
                    match db_path {
                        Some(p) => Arc::new(KvStore::with_persistence(p)),
                        None => Arc::new(KvStore::new()),
                    }
                },
                plugin_loader: {
                    let mut loader = PluginLoader::new();
                    if let Some(dir) = &prism_dir {
                        let plugins_dir = dir.join("plugins");
                        if plugins_dir.exists() {
                            loader.add_search_path(plugins_dir);
                        }
                    }
                    loader
                },
                sandbox_config: SandboxConfig::strict(),
                script_limits: ScriptLimits::default(),
                last_trace: Vec::new(),
                rate_limiter: {
                    let mut rl = rate_limiter::RateLimiter::new();
                    // script_execute: max 10 calls per 10 seconds
                    rl.register("script_execute", 10, std::time::Duration::from_secs(10));
                    // script_execute_write: max 5 calls per 10 seconds
                    rl.register(
                        "script_execute_write",
                        5,
                        std::time::Duration::from_secs(10),
                    );
                    // rule_import_url: max 5 calls per 10 seconds
                    rl.register("rule_import_url", 5, std::time::Duration::from_secs(10));
                    rl
                },
            })),
            app: app.clone(),
            smart_state,
        }
    }

    pub(crate) fn with_ext<F, R>(&self, f: F) -> Result<R, String>
    where
        F: FnOnce(&PrismExtension<host::ZephyrPrismHost>) -> Result<R, String>,
    {
        let lock = lock_critical(&self.inner, BackendModule::Prism, codes::PRISM_LOCK_FAILED)?;
        let ext = lock
            .extension
            .as_ref()
            .ok_or_else(|| "Prism not initialized".to_owned())?;
        let result = f(ext);
        drop(lock);
        result
    }

    /// Internal apply method executed on a blocking thread to avoid starving async command threads.
    pub async fn apply_internal(
        &self,
        options: Option<clash_prism_extension::ApplyOptions>,
    ) -> Result<
        (
            crate::network_coordinator::CoreApplyResult,
            serde_json::Value,
        ),
        String,
    > {
        let opts = options.unwrap_or_default();
        let inner = Arc::clone(&self.inner);
        tokio::task::spawn_blocking(move || {
            // RAII Scope Guard: Guarantees TLS is cleared before execution and on early exit/Drop
            let guard = host::HttpStatusGuard::enter();

            let mut lock = lock_critical(&inner, BackendModule::Prism, codes::PRISM_LOCK_FAILED)?;
            let ext = lock
                .extension
                .as_ref()
                .ok_or_else(|| "Prism not initialized".to_owned())?;
            let result = ext.apply(opts)?;
            if let Ok(val) = serde_json::to_value(&result.trace) {
                lock.last_trace = val.as_array().cloned().unwrap_or_default();
            }
            drop(lock);

            // Extract strictly thread-confined transport status code via RAII guard.
            // The thread-local bridge is set by ZephyrPrismHost::apply_config, which
            // derives hot_reload_success from the HTTP status code.  We use that
            // directly because ApplyResult (returned by ext.apply) does not contain
            // the ApplyStatus struct — only output_config, stats, trace, and annotations.
            let http_status = guard.take();
            let hot_reload_success =
                http_status.is_some_and(crate::network_coordinator::is_http_success);

            let core_result = crate::network_coordinator::CoreApplyResult {
                http_status,
                hot_reload_success: Some(hot_reload_success),
            };

            // Enrich the serialized JSON with the status fields so downstream
            // consumers (e.g. prism_apply command response) can access them.
            let mut val =
                serde_json::to_value(result).map_err(|e| format!("Serialize failed: {e}"))?;
            if let Some(obj) = val.as_object_mut() {
                let mut status_obj = serde_json::Map::new();
                status_obj.insert(
                    "hot_reload_success".to_owned(),
                    serde_json::json!(hot_reload_success),
                );
                if let Some(code) = http_status {
                    status_obj.insert("http_status".to_owned(), serde_json::json!(code));
                }
                obj.insert("status".to_owned(), serde_json::Value::Object(status_obj));
            }
            Ok((core_result, val))
        })
        .await
        .map_err(|e| format!("Task join failed: {e}"))?
    }

    pub(crate) fn get_prism_workspace(&self) -> Result<std::path::PathBuf, String> {
        prism_data_dir(&self.app)
    }

    /// Return the `prism/overrides/` directory, creating it if needed.
    pub(crate) fn get_overrides_dir(&self) -> Result<std::path::PathBuf, String> {
        let dir = self.get_prism_workspace()?.join("overrides");
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("Failed to create overrides dir: {e}"))?;
        Ok(dir)
    }

    /// Read and parse the smart.toml config file.
    pub(crate) fn read_smart_config(&self) -> Result<SmartConfig, String> {
        let prism_dir = self.get_prism_workspace()?;
        let config_path = prism_dir.join("smart.toml");
        if !config_path.exists() {
            let default_toml = SmartConfig::example_toml();
            return SmartConfig::from_toml(&default_toml)
                .map_err(|e| format!("Failed to parse default config: {e}"));
        }
        let toml_str = std::fs::read_to_string(&config_path)
            .map_err(|e| format!("Failed to read smart.toml: {e}"))?;
        SmartConfig::from_toml(&toml_str).map_err(|e| format!("Failed to parse smart.toml: {e}"))
    }

    /// Acquire the inner mutex guard.
    pub(crate) fn lock_inner(&self) -> Result<std::sync::MutexGuard<'_, PrismInner>, String> {
        lock_critical(&self.inner, BackendModule::Prism, codes::PRISM_LOCK_FAILED)
    }

    /// Check rate limit for a command. Returns `Ok(())` if allowed,
    /// `Err(retry_after)` if rate-limited.
    pub(crate) fn check_rate_limit(&self, key: &str) -> Result<(), String> {
        let mut lock = self.lock_inner()?;
        lock.rate_limiter
            .check(key)
            .map_err(|d| format!("Rate limited: retry after {:.1}s", d.as_secs_f64()))
    }
}

#[cfg(test)]
#[path = "prism_tests.rs"]
mod prism_tests;
