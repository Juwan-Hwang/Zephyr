use serde::Serialize;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use std::time::SystemTime;
use tauri::{AppHandle, Manager as _};

use crate::core_manager::core::log_writer::LogWriter;

// ── Path Redaction ───────────────────────────────────────────────────────────

/// Cached paths for redaction. Set once during app startup.
static REDACT_PATHS: OnceLock<(String, String)> = OnceLock::new();

/// Global app log writer. Set when `log_app_enabled` is first enabled.
static APP_LOG_WRITER: OnceLock<LogWriter> = OnceLock::new();

/// Whether app log persistence is currently active.
/// Controlled by the `log_app_enabled` setting.
static APP_LOG_ACTIVE: AtomicBool = AtomicBool::new(false);

/// Initialize the app log writer. Call when `log_app_enabled` is toggled on
/// or at startup if already enabled.
pub fn init_app_log_writer(log_dir: PathBuf, max_file_mb: u32) {
    if let Some(writer) = APP_LOG_WRITER.get() {
        writer.set_max_file_mb(max_file_mb);
    } else {
        let writer = LogWriter::new(log_dir, max_file_mb);
        let _ = APP_LOG_WRITER.set(writer);
    }
    APP_LOG_ACTIVE.store(true, Ordering::Relaxed);
}

/// Set the max file size for the app log writer dynamically.
pub fn set_app_log_max_file_mb(max_file_mb: u32) {
    if let Some(writer) = APP_LOG_WRITER.get() {
        writer.set_max_file_mb(max_file_mb);
    }
}

/// Set whether app log persistence is active.
pub fn set_app_log_active(active: bool) {
    APP_LOG_ACTIVE.store(active, Ordering::Relaxed);
}

/// Check if app log persistence is currently active.
pub fn is_app_log_active() -> bool {
    APP_LOG_ACTIVE.load(Ordering::Relaxed)
}

/// Initialize redaction paths. Call once after `ensure_app_storage` succeeds.
pub fn init_redact_paths(core_dir: &str, profiles_dir: &str) {
    let _ = REDACT_PATHS.set((core_dir.to_owned(), profiles_dir.to_owned()));
}

/// Redact sensitive paths (`core_dir`, `profiles_dir`) from error messages.
/// Replaces paths with `[CORE_DIR]` and `[PROFILES_DIR]` placeholders.
///
/// Handles both forward-slash and backslash path styles (Windows).
/// Performs case-insensitive matching to handle Windows path casing variations,
/// and also redacts escaped backslash versions (e.g., `C:\\Users` from JSON output).
pub fn redact_error_message(msg: &str) -> String {
    let Some((core_dir, profiles_dir)) = REDACT_PATHS.get() else {
        // Paths not initialized — return original message
        return msg.to_owned();
    };

    let mut result = msg.to_owned();

    // Case-insensitive replace for a single pattern in the string.
    let replace_ci = |s: &mut String, pattern: &str, replacement: &str| {
        let p_len = pattern.len();
        if p_len == 0 {
            return;
        }
        let mut i = 0;
        while i + p_len <= s.len() {
            if s.is_char_boundary(i)
                && s.is_char_boundary(i + p_len)
                && s[i..i + p_len].eq_ignore_ascii_case(pattern)
            {
                s.replace_range(i..i + p_len, replacement);
                i += replacement.len();
            } else {
                i += 1;
            }
        }
    };

    // Redact a single directory path in both slash styles and casing.
    let redact_dir = |s: &mut String, dir: &str, label: &str| {
        if dir.is_empty() {
            return;
        }
        // Normalize to both slash styles regardless of input format,
        // because error messages may use either style on any platform.
        let dir_f = dir.replace('\\', "/");
        let dir_b = dir.replace('/', "\\");

        // Forward-slash style: handle trailing separator first, then bare path
        let dir_f_sep = format!("{dir_f}/");
        let label_f_sep = format!("{label}/");
        replace_ci(s, &dir_f_sep, &label_f_sep);
        replace_ci(s, &dir_f, label);

        // Backslash style (Windows): handle trailing separator first, then bare path
        let dir_b_sep = format!("{dir_b}\\");
        let label_b_sep = format!("{label}\\");
        replace_ci(s, &dir_b_sep, &label_b_sep);
        replace_ci(s, &dir_b, label);

        // Escaped backslash style (JSON/Debug output): C:\\Users\\...
        let dir_be = dir.replace('\\', "\\\\");
        let dir_be_sep = format!("{dir_be}\\\\");
        let label_be_sep = format!("{label}\\\\");
        replace_ci(s, &dir_be_sep, &label_be_sep);
        replace_ci(s, &dir_be, label);
    };

    // Redact the longest (most specific) path first to avoid parent-path
    // replacements breaking subdirectory matches.
    let mut dirs: Vec<(&str, &str)> =
        vec![(core_dir, "[CORE_DIR]"), (profiles_dir, "[PROFILES_DIR]")];
    dirs.retain(|(d, _)| !d.is_empty());
    dirs.sort_by_key(|b| std::cmp::Reverse(b.0.len()));

    for (dir, label) in dirs {
        redact_dir(&mut result, dir, label);
    }
    result
}

// ── Event Types ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum BackendLevel {
    Fatal,
    Error,
    Warn,
    Info,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BackendModule {
    Core,
    Subscription,
    Prism,
    Config,
    Plugin,
    System,
    Updater,
    Override,
    Rule,
    Smart,
    Frontend,
}

#[derive(Debug, Clone, Serialize)]
pub struct BackendEvent {
    pub level: BackendLevel,
    pub module: BackendModule,
    pub code: u16,
    pub message: String,
    pub timestamp: u64,
}

impl BackendEvent {
    pub fn fatal(module: BackendModule, code: u16, message: impl Into<String>) -> Self {
        Self::new(BackendLevel::Fatal, module, code, message)
    }
    pub fn error(module: BackendModule, code: u16, message: impl Into<String>) -> Self {
        Self::new(BackendLevel::Error, module, code, message)
    }
    pub fn warn(module: BackendModule, code: u16, message: impl Into<String>) -> Self {
        Self::new(BackendLevel::Warn, module, code, message)
    }
    pub fn info(module: BackendModule, code: u16, message: impl Into<String>) -> Self {
        Self::new(BackendLevel::Info, module, code, message)
    }

    fn new(
        level: BackendLevel,
        module: BackendModule,
        code: u16,
        message: impl Into<String>,
    ) -> Self {
        Self {
            level,
            module,
            code,
            message: message.into(),
            timestamp: SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis().try_into().unwrap_or(0))
                .unwrap_or(0),
        }
    }
}

// ── Error Code Constants ────────────────────────────────────────────────────

pub mod codes {
    // Core: 1000-1999
    pub const CORE_START_FAILED: u16 = 1001;
    pub const CORE_STOP_FAILED: u16 = 1002;
    pub const CORE_HEALTH_CHECK_FAILED: u16 = 1003;
    pub const CORE_CRASHED: u16 = 1004;
    pub const CORE_CACHE_LOCKED: u16 = 1005;
    pub const CORE_RELOAD_FAILED: u16 = 1006;
    pub const CORE_LOCK_FAILED: u16 = 1007;
    pub const CORE_LOG_ROTATION_FAILED: u16 = 1008;
    /// Mihomo mode restore after subscription update failed.
    pub const CORE_MODE_RESTORE_FAILED: u16 = 1009;
    /// Mihomo mode restore failed in Drop guard (deferred path).
    pub const CORE_MODE_RESTORE_DROPPED: u16 = 1010;
    /// Panic was caught by `catch_unwind` in a core operation.
    pub const CORE_PANIC_GUARD: u16 = 1011;
    /// Mihomo GLOBAL group restore after subscription update failed.
    pub const CORE_GLOBAL_RESTORE_FAILED: u16 = 1012;
    /// Mihomo GLOBAL group restore failed in Drop guard (deferred path).
    pub const CORE_GLOBAL_RESTORE_DROPPED: u16 = 1013;
    /// Mihomo GLOBAL group switch before subscription update failed.
    pub const CORE_GLOBAL_SWITCH_FAILED: u16 = 1014;

    // Subscription: 2000-2999
    pub const SUB_UPDATE_FAILED: u16 = 2001;
    pub const SUB_UPDATE_TIMEOUT: u16 = 2002;
    pub const SUB_PARSE_FAILED: u16 = 2003;
    pub const SUB_ALL_FAILED: u16 = 2004;
    pub const SUB_UPDATE_SUCCESS: u16 = 2005;
    pub const SUB_LOCK_FAILED: u16 = 2006;
    pub const SUB_SSRF_BLOCKED: u16 = 2007;
    pub const SUB_NAME_INVALID: u16 = 2008;
    pub const SUB_URL_INVALID: u16 = 2009;
    pub const SUB_DNS_FAILED: u16 = 2010;
    pub const SUB_HTTP_ERROR: u16 = 2011;
    pub const SUB_NETWORK_ERROR: u16 = 2012;
    pub const SUB_RESPONSE_TOO_LARGE: u16 = 2013;
    pub const SUB_YAML_INVALID: u16 = 2014;
    /// Direct download attempt failed; falling back to proxy.
    pub const SUB_DIRECT_DOWNLOAD_FAILED: u16 = 2015;
    /// Retrying subscription fetch through local proxy.
    pub const SUB_PROXY_RETRY: u16 = 2016;

    // Prism: 3000-3999
    pub const PRISM_APPLY_FAILED: u16 = 3001;
    pub const PRISM_SCRIPT_ERROR: u16 = 3002;
    pub const PRISM_HOT_RELOAD_FAILED: u16 = 3003;
    pub const PRISM_LOCK_FAILED: u16 = 3004;
    /// Script pipeline execution returned an error result.
    pub const PRISM_SCRIPT_EXEC_FAILED: u16 = 3005;
    /// Script pipeline completed with warnings / informational output.
    pub const PRISM_SCRIPT_INFO: u16 = 3006;
    /// Sandbox configuration changed / permissions granted.
    pub const PRISM_SANDBOX_CHANGED: u16 = 3007;

    // Config: 4000-4999
    pub const CONFIG_SAVE_FAILED: u16 = 4001;
    pub const CONFIG_PARSE_FAILED: u16 = 4002;
    pub const CONFIG_DELETE_FAILED: u16 = 4003;
    pub const CONFIG_CREATED_DEFAULT: u16 = 4004;
    pub const CONFIG_LOCK_FAILED: u16 = 4005;
    /// Failed to read a profile file during encryption.
    pub const CONFIG_ENCRYPT_READ_FAILED: u16 = 4006;
    /// Failed to write an encrypted profile file.
    pub const CONFIG_ENCRYPT_WRITE_FAILED: u16 = 4007;
    /// Failed to encrypt profile content.
    pub const CONFIG_ENCRYPT_FAILED: u16 = 4008;
    /// Failed to read a profile file during decryption.
    pub const CONFIG_DECRYPT_READ_FAILED: u16 = 4009;
    /// Failed to write a decrypted profile file.
    pub const CONFIG_DECRYPT_WRITE_FAILED: u16 = 4010;
    /// Failed to decrypt profile content.
    pub const CONFIG_DECRYPT_FAILED: u16 = 4011;
    /// Persisting settings to disk failed.
    pub const CONFIG_PERSIST_FAILED: u16 = 4012;
    /// A dangling `last_config` reference was cleaned up.
    pub const CONFIG_DANGLING_REF_CLEANED: u16 = 4013;
    /// Panic was caught by `catch_unwind` during config I/O.
    pub const CONFIG_PANIC_GUARD: u16 = 4014;

    // Plugin: 5000-5999
    pub const PLUGIN_LOAD_FAILED: u16 = 5001;
    pub const PLUGIN_EXEC_ERROR: u16 = 5002;
    pub const PLUGIN_LOCK_FAILED: u16 = 5003;

    // System: 6000-6999
    pub const SYS_PROXY_FAILED: u16 = 6001;
    pub const SYS_TUN_FAILED: u16 = 6002;
    pub const SYS_DNS_FAILED: u16 = 6003;
    pub const SYS_LOCK_FAILED: u16 = 6004;
    pub const SYS_WINDOW_RECREATE_FAILED: u16 = 6005;
    /// `CoreWebView2` COM interface could not be obtained.
    pub const SYS_WEBVIEW2_COM_INIT_FAILED: u16 = 6006;
    /// `ProcessFailed` event handler registration failed.
    pub const SYS_WEBVIEW2_HANDLER_FAILED: u16 = 6007;
    /// Crash recovery arming failed.
    pub const SYS_CRASH_RECOVERY_ARM_FAILED: u16 = 6008;
    /// Crash recovery arming failed for the initial window.
    pub const SYS_CRASH_RECOVERY_ARM_INITIAL: u16 = 6009;
    /// `WebView` `reload()` call failed.
    pub const SYS_WEBVIEW_RELOAD_FAILED: u16 = 6010;
    /// Browser process exited — full window recreation initiated.
    pub const SYS_WEBVIEW_BROWSER_EXITED: u16 = 6011;
    /// Render process exited (rate-limited reload).
    pub const SYS_WEBVIEW_RENDER_EXITED: u16 = 6012;
    /// Render process crash loop detected — escalating to full recreation.
    pub const SYS_WEBVIEW_RENDER_CRASH_LOOP: u16 = 6013;
    /// `WebView` unresponsive threshold reached — force `reload()`.
    pub const SYS_WEBVIEW_UNRESPONSIVE: u16 = 6014;
    /// Heartbeat stale — webview considered dead, recreating.
    pub const SYS_HEARTBEAT_STALE: u16 = 6015;
    /// Reconstruction already in progress — request skipped.
    pub const SYS_RECONSTRUCTION_SKIPPED: u16 = 6016;
    /// System proxy toggle from tray failed.
    pub const SYS_PROXY_TOGGLE_FAILED: u16 = 6017;
    /// Other unhandled `ProcessFailedKind` (e.g. GPU, utility process — auto-recovered).
    pub const SYS_WEBVIEW_PROCESS_FAILED_OTHER: u16 = 6018;
    /// System resumed from sleep — core health check initiated.
    pub const SYS_RESUMED_HEALTH_CHECK: u16 = 6019;
    /// System resumed from sleep — core health check failed, restarting core.
    pub const SYS_RESUMED_CORE_RESTART: u16 = 6020;
    /// System resumed from sleep — core health check passed, no action needed.
    pub const SYS_RESUMED_CORE_HEALTHY: u16 = 6021;
    /// Network state change detected and debounce initiated.
    pub const SYS_NETWORK_STATE_CHANGED: u16 = 6022;
    /// Prism rules re-applied automatically after network change.
    pub const SYS_NETWORK_COORDINATOR_APPLIED: u16 = 6023;
    /// Error during network coordinator auto-apply.
    pub const SYS_NETWORK_COORDINATOR_ERROR: u16 = 6024;

    // Updater: 7000-7999
    pub const UPDATE_CHECK_FAILED: u16 = 7001;
    pub const UPDATE_DOWNLOAD_FAILED: u16 = 7002;
    pub const UPDATE_LOCK_FAILED: u16 = 7003;
    /// Panic was caught by `catch_unwind` during update.
    pub const UPDATE_PANIC_GUARD: u16 = 7004;

    // Override: 8000-8999
    pub const OVERRIDE_APPLY_FAILED: u16 = 8001;
    pub const OVERRIDE_LOCK_FAILED: u16 = 8002;

    // Rule: 9000-9999
    pub const RULE_PARSE_FAILED: u16 = 9001;
    pub const RULE_LOCK_FAILED: u16 = 9002;

    // Smart: 10000-10999
    pub const SMART_SELECT_FAILED: u16 = 10001;
    pub const SMART_LOCK_FAILED: u16 = 10002;
    /// Smart WAL append operation failed.
    pub const SMART_WAL_APPEND_FAILED: u16 = 10003;
    /// Smart WAL remove operation failed.
    pub const SMART_WAL_REMOVE_FAILED: u16 = 10004;

    // Frontend: 11000-11999
    /// Console `console.error()` / `console.warn()` forwarded from frontend.
    pub const FRONTEND_CONSOLE: u16 = 11001;
    /// Toast notification shown via `showNotification()`.
    pub const FRONTEND_NOTIFICATION: u16 = 11002;
    /// Uncaught exception caught by `window.onerror`.
    pub const FRONTEND_UNCAUGHT: u16 = 11003;
    /// Unhandled Promise rejection caught by `unhandledrejection`.
    pub const FRONTEND_REJECTION: u16 = 11004;
}

// ── Global Emitter ──────────────────────────────────────────────────────────

static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();

/// Initialize the global `AppHandle`. Call once in `app.setup()`.
pub fn init_app_handle(app: &AppHandle) {
    let _ = APP_HANDLE.set(app.clone());
}

/// Emit an event to the main webview via direct `eval()` dispatch.
///
/// Bypasses Tauri's `manager().emit()` → `emit_js_filter()` pipeline,
/// which fails to dispatch events in the `withGlobalTauri: false` config
/// (the JS-side `__internal_unstable_listeners_object_id__` never gets
/// populated by `listen_js_script`'s `eval()`, so `emit_js_filter` finds
/// no matching handlers and skips the dispatch).
///
/// Instead, we inject JS that directly reads `__internal_unstable_listeners_object_id__`,
/// collects listener IDs, and calls the dispatch function — exactly mirroring
/// what `emit_js_script` does, but from the "right side" of the JS context.
pub fn emit_to_main<S: Serialize + Clone>(app: &AppHandle, event: &str, payload: S) {
    if let Some(wv) = app.get_webview_window("main") {
        let payload_json = serde_json::to_string(&payload).unwrap_or_else(|_| "null".to_owned());
        let event_json = serde_json::to_string(event).unwrap_or_else(|_| "null".to_owned());

        // Direct dispatch to JS listeners
        #[allow(clippy::uninlined_format_args)]
        let js = format!(
            "(function() {{ \
               const fn = window['__internal_unstable_listeners_function_id__']; \
               const obj = window['__internal_unstable_listeners_object_id__']; \
               const evt = {evt}; \
               if (fn && obj && obj[evt]) {{ \
                 const ids = Object.getOwnPropertyNames(obj[evt]).map(Number).filter(n => !isNaN(n)); \
                 if (ids.length) {{ fn({{event: evt, payload: {payload}}}, ids); }} \
               }} \
             }})()",
            evt = event_json,
            payload = payload_json,
        );
        let _ = wv.eval(&js);
    }
}

/// Emit a backend event.
/// Always prints to stderr; pushes to frontend when `AppHandle` is ready.
/// Message is automatically redacted to remove sensitive paths.
pub fn emit_backend_event(event: &BackendEvent) {
    // Redact message to remove sensitive paths
    let redacted_message = redact_error_message(&event.message);
    let redacted_event = BackendEvent {
        level: event.level.clone(),
        module: event.module.clone(),
        code: event.code,
        message: redacted_message,
        timestamp: event.timestamp,
    };

    // stderr — always available, zero dependency
    eprintln!(
        "[{}] [{}] (#{}) {}",
        match redacted_event.level {
            BackendLevel::Fatal => "FATAL",
            BackendLevel::Error => "ERROR",
            BackendLevel::Warn => "WARN",
            BackendLevel::Info => "INFO",
        },
        serde_json::to_string(&redacted_event.module)
            .unwrap_or_default()
            .trim_matches('"'),
        redacted_event.code,
        redacted_event.message,
    );

    // Tauri emit — direct eval dispatch to main webview.
    if let Some(handle) = APP_HANDLE.get() {
        emit_to_main(handle, "backend-event", &redacted_event);
    }

    // Persist to disk if app log persistence is active
    if APP_LOG_ACTIVE.load(Ordering::Relaxed) {
        if let Some(writer) = APP_LOG_WRITER.get() {
            let level_str = match redacted_event.level {
                BackendLevel::Fatal => "FATAL",
                BackendLevel::Error => "ERROR",
                BackendLevel::Warn => "WARN",
                BackendLevel::Info => "INFO",
            };
            let module_str = match redacted_event.module {
                BackendModule::Core => "core",
                BackendModule::Subscription => "subscription",
                BackendModule::Prism => "prism",
                BackendModule::Config => "config",
                BackendModule::Plugin => "plugin",
                BackendModule::System => "system",
                BackendModule::Updater => "updater",
                BackendModule::Override => "override",
                BackendModule::Rule => "rule",
                BackendModule::Smart => "smart",
                BackendModule::Frontend => "frontend",
            };
            let line = format!(
                "[{}] [{}] [{}] (#{}) {}",
                chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f"),
                level_str,
                module_str,
                redacted_event.code,
                redacted_event.message,
            );
            if let Err(e) = writer.write_line(&line) {
                eprintln!("[log-writer] Failed to write log line: {e}");
            }
        }
    }
}

// ── Frontend Log Forwarding ────────────────────────────────────────────────

/// Write a log entry originating from the frontend (console errors, toast
/// notifications, uncaught exceptions, unhandled Promise rejections).
///
/// This goes through the standard `emit_backend_event` pipeline so the event
/// reaches stderr, the frontend event listener (for the logs page), and the
/// app log file (if `log_app_enabled` is active).
///
/// To prevent feedback loops (frontend error → backend → frontend toast →
/// backend log → …), `backend-events.js` skips toast notifications for
/// events from the `Frontend` module.
///
/// # Arguments
/// * `level` - One of `"error"`, `"warn"`, `"info"` (case-insensitive).
/// * `code`  - Error code from the `codes::FRONTEND_*` constants.
/// * `message` - The log message text.
pub fn write_frontend_log(level: &str, code: u16, message: &str) {
    let backend_level = match level.to_ascii_lowercase().as_str() {
        "error" | "fatal" => BackendLevel::Error,
        "warn" => BackendLevel::Warn,
        _ => BackendLevel::Info,
    };
    emit_backend_event(&BackendEvent::new(
        backend_level,
        BackendModule::Frontend,
        code,
        message,
    ));
}

// ── Convenience Macros ──────────────────────────────────────────────────────
//
// Usage: emit_error!(Core, CORE_START_FAILED, "message {}", var);
//
// Both module and code are identifiers, auto-resolved via $crate paths.

#[macro_export]
macro_rules! emit_error {
    ($module:ident, $code:ident, $($arg:tt)*) => {
        $crate::backend_event::emit_backend_event(
            &$crate::backend_event::BackendEvent::error(
                $crate::backend_event::BackendModule::$module,
                $crate::backend_event::codes::$code,
                format!($($arg)*)
            )
        )
    };
}

// ── Mutex Lock Utilities ─────────────────────────────────────────────────────

use std::sync::{Mutex, MutexGuard, PoisonError};

/// Lock a mutex for critical paths where data consistency is important.
///
/// Returns `Err` if the mutex is poisoned (another thread panicked while holding it).
/// Also emits an error event to notify the frontend.
///
/// # Arguments
/// * `mutex` - The mutex to lock
/// * `module` - The module for error event (e.g., `BackendModule::Core`)
/// * `code` - The error code (e.g., `codes::CORE_LOCK_FAILED`)
///
/// # Returns
/// * `Ok(MutexGuard)` - Successfully acquired lock
/// * `Err(String)` - Lock failed, with error message
///
/// # Example
/// ```ignore
/// let guard = lock_critical(&state.0, BackendModule::Core, codes::CORE_LOCK_FAILED)?;
/// ```
pub fn lock_critical<T>(
    mutex: &Mutex<T>,
    module: BackendModule,
    code: u16,
) -> Result<MutexGuard<'_, T>, String> {
    mutex.lock().map_err(|e| {
        let msg = format!("Lock failed: {e}");
        emit_backend_event(&BackendEvent::error(module, code, &msg));
        msg
    })
}

/// Lock a mutex for non-critical paths where best-effort access is acceptable.
///
/// If the mutex is poisoned (another thread panicked while holding it),
/// this still returns the guard with potentially inconsistent data.
/// Use this only when:
/// - The data is read-only or can tolerate inconsistency
/// - Missing the operation is worse than using potentially stale data
/// - You want to avoid propagating errors
///
/// # Arguments
/// * `mutex` - The mutex to lock
///
/// # Returns
/// * `MutexGuard` - Always returns a guard (never fails)
///
/// # Example
/// ```ignore
/// let guard = lock_best_effort(&state.0);
/// ```
pub fn lock_best_effort<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

#[macro_export]
macro_rules! emit_warn {
    ($module:ident, $code:ident, $($arg:tt)*) => {
        $crate::backend_event::emit_backend_event(
            &$crate::backend_event::BackendEvent::warn(
                $crate::backend_event::BackendModule::$module,
                $crate::backend_event::codes::$code,
                format!($($arg)*)
            )
        )
    };
}

#[macro_export]
macro_rules! emit_info {
    ($module:ident, $code:ident, $($arg:tt)*) => {
        $crate::backend_event::emit_backend_event(
            &$crate::backend_event::BackendEvent::info(
                $crate::backend_event::BackendModule::$module,
                $crate::backend_event::codes::$code,
                format!($($arg)*)
            )
        )
    };
}

// ── Panic Guard Utilities ──────────────────────────────────────────────────

/// Convert a `catch_unwind` panic payload into a human-readable string.
///
/// Panics in Rust can carry `&'static str`, `String`, or arbitrary types.
/// This function extracts the most common ones and falls back to a generic
/// message for unknown payload types.
#[must_use]
#[allow(clippy::needless_pass_by_value)]
pub fn panic_to_string(payload: Box<dyn std::any::Any + Send>) -> String {
    if let Some(s) = payload.downcast_ref::<&'static str>() {
        (*s).to_owned()
    } else if let Some(s) = payload.downcast_ref::<String>() {
        s.clone()
    } else {
        "unknown panic payload".to_owned()
    }
}
