use crate::core_manager::MihomoState;
use crate::{persist_settings, SettingsState};
use std::fs::{self, File};
use std::path::PathBuf;
use tauri::{AppHandle, Manager as _};
use tauri_plugin_dialog::DialogExt as _;

use super::core_process::ensure_app_storage;
use super::crypto::{
    cleanup_metadata_cache, load_metadata, lock_metadata, read_profile_file, save_metadata,
    save_profile_file, ConfigMetadata,
};
use super::secure_io::write_file_secure;
use super::ConfigInfo;
use zephyr_core::config::sanitizer::{sanitize_config_file_name, validate_path_within_dir};

/// Common validation for config update commands.
/// Returns sanitized name and app paths if valid.
fn validate_config_for_update(
    app: &AppHandle,
    name: &str,
) -> Result<(super::AppPaths, String), String> {
    let safe_name = sanitize_config_file_name(name.to_owned()).map_err(|e| e.to_string())?;
    if safe_name == "run_config.yaml" {
        return Err("Cannot modify the active temp config".to_owned());
    }
    let paths = ensure_app_storage(app)?;
    let config_path = paths.profiles_dir.join(&safe_name);
    if !config_path.exists() {
        return Err(format!("Config not found: {safe_name}"));
    }
    Ok((paths, safe_name))
}

/// Mask URL for safe display in UI — delegates to [`zephyr_core`].
#[must_use]
pub fn mask_url(url: &str) -> String {
    zephyr_core::config::merge::mask_url(url.to_owned())
}

#[tauri::command]
pub async fn list_configs(app: AppHandle) -> Result<Vec<ConfigInfo>, String> {
    let mut configs = Vec::new();
    let paths = ensure_app_storage(&app)?;

    // Clean up stale metadata entries
    cleanup_metadata_cache(&paths);

    let metadata = load_metadata(&paths);

    if let Ok(entries) = fs::read_dir(&paths.profiles_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            // Directories are not profiles, even when they carry a
            // YAML extension.
            if path.is_file()
                && path
                    .extension()
                    .and_then(std::ffi::OsStr::to_str)
                    .is_some_and(|ext| {
                        ext.eq_ignore_ascii_case("yaml") || ext.eq_ignore_ascii_case("yml")
                    })
            {
                if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                    if name != "run_config.yaml" {
                        let (url, sub_info, last_updated, auto_update_interval, user_agent) =
                            if let Some(meta) = metadata.configs.get(name) {
                                (
                                    meta.url.clone(),
                                    meta.sub_info.clone(),
                                    meta.last_updated,
                                    meta.auto_update_interval,
                                    meta.user_agent.clone(),
                                )
                            } else {
                                // Fallback to reading old comments
                                let mut url = None;
                                let mut sub_info = None;
                                if let Ok(file) = std::fs::File::open(&path) {
                                    use std::io::{BufRead as _, BufReader};
                                    let reader = BufReader::new(file);
                                    for line in reader.lines().take(50).map_while(Result::ok) {
                                        if line.starts_with("# URL: ") {
                                            url =
                                                Some(line.replace("# URL: ", "").trim().to_owned());
                                        } else if line.starts_with("# SUB_INFO: ") {
                                            sub_info = Some(
                                                line.replace("# SUB_INFO: ", "").trim().to_owned(),
                                            );
                                        }
                                    }
                                }
                                (url, sub_info, None, None, None)
                            };

                        let url_display = url.as_ref().map(|u| mask_url(u));

                        configs.push(ConfigInfo {
                            name: name.to_owned(),
                            url,
                            url_display,
                            sub_info,
                            last_updated,
                            auto_update_interval,
                            user_agent,
                        });
                    }
                }
            }
        }
    }
    configs.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(configs)
}

/// Get the full (unmasked) subscription URL for a given config name.
/// Internal use only — NOT exposed as a Tauri command to prevent URL leakage to the frontend.
pub fn get_config_url(app: &AppHandle, name: &str) -> Result<String, String> {
    // Reuse comprehensive sanitization (URL decode, path traversal check, etc.)
    let safe_name = sanitize_config_file_name(name.to_owned()).map_err(|e| e.to_string())?;

    let paths = ensure_app_storage(app)?;
    let metadata = load_metadata(&paths);

    // Look up URL from metadata first
    if let Some(meta) = metadata.configs.get(&safe_name) {
        if let Some(url) = &meta.url {
            return Ok(url.clone());
        }
    }

    // Fallback: read from file comments (legacy format)
    let path = paths.profiles_dir.join(&safe_name);
    if let Ok(file) = std::fs::File::open(&path) {
        use std::io::{BufRead as _, BufReader};
        let reader = BufReader::new(file);
        for line in reader.lines().map_while(Result::ok) {
            if line.starts_with("# URL: ") {
                return Ok(line.replace("# URL: ", "").trim().to_owned());
            }
        }
    }

    Err(format!("No subscription URL found for config: {name}"))
}

/// Update the subscription URL for an existing config in metadata.
#[tauri::command]
pub async fn update_config_url(
    app: AppHandle,
    name: String,
    new_url: String,
) -> Result<(), String> {
    let (paths, safe_name) = validate_config_for_update(&app, &name)?;

    // Trim whitespace before validation and storage
    let trimmed_url = new_url.trim();

    // Structural URL validation
    let parsed = url::Url::parse(trimmed_url).map_err(|e| format!("Invalid URL: {e}"))?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err("URL must use http:// or https://".to_owned());
    }

    let _guard = lock_metadata();
    let mut metadata = load_metadata(&paths);
    let entry = metadata.configs.entry(safe_name).or_default();
    entry.url = Some(trimmed_url.to_owned());
    save_metadata(&paths, &metadata)?;

    Ok(())
}

/// Update the auto-update interval for a subscription.
#[tauri::command]
pub async fn update_subscription_interval(
    app: AppHandle,
    name: String,
    interval: u64,
) -> Result<(), String> {
    let (paths, safe_name) = validate_config_for_update(&app, &name)?;
    let fallback_url = get_config_url(&app, &safe_name).ok();

    let _guard = lock_metadata();
    let mut metadata = load_metadata(&paths);
    let entry = metadata
        .configs
        .entry(safe_name)
        .or_insert_with(|| ConfigMetadata {
            url: fallback_url,
            ..Default::default()
        });
    entry.auto_update_interval = (interval > 0).then_some(interval);
    save_metadata(&paths, &metadata)?;

    Ok(())
}

/// Update the per-subscription User-Agent override.
/// When `user_agent` is `None` or empty, the subscription falls back to the
/// global `subscription_user_agent` from settings.
#[tauri::command]
pub async fn update_subscription_ua(
    app: AppHandle,
    name: String,
    user_agent: Option<String>,
) -> Result<(), String> {
    let (paths, safe_name) = validate_config_for_update(&app, &name)?;

    let normalized = user_agent
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from);

    if let Some(ua) = normalized.as_ref() {
        if ua.len() > 512 {
            return Err("User-Agent exceeds maximum length of 512 characters".to_owned());
        }
        if !ua.chars().all(|c| c.is_ascii() && !c.is_ascii_control()) {
            return Err("User-Agent contains invalid characters".to_owned());
        }
    }

    let fallback_url = get_config_url(&app, &safe_name).ok();

    let _guard = lock_metadata();
    let mut metadata = load_metadata(&paths);
    let entry = metadata
        .configs
        .entry(safe_name)
        .or_insert_with(|| ConfigMetadata {
            url: fallback_url,
            ..Default::default()
        });
    entry.user_agent.clone_from(&normalized);
    save_metadata(&paths, &metadata)?;

    Ok(())
}

/// Strip `.yaml`/`.yml` 扩展名（大小写不敏感），返回剩余部分；无扩展名则原样返回。
/// 用于配置名比较时忽略扩展名差异（如 "foo.yaml" vs "foo.yml" / "foo.YAML" / "foo.Yaml"）。
/// 在 Windows/macOS 等大小写不敏感文件系统上，扩展名可能是任意大小写组合。
/// 使用 `str::get` 安全切片，避免多字节 UTF-8 字符（如中文）导致字节索引落在字符中间而 panic。
fn strip_yaml_ext(name: &str) -> &str {
    if name.len() >= 5 {
        if let Some(suffix) = name.get(name.len() - 5..) {
            if suffix.eq_ignore_ascii_case(".yaml") {
                // 此时后 5 字节是 ".yaml"，前缀必然是合法 UTF-8 边界
                return &name[..name.len() - 5];
            }
        }
    }
    if name.len() >= 4 {
        if let Some(suffix) = name.get(name.len() - 4..) {
            if suffix.eq_ignore_ascii_case(".yml") {
                return &name[..name.len() - 4];
            }
        }
    }
    name
}

/// Build the `.yml` fallback name for a missing `.yaml` profile: only the
/// trailing extension is swapped, so `team.yaml.backup` never falls back
/// to the unrelated `team.yml.backup.yml`. The match is case-insensitive
/// so an uppercase `.YAML` name still finds its `.yml` file, while the
/// stem keeps its original spelling. Uses `str::get` like
/// [`strip_yaml_ext`]: a multibyte character straddling the suffix
/// boundary (e.g. a missing `é.yml` / `中.yml`) is a non-match, not a
/// panic — the raw slice would panic before the comparison ever ran.
fn yml_fallback_name(clean_name: &str) -> String {
    if clean_name.len() >= 5 {
        if let Some(suffix) = clean_name.get(clean_name.len() - 5..) {
            if suffix.eq_ignore_ascii_case(".yaml") {
                // The suffix matched ".yaml", so its five bytes are ASCII
                // and the cut is a char boundary.
                return format!("{}.yml", &clean_name[..clean_name.len() - 5]);
            }
        }
    }
    clean_name.to_owned()
}

/// Whether a stored profile spelling is the reserved runtime config.
/// The comparison is exact: a case variant such as `RUN_CONFIG.yaml`
/// is an ordinary listed profile when that is how it is stored
/// (creation and listing both treat only the exact `run_config.yaml`
/// as reserved), while the runtime config's own spelling stays
/// protected.
fn is_reserved_config_name(stored_name: &str) -> bool {
    stored_name == "run_config.yaml"
}

/// The name as stored on disk. On a case-insensitive filesystem the
/// request may differ in case from the entry (`FOO.YAML` deletes
/// `foo.yaml`); metadata keys and `last_config` use the stored spelling,
/// so removing them under the request's spelling would leave stale
/// references behind. An exact-case match always wins: on a
/// case-sensitive filesystem `foo.yaml` and `Foo.yaml` can coexist, and
/// taking the first case-insensitive match in `read_dir` order could
/// clear the metadata of the file that was *not* deleted. The
/// case-insensitive fallback compares Unicode lowercases, not ASCII
/// only: on a case-insensitive volume `É.YAML` and `é.YAML` are the
/// same file. Falls back to the request when the entry is gone.
fn actual_entry_name(dir: &std::path::Path, name: &str) -> String {
    if let Ok(entries) = std::fs::read_dir(dir) {
        // Prefer an exact-case match; remember the first
        // case-insensitive match as a fallback.
        let mut case_insensitive_match: Option<String> = None;
        for entry in entries.flatten() {
            let file_name = entry.file_name().to_string_lossy().into_owned();
            if file_name == name {
                return file_name;
            }
            if case_insensitive_match.is_none() && file_name.to_lowercase() == name.to_lowercase() {
                case_insensitive_match = Some(file_name);
            }
        }
        if let Some(matched) = case_insensitive_match {
            return matched;
        }
    }
    // Normalization-insensitive volumes (macOS): the request may use a
    // different Unicode normalization form than the stored spelling
    // (composed `é` vs decomposed `e` + accent), which lowercase
    // comparison cannot see. The filesystem itself resolves it:
    // canonicalize returns the stored spelling. Only when the resolved
    // file is a direct child of this directory, and only for a
    // non-symlink: canonicalize would give a symlink's target name
    // instead of the link's own name, which is what metadata keys use.
    let entry_path = dir.join(name);
    let is_symlink = entry_path
        .symlink_metadata()
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false);
    if !is_symlink {
        if let Ok(canonical) = entry_path.canonicalize() {
            if let (Some(file_name), Ok(canonical_dir)) =
                (canonical.file_name(), dir.canonicalize())
            {
                if canonical.parent() == Some(canonical_dir.as_path()) {
                    return file_name.to_string_lossy().into_owned();
                }
            }
        }
    }
    name.to_owned()
}

/// Whether a `last_config` value names the deleted profile.
///
/// The value is normalized (an extensionless `foo` means `foo.yaml`)
/// and compared by stem. A match only counts when no file by that
/// name is left on disk: the same stem can name a surviving sibling
/// with a different extension (`foo.yaml` outlives the deletion of
/// `foo.yml`), and the file may have been recreated by a concurrent
/// save after the deletion transaction released the transform lock.
/// The two-phase cleanup re-checks under the settings lock, so a
/// recreation between the check and the reset cannot slip through.
/// The stem checks use the normalized name, not the raw value: for an
/// extensionless value the raw name has no extension and would stat a
/// nonexistent path, resetting a reference to a surviving profile.
fn is_same_config_name(profiles_dir: &std::path::Path, lc: &str, deleted_name: &str) -> bool {
    if lc == deleted_name {
        // The file was just deleted; only reset when it is really
        // gone (see the doc comment).
        return !profiles_dir.join(lc).exists();
    }
    let norm_lc = sanitize_config_file_name(lc.to_owned())
        .or_else(|_| sanitize_config_file_name(format!("{lc}.yaml")))
        .unwrap_or_default();
    let norm_del = sanitize_config_file_name(deleted_name.to_owned()).unwrap_or_default();
    if norm_lc.is_empty() {
        return false;
    }
    if strip_yaml_ext(&norm_lc) == strip_yaml_ext(&norm_del) {
        // Same stem: the value names the deleted file — unless it
        // names a surviving sibling with a different extension
        // (`foo.yaml` outlives the deletion of `foo.yml`).
        return !profiles_dir.join(&norm_lc).exists();
    }
    // The selected name may differ in case from the stored spelling
    // (`FOO.yaml` selected, `foo.yaml` on disk). A case-insensitive
    // stem match alone would also match a *different* profile on a
    // case-sensitive filesystem, so only treat it as the same file
    // when nothing by that name is left on disk. This stat runs
    // only on the case-insensitive-match path, not the common one.
    // Unicode lowercase, like the stored-name resolution above:
    // `É` and `é` are the same file on a case-insensitive volume.
    strip_yaml_ext(&norm_lc).to_lowercase() == strip_yaml_ext(&norm_del).to_lowercase()
        && !profiles_dir.join(&norm_lc).exists()
}

/// 删除配置后检查 `last_config` 是否悬空（指向已删除的文件）。
/// 如果是，重置为第一个可用配置；如果没有任何配置，置为 `None`。
fn cleanup_dangling_last_config(app: &AppHandle, paths: &super::AppPaths, deleted_name: &str) {
    let state = app.state::<SettingsState>();
    // 判断 last_config 是否指向已删除的配置（规范化 + strip 扩展名后比较）
    // 提取为闭包便于两段锁内复用，避免 TOCTOU 竞态时第二段锁无条件覆盖并发更新
    let is_same_config =
        |lc: &str| -> bool { is_same_config_name(&paths.profiles_dir, lc, deleted_name) };

    // 第一段持锁：只判断是否需要清理，避免在锁内做阻塞 I/O 导致锁竞争
    let needs_cleanup = {
        let settings_guard = state
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        settings_guard
            .last_config
            .as_deref()
            .is_some_and(is_same_config)
    };

    if !needs_cleanup {
        return;
    }

    // 锁外执行阻塞文件系统 I/O：找到第一个可用的配置文件作为替代
    let new_config = super::core_process::first_available_profile(paths).and_then(|p| {
        p.file_name()
            .and_then(|name| name.to_str())
            .map(std::borrow::ToOwned::to_owned)
    });

    // 第二段持锁：再次确认 last_config 仍指向已删除的配置才覆盖，避免并发修改被丢弃
    // 写盘也在锁内完成：锁外写入的旧快照可能晚于更新的快照落盘，把它覆盖回去
    let settings_clone = {
        let mut settings_guard = state
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if !settings_guard
            .last_config
            .as_deref()
            .is_some_and(is_same_config)
        {
            return;
        }
        let mut next = settings_guard.clone();
        next.last_config = new_config;
        if let Err(e) = persist_settings(app, &next) {
            // Persist-then-publish: memory keeps matching settings.json.
            drop(settings_guard);
            crate::emit_warn!(
                Config,
                CONFIG_PERSIST_FAILED,
                "Failed to persist settings after last_config cleanup: {e}"
            );
            return;
        }
        *settings_guard = next.clone();
        drop(settings_guard);
        next
    };
    if let Some(name) = &settings_clone.last_config {
        crate::emit_info!(
            Config,
            CONFIG_DANGLING_REF_CLEANED,
            "last_config was dangling (pointed to deleted '{deleted_name}'), reset to '{name}'"
        );
    } else {
        crate::emit_info!(
            Config,
            CONFIG_DANGLING_REF_CLEANED,
            "last_config was dangling (pointed to deleted '{deleted_name}'), reset to None (no profiles left)"
        );
    }
}

/// Remove a profile under the profile-transform guard, so the encryption batch
/// cannot read the file before the removal and write it back afterwards.
/// The actual removal, without taking the profile-transform lock: the
/// caller must hold it (see [`delete_profile_file_transaction`]).
fn remove_profile_file_inner(path: &std::path::Path) -> Result<(), String> {
    fs::remove_file(path).map_err(|e| format!("Failed to delete file: {e}"))
}

/// Delete a profile file and verify it is actually gone, without taking
/// the profile-transform lock: the caller must hold it (see
/// [`delete_profile_file_transaction`]).
/// On Windows a remove can report success while the file remains
/// (locked), so one attempt is not proof; retries once after a short
/// wait. A retry that finds the file already gone is success: the
/// pending deletion completed during the wait.
fn remove_profile_file_verified_inner(path: &std::path::Path) -> Result<(), String> {
    remove_profile_file_inner(path)?;
    // Verify deletion (Windows may report success but file remains if locked)
    if path.exists() {
        std::thread::sleep(std::time::Duration::from_millis(100));
        if let Err(err) = remove_profile_file_inner(path) {
            // The pending deletion may have completed during the
            // wait: a missing file is the success we were waiting for.
            // Only a confirmed absence counts: `Path::exists` returns
            // false for any inspection error, so it would mistake a
            // locked or inaccessible file for a completed deletion.
            if path_is_absent(path) {
                return Ok(());
            }
            return Err(err);
        }
        if !path_is_absent(path) {
            return Err("File could not be deleted (locked by another process?)".to_owned());
        }
    }
    Ok(())
}

/// Whether a path is confirmed absent: only a `NotFound` inspection
/// counts. `Path::exists` returns false for *any* error, so it would
/// mistake an inspection failure (a locked or inaccessible file) for
/// a completed deletion and report success while the file remains.
/// The link itself is inspected, not its target: a dangling symlink
/// is a present entry, and removing it is what the delete verified.
fn path_is_absent(path: &std::path::Path) -> bool {
    matches!(
        path.symlink_metadata(),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound
    )
}

/// Remove every metadata entry that names a deleted profile file.
///
/// Keys may be stored under any case spelling of the name, so an
/// exact-spelling removal leaves aliases behind on case-insensitive
/// volumes. A differently-cased key is removed only when no file by
/// that exact spelling remains: on a case-sensitive filesystem a
/// differently-cased key belongs to a distinct surviving file.
/// `names` lists the spellings known to name the file (stored and
/// request); a key matching any of them case-insensitively is the
/// deleted file's when its own file is gone.
fn remove_deleted_metadata(paths: &super::AppPaths, names: &[String]) -> Result<(), String> {
    let _guard = lock_metadata();
    let mut metadata = load_metadata(paths);
    let lowers: Vec<String> = names.iter().map(|n| n.to_lowercase()).collect();
    let dir = &paths.profiles_dir;
    metadata.configs.retain(|key, _| {
        if !lowers.iter().any(|lower| key.to_lowercase() == *lower) {
            return true;
        }
        // An exact spelling always goes; a differently-cased key goes
        // only when its file is gone (see the doc comment).
        if names.iter().any(|n| n == key) {
            return false;
        }
        dir.join(key).exists()
    });
    save_metadata(paths, &metadata)
}

/// Delete one profile file and its metadata entries as a single
/// transform-guarded transaction on the blocking pool.
///
/// Holding the transform guard across the file removal, the
/// verification retry, the metadata cleanup, and the selection
/// cleanup keeps a concurrent save (subscription or user) from
/// recreating the profile in between and having its fresh metadata
/// removed, or its selection reset, while the recreated file
/// survives — the same serialization the subscription save already
/// keeps for its own file swap plus metadata write. The lock is a
/// std mutex a save can hold for a while, so waiting for it must
/// not stall a Tokio worker (same rule as `update_config`).
/// The selection cleanup runs even on partial failure (file gone,
/// metadata not saved): the command still reports the deletion
/// error, but a dangling `last_config` must not be left behind for
/// a retry to trip over.
async fn delete_profile_file_transaction(
    app: AppHandle,
    paths: super::AppPaths,
    target_path: std::path::PathBuf,
    metadata_names: Vec<String>,
    deleted_name: String,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let _transform_guard = crate::lock_profile_transform();
        let remove_result = remove_profile_file_verified_inner(&target_path);
        let metadata_result = match &remove_result {
            Ok(()) => remove_deleted_metadata(&paths, &metadata_names),
            // If the file could not be removed, metadata stays intact.
            Err(_) => Ok(()),
        };
        cleanup_dangling_last_config(&app, &paths, &deleted_name);
        remove_result.and(metadata_result)
    })
    .await
    .map_err(|e| format!("Profile delete task failed: {e}"))?
}

#[tauri::command]
pub async fn delete_config(app: AppHandle, name: String) -> Result<String, String> {
    let paths = ensure_app_storage(&app)?;

    // Ensure the name has a .yaml/.yml extension. The check is
    // case-insensitive: `Foo.YAML` is already a YAML file, and appending
    // `.yaml` to it would make the file undeletable (neither the primary
    // `Foo.YAML.yaml` nor any fallback would ever match it).
    let lower_name = name.to_lowercase();
    let mut clean_name = if lower_name.ends_with(".yaml") || lower_name.ends_with(".yml") {
        name.clone()
    } else {
        format!("{name}.yaml")
    };

    clean_name = sanitize_config_file_name(clean_name).map_err(|e| e.to_string())?;

    let target_path = paths.profiles_dir.join(&clean_name);
    validate_path_within_dir(&target_path, &paths.profiles_dir).map_err(|e| e.to_string())?;

    let file_exists = target_path.exists();

    if !file_exists {
        // Try with .yml extension as well. Build the fallback from the
        // sanitized name, not the raw input, and validate it like the
        // primary path: the raw name can carry a drive-relative or
        // otherwise escaping path that `join` would keep.
        let yml_name = yml_fallback_name(&clean_name);
        let yml_path = paths.profiles_dir.join(&yml_name);
        validate_path_within_dir(&yml_path, &paths.profiles_dir).map_err(|e| e.to_string())?;

        if yml_path.exists() {
            // Use the on-disk spelling for metadata and last_config:
            // on a case-insensitive filesystem the request may differ
            // in case from the entry.
            let stored_yml = actual_entry_name(&paths.profiles_dir, &yml_name);
            // File removal, metadata cleanup, and selection cleanup in
            // one transform-guarded transaction (see
            // `delete_profile_file_transaction`).
            delete_profile_file_transaction(
                app.clone(),
                paths.clone(),
                yml_path,
                vec![stored_yml.clone(), yml_name.clone()],
                stored_yml,
            )
            .await?;
            return Ok(format!("Config {yml_name} deleted"));
        }
        return Err("File does not exist".to_owned());
    }

    // The on-disk spelling, for metadata and last_config: on a
    // case-insensitive filesystem the request may differ in case from
    // the entry. Resolve it before deleting, while the entry exists.
    let stored_name = actual_entry_name(&paths.profiles_dir, &clean_name);

    // The reserved name is the stored spelling: a case variant such as
    // `RUN_CONFIG.yaml` is an ordinary listed profile when that is how
    // it is stored (creation and listing both treat only the exact
    // `run_config.yaml` as reserved), while the runtime config's own
    // spelling stays protected.
    if is_reserved_config_name(&stored_name) {
        return Err("Cannot delete the active temp config".to_owned());
    }

    // File removal, metadata cleanup, and selection cleanup in one
    // transform-guarded transaction: if file deletion fails, metadata
    // stays intact. The request spelling is listed too: metadata can
    // be keyed under the spelling it was stored with, which may differ
    // in case from the file on disk, and the original name in case it
    // was stored with a different key.
    delete_profile_file_transaction(
        app,
        paths.clone(),
        target_path,
        vec![stored_name.clone(), clean_name.clone(), name.clone()],
        stored_name,
    )
    .await?;

    Ok(format!("Config {name} deleted"))
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn read_config_file(app: AppHandle, config_path: String) -> Result<String, String> {
    let paths = ensure_app_storage(&app)?;
    let config_file_name = sanitize_config_file_name(config_path).map_err(|e| e.to_string())?;
    let (resolved_path, base_dir) = if config_file_name == "run_config.yaml" {
        (
            paths.core_dir.join(&config_file_name),
            paths.core_dir.clone(),
        )
    } else {
        (
            paths.profiles_dir.join(&config_file_name),
            paths.profiles_dir.clone(),
        )
    };

    validate_path_within_dir(&resolved_path, &base_dir).map_err(|e| e.to_string())?;

    if !resolved_path.exists() {
        return Err("Config file not found".to_owned());
    }

    // run_config.yaml is always plaintext; profile files may be encrypted
    if config_file_name == "run_config.yaml" {
        fs::read_to_string(&resolved_path).map_err(|e| format!("Failed to read config: {e}"))
    } else {
        read_profile_file(&resolved_path)
    }
}

/// Async so Tauri does not run it on the main thread: a profile save waits for
/// the profile-transform guard, which an encryption batch holds while it
/// rewrites every profile. The work runs on the blocking pool.
#[tauri::command]
pub async fn write_config_file(
    app: AppHandle,
    config_path: String,
    content: String,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            write_config_file_inner(app, config_path, content)
        }))
        .map_err(|payload| {
            let msg = crate::backend_event::panic_to_string(payload);
            crate::emit_error!(
                Config,
                CONFIG_PANIC_GUARD,
                "Panic in write_config_file: {msg}"
            );
            format!("Internal error in write_config_file: {msg}")
        })
        .and_then(std::convert::identity)
    })
    .await
    .map_err(|e| format!("Config save task failed: {e}"))?
}

/// Parse YAML config content and strip dangerous keys before it is written.
/// Returns the original text unchanged when nothing was removed, so
/// comments and formatting survive a clean save. Kept separate from
/// `write_config_file_inner` so the sanitize step itself is testable
/// without a running Tauri app.
fn sanitize_config_content(content: &str) -> Result<String, String> {
    let value: serde_yaml::Value =
        serde_yaml::from_str(content).map_err(|e| format!("Invalid YAML: {e}"))?;
    let mut sanitized = value.clone();
    zephyr_core::config::sanitizer::remove_dangerous_keys_internal_pub(&mut sanitized, false);
    if sanitized == value {
        Ok(content.to_owned())
    } else {
        let serialized = serde_yaml::to_string(&sanitized)
            .map_err(|e| format!("Failed to serialize sanitized YAML: {e}"))?;
        // Re-serialization drops comments, but the `# URL: ` / `# SUB_INFO: `
        // lines are functional subscription metadata for legacy profiles,
        // so carry them over when the file had to be rewritten. Shared
        // with backup import so the two paths cannot drift apart.
        Ok(crate::backup::preserve_subscription_comments(
            content, serialized,
        ))
    }
}

#[allow(clippy::needless_pass_by_value)]
fn write_config_file_inner(
    app: AppHandle,
    config_path: String,
    content: String,
) -> Result<String, String> {
    let paths = ensure_app_storage(&app)?;
    let config_file_name = sanitize_config_file_name(config_path).map_err(|e| e.to_string())?;
    let (resolved_path, base_dir) = if config_file_name == "run_config.yaml" {
        (
            paths.core_dir.join(&config_file_name),
            paths.core_dir.clone(),
        )
    } else {
        (
            paths.profiles_dir.join(&config_file_name),
            paths.profiles_dir.clone(),
        )
    };

    validate_path_within_dir(&resolved_path, &base_dir).map_err(|e| e.to_string())?;

    // Parse and sanitize YAML content before writing to disk
    let final_content = sanitize_config_content(&content)?;

    // run_config.yaml is always plaintext; profile files may be encrypted
    if config_file_name == "run_config.yaml" {
        write_file_secure(&resolved_path, &final_content)?;
    } else {
        // Reading the flag and writing the file under the same guard is what
        // makes the save safe: `patch_settings`' encryption batch holds this
        // lock while it rewrites every profile, so without it a save could land
        // between the batch's read of this file and its write of it, and the
        // batch would then overwrite the saved content with its stale copy.
        //
        // Taken *before* the settings lock, matching `patch_settings`, which
        // reads the authoritative value under that lock while holding this one.
        // The reverse order would deadlock the two.
        save_profile_file(&app, &resolved_path, &final_content)?;
    }

    Ok("Config saved".to_owned())
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn open_config_folder(app: AppHandle) -> Result<String, String> {
    let paths = ensure_app_storage(&app)?;
    let target = paths.profiles_dir;

    tauri_plugin_opener::open_path(&target, None::<&str>)
        .map_err(|e| format!("Failed to open config folder: {e}"))?;

    Ok(target.to_string_lossy().into_owned())
}

/// Async for the same reason as [`write_config_file`]: the rename waits for the
/// profile-transform guard, so it runs on the blocking pool, not the main thread.
#[tauri::command]
pub async fn rename_config(
    app: AppHandle,
    old_name: String,
    new_name: String,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || rename_config_blocking(app, old_name, new_name))
        .await
        .map_err(|e| format!("Config rename task failed: {e}"))?
}

#[allow(clippy::needless_pass_by_value)]
fn rename_config_blocking(
    app: AppHandle,
    old_name: String,
    new_name: String,
) -> Result<String, String> {
    let paths = ensure_app_storage(&app)?;

    // Sanitize old name
    let lower_old = old_name.to_lowercase();
    let mut clean_old = if lower_old.ends_with(".yaml") || lower_old.ends_with(".yml") {
        old_name.clone()
    } else {
        format!("{old_name}.yaml")
    };
    clean_old = sanitize_config_file_name(clean_old).map_err(|e| e.to_string())?;
    if clean_old == "run_config.yaml" {
        return Err("Cannot rename the active temp config".to_owned());
    }

    // Sanitize new name
    let lower_new = new_name.to_lowercase();
    let mut clean_new = if lower_new.ends_with(".yaml") || lower_new.ends_with(".yml") {
        new_name
    } else {
        format!("{new_name}.yaml")
    };
    clean_new = sanitize_config_file_name(clean_new).map_err(|e| e.to_string())?;
    if clean_new == "run_config.yaml" {
        return Err("Cannot use reserved name 'run_config'".to_owned());
    }

    let old_path = paths.profiles_dir.join(&clean_old);
    let new_path = paths.profiles_dir.join(&clean_new);
    validate_path_within_dir(&old_path, &paths.profiles_dir).map_err(|e| e.to_string())?;
    validate_path_within_dir(&new_path, &paths.profiles_dir).map_err(|e| e.to_string())?;

    if !old_path.exists() {
        return Err(format!("Config '{clean_old}' does not exist"));
    }
    if clean_old == clean_new {
        return Err("New name is the same as the current name".to_owned());
    }
    if new_path.exists() {
        return Err(format!("A config named '{clean_new}' already exists"));
    }

    // Rename file + update metadata under lock to prevent cleanup_metadata_cache
    // from removing the metadata entry while the file is temporarily absent.
    {
        // The encryption batch rewrites every profile it read, so a rename that
        // lands between its read and write would leave a stale copy at the old
        // name. Taken before the metadata lock, matching the profile writers.
        let _transform_guard = crate::lock_profile_transform();
        let _guard = lock_metadata();
        // Re-validate under lock: a concurrent command may have created new_path
        // between the pre-lock check and here.
        if new_path.exists() {
            return Err(format!("A config named '{clean_new}' already exists"));
        }
        std::fs::rename(&old_path, &new_path)
            .map_err(|e| format!("Failed to rename config: {e}"))?;
        let mut metadata = load_metadata(&paths);
        if let Some(meta) = metadata.configs.remove(&clean_old) {
            metadata.configs.insert(clean_new.clone(), meta);
        }
        // Also try original name in case metadata was stored differently
        if old_name != clean_old {
            if let Some(meta) = metadata.configs.remove(&old_name) {
                metadata.configs.insert(clean_new.clone(), meta);
            }
        }
        if let Err(e) = save_metadata(&paths, &metadata) {
            // Rollback: rename file back to old path
            if let Err(rn_err) = std::fs::rename(&new_path, &old_path) {
                emit_warn!(
                    Config,
                    CONFIG_PERSIST_FAILED,
                    "Rollback: failed to rename {clean_new} back to {clean_old}: {rn_err}"
                );
            }
            return Err(format!("Failed to save metadata: {e}"));
        }
    }

    // Update last_config setting if it references the old name
    // Also migrate last_proxy_selection key from old name to new name
    let mut last_config_updated = false;
    {
        let state = app.state::<crate::SettingsState>();
        let mut guard = state
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut dirty = false;

        // Update last_config if it references the old name
        if guard.last_config.as_deref() == Some(&clean_old)
            || guard.last_config.as_deref() == Some(&old_name)
        {
            guard.last_config = Some(clean_new.clone());
            dirty = true;
            last_config_updated = true;
        }

        // Migrate proxy selection key
        let node_to_migrate = guard.last_proxy_selection.remove(&clean_old).or_else(|| {
            if old_name != clean_old {
                guard.last_proxy_selection.remove(&old_name)
            } else {
                None
            }
        });
        if let Some(node) = node_to_migrate {
            guard.last_proxy_selection.insert(clean_new.clone(), node);
            dirty = true;
        }

        // Migrate primary group preference key
        let group_to_migrate = guard
            .primary_group_preference
            .remove(&clean_old)
            .or_else(|| {
                if old_name != clean_old {
                    guard.primary_group_preference.remove(&old_name)
                } else {
                    None
                }
            });
        if let Some(group) = group_to_migrate {
            guard
                .primary_group_preference
                .insert(clean_new.clone(), group);
            dirty = true;
        }

        // Persist under the lock: a snapshot written after releasing it could
        // land after a newer one and revert it on disk. Memory keeps the
        // migrated keys even if the write fails, since the file is renamed.
        if dirty {
            if let Err(e) = crate::persist_settings(&app, &guard) {
                emit_error!(
                    Config,
                    CONFIG_SAVE_FAILED,
                    "Failed to persist settings: {e}"
                );
            }
        }
        drop(guard);
    }

    // Sync runtime MihomoState.last_config_path
    if last_config_updated {
        let mihomo = app.state::<MihomoState>();
        if let Ok(mut guard) = mihomo.0.lock() {
            guard.set_last_config_path(Some(clean_new.clone()));
        };
    }

    // The callers use the result as the new file name (sanitised, with extension).
    Ok(clean_new)
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    // ── mask_url tests ─────────────────────────────────────────────────────

    #[test]
    fn test_mask_long_domain() {
        let result =
            mask_url("https://very-long-domain-name.example.com/path/to/config?token=secret");
        assert!(result.contains("***"));
        assert!(!result.contains("very-long-domain-name"));
        assert!(!result.contains("secret"));
    }

    #[test]
    fn test_mask_short_domain() {
        let result = mask_url("https://ab.cd/path");
        assert!(result.contains("***"));
    }

    #[test]
    fn test_mask_invalid_url() {
        let result = mask_url("not-a-url");
        assert_eq!(result, "***");
    }

    #[test]
    fn test_mask_ip_url() {
        let result = mask_url("http://192.168.1.1:7890/api");
        assert!(result.contains("***"));
    }

    #[test]
    fn test_mask_preserves_scheme() {
        let result = mask_url("https://example.com/path");
        assert!(result.starts_with("https://"));
    }

    #[test]
    fn test_mask_http_scheme() {
        let result = mask_url("http://example.com/path");
        assert!(result.starts_with("http://"));
    }

    #[test]
    fn test_mask_hides_path_and_query() {
        let result = mask_url("https://example.com/secret/path?token=abc123");
        assert!(!result.contains("/secret/path"));
        assert!(!result.contains("token=abc123"));
        assert!(result.ends_with("/***"));
    }

    // ── dangerous_keys tests ───────────────────────────────────────────────

    #[test]
    fn test_top_level_script_removed() {
        let yaml = "script: test.js\nport: 7890";
        let mut value: serde_yaml::Value = serde_yaml::from_str(yaml).unwrap();
        zephyr_core::config::sanitizer::remove_dangerous_keys_internal_pub(&mut value, false);
        assert!(!value
            .as_mapping()
            .unwrap()
            .contains_key(serde_yaml::Value::String("script".to_owned())));
        assert!(value
            .as_mapping()
            .unwrap()
            .contains_key(serde_yaml::Value::String("port".to_owned())));
    }

    #[test]
    fn test_nested_script_in_proxy_group_removed() {
        let yaml = r"
proxy-groups:
  - name: test
    type: select
    script: malicious.js
    proxies:
      - proxy1
";
        let mut value: serde_yaml::Value = serde_yaml::from_str(yaml).unwrap();
        zephyr_core::config::sanitizer::remove_dangerous_keys_internal_pub(&mut value, false);

        let groups = value.get("proxy-groups").unwrap().as_sequence().unwrap();
        let group = groups.first().unwrap().as_mapping().unwrap();
        assert!(!group.contains_key(serde_yaml::Value::String("script".to_owned())));
        assert!(group.contains_key(serde_yaml::Value::String("name".to_owned())));
    }

    #[test]
    fn test_provider_path_removed() {
        let yaml = r"
proxy-providers:
  my-provider:
    type: http
    url: https://example.com/proxies.yaml
    path: /etc/passwd
    interval: 3600
";
        let mut value: serde_yaml::Value = serde_yaml::from_str(yaml).unwrap();
        zephyr_core::config::sanitizer::remove_dangerous_keys_internal_pub(&mut value, false);

        let providers = value.get("proxy-providers").unwrap().as_mapping().unwrap();
        let provider = providers
            .get(serde_yaml::Value::String("my-provider".to_owned()))
            .unwrap()
            .as_mapping()
            .unwrap();
        assert!(!provider.contains_key(serde_yaml::Value::String("path".to_owned())));
        assert!(provider.contains_key(serde_yaml::Value::String("type".to_owned())));
    }

    #[test]
    fn test_non_provider_path_preserved() {
        let yaml = r#"
tun:
  enable: false
  stack: system
  dns-hijack:
    - any:53
    - tcp://any:53
proxies:
  - name: "test"
    type: ss
    server: 127.0.0.1
    port: 8388
"#;
        let mut value: serde_yaml::Value = serde_yaml::from_str(yaml).unwrap();
        zephyr_core::config::sanitizer::remove_dangerous_keys_internal_pub(&mut value, false);

        let proxies = value.get("proxies").unwrap().as_sequence().unwrap();
        let proxy = proxies.first().unwrap().as_mapping().unwrap();
        assert!(proxy.contains_key(serde_yaml::Value::String("port".to_owned())));
    }

    #[test]
    fn test_deeply_nested_script_removed() {
        let yaml = r#"
rules:
  - SCRIPT,test.js,DIRECT
  - MATCH,PROXY
script:
  code: |
    function main() { return "malicious" }
"#;
        let mut value: serde_yaml::Value = serde_yaml::from_str(yaml).unwrap();
        zephyr_core::config::sanitizer::remove_dangerous_keys_internal_pub(&mut value, false);

        assert!(!value
            .as_mapping()
            .unwrap()
            .contains_key(serde_yaml::Value::String("script".to_owned())));
    }

    #[test]
    fn test_script_path_removed() {
        let yaml = r"
script-path: /malicious/script.js
mode: rule
";
        let mut value: serde_yaml::Value = serde_yaml::from_str(yaml).unwrap();
        zephyr_core::config::sanitizer::remove_dangerous_keys_internal_pub(&mut value, false);

        assert!(!value
            .as_mapping()
            .unwrap()
            .contains_key(serde_yaml::Value::String("script-path".to_owned())));
    }

    #[test]
    fn test_provider_without_path_preserved() {
        let yaml = r"
rule-providers:
  my-rules:
    type: http
    url: https://example.com/rules.yaml
    interval: 86400
";
        let mut value: serde_yaml::Value = serde_yaml::from_str(yaml).unwrap();
        zephyr_core::config::sanitizer::remove_dangerous_keys_internal_pub(&mut value, false);

        let providers = value.get("rule-providers").unwrap().as_mapping().unwrap();
        assert!(providers.contains_key(serde_yaml::Value::String("my-rules".to_owned())));
    }

    #[test]
    fn test_write_config_file_sanitizes_yaml_content() {
        let dirty_yaml = r"
script: evil.js
external-controller-unix: /tmp/evil.sock
proxy-providers:
  p:
    type: http
    url: https://example.com/p.yaml
    path: /etc/passwd
port: 7890
";
        let sanitized_str = sanitize_config_content(dirty_yaml).expect("valid YAML");
        assert!(!sanitized_str.contains("evil.js"));
        assert!(!sanitized_str.contains("/tmp/evil.sock"));
        assert!(!sanitized_str.contains("/etc/passwd"));
        assert!(sanitized_str.contains("7890"));
    }

    #[test]
    fn test_write_config_file_rejects_invalid_yaml() {
        let invalid_yaml = "rules: [unclosed sequence";
        assert!(sanitize_config_content(invalid_yaml).is_err());
    }

    #[test]
    fn test_write_config_file_keeps_clean_content_untouched() {
        let clean_yaml = "# subscription: https://example.com/sub.yaml\nport: 7890\n";
        assert_eq!(
            sanitize_config_content(clean_yaml).expect("valid YAML"),
            clean_yaml
        );
    }

    #[test]
    fn test_write_config_file_keeps_subscription_url_when_sanitizing() {
        let dirty_yaml = "# URL: https://example.com/sub.yaml\n# SUB_INFO: upload=0\nscript: evil.js\nport: 7890\n";
        let out = sanitize_config_content(dirty_yaml).expect("valid YAML");
        assert!(!out.contains("evil.js"));
        assert!(out.contains("# URL: https://example.com/sub.yaml"));
        assert!(out.contains("# SUB_INFO: upload=0"));
        assert!(out.contains("7890"));
    }

    // ── yml_fallback_name tests ────────────────────────────────────────────

    #[test]
    fn test_yml_fallback_swaps_trailing_yaml_only() {
        assert_eq!(yml_fallback_name("foo.yaml"), "foo.yml");
        assert_eq!(yml_fallback_name("Foo.YAML"), "Foo.yml");
        // Not a trailing .yaml: left alone, never a different file.
        assert_eq!(yml_fallback_name("team.yaml.backup"), "team.yaml.backup");
        assert_eq!(yml_fallback_name("foo.yml"), "foo.yml");
    }

    #[test]
    fn test_yml_fallback_unicode_names_do_not_panic() {
        // A missing `é.yml` / `中.yml` used to panic: slicing five bytes
        // back lands inside the multibyte character. Now it is simply
        // not a `.yaml` name and comes back unchanged.
        assert_eq!(yml_fallback_name("é.yml"), "é.yml");
        assert_eq!(yml_fallback_name("中.yml"), "中.yml");
        assert_eq!(yml_fallback_name("é.yaml"), "é.yml");
    }

    // ── actual_entry_name tests ────────────────────────────────────────────

    #[test]
    fn test_actual_entry_name_keeps_stored_spelling() {
        let unique = format!("zephyr_test_entry_name_{}", std::process::id());
        let dir = std::env::temp_dir().join(&unique);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("foo.yaml"), "port: 7890\n").unwrap();

        // A differently-cased request resolves to the stored spelling,
        // so metadata removal and last_config cleanup match the entry.
        assert_eq!(actual_entry_name(&dir, "FOO.YAML"), "foo.yaml");
        assert_eq!(actual_entry_name(&dir, "foo.yaml"), "foo.yaml");
        // A missing entry comes back as requested.
        assert_eq!(actual_entry_name(&dir, "missing.yaml"), "missing.yaml");

        // Unicode case folding, not ASCII only: on a case-insensitive
        // volume `É.YAML` and `é.YAML` are the same file.
        std::fs::write(dir.join("é.YAML"), "port: 7892\n").unwrap();
        assert_eq!(actual_entry_name(&dir, "É.YAML"), "é.YAML");

        // On a case-sensitive filesystem both casings can coexist: the
        // exact match must win, or deleting one would clear the other's
        // metadata. On a case-insensitive filesystem the second write
        // lands on the same file, so only check coexistence when both
        // entries are really there.
        std::fs::write(dir.join("Foo.yaml"), "port: 7891\n").unwrap();
        let entries: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        if entries.iter().any(|n| n == "foo.yaml") && entries.iter().any(|n| n == "Foo.yaml") {
            assert_eq!(actual_entry_name(&dir, "Foo.yaml"), "Foo.yaml");
            assert_eq!(actual_entry_name(&dir, "foo.yaml"), "foo.yaml");
            // With no exact match (`FOO.YAML`), either stored spelling is
            // a valid answer; read_dir order decides, so don't pin it.
            assert!(matches!(
                actual_entry_name(&dir, "FOO.YAML").as_str(),
                "foo.yaml" | "Foo.yaml"
            ));
        }

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_is_reserved_config_name_exact_only() {
        assert!(is_reserved_config_name("run_config.yaml"));
        assert!(!is_reserved_config_name("RUN_CONFIG.yaml"));
        assert!(!is_reserved_config_name("Run_Config.yaml"));
        assert!(!is_reserved_config_name("run_config.yml"));
        assert!(!is_reserved_config_name("my-run_config.yaml"));
        assert!(!is_reserved_config_name(""));
    }

    #[test]
    fn test_is_same_config_name_extensionless_survivor() {
        let unique = format!("zephyr_test_same_config_{}", std::process::id());
        let dir = std::env::temp_dir().join(&unique);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("foo.yaml"), "port: 7890\n").unwrap();
        // An extensionless `foo` selects `foo.yaml`, which survives the
        // deletion of the distinct `FOO.yaml`: the reference is not
        // dangling. The old check stat'ed the raw `foo` (no extension)
        // and would have reset it anyway.
        assert!(!is_same_config_name(&dir, "foo", "FOO.yaml"));
        // Once `foo.yaml` is gone too, the reference is dangling.
        std::fs::remove_file(dir.join("foo.yaml")).unwrap();
        assert!(is_same_config_name(&dir, "foo", "FOO.yaml"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_is_same_config_name_surviving_sibling_and_recreation() {
        let unique = format!("zephyr_test_same_config_sib_{}", std::process::id());
        let dir = std::env::temp_dir().join(&unique);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("foo.yaml"), "port: 7890\n").unwrap();
        std::fs::write(dir.join("foo.yml"), "port: 7891\n").unwrap();
        // Same stem, different extension: deleting `foo.yml` must not
        // reset a selection pointing at the surviving `foo.yaml`.
        assert!(!is_same_config_name(&dir, "foo.yaml", "foo.yml"));
        assert!(!is_same_config_name(&dir, "foo.yml", "foo.yaml"));
        // Once the sibling is gone too, the reference is dangling.
        std::fs::remove_file(dir.join("foo.yaml")).unwrap();
        assert!(is_same_config_name(&dir, "foo.yaml", "foo.yml"));
        // An exact match counts only while the file is really gone: a
        // concurrent save may have recreated it after the deletion.
        std::fs::write(dir.join("foo.yml"), "port: 7891\n").unwrap();
        assert!(!is_same_config_name(&dir, "foo.yml", "foo.yml"));
        std::fs::remove_file(dir.join("foo.yml")).unwrap();
        assert!(is_same_config_name(&dir, "foo.yml", "foo.yml"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_remove_deleted_metadata_keeps_surviving_case_variant() {
        let unique = format!("zephyr_test_del_meta_{}", std::process::id());
        let dir = std::env::temp_dir().join(&unique);
        std::fs::create_dir_all(&dir).unwrap();
        // `foo.yaml` is the deleted file (absent); `FOO.yaml` survives
        // as a distinct file on a case-sensitive filesystem; `bar.yaml`
        // is unrelated.
        std::fs::write(dir.join("FOO.yaml"), "port: 7890\n").unwrap();
        std::fs::write(dir.join("bar.yaml"), "port: 7891\n").unwrap();
        std::fs::write(
            dir.join("metadata.json"),
            r#"{"configs": {"foo.yaml": {"url": "https://example.com/a"}, "FOO.yaml": {"url": "https://example.com/b"}, "bar.yaml": {}}}"#,
        )
        .unwrap();
        let paths = crate::core_manager::AppPaths {
            app_data_dir: dir.clone(),
            core_dir: dir.clone(),
            profiles_dir: dir.clone(),
        };
        remove_deleted_metadata(&paths, &["foo.yaml".to_owned()]).unwrap();
        let meta = load_metadata(&paths);
        assert!(!meta.configs.contains_key("foo.yaml"));
        assert!(meta.configs.contains_key("FOO.yaml"));
        assert!(meta.configs.contains_key("bar.yaml"));

        // Alias case: a differently-cased key whose file is gone names
        // the deleted file and goes too. Remove the surviving `FOO.yaml`
        // first: on a case-insensitive volume `Foo.yaml` resolves to
        // it, so the key would (correctly) be kept while the file lives.
        std::fs::remove_file(dir.join("FOO.yaml")).unwrap();
        std::fs::write(
            dir.join("metadata.json"),
            r#"{"configs": {"foo.yaml": {}, "Foo.yaml": {}}}"#,
        )
        .unwrap();
        remove_deleted_metadata(&paths, &["foo.yaml".to_owned()]).unwrap();
        let meta = load_metadata(&paths);
        assert!(!meta.configs.contains_key("foo.yaml"));
        assert!(!meta.configs.contains_key("Foo.yaml"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    // Normalization-insensitive volumes only (macOS): a composed
    // request resolves to a decomposed stored spelling. On Linux the
    // two forms are distinct files, so this cannot be exercised there.
    #[test]
    #[cfg(target_os = "macos")]
    fn test_actual_entry_name_unicode_normalization() {
        let unique = format!("zephyr_test_entry_norm_{}", std::process::id());
        let dir = std::env::temp_dir().join(&unique);
        std::fs::create_dir_all(&dir).unwrap();
        // Stored decomposed (e + combining acute), requested composed (é).
        let decomposed = "e\u{301}.yaml";
        let composed = "\u{e9}.yaml";
        std::fs::write(dir.join(decomposed), "port: 7890\n").unwrap();
        assert_eq!(actual_entry_name(&dir, composed), decomposed);

        let _ = std::fs::remove_dir_all(&dir);
    }
}

// ── Log Folder & Export ──────────────────────────────────────────────────────

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn open_log_folder(app: AppHandle) -> Result<String, String> {
    let paths = ensure_app_storage(&app)?;
    let logs_dir = paths.app_data_dir.join("logs");
    fs::create_dir_all(&logs_dir).map_err(|e| format!("Failed to create logs dir: {e}"))?;

    tauri_plugin_opener::open_path(&logs_dir, None::<&str>)
        .map_err(|e| format!("Failed to open log folder: {e}"))?;

    Ok(logs_dir.to_string_lossy().into_owned())
}

/// Check whether `haystack` contains `needle` using byte-slice windows search.
/// Zero-allocation alternative to `str::contains()` for `&[u8]` data.
fn contains_bytes(haystack: &[u8], needle: &[u8]) -> bool {
    if needle.is_empty() || needle.len() > haystack.len() {
        return false;
    }
    haystack.windows(needle.len()).any(|w| w == needle)
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub async fn export_logs(
    app: AppHandle,
    log_type: String,
    from_date: String,
    to_date: String,
    level: Option<String>,
) -> Result<String, String> {
    let paths = ensure_app_storage(&app)?;
    let logs_base = paths.app_data_dir.join("logs");

    // Collect files based on log_type
    let mut files_to_export: Vec<(String, PathBuf)> = Vec::new(); // (relative_path, absolute_path)

    let mut dirs_to_check = Vec::new();
    if log_type == "app" || log_type == "all" {
        dirs_to_check.push("app");
    }
    if log_type == "core" || log_type == "all" {
        dirs_to_check.push("core");
    }

    for subdir in dirs_to_check {
        let dir = logs_base.join(subdir);
        for path in super::log_writer::collect_log_files(&dir, &from_date, &to_date) {
            let name = path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned();
            files_to_export.push((format!("{subdir}/{name}"), path));
        }
    }

    if files_to_export.is_empty() {
        return Err("No log files found for the selected date range".to_owned());
    }

    // Use dialog to pick save location (async via oneshot channel)
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .add_filter("ZIP", &["zip"])
        .set_file_name("zephyr-logs.zip")
        .save_file(move |path| {
            let _ = tx.send(path);
        });
    let file_path = rx
        .await
        .map_err(|_e| "Dialog cancelled".to_owned())?
        .ok_or_else(|| "Export cancelled".to_owned())?;

    let save_path = file_path
        .as_path()
        .ok_or_else(|| "Invalid save path".to_owned())?
        .to_path_buf();

    // Run heavy zip creation on a dedicated blocking thread
    let level_clone = level.clone();
    tokio::task::spawn_blocking(move || -> Result<String, String> {
        use std::io::Write as _;
        use zip::write::SimpleFileOptions;

        let zip_file =
            File::create(&save_path).map_err(|e| format!("Failed to create zip file: {e}"))?;
        let mut zip_writer = zip::ZipWriter::new(zip_file);
        let zip_options =
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);

        for (relative_path, abs_path) in &files_to_export {
            zip_writer
                .start_file(relative_path.as_str(), zip_options)
                .map_err(|e| format!("Failed to add file to zip: {e}"))?;

            let mut file = File::open(abs_path)
                .map_err(|e| format!("Failed to open log file {abs_path:?}: {e}"))?;

            if let Some(lvl) = &level_clone {
                let lvl_lower = lvl.to_lowercase();
                if lvl_lower.is_empty() || lvl_lower == "all" {
                    std::io::copy(&mut file, &mut zip_writer)
                        .map_err(|e| format!("Failed to copy log file to zip: {e}"))?;
                } else {
                    use std::io::BufRead as _;
                    let mut reader = std::io::BufReader::new(file);
                    let mut buf = Vec::new();
                    let mut lower_buf = Vec::new();
                    // Track whether the current multi-line log entry matched the filter.
                    // Continuation lines (no severity marker) follow their parent entry.
                    let mut current_entry_matched = false;
                    while reader
                        .read_until(b'\n', &mut buf)
                        .map_err(|e| format!("Failed to read line: {e}"))?
                        > 0
                    {
                        // Zero-allocation severity matching: reuse a single buffer,
                        // fill with ASCII-lowercased bytes, then byte-slice windows search.
                        // Search the full line — lower_buf is reused across iterations so
                        // capacity stabilizes quickly with no extra heap allocations.
                        lower_buf.clear();
                        lower_buf.extend(buf.iter().map(u8::to_ascii_lowercase));
                        let search_buf = &lower_buf;

                        // Match severity in three formats:
                        //   plaintext: [fatal], [error], etc.
                        //   logfmt:    level=fatal, level=error, etc.
                        //   JSON:      "level":"fatal", "level": "error", etc.
                        let is_fatal = contains_bytes(search_buf, b"[fatal]")
                            || contains_bytes(search_buf, b"level=fatal")
                            || contains_bytes(search_buf, b"\"level\":\"fatal\"")
                            || contains_bytes(search_buf, b"\"level\": \"fatal\"");
                        let is_error = contains_bytes(search_buf, b"[error]")
                            || contains_bytes(search_buf, b"level=error")
                            || contains_bytes(search_buf, b"\"level\":\"error\"")
                            || contains_bytes(search_buf, b"\"level\": \"error\"");
                        let is_warn = contains_bytes(search_buf, b"[warn]")
                            || contains_bytes(search_buf, b"level=warn")
                            || contains_bytes(search_buf, b"[warning]")
                            || contains_bytes(search_buf, b"level=warning")
                            || contains_bytes(search_buf, b"\"level\":\"warn\"")
                            || contains_bytes(search_buf, b"\"level\": \"warn\"")
                            || contains_bytes(search_buf, b"\"level\":\"warning\"")
                            || contains_bytes(search_buf, b"\"level\": \"warning\"");
                        let is_info = contains_bytes(search_buf, b"[info]")
                            || contains_bytes(search_buf, b"level=info")
                            || contains_bytes(search_buf, b"\"level\":\"info\"")
                            || contains_bytes(search_buf, b"\"level\": \"info\"");
                        let is_debug = contains_bytes(search_buf, b"[debug]")
                            || contains_bytes(search_buf, b"level=debug")
                            || contains_bytes(search_buf, b"\"level\":\"debug\"")
                            || contains_bytes(search_buf, b"\"level\": \"debug\"");
                        let is_trace = contains_bytes(search_buf, b"[trace]")
                            || contains_bytes(search_buf, b"level=trace")
                            || contains_bytes(search_buf, b"\"level\":\"trace\"")
                            || contains_bytes(search_buf, b"\"level\": \"trace\"");

                        // Determine if this line is a new log entry (has any severity marker)
                        // or a continuation line (stack trace, multi-line payload, etc.)
                        let is_new_entry =
                            is_fatal || is_error || is_warn || is_info || is_debug || is_trace;

                        if is_new_entry {
                            current_entry_matched = match lvl_lower.as_str() {
                                "fatal" => is_fatal,
                                "error" => is_fatal || is_error,
                                "warn" => is_fatal || is_error || is_warn,
                                "info" => is_fatal || is_error || is_warn || is_info,
                                "debug" => is_fatal || is_error || is_warn || is_info || is_debug,
                                _ => true,
                            };
                        }
                        // else: continuation line — keep current_entry_matched from parent

                        if current_entry_matched {
                            zip_writer
                                .write_all(&buf)
                                .map_err(|e| format!("Failed to write line to zip: {e}"))?;
                        }
                        buf.clear();
                    }
                }
            } else {
                std::io::copy(&mut file, &mut zip_writer)
                    .map_err(|e| format!("Failed to copy log file to zip: {e}"))?;
            }
        }

        zip_writer
            .finish()
            .map_err(|e| format!("Failed to finalize zip: {e}"))?;

        Ok(save_path.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| format!("Export task panicked: {e}"))?
}
