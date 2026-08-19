//! `ZephyrPrismHost` --- bridges Prism Engine to Zephyr's internal state.

use tauri::Manager as _;

use clash_prism_extension::{ApplyStatus, CoreInfo, PrismEvent, PrismHost, ProfileInfo};

use crate::backend_event::{codes, lock_best_effort, lock_critical, BackendModule};
use crate::core_manager::core::MAX_RESPONSE_SIZE;
use crate::core_manager::{ensure_app_storage, read_profile_file, write_file_secure, MihomoState};
use zephyr_core::config::sanitizer::validate_path_within_dir;

use super::prism_data_dir;
use super::types::sanitize_filename;

// ── Thread-confined HTTP status bridge for ext.apply() ───────────────────
// (WiFi SSID detection now lives in network_coordinator)

use std::cell::Cell;

thread_local! {
    static CURRENT_APPLY_HTTP_STATUS: Cell<Option<u16>> = const { Cell::new(None) };
}

pub(crate) fn set_current_apply_http_status(status: Option<u16>) {
    CURRENT_APPLY_HTTP_STATUS.with(|c| c.set(status));
}

#[must_use]
pub(crate) fn take_current_apply_http_status() -> Option<u16> {
    CURRENT_APPLY_HTTP_STATUS.with(Cell::take)
}

/// RAII Scope Guard for thread-confined HTTP status bridge during `ext.apply()`.
///
/// ### Hard Architectural Invariants:
/// 1. **Same-Thread Synchronous Execution**: `clash_prism_extension::Apply` and
///    `ZephyrPrismHost::apply_config` MUST execute synchronously on the exact same OS thread
///    as `HttpStatusGuard::enter()`. The thread-local bridge assumes no internal thread hopping
///    occurs inside `ext.apply()`.
/// 2. **Single-Flight Concurrency**: Mihomo `PUT /configs` is serialized by the Coordinator's
///    single-flight state machine, preventing concurrent overlapping rule applications.
/// 3. **Guaranteed RAII Cleanup**: Whether `ext.apply()` completes normally, returns `Err(?)`
///    via early return, or unwinds, `Drop` unconditionally clears the thread-local storage,
///    preventing Tokio worker thread reuse pollution.
pub(crate) struct HttpStatusGuard {
    taken: bool,
    // !Send marker: enforces at compile time that the guard cannot cross
    // thread boundaries. The thread-local `CURRENT_APPLY_HTTP_STATUS` is
    // only valid on the thread that called `enter()`.
    _marker: std::marker::PhantomData<*const ()>,
}

impl HttpStatusGuard {
    #[must_use]
    pub fn enter() -> Self {
        CURRENT_APPLY_HTTP_STATUS.with(|c| c.set(None));
        Self {
            taken: false,
            _marker: std::marker::PhantomData,
        }
    }

    #[must_use]
    pub fn take(mut self) -> Option<u16> {
        self.taken = true;
        take_current_apply_http_status()
    }
}

impl Drop for HttpStatusGuard {
    fn drop(&mut self) {
        if !self.taken {
            let _ = take_current_apply_http_status();
        }
    }
}

pub(crate) struct ZephyrPrismHost {
    app: tauri::AppHandle,
}

impl ZephyrPrismHost {
    pub(crate) const fn new(app: tauri::AppHandle) -> Self {
        Self { app }
    }

    /// Synchronous HTTP PUT to localhost --- no tokio dependency.
    /// Used by `apply_config` which is a sync trait method callable from any thread.
    fn http_put(url: &str, body: &str, bearer: &str) -> Option<u16> {
        use std::io::{Read as _, Write as _};
        use std::net::TcpStream;

        let parsed = match url::Url::parse(url) {
            Ok(u) => u,
            Err(_) => return None,
        };

        let host = parsed.host_str().unwrap_or("127.0.0.1");
        let port = parsed.port().unwrap_or(9090);
        let target = &parsed[url::Position::BeforePath..url::Position::AfterQuery];

        // Connect with timeout (2s connect, 5s total)
        let mut stream = match TcpStream::connect_timeout(
            &format!("{host}:{port}")
                .parse()
                .unwrap_or_else(|_| std::net::SocketAddr::from(([127, 0, 0, 1], port))),
            std::time::Duration::from_secs(2),
        ) {
            Ok(s) => s,
            Err(_) => return None,
        };
        stream
            .set_read_timeout(Some(std::time::Duration::from_secs(5)))
            .ok();
        stream
            .set_write_timeout(Some(std::time::Duration::from_secs(5)))
            .ok();

        let auth_header = if bearer.is_empty() {
            String::new()
        } else {
            format!("Authorization: Bearer {bearer}\r\n")
        };

        let request = format!(
            "PUT {target} HTTP/1.1\r\n\
             Host: {host}:{port}\r\n\
             Content-Type: application/json\r\n\
             Content-Length: {}\r\n\
             Connection: close\r\n\
             {auth_header}\
             \r\n\
             {body}",
            body.len()
        );

        if stream.write_all(request.as_bytes()).is_err() {
            return None;
        }

        // Read response status line (first line only)
        let mut buf = [0u8; 256];
        let mut response = Vec::new();
        loop {
            match stream.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => response.extend_from_slice(buf.get(..n).unwrap_or_default()),
            }
            // Stop after we have the status line
            if response.windows(4).any(|w| w == b"\r\n\r\n") {
                break;
            }
        }

        // Parse 3-digit HTTP status code (e.g. "HTTP/1.1 204 No Content" -> 204)
        // Tokenize by whitespace to support any HTTP version (HTTP/1.0, HTTP/1.1, HTTP/2).
        let head = response
            .split(|b| *b == b'\r' || *b == b'\n')
            .next()
            .unwrap_or(&[]);
        let line = match std::str::from_utf8(head) {
            Ok(s) => s,
            Err(_) => return None,
        };
        // Reject malformed status lines: require "HTTP/<digit>.<digit>" prefix.
        // This rejects "HTTP/ 200 OK" or "HTTP/nonsense 200 OK" which would
        // otherwise produce a false-positive status parse.
        let mut parts = line.split_whitespace();
        let version = parts.next().unwrap_or("");
        let vb = version.as_bytes();
        if !(version.starts_with("HTTP/")
            && vb.len() >= 7
            && vb.get(5).is_some_and(u8::is_ascii_digit)
            && vb.get(6) == Some(&b'.'))
        {
            return None;
        }
        parts.next().and_then(|tok| {
            // Reject malformed status tokens: the token must be exactly
            // three ASCII digits (e.g. "204", not "0200" or "7").
            if tok.len() == 3 && tok.bytes().all(|b| b.is_ascii_digit()) {
                tok.parse::<u16>().ok()
            } else {
                None
            }
        })
    }
}

impl PrismHost for ZephyrPrismHost {
    // -- Required methods ----------------------------------------------------

    fn read_running_config(&self) -> Result<String, String> {
        let paths = ensure_app_storage(&self.app)?;
        std::fs::read_to_string(paths.core_dir.join("run_config.yaml"))
            .map_err(|e| format!("Failed to read running config: {e}"))
    }

    fn apply_config(&self, config: &str) -> Result<ApplyStatus, String> {
        let paths = ensure_app_storage(&self.app)?;
        let run_config_path = paths.core_dir.join("run_config.yaml");

        // Secure write (Unix 0600 / Windows DACL)
        write_file_secure(&run_config_path, config)?;

        // Hot-reload via mihomo REST API (PUT for full config replacement)
        let (port, secret) = {
            let state = self.app.state::<MihomoState>();
            let lock = lock_critical(&state.0, BackendModule::Core, codes::CORE_LOCK_FAILED)?;
            (
                lock.last_port().unwrap_or(9090),
                lock.last_secret().to_owned(),
            )
        };

        let url = format!("http://127.0.0.1:{port}/configs?force=true");
        // Mihomo's PUT /configs expects a JSON body {"path": "..."} to reload
        // from disk — NOT the raw YAML config. Sending raw YAML with
        // Content-Type: application/json causes a silent 400 Bad Request.
        let body = serde_json::json!({ "path": run_config_path.to_string_lossy() }).to_string();
        // Synchronous HTTP PUT --- apply_config is a sync trait method that may be
        // called from non-tokio threads (e.g. WebView2 COM callbacks). Using
        // std::net avoids the "no reactor running" panic from block_on().
        let http_status_code = Self::http_put(&url, &body, &secret);
        set_current_apply_http_status(http_status_code);
        let hot_reload_success =
            http_status_code.is_some_and(crate::network_coordinator::is_http_success);

        Ok(ApplyStatus {
            files_saved: true,
            hot_reload_success,
            message: match http_status_code {
                Some(code) if crate::network_coordinator::is_http_success(code) => {
                    format!("Config applied and reloaded (HTTP {code})")
                }
                Some(code) => {
                    format!("Core rejected reload with HTTP {code}. Restart core to apply.")
                }
                None => "Config saved. Failed to connect to core REST API. Restart core to apply."
                    .to_owned(),
            },
            restarted: false,
        })
    }

    fn get_prism_workspace(&self) -> Result<std::path::PathBuf, String> {
        prism_data_dir(&self.app)
    }

    fn notify(&self, event: PrismEvent) {
        crate::backend_event::emit_to_main(&self.app, "prism-event", event);
    }

    // -- Optional methods (override defaults) --------------------------------

    fn read_raw_profile(&self, profile_id: &str) -> Result<String, String> {
        // H-5: Sanitize profile_id to prevent path traversal
        let safe_id = sanitize_filename(profile_id)?;
        let paths = ensure_app_storage(&self.app)?;
        let profile_path = paths.profiles_dir.join(&safe_id);
        validate_path_within_dir(&profile_path, &paths.profiles_dir).map_err(|e| e.to_string())?;
        let metadata = std::fs::metadata(&profile_path)
            .map_err(|e| format!("Failed to read profile '{safe_id}': {e}"))?;
        if metadata.len() > MAX_RESPONSE_SIZE as u64 {
            return Err(format!(
                "Profile '{safe_id}' exceeds maximum size of {MAX_RESPONSE_SIZE} bytes"
            ));
        }
        // Use read_profile_file to auto-decrypt encrypted profiles (encrypt_configs)
        // Without this, encrypted YAML is parsed as a plain string,
        // causing "No 'rules' section found in profile" when extracting rules.
        read_profile_file(&profile_path)
            .map_err(|e| format!("Failed to read profile '{safe_id}': {e}"))
    }

    fn list_profiles(&self) -> Result<Vec<ProfileInfo>, String> {
        let paths = ensure_app_storage(&self.app)?;
        let current = {
            let state = self.app.state::<MihomoState>();
            state
                .0
                .lock()
                .ok()
                .and_then(|lock| lock.last_config_path().map(String::from))
                .unwrap_or_default()
        };

        let entries = std::fs::read_dir(&paths.profiles_dir)
            .map_err(|e| format!("Failed to read profiles dir: {e}"))?;

        let mut profiles = Vec::new();
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            let is_yaml = name.ends_with(".yaml") || name.ends_with(".yml");
            if is_yaml {
                let is_current = name == current;
                profiles.push(ProfileInfo {
                    id: name.clone(),
                    name,
                    profile_type: "local".to_owned(),
                    is_current,
                });
            }
        }

        Ok(profiles)
    }

    fn get_core_info(&self) -> Result<CoreInfo, String> {
        let state = self.app.state::<MihomoState>();
        let lock = lock_critical(&state.0, BackendModule::Core, codes::CORE_LOCK_FAILED)?;
        Ok(CoreInfo {
            version: String::from("unknown"), // async get_core_version unavailable in sync trait
            api_port: lock.last_port().unwrap_or(9090),
            api_secret: lock.last_secret().to_owned(),
            is_running: lock.process().is_some(),
        })
    }

    fn get_current_profile(&self) -> Option<String> {
        let state = self.app.state::<MihomoState>();
        let path = lock_best_effort(&state.0).last_config_path()?.to_owned();
        let stem = std::path::Path::new(&path)
            .file_stem()
            .and_then(|s| s.to_str())
            .map(String::from);
        stem
    }

    fn get_variables(&self) -> std::collections::HashMap<String, String> {
        let mut vars = std::collections::HashMap::new();

        // Read the final merged config (run_config.yaml) to extract proxy-group names.
        // This allows {{proxy|DIRECT}} in .prism.yaml files to resolve to the actual
        // proxy group name from the current subscription.
        let paths = match ensure_app_storage(&self.app) {
            Ok(p) => p,
            Err(_) => return vars,
        };
        let run_config = paths.core_dir.join("run_config.yaml");
        let content = match std::fs::read_to_string(&run_config) {
            Ok(c) => c,
            Err(_) => return vars,
        };

        // Parse just enough to get proxy-groups[].name
        if let Ok(config) = serde_yaml::from_str::<serde_yaml::Value>(&content) {
            if let Some(groups) = config.get("proxy-groups").and_then(|g| g.as_sequence()) {
                // Collect all non-special proxy group names
                let names: Vec<String> = groups
                    .iter()
                    .filter_map(|g| g.get("name").and_then(|n| n.as_str()).map(String::from))
                    .filter(|n| {
                        // Skip internal/special groups
                        !matches!(n.as_str(), "GLOBAL" | "DIRECT" | "REJECT" | "PASS")
                    })
                    .collect();

                // Provide "proxy" = first usable proxy group name (typically the main selector)
                if let Some(first) = names.first() {
                    vars.insert("proxy".to_owned(), first.clone());
                }

                // Also provide each group name as a variable (identity mapping)
                // so users can reference specific groups.
                for name in &names {
                    vars.insert(name.clone(), name.clone());
                }
                // Debug: log resolved variables for diagnosing cross-subscription rule errors
                let proxy_val = vars.get("proxy").map(String::as_str).unwrap_or("<none>");
                emit_info!(
                    Prism,
                    PRISM_SCRIPT_ERROR,
                    "get_variables: proxy={proxy_val}, groups={names:?}"
                );
            }
        }

        vars
    }

    fn validate_config(&self, config: &str) -> Result<bool, String> {
        let paths = ensure_app_storage(&self.app)?;
        let tmp_path = paths.core_dir.join("_prism_validate.yaml");
        write_file_secure(&tmp_path, config)?;

        let exe = crate::core_manager::get_core_exe_path(&self.app)?;
        let mut cmd = std::process::Command::new(&exe);
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt as _;
            cmd.creation_flags(crate::core_manager::CREATE_NO_WINDOW);
        }
        let output = cmd
            .args(["-t", "-f"])
            .arg(&tmp_path)
            .output()
            .map_err(|e| format!("Failed to run validation: {e}"))?;

        let _ = std::fs::remove_file(&tmp_path);
        Ok(output.status.success())
    }

    fn get_ssid(&self) -> Option<String> {
        crate::network_coordinator::detect_ssid()
    }
}
