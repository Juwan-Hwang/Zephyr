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
    // `Rc<()>` is `!Send` and `!Sync`, which is stronger than `*const ()`
    // (the latter does not actually prevent `Send` auto-derivation).
    _marker: std::marker::PhantomData<std::rc::Rc<()>>,
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
        // Tokenize by whitespace; validate version as HTTP/<digit>.<digit>.
        let head = response
            .split(|b| *b == b'\r' || *b == b'\n')
            .next()
            .unwrap_or(&[]);
        let line = match std::str::from_utf8(head) {
            Ok(s) => s,
            Err(_) => return None,
        };
        // Reject malformed status lines: require exactly "HTTP/<digit>.<digit>".
        // This rejects "HTTP/ 200 OK", "HTTP/nonsense 200 OK", "HTTP/1.",
        // "HTTP/1.1junk", etc.
        let mut parts = line.split_whitespace();
        let version = parts.next().unwrap_or("");
        let vb = version.as_bytes();
        if !(version.starts_with("HTTP/")
            && vb.len() == 8
            && vb.get(5).is_some_and(u8::is_ascii_digit)
            && vb.get(6) == Some(&b'.')
            && vb.get(7).is_some_and(u8::is_ascii_digit))
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

/// Same rule as `restore_unchanged_provider_paths` in the pipeline,
/// for the YAML values this path works with: a provider `path` /
/// `script-path` the script left exactly as it was in the running
/// config is restored after the import sanitizer strips it. The
/// script's own output is `modified`; the on-disk `run_config.yaml`
/// is `before`.
fn restore_unchanged_provider_paths_yaml(
    stripped: &mut serde_yaml::Value,
    modified: &serde_yaml::Value,
    before: &serde_yaml::Value,
) {
    // A tagged node wraps the real one: mihomo's decoder looks through
    // the tag, and so does the sanitizer that stripped these paths — so
    // every level this function reads (root, section, provider) must be
    // unwrapped, or the lookups below return None and the stripped
    // paths are never restored. Same unwrap as the
    // external-controller injection in `apply_config` below.
    let stripped_root = untagged_mut(stripped);
    let before_root = untagged(before);
    let modified_root = untagged(modified);
    for section in ["proxy-providers", "rule-providers"] {
        let section_key = serde_yaml::Value::String(section.to_owned());
        let Some(stripped_providers) = stripped_root
            .as_mapping_mut()
            .and_then(|m| m.get_mut(section_key.clone()))
            .and_then(|v| untagged_mut(v).as_mapping_mut())
        else {
            continue;
        };
        let Some(before_providers) = before_root
            .as_mapping()
            .and_then(|m| m.get(section_key.clone()))
            .and_then(|v| untagged(v).as_mapping())
        else {
            continue;
        };
        let Some(modified_providers) = modified_root
            .as_mapping()
            .and_then(|m| m.get(section_key.clone()))
            .and_then(|v| untagged(v).as_mapping())
        else {
            continue;
        };
        let names: Vec<serde_yaml::Value> = stripped_providers.keys().cloned().collect();
        for name in names {
            let Some(before_provider) = before_providers.get(name.clone()) else {
                continue;
            };
            let Some(modified_provider) = modified_providers.get(name.clone()) else {
                continue;
            };
            let Some(provider) = stripped_providers.get_mut(name.clone()) else {
                continue;
            };
            let (Some(provider_map), Some(before_map), Some(modified_map)) = (
                untagged_mut(provider).as_mapping_mut(),
                untagged(before_provider).as_mapping(),
                untagged(modified_provider).as_mapping(),
            ) else {
                continue;
            };
            // Compare per key, merge-aware: the script may change
            // something else about the provider (its interval, say)
            // while leaving `path` alone, and whole-provider equality
            // would then drop a path the script never touched. A key
            // counts as untouched only when its merged value — direct
            // or inherited through `<<` — is the same on both sides.
            // The value is written back flat: mihomo resolves a direct
            // key over a merge source, so the effective config is
            // unchanged even though the sanitizer also stripped the
            // inherited copy out of the merge source.
            for key in ["path", "script-path"] {
                let key_value = serde_yaml::Value::String(key.to_owned());
                if provider_map.contains_key(key_value.clone()) {
                    continue;
                }
                let Some(before_value) =
                    zephyr_core::config::sanitizer::merged_mapping_get(before_map, key, 0)
                else {
                    continue;
                };
                let modified_value =
                    zephyr_core::config::sanitizer::merged_mapping_get(modified_map, key, 0);
                if modified_value == Some(before_value) {
                    provider_map.insert(key_value, before_value.clone());
                }
            }
        }
    }
}

/// Look through tagged values to the node they wrap.
fn untagged(value: &serde_yaml::Value) -> &serde_yaml::Value {
    let mut target = value;
    while let serde_yaml::Value::Tagged(tagged) = target {
        target = &tagged.value;
    }
    target
}

/// Look through tagged values to the node they wrap (mutable).
fn untagged_mut(value: &mut serde_yaml::Value) -> &mut serde_yaml::Value {
    let mut target = value;
    while let serde_yaml::Value::Tagged(tagged) = target {
        target = &mut tagged.value;
    }
    target
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

        // Hold the reload-and-reconcile sequence for this whole
        // reload, as the pipeline path does, from the generation
        // snapshot through the confirmation and the publication it
        // feeds. Taking the lock only for the reconciliation — the
        // earlier shape — left the snapshot and the PUT outside it: a
        // pipeline sequence that published in between bumped the
        // generation and voided this reload's confirmed result even
        // when this PUT was the later one, so the tray kept the earlier
        // publisher's state while the core ran this config. The guard
        // cannot be handed to the reconciliation thread (`MutexGuard`
        // is not `Send`), so it stays on this thread and that thread is
        // joined below while the guard is held; the thread-local HTTP
        // status is also set on this thread, before the join, exactly
        // as `apply_internal` expects. This thread already blocks its
        // caller under the Prism inner lock for the PUT; the join adds
        // the confirmation wait to that block, which is the price of
        // keeping the sequence ordered end to end.
        //
        // The managed endpoint is re-read just before it is injected
        // into the config below: a core restart while this waited for
        // the sequence lock changes the port and secret, and the filter
        // restores those same values into the config — a restart
        // between the injection and the PUT would otherwise leave the
        // file carrying the previous core's address and secret.
        let sequence = super::pipeline::acquire_reload_reconcile_lock();
        // The caller holds `RUN_CONFIG_LOCK` for the whole apply: all
        // four `ext.apply` sites take it before the Prism inner lock,
        // so the order is `RUN_CONFIG_LOCK` → inner → sequence
        // everywhere. This function must NOT take it itself — the mutex
        // is not re-entrant, and the batch/write/rebuild callers
        // already hold it on this thread, so taking it here would
        // deadlock instead of serializing. It is held for the whole
        // apply, through the write and the reload signal below.
        // Fail closed while a core start is in progress (see
        // `CORE_START_COUNT` in the pipeline): the start is replacing
        // `run_config.yaml` with fresh credentials, and an apply here
        // would write the previous run's port/secret back into the
        // file and fail the startup health check.
        if super::pipeline::core_start_in_progress() {
            return Err("Prism apply refused: a core start is in progress".to_owned());
        }

        // A script may add an unauthenticated control surface (such as
        // `external-controller-unix`) to the config it hands back; the
        // strip in `prepare_runtime_config` never sees Prism output, so
        // filter it here before the config is written and hot-reloaded.
        // The strip also removes provider `path` / `script-path` keys a
        // script may add: the import sanitizer strips those, and the
        // same rule applies to script output — otherwise a provider
        // path inside the core directory would be kept and reloaded,
        // and mihomo would load it. The TCP `external-controller` /
        // `secret` are left alone by the strip, because
        // `prepare_runtime_config` re-injects the managed values right
        // after. This writer has no such step, so a script that sets
        // `external-controller` to `0.0.0.0:9090` and clears `secret`
        // would reach the reload as-is. Restore the managed values
        // (read above, under the sequence lock) instead: the written
        // config always carries the controller the app itself uses,
        // never the script's.
        // An unparsable input is rejected, not written as-is: the
        // single-document parser refuses multi-document input, so a
        // script output like `external-controller-unix: /tmp/x`
        // followed by `---` would otherwise be written raw — leaving
        // an unauthenticated control surface on disk for a later
        // restart to load, and possibly in the reload itself. The same
        // holds for a failed re-serialization. The previous config
        // keeps running; the script's output is reported as an error.
        let filtered;
        // Bound here so the PUT and the TUN confirmation below can use
        // the same values: assigned inside the parse arm, just before
        // they are injected (see below) — a start that begins during
        // the parse must not leave stale values in the file, and the
        // reload must talk to the core those values describe. `None`
        // means no core is running: the file is still written, but
        // without the injection and without a reload (see below).
        let endpoint: Option<(u16, String)>;
        let config_to_write: &str = match serde_yaml::from_str::<serde_yaml::Value>(config) {
            Ok(mut value) => {
                // The full import sanitizer, not just the control-plane
                // strip: it also removes provider `path` / `script-path`
                // keys (see the comment above) and `script` keys.
                // Snapshot the script's output first: the restore below
                // compares providers against it to tell a path the
                // script left alone from one the script set.
                let modified = value.clone();
                zephyr_core::config::sanitizer::remove_dangerous_keys_internal_pub(
                    &mut value, false,
                );
                // A provider path the script did not touch is not the
                // script's to remove: restore it from the running
                // config on disk, exactly as the pipeline path does.
                // Best-effort — if the file cannot be read or parsed,
                // the path simply stays stripped, as today.
                if let Ok(before_text) = self.read_running_config() {
                    if let Ok(before) = serde_yaml::from_str::<serde_yaml::Value>(&before_text) {
                        restore_unchanged_provider_paths_yaml(&mut value, &modified, &before);
                    }
                }
                let mut target = &mut value;
                while let serde_yaml::Value::Tagged(tagged) = target {
                    target = &mut tagged.value;
                }
                // Re-read the managed values here, just before injecting
                // them: a core start can begin after the check above (the
                // start path takes no lock this function holds), and the
                // values read then would be stale — writing them back
                // would undo the start's fresh credentials. Fail closed
                // if a start is in progress now. But a core that has
                // simply not published its controller yet is not an
                // error: it is stopped, not starting, and the next start
                // writes fresh credentials — so the file is still
                // written, without the injection and without a reload
                // (same rule as `write_running_config` in the pipeline).
                if super::pipeline::core_start_in_progress() {
                    return Err("Prism apply refused: a core start is in progress".to_owned());
                }
                endpoint = {
                    let state = self.app.state::<MihomoState>();
                    let lock =
                        lock_critical(&state.0, BackendModule::Core, codes::CORE_LOCK_FAILED)?;
                    lock.last_port()
                        .map(|port| (port, lock.last_secret().to_owned()))
                };
                if let Some((port, secret)) = &endpoint {
                    if let serde_yaml::Value::Mapping(map) = target {
                        map.insert(
                            serde_yaml::Value::String("external-controller".to_owned()),
                            serde_yaml::Value::String(format!("127.0.0.1:{port}")),
                        );
                        map.insert(
                            serde_yaml::Value::String("secret".to_owned()),
                            serde_yaml::Value::String(secret.clone()),
                        );
                    }
                }
                match serde_yaml::to_string(&value) {
                    Ok(text) => {
                        filtered = text;
                        &filtered
                    }
                    Err(e) => {
                        return Err(format!("Failed to serialize filtered Prism config: {e}"));
                    }
                }
            }
            Err(e) => {
                return Err(format!("Prism script output is not valid YAML: {e}"));
            }
        };

        // Re-check immediately before the write: a start that began
        // during the filter/serialize above would have its fresh
        // credentials overwritten by this write.
        if super::pipeline::core_start_in_progress() {
            return Err("Prism apply refused: a core start is in progress".to_owned());
        }

        // Secure write (Unix 0600 / Windows DACL) through a temporary file:
        // a failed write leaves the config the core loaded intact.
        crate::core_manager::core::secure_io::write_file_secure_atomic(
            &run_config_path,
            config_to_write,
        )?;

        // Mihomo's PUT /configs expects a JSON body {"path": "..."} to reload
        // from disk — NOT the raw YAML config. Sending raw YAML with
        // Content-Type: application/json causes a silent 400 Bad Request.
        let body = serde_json::json!({ "path": run_config_path.to_string_lossy() }).to_string();
        // Snapshot the live-state generation before the reload: the PUT
        // below can block for seconds, and a snapshot taken only after
        // it returns would include a TUN preference recorded in the
        // meantime, letting the reconciliation below vouch for a result
        // that preference should have voided.
        let epoch = crate::core_manager::core::tun_manager::live_tun_state_epoch();
        // Hot-reload via mihomo REST API (PUT for full config replacement).
        // The endpoint was read above, under the sequence lock, so the
        // PUT talks to the same core the injected controller values
        // belong to. With no endpoint the core is stopped: there is
        // nothing to reload, so no PUT is made — but a 0 is still
        // recorded (a reload attempt with no answer), rather than
        // leaving "no reload was attempted" (None), or the caller
        // retries the reload itself against the stopped core (see
        // `execute_prism_yaml_write`).
        // Synchronous HTTP PUT --- apply_config is a sync trait method that may be
        // called from non-tokio threads (e.g. WebView2 COM callbacks). Using
        // std::net avoids the "no reactor running" panic from block_on().
        let http_status_code = match &endpoint {
            Some((port, secret)) => {
                let url = format!("http://127.0.0.1:{port}/configs?force=true");
                let code = Self::http_put(&url, &body, secret);
                // A reload attempt without an HTTP answer (the connection or the
                // write failed, or the core never replied) is recorded as 0, so
                // callers can tell it from "no reload was attempted" (None);
                // `reload_outcome` in prism.rs reports it as a failed reload
                // without an HTTP status.
                set_current_apply_http_status(Some(code.unwrap_or(0)));
                code
            }
            None => {
                set_current_apply_http_status(Some(0));
                None
            }
        };
        let hot_reload_success =
            http_status_code.is_some_and(crate::network_coordinator::is_http_success);

        let tray_refresh_needed = if hot_reload_success {
            // The reload succeeded, so the PUT ran and an endpoint
            // exists; the stopped-core path never reaches this branch
            // (`hot_reload_success` is false without a PUT).
            if let Some((port, secret)) = &endpoint {
                // This path hot-reloads on its own instead of going through
                // `trigger_hot_reload_and_reconcile_tun`, so it owes the same
                // reconciliation: a patch applied here can flip `tun.enable`
                // on the running core, and without it the tray keeps
                // reporting the recorded preference. Confirm the applied
                // state with the core first, exactly as the pipeline path
                // does — the file alone is never enough. The confirmation
                // runs on its own thread (`confirmed_tun_enabled` builds a
                // blocking reqwest client, which cannot run on a runtime
                // thread), joined while this thread holds the sequence
                // guard above, so no other sequence can publish between
                // this reload and its reconciliation.
                // Own the values before the spawn: the closure must be
                // 'static, and `endpoint` is dropped at the end of this
                // function — borrowing it into the thread does not
                // compile (E0597).
                let port = *port;
                let secret = secret.clone();
                let app = self.app.clone();
                let confirmation = std::thread::spawn(move || {
                    if let Some(applied) = super::pipeline::confirmed_tun_enabled(port, &secret) {
                        crate::core_manager::core::tun_manager::reconcile_tun_with_core(
                            &app, applied, epoch,
                        )
                    } else {
                        false
                    }
                });
                confirmation.join().unwrap_or(false)
            } else {
                false
            }
        } else {
            false
        };
        drop(sequence);
        if tray_refresh_needed {
            // The tray repaint runs only after the sequence lock is
            // released, on its own thread: tray writes wait on the main
            // thread, so holding the lock across them could deadlock
            // against a main-thread caller waiting on this lock (see
            // `reconcile_tun_with_core`).
            let app = self.app.clone();
            std::thread::spawn(move || {
                crate::core_manager::core::tun_manager::refresh_tray_after_reconcile(&app);
            });
        }

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
None => "Config saved. Failed to apply via core REST API (connection or response error). Restart core to apply."
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
        // Resolve the selected name to the stored entry: on a
        // case-insensitive volume the selection may differ in case
        // from the file on disk (`work.yaml` selects `Work.YAML`),
        // and a plain string comparison would mark it as not current.
        // On a case-sensitive volume the two spellings are distinct
        // files, and the resolver prefers the exact match, so they
        // are not conflated.
        let current_entry = crate::core_manager::core::config_manager::actual_entry_name(
            &paths.profiles_dir,
            &current,
        );
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            // Directories are not profiles, even when they carry a
            // YAML extension.
            let lower = name.to_lowercase();
            let is_yaml =
                entry.path().is_file() && (lower.ends_with(".yaml") || lower.ends_with(".yml"));
            if is_yaml {
                let is_current = name == current_entry;
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
        // One snapshot, so `is_running` and the connection details describe the
        // same core instance. The TUN-mode check runs after the lock is released.
        let state = self.app.state::<MihomoState>();
        let lock = lock_critical(&state.0, BackendModule::Core, codes::CORE_LOCK_FAILED)?;
        let started = lock.started_at().is_some();
        let has_process = lock.process().is_some();
        let last_port = lock.last_port();
        let api_secret = lock.last_secret().to_owned();
        drop(lock);
        let is_running = crate::core_manager::core::subscription::core_running_from(
            started,
            has_process,
            last_port.is_some(),
        );
        Ok(CoreInfo {
            version: String::from("unknown"), // async get_core_version unavailable in sync trait
            api_port: last_port.unwrap_or(9090),
            api_secret,
            is_running,
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

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    fn file_provider_yaml(path: &str) -> serde_yaml::Value {
        serde_yaml::from_str(&format!("type: file\npath: {path}\ninterval: 3600\n")).unwrap()
    }

    fn providers_yaml(provider: serde_yaml::Value) -> serde_yaml::Value {
        let mut top = serde_yaml::Mapping::new();
        let mut providers = serde_yaml::Mapping::new();
        providers.insert(serde_yaml::Value::String("local".to_owned()), provider);
        top.insert(
            serde_yaml::Value::String("proxy-providers".to_owned()),
            serde_yaml::Value::Mapping(providers),
        );
        serde_yaml::Value::Mapping(top)
    }

    #[test]
    fn restore_unchanged_provider_paths_yaml_restores_untouched_path() {
        let before = providers_yaml(file_provider_yaml("/profiles/local.yaml"));
        let modified = before.clone();
        let mut stripped = modified.clone();
        stripped
            .as_mapping_mut()
            .unwrap()
            .get_mut(serde_yaml::Value::String("proxy-providers".to_owned()))
            .unwrap()
            .as_mapping_mut()
            .unwrap()
            .get_mut(serde_yaml::Value::String("local".to_owned()))
            .unwrap()
            .as_mapping_mut()
            .unwrap()
            .remove(serde_yaml::Value::String("path".to_owned()));
        restore_unchanged_provider_paths_yaml(&mut stripped, &modified, &before);
        let path = stripped
            .as_mapping()
            .unwrap()
            .get(serde_yaml::Value::String("proxy-providers".to_owned()))
            .unwrap()
            .as_mapping()
            .unwrap()
            .get(serde_yaml::Value::String("local".to_owned()))
            .unwrap()
            .as_mapping()
            .unwrap()
            .get(serde_yaml::Value::String("path".to_owned()))
            .unwrap();
        assert_eq!(path.as_str(), Some("/profiles/local.yaml"));
    }

    #[test]
    fn restore_unchanged_provider_paths_yaml_restores_path_under_tagged_root() {
        // A tagged mapping root wraps the real node: the sanitizer
        // looks through the tag and strips the path, so the restore
        // must look through it too — otherwise the section lookups
        // return None and the path is lost from the written config.
        let before: serde_yaml::Value = serde_yaml::from_str(
            "!custom\nproxy-providers:\n  local:\n    type: file\n    path: /profiles/local.yaml\n    interval: 3600\n",
        )
        .unwrap();
        assert!(matches!(before, serde_yaml::Value::Tagged(_)));
        let modified = before.clone();
        let mut stripped: serde_yaml::Value = serde_yaml::from_str(
            "!custom\nproxy-providers:\n  local:\n    type: file\n    interval: 3600\n",
        )
        .unwrap();
        restore_unchanged_provider_paths_yaml(&mut stripped, &modified, &before);
        let path = untagged(&stripped)
            .as_mapping()
            .unwrap()
            .get(serde_yaml::Value::String("proxy-providers".to_owned()))
            .unwrap()
            .as_mapping()
            .unwrap()
            .get(serde_yaml::Value::String("local".to_owned()))
            .unwrap()
            .as_mapping()
            .unwrap()
            .get(serde_yaml::Value::String("path".to_owned()))
            .unwrap();
        assert_eq!(path.as_str(), Some("/profiles/local.yaml"));
    }

    #[test]
    fn restore_unchanged_provider_paths_yaml_restores_path_under_tagged_provider() {
        // Same tag transparency one level down: a tagged provider
        // value is stripped by the sanitizer too, so the restore
        // must look through it — otherwise `as_mapping_mut` returns
        // None and the path is lost from the written config.
        let before: serde_yaml::Value = serde_yaml::from_str(
            "proxy-providers:\n  local: !custom\n    type: file\n    path: /profiles/local.yaml\n    interval: 3600\n",
        )
        .unwrap();
        let provider = before
            .as_mapping()
            .unwrap()
            .get(serde_yaml::Value::String("proxy-providers".to_owned()))
            .unwrap()
            .as_mapping()
            .unwrap()
            .get(serde_yaml::Value::String("local".to_owned()))
            .unwrap();
        assert!(matches!(provider, serde_yaml::Value::Tagged(_)));
        let modified = before.clone();
        let mut stripped: serde_yaml::Value = serde_yaml::from_str(
            "proxy-providers:\n  local: !custom\n    type: file\n    interval: 3600\n",
        )
        .unwrap();
        restore_unchanged_provider_paths_yaml(&mut stripped, &modified, &before);
        let provider = untagged(&stripped)
            .as_mapping()
            .unwrap()
            .get(serde_yaml::Value::String("proxy-providers".to_owned()))
            .unwrap()
            .as_mapping()
            .unwrap()
            .get(serde_yaml::Value::String("local".to_owned()))
            .unwrap();
        let path = untagged(provider)
            .as_mapping()
            .unwrap()
            .get(serde_yaml::Value::String("path".to_owned()))
            .unwrap();
        assert_eq!(path.as_str(), Some("/profiles/local.yaml"));
    }

    #[test]
    fn restore_unchanged_provider_paths_yaml_restores_path_under_tagged_section() {
        // And one level up: a tagged section value is stripped the
        // same way, so the section lookup must look through it too.
        let before: serde_yaml::Value = serde_yaml::from_str(
            "proxy-providers: !custom\n  local:\n    type: file\n    path: /profiles/local.yaml\n    interval: 3600\n",
        )
        .unwrap();
        let section = before
            .as_mapping()
            .unwrap()
            .get(serde_yaml::Value::String("proxy-providers".to_owned()))
            .unwrap();
        assert!(matches!(section, serde_yaml::Value::Tagged(_)));
        let modified = before.clone();
        let mut stripped: serde_yaml::Value = serde_yaml::from_str(
            "proxy-providers: !custom\n  local:\n    type: file\n    interval: 3600\n",
        )
        .unwrap();
        restore_unchanged_provider_paths_yaml(&mut stripped, &modified, &before);
        let section = untagged(&stripped)
            .as_mapping()
            .unwrap()
            .get(serde_yaml::Value::String("proxy-providers".to_owned()))
            .unwrap();
        let path = untagged(section)
            .as_mapping()
            .unwrap()
            .get(serde_yaml::Value::String("local".to_owned()))
            .unwrap()
            .as_mapping()
            .unwrap()
            .get(serde_yaml::Value::String("path".to_owned()))
            .unwrap();
        assert_eq!(path.as_str(), Some("/profiles/local.yaml"));
    }

    #[test]
    fn restore_unchanged_provider_paths_yaml_ignores_script_added_path() {
        let before = providers_yaml(
            serde_yaml::from_str(
                "type: http\nurl: https://example.com/list.yaml\ninterval: 3600\n",
            )
            .unwrap(),
        );
        let mut modified = before.clone();
        modified
            .as_mapping_mut()
            .unwrap()
            .get_mut(serde_yaml::Value::String("proxy-providers".to_owned()))
            .unwrap()
            .as_mapping_mut()
            .unwrap()
            .get_mut(serde_yaml::Value::String("local".to_owned()))
            .unwrap()
            .as_mapping_mut()
            .unwrap()
            .insert(
                serde_yaml::Value::String("path".to_owned()),
                serde_yaml::Value::String("/tmp/evil.yaml".to_owned()),
            );
        let mut stripped = modified.clone();
        stripped
            .as_mapping_mut()
            .unwrap()
            .get_mut(serde_yaml::Value::String("proxy-providers".to_owned()))
            .unwrap()
            .as_mapping_mut()
            .unwrap()
            .get_mut(serde_yaml::Value::String("local".to_owned()))
            .unwrap()
            .as_mapping_mut()
            .unwrap()
            .remove(serde_yaml::Value::String("path".to_owned()));
        restore_unchanged_provider_paths_yaml(&mut stripped, &modified, &before);
        assert!(stripped
            .as_mapping()
            .unwrap()
            .get(serde_yaml::Value::String("proxy-providers".to_owned()))
            .unwrap()
            .as_mapping()
            .unwrap()
            .get(serde_yaml::Value::String("local".to_owned()))
            .unwrap()
            .as_mapping()
            .unwrap()
            .get(serde_yaml::Value::String("path".to_owned()))
            .is_none());
    }

    /// The `path` of the `local` provider in a config value, if present.
    fn provider_path_yaml(value: &serde_yaml::Value) -> Option<&str> {
        untagged(value)
            .as_mapping()
            .and_then(|m| m.get(serde_yaml::Value::String("proxy-providers".to_owned())))
            .and_then(|v| untagged(v).as_mapping())
            .and_then(|m| m.get(serde_yaml::Value::String("local".to_owned())))
            .and_then(|v| untagged(v).as_mapping())
            .and_then(|m| m.get(serde_yaml::Value::String("path".to_owned())))
            .and_then(serde_yaml::Value::as_str)
    }

    #[test]
    fn restore_unchanged_provider_paths_yaml_restores_path_when_only_interval_changed() {
        // The script changed the interval but left `path` alone: the
        // old whole-provider comparison dropped the path.
        let before = providers_yaml(file_provider_yaml("/profiles/local.yaml"));
        let mut modified = before.clone();
        modified
            .as_mapping_mut()
            .unwrap()
            .get_mut(serde_yaml::Value::String("proxy-providers".to_owned()))
            .unwrap()
            .as_mapping_mut()
            .unwrap()
            .get_mut(serde_yaml::Value::String("local".to_owned()))
            .unwrap()
            .as_mapping_mut()
            .unwrap()
            .insert(
                serde_yaml::Value::String("interval".to_owned()),
                serde_yaml::Value::Number(7200.into()),
            );
        let mut stripped = modified.clone();
        stripped
            .as_mapping_mut()
            .unwrap()
            .get_mut(serde_yaml::Value::String("proxy-providers".to_owned()))
            .unwrap()
            .as_mapping_mut()
            .unwrap()
            .get_mut(serde_yaml::Value::String("local".to_owned()))
            .unwrap()
            .as_mapping_mut()
            .unwrap()
            .remove(serde_yaml::Value::String("path".to_owned()));
        restore_unchanged_provider_paths_yaml(&mut stripped, &modified, &before);
        assert_eq!(provider_path_yaml(&stripped), Some("/profiles/local.yaml"));
    }

    #[test]
    fn restore_unchanged_provider_paths_yaml_restores_merged_path() {
        // The path is inherited through `<<`: the sanitizer strips it
        // out of the merge source, so the restore must find it there.
        let before: serde_yaml::Value = serde_yaml::from_str(
            "proxy-providers:\n  local:\n    type: file\n    <<:\n      path: /profiles/local.yaml\n    interval: 3600\n",
        )
        .unwrap();
        let modified = before.clone();
        let mut stripped: serde_yaml::Value = serde_yaml::from_str(
            "proxy-providers:\n  local:\n    type: file\n    <<: {}\n    interval: 3600\n",
        )
        .unwrap();
        restore_unchanged_provider_paths_yaml(&mut stripped, &modified, &before);
        assert_eq!(provider_path_yaml(&stripped), Some("/profiles/local.yaml"));
    }

    #[test]
    fn restore_unchanged_provider_paths_yaml_ignores_repointed_merged_path() {
        // The script repointed the merge source at a different path:
        // the merged value changed, so nothing is restored.
        let before: serde_yaml::Value = serde_yaml::from_str(
            "proxy-providers:\n  local:\n    type: file\n    <<:\n      path: /profiles/local.yaml\n    interval: 3600\n",
        )
        .unwrap();
        let modified: serde_yaml::Value = serde_yaml::from_str(
            "proxy-providers:\n  local:\n    type: file\n    <<:\n      path: /profiles/other.yaml\n    interval: 3600\n",
        )
        .unwrap();
        let mut stripped: serde_yaml::Value = serde_yaml::from_str(
            "proxy-providers:\n  local:\n    type: file\n    <<: {}\n    interval: 3600\n",
        )
        .unwrap();
        restore_unchanged_provider_paths_yaml(&mut stripped, &modified, &before);
        assert_eq!(provider_path_yaml(&stripped), None);
    }
}
