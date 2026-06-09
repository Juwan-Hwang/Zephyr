use std::sync::{Arc, RwLock};

/// Core application state shared across all platforms.
/// Tauri desktop: injected via `tauri::State<Arc<AppStore>>`
/// Android: held by ViewModel
/// iOS: held by @MainActor ObservableObject
#[cfg_attr(feature = "uniffi", derive(uniffi::Object))]
pub struct AppStore {
    inner: Arc<RwLock<StoreInner>>,
}

struct StoreInner {
    active_profile: Option<String>,
    core_running: bool,
}

impl Default for StoreInner {
    fn default() -> Self {
        Self {
            active_profile: None,
            core_running: false,
        }
    }
}

#[cfg_attr(feature = "uniffi", uniffi::export)]
impl AppStore {
    #[cfg_attr(feature = "uniffi", uniffi::constructor)]
    pub fn new() -> Self {
        Self {
            inner: Arc::new(RwLock::new(StoreInner::default())),
        }
    }

    pub fn get_active_profile(&self) -> Option<String> {
        self.inner
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .active_profile
            .clone()
    }

    pub fn set_active_profile(&self, profile: String) {
        self.inner
            .write()
            .unwrap_or_else(|e| e.into_inner())
            .active_profile = Some(profile);
    }

    pub fn is_core_running(&self) -> bool {
        self.inner
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .core_running
    }

    pub fn set_core_running(&self, running: bool) {
        self.inner
            .write()
            .unwrap_or_else(|e| e.into_inner())
            .core_running = running;
    }
}

// ── Smart state types — migrated from `src-tauri/src/prism/smart_state.rs` ──

/// WAL change record for smart state persistence.
#[cfg_attr(feature = "uniffi", derive(uniffi::Enum))]
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub enum ChangeRecord {
    Update {
        node_name: String,
        latency_ms: f64,
        success: bool,
        timestamp: i64,
    },
    Clear,
}

/// Configuration for smart state persistence — migrated from `src-tauri/src/prism/smart_state.rs`.
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
#[derive(Clone, Debug)]
pub struct SmartStateConfig {
    /// Trigger threshold for main file flush.
    pub flush_threshold: u64,
    /// WAL file path.
    pub wal_path: String,
    /// Main data file path.
    pub data_path: String,
}
