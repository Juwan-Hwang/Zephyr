//! Backup & restore system — transactional config export/import with manifest.
//!
//! ## Design
//!
//! **Export**: Collect `settings.json`, `run_config.yaml`, and all profile
//! YAMLs into a ZIP archive with a `manifest.json` containing checksums
//! and metadata. Reuses the zip-bomb detection logic from `updater.rs`
//! and path-traversal protection from `sanitizer.rs`.
//!
//! **Import**: Three-phase transactional flow:
//!   1. **Validate** — verify manifest, checksums, zip bomb, path traversal
//!   2. **Stage** — extract files to a staging directory
//!   3. **Commit** — atomically swap staged files into place; on any failure,
//!      roll back to the pre-import state
//!
//! ## Security
//!
//! - Zip bomb: max 200 MB uncompressed, max 200:1 compression ratio (same as updater)
//! - Path traversal: reject entries with `..`, absolute paths, null bytes, symlinks
//! - Manifest: SHA-256 checksum per file, version field for forward compatibility
//! - Atomicity: staging directory + rename swap, rollback on failure

use crate::core_manager::{ensure_app_storage, AppPaths};
use crate::SettingsState;
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};
use std::fs;
use std::io::{Read as _, Write as _};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager as _};
use tauri_plugin_dialog::DialogExt as _;

// ── Constants ─────────────────────────────────────────────────────────────

/// Maximum total uncompressed size for a backup archive (200 MB).
const MAX_BACKUP_SIZE: u64 = 200 * 1024 * 1024;

/// Maximum compression ratio (uncompressed:compressed).
const MAX_COMPRESSION_RATIO: u64 = 200;

/// Current manifest format version.
const MANIFEST_VERSION: u32 = 1;

// ── Manifest ──────────────────────────────────────────────────────────────

/// Backup manifest — embedded as `manifest.json` inside the ZIP archive.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupManifest {
    /// Manifest format version (for forward compatibility).
    pub version: u32,
    /// Zephyr app version that created the backup.
    pub app_version: String,
    /// ISO 8601 timestamp of when the backup was created.
    pub created_at: String,
    /// File entries with relative paths and SHA-256 checksums.
    pub files: Vec<ManifestEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ManifestEntry {
    /// Relative path within the archive (e.g., "settings.json", "profiles/my-sub.yaml").
    pub path: String,
    /// SHA-256 hex digest of the file content.
    pub sha256: String,
    /// Uncompressed file size in bytes.
    pub size: u64,
}

// ── Export ────────────────────────────────────────────────────────────────

/// Collect all files that should be included in a backup.
///
/// Returns a list of `(relative_path, absolute_path)` pairs.
fn collect_backup_files(paths: &AppPaths) -> Vec<(String, PathBuf)> {
    let mut files = Vec::new();

    // 1. settings.json
    let settings = paths.app_data_dir.join("settings.json");
    if settings.exists() {
        files.push(("settings.json".to_owned(), settings));
    }

    // 2. run_config.yaml (runtime config)
    let run_config = paths.core_dir.join("run_config.yaml");
    if run_config.exists() {
        files.push(("run_config.yaml".to_owned(), run_config));
    }

    // 3. All profile YAML files
    if paths.profiles_dir.exists() {
        if let Ok(entries) = fs::read_dir(&paths.profiles_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_file() {
                    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
                        let ext_lower = ext.to_lowercase();
                        if ext_lower == "yaml" || ext_lower == "yml" {
                            if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                                files.push((format!("profiles/{name}"), path));
                            }
                        }
                    }
                }
            }
        }
    }

    // 4. Metadata file (subscription info, intervals, etc.)
    let metadata = paths.app_data_dir.join("metadata.json");
    if metadata.exists() {
        files.push(("metadata.json".to_owned(), metadata));
    }

    files
}

/// Compute SHA-256 hex digest of a file by streaming in 8 KiB chunks.
///
/// Streaming avoids loading the entire file into memory, preventing OOM
/// crashes when processing large configuration files.
fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path).map_err(|e| format!("Failed to open {path:?}: {e}"))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 8192];
    loop {
        let n = file
            .read(&mut buffer)
            .map_err(|e| format!("Failed to read {path:?}: {e}"))?;
        if n == 0 {
            break;
        }
        hasher.update(buffer.get(..n).unwrap_or(&[]));
    }
    Ok(hex::encode(hasher.finalize()))
}

/// Export all user configuration to a ZIP file with a manifest.
///
/// The user selects the save location via a native file dialog.
/// Returns the path the file was saved to.
#[tauri::command]
pub async fn export_backup(app: AppHandle) -> Result<String, String> {
    let paths = ensure_app_storage(&app)?;

    // Collect backup files on a blocking thread to avoid blocking
    // the async executor with filesystem traversal.
    let paths_clone = paths.clone();
    let files = tokio::task::spawn_blocking(move || collect_backup_files(&paths_clone))
        .await
        .map_err(|e| format!("Failed to collect backup files: {e}"))?;

    if files.is_empty() {
        return Err("No configuration files found to backup".to_owned());
    }

    // Prompt user for save location
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .add_filter("ZIP", &["zip"])
        .set_file_name("zephyr-backup.zip")
        .save_file(move |path| {
            let _ = tx.send(path);
        });
    let file_path = rx
        .await
        .map_err(|_rx| "Dialog cancelled".to_owned())?
        .ok_or_else(|| "Export cancelled".to_owned())?;

    let save_path = file_path
        .as_path()
        .ok_or_else(|| "Invalid save path".to_owned())?
        .to_path_buf();

    // Create the ZIP archive on a blocking thread — all synchronous I/O
    // (SHA-256 hashing, metadata, file reading) runs here to avoid
    // blocking the Tokio async executor.
    tokio::task::spawn_blocking(move || -> Result<String, String> {
        use zip::write::SimpleFileOptions;

        // Build manifest entries on the blocking thread
        let app_version = env!("CARGO_PKG_VERSION").to_owned();
        let created_at = chrono::Utc::now().to_rfc3339();

        let mut manifest_entries = Vec::with_capacity(files.len());
        for (rel_path, abs_path) in &files {
            let sha = sha256_file(abs_path)?;
            let size = fs::metadata(abs_path).map(|m| m.len()).unwrap_or(0);
            manifest_entries.push(ManifestEntry {
                path: rel_path.clone(),
                sha256: sha,
                size,
            });
        }

        let manifest = BackupManifest {
            version: MANIFEST_VERSION,
            app_version,
            created_at,
            files: manifest_entries,
        };

        let zip_file =
            fs::File::create(&save_path).map_err(|e| format!("Failed to create zip: {e}"))?;
        let mut zip_writer = zip::ZipWriter::new(zip_file);
        let zip_options =
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);

        // Write manifest first
        let manifest_json = serde_json::to_string_pretty(&manifest)
            .map_err(|e| format!("Failed to serialize manifest: {e}"))?;
        zip_writer
            .start_file("manifest.json", zip_options)
            .map_err(|e| format!("Failed to write manifest: {e}"))?;
        zip_writer
            .write_all(manifest_json.as_bytes())
            .map_err(|e| format!("Failed to write manifest content: {e}"))?;

        // Write all files
        for (rel_path, abs_path) in &files {
            zip_writer
                .start_file(rel_path.as_str(), zip_options)
                .map_err(|e| format!("Failed to add {rel_path} to zip: {e}"))?;

            let mut file = fs::File::open(abs_path)
                .map_err(|e| format!("Failed to open {abs_path:?}: {e}"))?;
            std::io::copy(&mut file, &mut zip_writer)
                .map_err(|e| format!("Failed to copy {rel_path} to zip: {e}"))?;
        }

        zip_writer
            .finish()
            .map_err(|e| format!("Failed to finalize zip: {e}"))?;

        Ok(save_path.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| format!("Export task failed: {e}"))?
}

// ── Import ────────────────────────────────────────────────────────────────

/// Validate a path inside the archive — reject path traversal, absolute paths,
/// null bytes, and symlinks.
///
/// This reuses the same security principles as `sanitizer.rs` and the
/// zip extraction in `updater.rs`.
fn is_safe_archive_path(path: &str) -> bool {
    // Reject empty paths — an empty path resolves to the staging
    // directory itself, which would cause unexpected behavior.
    if path.is_empty() {
        return false;
    }

    // Reject null bytes
    if path.contains('\0') {
        return false;
    }

    // Reject absolute paths (Unix and Windows)
    if path.starts_with('/') || path.starts_with('\\') {
        return false;
    }

    // Reject Windows drive letters (e.g., C:\, D:\)
    if path.len() >= 2 {
        let bytes = path.as_bytes();
        if let (Some(&b1), Some(&b0)) = (bytes.get(1), bytes.first()) {
            if b1 == b':' && b0.is_ascii_alphabetic() {
                return false;
            }
        }
    }

    // Reject path traversal, backslashes, and colons to prevent NTFS ADS
    // (Alternate Data Stream) exploits and platform-specific directory
    // traversal bypasses. Standard ZIP archives must only use forward
    // slashes (/) as directory separators.
    if path.contains("..") || path.contains('\\') || path.contains(':') {
        return false;
    }

    true
}

/// Atomically move a file, falling back to copy + delete if `fs::rename`
/// fails with `EXDEV` (cross-device link).
///
/// This is necessary because `staging_dir` (inside `app_data_dir`) and
/// destination directories (`profiles_dir`, `core_dir`) may reside on
/// different filesystems or mount points.
fn atomic_rename(src: &Path, dst: &Path) -> Result<(), String> {
    match fs::rename(src, dst) {
        Ok(()) => Ok(()),
        Err(rename_err) => {
            // `fs::rename` failed (e.g., EXDEV — cross-device link).
            // Fall back to copy + rename via a temporary file in the
            // destination directory so the destination is never left in
            // a partially-written state.
            let dst_dir = dst
                .parent()
                .ok_or_else(|| format!("No parent dir for {dst:?}"))?;
            // Use UUID for uniqueness — SystemTime nanos can collide on
            // platforms with low clock resolution (e.g., Windows ~15 ms).
            let temp_path = dst_dir.join(format!(".tmp-atomic-{}", uuid::Uuid::new_v4()));

            if let Err(e) = fs::copy(src, &temp_path) {
                let _ = fs::remove_file(&temp_path);
                return Err(format!(
                    "Failed to move {src:?} to {dst:?}: \
                     rename failed ({rename_err}), copy fallback failed ({e})"
                ));
            }
            if let Err(e) = fs::rename(&temp_path, dst) {
                let _ = fs::remove_file(&temp_path);
                return Err(format!(
                    "Failed to move {src:?} to {dst:?}: \
                     rename failed ({rename_err}), temp rename failed ({e})"
                ));
            }
            let _ = fs::remove_file(src);
            Ok(())
        }
    }
}

/// Verify a file's SHA-256 against the manifest.
fn verify_sha256(path: &Path, expected: &str) -> Result<(), String> {
    let actual = sha256_file(path)?;
    if actual != expected {
        return Err(format!(
            "Checksum mismatch for {path:?}: expected {expected}, got {actual}"
        ));
    }
    Ok(())
}

/// Import a backup ZIP file with transactional restore.
///
/// Flow:
/// 1. Open ZIP, read manifest, validate version
/// 2. Check each entry for path traversal / zip bomb
/// 3. Extract to staging directory
/// 4. Verify all checksums
/// 5. Back up current files → swap staged files in → clean up
/// 6. On any failure: delete staging, restore backup
#[tauri::command]
pub async fn import_backup(app: AppHandle) -> Result<String, String> {
    let paths = ensure_app_storage(&app)?;

    // Prompt user for file to import
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .add_filter("ZIP", &["zip"])
        .pick_file(move |path| {
            let _ = tx.send(path);
        });
    let file_path = rx
        .await
        .map_err(|_rx| "Dialog cancelled".to_owned())?
        .ok_or_else(|| "Import cancelled".to_owned())?;

    let open_path = file_path
        .as_path()
        .ok_or_else(|| "Invalid file path".to_owned())?
        .to_path_buf();

    // Phase 1-4: Validate and stage (on blocking thread)
    let paths_clone = paths.clone();
    let staging_result =
        tokio::task::spawn_blocking(move || -> Result<(BackupManifest, PathBuf), String> {
            // Open the archive
            let file = fs::File::open(&open_path)
                .map_err(|e| format!("Failed to open backup file: {e}"))?;
            let mut archive = zip::ZipArchive::new(file)
                .map_err(|e| format!("Failed to read ZIP archive: {e}"))?;

            // Read manifest first — use by_name for O(1) lookup
            let mut manifest_str = String::new();
            archive
                .by_name("manifest.json")
                .map_err(|_zip| "Backup archive is missing manifest.json".to_owned())?
                .take(10 * 1024 * 1024)
                .read_to_string(&mut manifest_str)
                .map_err(|e| format!("Failed to read manifest: {e}"))?;

            let manifest: BackupManifest = serde_json::from_str(&manifest_str)
                .map_err(|e| format!("Failed to parse manifest: {e}"))?;

            if manifest.version > MANIFEST_VERSION {
                return Err(format!(
                    "Backup manifest version {} is newer than supported version {}. \
                     Please update Zephyr.",
                    manifest.version, MANIFEST_VERSION
                ));
            }

            // Create staging directory — use UUID for uniqueness since
            // SystemTime millisecond timestamps can collide on platforms
            // with low clock resolution (e.g., Windows ~15 ms).
            let staging_dir = paths_clone
                .app_data_dir
                .join(format!(".backup-staging-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&staging_dir)
                .map_err(|e| format!("Failed to create staging directory: {e}"))?;

            // Extract and validate each file inside a closure so that any
            // error triggers a single, centralized cleanup of the staging dir.
            let mut total_uncompressed: u64 = 0;
            let mut extract_all = || -> Result<(), String> {
                for entry in &manifest.files {
                    if !is_safe_archive_path(&entry.path) {
                        return Err(format!("Unsafe path in backup archive: {}", entry.path));
                    }

                    // Find the entry in the ZIP by name — use by_name for O(1) lookup
                    let zip_entry = archive.by_name(&entry.path).map_err(|_zip| {
                        format!(
                            "File '{}' listed in manifest not found in archive",
                            entry.path
                        )
                    })?;

                    // Reject symlinks
                    if zip_entry.is_symlink() {
                        return Err(format!("Refusing to extract symlink: {}", entry.path));
                    }

                    // Zip bomb: check uncompressed size
                    let uncompressed = zip_entry.size();
                    total_uncompressed += uncompressed;
                    if total_uncompressed > MAX_BACKUP_SIZE {
                        return Err("Backup archive exceeds 200 MB uncompressed limit".to_owned());
                    }

                    // Zip bomb: check compression ratio
                    let compressed = zip_entry.compressed_size();
                    if compressed > 0
                        && uncompressed > compressed.saturating_mul(MAX_COMPRESSION_RATIO)
                    {
                        return Err(
                            "Suspicious compression ratio detected (possible zip bomb)".to_owned()
                        );
                    }

                    // Verify size matches manifest
                    if uncompressed != entry.size {
                        return Err(format!(
                            "Size mismatch for {}: manifest says {} bytes, \
                             archive has {} bytes",
                            entry.path, entry.size, uncompressed
                        ));
                    }

                    // Create parent directories if needed (e.g., profiles/)
                    let dest_path = staging_dir.join(&entry.path);
                    if let Some(parent) = dest_path.parent() {
                        fs::create_dir_all(parent)
                            .map_err(|e| format!("Failed to create directory: {e}"))?;
                    }

                    // Extract file — limit bytes written to the declared
                    // uncompressed size to prevent zip-bomb bypass via
                    // spoofed size headers.
                    let mut out_file = fs::File::create(&dest_path)
                        .map_err(|e| format!("Failed to create {dest_path:?}: {e}"))?;
                    let mut limited_reader = zip_entry.take(uncompressed);
                    std::io::copy(&mut limited_reader, &mut out_file)
                        .map_err(|e| format!("Failed to extract {}: {e}", entry.path))?;
                    out_file
                        .sync_all()
                        .map_err(|e| format!("Failed to sync {dest_path:?}: {e}"))?;
                    drop(out_file);

                    // Verify checksum
                    verify_sha256(&dest_path, &entry.sha256)?;

                    // Validate settings.json structure before commit so a
                    // corrupt archive doesn't overwrite the user's working
                    // settings file.
                    if entry.path == "settings.json" {
                        let content = fs::read_to_string(&dest_path)
                            .map_err(|e| format!("Failed to read extracted settings.json: {e}"))?;
                        if serde_json::from_str::<crate::Settings>(&content).is_err() {
                            return Err("Extracted settings.json is corrupt or invalid".to_owned());
                        }
                    }
                }
                Ok(())
            };

            if let Err(e) = extract_all() {
                let _ = fs::remove_dir_all(&staging_dir);
                return Err(e);
            }

            Ok((manifest, staging_dir))
        })
        .await
        .map_err(|e| format!("Import task failed: {e}"))?;

    // Phase 5: Commit — atomically swap files into place.
    // All blocking I/O (create_dir_all, atomic_rename, restore_rollback,
    // remove_dir_all) runs inside spawn_blocking to avoid blocking the
    // Tokio async executor.
    let (manifest, staging_dir) = match staging_result {
        Ok(res) => res,
        Err(e) => return Err(e),
    };

    let file_count = manifest.files.len();
    let app_version = manifest.app_version.clone();
    let paths_clone = paths.clone();

    let commit_result = tokio::task::spawn_blocking(move || -> Result<(), String> {
        // Back up current files, then swap — use UUID for the rollback
        // directory name to avoid collisions and improve predictability.
        let backup_dir = paths_clone
            .app_data_dir
            .join(format!(".backup-rollback-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&backup_dir)
            .map_err(|e| format!("Failed to create rollback directory: {e}"))?;

        // Map relative paths to absolute destinations
        let dest_map = build_dest_map(&paths_clone, &manifest);

        // Commit phase: back up current files, then swap staged files in.
        // Wrapped in a closure so that any error triggers rollback + cleanup
        // in a single, centralized location.
        let mut newly_created: Vec<PathBuf> = Vec::new();

        let mut commit_result = || -> Result<(), String> {
            // Back up current files that will be replaced
            for (rel_path, dest_abs) in &dest_map {
                if dest_abs.exists() {
                    let backup_path = backup_dir.join(rel_path);
                    if let Some(parent) = backup_path.parent() {
                        fs::create_dir_all(parent)
                            .map_err(|e| format!("Failed to create backup dir: {e}"))?;
                    }
                    atomic_rename(dest_abs, &backup_path)?;
                }
            }

            // Move staged files into place.
            // Push to newly_created *before* attempting atomic_rename so that
            // a partial copy fallback failure is also cleaned up.
            for (rel_path, dest_abs) in &dest_map {
                let staged_path = staging_dir.join(rel_path);
                if staged_path.exists() {
                    if let Some(parent) = dest_abs.parent() {
                        fs::create_dir_all(parent)
                            .map_err(|e| format!("Failed to create dest dir: {e}"))?;
                    }

                    let is_new = !backup_dir.join(rel_path).exists();
                    if is_new {
                        newly_created.push(dest_abs.clone());
                    }

                    atomic_rename(&staged_path, dest_abs)
                        .map_err(|e| format!("Failed to apply {rel_path}: {e}"))?;
                }
            }
            Ok(())
        };

        if let Err(e) = commit_result() {
            // Rollback: delete newly created files, then restore backups
            for created in &newly_created {
                let _ = fs::remove_file(created);
            }
            restore_rollback(&backup_dir, &paths_clone);
            let _ = fs::remove_dir_all(&staging_dir);
            let _ = fs::remove_dir_all(&backup_dir);
            return Err(format!("{e}. Rolled back to previous state."));
        }

        // Success — clean up
        let _ = fs::remove_dir_all(&staging_dir);
        let _ = fs::remove_dir_all(&backup_dir);
        Ok(())
    })
    .await
    .map_err(|e| format!("Commit task failed: {e}"))?;

    commit_result?;

    // Reload SettingsState from the newly imported settings.json to
    // prevent the in-memory state from overwriting the imported file.
    // Run migrate_settings to handle backups from older schema versions.
    if let Some(settings_state) = app.try_state::<SettingsState>() {
        let settings_file = paths.app_data_dir.join("settings.json");
        if settings_file.exists() {
            if let Ok(content) = fs::read_to_string(&settings_file) {
                if let Ok(new_settings) = serde_json::from_str::<crate::Settings>(&content) {
                    let migrated = crate::migrate_settings(new_settings, &settings_file);
                    let mut guard = settings_state
                        .0
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner);
                    *guard = migrated;
                }
            }
        }
    }

    Ok(format!(
        "Backup restored successfully ({file_count} files from v{app_version})"
    ))
}

/// Map manifest relative paths to absolute destination paths.
fn build_dest_map(paths: &AppPaths, manifest: &BackupManifest) -> Vec<(String, PathBuf)> {
    manifest
        .files
        .iter()
        .map(|entry| {
            let dest = if entry.path.starts_with("profiles/") {
                let file_name = entry.path.strip_prefix("profiles/").unwrap_or(&entry.path);
                paths.profiles_dir.join(file_name)
            } else if entry.path == "settings.json" {
                paths.app_data_dir.join("settings.json")
            } else if entry.path == "run_config.yaml" {
                paths.core_dir.join("run_config.yaml")
            } else if entry.path == "metadata.json" {
                paths.app_data_dir.join("metadata.json")
            } else {
                // Unknown files go to app_data_dir root
                paths.app_data_dir.join(&entry.path)
            };
            (entry.path.clone(), dest)
        })
        .collect()
}

/// Restore all files from the rollback directory to their original locations.
///
/// Collects all file paths into a `Vec` *before* performing any renames.
/// Modifying a directory tree while iterating over it with `fs::read_dir`
/// is unsafe and platform-dependent — on Windows it can skip files,
/// return duplicates, or fail with an error.
fn restore_rollback(backup_dir: &Path, paths: &AppPaths) {
    // Phase 1: Walk the backup dir and collect all (src, dest) pairs.
    let mut files_to_restore: Vec<(PathBuf, PathBuf)> = Vec::new();

    fn walk_dir(dir: &Path, base: &Path, paths: &AppPaths, files: &mut Vec<(PathBuf, PathBuf)>) {
        if let Ok(entries) = fs::read_dir(dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    walk_dir(&path, base, paths, files);
                } else {
                    let rel = path.strip_prefix(base).unwrap_or(&path);
                    let dest = map_rel_to_dest(rel, paths);
                    files.push((path, dest));
                }
            }
        }
    }

    walk_dir(backup_dir, backup_dir, paths, &mut files_to_restore);

    // Phase 2: Restore each file — safe because the directory iterator
    // has already been fully consumed.
    for (src, dest) in &files_to_restore {
        if let Some(parent) = dest.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if let Err(e) = atomic_rename(src, dest) {
            let rel = src.strip_prefix(backup_dir).unwrap_or(src);
            eprintln!("[Backup] Rollback failed for {rel:?}: {e}");
        }
    }
}

/// Map a relative path (from backup dir) to its absolute destination.
///
/// Uses `Path` methods instead of string matching to be platform-agnostic
/// (Windows uses backslash separators).
fn map_rel_to_dest(rel: &Path, paths: &AppPaths) -> PathBuf {
    if rel.starts_with("profiles") {
        let file_name = rel.strip_prefix("profiles").unwrap_or(rel);
        paths.profiles_dir.join(file_name)
    } else if rel == Path::new("settings.json") {
        paths.app_data_dir.join("settings.json")
    } else if rel == Path::new("run_config.yaml") {
        paths.core_dir.join("run_config.yaml")
    } else if rel == Path::new("metadata.json") {
        paths.app_data_dir.join("metadata.json")
    } else {
        paths.app_data_dir.join(rel)
    }
}
