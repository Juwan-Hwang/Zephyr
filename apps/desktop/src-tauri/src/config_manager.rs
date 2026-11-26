//! Top-level config manager — Tauri commands for runtime config read/update.
//!
//! Pure logic ([`merge_yaml`], security settings, [`ConfigIo`]) is delegated to [`zephyr_core::config::merge`].
//! This module only contains Tauri-specific glue ([`AppHandle`], [`State`], reqwest hot-reload).

use crate::core_manager::ensure_app_storage;
use crate::core_manager::MihomoState;
#[allow(unused_imports)]
use crate::emit_warn;
use serde_json::Value as JsonValue;
use serde_yaml::Value as YamlValue;
use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{AppHandle, State};
use zephyr_core::config::sanitizer::remove_dangerous_keys_internal_pub as remove_dangerous_keys;

// Re-export pure functions from core crate
use zephyr_core::config::merge::{
    copy_inherited_mappings, merge_yaml, null_out_inherited, read_config_with_io,
    update_config_core, ConfigIo,
};

// Test-only imports (available via super::* in tests)
#[cfg(test)]
use zephyr_core::config::merge::{
    extract_security_settings, restore_security_settings, strip_secret_from_yaml, SecuritySettings,
};

// ── ConfigIo trait implementation for Tauri ────────────────────────────

/// Real filesystem implementation of `ConfigIo` for the desktop app.
pub(crate) struct RealConfigIo;

impl ConfigIo for RealConfigIo {
    fn read_to_string(&self, path: &Path) -> Result<String, String> {
        fs::read_to_string(path).map_err(|e| format!("Failed to read file: {e}"))
    }

    fn write_file(&self, path: &Path, content: &str) -> Result<(), String> {
        // Check the fully merged candidate before any runtime/profile write.
        // A settings port edit bypasses the startup injector's collision check.
        crate::speed_test::validate_diagnostic_ports(content)?;
        crate::core_manager::write_file_secure(path, content)
    }

    fn path_exists(&self, path: &Path) -> bool {
        path.exists()
    }
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn read_config(app: AppHandle) -> Result<JsonValue, String> {
    let paths = ensure_app_storage(&app)?;
    let run_config_path = paths.core_dir.join("run_config.yaml");
    read_config_with_io(&RealConfigIo, &run_config_path)
}

/// What happened to the original profile when a patch was saved.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProfileSave {
    /// No profile takes the patch: none is active, or it is the run config
    /// itself.
    NotNeeded,
    /// The profile was updated.
    Saved,
    /// The profile could not be updated; the patch only lives in the run
    /// config and is lost the next time the profile is loaded.
    Failed {
        /// The profile file name.
        profile: String,
        /// Why it was not updated.
        reason: String,
    },
}

/// Result of config update operation with detailed status
#[derive(Debug, serde::Serialize)]
pub struct ConfigUpdateResult {
    /// Whether every file that should take the patch was written: the run
    /// config and, when one is active, the original profile.
    pub files_saved: bool,
    /// Whether the run config was written (always true on `Ok`).
    pub run_config_saved: bool,
    /// Whether the original profile took the patch (true when none needed it).
    pub profile_saved: bool,
    /// Why the original profile was not updated, when it was not.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile_error: Option<String>,
    /// Whether the core hot reload succeeded
    pub hot_reload_success: bool,
    /// The reload reached the core but was not confirmed in time: it may
    /// still apply, so a failed reload is not certain.
    pub reload_unconfirmed: bool,
    /// Human-readable status message
    pub message: String,
}

/// Where the patch has to go besides the run config.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProfileTarget {
    /// No original profile: none is recorded, or it is the run config itself.
    NoProfile,
    /// The recorded profile's file is gone (deleted while its core runs).
    Missing(String),
    /// The recorded profile, at this path.
    Present {
        /// The profile file name.
        name: String,
        /// Its path in the profiles directory.
        path: std::path::PathBuf,
    },
}

/// The reason reported for a recorded profile whose file is gone.
pub const PROFILE_FILE_MISSING: &str = "its file no longer exists";

/// The error an update returns, with nothing saved, when the core runs
/// another profile than the one the caller checked the patch against.
pub const PROFILE_CHANGED_MEANWHILE: &str =
    "the running profile changed before the save; nothing was saved";

/// Whether an update checked against profile `expected` must be refused
/// because the core no longer runs that profile (`last_config_path`). An
/// empty `expected` (or the run config itself) means the caller checked it
/// with no profile running (the minimal config): it is refused once a
/// profile runs. A named one is refused once another profile runs, and also
/// when none is recorded (the minimal config after a failed start, or no
/// start yet): the patch would then reach no profile file, and the run
/// config it would reach is not the one it was checked against. With no
/// `expected` nothing is checked.
#[must_use]
pub fn profile_changed_meanwhile(expected: Option<&str>, last_config_path: Option<&str>) -> bool {
    let Some(checked) = expected else {
        return false;
    };
    let running = last_config_path.filter(|recorded| *recorded != "run_config.yaml");
    if checked.is_empty() || checked == "run_config.yaml" {
        running.is_some()
    } else {
        running != Some(checked)
    }
}

/// Find the original profile a patch also has to be written to.
#[must_use]
pub fn profile_target(last_config_path: Option<&str>, profiles_dir: &Path) -> ProfileTarget {
    match last_config_path {
        None | Some("run_config.yaml") => ProfileTarget::NoProfile,
        Some(name) => {
            let path = profiles_dir.join(name);
            if path.exists() {
                ProfileTarget::Present {
                    name: name.to_owned(),
                    path,
                }
            } else {
                ProfileTarget::Missing(name.to_owned())
            }
        }
    }
}

/// Merge `patch` into the profile `profile_name` (at `profile_path` when the
/// update read the recorded profile), under the profile-transform guard.
/// Blocking: it runs on the blocking pool, with the run-config lock held.
fn save_patch_to_profile(
    app: &AppHandle,
    profiles_dir: &Path,
    profile_name: String,
    profile_path: std::path::PathBuf,
    patch: &JsonValue,
) -> Result<ProfileSave, String> {
    let patch_yaml: YamlValue = serde_yaml::to_value(patch)
        .map_err(|e| format!("Failed to convert JSON patch to YAML: {e}"))?;
    // One read-modify-write under the profile-transform guard, so a
    // concurrent save or encryption batch cannot land in between;
    // the profile keeps its current encryption form. The guard is a
    // std mutex an encryption batch can hold for a while, so it is
    // waited for only so long: the start lock is held here.
    // The file is named again under the guard: a rename that moved
    // it (and the recorded path) meanwhile is followed, not reported
    // as a failed save.
    let resolve_app = app.clone();
    let owned_profiles_dir = profiles_dir.to_path_buf();
    let edited = crate::core_manager::update_profile_file_resolved_within(
        app,
        PROFILE_EDIT_WAIT,
        move || renamed_profile_path(&resolve_app, &owned_profiles_dir, profile_path),
        |profile_content| merge_patch_into_profile(profile_content, &patch_yaml),
    );
    Ok(match edited {
        Ok(true) => ProfileSave::Saved,
        Ok(false) => {
            emit_warn!(
                Config,
                CONFIG_PARSE_FAILED,
                "Profile {profile_name} was not updated: it could not be parsed or merged"
            );
            ProfileSave::Failed {
                profile: profile_name,
                reason: "it could not be parsed or merged".to_owned(),
            }
        }
        Err(e) => {
            emit_warn!(
                Config,
                CONFIG_PARSE_FAILED,
                "Failed to update profile {profile_name}: {e}"
            );
            ProfileSave::Failed {
                profile: profile_name,
                reason: e,
            }
        }
    })
}

/// The profile file an update edits, named again under the
/// profile-transform guard: the recorded profile then when its file is
/// there (a rename moves both under that guard), else the one named
/// before while its file is there; neither: the profile file is missing.
fn renamed_profile_path(
    app: &AppHandle,
    profiles_dir: &Path,
    named_before: std::path::PathBuf,
) -> Result<std::path::PathBuf, String> {
    // A poisoned state lock still holds the recorded profile: a panic
    // elsewhere does not block every later save.
    let recorded = tauri::Manager::state::<MihomoState>(app)
        .0
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .last_config_path()
        .map(String::from);
    match profile_target(recorded.as_deref(), profiles_dir) {
        ProfileTarget::Present { path, .. } => Ok(path),
        ProfileTarget::NoProfile | ProfileTarget::Missing(_) if named_before.exists() => {
            Ok(named_before)
        }
        ProfileTarget::NoProfile | ProfileTarget::Missing(_) => {
            Err(PROFILE_FILE_MISSING.to_owned())
        }
    }
}

/// Build the result of an update whose run config was written, from what
/// happened to the profile and to the hot reload. A profile that could not
/// take the patch is reported as such: the change is live (or will be after
/// a restart) but is lost the next time that profile is loaded. When the hot
/// reload failed too, a restart is no remedy: it rebuilds the run config from
/// that profile and drops the change, so the message asks for the profile to
/// be fixed and the change saved again instead.
#[must_use]
pub fn config_update_result(
    profile: &ProfileSave,
    hot_reload_success: bool,
    hot_reload_message: &str,
) -> ConfigUpdateResult {
    let reload_failure = if hot_reload_message.is_empty() {
        String::new()
    } else {
        format!("{hot_reload_message} - ")
    };
    // Starts a sentence when no reload message comes before it. After a
    // reload that may still apply, the message before it says so already.
    let core_did_not_reload = if hot_reload_message.is_empty() {
        "The core did not reload it"
    } else if hot_reload_message == reload_error_message(true) {
        "the core may not have reloaded it"
    } else {
        "the core did not reload it"
    };
    let (profile_saved, profile_error, message) = match profile {
        ProfileSave::Failed { profile, reason } => {
            let message = if hot_reload_success {
                format!(
                    "Changes applied. Run config saved, but profile {profile} could not be \
                     updated ({reason}); the change will be lost when that profile is loaded again."
                )
            } else {
                format!(
                    "Run config saved, but profile {profile} could not be updated ({reason}). \
                     {reload_failure}{core_did_not_reload}, and restarting the core would \
                     rebuild the run config from that profile and drop the change: fix the \
                     profile, then save the change again."
                )
            };
            (false, Some(reason.clone()), message)
        }
        ProfileSave::NotNeeded | ProfileSave::Saved => {
            let message = if hot_reload_success {
                "Configuration saved and applied successfully".to_owned()
            } else if hot_reload_message.is_empty() {
                "Configuration saved. Restart core to apply changes.".to_owned()
            } else {
                format!("Configuration saved. {reload_failure}restart core to apply changes.")
            };
            (true, None, message)
        }
    };
    ConfigUpdateResult {
        files_saved: profile_saved,
        run_config_saved: true,
        profile_saved,
        profile_error,
        hot_reload_success,
        reload_unconfirmed: false,
        message,
    }
}

/// YAML merge key: mihomo folds a `<<` source into the mapping holding it.
const YAML_MERGE_KEY: &str = "<<";

/// Deepest `<<` chain or patch nesting followed here; deeper input is
/// treated as having no such entry (lookups) or dropped (patches).
const MAX_MERGE_DEPTH: usize = 64;

/// The string a mapping key resolves to, looking through explicit YAML tags
/// (mihomo reads `!!str <<` as `<<`).
#[allow(clippy::wildcard_enum_match_arm)]
fn resolved_key(key: &YamlValue) -> Option<&str> {
    match key {
        YamlValue::String(s) => Some(s.as_str()),
        YamlValue::Tagged(tagged) => resolved_key(&tagged.value),
        _ => None,
    }
}

/// `name` in `value` once `<<` merge keys are resolved the way mihomo
/// resolves them: an explicit entry wins, then the merge sources in order (a
/// single mapping or a sequence of mappings, each possibly with its own `<<`).
#[allow(clippy::wildcard_enum_match_arm)]
pub(crate) fn merged_entry<'a>(
    value: &'a YamlValue,
    name: &str,
    depth: usize,
) -> Option<&'a YamlValue> {
    if depth > MAX_MERGE_DEPTH {
        return None;
    }
    match value {
        YamlValue::Mapping(map) => map
            .iter()
            .find(|(k, _)| resolved_key(k) == Some(name))
            .map(|(_, v)| v)
            .or_else(|| {
                map.iter()
                    .filter(|(k, _)| resolved_key(k) == Some(YAML_MERGE_KEY))
                    .find_map(|(_, source)| merged_entry(source, name, depth + 1))
            }),
        YamlValue::Sequence(seq) => seq
            .iter()
            .find_map(|item| merged_entry(item, name, depth + 1)),
        YamlValue::Tagged(tagged) => merged_entry(&tagged.value, name, depth + 1),
        _ => None,
    }
}

/// Whether a profile turns TUN on, counting values it inherits through `<<`.
fn profile_tun_enabled(profile: &YamlValue) -> bool {
    merged_entry(profile, "tun", 0)
        .and_then(|tun| merged_entry(tun, "enable", 0))
        .and_then(YamlValue::as_bool)
        .unwrap_or(false)
}

/// Drop every `<<` merge key from a patch, at any depth. A patch comes from
/// the app's own pages, which never send one; a merge source would let it
/// bring in values the guards below check only as plain entries. A patch
/// nested deeper than the limit is refused (false) rather than cut short.
#[allow(clippy::wildcard_enum_match_arm)]
#[must_use]
fn strip_merge_keys(value: &mut YamlValue, depth: usize) -> bool {
    if depth > MAX_MERGE_DEPTH {
        return false;
    }
    match value {
        YamlValue::Mapping(map) => {
            map.retain(|k, _| resolved_key(k) != Some(YAML_MERGE_KEY));
            map.iter_mut()
                .all(|(_, child)| strip_merge_keys(child, depth + 1))
        }
        YamlValue::Sequence(seq) => seq.iter_mut().all(|item| strip_merge_keys(item, depth + 1)),
        YamlValue::Tagged(tagged) => strip_merge_keys(&mut tagged.value, depth + 1),
        _ => true,
    }
}

/// Merge `patch` into a profile's YAML (`None` when the profile cannot be
/// parsed, the patch nests too deep, or the merge fails). A mapping the
/// profile inherits through `<<` keeps its inherited fields when the patch
/// adds to it. The profile is guarded the way the run config
/// is: a patch does not set its controller address or secret (every start
/// injects the app's own), carries no `<<` merge key at any depth (mihomo
/// would fold its contents in), and does not turn TUN on or off (also when
/// the profile inherits that setting through `<<`), which only the TUN
/// switch does; otherwise loading that profile later would start TUN on its
/// own, or without the TUN the run config keeps on.
#[must_use]
pub fn merge_patch_into_profile(profile_content: &str, patch: &YamlValue) -> Option<String> {
    // A patch that is not a mapping would replace the whole profile.
    if !matches!(patch, YamlValue::Mapping(_)) {
        return None;
    }
    let mut profile = serde_yaml::from_str::<YamlValue>(profile_content).ok()?;
    // Only a plain mapping takes the patch key by key: merging into anything
    // else would replace the whole profile with the patch. `is_mapping` looks
    // through a tag, so a tagged root (`!profile`) is matched out explicitly.
    if !matches!(profile, YamlValue::Mapping(_)) {
        return None;
    }
    let tun_on = profile_tun_enabled(&profile);
    let mut guarded = patch.clone();
    if !strip_merge_keys(&mut guarded, 0) {
        return None;
    }
    // Only the patch is sanitized: what the profile holds and the patch does
    // not touch is the user's own (a local rule provider's `path`, say) and
    // stays as it is, rather than being deleted by any settings save.
    remove_dangerous_keys(&mut guarded, false);
    // A patch comes from the frontend as JSON, so its keys are plain strings
    // (no YAML tags): the guards below match them by name.
    if let YamlValue::Mapping(map) = &mut guarded {
        map.remove("external-controller");
        map.remove("secret");
        // A provider entry in the patch carries no `path` at all: the
        // sanitizer only knows an entry as a provider by its `type`, and a
        // path-only entry merged into an existing provider would set that
        // provider's file path past it.
        for section in ["rule-providers", "proxy-providers"] {
            if let Some(YamlValue::Mapping(providers)) = map.get_mut(section) {
                for (_, provider) in providers.iter_mut() {
                    if let YamlValue::Mapping(entry) = provider {
                        entry.remove("path");
                    }
                }
            }
        }
        // Whichever way TUN is set, only the TUN switch changes it, as for
        // the run config: a patch's `enable` is dropped, and so is a null
        // `tun`, which would remove the whole section (bringing an inherited
        // `enable: true` into effect, or turning an enabled TUN off).
        let emptied = match map.get_mut("tun") {
            Some(YamlValue::Mapping(tun)) => {
                tun.remove("enable");
                tun.is_empty()
            }
            // Not a mapping (null, `false`, a string): it would replace
            // the profile's whole section.
            Some(_) => true,
            None => false,
        };
        if emptied {
            map.remove("tun");
        }
    }
    copy_inherited_mappings(&mut profile, &guarded, 0);
    merge_yaml(&mut profile, &guarded, 0).ok()?;
    null_out_inherited(&mut profile, &guarded, 0);
    // Checked on the result too: no patch may turn TUN on or off, whatever
    // path the merge took.
    if profile_tun_enabled(&profile) != tun_on {
        return None;
    }
    // Re-serializing drops comments; a legacy profile keeps its subscription
    // URL and info only in `# URL: ` / `# SUB_INFO: ` lines, so those stay.
    let serialized = serde_yaml::to_string(&profile).ok()?;
    Some(crate::backup::preserve_subscription_comments(
        profile_content,
        serialized,
    ))
}

/// How long the hot reload after a config update may take, the error body
/// included. The update holds the start lock until it ends, so a core that
/// accepts the connection but never answers (frozen after a sleep) cannot
/// keep every start, the recovery restart after a resume included, waiting.
/// Long enough for a reload that downloads an uncached provider or brings
/// TUN up again.
pub const CONFIG_RELOAD_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// Numbers each config update before it writes the run config (under the
/// start lock, so in the order the core gets their reloads): a late answer
/// to an older reload does not replace the listener a newer one recorded.
static RELOAD_REVISION: AtomicU64 = AtomicU64::new(0);
/// The reload whose listener was recorded last: an older one's late answer
/// does not replace it.
static ENDPOINT_REVISION: AtomicU64 = AtomicU64::new(0);

/// How long a config update waits for the profile-transform guard to write
/// the profile. It holds the start lock meanwhile, and an encryption batch
/// over many profiles can hold the guard for long: past this, the profile is
/// reported not saved (the run config and the core still take the patch).
pub const PROFILE_EDIT_WAIT: std::time::Duration = std::time::Duration::from_secs(5);

/// How long a config update waits for the run-config lock (a Prism script
/// or rebuild writing the run config) before it saves nothing and reports
/// the run config busy. It holds the start lock meanwhile.
pub const RUN_CONFIG_WAIT: std::time::Duration = std::time::Duration::from_secs(3);

/// The error an update returns, with nothing saved, when the run config
/// stayed locked for [`RUN_CONFIG_WAIT`].
pub const RUN_CONFIG_BUSY: &str =
    "the running config is being updated by another change; nothing was saved, try again";

// A config save holds the start lock through its wait for the run config,
// its profile write and its reload; a start waiting for it must not give up
// first.
const _: () = assert!(
    RUN_CONFIG_WAIT.as_secs() + PROFILE_EDIT_WAIT.as_secs() + CONFIG_RELOAD_TIMEOUT.as_secs() + 5
        < crate::core_manager::core::CORE_START_LOCK_TIMEOUT.as_secs()
);

/// Take the run-config lock, waiting at most `wait` ([`RUN_CONFIG_BUSY`]
/// after that). Blocking: call it on the blocking pool.
fn lock_run_config_within(
    wait: std::time::Duration,
) -> Result<std::sync::MutexGuard<'static, ()>, String> {
    let deadline = std::time::Instant::now() + wait;
    loop {
        match crate::prism::pipeline::RUN_CONFIG_LOCK.try_lock() {
            Ok(guard) => return Ok(guard),
            Err(std::sync::TryLockError::Poisoned(e)) => {
                return Err(format!("Run config lock poisoned: {e}"))
            }
            Err(std::sync::TryLockError::WouldBlock) => {
                if std::time::Instant::now() >= deadline {
                    return Err(RUN_CONFIG_BUSY.to_owned());
                }
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
        }
    }
}

/// The proxy listener a core reports in its `GET /configs` answer (the
/// first of mixed, HTTP and SOCKS port set, as a run config is read).
#[must_use]
pub fn endpoint_from_core_configs(
    configs: &JsonValue,
) -> Option<crate::core_manager::core::ProxyEndpoint> {
    let yaml = serde_yaml::to_value(configs).ok()?;
    crate::core_manager::core::core_process::extract_configured_proxy_endpoint_from_yaml(&yaml)
}

/// The proxy listener the core on `port` runs now, asked within 3 s:
/// `Some(None)` when it answers with no listener, `None` when it does not
/// answer.
async fn core_reported_endpoint(
    port: u16,
    secret: &str,
) -> Option<Option<crate::core_manager::core::ProxyEndpoint>> {
    let client = reload_client(std::time::Duration::from_secs(3)).ok()?;
    let mut req = client.get(format!("http://127.0.0.1:{port}/configs"));
    if !secret.is_empty() {
        req = req.bearer_auth(secret);
    }
    let res = req.send().await.ok()?;
    if !res.status().is_success() {
        return None;
    }
    Some(endpoint_from_core_configs(
        &res.json::<JsonValue>().await.ok()?,
    ))
}

/// [`core_reported_endpoint`], asked again a few times while the core does
/// not answer (busy right after a reload).
async fn core_reported_endpoint_retrying(
    port: u16,
    secret: &str,
) -> Option<Option<crate::core_manager::core::ProxyEndpoint>> {
    const ATTEMPTS: u32 = 3;
    for attempt in 1..=ATTEMPTS {
        if let Some(endpoint) = core_reported_endpoint(port, secret).await {
            return Some(endpoint);
        }
        if attempt < ATTEMPTS {
            tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        }
    }
    None
}

/// The profile a config update saves into: the one recorded now, or, when a
/// stop cleared it since the update's check, the one recorded at that check.
#[must_use]
pub fn profile_or_checked(now: Option<String>, at_check: Option<String>) -> Option<String> {
    now.or(at_check)
}

/// Whether the core running now is the one an update sent its reload to
/// (`before`, its start time then): not when none ran then, and not once it
/// stopped or another one started.
#[must_use]
pub fn same_core_instance(
    before: Option<std::time::Instant>,
    now: Option<std::time::Instant>,
) -> bool {
    before.is_some() && before == now
}

/// Whether a failed reload request may still land: it failed after the
/// connection was made (it timed out, or the connection was reset before the
/// answer came), so the core may have taken and applied it. A connection
/// that timed out or was refused never reached it, and a request that could
/// not be built was never sent.
#[must_use]
pub fn reload_may_still_land(err: &reqwest::Error) -> bool {
    !err.is_connect() && !err.is_builder()
}

/// What the update reports when the reload request failed: a core that took
/// the request but did not confirm it in time (it may still apply it), or one
/// that could not be reached ([`reload_may_still_land`] tells them apart).
#[must_use]
pub const fn reload_error_message(may_still_land: bool) -> &'static str {
    if may_still_land {
        "The core did not confirm the reload (it may still apply it)"
    } else {
        "Core API unavailable for hot reload"
    }
}

/// The client for the hot reload: direct to the local core, and giving up
/// after `timeout` (connecting after at most 3 seconds of it).
pub fn reload_client(timeout: std::time::Duration) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .no_proxy()
        .connect_timeout(timeout.min(std::time::Duration::from_secs(3)))
        .timeout(timeout)
        .build()
        .map_err(|e| format!("failed to build HTTP client: {e}"))
}

#[tauri::command]
pub async fn update_config(
    app: AppHandle,
    state: State<'_, MihomoState>,
    patch: JsonValue,
    expect_profile: Option<String>,
) -> Result<ConfigUpdateResult, String> {
    let paths = ensure_app_storage(&app)?;
    let run_config_path = paths.core_dir.join("run_config.yaml");
    // Built before anything is written: once the run config changed, an
    // error here would report nothing saved.
    let client = reload_client(CONFIG_RELOAD_TIMEOUT)?;

    // A start (a profile switch, say) rewrites the run config and changes
    // the recorded profile. Holding the start lock for the whole update keeps
    // the two from interleaving: the patch goes into the run config and the
    // profile of the same core, never the new run config and the old
    // profile. Like a start the user asked for, it gives up after the
    // timeout rather than wait out a long start.
    let Some(start_guard) = crate::core_manager::core::wait_for_start_lock(
        &crate::core_manager::core::CORE_START_LOCK,
        crate::core_manager::core::StartLockWait::Bounded,
    )
    .await
    else {
        return Err(crate::core_manager::CORE_ALREADY_STARTING.to_owned());
    };

    // A patch checked against one profile (rules validated in it) is not
    // saved once a start brought up another: checked here, under the lock,
    // so no start can land between this check and the writes.
    // Recovered when poisoned, as in step 5: a panic elsewhere does not
    // block every later save.
    let recorded_profile = state
        .0
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .last_config_path()
        .map(String::from);
    if profile_changed_meanwhile(expect_profile.as_deref(), recorded_profile.as_deref()) {
        return Err(PROFILE_CHANGED_MEANWHILE.to_owned());
    }

    // Numbered before the run config is written, in the order the core gets
    // the reloads.
    let reload_revision = RELOAD_REVISION.fetch_add(1, Ordering::SeqCst) + 1;

    // Steps 1-5 run under the run-config lock, which the Prism writers and
    // rebuilds hold through their own read-modify-write of the run config:
    // none can read the run config or the profile between this write and
    // the profile save, and then write a run config without the patch (or
    // have its own change overwritten by this one). It is a std mutex a
    // Prism script can hold for a while, so the work runs on the blocking
    // pool and waits for it only so long: the start lock is held here.
    let blocking_app = app.clone();
    let blocking_run_config_path = run_config_path.clone();
    let blocking_patch = patch.clone();
    let profiles_dir = paths.profiles_dir.clone();
    let profile_at_check = recorded_profile.clone();
    let saved = tokio::task::spawn_blocking(move || {
        let _run_config = lock_run_config_within(RUN_CONFIG_WAIT)?;
        // Block other runtime writers until this exact candidate has finished
        // reloading and its diagnostic listener has been reconciled.
        let config_guard = crate::prism::pipeline::CoreStartGuard::acquire();

        // Steps 1-4: Read, merge, secure, write (testable core)
        let (current_yaml, _port_from_core) =
            update_config_core(&RealConfigIo, &blocking_run_config_path, &blocking_patch)?;

        // 5. Update the original profile too
        let (last_config_path, port, secret) = {
            let state = tauri::Manager::state::<MihomoState>(&blocking_app);
            // Not fallible: the run config is already written, so an error
            // here would hide that from the caller instead of reporting a
            // partial save.
            let lock = state
                .0
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            (
                lock.last_config_path().map(String::from),
                lock.last_port().unwrap_or(9090),
                lock.last_secret().to_owned(),
            )
        };

        // A recorded profile whose file is gone (deleted while its core runs)
        // did not take the patch either: only the run config holds it. One that
        // looks gone because a rename is moving it is named again under the
        // profile-transform guard, as a present one is.
        // A stop does not take the start lock: one that landed since the
        // check above cleared the recorded profile, which still is the one
        // this patch was checked against and that the user edits. It takes
        // the patch, so the save is neither lost nor reported as not needed.
        let target_profile = profile_or_checked(last_config_path, profile_at_check);
        let profile_save = match profile_target(target_profile.as_deref(), &profiles_dir) {
            ProfileTarget::NoProfile => ProfileSave::NotNeeded,
            ProfileTarget::Missing(profile_name) => {
                let profile_path = profiles_dir.join(&profile_name);
                save_patch_to_profile(
                    &blocking_app,
                    &profiles_dir,
                    profile_name,
                    profile_path,
                    &blocking_patch,
                )?
            }
            ProfileTarget::Present {
                name: profile_name,
                path: profile_path,
            } => save_patch_to_profile(
                &blocking_app,
                &profiles_dir,
                profile_name,
                profile_path,
                &blocking_patch,
            )?,
        };
        Ok::<_, String>((current_yaml, profile_save, port, secret, config_guard))
    })
    .await
    .map_err(|e| format!("Config update task failed: {e}"))??;
    let (current_yaml, profile_save, port, secret, config_guard) = saved;

    // 6. Request Core Reload
    let actual_port = if let Some(ext_ctrl) = current_yaml
        .get("external-controller")
        .and_then(|v| v.as_str())
    {
        if let Some(p) = ext_ctrl.split(':').next_back() {
            p.parse::<u16>().unwrap_or_else(|_| {
                emit_warn!(
                    Config,
                    CONFIG_PARSE_FAILED,
                    "failed to parse external-controller port, using default"
                );
                port
            })
        } else {
            port
        }
    } else {
        port
    };

    let url = format!("http://127.0.0.1:{actual_port}/configs?force=true");
    let mut req = client.put(&url).json(&serde_json::json!({
        "path": run_config_path.to_string_lossy()
    }));

    if !secret.is_empty() {
        req = req.bearer_auth(&secret);
    }

    let mut hot_reload_success = false;
    let mut hot_reload_message = String::new();
    let mut reload_unconfirmed = false;

    // The reload may have moved or removed the proxy listener; the tray's
    // system-proxy toggle and env copy read this endpoint. Only for the core
    // this reload went to: one stopped meanwhile had its endpoint cleared
    // (Copy Proxy Env would hand out a dead proxy), and one started since
    // recorded its own.
    // Nor over the record of a later reload of the same core: two updates'
    // answers may come back out of order once the start lock is let go.
    let core_instance = crate::backend_event::lock_best_effort(&state.0).started_at();
    let record_endpoint = |endpoint| {
        let mut guard = crate::backend_event::lock_best_effort(&state.0);
        if same_core_instance(core_instance, guard.started_at())
            && ENDPOINT_REVISION.load(Ordering::SeqCst) <= reload_revision
        {
            ENDPOINT_REVISION.store(reload_revision, Ordering::SeqCst);
            guard.set_last_proxy_endpoint(endpoint);
        }
    };

    let sent = req.send().await;
    let reloaded = sent
        .as_ref()
        .is_ok_and(|response| response.status().is_success());
    if reloaded {
        let candidate = crate::speed_test::injected_route(&current_yaml);
        let app_for_confirmation = app.clone();
        let _ = tokio::task::spawn_blocking(move || {
            crate::speed_test::confirm_listener(&app_for_confirmation, candidate);
        })
        .await;
    }
    let unknown = sent.as_ref().is_err_and(reload_may_still_land);
    if unknown {
        let candidate = crate::speed_test::injected_route(&current_yaml);
        let app_for_confirmation = app.clone();
        let _ = tokio::task::spawn_blocking(move || {
            crate::speed_test::reconcile_unknown_listener(&app_for_confirmation, candidate);
        })
        .await;
    }
    drop(config_guard);
    if reloaded || unknown {
        crate::speed_test::notify_reloaded(&app);
    }
    // The core has answered the reload (or the request ended): a start may
    // go ahead. The lock is held through the reload, bounded by
    // CONFIG_RELOAD_TIMEOUT, so no start replaces the core while it loads
    // the file. The core is asked for its listener below without the lock
    // (a few seconds more would push a waiting start past its timeout); the
    // endpoint is recorded only for the core the reload went to.
    drop(start_guard);
    match sent {
        Ok(res) => {
            let status = res.status();
            if status.is_success() {
                hot_reload_success = true;
                // The listener the core reports after the reload: the run
                // config can change after the transition guard is released
                // above. A core busy right after the reload is asked again:
                // only its answer says what it loaded. When it never answers,
                // this update's candidate is the fallback, since a later
                // save-only Prism write may already have changed the disk.
                let endpoint = if let Some(endpoint) =
                    core_reported_endpoint_retrying(actual_port, &secret).await
                {
                    endpoint
                } else {
                    crate::core_manager::core::core_process::extract_configured_proxy_endpoint_from_yaml(
                        &current_yaml,
                    )
                };
                record_endpoint(endpoint);
            } else {
                let text = res.text().await.unwrap_or_default();
                emit_warn!(
                    Core,
                    CORE_RELOAD_FAILED,
                    "Core reload API returned non-success: {text}"
                );
                hot_reload_message = format!("Hot reload returned status {status}");
            }
        }
        Err(e) => {
            emit_warn!(
                Core,
                CORE_RELOAD_FAILED,
                "Failed to reload core via API: {e}"
            );
            // A reload the core took but did not confirm in time may land or
            // not: the listener the core reports now is the one recorded (none
            // when it reports none), and the old record stays when it does
            // not answer. One that never reached the core leaves the old
            // listener in place.
            let may_still_land = reload_may_still_land(&e);
            reload_unconfirmed = may_still_land;
            if may_still_land {
                if let Some(endpoint) = core_reported_endpoint(actual_port, &secret).await {
                    record_endpoint(endpoint);
                }
            }
            reload_error_message(may_still_land).clone_into(&mut hot_reload_message);
        }
    }

    let mut result = config_update_result(&profile_save, hot_reload_success, &hot_reload_message);
    result.reload_unconfirmed = reload_unconfirmed;
    Ok(result)
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    clippy::indexing_slicing,
    clippy::needless_borrows_for_generic_args
)]
mod tests {
    use super::*;

    #[test]
    fn a_stop_during_a_config_update_does_not_skip_the_profile_save() {
        // Stopped since the check: the checked profile still takes the patch.
        assert_eq!(
            profile_or_checked(None, Some("a.yaml".into())),
            Some("a.yaml".into())
        );
        assert_eq!(
            profile_or_checked(Some("a.yaml".into()), Some("a.yaml".into())),
            Some("a.yaml".into())
        );
        // None ran at the check: none is needed.
        assert_eq!(profile_or_checked(None, None), None);
    }

    #[test]
    fn the_endpoint_is_recorded_only_for_the_core_the_reload_went_to() {
        let started = std::time::Instant::now();
        assert!(same_core_instance(Some(started), Some(started)));
        // Stopped meanwhile: its endpoint stays cleared.
        assert!(!same_core_instance(Some(started), None));
        // Another core started since: it recorded its own.
        let later = started + std::time::Duration::from_millis(1);
        assert!(!same_core_instance(Some(started), Some(later)));
        // None ran when the reload went out.
        assert!(!same_core_instance(None, None));
    }

    #[test]
    fn config_update_waits_for_the_run_config_lock_only_so_long() {
        let held = crate::prism::pipeline::RUN_CONFIG_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let busy = lock_run_config_within(std::time::Duration::from_millis(50)).err();
        assert_eq!(busy.as_deref(), Some(RUN_CONFIG_BUSY));
        drop(held);
        assert!(lock_run_config_within(std::time::Duration::from_millis(50)).is_ok());
    }

    #[test]
    fn test_update_config_basic_merge() {
        let mut base: YamlValue = serde_yaml::from_str("port: 7890\nmode: rule").unwrap();
        let patch: YamlValue = serde_yaml::from_str("mode: global\ndns:\n  enable: true").unwrap();
        merge_yaml(&mut base, &patch, 0).unwrap();

        let map = base.as_mapping().unwrap();
        assert_eq!(
            map.get(&YamlValue::String("mode".to_owned()))
                .unwrap()
                .as_str()
                .unwrap(),
            "global"
        );
        assert_eq!(
            map.get(&YamlValue::String("port".to_owned()))
                .unwrap()
                .as_i64()
                .unwrap(),
            7890
        );
        assert!(map.contains_key(&YamlValue::String("dns".to_owned())));
    }

    #[test]
    fn test_update_config_null_removes_key() {
        let mut base: YamlValue =
            serde_yaml::from_str("port: 7890\nmode: rule\nlog-level: info").unwrap();
        let patch: YamlValue = serde_yaml::from_str("mode: null\nlog-level: null").unwrap();
        merge_yaml(&mut base, &patch, 0).unwrap();

        let map = base.as_mapping().unwrap();
        assert!(!map.contains_key(&YamlValue::String("mode".to_owned())));
        assert!(!map.contains_key(&YamlValue::String("log-level".to_owned())));
        assert!(map.contains_key(&YamlValue::String("port".to_owned())));
    }

    #[test]
    fn test_extract_security_settings_full() {
        let yaml: YamlValue = serde_yaml::from_str(
            "external-controller: 127.0.0.1:9090\nsecret: mysecret\ntun:\n  enable: true",
        )
        .unwrap();
        let settings = extract_security_settings(&yaml);
        assert_eq!(
            settings.external_controller,
            Some("127.0.0.1:9090".to_owned())
        );
        assert_eq!(settings.secret, Some("mysecret".to_owned()));
        assert!(settings.tun_enabled);
    }

    #[test]
    fn test_restore_security_settings_preserves_controller() {
        let mut yaml: YamlValue =
            serde_yaml::from_str("external-controller: 0.0.0.0:8080\nport: 7890").unwrap();
        let settings = SecuritySettings {
            external_controller: Some("127.0.0.1:9090".to_owned()),
            secret: Some("mysecret".to_owned()),
            tun_enabled: false,
        };
        restore_security_settings(&mut yaml, &settings);
        let ctrl = yaml.get("external-controller").unwrap().as_str().unwrap();
        assert!(ctrl.starts_with("127.0.0.1:"));
        assert!(ctrl.contains("9090"));
    }

    #[test]
    fn test_strip_secret_removes_secret() {
        let mut yaml: YamlValue = serde_yaml::from_str("secret: mysecret\nport: 7890").unwrap();
        strip_secret_from_yaml(&mut yaml);
        assert!(yaml.get("secret").is_none());
        assert_eq!(yaml.get("port").unwrap().as_i64().unwrap(), 7890);
    }

    #[test]
    fn test_full_roundtrip_read_merge_write_read() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("run_config.yaml");
        fs::write(
            &path,
            "external-controller: 127.0.0.1:9090\nsecret: mysecret\nport: 7890\nmode: rule\n",
        )
        .unwrap();

        let io = RealConfigIo;
        let original = read_config_with_io(&io, &path).unwrap();
        assert_eq!(original["port"], 7890);
        assert!(original.get("secret").is_none());

        let patch = serde_json::json!({"mode": "global", "log-level": "debug"});
        let (merged_yaml, port) = update_config_core(&io, &path, &patch).unwrap();
        assert_eq!(merged_yaml["mode"], "global");
        assert_eq!(merged_yaml["secret"], "mysecret");
        assert_eq!(port, "9090");

        let after = read_config_with_io(&io, &path).unwrap();
        assert_eq!(after["mode"], "global");
        assert_eq!(after["log-level"], "debug");
        assert_eq!(after["port"], 7890);
        assert!(after.get("secret").is_none());
    }

    #[test]
    fn test_full_roundtrip_security_cannot_be_overridden() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("run_config.yaml");
        fs::write(
            &path,
            "external-controller: 127.0.0.1:9090\nsecret: s3cret\nport: 7890\n",
        )
        .unwrap();

        let io = RealConfigIo;
        for _ in 0..5 {
            let patch = serde_json::json!({
                "external-controller": "0.0.0.0:0",
                "secret": "hacked"
            });
            update_config_core(&io, &path, &patch).unwrap();
        }

        let final_config = read_config_with_io(&io, &path).unwrap();
        assert_eq!(final_config["external-controller"], "127.0.0.1:9090");
        assert!(final_config.get("secret").is_none());

        let raw = fs::read_to_string(&path).unwrap();
        assert!(raw.contains("secret: s3cret"));
        assert!(raw.contains("127.0.0.1:9090"));
        assert!(!raw.contains("0.0.0.0"));
        assert!(!raw.contains("hacked"));
    }

    #[test]
    fn test_full_roundtrip_tun_state_protected() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("run_config.yaml");
        fs::write(
            &path,
            "external-controller: 127.0.0.1:9090\nport: 7890\ntun:\n  enable: false\n",
        )
        .unwrap();

        let io = RealConfigIo;
        let patch = serde_json::json!({"tun": {"enable": true}});
        let (yaml, _) = update_config_core(&io, &path, &patch).unwrap();
        assert!(!yaml["tun"]["enable"].as_bool().unwrap());
    }

    #[test]
    fn update_result_reports_full_success() {
        let result = config_update_result(&ProfileSave::Saved, true, "");
        assert!(result.files_saved && result.profile_saved && result.run_config_saved);
        assert!(result.hot_reload_success);
        assert!(result.profile_error.is_none());
        assert_eq!(
            result.message,
            "Configuration saved and applied successfully"
        );

        let none_needed = config_update_result(&ProfileSave::NotNeeded, true, "");
        assert!(none_needed.files_saved && none_needed.profile_saved);
    }

    #[test]
    fn update_result_reports_a_profile_that_did_not_take_the_patch() {
        let failed = ProfileSave::Failed {
            profile: "sample.yaml".to_owned(),
            reason: "it could not be parsed or merged".to_owned(),
        };
        let result = config_update_result(&failed, true, "");
        assert!(!result.files_saved);
        assert!(!result.profile_saved);
        assert!(result.run_config_saved);
        assert!(result.hot_reload_success);
        assert_eq!(
            result.profile_error.as_deref(),
            Some("it could not be parsed or merged")
        );
        assert!(!result.message.contains("successfully"));
        assert!(result.message.contains("sample.yaml"));

        let json = serde_json::to_value(&result).unwrap();
        assert_eq!(json["files_saved"], false);
        assert_eq!(json["profile_saved"], false);
        assert_eq!(json["run_config_saved"], true);
    }

    #[test]
    fn update_result_reports_both_a_failed_profile_and_a_failed_reload() {
        let failed = ProfileSave::Failed {
            profile: "sample.yaml".to_owned(),
            reason: "disk full".to_owned(),
        };
        let result = config_update_result(&failed, false, "Core API unavailable for hot reload");
        assert!(!result.files_saved && !result.hot_reload_success);
        assert!(result.message.contains("disk full"));
        assert!(result
            .message
            .contains("Core API unavailable for hot reload"));
        // A restart rebuilds the run config from the profile that lacks the
        // change: the message must not send the user there.
        assert!(!result.message.contains("restart core to apply"));
        assert!(!result.message.contains("Restart core to apply"));
        assert!(result
            .message
            .contains("fix the profile, then save the change again"));
        let unconfirmed = config_update_result(&failed, false, reload_error_message(true));
        assert!(unconfirmed.message.contains("may not have reloaded it"));
        assert!(!unconfirmed.message.contains("did not reload it"));
        let bare = config_update_result(&failed, false, "");
        assert!(bare.message.contains("). The core did not reload it"));
        assert!(!bare.message.contains("Restart core to apply"));
    }

    #[test]
    fn profile_patch_cannot_turn_on_tun_or_move_the_controller() {
        let patch = |json: serde_json::Value| serde_yaml::to_value(json).unwrap();
        let read = |yaml: &str| serde_yaml::from_str::<YamlValue>(yaml).unwrap();
        let profile = "tun:\n  enable: false\n  stack: system\nsecret: kept\n\
                       external-controller: 127.0.0.1:9090\nrules: []\n";

        let merged = read(
            &merge_patch_into_profile(
                profile,
                &patch(serde_json::json!({
                    "tun": { "enable": true, "stack": "gvisor" },
                    "secret": "changed",
                    "external-controller": "0.0.0.0:9090",
                    "<<": { "tun": { "enable": true } },
                    "rules": ["DOMAIN,example.com,DIRECT"],
                })),
            )
            .unwrap(),
        );
        assert_eq!(merged["tun"]["enable"], YamlValue::Bool(false));
        assert_eq!(merged["tun"]["stack"], YamlValue::from("gvisor"));
        assert_eq!(merged["secret"], YamlValue::from("kept"));
        assert_eq!(
            merged["external-controller"],
            YamlValue::from("127.0.0.1:9090")
        );
        assert!(merged.get("<<").is_none());
        assert_eq!(
            merged["rules"][0],
            YamlValue::from("DOMAIN,example.com,DIRECT")
        );

        // No TUN section: an enable-only patch adds none.
        let merged = read(
            &merge_patch_into_profile(
                "rules: []\n",
                &patch(serde_json::json!({ "tun": { "enable": true } })),
            )
            .unwrap(),
        );
        assert!(merged.get("tun").is_none());

        // TUN already on in the profile: a patch cannot turn it off either,
        // with `enable: false` or with a null section.
        let merged = read(
            &merge_patch_into_profile(
                "tun:\n  enable: true\n",
                &patch(serde_json::json!({ "tun": { "enable": false, "stack": "gvisor" } })),
            )
            .unwrap(),
        );
        assert_eq!(merged["tun"]["enable"], YamlValue::Bool(true));
        assert_eq!(merged["tun"]["stack"], YamlValue::from("gvisor"));
        let merged = read(
            &merge_patch_into_profile(
                "tun:\n  enable: true\n",
                &patch(serde_json::json!({ "tun": null, "mode": "rule" })),
            )
            .unwrap(),
        );
        assert_eq!(merged["tun"]["enable"], YamlValue::Bool(true));
        assert_eq!(merged["mode"], YamlValue::from("rule"));
        // Nor with a scalar in place of the section.
        let merged = read(
            &merge_patch_into_profile(
                "tun:\n  enable: true\n",
                &patch(serde_json::json!({ "tun": false })),
            )
            .unwrap(),
        );
        assert_eq!(merged["tun"]["enable"], YamlValue::Bool(true));

        assert!(merge_patch_into_profile("rules: [", &patch(serde_json::json!({}))).is_none());
    }

    #[test]
    fn profile_patch_to_a_tun_inherited_at_the_top_keeps_it_on() {
        let patch = |json: serde_json::Value| serde_yaml::to_value(json).unwrap();
        let read = |yaml: &str| serde_yaml::from_str::<YamlValue>(yaml).unwrap();
        let profile = "<<:\n  tun:\n    enable: true\n    stack: system\nrules: []\n";
        let merged = read(
            &merge_patch_into_profile(
                profile,
                &patch(serde_json::json!({ "tun": { "stack": "gvisor" } })),
            )
            .unwrap(),
        );
        assert_eq!(merged["tun"]["enable"], YamlValue::Bool(true));
        assert_eq!(merged["tun"]["stack"], YamlValue::from("gvisor"));
    }

    #[test]
    fn profile_patch_keeps_the_profiles_own_provider_paths() {
        let patch = |json: serde_json::Value| serde_yaml::to_value(json).unwrap();
        let read = |yaml: &str| serde_yaml::from_str::<YamlValue>(yaml).unwrap();
        let profile = "rule-providers:\n  local:\n    type: file\n    behavior: domain\n    \
                       path: ./rules/local.yaml\nrules:\n  - RULE-SET,local,DIRECT\n";

        // A save of an unrelated setting leaves the local provider working.
        let merged = read(
            &merge_patch_into_profile(profile, &patch(serde_json::json!({ "mode": "global" })))
                .unwrap(),
        );
        assert_eq!(merged["mode"], YamlValue::from("global"));
        assert_eq!(
            merged["rule-providers"]["local"]["path"],
            YamlValue::from("./rules/local.yaml")
        );

        // The patch itself is still sanitized: it cannot bring in a provider
        // path or a script.
        let merged = read(
            &merge_patch_into_profile(
                profile,
                &patch(serde_json::json!({
                    "rule-providers": { "remote": {
                        "type": "http", "url": "https://example.com/r.yaml",
                        "path": "../../escape.yaml",
                    } },
                    "script": { "code": "x" },
                })),
            )
            .unwrap(),
        );
        assert!(merged["rule-providers"]["remote"].get("path").is_none());
        assert!(merged.get("script").is_none());
        assert_eq!(
            merged["rule-providers"]["local"]["path"],
            YamlValue::from("./rules/local.yaml")
        );

        // A path-only entry (no `type`, so not recognizable as a provider on
        // its own) cannot move an existing provider's file either.
        let merged = read(
            &merge_patch_into_profile(
                profile,
                &patch(serde_json::json!({
                    "rule-providers": { "local": { "path": "../../escape.yaml" } },
                    "proxy-providers": { "p": { "path": "/etc/passwd" } },
                })),
            )
            .unwrap(),
        );
        assert_eq!(
            merged["rule-providers"]["local"]["path"],
            YamlValue::from("./rules/local.yaml")
        );
        assert!(merged["proxy-providers"]["p"].get("path").is_none());
    }

    #[test]
    fn profile_patch_never_replaces_a_profile_that_is_not_a_mapping() {
        let patch = serde_yaml::to_value(serde_json::json!({ "mode": "global" })).unwrap();
        for profile in [
            "!profile\nmode: rule\nrules: []\n",
            "",
            "- a\n- b\n",
            "just text\n",
        ] {
            assert!(
                merge_patch_into_profile(profile, &patch).is_none(),
                "{profile:?} must be left alone"
            );
        }
        assert!(merge_patch_into_profile("mode: rule\n", &patch).is_some());
    }

    #[test]
    fn profile_patch_that_is_not_a_mapping_leaves_the_profile_alone() {
        for json in [
            serde_json::json!(["mode", "global"]),
            serde_json::json!("mode: global"),
            serde_json::json!(7),
            serde_json::json!(null),
        ] {
            let patch = serde_yaml::to_value(&json).unwrap();
            assert!(
                merge_patch_into_profile("mode: rule\n", &patch).is_none(),
                "{patch:?} must not replace the profile"
            );
        }
    }

    #[test]
    fn profile_patch_keeps_legacy_subscription_comments() {
        let profile = "# URL: https://example.com/sub.yaml\n# SUB_INFO: upload=0; download=0\n# other note\nmode: rule\n";
        let patch = serde_yaml::to_value(serde_json::json!({ "mode": "global" })).unwrap();
        let merged = merge_patch_into_profile(profile, &patch).unwrap();
        assert!(merged.starts_with(
            "# URL: https://example.com/sub.yaml\n# SUB_INFO: upload=0; download=0\n"
        ));
        let value: YamlValue = serde_yaml::from_str(&merged).unwrap();
        assert_eq!(value["mode"], YamlValue::from("global"));
    }

    #[tokio::test]
    async fn reload_gives_up_on_a_core_that_never_answers() {
        // The OS accepts the connection, but nothing ever reads or answers it:
        // a frozen core.
        let silent = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = silent.local_addr().unwrap().port();
        let client = reload_client(std::time::Duration::from_millis(200)).unwrap();
        let started = std::time::Instant::now();
        let err = client
            .put(format!("http://127.0.0.1:{port}/configs?force=true"))
            .json(&serde_json::json!({ "path": "run_config.yaml" }))
            .send()
            .await
            .unwrap_err();
        assert!(err.is_timeout(), "{err}");
        assert!(started.elapsed() < std::time::Duration::from_secs(5));
        // Reported as not confirmed, not as an unreachable core.
        assert!(reload_may_still_land(&err), "{err:?}");
        assert!(reload_error_message(reload_may_still_land(&err)).contains("did not confirm"));
        drop(silent);
    }

    #[tokio::test]
    async fn reload_cut_off_before_the_answer_may_still_land() {
        // The core reads the request and drops the connection without an
        // answer (it crashed or restarted while applying it).
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            use tokio::io::AsyncReadExt as _;
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buf = [0_u8; 1024];
            let _ = socket.read(&mut buf).await;
            drop(socket);
        });
        let client = reload_client(std::time::Duration::from_secs(10)).unwrap();
        let err = client
            .put(format!("http://127.0.0.1:{port}/configs?force=true"))
            .json(&serde_json::json!({ "path": "run_config.yaml" }))
            .send()
            .await
            .unwrap_err();
        assert!(!err.is_timeout(), "{err:?}");
        assert!(reload_may_still_land(&err), "{err:?}");
        server.await.unwrap();
    }

    #[tokio::test]
    async fn reload_to_a_closed_port_reports_an_unreachable_core() {
        let closed = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = closed.local_addr().unwrap().port();
        drop(closed);
        // Windows answers a closed local port only after its connect
        // retries (about 2 s): refused or timed out while connecting, the
        // request never reached a core either way.
        let client = reload_client(std::time::Duration::from_secs(10)).unwrap();
        let err = client
            .put(format!("http://127.0.0.1:{port}/configs?force=true"))
            .send()
            .await
            .unwrap_err();
        assert!(!reload_may_still_land(&err), "{err:?}");
        assert_eq!(
            reload_error_message(reload_may_still_land(&err)),
            "Core API unavailable for hot reload"
        );
    }

    #[test]
    fn profile_patch_removes_a_key_the_profile_inherits() {
        let patch = |json: serde_json::Value| serde_yaml::to_value(json).unwrap();
        let read = |yaml: &str| serde_yaml::from_str::<YamlValue>(yaml).unwrap();
        let profile = "base: &base\n  ipv6: true\n  dns:\n    enable: true\n    ipv6: true\n<<: *base\ndns:\n  <<: *base\n  listen: 127.0.0.1:53\n";
        let merged = read(
            &merge_patch_into_profile(
                profile,
                &patch(serde_json::json!({ "ipv6": null, "dns": { "ipv6": null } })),
            )
            .unwrap(),
        );
        // Written as explicit nulls: the inherited `true` no longer applies.
        assert_eq!(merged.get("ipv6"), Some(&YamlValue::Null));
        assert_eq!(merged["dns"].get("ipv6"), Some(&YamlValue::Null));
        assert_eq!(merged["dns"]["listen"], YamlValue::from("127.0.0.1:53"));
        // A key nothing provides stays absent.
        let plain = read(
            &merge_patch_into_profile("mode: rule\n", &patch(serde_json::json!({ "ipv6": null })))
                .unwrap(),
        );
        assert_eq!(plain.get("ipv6"), None);
    }

    #[test]
    fn core_configs_answer_gives_the_proxy_listener() {
        let port = |json: serde_json::Value| endpoint_from_core_configs(&json).map(|e| e.port);
        assert_eq!(
            port(serde_json::json!({ "port": 0, "socks-port": 7891, "mixed-port": 0 })),
            Some(7891)
        );
        assert_eq!(
            port(serde_json::json!({ "port": 7890, "socks-port": 7891, "mixed-port": 7893 })),
            Some(7893)
        );
        assert_eq!(
            port(serde_json::json!({ "port": 0, "mixed-port": 0 })),
            None
        );
    }

    #[tokio::test]
    async fn core_reported_endpoint_asks_the_core() {
        use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
        let api = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let api_port = api.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            let (mut socket, _) = api.accept().await.unwrap();
            let mut buf = [0u8; 1024];
            let n = socket.read(&mut buf).await.unwrap();
            let request = String::from_utf8_lossy(&buf[..n]).into_owned();
            assert!(request.starts_with("GET /configs "), "{request}");
            assert!(request.contains("Bearer test-secret"), "{request}");
            let body = r#"{"port":0,"socks-port":0,"mixed-port":7893}"#;
            let reply = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            socket.write_all(reply.as_bytes()).await.unwrap();
        });
        let endpoint = core_reported_endpoint(api_port, "test-secret").await;
        assert_eq!(endpoint.flatten().map(|e| e.port), Some(7893));
        server.await.unwrap();
        // An answer with no listener is known: the old record is cleared.
        let api = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let api_port = api.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            let (mut socket, _) = api.accept().await.unwrap();
            let mut buf = [0u8; 1024];
            let _ = socket.read(&mut buf).await.unwrap();
            let body = r#"{"port":0,"socks-port":0,"mixed-port":0}"#;
            let reply = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            socket.write_all(reply.as_bytes()).await.unwrap();
        });
        assert_eq!(core_reported_endpoint(api_port, "").await, Some(None));
        server.await.unwrap();
        // Nothing listening: unknown, so the old record stays.
        let closed = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let closed_port = closed.local_addr().unwrap().port();
        drop(closed);
        assert!(core_reported_endpoint(closed_port, "").await.is_none());
    }

    #[test]
    fn profile_patch_keeps_fields_inherited_through_merge_keys() {
        let patch = |json: serde_json::Value| serde_yaml::to_value(json).unwrap();
        let read = |yaml: &str| serde_yaml::from_str::<YamlValue>(yaml).unwrap();
        let profile = "base: &base\n  tun:\n    enable: true\n    stack: mixed\n  dns:\n    enable: true\n    nameserver:\n      - 192.0.2.1\n<<: *base\nrules: []\n";
        let merged = read(
            &merge_patch_into_profile(
                profile,
                &patch(
                    serde_json::json!({ "tun": { "stack": "gvisor" }, "dns": { "ipv6": true } }),
                ),
            )
            .unwrap(),
        );
        assert_eq!(merged["tun"]["enable"], YamlValue::from(true));
        assert_eq!(merged["tun"]["stack"], YamlValue::from("gvisor"));
        assert_eq!(merged["dns"]["enable"], YamlValue::from(true));
        assert_eq!(merged["dns"]["ipv6"], YamlValue::from(true));
        assert_eq!(merged["dns"]["nameserver"][0], YamlValue::from("192.0.2.1"));
    }

    #[test]
    fn profile_patch_keeps_an_inherited_tagged_mapping_whole() {
        let patch = |json: serde_json::Value| serde_yaml::to_value(json).unwrap();
        let read = |yaml: &str| serde_yaml::from_str::<YamlValue>(yaml).unwrap();
        let profile = "base: &base\n  dns: !custom\n    enable: true\n    nameserver:\n      - 192.0.2.1\n<<: *base\nrules: []\n";
        let merged = read(
            &merge_patch_into_profile(
                profile,
                &patch(serde_json::json!({ "dns": { "ipv6": true } })),
            )
            .unwrap(),
        );
        let tagged_dns = if let YamlValue::Tagged(tagged) = &merged["dns"] {
            tagged.value.as_mapping()
        } else {
            None
        };
        assert!(
            tagged_dns.is_some(),
            "the inherited dns section lost its tag: {:?}",
            merged["dns"]
        );
        let dns = tagged_dns.unwrap();
        assert_eq!(dns.get("ipv6"), Some(&YamlValue::from(true)));
        assert_eq!(dns.get("enable"), Some(&YamlValue::from(true)));
        assert_eq!(dns.get("nameserver"), Some(&read("[192.0.2.1]")));
    }

    #[test]
    fn update_is_refused_once_another_profile_runs() {
        // Checked against a.yaml, b.yaml runs now: refused.
        assert!(profile_changed_meanwhile(Some("a.yaml"), Some("b.yaml")));
        // Same profile, or nothing to compare against: goes ahead.
        assert!(!profile_changed_meanwhile(Some("a.yaml"), Some("a.yaml")));
        assert!(!profile_changed_meanwhile(None, Some("b.yaml")));
        assert!(!profile_changed_meanwhile(None, None));
        // Checked against a.yaml, but no profile runs (the minimal config
        // after a failed start): the patch would reach no profile.
        assert!(profile_changed_meanwhile(Some("a.yaml"), None));
        assert!(profile_changed_meanwhile(
            Some("a.yaml"),
            Some("run_config.yaml")
        ));
        // Checked with no profile running: refused once one runs.
        assert!(!profile_changed_meanwhile(Some(""), None));
        assert!(!profile_changed_meanwhile(
            Some(""),
            Some("run_config.yaml")
        ));
        assert!(profile_changed_meanwhile(Some(""), Some("b.yaml")));
    }

    #[test]
    fn profile_patch_merges_into_a_tagged_mapping_and_keeps_its_tag() {
        let patch = |json: serde_json::Value| serde_yaml::to_value(json).unwrap();
        let read = |yaml: &str| serde_yaml::from_str::<YamlValue>(yaml).unwrap();
        let profile = "defaults: &d\n  enable: true\n  nameserver:\n    - 192.0.2.1\ndns: !custom\n  <<: *d\n  ipv6: false\n";
        let merged = read(
            &merge_patch_into_profile(
                profile,
                &patch(serde_json::json!({ "dns": { "listen": "0.0.0.0:1053" } })),
            )
            .unwrap(),
        );
        let tagged_dns = if let YamlValue::Tagged(tagged) = &merged["dns"] {
            tagged.value.as_mapping()
        } else {
            None
        };
        assert!(
            tagged_dns.is_some(),
            "the dns section lost its tag: {:?}",
            merged["dns"]
        );
        let dns = tagged_dns.unwrap();
        assert_eq!(dns.get("listen"), Some(&YamlValue::from("0.0.0.0:1053")));
        assert_eq!(dns.get("ipv6"), Some(&YamlValue::from(false)));
        // What it inherits stays in effect.
        assert!(dns.contains_key("<<"));
    }

    #[test]
    fn profile_patch_with_a_null_tun_keeps_an_off_tun_section() {
        let patch = |json: serde_json::Value| serde_yaml::to_value(json).unwrap();
        let read = |yaml: &str| serde_yaml::from_str::<YamlValue>(yaml).unwrap();
        // TUN is off explicitly, over an inherited `enable: true`.
        let profile = "base: &base\n  tun:\n    enable: true\n<<: *base\ntun:\n  enable: false\n";
        let merged = read(
            &merge_patch_into_profile(
                profile,
                &patch(serde_json::json!({ "tun": null, "mode": "rule" })),
            )
            .unwrap(),
        );
        assert_eq!(merged["tun"]["enable"], YamlValue::from(false));
        assert_eq!(merged["mode"], YamlValue::from("rule"));
    }

    #[test]
    fn profile_patch_nested_too_deep_is_refused() {
        let mut nested = serde_json::json!("x.example.com");
        for _ in 0..(MAX_MERGE_DEPTH + 2) {
            nested = serde_json::json!({ "k": nested });
        }
        let patch = serde_yaml::to_value(serde_json::json!({ "deep": nested })).unwrap();
        assert!(merge_patch_into_profile("mode: rule\n", &patch).is_none());
        // Within the limit it goes through.
        let shallow =
            serde_yaml::to_value(serde_json::json!({ "a": { "b": { "c": 1 } } })).unwrap();
        assert!(merge_patch_into_profile("mode: rule\n", &shallow).is_some());
    }

    #[test]
    fn profile_patch_follows_merge_keys_for_tun() {
        let patch = |json: serde_json::Value| serde_yaml::to_value(json).unwrap();
        let read = |yaml: &str| serde_yaml::from_str::<YamlValue>(yaml).unwrap();

        // A merge source nested in the patch cannot bring TUN in.
        let merged = read(
            &merge_patch_into_profile(
                "rules: []\n",
                &patch(serde_json::json!({ "tun": { "<<": { "enable": true } } })),
            )
            .unwrap(),
        );
        assert!(merged.get("tun").is_none());
        let merged = read(
            &merge_patch_into_profile(
                "tun:\n  enable: false\n",
                &patch(serde_json::json!({
                    "tun": { "<<": [{ "enable": true }], "stack": "gvisor" },
                    "dns": { "<<": { "enable": true } },
                })),
            )
            .unwrap(),
        );
        assert_eq!(merged["tun"]["enable"], YamlValue::Bool(false));
        assert!(merged["tun"].get("<<").is_none());
        assert_eq!(merged["tun"]["stack"], YamlValue::from("gvisor"));
        assert!(merged["dns"].get("<<").is_none());

        // A profile that inherits TUN on through `<<` counts as on: a patch
        // turning it off is dropped, and its other fields keep it on.
        let inherited = "base: &base\n  enable: true\n  stack: system\ntun:\n  <<: *base\n";
        let merged = read(
            &merge_patch_into_profile(
                inherited,
                &patch(serde_json::json!({ "tun": { "enable": false, "stack": "gvisor" } })),
            )
            .unwrap(),
        );
        assert!(profile_tun_enabled(&merged));
        assert_eq!(merged["tun"]["stack"], YamlValue::from("gvisor"));
        let top_level = "<<:\n  tun:\n    enable: true\n";
        assert!(profile_tun_enabled(&read(top_level)));
        assert!(profile_tun_enabled(&read(inherited)));
        // An explicit entry wins over an inherited one, as in mihomo.
        assert!(!profile_tun_enabled(&read(
            "tun:\n  <<: { enable: true }\n  enable: false\n"
        )));
        assert!(!profile_tun_enabled(&read(
            "tun:\n  <<: { stack: system }\n"
        )));
    }

    #[test]
    fn profile_target_reports_a_recorded_profile_whose_file_is_gone() {
        let dir = tempfile::TempDir::new().unwrap();
        std::fs::write(dir.path().join("present.yaml"), "mode: rule\n").unwrap();
        assert_eq!(profile_target(None, dir.path()), ProfileTarget::NoProfile);
        assert_eq!(
            profile_target(Some("run_config.yaml"), dir.path()),
            ProfileTarget::NoProfile
        );
        assert_eq!(
            profile_target(Some("present.yaml"), dir.path()),
            ProfileTarget::Present {
                name: "present.yaml".to_owned(),
                path: dir.path().join("present.yaml"),
            }
        );
        assert_eq!(
            profile_target(Some("deleted.yaml"), dir.path()),
            ProfileTarget::Missing("deleted.yaml".to_owned())
        );

        // Reported as a profile that did not take the patch, not as saved.
        let missing = ProfileSave::Failed {
            profile: "deleted.yaml".to_owned(),
            reason: PROFILE_FILE_MISSING.to_owned(),
        };
        let result = config_update_result(&missing, true, "");
        assert!(!result.files_saved && !result.profile_saved);
        assert_eq!(result.profile_error.as_deref(), Some(PROFILE_FILE_MISSING));
        assert!(result.message.contains("deleted.yaml"));
    }

    #[test]
    fn update_result_reports_a_failed_reload_with_saved_files() {
        let result =
            config_update_result(&ProfileSave::Saved, false, "Hot reload returned status 500");
        assert!(result.files_saved && !result.hot_reload_success);
        assert_eq!(
            result.message,
            "Configuration saved. Hot reload returned status 500 - restart core to apply changes."
        );
        let bare = config_update_result(&ProfileSave::NotNeeded, false, "");
        assert_eq!(
            bare.message,
            "Configuration saved. Restart core to apply changes."
        );
        let json = serde_json::to_value(&bare).unwrap();
        assert!(json.get("profile_error").is_none());
    }
}
