//! Cross-platform event system — UniFFI callback interface.
//!
//! This module defines the event types and callback interface that allow
//! the core crate to emit events without depending on any specific UI framework.
//!
//! - **Desktop (Tauri)**: Implements `CoreEventCallback` to forward events
//!   to `emit_backend_event()` / `emit_to_main()`.
//! - **Mobile (Android/iOS)**: Implements `CoreEventCallback` in Kotlin/Swift
//!   to forward events to the native UI layer.

use std::sync::Arc;

// ── Event types (shared across all platforms) ────────────────────────────

/// Event severity level.
#[cfg_attr(feature = "uniffi", derive(uniffi::Enum))]
#[derive(Debug, Clone)]
pub enum EventLevel {
    Fatal,
    Error,
    Warn,
    Info,
}

/// Module that originated the event.
#[cfg_attr(feature = "uniffi", derive(uniffi::Enum))]
#[derive(Debug, Clone)]
pub enum EventModule {
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
}

/// A structured event emitted by the core.
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
#[derive(Debug, Clone)]
pub struct CoreEvent {
    pub level: EventLevel,
    pub module: EventModule,
    pub code: u16,
    pub message: String,
    pub timestamp: u64,
}

impl CoreEvent {
    pub fn fatal(module: EventModule, code: u16, message: impl Into<String>) -> Self {
        Self::new(EventLevel::Fatal, module, code, message)
    }
    pub fn error(module: EventModule, code: u16, message: impl Into<String>) -> Self {
        Self::new(EventLevel::Error, module, code, message)
    }
    pub fn warn(module: EventModule, code: u16, message: impl Into<String>) -> Self {
        Self::new(EventLevel::Warn, module, code, message)
    }
    pub fn info(module: EventModule, code: u16, message: impl Into<String>) -> Self {
        Self::new(EventLevel::Info, module, code, message)
    }

    fn new(level: EventLevel, module: EventModule, code: u16, message: impl Into<String>) -> Self {
        Self {
            level,
            module,
            code,
            message: message.into(),
            timestamp: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis().try_into().unwrap_or(0))
                .unwrap_or(0),
        }
    }
}

// ── Error code constants (mirrors src-tauri's codes module) ──────────────

pub mod codes {
    // Core: 1000-1999
    pub const CORE_START_FAILED: u16 = 1001;
    pub const CORE_STOP_FAILED: u16 = 1002;
    pub const CORE_HEALTH_CHECK_FAILED: u16 = 1003;
    pub const CORE_CRASHED: u16 = 1004;
    pub const CORE_CACHE_LOCKED: u16 = 1005;
    pub const CORE_RELOAD_FAILED: u16 = 1006;
    pub const CORE_LOCK_FAILED: u16 = 1007;

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

    // Prism: 3000-3999
    pub const PRISM_APPLY_FAILED: u16 = 3001;
    pub const PRISM_SCRIPT_ERROR: u16 = 3002;
    pub const PRISM_HOT_RELOAD_FAILED: u16 = 3003;
    pub const PRISM_LOCK_FAILED: u16 = 3004;

    // Config: 4000-4999
    pub const CONFIG_SAVE_FAILED: u16 = 4001;
    pub const CONFIG_PARSE_FAILED: u16 = 4002;
    pub const CONFIG_DELETE_FAILED: u16 = 4003;
    pub const CONFIG_CREATED_DEFAULT: u16 = 4004;
    pub const CONFIG_LOCK_FAILED: u16 = 4005;

    // Plugin: 5000-5999
    pub const PLUGIN_LOAD_FAILED: u16 = 5001;
    pub const PLUGIN_EXEC_ERROR: u16 = 5002;
    pub const PLUGIN_LOCK_FAILED: u16 = 5003;

    // System: 6000-6999
    pub const SYS_PROXY_FAILED: u16 = 6001;
    pub const SYS_TUN_FAILED: u16 = 6002;
    pub const SYS_DNS_FAILED: u16 = 6003;
    pub const SYS_LOCK_FAILED: u16 = 6004;

    // Updater: 7000-7999
    pub const UPDATE_CHECK_FAILED: u16 = 7001;
    pub const UPDATE_DOWNLOAD_FAILED: u16 = 7002;
    pub const UPDATE_LOCK_FAILED: u16 = 7003;

    // Override: 8000-8999
    pub const OVERRIDE_APPLY_FAILED: u16 = 8001;
    pub const OVERRIDE_LOCK_FAILED: u16 = 8002;

    // Rule: 9000-9999
    pub const RULE_PARSE_FAILED: u16 = 9001;
    pub const RULE_LOCK_FAILED: u16 = 9002;

    // Smart: 10000-10999
    pub const SMART_SELECT_FAILED: u16 = 10001;
    pub const SMART_LOCK_FAILED: u16 = 10002;
}

// ── Callback interface (implemented by each platform) ────────────────────

/// Platform-specific event callback.
///
/// Each platform implements this trait to route events to its native UI:
/// - **Tauri**: Forwards to `emit_backend_event()` / `emit_to_main()`
/// - **Android**: Forwards to Kotlin coroutine channel / StateFlow
/// - **iOS**: Forwards to Swift NotificationCenter / async stream
#[cfg_attr(feature = "uniffi", uniffi::export(callback_interface))]
pub trait CoreEventCallback: Send + Sync {
    fn on_event(&self, event: CoreEvent);
}

// ── Global event dispatcher ──────────────────────────────────────────────

/// Global event dispatcher that routes events to the registered callback.
///
/// On desktop, this is set once during Tauri app setup.
/// On mobile, this is set when the native app creates the core binding.
static EVENT_DISPATCHER: std::sync::OnceLock<Arc<dyn CoreEventCallback>> =
    std::sync::OnceLock::new();

/// Initialize the global event dispatcher. Call once at app startup.
pub fn init_event_dispatcher(callback: Arc<dyn CoreEventCallback>) {
    let _ = EVENT_DISPATCHER.set(callback);
}

/// UniFFI-accessible wrapper for initializing the event dispatcher.
/// Mobile platforms call this to register their native callback.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn set_event_callback(callback: Box<dyn CoreEventCallback>) {
    init_event_dispatcher(Arc::from(callback))
}

/// Emit an event through the global dispatcher.
/// If no dispatcher is set, falls back to stderr logging.
pub fn emit_event(event: &CoreEvent) {
    // Always log to stderr as a baseline
    eprintln!(
        "[{}] [{}] (#{}) {}",
        match event.level {
            EventLevel::Fatal => "FATAL",
            EventLevel::Error => "ERROR",
            EventLevel::Warn => "WARN",
            EventLevel::Info => "INFO",
        },
        match event.module {
            EventModule::Core => "core",
            EventModule::Subscription => "subscription",
            EventModule::Prism => "prism",
            EventModule::Config => "config",
            EventModule::Plugin => "plugin",
            EventModule::System => "system",
            EventModule::Updater => "updater",
            EventModule::Override => "override",
            EventModule::Rule => "rule",
            EventModule::Smart => "smart",
        },
        event.code,
        event.message,
    );

    if let Some(dispatcher) = EVENT_DISPATCHER.get() {
        dispatcher.on_event(event.clone());
    }
}

/// Convenience function: emit an info event.
pub fn emit_info(module: EventModule, code: u16, message: impl Into<String>) {
    emit_event(&CoreEvent::info(module, code, message));
}

/// Convenience function: emit a warning event.
pub fn emit_warn(module: EventModule, code: u16, message: impl Into<String>) {
    emit_event(&CoreEvent::warn(module, code, message));
}

/// Convenience function: emit an error event.
pub fn emit_error(module: EventModule, code: u16, message: impl Into<String>) {
    emit_event(&CoreEvent::error(module, code, message));
}

// ── Path redaction (shared across platforms) ─────────────────────────────

/// Cached paths for redaction. Set once during app startup.
static REDACT_PATHS: std::sync::OnceLock<(String, String)> = std::sync::OnceLock::new();

/// Initialize redaction paths. Call once after app storage is set up.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn init_redact_paths(core_dir: String, profiles_dir: String) {
    let _ = REDACT_PATHS.set((core_dir, profiles_dir));
}

/// Redact sensitive paths from error messages.
/// Replaces paths with `[CORE_DIR]` and `[PROFILES_DIR]` placeholders.
pub fn redact_error_message(msg: &str) -> String {
    let Some((core_dir, profiles_dir)) = REDACT_PATHS.get() else {
        return msg.to_owned();
    };

    let mut result = msg.to_owned();

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

    let redact_dir = |s: &mut String, dir: &str, label: &str| {
        if dir.is_empty() {
            return;
        }
        let dir_f = dir.replace('\\', "/");
        let dir_b = dir.replace('/', "\\");

        let dir_f_sep = format!("{dir_f}/");
        let label_f_sep = format!("{label}/");
        replace_ci(s, &dir_f_sep, &label_f_sep);
        replace_ci(s, &dir_f, label);

        let dir_b_sep = format!("{dir_b}\\");
        let label_b_sep = format!("{label}\\");
        replace_ci(s, &dir_b_sep, &label_b_sep);
        replace_ci(s, &dir_b, label);

        let dir_be = dir.replace('\\', "\\\\");
        let dir_be_sep = format!("{dir_be}\\\\");
        let label_be_sep = format!("{label}\\\\");
        replace_ci(s, &dir_be_sep, &label_be_sep);
        replace_ci(s, &dir_be, label);
    };

    let mut dirs: Vec<(&str, &str)> =
        vec![(core_dir, "[CORE_DIR]"), (profiles_dir, "[PROFILES_DIR]")];
    dirs.retain(|(d, _)| !d.is_empty());
    dirs.sort_by_key(|b| std::cmp::Reverse(b.0.len()));

    for (dir, label) in dirs {
        redact_dir(&mut result, dir, label);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Initialize `REDACT_PATHS` for tests. Uses `get_or_init` so repeated
    /// calls are idempotent — `OnceLock::set` only succeeds once, which would
    /// make subsequent test setups silently no-op.
    fn init_redact_paths_for_test() {
        REDACT_PATHS.get_or_init(|| {
            (
                "/home/user/.config/zephyr/core".to_owned(),
                "/home/user/.config/zephyr/profiles".to_owned(),
            )
        });
    }

    #[test]
    fn test_core_event_creation() {
        let event = CoreEvent::info(EventModule::Core, codes::CORE_START_FAILED, "test message");
        assert!(matches!(event.level, EventLevel::Info));
        assert!(matches!(event.module, EventModule::Core));
        assert_eq!(event.code, 1001);
        assert_eq!(event.message, "test message");
        assert!(event.timestamp > 0);
    }

    #[test]
    fn test_redact_error_message() {
        init_redact_paths_for_test();
        let msg = "Failed to read /home/user/.config/zephyr/core/run_config.yaml";
        let redacted = redact_error_message(msg);
        assert!(redacted.contains("[CORE_DIR]"));
        assert!(!redacted.contains("/home/user/.config/zephyr/core"));
    }

    // -- Snapshot tests for error redaction --------------------------------

    #[test]
    fn snapshot_redact_core_dir() {
        init_redact_paths_for_test();
        insta::assert_snapshot!(redact_error_message(
            "Failed to read /home/user/.config/zephyr/core/run_config.yaml"
        ));
    }

    #[test]
    fn snapshot_redact_profiles_dir() {
        init_redact_paths_for_test();
        insta::assert_snapshot!(redact_error_message(
            "Error loading /home/user/.config/zephyr/profiles/default.yaml: permission denied"
        ));
    }

    #[test]
    fn snapshot_redact_both_dirs() {
        init_redact_paths_for_test();
        insta::assert_snapshot!(redact_error_message(
            "Core at /home/user/.config/zephyr/core failed; profiles at /home/user/.config/zephyr/profiles also failed"
        ));
    }

    #[test]
    fn snapshot_redact_no_match() {
        init_redact_paths_for_test();
        insta::assert_snapshot!(redact_error_message("An unrelated error occurred"));
    }
}
