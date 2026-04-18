use std::fs;
use std::process::Command;
use tauri::AppHandle;

use super::config_sanitizer::{sanitize_config_file_name, validate_path_within_dir};
use super::core_process::ensure_app_storage;
use super::crypto::{cleanup_metadata_cache, load_metadata, save_metadata};
use super::secure_io::write_file_secure;
use super::ConfigInfo;

/// Mask URL for safe display in UI (hide sensitive host, path, and query parts)
pub(super) fn mask_url(url: &str) -> String {
    if let Ok(parsed) = reqwest::Url::parse(url) {
        let host = parsed.host_str().unwrap_or("???");
        let masked_host = if host.len() > 6 {
            format!("{}***{}", &host[..3], &host[host.len() - 3..])
        } else {
            "***".to_owned()
        };
        // Only show scheme + masked host; hide path and query entirely
        format!("{}://{masked_host}/***", parsed.scheme())
    } else {
        "***".to_owned()
    }
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
            if path
                .extension()
                .is_some_and(|ext| ext == "yaml" || ext == "yml")
            {
                if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                    if name != "run_config.yaml" {
                        let (url, sub_info) = if let Some(meta) = metadata.configs.get(name) {
                            (meta.url.clone(), meta.sub_info.clone())
                        } else {
                            // Fallback to reading old comments
                            let mut url = None;
                            let mut sub_info = None;
                            if let Ok(file) = std::fs::File::open(&path) {
                                use std::io::{BufRead as _, BufReader};
                                let reader = BufReader::new(file);
                                for line in reader.lines().take(50).map_while(Result::ok) {
                                    if line.starts_with("# URL: ") {
                                        url = Some(line.replace("# URL: ", "").trim().to_owned());
                                    } else if line.starts_with("# SUB_INFO: ") {
                                        sub_info = Some(
                                            line.replace("# SUB_INFO: ", "").trim().to_owned(),
                                        );
                                    }
                                }
                            }
                            (url, sub_info)
                        };

                        let url_display = url.as_ref().map(|u| mask_url(u));

                        configs.push(ConfigInfo {
                            name: name.to_owned(),
                            url,
                            url_display,
                            sub_info,
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
/// This is the only endpoint that exposes the raw URL, used exclusively for subscription updates.
#[tauri::command]
pub async fn get_config_url(app: AppHandle, name: String) -> Result<String, String> {
    // Reuse comprehensive sanitization (URL decode, path traversal check, etc.)
    let safe_name = sanitize_config_file_name(&name)?;

    let paths = ensure_app_storage(&app)?;
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

#[tauri::command]
pub async fn delete_config(app: AppHandle, name: String) -> Result<String, String> {
    let paths = ensure_app_storage(&app)?;

    // Ensure the name has a .yaml extension
    let mut clean_name = if name.ends_with(".yaml") || name.ends_with(".yml") {
        name.clone()
    } else {
        format!("{name}.yaml")
    };

    clean_name = sanitize_config_file_name(&clean_name)?;
    if clean_name == "run_config.yaml" {
        return Err("Cannot delete the active temp config".to_owned());
    }

    let target_path = paths.profiles_dir.join(&clean_name);
    validate_path_within_dir(&target_path, &paths.profiles_dir)?;

    let file_exists = target_path.exists();

    if !file_exists {
        // Try with .yml extension as well
        let yml_name = name.replace(".yaml", ".yml");
        let yml_path = paths.profiles_dir.join(&yml_name);

        if yml_path.exists() {
            fs::remove_file(&yml_path).map_err(|e| format!("Failed to delete file: {e}"))?;
            let mut metadata = load_metadata(&paths);
            metadata.configs.remove(&yml_name);
            save_metadata(&paths, &metadata);
            return Ok(format!("Config {yml_name} deleted"));
        }
        return Err(format!("File does not exist: {target_path:?}"));
    }

    // Remove metadata
    let mut metadata = load_metadata(&paths);
    metadata.configs.remove(&name);
    save_metadata(&paths, &metadata);

    // Delete the file and verify
    fs::remove_file(&target_path).map_err(|e| format!("Failed to delete file: {e}"))?;

    // Verify deletion (Windows may report success but file remains if locked)
    if target_path.exists() {
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        fs::remove_file(&target_path).map_err(|e| format!("Failed to delete file: {e}"))?;

        if target_path.exists() {
            return Err(format!(
                "File could not be deleted (locked by another process?): {target_path:?}"
            ));
        }
    }

    Ok(format!("Config {name} deleted"))
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn read_config_file(app: AppHandle, config_path: String) -> Result<String, String> {
    let paths = ensure_app_storage(&app)?;
    let config_file_name = sanitize_config_file_name(&config_path)?;
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

    validate_path_within_dir(&resolved_path, &base_dir)?;

    if !resolved_path.exists() {
        return Err(format!("Config file {resolved_path:?} not found"));
    }

    fs::read_to_string(&resolved_path).map_err(|e| format!("Failed to read config: {e}"))
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn write_config_file(
    app: AppHandle,
    config_path: String,
    content: String,
) -> Result<String, String> {
    let paths = ensure_app_storage(&app)?;
    let config_file_name = sanitize_config_file_name(&config_path)?;
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

    validate_path_within_dir(&resolved_path, &base_dir)?;

    write_file_secure(&resolved_path, &content)?;

    Ok(format!("Successfully wrote to {resolved_path:?}"))
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn open_config_folder(app: AppHandle) -> Result<String, String> {
    let paths = ensure_app_storage(&app)?;
    let target = paths.profiles_dir;

    #[cfg(target_os = "windows")]
    {
        Command::new("explorer")
            .arg(&target)
            .spawn()
            .map_err(|e| format!("Failed to open config folder: {e}"))?;
    }

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(&target)
            .spawn()
            .map_err(|e| format!("Failed to open config folder: {e}"))?;
    }

    #[cfg(target_os = "linux")]
    {
        Command::new("xdg-open")
            .arg(&target)
            .spawn()
            .map_err(|e| format!("Failed to open config folder: {e}"))?;
    }

    Ok(target.to_string_lossy().into_owned())
}
