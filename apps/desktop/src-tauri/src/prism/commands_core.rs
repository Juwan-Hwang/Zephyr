//! Core Prism Engine IPC commands.

#![allow(clippy::needless_pass_by_value)]

use tauri::State;

use clash_prism_extension::{ApplyOptions, PrismExtension, RuleInsertPosition};

use super::types::MAX_INPUT_SIZE;
use crate::backend_event::{codes, lock_best_effort, lock_critical, BackendModule};
use crate::core_manager::core::core_process;
use crate::core_manager::read_profile_file;
use crate::prism::PrismState;

/// Helper: parse `RuleInsertPosition` from a frontend string.
pub(crate) fn parse_position(
    position: &str,
    group_id: Option<&str>,
) -> Result<RuleInsertPosition, String> {
    match position {
        "before_prism" => Ok(RuleInsertPosition::BeforePrism),
        "after_prism" => Ok(RuleInsertPosition::AfterPrism),
        "append" => Ok(RuleInsertPosition::Append),
        "after_group" => {
            let id =
                group_id.ok_or_else(|| "after_group requires a group_id parameter".to_owned())?;
            Ok(RuleInsertPosition::AfterGroup(id.to_owned()))
        }
        other => Err(format!("Unknown position: {other}")),
    }
}

/// Apply Prism rule engine changes to the running Mihomo configuration.
///
/// Compiles all `.prism.yaml` rule files, merges patches into the active
/// config, and hot-reloads via the Mihomo REST API. Runs in a blocking
/// thread pool to avoid starving other IPC commands during compilation
/// of large rule sets (65k+ rules).
///
/// Returns `{ patches, annotations, trace }` describing what was changed.
#[tauri::command]
pub async fn prism_apply(
    state: State<'_, PrismState>,
    options: Option<ApplyOptions>,
) -> Result<serde_json::Value, String> {
    state
        .apply_internal(options, false)
        .await
        .map(|(_, val)| val)
}

#[tauri::command]
pub fn prism_status(state: State<PrismState>) -> Result<serde_json::Value, String> {
    state.with_ext(|ext| {
        serde_json::to_value(ext.status()).map_err(|e| format!("Serialize failed: {e}"))
    })
}

#[tauri::command]
pub async fn prism_list_rules(
    state: State<'_, PrismState>,
    with_running_rules: Option<bool>,
    source_file: Option<String>,
) -> Result<serde_json::Value, String> {
    let inner = std::sync::Arc::clone(&state.inner);
    let app = state.app.clone();
    tokio::task::spawn_blocking(move || {
        // Config lock precedes the extension lock, just as on apply/rebuild.
        let _config =
            crate::config_manager::lock_run_config_within(std::time::Duration::from_secs(5))?;
        let lock = lock_critical(&inner, BackendModule::Prism, codes::PRISM_LOCK_FAILED)?;
        let ext = lock.extension.as_ref().ok_or("Prism not initialized")?;
        let mut groups = ext.list_rules()?;
        drop(lock);
        let annotations_confirmed = super::host::rule_annotations_confirmed();
        let state = tauri::Manager::state::<PrismState>(&app);
        let generated = super::rule_library::generated_rule_files(&state).ok();
        for group in &mut groups {
            if !annotations_confirmed
                || generated
                    .as_ref()
                    .is_none_or(|files| files.contains(&group.group_id))
            {
                group.immutable = true;
            }
        }
        if !with_running_rules.unwrap_or(false) {
            return serde_json::to_value(groups).map_err(|e| format!("Serialize failed: {e}"));
        }
        if crate::prism::pipeline::core_start_in_progress() {
            return Err(
                "Rule details unavailable during a core start or configuration reload".to_owned(),
            );
        }
        let endpoint = {
            let mihomo = tauri::Manager::state::<crate::core_manager::MihomoState>(&app);
            let core = lock_critical(&mihomo.0, BackendModule::Core, codes::CORE_LOCK_FAILED)?;
            (
                core.last_port().ok_or("Core is stopped")?,
                core.last_secret().to_owned(),
            )
        };
        let response = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(5))
            .no_proxy()
            .build()
            .map_err(|error| error.to_string())?
            .get(format!("http://127.0.0.1:{}/rules", endpoint.0))
            .bearer_auth(endpoint.1)
            .send()
            .and_then(reqwest::blocking::Response::error_for_status)
            .map_err(|error| format!("Active rule details unavailable: {error}"))?;
        use std::io::Read as _;
        let limit = crate::core_manager::core::MAX_RESPONSE_SIZE;
        let mut bytes = Vec::new();
        response
            .take(u64::try_from(limit + 1).unwrap_or(u64::MAX))
            .read_to_end(&mut bytes)
            .map_err(|error| format!("Active rule details unavailable: {error}"))?;
        if bytes.len() > limit {
            return Err(format!("Active rule details exceed the {limit}-byte limit"));
        }
        let active: serde_json::Value = serde_json::from_slice(&bytes)
            .map_err(|error| format!("Invalid active rule details: {error}"))?;
        let paths = crate::core_manager::ensure_app_storage(&app)?;
        let content = std::fs::read_to_string(paths.core_dir.join("run_config.yaml"))
            .map_err(|error| format!("Failed to read rule details: {error}"))?;
        let config: serde_yaml::Value = serde_yaml::from_str(&content)
            .map_err(|error| format!("Failed to parse rule details: {error}"))?;
        let rules = super::host::effective_runtime_rules(&config)?;
        // A row's editable file version belongs to this attribution snapshot,
        // not a later click after another writer may have moved its duplicates.
        let source_content = source_file
            .as_deref()
            .map(|filename| {
                let directory = super::prism_data_dir(&app)?;
                let path = super::types::resolve_rule_path(&directory, filename)?;
                let content = std::fs::read_to_string(&path)
                    .map_err(|error| format!("Failed to read rule source: {error}"))?;
                let name = path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .ok_or("Invalid rule source filename")?;
                if !super::host::rule_source_matches(name, &content)? {
                    return Err(
                        "Rule source differs from the confirmed build; apply it before editing"
                            .to_owned(),
                    );
                }
                Ok(content)
            })
            .transpose()?;
        Ok(serde_json::json!({
            "groups": groups,
            "rules": rules,
            "activeRules": active.get("rules"),
            "sourceFile": source_file,
            "sourceContent": source_content,
            "annotationsConfirmed": annotations_confirmed,
            "rulesRevision": super::host::rule_annotations_revision(),
        }))
    })
    .await
    .map_err(|error| format!("Rule details task failed: {error}"))?
}

#[tauri::command]
pub fn prism_preview_rules(
    state: State<PrismState>,
    patch_id: String,
) -> Result<serde_json::Value, String> {
    state.with_ext(|ext| {
        let diff = ext.preview_rules(&patch_id)?;
        serde_json::to_value(diff).map_err(|e| format!("Serialize failed: {e}"))
    })
}

/// Return the cached trace from the last `prism_apply` call.
/// This is a lightweight read-only operation — no recompilation.
#[tauri::command]
pub fn prism_get_last_trace(state: State<PrismState>) -> Result<serde_json::Value, String> {
    let lock = state
        .inner
        .lock()
        .map_err(|e| format!("Lock failed: {e}"))?;
    serde_json::to_value(&lock.last_trace).map_err(|e| format!("Serialize failed: {e}"))
}

#[tauri::command]
pub fn prism_is_prism_rule(
    state: State<PrismState>,
    index: usize,
) -> Result<serde_json::Value, String> {
    state.with_ext(|ext| {
        let info = ext.is_prism_rule(index)?;
        serde_json::to_value(info).map_err(|e| format!("Serialize failed: {e}"))
    })
}

#[tauri::command]
pub async fn prism_insert_rule_available() -> Result<(), String> {
    tokio::task::spawn_blocking(|| {
        let _config =
            crate::config_manager::lock_run_config_within(std::time::Duration::from_secs(5))?;
        if crate::prism::pipeline::core_start_in_progress() {
            return Err(
                "Rule insertion unavailable while the core configuration is changing".to_owned(),
            );
        }
        super::host::require_current_rule_insert_cache()
    })
    .await
    .map_err(|error| format!("Rule insertion availability task failed: {error}"))?
}

#[tauri::command]
pub async fn prism_insert_rule(
    state: State<'_, PrismState>,
    rule: serde_json::Value,
    position: String,
    group_id: Option<String>,
) -> Result<usize, String> {
    // Hold RUN_CONFIG_LOCK across the read-apply sequence: `insert_rule`
    // reads the current compiled output and `apply_config` writes it back,
    // and a core start completing in between would leave the old content
    // paired with the new credentials on disk. The lock order
    // (run-config lock, then the Prism inner lock) matches every other
    // `ext.apply` site; `apply_config` itself must NOT take it.
    let app = state.app.clone();
    tokio::task::spawn_blocking(move || {
        let _guard = crate::prism::pipeline::RUN_CONFIG_LOCK
            .lock()
            .map_err(|e| format!("Run config lock poisoned: {e}"))?;
        let state = tauri::Manager::state::<PrismState>(&app);
        state.with_ext(|ext| {
            super::host::require_current_rule_insert_cache()?;
            let pos = parse_position(&position, group_id.as_deref())?;
            ext.insert_rule(rule, &pos)
        })
    })
    .await
    .map_err(|error| format!("Rule insertion task failed: {error}"))?
}

#[tauri::command]
pub async fn prism_insert_rule_str(
    state: State<'_, PrismState>,
    rule_text: String,
    position: String,
    group_id: Option<String>,
) -> Result<usize, String> {
    // Same as `prism_insert_rule`: hold the lock across the read-apply
    // sequence so a core start cannot land between the output read and
    // the write (see above).
    let app = state.app.clone();
    tokio::task::spawn_blocking(move || {
        let _guard = crate::prism::pipeline::RUN_CONFIG_LOCK
            .lock()
            .map_err(|e| format!("Run config lock poisoned: {e}"))?;
        let state = tauri::Manager::state::<PrismState>(&app);
        state.with_ext(|ext| {
            super::host::require_current_rule_insert_cache()?;
            let pos = parse_position(&position, group_id.as_deref())?;
            ext.insert_rule_str(&rule_text, &pos)
        })
    })
    .await
    .map_err(|error| format!("Rule insertion task failed: {error}"))?
}

#[tauri::command]
pub async fn prism_toggle_group(
    state: State<'_, PrismState>,
    group_id: String,
    enabled: bool,
) -> Result<bool, String> {
    let app = state.app.clone();
    tokio::task::spawn_blocking(move || {
        let _guard = crate::prism::pipeline::RUN_CONFIG_LOCK
            .lock()
            .map_err(|error| format!("Run config lock poisoned: {error}"))?;
        let state = tauri::Manager::state::<PrismState>(&app);
        super::rule_library::ensure_user_rule(&state, &group_id)?;
        let _files = super::rule_library::lock_rule_files()?;
        state.with_ext(|ext| ext.toggle_group(&group_id, enabled))
    })
    .await
    .map_err(|error| format!("Rule toggle task failed: {error}"))?
}

#[tauri::command]
pub fn prism_trace_report(
    state: State<PrismState>,
    patch_id: String,
) -> Result<serde_json::Value, String> {
    state.with_ext(|ext| {
        let trace = ext.get_trace(&patch_id)?;
        serde_json::to_value(trace).map_err(|e| format!("Serialize failed: {e}"))
    })
}

#[tauri::command]
pub fn prism_trace_report_text(state: State<PrismState>) -> Result<String, String> {
    state.with_ext(PrismExtension::trace_report)
}

#[tauri::command]
pub fn prism_validate_config(state: State<PrismState>, config: String) -> Result<bool, String> {
    if config.len() > MAX_INPUT_SIZE {
        return Err(format!(
            "Config too large ({} bytes, max {} bytes)",
            config.len(),
            MAX_INPUT_SIZE
        ));
    }
    state.with_ext(|ext| ext.validate_config(&config))
}

#[tauri::command]
pub fn prism_list_profiles(state: State<PrismState>) -> Result<serde_json::Value, String> {
    state.with_ext(|ext| {
        let profiles = ext.list_profiles()?;
        serde_json::to_value(profiles).map_err(|e| format!("Serialize failed: {e}"))
    })
}

#[tauri::command]
pub fn prism_get_core_info(state: State<PrismState>) -> Result<serde_json::Value, String> {
    state.with_ext(|ext| {
        let info = ext.get_core_info()?;
        serde_json::to_value(info).map_err(|e| format!("Serialize failed: {e}"))
    })
}

#[tauri::command]
pub fn prism_start_watching(
    state: State<PrismState>,
    debounce_ms: Option<u64>,
) -> Result<(), String> {
    state.with_ext(|ext| ext.start_watching(debounce_ms.unwrap_or(500)))
}

#[tauri::command]
pub fn prism_stop_watching(state: State<PrismState>) -> Result<(), String> {
    state.with_ext(|ext| {
        ext.stop_watching();
        Ok(())
    })
}

#[tauri::command]
pub fn prism_is_watching(state: State<PrismState>) -> Result<bool, String> {
    state.with_ext(|ext| Ok(ext.is_watching()))
}

#[tauri::command]
pub fn prism_get_stats(state: State<PrismState>) -> Result<serde_json::Value, String> {
    state.with_ext(|ext| {
        let stats = ext.get_stats()?;
        serde_json::to_value(stats).map_err(|e| format!("Serialize failed: {e}"))
    })
}

#[tauri::command]
pub fn prism_read_raw_profile(
    state: State<PrismState>,
    profile_id: String,
) -> Result<String, String> {
    state.with_ext(|ext| ext.read_raw_profile(&profile_id))
}

/// Rebuild: reset `run_config.yaml` to the original subscription profile, then
/// re-apply all patches from scratch. This ensures that toggling rule files
/// (via `__when__.profile` or `enabled: false`) produces a clean result —
/// previously appended rules from disabled/skipped patches are properly removed.
#[tauri::command]
pub async fn prism_rebuild(
    state: State<'_, PrismState>,
    options: Option<ApplyOptions>,
    with_overrides: Option<bool>,
) -> Result<serde_json::Value, String> {
    let opts = options.unwrap_or_default();
    let combined = with_overrides.unwrap_or(false);
    let inner = std::sync::Arc::clone(&state.inner);
    let app = state.app.clone();
    let mode_guard = if combined {
        Some(crate::core_manager::core::subscription::lock_mode_for_overlay().await?)
    } else {
        None
    };

    tokio::task::spawn_blocking(move || {
        let _mode = mode_guard;
        // Held across the clean-base write and the compile, as every other
        // run_config.yaml writer does: an override apply in between would
        // otherwise be overwritten by this base, or be compiled over.
        let _guard =
            crate::config_manager::lock_run_config_within(std::time::Duration::from_secs(5))?;
        // Refuse while a core start is in progress, before writing
        // anything: the start is about to write the new run config with
        // fresh credentials, and this clean base would overwrite it, so
        // the startup health check would fail on the old credentials.
        // `ext.apply` below is guard-checked against a start, but the
        // base write here was not.
        if crate::prism::pipeline::core_start_in_progress() {
            return Err(
                "Hot reload refused: a core start or configuration reload is in progress"
                    .to_owned(),
            );
        }
        let mut selections = if combined {
            crate::runtime_dns::RebuildSelections::capture(&app)?
        } else {
            None
        };
        let _selection_transition = selections
            .as_ref()
            .map(|_| crate::speed_test::ReloadGuard::acquire());
        let deferred = combined.then(super::host::DeferredReloadGuard::enter);
        // Read the original profile config here, under the lock and after
        // the start check — not before entering spawn_blocking: a start
        // that finished while waiting for the lock would otherwise leave
        // this clean base carrying the previous run's profile text paired
        // with the new run's secret. (Same reason the secret is re-read
        // below. The lock order here — run-config lock, then the
        // core-state lock — matches `apply_config`.)
        let (raw_profile, global_prefs) = {
            let mihomo = tauri::Manager::state::<crate::core_manager::MihomoState>(&app);
            let lock = lock_critical(&mihomo.0, BackendModule::Core, codes::CORE_LOCK_FAILED)?;
            let config_path = lock.last_config_path().map(ToOwned::to_owned);
            drop(lock);

            // Read global preferences for injection
            let settings_state = tauri::Manager::state::<crate::SettingsState>(&app);
            let settings_lock = lock_best_effort(&settings_state.0);
            let prefs = settings_lock.to_global_prefs();
            drop(settings_lock);

            let content = if let Some(profile_name) = config_path {
                let paths = crate::core_manager::ensure_app_storage(&app)?;
                let profile_file = paths.profiles_dir.join(&profile_name);
                read_profile_file(&profile_file)
                    .map_err(|e| format!("Failed to read profile '{profile_name}': {e}"))?
            } else {
                // Rebuild the minimal core from its clean built-in base too;
                // re-applying its prior output would keep deleted/appended rules.
                core_process::build_minimal_runtime_config("").0
            };
            (content, Some(prefs))
        };
        // Re-read the secret here, under the lock and after the check, for
        // the same reason as the profile read above: a start that finished
        // while waiting for the lock would otherwise leave the clean base
        // carrying the previous run's secret. (Same reason `apply_config`
        // re-reads the endpoint just before injecting it; the lock order
        // here — run-config lock, then the core-state lock — matches that
        // path.)
        let (current_secret, core_running) = {
            let mihomo = tauri::Manager::state::<crate::core_manager::MihomoState>(&app);
            let lock = lock_critical(&mihomo.0, BackendModule::Core, codes::CORE_LOCK_FAILED)?;
            (lock.last_secret().to_owned(), lock.last_port().is_some())
        };
        // Captures the core's answer to the reload `ext.apply` triggers
        // (set by `ZephyrPrismHost::apply_config` on this thread).
        let status_guard = super::host::HttpStatusGuard::enter();
        let mut rollback = crate::prism::pipeline::PreparedConfigRollback::new(&app)?;
        // Step 1: Write the original profile config to run_config.yaml (clean base),
        // then re-inject secret & external-controller (prepare_runtime_config does both).
        {
            let paths = crate::core_manager::ensure_app_storage(&app)?;
            let run_config_path = paths.core_dir.join("run_config.yaml");

            // Use prepare_runtime_config to inject secret + external-controller
            // into the raw profile, just like start_core does.
            // The running core keeps its speed-test listener where it is:
            // a reload that fails must not leave this file naming a port
            // the core never opened.
            let held_port = core_running
                .then(|| crate::speed_test::held_port(&app))
                .flatten();
            let (prepared, _api_port, _proxy_port) =
                crate::speed_test::with_running_port(held_port, || {
                    core_process::prepare_runtime_config(
                        &raw_profile,
                        &current_secret,
                        global_prefs.as_ref(),
                    )
                })
                .ok_or_else(|| "Failed to prepare runtime config".to_owned())?;
            // Atomic: an override dry run (`override_test`) reads this file
            // without the run-config lock and must not see it half written.
            crate::core_manager::core::secure_io::write_file_secure_atomic(
                &run_config_path,
                &prepared,
            )?;
        }

        // Synchronize enabled overrides before the only Prism compilation:
        // recompiling its output would append the same rules twice.
        let override_state = tauri::Manager::state::<PrismState>(&app);
        let prepared_scripts = if combined {
            super::overrides::prepare_rebuild_overrides_locked(&override_state, &mut rollback)
                .map(Some)
        } else {
            super::overrides::prune_rebuild_overrides_locked(&override_state, &mut rollback)
                .map(|()| None)
        };
        let scripts = match prepared_scripts {
            Ok(scripts) => scripts,
            Err(error) => return Err(rollback.with_restore_error(error)),
        };
        // Step 2: Apply all patches on the clean base
        let lock = lock_critical(&inner, BackendModule::Prism, codes::PRISM_LOCK_FAILED)?;
        let ext = lock
            .extension
            .as_ref()
            .ok_or_else(|| "Prism not initialized".to_owned())?;
        if let Err(error) = status_guard.capture_rule_sources(&app) {
            drop(lock);
            let failure = rollback.with_restore_error(error);
            if let Some((_, logs)) = scripts {
                super::overrides::finish_rebuild_logs(
                    &override_state,
                    logs,
                    false,
                    false,
                    Some(&failure),
                );
            }
            return Err(failure);
        }
        let applied = ext.apply(opts);
        if applied.is_ok() {
            super::host::mark_rule_insert_cache_current();
        }
        drop(lock);
        let mut result = match applied {
            Ok(result) => result,
            Err(error) => {
                if let Some((_, logs)) = scripts {
                    super::overrides::finish_rebuild_logs(
                        &override_state,
                        logs,
                        false,
                        false,
                        Some(&error),
                    );
                }
                return Err(rollback.with_restore_error(error));
            }
        };

        let pending_logs = if let Some((prepared_scripts, mut logs)) = scripts {
            let state = tauri::Manager::state::<PrismState>(&app);
            match super::overrides::apply_js_after_rebuild_locked(&state, &prepared_scripts) {
                Ok(js_logs) => logs.extend(js_logs),
                Err(error) => {
                    super::overrides::finish_rebuild_logs(&state, logs, false, false, Some(&error));
                    return Err(rollback.with_restore_error(error));
                }
            }
            logs
        } else {
            Vec::new()
        };
        let prepared_value = (|| -> Result<serde_json::Value, String> {
            if combined {
                let paths = crate::core_manager::ensure_app_storage(&app)?;
                let run_config_path = paths.core_dir.join("run_config.yaml");
                result.output_config = std::fs::read_to_string(&run_config_path)
                    .map_err(|error| format!("Failed to read combined runtime output: {error}"))?;
                if let Some(snapshot) = selections.as_mut() {
                    let prepared = snapshot.prepare(&app, &result.output_config)?;
                    let unchanged =
                        serde_yaml::from_str::<serde_yaml::Value>(&result.output_config)
                            .ok()
                            .zip(serde_yaml::from_str::<serde_yaml::Value>(&prepared).ok())
                            .is_some_and(|(current, candidate)| current == candidate);
                    if !unchanged {
                        crate::core_manager::core::secure_io::write_file_secure_atomic(
                            &run_config_path,
                            &prepared,
                        )?;
                        result.output_config = prepared;
                        super::host::invalidate_rule_insert_cache();
                    }
                }
            }
            serde_json::to_value(result).map_err(|error| format!("Serialize failed: {error}"))
        })();
        let mut value = match prepared_value {
            Ok(value) => value,
            Err(error) => {
                let failure = rollback.with_restore_error(error);
                if combined {
                    super::overrides::finish_rebuild_logs(
                        &override_state,
                        pending_logs,
                        false,
                        false,
                        Some(&failure),
                    );
                }
                return Err(failure);
            }
        };
        drop(deferred);

        // Whether the core took the rebuilt config: true / false (refused or
        // did not answer), or null when no reload was sent. `ApplyResult` does not
        // carry it, so a caller could not tell a rejected reload from success.
        let mut hot_reload_error = None;
        let mut hot_reload_uncertain = false;
        let mut put_confirmed = false;
        let mut put_uncertain = false;
        let hot_reload_success = if combined {
            let mut outcome = crate::prism::pipeline::reload_prepared_locked(&app);
            put_confirmed = outcome.as_ref().is_ok_and(|reloaded| *reloaded);
            put_uncertain = outcome.as_ref().is_err_and(|error| !error.rejected);
            if put_confirmed {
                if let Some(snapshot) = selections.as_ref() {
                    if let Err(error) = snapshot.restore(&app) {
                        snapshot.invalidate(&app);
                        outcome = Err(crate::prism::pipeline::ReloadError {
                            message: format!(
                                "Rebuild selection restoration is unconfirmed: {error}"
                            ),
                            rejected: false,
                        });
                    }
                }
            }
            // A successful or stopped-core save keeps the complete candidate.
            // An unknown outcome may already be live, while an explicit HTTP
            // rejection restores both the previous config and workspace patches.
            if !outcome.as_ref().is_err_and(|error| error.rejected) {
                rollback.disarm();
            }
            match outcome {
                Ok(reloaded) => {
                    if reloaded {
                        super::host::confirm_compiled_rule_annotations(&app);
                    }
                    reloaded.then_some(true)
                }
                Err(error) => {
                    hot_reload_uncertain = !error.rejected;
                    hot_reload_error = Some(if error.rejected {
                        rollback.with_restore_error(error.message)
                    } else {
                        error.message
                    });
                    Some(false)
                }
            }
        } else {
            let status = status_guard.take();
            hot_reload_uncertain = status == Some(0);
            if status
                .is_none_or(|code| code == 0 || crate::network_coordinator::is_http_success(code))
            {
                rollback.disarm();
            } else if let Some(code) = status {
                hot_reload_error = Some(
                    rollback.with_restore_error(format!("Core rejected reload with HTTP {code}",)),
                );
            }
            status.map(crate::network_coordinator::is_http_success)
        };
        if combined {
            super::overrides::finish_rebuild_logs(
                &override_state,
                pending_logs,
                put_confirmed,
                put_uncertain,
                hot_reload_error.as_deref(),
            );
        }
        if let Some(obj) = value.as_object_mut() {
            obj.insert(
                "hot_reload_uncertain".to_owned(),
                serde_json::json!(hot_reload_uncertain),
            );
            obj.insert(
                "hot_reload_success".to_owned(),
                serde_json::json!(hot_reload_success),
            );
            if let Some(error) = hot_reload_error {
                obj.insert("hot_reload_error".to_owned(), serde_json::json!(error));
            }
            if combined {
                if let Some(status) = obj
                    .get_mut("status")
                    .and_then(serde_json::Value::as_object_mut)
                {
                    status.insert(
                        "hot_reload_success".to_owned(),
                        serde_json::json!(hot_reload_success),
                    );
                }
            }
        }
        Ok(value)
    })
    .await
    .map_err(|e| format!("Task join failed: {e}"))?
}
