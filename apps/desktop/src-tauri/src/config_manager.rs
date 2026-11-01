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
use tauri::{AppHandle, State};
use zephyr_core::config::sanitizer::remove_dangerous_keys_internal_pub as remove_dangerous_keys;

// Re-export pure functions from core crate
use zephyr_core::config::merge::{merge_yaml, read_config_with_io, update_config_core, ConfigIo};

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
                     {reload_failure}the core did not reload it, and restarting the core would \
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
fn merged_entry<'a>(value: &'a YamlValue, name: &str, depth: usize) -> Option<&'a YamlValue> {
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
/// bring in values the guards below check only as plain entries.
#[allow(clippy::wildcard_enum_match_arm)]
fn strip_merge_keys(value: &mut YamlValue, depth: usize) {
    if depth > MAX_MERGE_DEPTH {
        *value = YamlValue::Null;
        return;
    }
    match value {
        YamlValue::Mapping(map) => {
            map.retain(|k, _| resolved_key(k) != Some(YAML_MERGE_KEY));
            for (_, child) in map.iter_mut() {
                strip_merge_keys(child, depth + 1);
            }
        }
        YamlValue::Sequence(seq) => {
            for item in seq.iter_mut() {
                strip_merge_keys(item, depth + 1);
            }
        }
        YamlValue::Tagged(tagged) => strip_merge_keys(&mut tagged.value, depth + 1),
        _ => {}
    }
}

/// Merge `patch` into a profile's YAML (`None` when the profile cannot be
/// parsed or the merge fails). The profile is guarded the way the run config
/// is: a patch does not set its controller address or secret (every start
/// injects the app's own), carries no `<<` merge key at any depth (mihomo
/// would fold its contents in), and does not turn on a TUN the profile has
/// off (also when the profile inherits that setting through `<<`), which
/// only the TUN switch does; otherwise loading that profile later would
/// start TUN on its own.
#[must_use]
pub fn merge_patch_into_profile(profile_content: &str, patch: &YamlValue) -> Option<String> {
    let mut profile = serde_yaml::from_str::<YamlValue>(profile_content).ok()?;
    remove_dangerous_keys(&mut profile, false);
    let tun_on = profile_tun_enabled(&profile);
    let mut guarded = patch.clone();
    strip_merge_keys(&mut guarded, 0);
    if let YamlValue::Mapping(map) = &mut guarded {
        map.remove("external-controller");
        map.remove("secret");
        if !tun_on {
            let emptied = match map.get_mut("tun") {
                Some(YamlValue::Mapping(tun)) => {
                    tun.remove("enable");
                    tun.is_empty()
                }
                _ => false,
            };
            if emptied {
                map.remove("tun");
            }
        }
    }
    merge_yaml(&mut profile, &guarded, 0).ok()?;
    remove_dangerous_keys(&mut profile, false);
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
pub const CONFIG_RELOAD_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

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
) -> Result<ConfigUpdateResult, String> {
    let paths = ensure_app_storage(&app)?;
    let run_config_path = paths.core_dir.join("run_config.yaml");

    // A start (a profile switch, say) rewrites the run config and changes
    // the recorded profile. Holding the start lock for the whole update keeps
    // the two from interleaving: the patch goes into the run config and the
    // profile of the same core, never the new run config and the old
    // profile. Like a start the user asked for, it gives up after the
    // timeout rather than wait out a long start.
    let Some(_start_guard) = crate::core_manager::core::wait_for_start_lock(
        &crate::core_manager::core::CORE_START_LOCK,
        crate::core_manager::core::StartLockWait::Bounded,
    )
    .await
    else {
        return Err(crate::core_manager::CORE_ALREADY_STARTING.to_owned());
    };

    // Steps 1-4: Read, merge, secure, write (testable core)
    let (current_yaml, _port_from_core) =
        update_config_core(&RealConfigIo, &run_config_path, &patch)?;

    // 5. Update the original profile too
    let (last_config_path, port, secret) = {
        let lock = state
            .0
            .lock()
            .map_err(|e| format!("Failed to lock state: {e}"))?;
        (
            lock.last_config_path().map(String::from),
            lock.last_port().unwrap_or(9090),
            lock.last_secret().to_owned(),
        )
    };

    // A recorded profile whose file is gone (deleted while its core runs)
    // did not take the patch either: only the run config holds it.
    let profile_save = match profile_target(last_config_path.as_deref(), &paths.profiles_dir) {
        ProfileTarget::NoProfile => ProfileSave::NotNeeded,
        ProfileTarget::Missing(profile_name) => {
            emit_warn!(
                Config,
                CONFIG_PARSE_FAILED,
                "Profile {profile_name} was not updated: {PROFILE_FILE_MISSING}"
            );
            ProfileSave::Failed {
                profile: profile_name,
                reason: PROFILE_FILE_MISSING.to_owned(),
            }
        }
        ProfileTarget::Present {
            name: profile_name,
            path: profile_path,
        } => {
            let patch_yaml: YamlValue = serde_yaml::to_value(&patch)
                .map_err(|e| format!("Failed to convert JSON patch to YAML: {e}"))?;
            // One read-modify-write under the profile-transform guard, so a
            // concurrent save or encryption batch cannot land in between;
            // the profile keeps its current encryption form. The guard is a
            // std mutex an encryption batch can hold for a while, so the
            // edit runs on the blocking pool instead of a runtime worker.
            let blocking_app = app.clone();
            let edited = tokio::task::spawn_blocking(move || {
                crate::core_manager::update_profile_file(
                    &blocking_app,
                    &profile_path,
                    |profile_content| merge_patch_into_profile(profile_content, &patch_yaml),
                )
            })
            .await
            .unwrap_or_else(|e| Err(format!("profile update task failed: {e}")));
            match edited {
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
            }
        }
    };

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

    let client = reload_client(CONFIG_RELOAD_TIMEOUT)?;
    let url = format!("http://127.0.0.1:{actual_port}/configs?force=true");
    let mut req = client.put(&url).json(&serde_json::json!({
        "path": run_config_path.to_string_lossy()
    }));

    if !secret.is_empty() {
        req = req.bearer_auth(secret);
    }

    let mut hot_reload_success = false;
    let mut hot_reload_message = String::new();

    match req.send().await {
        Ok(res) => {
            let status = res.status();
            if status.is_success() {
                hot_reload_success = true;
                // The reload may have moved or removed the proxy listener; the
                // tray's system-proxy toggle and env copy read this endpoint.
                let endpoint =
                    crate::core_manager::core::core_process::extract_configured_proxy_endpoint_from_yaml(
                        &current_yaml,
                    );
                crate::backend_event::lock_best_effort(&state.0).set_last_proxy_endpoint(endpoint);
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
            "Core API unavailable for hot reload".clone_into(&mut hot_reload_message);
        }
    }

    Ok(config_update_result(
        &profile_save,
        hot_reload_success,
        &hot_reload_message,
    ))
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
        let bare = config_update_result(&failed, false, "");
        assert!(bare.message.contains("the core did not reload it"));
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

        // TUN already on in the profile: the patch may still turn it off.
        let merged = read(
            &merge_patch_into_profile(
                "tun:\n  enable: true\n",
                &patch(serde_json::json!({ "tun": { "enable": false } })),
            )
            .unwrap(),
        );
        assert_eq!(merged["tun"]["enable"], YamlValue::Bool(false));

        assert!(merge_patch_into_profile("rules: [", &patch(serde_json::json!({}))).is_none());
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
        drop(silent);
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

        // A profile that inherits TUN on through `<<` counts as on: turning
        // it off is kept, not stripped as if TUN were already off.
        let inherited = "base: &base\n  enable: true\n  stack: system\ntun:\n  <<: *base\n";
        let merged = read(
            &merge_patch_into_profile(
                inherited,
                &patch(serde_json::json!({ "tun": { "enable": false } })),
            )
            .unwrap(),
        );
        assert_eq!(merged["tun"]["enable"], YamlValue::Bool(false));
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
