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
    /// No profile takes the patch: none is active, it is the run config
    /// itself, or its file is gone.
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

/// Build the result of an update whose run config was written, from what
/// happened to the profile and to the hot reload. A profile that could not
/// take the patch is reported as such: the change is live (or will be after
/// a restart) but is lost the next time that profile is loaded.
#[must_use]
pub fn config_update_result(
    profile: &ProfileSave,
    hot_reload_success: bool,
    hot_reload_message: &str,
) -> ConfigUpdateResult {
    let reload_note = if hot_reload_success {
        None
    } else if hot_reload_message.is_empty() {
        Some("Restart core to apply changes.".to_owned())
    } else {
        Some(format!(
            "{hot_reload_message} - restart core to apply changes."
        ))
    };
    let (profile_saved, profile_error, message) = match profile {
        ProfileSave::Failed { profile, reason } => {
            let saved_part = format!(
                "Run config saved, but profile {profile} could not be updated ({reason}); \
                 the change will be lost when that profile is loaded again."
            );
            let message = match &reload_note {
                None => format!("Changes applied. {saved_part}"),
                Some(note) => format!("{saved_part} {note}"),
            };
            (false, Some(reason.clone()), message)
        }
        ProfileSave::NotNeeded | ProfileSave::Saved => {
            let message = match &reload_note {
                None => "Configuration saved and applied successfully".to_owned(),
                Some(note) => format!("Configuration saved. {note}"),
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

#[tauri::command]
pub async fn update_config(
    app: AppHandle,
    state: State<'_, MihomoState>,
    patch: JsonValue,
) -> Result<ConfigUpdateResult, String> {
    let paths = ensure_app_storage(&app)?;
    let run_config_path = paths.core_dir.join("run_config.yaml");

    // Steps 1-4: Read, merge, secure, write (testable core)
    let (current_yaml, _port_from_core) =
        update_config_core(&RealConfigIo, &run_config_path, &patch)?;

    // 5. Update original profile if it exists
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

    let mut profile_save = ProfileSave::NotNeeded;
    if let Some(profile_name) = &last_config_path {
        if profile_name != "run_config.yaml" {
            let profile_path = paths.profiles_dir.join(profile_name);
            if profile_path.exists() {
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
                        |profile_content| {
                            let mut profile_yaml =
                                serde_yaml::from_str::<YamlValue>(profile_content).ok()?;
                            remove_dangerous_keys(&mut profile_yaml, false);
                            merge_yaml(&mut profile_yaml, &patch_yaml, 0).ok()?;
                            remove_dangerous_keys(&mut profile_yaml, false);
                            serde_yaml::to_string(&profile_yaml).ok()
                        },
                    )
                })
                .await
                .unwrap_or_else(|e| Err(format!("profile update task failed: {e}")));
                profile_save = match edited {
                    Ok(true) => ProfileSave::Saved,
                    Ok(false) => {
                        emit_warn!(
                            Config,
                            CONFIG_PARSE_FAILED,
                            "Profile {profile_name} was not updated: it could not be parsed or merged"
                        );
                        ProfileSave::Failed {
                            profile: profile_name.clone(),
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
                            profile: profile_name.clone(),
                            reason: e,
                        }
                    }
                };
            }
        }
    }

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

    let client = reqwest::Client::builder()
        .no_proxy()
        .build()
        .map_err(|e| format!("failed to build HTTP client: {e}"))?;
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
        assert!(result.message.contains("restart core"));
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
