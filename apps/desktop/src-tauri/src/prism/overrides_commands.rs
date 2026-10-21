//! Override module — Tauri IPC commands.

#![allow(clippy::needless_pass_by_value)]
#![allow(clippy::shadow_reuse)]

use tauri::{Manager as _, State};

use clash_prism_extension::ApplyOptions;

use crate::core_manager::core::fetch_util::fetch_url_content;
use crate::core_manager::write_file_secure;
use crate::prism::overrides::overrides_model::{
    LogEntry, OverrideExt, OverrideItem, OverrideLog, OverrideType,
};
use crate::prism::overrides::overrides_store;
use crate::prism::pipeline::{
    execute_batch_pipeline, execute_test_pipeline, execute_write_pipeline,
};
use crate::prism::types::{check_input_size, check_name_size};
use crate::prism::PrismState;
use zephyr_core::config::sanitizer::remove_dangerous_keys_internal_pub as remove_dangerous_keys;

/// Sanitize user-supplied or remote Prism YAML override content before it is written to disk.
///
/// Strips dangerous YAML keys (`script`, `external-controller-*`, `external-ui`, provider `path`).
fn sanitize_override_yaml(content: &str) -> Result<String, String> {
    let value = match serde_yaml::from_str::<serde_yaml::Value>(content) {
        Ok(value) => value,
        Err(e) => return Err(format!("Invalid YAML: {e}")),
    };
    let mut sanitized = value.clone();
    remove_dangerous_keys(&mut sanitized, false);
    if sanitized == value {
        Ok(content.to_owned())
    } else {
        serde_yaml::to_string(&sanitized)
            .map_err(|e| format!("Failed to serialize sanitized YAML: {e}"))
    }
}

/// List all override items, sorted by order.
#[tauri::command]
pub fn override_list(state: State<PrismState>) -> Result<Vec<OverrideItem>, String> {
    let meta = overrides_store::load_meta(&state)?;
    let mut items = meta.items;
    items.sort_by_key(|i| i.order);
    // Populate last_success from execution logs
    for item in &mut items {
        if let Ok((success, error)) = overrides_store::read_log_status(&state, &item.id) {
            item.last_success = Some(success);
            if !success {
                item.last_error = error;
            }
        }
    }
    Ok(items)
}

/// Create a new override item and allocate a content file.
///
/// For remote overrides with a URL, the content is downloaded immediately
/// and the extension is detected from the URL path (falling back to content analysis).
/// If the download fails or the content is invalid (e.g. HTML), an error is returned
/// and the override is NOT created.
#[tauri::command]
pub async fn override_create(
    state: State<'_, PrismState>,
    name: String,
    ext: String,
    r#type: String,
    url: Option<String>,
) -> Result<OverrideItem, String> {
    // Security: Override names are identifiers; cap them like other names.
    check_name_size(&name, "Override name")?;
    let mut ext = OverrideExt::from_ext(&ext).ok_or_else(|| format!("Unknown ext: {ext}"))?;
    let r#type = match r#type.as_str() {
        "local" => OverrideType::Local,
        "remote" => {
            if url.as_ref().is_none_or(|u| u.trim().is_empty()) {
                return Err("URL is required for remote overrides".to_owned());
            }
            OverrideType::Remote
        }
        _ => return Err(format!("Unknown type: {type}")),
    };

    let download_url = if r#type == OverrideType::Remote {
        url.clone()
    } else {
        None
    };

    // For remote overrides: detect ext from URL first, then download and validate content.
    let pre_downloaded = if let Some(download_url) = &download_url {
        // 1. Try URL extension (most reliable for CDN / raw file URLs)
        if let Some(url_ext) = detect_ext_from_url(download_url) {
            ext = url_ext;
        }

        // 2. Download content
        match download_remote_content(&state.app, download_url).await {
            Ok(content) => {
                // Validate content is not HTML / binary
                validate_override_content(&content)?;

                // 3. If URL had no clear extension, fall back to content-based detection
                if detect_ext_from_url(download_url).is_none() {
                    let detected = detect_override_ext(&content);
                    if detected != ext {
                        emit_warn!(
                            Override,
                            OVERRIDE_APPLY_FAILED,
                            "Content-detected override type {:?} (URL hint was {:?}) for: {}",
                            detected,
                            ext,
                            download_url
                        );
                    }
                    ext = detected;
                }
                Some(content)
            }
            Err(e) => {
                return Err(format!(
                    "Failed to download override from {download_url}: {e}"
                ));
            }
        }
    } else {
        None
    };

    let mut item = OverrideItem::new(name, ext, r#type);
    if r#type == OverrideType::Remote {
        item.global = true;
    }
    if let Some(u) = url {
        item.url = Some(u);
    }

    // Write content: use pre-downloaded content, or fall back to default template
    let dir = overrides_store::overrides_dir(&state)?;
    let content_path = dir.join(item.content_filename());
    let mut content = pre_downloaded.unwrap_or_else(|| default_template_content(item.ext));
    if item.ext == OverrideExt::PrismYaml {
        content = sanitize_override_yaml(&content)?;
    }

    write_file_secure(&content_path, &content)
        .map_err(|e| format!("Failed to create content file: {e}"))?;

    // create_item atomically assigns order and persists — no race condition
    overrides_store::create_item(&state, item)
}

/// Extract override extension from a URL path.
///
/// Parses the last path segment, strips query params and fragments,
/// and checks for `.js`, `.yaml`, `.yml` extensions.
/// Returns `None` if the URL has no recognizable extension.
fn detect_ext_from_url(url: &str) -> Option<OverrideExt> {
    let parsed = reqwest::Url::parse(url).ok()?;
    let last_segment = parsed
        .path_segments()?
        .rev()
        .find(|s| !s.is_empty())?
        .to_lowercase();

    if last_segment.ends_with(".js")
        || last_segment.ends_with(".mjs")
        || last_segment.ends_with(".cjs")
    {
        Some(OverrideExt::Js)
    } else if last_segment.ends_with(".yaml") || last_segment.ends_with(".yml") {
        Some(OverrideExt::PrismYaml)
    } else {
        None
    }
}

/// Validate that downloaded content is not HTML or binary data.
fn validate_override_content(content: &str) -> Result<(), String> {
    let trimmed = content.trim_start();
    if trimmed
        .get(..9)
        .is_some_and(|s| s.eq_ignore_ascii_case("<!doctype"))
        || trimmed
            .get(..5)
            .is_some_and(|s| s.eq_ignore_ascii_case("<html"))
        || trimmed
            .get(..5)
            .is_some_and(|s| s.eq_ignore_ascii_case("<head"))
    {
        return Err(
            "Downloaded content appears to be an HTML page, not a valid override script. \
             The URL may point to a web page instead of a raw script file."
                .to_owned(),
        );
    }
    if content.contains('\0') {
        return Err("Downloaded content contains null bytes (binary data)".to_owned());
    }
    Ok(())
}

/// Detect whether content is JS or Prism YAML.
///
/// Used as fallback when the URL has no recognizable extension.
/// Relies on heuristic signal counting — no attempt to perfectly parse syntax.
fn detect_override_ext(content: &str) -> OverrideExt {
    let mut yaml_signals = 0_u32;
    let mut js_signals = 0_u32;
    let mut semicolons = 0_u32;

    for line in content.lines().take(1000) {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        // Skip line comments
        if trimmed.starts_with('#') || trimmed.starts_with("//") {
            continue;
        }

        // Count semicolons
        semicolons = semicolons.saturating_add(
            u32::try_from(trimmed.chars().filter(|&c| c == ';').count()).unwrap_or(u32::MAX),
        );

        // Minified JS: very long line (> 500 chars) is almost certainly JS.
        if trimmed.len() > 500 {
            js_signals += 5;
            continue;
        }

        // YAML document start marker
        if trimmed == "---" || trimmed.starts_with("--- ") {
            return OverrideExt::PrismYaml;
        }
        if trimmed.starts_with("%YAML") || trimmed.starts_with("%TAG") {
            return OverrideExt::PrismYaml;
        }

        // YAML key-value: `key: value` (colon + space) or `key:` at EOL
        if let Some(colon_pos) = trimmed.find(':') {
            let key_part = &trimmed[..colon_pos];
            let after_colon = trimmed[colon_pos + 1..].chars().next();
            if !key_part.is_empty()
                && key_part
                    .chars()
                    .all(|c| c.is_alphanumeric() || c == '-' || c == '_' || c == '$')
                && (after_colon == Some(' ') || after_colon.is_none())
                && !trimmed.ends_with(',')
                && !trimmed.ends_with(';')
            {
                yaml_signals += 1;
            }
        }

        // YAML list item
        if trimmed.starts_with("- ") && !trimmed.contains(';') {
            yaml_signals += 1;
        }

        // JS keywords
        if trimmed.starts_with("function ")
            || trimmed.starts_with("async function ")
            || trimmed.starts_with("class ")
            || trimmed.starts_with("export ")
            || trimmed.starts_with("import ")
            || trimmed.starts_with("var ")
            || trimmed.starts_with("let ")
            || trimmed.starts_with("const ")
            || trimmed.starts_with("return ")
            || trimmed == "return"
        {
            js_signals += 2;
        }
        if trimmed.starts_with("\"use strict\"") || trimmed.starts_with("'use strict'") {
            js_signals += 3;
        }
        if trimmed.contains("=>") || trimmed.contains("console.") {
            js_signals += 1;
        }
    }

    // Semicolons are very common in JS but rare in YAML
    if semicolons > 20 {
        js_signals += 5;
    }

    if yaml_signals >= 2 && yaml_signals > js_signals {
        OverrideExt::PrismYaml
    } else {
        OverrideExt::Js
    }
}

/// Return the default template content for a given override extension.
fn default_template_content(ext: OverrideExt) -> String {
    match ext {
        OverrideExt::Js => r"// Zephyr Override Script
// API: config.get(path), config.set(path, value), log.*, utils.*

function main(config) {
    log.info('Override executed');
    return config;
}
"
        .to_owned(),
        OverrideExt::PrismYaml => r#"# Zephyr Prism Override
# Supports: $override, $prepend, $append, $filter, $transform, $remove, $default
# Conditions: __when__, Variables: __vars__, Dependencies: __after__

# Example: prepend rules
# rules:
#   $prepend:
#     - "DOMAIN-SUFFIX,google.com,DIRECT"
"#
        .to_owned(),
    }
}

/// Update metadata fields of an override item (not content).
#[tauri::command]
pub fn override_update(
    state: State<PrismState>,
    id: String,
    mut name: Option<String>,
    enabled: Option<bool>,
    global: Option<bool>,
    mut profile_ids: Option<Vec<String>>,
    mut url: Option<String>,
) -> Result<OverrideItem, String> {
    // update_item performs read-modify-write within a single lock acquisition,
    // preventing race conditions with concurrent updates. The name check
    // lives inside it for the same reason: only a changed name is a new
    // identifier held to the cap, while resubmitting the stored name
    // (say, toggling an imported item whose name predates the limit)
    // stays allowed — comparing against a copy loaded beforehand could
    // race another update's rename.
    let mut name_error: Option<String> = None;
    let updated = overrides_store::update_item(&state, &id, |item| {
        // A failed name check aborts the whole update: returning false
        // means update_item saves nothing at all.
        if let Some(n) = &name {
            if *n != item.name {
                if let Err(e) = check_name_size(n, "Override name") {
                    name_error = Some(e);
                    return false;
                }
            }
        }
        if let Some(n) = name.take() {
            item.name = n;
        }
        if let Some(e) = enabled {
            item.enabled = e;
        }
        if let Some(g) = global {
            item.global = g;
        }
        if let Some(pids) = profile_ids.take() {
            item.profile_ids = pids;
        }
        if let Some(u) = url.take() {
            item.url = Some(u);
        }
        true
    });
    if let Some(e) = name_error {
        return Err(e);
    }
    updated
}

/// Delete an override item and its content/log files.
#[tauri::command]
pub fn override_delete(state: State<PrismState>, id: String) -> Result<(), String> {
    overrides_store::delete_item(&state, &id)
}

/// Get the content of an override script.
#[tauri::command]
pub fn override_get_content(state: State<PrismState>, id: String) -> Result<String, String> {
    overrides_store::read_content(&state, &id)
}

/// A dry run writes nothing and save-only writes without running: asking for
/// both at once has no meaning, so it is refused before anything is written.
fn check_write_mode(dry_run: Option<bool>, save_only: Option<bool>) -> Result<(), String> {
    if dry_run == Some(true) && save_only == Some(true) {
        return Err("dry_run and save_only cannot both be set".to_owned());
    }
    Ok(())
}

/// Save content to an override and optionally test-execute it.
///
/// If `dry_run = true`, validates and executes without persisting content or writing config.
/// If `dry_run = false`, persists content, executes, and writes back to config.
/// Returns the execution log.
///
/// Note: This function is async so Tauri runs it on a blocking thread pool,
/// preventing UI freezes during script execution.
#[tauri::command]
pub async fn override_set_content(
    state: State<'_, PrismState>,
    id: String,
    content: String,
    dry_run: Option<bool>,
    save_only: Option<bool>,
) -> Result<OverrideLog, String> {
    check_input_size(&content, "Override content")?;
    check_write_mode(dry_run, save_only)?;

    let item = overrides_store::load_item(&state, &id)?;

    // Validate and sanitize the content
    let content = if item.ext == OverrideExt::Js {
        let runtime = clash_prism_script::ScriptRuntime::with_context(
            crate::prism::pipeline::build_script_context(),
        );
        if let Err(e) = runtime.validate(&content) {
            return Err(format!("Script validation failed: {e}"));
        }
        content
    } else if item.ext == OverrideExt::PrismYaml {
        sanitize_override_yaml(&content)?
    } else {
        content
    };

    // Save only: persist the content without executing it (JS is syntax-checked,
    // Prism YAML is parse-checked; both are fully checked when they run).
    if save_only.unwrap_or(false) {
        // An enabled Prism YAML override is compiled from its workspace patch: keep
        // the patch in step so the next apply uses what was just saved. The patch is
        // written first, so a failed save leaves the stored script untouched too.
        if item.ext == OverrideExt::PrismYaml && item.enabled {
            // Same lock as the apply paths, so a compile never reads a half-written patch.
            let _guard = crate::prism::pipeline::RUN_CONFIG_LOCK
                .lock()
                .map_err(|e| format!("Run config lock poisoned: {e}"))?;
            let prism_dir = crate::prism::prism_data_dir(&state.app)?;
            let patch_path = prism_dir.join(item.patch_filename());
            let previous_patch = std::fs::read_to_string(&patch_path).ok();
            write_file_secure(&patch_path, &content)
                .map_err(|e| format!("Failed to write Prism patch: {e}"))?;
            if let Err(e) = overrides_store::write_content(&state, &id, &content) {
                // The save failed: put the patch back so the next apply still uses
                // the previously saved script.
                let restored = match previous_patch {
                    Some(text) => write_file_secure(&patch_path, &text).is_ok(),
                    None => std::fs::remove_file(&patch_path).is_ok(),
                };
                if !restored {
                    emit_warn!(
                        Override,
                        OVERRIDE_APPLY_FAILED,
                        "Could not restore the Prism patch of override {} after a failed save",
                        id
                    );
                }
                return Err(e);
            }
        } else {
            overrides_store::write_content(&state, &id, &content)?;
        }
        return Ok(OverrideLog {
            script_id: item.id,
            script_name: item.name,
            executed_at: chrono::Utc::now().timestamp_millis(),
            duration_us: 0,
            success: true,
            config_modified: false,
            error: None,
            logs: Vec::new(),
        });
    }

    let dry = dry_run.unwrap_or(false);

    // Only persist content when NOT in dry-run mode
    if !dry {
        overrides_store::write_content(&state, &id, &content)?;
    }

    // Execute (dry_run or live)
    let log = if dry {
        // The button is a syntax check and the script already passed validation above.
        // With no running config yet to try it on (the core has never started), say the
        // dry run was skipped instead of failing a script whose syntax is fine. Any other
        // pipeline failure (run_config.yaml unreadable or broken) is reported as one.
        execute_override_test(&state, &item, &content).unwrap_or_else(|e| {
            let no_running_config = crate::core_manager::ensure_app_storage(&state.app)
                .is_ok_and(|paths| !paths.core_dir.join("run_config.yaml").exists());
            if no_running_config {
                OverrideLog {
                    script_id: item.id.clone(),
                    script_name: item.name.clone(),
                    executed_at: chrono::Utc::now().timestamp_millis(),
                    duration_us: 0,
                    success: true,
                    config_modified: false,
                    error: None,
                    logs: vec![LogEntry {
                        level: "warn".to_owned(),
                        message: format!("Syntax OK; dry run skipped: {e}"),
                    }],
                }
            } else {
                OverrideLog {
                    script_id: item.id.clone(),
                    script_name: item.name.clone(),
                    executed_at: chrono::Utc::now().timestamp_millis(),
                    duration_us: 0,
                    success: false,
                    config_modified: false,
                    error: Some(e),
                    logs: Vec::new(),
                }
            }
        })
    } else {
        // The content is already saved: a pipeline error (core not running, the
        // running config unreadable) is this run's result, not a failed save, so
        // record it as the last run instead of leaving the previous status shown.
        execute_override_write(&state, &item, &content).unwrap_or_else(|e| OverrideLog {
            script_id: item.id.clone(),
            script_name: item.name.clone(),
            executed_at: chrono::Utc::now().timestamp_millis(),
            duration_us: 0,
            success: false,
            config_modified: false,
            error: Some(e),
            logs: Vec::new(),
        })
    };

    // Persist the log of real runs only: a dry run (syntax check) must not
    // replace the last-run status shown for the override.
    // The script is already written and applied by now: a log that cannot be
    // saved must not turn the run into an error.
    if !dry {
        if let Err(e) = overrides_store::save_log(&state, &id, &log) {
            emit_warn!(
                Override,
                OVERRIDE_APPLY_FAILED,
                "Could not save the run log for override {}: {}",
                id,
                e
            );
        }
    }

    Ok(log)
}

/// Test-execute an override script without modifying config.
fn execute_override_test(
    state: &PrismState,
    item: &OverrideItem,
    content: &str,
) -> Result<OverrideLog, String> {
    // Prism YAML has no dry-run pipeline: a syntax check passes once the YAML is
    // well-formed, and reports the parse error otherwise.
    if item.ext == OverrideExt::PrismYaml {
        let error = serde_yaml::from_str::<serde_yaml::Value>(content)
            .err()
            .map(|e| format!("YAML syntax error: {e}"));
        return Ok(OverrideLog {
            script_id: item.id.clone(),
            script_name: item.name.clone(),
            executed_at: chrono::Utc::now().timestamp_millis(),
            duration_us: 0,
            success: error.is_none(),
            config_modified: false,
            error,
            logs: Vec::new(),
        });
    }

    let result = execute_test_pipeline(state, content, &item.name)?;

    Ok(OverrideLog {
        script_id: item.id.clone(),
        script_name: item.name.clone(),
        executed_at: chrono::Utc::now().timestamp_millis(),
        duration_us: result.duration_us,
        success: result.success,
        config_modified: result.config_modified,
        error: result.error,
        logs: result
            .logs
            .iter()
            .map(|l| LogEntry {
                level: l.level.clone(),
                message: l.message.clone(),
            })
            .collect(),
    })
}

/// Execute an override script and write back to config if modified.
fn execute_override_write(
    state: &PrismState,
    item: &OverrideItem,
    content: &str,
) -> Result<OverrideLog, String> {
    // Prism YAML overrides are executed via the Prism DSL pipeline
    if item.ext == OverrideExt::PrismYaml {
        return execute_prism_yaml_write(state, item, content);
    }

    let result = execute_write_pipeline(state, content, &item.name)?;

    Ok(OverrideLog {
        script_id: item.id.clone(),
        script_name: item.name.clone(),
        executed_at: chrono::Utc::now().timestamp_millis(),
        duration_us: result.duration_us,
        success: result.success,
        config_modified: result.config_modified,
        error: result.error,
        logs: result
            .logs
            .iter()
            .map(|l| LogEntry {
                level: l.level.clone(),
                message: l.message.clone(),
            })
            .collect(),
    })
}

/// Execute a batch of Prism YAML overrides efficiently.
///
/// Writes all patch files first, then performs a single `ext.apply()` compilation.
/// During that call the host writes the output to `run_config.yaml` and reloads
/// the core; the returned flag says whether the core took that reload. With
/// `trigger_reload`, one more (unawaited) reload follows; the batch caller passes
/// false and decides itself whether a final awaited reload is needed.
fn execute_prism_yaml_batch(
    state: &PrismState,
    patches: &[(String, String, String, String)], // (id, name, patch_filename, content)
    trigger_reload: bool,
) -> Result<(Vec<OverrideLog>, bool), String> {
    use crate::prism::pipeline::RUN_CONFIG_LOCK;

    let _guard = RUN_CONFIG_LOCK
        .lock()
        .map_err(|e| format!("Run config lock poisoned: {e}"))?;

    let start = std::time::Instant::now();

    // Step 1: Write all patch files to the Prism workspace
    let prism_dir = crate::prism::prism_data_dir(&state.app)?;

    for (_id, name, patch_filename, content) in patches {
        let patch_path = prism_dir.join(patch_filename);
        write_file_secure(&patch_path, content)
            .map_err(|e| format!("Failed to write Prism patch for '{name}': {e}"))?;
    }

    // Step 2: Single compilation via ext.apply()
    let lock = state.lock_inner()?;
    let ext = lock
        .extension
        .as_ref()
        .ok_or_else(|| "Prism extension not initialized".to_owned())?;
    // `ext.apply` hands its output to the host, which hot-reloads the core
    // on this thread; the guard captures whether the core took it, so the
    // caller knows these patches are live even if a later reload fails.
    let status_guard = crate::prism::host::HttpStatusGuard::enter();
    let applied = ext.apply(ApplyOptions::default());
    let reloaded = status_guard
        .take()
        .is_some_and(crate::network_coordinator::is_http_success);
    let result = match applied {
        Ok(res) => res,
        Err(err) => {
            drop(lock);
            let duration_us = u64::try_from(start.elapsed().as_micros()).unwrap_or(u64::MAX);
            let logs: Vec<OverrideLog> = patches
                .iter()
                .map(|(id, name, _, _)| OverrideLog {
                    script_id: id.clone(),
                    script_name: name.clone(),
                    executed_at: chrono::Utc::now().timestamp_millis(),
                    duration_us,
                    success: false,
                    config_modified: false,
                    error: Some(err.clone()),
                    logs: vec![],
                })
                .collect();
            return Ok((logs, false));
        }
    };
    drop(lock);

    let duration_us = u64::try_from(start.elapsed().as_micros()).unwrap_or(u64::MAX);

    // No write-back here: `ext.apply` returns Ok only after the host's
    // `apply_config` has written this same output to run_config.yaml
    // (atomically, under this lock) and sent the reload. Writing it again
    // would only reopen a window in which a newer run_config.yaml (a TUN
    // start rewrites it outside this lock) is replaced by this older output.

    // Step 4: one more reload only when the caller asks for it
    if trigger_reload {
        crate::prism::pipeline::trigger_hot_reload_and_reconcile_tun(state)?;
    }

    // Build logs for each patch (all share the same compilation result)
    let trace_logs: Vec<LogEntry> = result
        .trace
        .iter()
        .map(|t| LogEntry {
            level: "info".to_owned(),
            message: format!("{t:?}"),
        })
        .collect();

    let logs: Vec<OverrideLog> = patches
        .iter()
        .map(|(id, name, _, _)| OverrideLog {
            script_id: id.clone(),
            script_name: name.clone(),
            executed_at: chrono::Utc::now().timestamp_millis(),
            duration_us,
            success: true,
            config_modified: true,
            error: None,
            logs: trace_logs.clone(),
        })
        .collect();

    Ok((logs, reloaded))
}

/// The error a single Prism apply reports for the reload its host made:
/// none when the core took it or no reload was made, otherwise the refusal
/// (or the missing answer, recorded as 0), with where the change stays.
#[must_use]
fn single_apply_reload_error(status: Option<u16>) -> Option<String> {
    let code = status.filter(|&code| !crate::network_coordinator::is_http_success(code))?;
    let refusal = if code == 0 {
        "did not answer the reload".to_owned()
    } else {
        format!("refused the reload (HTTP {code})")
    };
    Some(format!(
        "The core {refusal}. The change is saved in the running config and takes \
         effect at its next reload."
    ))
}

/// Execute a Prism YAML override by writing it to the Prism workspace and applying.
///
/// This writes the Prism YAML content as a patch file in the Prism workspace,
/// then calls `ext.apply()` to compile and apply all patches.
fn execute_prism_yaml_write(
    state: &PrismState,
    item: &OverrideItem,
    content: &str,
) -> Result<OverrideLog, String> {
    use crate::prism::pipeline::RUN_CONFIG_LOCK;

    let _guard = RUN_CONFIG_LOCK
        .lock()
        .map_err(|e| format!("Run config lock poisoned: {e}"))?;

    let start = std::time::Instant::now();

    // Write the override content as a patch file in the Prism workspace
    let prism_dir = crate::prism::prism_data_dir(&state.app)?;
    let patch_filename = item.patch_filename();
    let patch_path = prism_dir.join(&patch_filename);
    write_file_secure(&patch_path, content)
        .map_err(|e| format!("Failed to write Prism patch: {e}"))?;

    // Apply through the Prism extension
    let lock = state
        .inner
        .lock()
        .map_err(|e| format!("Prism lock failed: {e}"))?;
    let ext = lock
        .extension
        .as_ref()
        .ok_or_else(|| "Prism extension not initialized".to_owned())?;
    // As in the batch path: the host reloads the core during `ext.apply`,
    // and the guard captures whether the core took it.
    let status_guard = crate::prism::host::HttpStatusGuard::enter();
    let applied = ext.apply(ApplyOptions::default());
    let reload_status = status_guard.take();
    drop(lock);
    let result = applied?;

    let duration_us = u64::try_from(start.elapsed().as_micros()).unwrap_or(u64::MAX);

    // `ext.apply` already wrote this output to run_config.yaml through the
    // host (see `execute_prism_yaml_batch`), so it is not written again. A
    // reload the host made, taken or refused, is not repeated: taken, the
    // host also reconciled TUN; refused, the same file would be refused
    // again, and the run reports it instead of success.
    let error = single_apply_reload_error(reload_status);
    if reload_status.is_none() {
        crate::prism::pipeline::trigger_hot_reload_and_reconcile_tun(state)?;
    }

    Ok(OverrideLog {
        script_id: item.id.clone(),
        script_name: item.name.clone(),
        executed_at: chrono::Utc::now().timestamp_millis(),
        duration_us,
        success: error.is_none(),
        config_modified: true,
        error,
        logs: result
            .trace
            .iter()
            .map(|t| LogEntry {
                level: "info".to_owned(),
                message: format!("{t:?}"),
            })
            .collect(),
    })
}

/// Reorder override items.
#[tauri::command]
pub fn override_reorder(state: State<PrismState>, ids: Vec<String>) -> Result<(), String> {
    overrides_store::reorder_items_atomic(&state, &ids)
}

/// Toggle override enabled/disabled.
#[tauri::command]
pub fn override_toggle(state: State<PrismState>, id: String, enabled: bool) -> Result<(), String> {
    // When enabling a Prism YAML override, read and sanitize the stored
    // content before persisting the flag: if the content cannot be restored
    // as a patch, the toggle fails without changing any state.
    let prepared = if enabled {
        let peek = overrides_store::load_item(&state, &id)?;
        if peek.ext == OverrideExt::PrismYaml {
            let content = overrides_store::read_content(&state, &id)
                .map_err(|e| format!("Failed to read override content to restore patch: {e}"))?;
            // Sanitize on restore so a stored override saved before
            // write-path sanitization cannot reactivate dangerous keys.
            Some(sanitize_override_yaml(&content)?)
        } else {
            None
        }
    } else {
        None
    };

    // Use atomic update to avoid read-modify-write race
    let item = overrides_store::update_item(&state, &id, |item| {
        item.enabled = enabled;
        true
    })?;

    // Synchronize Prism workspace patch file for Prism YAML overrides
    if item.ext == OverrideExt::PrismYaml {
        let prism_dir = crate::prism::prism_data_dir(&state.app)
            .map_err(|e| format!("Failed to get prism data dir: {e}"))?;
        let patch_path = prism_dir.join(item.patch_filename());

        if enabled {
            // Re-enable: restore patch file from the content prepared above
            if let Some(content) = &prepared {
                write_file_secure(&patch_path, content)
                    .map_err(|e| format!("Failed to restore patch file: {e}"))?;
            }
        } else {
            // Disable: remove patch so Prism extension stops applying it
            if patch_path.exists() {
                std::fs::remove_file(&patch_path)
                    .map_err(|e| format!("Failed to remove patch file: {e}"))?;
            }
        }
    }

    Ok(())
}

/// Test-execute an override without saving content.
#[tauri::command]
pub fn override_test(state: State<PrismState>, id: String) -> Result<OverrideLog, String> {
    let item = overrides_store::load_item(&state, &id)?;
    let content = overrides_store::read_content(&state, &id)?;
    // Test what would actually be applied: stored Prism YAML goes through
    // the same sanitization as the apply path. A sanitization failure is
    // reported as a failed test log, matching how this command has always
    // surfaced unusable content, instead of becoming an IPC error.
    let content = if item.ext == OverrideExt::PrismYaml {
        match sanitize_override_yaml(&content) {
            Ok(clean) => clean,
            Err(e) => {
                return Ok(OverrideLog {
                    script_id: item.id.clone(),
                    script_name: item.name,
                    executed_at: chrono::Utc::now().timestamp_millis(),
                    duration_us: 0,
                    success: false,
                    config_modified: false,
                    error: Some(format!("Invalid Prism YAML: {e}")),
                    logs: vec![LogEntry {
                        level: "Error".to_owned(),
                        message: format!("Stored override content is not valid YAML: {e}"),
                    }],
                });
            }
        }
    } else {
        content
    };
    // A dry run: report it, but keep the last real apply's log as the override's status.
    execute_override_test(&state, &item, &content)
}

/// Download and refresh a remote override.
///
/// Downloads directly first and falls back to the running managed core's proxy
/// when the direct route fails.
///
/// Note: This function is async to avoid blocking the UI during network I/O.
#[tauri::command]
pub async fn override_refresh_remote(
    state: State<'_, PrismState>,
    id: String,
) -> Result<OverrideLog, String> {
    let item = overrides_store::load_item(&state, &id)?;
    if item.r#type != OverrideType::Remote {
        return Err("Only remote overrides can be refreshed".to_owned());
    }

    let url = item
        .url
        .as_ref()
        .ok_or("No URL set for remote override")?
        .clone();

    // Direct first, then through the managed core if direct fails
    let mut content = download_remote_content(&state.app, &url).await?;
    if item.ext == OverrideExt::PrismYaml {
        content = sanitize_override_yaml(&content)?;
    }

    // Update content
    overrides_store::write_content(&state, &id, &content)?;

    // Update timestamp atomically (returns the updated item)
    let updated_item = overrides_store::update_item(&state, &id, |item| {
        item.updated_at = Some(chrono::Utc::now().timestamp_millis());
        true
    })?;

    // Execute via write pipeline so the refreshed override takes effect immediately.
    // Using dry-run (execute_override_test) would update the file but leave the
    // running config unchanged, confusing users who expect refresh to apply immediately.
    let log = execute_override_write(&state, &updated_item, &content)?;
    overrides_store::save_log(&state, &id, &log)?;
    Ok(log)
}

/// Apply all enabled overrides to the current config.
///
/// Uses batch pipeline to load config once, apply all scripts in memory,
/// and write back once. Hot-reload is triggered only once after all overrides are applied.
///
/// Scope filtering: Only applies overrides where:
/// - `global == true` (applies to all profiles), OR
/// - `profile_ids` contains the current active profile ID
///
/// Note: This function is async to avoid blocking the UI during script execution.
#[tauri::command]
pub async fn override_apply_all(state: State<'_, PrismState>) -> Result<Vec<OverrideLog>, String> {
    // Get current active profile ID for scope filtering
    let current_profile_id: Option<String> = {
        let mihomo_state = state.app.state::<crate::MihomoState>();
        let lock = match mihomo_state.0.lock() {
            Ok(l) => l,
            Err(e) => {
                emit_warn!(
                    Override,
                    OVERRIDE_APPLY_FAILED,
                    "MihomoState lock poisoned, overrides not applied: {e}"
                );
                // Not an empty success: nothing was applied, and the
                // caller (restart recovery) has to count it as a failure.
                return Err(format!("MihomoState lock poisoned: {e}"));
            }
        };
        lock.last_config_path().map(String::from)
    };

    let meta = overrides_store::load_meta(&state)?;

    // Collect enabled overrides by type with scope filtering.
    // Pre-execution errors (empty file, read failure) are included in the returned logs
    // so the UI can display them alongside execution results.
    let (js_scripts, prism_patches, pre_logs) =
        collect_apply_all_items(&state, &meta.items, current_profile_id.as_deref());

    if js_scripts.is_empty() && prism_patches.is_empty() {
        return Ok(pre_logs);
    }

    let mut all_logs = pre_logs;
    let mut prism_success = false;
    // Patches the core already runs: Prism's own reload during `ext.apply`
    // was accepted, so a failed final reload does not undo them.
    let mut live_prism_ids: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut js_modified = false;

    // Phase 1: Apply Prism YAML overrides (batch: write all patches → single compile → single write)
    // Prism DSL runs first so JS overrides can read and modify Prism's output.
    if !prism_patches.is_empty() {
        // The host reloads the core during this batch's `ext.apply`. One more
        // reload, awaited, runs at the end only when a JS override changed
        // the config afterwards or the core did not take the host's reload:
        // the caller restores the proxy selection right after and must see
        // the reloaded groups. A batch that fails as a whole (patch write,
        // run config write, a poisoned lock) becomes one failed log per
        // patch, saved like the others, and the JS overrides below still run.
        let (prism_logs, prism_reloaded) = execute_prism_yaml_batch(&state, &prism_patches, false)
            .unwrap_or_else(|e| {
                emit_warn!(
                    Override,
                    OVERRIDE_APPLY_FAILED,
                    "Prism override batch failed: {e}"
                );
                let logs = prism_patches
                    .iter()
                    .map(|(id, name, _, _)| failed_apply_log(id.clone(), name.clone(), e.clone()))
                    .collect();
                (logs, false)
            });
        if prism_reloaded {
            live_prism_ids.extend(
                prism_logs
                    .iter()
                    .filter(|log| log.success)
                    .map(|log| log.script_id.clone()),
            );
        }
        if let Some(first_log) = prism_logs.first() {
            prism_success = first_log.success;
        }
        for log in &prism_logs {
            if let Err(e) = overrides_store::save_log(&state, &log.script_id, log) {
                emit_warn!(
                    Override,
                    OVERRIDE_APPLY_FAILED,
                    "Failed to save log for '{}': {e}",
                    log.script_name
                );
            }
        }
        all_logs.extend(prism_logs);
    }

    // Phase 2: Execute JS overrides via batch pipeline
    // JS overrides run after Prism so they can modify Prism's output.
    if !js_scripts.is_empty() {
        // Use batch pipeline: single load → all scripts in memory → single write → single reload
        let script_refs: Vec<(&str, &str)> = js_scripts
            .iter()
            .map(|(_, name, content)| (content.as_str(), name.as_str()))
            .collect();

        // A batch that fails as a whole must not skip the reload below:
        // Prism patches written in phase 1 would otherwise never reach the core.
        let results = match execute_batch_pipeline(&state, &script_refs, false) {
            Ok(results) => results,
            Err(e) => {
                emit_warn!(
                    Override,
                    OVERRIDE_APPLY_FAILED,
                    "JS override batch failed: {e}"
                );
                for (id, name, _) in &js_scripts {
                    let log = failed_apply_log(id.clone(), name.clone(), e.clone());
                    // Saved like every other result, so the overrides
                    // page does not keep showing the previous run's.
                    if let Err(save_err) = overrides_store::save_log(&state, id, &log) {
                        emit_warn!(
                            Override,
                            OVERRIDE_APPLY_FAILED,
                            "Failed to save log for '{name}': {save_err}"
                        );
                    }
                    all_logs.push(log);
                }
                Vec::new()
            }
        };

        // Convert pipeline results to override logs
        let exec_logs: Vec<OverrideLog> = js_scripts
            .iter()
            .zip(results.iter())
            .map(|((id, name, _), result)| {
                let log = OverrideLog {
                    script_id: id.clone(),
                    script_name: name.clone(),
                    executed_at: chrono::Utc::now().timestamp_millis(),
                    duration_us: result.duration_us,
                    success: result.success,
                    config_modified: result.config_modified,
                    error: result.error.clone(),
                    logs: result
                        .logs
                        .iter()
                        .map(|l| LogEntry {
                            level: l.level.clone(),
                            message: l.message.clone(),
                        })
                        .collect(),
                };
                // Persist individual logs (ignore errors)
                if let Err(e) = overrides_store::save_log(&state, id, &log) {
                    emit_warn!(
                        Override,
                        OVERRIDE_APPLY_FAILED,
                        "Failed to save log for '{name}': {e}"
                    );
                }
                log
            })
            .collect();

        js_modified = results.iter().any(|r| r.success && r.config_modified);
        all_logs.extend(exec_logs);
    }

    // Hot-reload if any JS script modified the config or Prism YAML patches
    // succeeded, and only return once the core has the new config. A reload
    // the core refuses means none of those changes took effect yet: each
    // saved result says so, and that the change stays in the running config
    // and goes live with its next reload (the overrides page reads them), and
    // the reload is reported as one more failed entry. Prism patches the core
    // already took during their own apply stay successful: they are live, and
    // when nothing else was lost the failed reload is only logged. When the
    // core already took the Prism output and no JS override changed it, there
    // is nothing left to reload: the host's apply did the reload and the TUN
    // reconcile.
    let prism_pending = prism_success && live_prism_ids.is_empty();
    if js_modified || prism_pending {
        if let Err(e) = crate::prism::pipeline::hot_reload_and_wait(&state).await {
            let error = format!(
                "The core did not reload the overridden config: {e}. The change is \
                 saved in the running config and takes effect at its next reload."
            );
            record_failed_final_reload(&state, &mut all_logs, &live_prism_ids, error);
        }
    }

    Ok(all_logs)
}

/// A JS override to run: `(id, name, content)`.
type JsScript = (String, String, String);
/// A Prism override to apply: `(id, name, patch_filename, content)`.
type PrismPatch = (String, String, String, String);

/// The enabled overrides `override_apply_all` runs for the active profile
/// (global ones, or ones listing `current_profile_id`), split into JS scripts
/// `(id, name, content)` and sanitized Prism patches
/// `(id, name, patch_filename, content)`, plus a saved failed log for each
/// one that could not be read (empty, unreadable, or invalid Prism YAML).
fn collect_apply_all_items(
    state: &PrismState,
    items: &[OverrideItem],
    current_profile_id: Option<&str>,
) -> (Vec<JsScript>, Vec<PrismPatch>, Vec<OverrideLog>) {
    let mut js_scripts: Vec<JsScript> = Vec::new();
    let mut prism_patches: Vec<PrismPatch> = Vec::new();
    let mut pre_logs: Vec<OverrideLog> = Vec::new();
    for item in items.iter().filter(|i| i.enabled) {
        // Scope filtering: skip if not global and not matching current profile
        let in_scope = item.global
            || current_profile_id.is_some_and(|pid| item.profile_ids.iter().any(|p| p == pid));
        if !in_scope {
            continue;
        }

        let content = match overrides_store::read_content(state, &item.id) {
            Ok(c) if !c.is_empty() => c,
            Ok(_) => {
                pre_logs.push(saved_pre_log(
                    state,
                    item,
                    "Override file is empty".to_owned(),
                    "Override content file is empty".to_owned(),
                ));
                continue;
            }
            Err(e) => {
                pre_logs.push(saved_pre_log(
                    state,
                    item,
                    format!("Failed to read override: {e}"),
                    format!("Failed to read override content: {e}"),
                ));
                continue;
            }
        };
        if item.ext != OverrideExt::PrismYaml {
            js_scripts.push((item.id.clone(), item.name.clone(), content));
            continue;
        }
        // Stored content saved before write-path sanitization (or
        // edited on disk) must not reach the core unsanitized.
        match sanitize_override_yaml(&content) {
            Ok(clean) => {
                prism_patches.push((
                    item.id.clone(),
                    item.name.clone(),
                    item.patch_filename(),
                    clean,
                ));
            }
            Err(e) => {
                let removal_note = remove_stale_patch(state, item);
                pre_logs.push(saved_pre_log(
                    state,
                    item,
                    format!("Invalid Prism YAML: {e}"),
                    format!(
                        "Stored override content is not valid YAML: {e}{}",
                        removal_note.as_deref().unwrap_or_default()
                    ),
                ));
            }
        }
    }
    (js_scripts, prism_patches, pre_logs)
}

/// Removes the workspace patch an earlier apply left for `item`: the batch
/// compilation applies every patch file in the workspace, so a stale patch
/// must not survive its stored content failing sanitization. A removal failure is
/// returned as a note for the override's log instead of being discarded.
fn remove_stale_patch(state: &PrismState, item: &OverrideItem) -> Option<String> {
    let prism_dir = crate::prism::prism_data_dir(&state.app).ok()?;
    let patch_path = prism_dir.join(item.patch_filename());
    if !patch_path.exists() {
        return None;
    }
    std::fs::remove_file(&patch_path)
        .err()
        .map(|re| format!(" Also failed to remove its stale workspace patch: {re}"))
}

/// A failed log for an override `override_apply_all` could not run, saved
/// so the overrides page shows it.
fn saved_pre_log(
    state: &PrismState,
    item: &OverrideItem,
    error: String,
    message: String,
) -> OverrideLog {
    let log = OverrideLog {
        script_id: item.id.clone(),
        script_name: item.name.clone(),
        executed_at: chrono::Utc::now().timestamp_millis(),
        duration_us: 0,
        success: false,
        config_modified: false,
        error: Some(error),
        logs: vec![LogEntry {
            level: "Error".to_owned(),
            message,
        }],
    };
    if let Err(e) = overrides_store::save_log(state, &item.id, &log) {
        emit_warn!(
            Override,
            OVERRIDE_APPLY_FAILED,
            "Failed to save log for '{}': {e}",
            item.name
        );
    }
    log
}

/// Records a failed final reload of `override_apply_all`: each override whose
/// change is not on the core yet is marked failed with `error` and saved
/// again, and the reload becomes one more failed entry. When every change is
/// already on the core (Prism patches it took during their own apply), the
/// failure loses nothing, so it is only logged rather than reported as a
/// failed override, which restart recovery would warn about.
fn record_failed_final_reload(
    state: &PrismState,
    all_logs: &mut Vec<OverrideLog>,
    live_prism_ids: &std::collections::HashSet<String>,
    error: String,
) {
    let mut lost_any = false;
    for log in all_logs.iter_mut() {
        if !lost_by_failed_reload(log, live_prism_ids) {
            continue;
        }
        lost_any = true;
        log.success = false;
        log.error = Some(error.clone());
        let saved: &OverrideLog = log;
        if let Err(save_err) = overrides_store::save_log(state, &saved.script_id, saved) {
            emit_warn!(
                Override,
                OVERRIDE_APPLY_FAILED,
                "Failed to save log for '{}': {save_err}",
                saved.script_name
            );
        }
    }
    if lost_any {
        all_logs.push(failed_apply_log(
            String::new(),
            "hot-reload".to_owned(),
            error,
        ));
    } else {
        emit_warn!(Override, OVERRIDE_APPLY_FAILED, "{error}");
    }
}

/// Whether a failed final reload means this override's change is not on the
/// core: it changed the config, and it is not a Prism patch the core already
/// took during its own apply.
fn lost_by_failed_reload(
    log: &OverrideLog,
    live_prism_ids: &std::collections::HashSet<String>,
) -> bool {
    log.success
        && log.config_modified
        && !log.script_id.is_empty()
        && !live_prism_ids.contains(&log.script_id)
}

/// A log entry for a step of `override_apply_all` that failed before or
/// after the scripts themselves ran.
fn failed_apply_log(script_id: String, script_name: String, error: String) -> OverrideLog {
    OverrideLog {
        script_id,
        script_name,
        executed_at: chrono::Utc::now().timestamp_millis(),
        duration_us: 0,
        success: false,
        config_modified: false,
        error: Some(error),
        logs: Vec::new(),
    }
}

/// Download remote content directly first, falling back to managed core proxy if direct connection fails.
///
/// Uses the unified `fetch_url_content` function from `fetch_util` for consistent
/// security measures (SSRF protection, DNS pinning, redirect validation).
async fn download_remote_content(app: &tauri::AppHandle, url: &str) -> Result<String, String> {
    let mut content = fetch_url_content(url, Some(app)).await?;
    // Strip UTF-8 BOM in-place to avoid interfering with content detection
    if content.starts_with('\u{feff}') {
        content.drain(..'\u{feff}'.len_utf8());
    }
    // Reject empty responses — aligned with subscription.rs empty content check
    if content.trim().is_empty() {
        return Err(
            "Remote override returned empty content. The URL may be invalid or the resource unavailable.".to_owned(),
        );
    }
    check_input_size(&content, "Remote override content")?;
    Ok(content)
}

// ═══════════════════════════════════════════════════════════════════════
//  Export / Import
// ═══════════════════════════════════════════════════════════════════════

/// Serializable export entry — metadata + content for a single override.
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportEntry {
    name: String,
    ext: String,
    r#type: String,
    global: bool,
    profile_ids: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    url: Option<String>,
    enabled: bool,
    content: String,
}

/// Export payload with version for forward compatibility.
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportPayload {
    version: u32,
    exported_at: i64,
    items: Vec<ExportEntry>,
}

/// Export all overrides as a JSON file in the `prism/overrides/exports/` directory.
///
/// Returns the absolute path of the written file so the UI can display it.
#[tauri::command]
pub fn override_export(state: State<PrismState>) -> Result<String, String> {
    use chrono::Local;

    let meta = overrides_store::load_meta(&state)?;
    if meta.items.is_empty() {
        return Err("No overrides to export".to_owned());
    }

    let mut entries = Vec::with_capacity(meta.items.len());
    for item in &meta.items {
        let content = match overrides_store::read_content(&state, &item.id) {
            Ok(c) => c,
            Err(e) => {
                emit_warn!(
                    Override,
                    OVERRIDE_APPLY_FAILED,
                    "[overrides] Failed to read content for '{}', skipping: {e}",
                    item.name
                );
                continue;
            }
        };
        entries.push(ExportEntry {
            name: item.name.clone(),
            ext: item.ext.file_ext().to_owned(),
            r#type: match item.r#type {
                OverrideType::Local => "local".to_owned(),
                OverrideType::Remote => "remote".to_owned(),
            },
            global: item.global,
            profile_ids: item.profile_ids.clone(),
            url: item.url.clone(),
            enabled: item.enabled,
            content,
        });
    }

    let payload = ExportPayload {
        version: 1,
        exported_at: chrono::Utc::now().timestamp_millis(),
        items: entries,
    };

    let json = serde_json::to_string_pretty(&payload)
        .map_err(|e| format!("Failed to serialize export: {e}"))?;

    // Write to prism/overrides/exports/
    let overrides_dir = overrides_store::overrides_dir(&state)?;
    let exports_dir = overrides_dir.join("exports");
    std::fs::create_dir_all(&exports_dir)
        .map_err(|e| format!("Failed to create exports dir: {e}"))?;

    let filename = format!(
        "zephyr-overrides-{}.json",
        Local::now().format("%Y-%m-%d-%H%M%S")
    );
    let export_path = exports_dir.join(&filename);
    write_file_secure(&export_path, &json)
        .map_err(|e| format!("Failed to write export file: {e}"))?;

    // Return the absolute path as a string for the UI to display
    Ok(export_path.to_string_lossy().into_owned())
}

/// Import overrides from a JSON string (read by the front-end file picker).
///
/// Accepts the raw JSON content of a previously exported file.
/// Creates each override, writes its content, and applies scope/enabled state.
/// Uses batch import for efficiency (single metadata lock for all items).
/// Returns the number of overrides imported.
#[tauri::command]
pub fn override_import(state: State<PrismState>, json: String) -> Result<u32, String> {
    check_input_size(&json, "Import payload")?;

    let payload: ExportPayload =
        serde_json::from_str(&json).map_err(|e| format!("Invalid export file format: {e}"))?;

    if payload.items.is_empty() {
        return Err("Export file contains no overrides".to_owned());
    }

    // Build items with all fields pre-populated (avoids per-item update_item calls)
    let mut items_to_import: Vec<(OverrideItem, String)> = Vec::with_capacity(payload.items.len());

    for entry in payload.items {
        if entry.name.is_empty() || entry.ext.is_empty() {
            emit_warn!(
                Override,
                OVERRIDE_APPLY_FAILED,
                "Skipping malformed import entry: empty name or ext"
            );
            continue;
        }

        // No name-size check on import: this is a restore path for backups
        // exported earlier, and legacy names must round-trip. The payload
        // as a whole is already capped by check_input_size above; the
        // 1024-byte name limit applies to interactive create/rename only.

        let Some(ext) = OverrideExt::from_ext(&entry.ext) else {
            emit_warn!(
                Override,
                OVERRIDE_APPLY_FAILED,
                "[overrides] Skipping import entry with unknown ext: {}",
                entry.ext
            );
            continue;
        };
        let r#type = match entry.r#type.as_str() {
            "remote" => OverrideType::Remote,
            _ => OverrideType::Local,
        };

        let content = if ext == OverrideExt::PrismYaml {
            match sanitize_override_yaml(&entry.content) {
                Ok(s) => s,
                Err(e) => {
                    emit_warn!(
                        Override,
                        OVERRIDE_APPLY_FAILED,
                        "Skipping import entry with invalid YAML '{}': {e}",
                        entry.name
                    );
                    continue;
                }
            }
        } else {
            entry.content
        };

        // Pre-populate all fields to avoid redundant update_item call
        let mut item = OverrideItem::new(entry.name, ext, r#type);
        item.global = entry.global;
        item.profile_ids = entry.profile_ids;
        item.enabled = entry.enabled;
        item.url = entry.url;

        items_to_import.push((item, content));
    }

    // Batch import: single metadata lock, then best-effort content writes
    overrides_store::import_items_batch(&state, items_to_import)
}

#[cfg(test)]
#[path = "overrides_commands_tests.rs"]
mod overrides_commands_tests;
