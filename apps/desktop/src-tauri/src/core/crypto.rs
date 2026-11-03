use base64::{engine::general_purpose::STANDARD as base64_standard, Engine as _};
use rand::RngExt as _;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};

use tauri::Manager as _;

use super::secure_io::{write_file_secure, write_file_secure_atomic};
use super::AppPaths;

#[derive(serde::Serialize, serde::Deserialize, Default)]
pub(super) struct ProfilesMetadata {
    pub configs: std::collections::HashMap<String, ConfigMetadata>,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Default)]
pub(super) struct ConfigMetadata {
    pub url: Option<String>,
    pub sub_info: Option<String>,
    #[serde(default)]
    pub last_updated: Option<u64>, // Unix timestamp (seconds) of last successful update
    #[serde(default)]
    pub auto_update_interval: Option<u64>, // Auto-update interval in seconds for this subscription (0 = disabled)
    /// Per-subscription User-Agent override. When set, used instead of the global
    /// `subscription_user_agent` for downloading/updating this subscription.
    #[serde(default)]
    pub user_agent: Option<String>,
}

/// Machine key file name for persistent storage
const MACHINE_KEY_FILE: &str = ".machine_key";

/// Cached derived key - computed once, used for all encryption/decryption
static DERIVED_KEY: OnceLock<Vec<u8>> = OnceLock::new();

/// Get or create a persistent machine-specific encryption key.
/// Uses multiple hardware fingerprints for enhanced security against VM cloning.
/// Falls back to a randomly generated key persisted to disk if system IDs unavailable.
/// Returns Ok(key) on success, or Err if the key could not be persisted (session-only key).
static MACHINE_KEY_PERSISTED: AtomicBool = AtomicBool::new(false);

pub(super) fn get_machine_key() -> Vec<u8> {
    DERIVED_KEY.get_or_init(compute_machine_key).clone()
}

/// Compute the machine key (expensive operation - use `get_machine_key()` for cached access)
fn compute_machine_key() -> Vec<u8> {
    let mut seed_parts: Vec<String> = Vec::new();

    // Collect system machine ID
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt as _;
        if let Ok(hklm) = winreg::RegKey::predef(winreg::enums::HKEY_LOCAL_MACHINE)
            .open_subkey("SOFTWARE\\Microsoft\\Cryptography")
        {
            if let Ok(guid) = hklm.get_value::<String, _>("MachineGuid") {
                seed_parts.push(guid);
            }
        }
        // Additional Windows fingerprint: Volume serial number of C: drive
        // This adds another factor that changes if the system is cloned
        if let Ok(output) = std::process::Command::new("cmd")
            .args(["/C", "vol C:"])
            .creation_flags(super::CREATE_NO_WINDOW)
            .output()
        {
            let vol_output = String::from_utf8_lossy(&output.stdout);
            // Extract serial number from output like "Volume Serial Number is XXXX-XXXX"
            if let Some(idx) = vol_output.find("Volume Serial Number is ") {
                let serial = &vol_output[idx + 24..];
                if let Some(end) = serial.find('\n') {
                    seed_parts.push(serial[..end].trim().to_owned());
                }
            }
        }
    }
    #[cfg(target_os = "macos")]
    {
        if let Ok(output) = std::process::Command::new("ioreg")
            .arg("-rd1")
            .arg("-c")
            .arg("IOPlatformExpertDevice")
            .output()
        {
            let out_str = String::from_utf8_lossy(&output.stdout);
            if let Some(idx) = out_str.find("IOPlatformUUID") {
                seed_parts.push(out_str[idx..].to_owned());
            }
        }
        // Additional macOS fingerprint: Hardware UUID
        if let Ok(output) = std::process::Command::new("ioreg")
            .arg("-rd1")
            .arg("-c")
            .arg("IOPlatformExpertDevice")
            .arg("-d")
            .arg("1")
            .output()
        {
            let out_str = String::from_utf8_lossy(&output.stdout);
            if let Some(idx) = out_str.find("IOPlatformSerialNumber") {
                if let Some(serial_start) = out_str[idx..].find('"') {
                    let rest = &out_str[idx + serial_start + 1..];
                    if let Some(serial_end) = rest.find('"') {
                        seed_parts.push(rest[..serial_end].to_owned());
                    }
                }
            }
        }
    }
    #[cfg(target_os = "linux")]
    {
        if let Ok(id) = fs::read_to_string("/etc/machine-id") {
            seed_parts.push(id.trim().to_owned());
        }
        // Additional Linux fingerprint: board serial if available
        if let Ok(output) = std::process::Command::new("cat")
            .arg("/sys/class/dmi/id/board_serial")
            .output()
        {
            let board_serial = String::from_utf8_lossy(&output.stdout);
            let trimmed = board_serial.trim();
            if !trimmed.is_empty() && trimmed != "None" && trimmed.len() > 2 {
                seed_parts.push(trimmed.to_owned());
            }
        }
    }

    // Combine all seed parts with process ID for additional uniqueness
    // This adds a session-specific component to prevent cross-session attacks
    let combined_seed = if !seed_parts.is_empty() {
        // Use multiple hardware fingerprints combined
        seed_parts.join("|")
    } else {
        // Fallback: empty seed
        String::new()
    };

    // If we have a system seed, derive a 32-byte key using PBKDF2
    // This ensures consistent key length and proper entropy distribution
    if !combined_seed.is_empty() {
        use pbkdf2::pbkdf2_hmac;
        use sha2::Sha256;

        // Use a fixed salt for key derivation (not secret, just prevents rainbow tables)
        const SALT: &[u8] = b"Zephyr_AES256_Key_Derivation";

        // Derive 32 bytes for AES-256 using PBKDF2-HMAC-SHA256
        // 100,000 iterations provides good security vs performance balance
        let mut derived_key = [0u8; 32];
        pbkdf2_hmac::<Sha256>(combined_seed.as_bytes(), SALT, 100_000, &mut derived_key);

        // Hardware fingerprint-based key is deterministic and stable across restarts
        MACHINE_KEY_PERSISTED.store(true, Ordering::SeqCst);
        return derived_key.to_vec();
    }

    // Fallback: use a persistent random key stored in the app data directory
    // This ensures key consistency across sessions while avoiding hardcoded keys
    // Try platform-specific locations first
    let key_path = {
        #[cfg(target_os = "windows")]
        {
            std::env::var("APPDATA")
                .map(|base| PathBuf::from(base).join("Zephyr").join(MACHINE_KEY_FILE))
                .ok()
        }

        #[cfg(target_os = "macos")]
        {
            std::env::var("HOME")
                .map(|h| {
                    PathBuf::from(h)
                        .join("Library/Application Support/Zephyr")
                        .join(MACHINE_KEY_FILE)
                })
                .ok()
        }

        #[cfg(target_os = "linux")]
        {
            // XDG_CONFIG_HOME takes precedence over ~/.config
            std::env::var("XDG_CONFIG_HOME")
                .map(|base| PathBuf::from(base).join("Zephyr").join(MACHINE_KEY_FILE))
                .ok()
                .or_else(|| {
                    std::env::var("HOME")
                        .map(|h| {
                            PathBuf::from(h)
                                .join(".config/Zephyr")
                                .join(MACHINE_KEY_FILE)
                        })
                        .ok()
                })
        }

        #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
        {
            std::env::var("HOME")
                .map(|h| {
                    PathBuf::from(h)
                        .join(".config/Zephyr")
                        .join(MACHINE_KEY_FILE)
                })
                .ok()
        }
    };

    if let Some(key_path_ref) = key_path {
        // Ensure directory exists with secure permissions
        if let Some(parent) = key_path_ref.parent() {
            if !parent.exists() && fs::create_dir_all(parent).is_ok() {
                // Set directory permissions on Unix
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt as _;
                    let _ = fs::set_permissions(parent, fs::Permissions::from_mode(0o700));
                }
            }
        }

        // Try to read existing key
        if key_path_ref.exists() {
            if let Ok(existing_key) = fs::read_to_string(&key_path_ref) {
                let trimmed = existing_key.trim();
                if let Ok(decoded) = hex::decode(trimmed) {
                    if decoded.len() == 32 {
                        MACHINE_KEY_PERSISTED.store(true, Ordering::SeqCst);
                        return decoded;
                    }
                }
            }
        }

        // Generate new random key (32 bytes is sufficient for AES-256)
        let mut key_buf = [0u8; 32];
        rand::rng().fill(&mut key_buf);

        // Persist the key as hex to avoid UTF-8 corruption
        if write_file_secure(&key_path_ref, &hex::encode(key_buf)).is_ok() {
            MACHINE_KEY_PERSISTED.store(true, Ordering::SeqCst);
            return key_buf.to_vec();
        }
    }

    // Absolute last resort: session-only key
    // This is a critical failure - warn user that data will be lost on restart
    emit_error!(
        Core,
        CORE_CRASHED,
        "Could not persist machine key. Encrypted data will be lost on restart!"
    );
    // Session-only key - will not persist
    // Callers should check is_machine_key_persisted() before storing sensitive data
    let mut key_buf = [0u8; 32];
    rand::rng().fill(&mut key_buf);
    key_buf.to_vec()
}

/// Check if the machine key was successfully persisted
/// Returns false if using a session-only key (data will be lost on restart)
#[tauri::command]
pub fn is_machine_key_persisted() -> bool {
    if !MACHINE_KEY_PERSISTED.load(Ordering::SeqCst) {
        let _key = get_machine_key();
    }
    MACHINE_KEY_PERSISTED.load(Ordering::SeqCst)
}

/// Encrypt a string using AES-256-GCM with the machine key.
/// Returns base64-encoded ciphertext with version prefix and nonce prepended.
/// Format: "v2:" + nonce (12 bytes) + ciphertext + auth tag (16 bytes)
pub(super) fn obfuscate_string(s: &str) -> Result<String, String> {
    use aes_gcm::{
        aead::{Aead as _, KeyInit as _},
        Aes256Gcm, Nonce,
    };

    let key_bytes = get_machine_key();

    if key_bytes.len() != 32 {
        return Err(format!(
            "Invalid key length {}, expected 32",
            key_bytes.len()
        ));
    }

    let cipher = Aes256Gcm::new_from_slice(&key_bytes)
        .map_err(|e| format!("Failed to initialize AES cipher: {e}"))?;

    let nonce_bytes: [u8; 12] = rand::rng().random();
    let nonce: Nonce<_> = nonce_bytes.into();

    let ciphertext = cipher
        .encrypt(&nonce, s.as_bytes())
        .map_err(|e| format!("AES encryption failed: {e}"))?;

    let mut result = b"v2:".to_vec();
    result.extend(&nonce_bytes);
    result.extend(ciphertext);
    Ok(base64_standard.encode(&result))
}

/// Decrypt a string encrypted with AES-256-GCM.
/// Expects base64-encoded ciphertext with "v2:" prefix.
pub(super) fn deobfuscate_string(s: &str) -> Result<String, String> {
    use aes_gcm::{
        aead::{Aead as _, KeyInit as _},
        Aes256Gcm, Nonce,
    };

    let decoded = base64_standard
        .decode(s)
        .map_err(|e| format!("Invalid base64 encoding: {e}"))?;

    if !decoded.starts_with(b"v2:") {
        return Err("Unknown or missing encryption version prefix".to_owned());
    }

    if decoded.len() < 31 {
        return Err("Invalid v2 ciphertext: too short".to_owned());
    }

    let nonce_bytes = decoded
        .get(3..15)
        .ok_or("Invalid ciphertext: missing nonce")?;
    let ciphertext = decoded
        .get(15..)
        .ok_or("Invalid ciphertext: missing data")?;

    let key_bytes = get_machine_key();

    if key_bytes.len() != 32 {
        return Err(format!(
            "Invalid key length {}, expected 32",
            key_bytes.len()
        ));
    }

    let cipher = Aes256Gcm::new_from_slice(&key_bytes)
        .map_err(|e| format!("Failed to initialize AES cipher: {e}"))?;

    let nonce: Nonce<_> = nonce_bytes
        .try_into()
        .map_err(|e| format!("Invalid nonce length: {e}"))?;

    let plaintext = cipher
        .decrypt(&nonce, ciphertext)
        .map_err(|e| format!("AES decryption failed - data may be tampered: {e}"))?;

    String::from_utf8(plaintext).map_err(|e| format!("Decrypted data is not valid UTF-8: {e}"))
}

/// Check whether file content is encrypted (starts with base64-encoded "v2:" prefix).
/// The base64 of the 3-byte prefix `v2:` is `djI6`.
#[must_use]
pub fn is_encrypted_content(content: &str) -> bool {
    content.starts_with("djI6")
}

/// Read a profile file, automatically decrypting if encrypted.
pub fn read_profile_file(path: &Path) -> Result<String, String> {
    let content = fs::read_to_string(path).map_err(|e| format!("Failed to read config: {e}"))?;
    if is_encrypted_content(&content) {
        deobfuscate_string(&content)
    } else {
        Ok(content)
    }
}

/// Write a profile file, encrypting if `encrypt` is true.
///
/// Every caller must hold `crate::PROFILE_CRYPTO_TRANSFORM` for the whole
/// read-flag-and-write sequence, and must keep holding it until the content is
/// at its final path. The encryption batch rewrites every profile in the
/// directory, so a write that is not covered by that guard can land between the
/// batch's read of a file and its write of it, and be overwritten with what the
/// batch read.
///
/// The guard deliberately is not taken here: this function is called from
/// inside sequences that already hold it, and `std::sync::Mutex` is not
/// reentrant — taking it here would deadlock those callers against themselves.
pub fn write_profile_file(path: &Path, content: &str, encrypt: bool) -> Result<(), String> {
    // A session-only key is gone at the next start, so a profile encrypted with
    // it could never be read again. Write plaintext instead, matching the
    // startup reconciliation, which also leaves profiles plaintext in that case.
    let data = if encrypt && is_machine_key_persisted() {
        obfuscate_string(content)?
    } else {
        content.to_owned()
    };
    // Atomic: profiles are read without the transform guard (core start,
    // listings), so an in-place truncate-and-write could be read half-done.
    write_file_secure_atomic(path, &data)
}

/// Write one profile with the current `encrypt_configs` setting, under the
/// profile-transform guard.
///
/// For callers that write a single file and hold neither lock. The guard is
/// taken before the settings lock, matching every other profile writer.
pub fn save_profile_file(app: &tauri::AppHandle, path: &Path, content: &str) -> Result<(), String> {
    let transform_guard = crate::lock_profile_transform();
    let result = write_profile_file(path, content, authoritative_encrypt_configs(app));
    drop(transform_guard);
    result
}

/// Read-modify-write one profile as a single step under the profile-transform
/// guard.
///
/// `edit` receives the decrypted content and returns the new content, or
/// `None` to leave the file untouched. Holding the guard across the read and
/// the write keeps a concurrent single-file save or an encryption batch from
/// landing in between and being overwritten. Returns whether the file was
/// written.
pub fn update_profile_file(
    app: &tauri::AppHandle,
    path: &Path,
    edit: impl FnOnce(&str) -> Option<String>,
) -> Result<bool, String> {
    let transform_guard = crate::lock_profile_transform();
    let result = read_profile_file(path).and_then(|current| {
        let Some(updated) = edit(&current) else {
            return Ok(false);
        };
        write_profile_file(path, &updated, authoritative_encrypt_configs(app)).map(|()| true)
    });
    drop(transform_guard);
    result
}

/// The currently authoritative `encrypt_configs` value.
///
/// Read under the settings lock, so a caller that has already acquired the
/// profile-transform guard sees the value that actually won, rather than the one
/// its own patch happened to persist. Without this, a patch whose write was
/// superseded while it waited for the transform lock would still run its own
/// transform and undo the newer one.
///
/// A poisoned lock is recovered: every settings writer edits a clone and
/// publishes it only after `persist_settings` succeeds, so a panicking holder
/// cannot leave a half-applied `encrypt_configs` behind.
#[must_use]
pub fn authoritative_encrypt_configs(app: &tauri::AppHandle) -> bool {
    app.state::<crate::SettingsState>()
        .0
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .encrypt_configs
}

/// Encrypt all plaintext profile YAML files in `profiles_dir`.
/// Files already encrypted (starting with "djI6") are skipped.
/// Returns an error string with the count of failures (does not abort on individual failures).
pub fn encrypt_all_profiles(profiles_dir: &Path) -> Result<(), String> {
    let entries =
        fs::read_dir(profiles_dir).map_err(|e| format!("Failed to read profiles dir: {e}"))?;
    let mut failures = 0u32;
    for entry in entries.flatten() {
        let path = entry.path();
        let is_yaml = path
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|ext| ext.eq_ignore_ascii_case("yaml") || ext.eq_ignore_ascii_case("yml"));
        if !is_yaml || !path.is_file() {
            continue;
        }
        let content = match fs::read_to_string(&path) {
            Ok(c) => c,
            Err(e) => {
                crate::emit_warn!(
                    Config,
                    CONFIG_ENCRYPT_READ_FAILED,
                    "encrypt: skip {}: {e}",
                    path.display()
                );
                failures += 1;
                continue;
            }
        };
        if is_encrypted_content(&content) {
            continue; // already encrypted
        }
        match obfuscate_string(&content) {
            Ok(encrypted) => {
                if let Err(e) = write_file_secure_atomic(&path, &encrypted) {
                    crate::emit_warn!(
                        Config,
                        CONFIG_ENCRYPT_WRITE_FAILED,
                        "encrypt: write {}: {e}",
                        path.display()
                    );
                    failures += 1;
                }
            }
            Err(e) => {
                crate::emit_warn!(
                    Config,
                    CONFIG_ENCRYPT_FAILED,
                    "encrypt: encrypt {}: {e}",
                    path.display()
                );
                failures += 1;
            }
        }
    }
    if failures > 0 {
        Err(format!("{failures} file(s) failed to encrypt"))
    } else {
        Ok(())
    }
}

/// Decrypt all encrypted profile YAML files in `profiles_dir`.
/// Files not encrypted (not starting with "djI6") are skipped.
/// Returns an error string with the count of failures (does not abort on individual failures).
///
/// `sanitize` names the files whose decrypted content is sanitized
/// (see `sanitize_decrypted_profile`): pass `Some` with the files
/// this import delivered — an imported encrypted profile arrives as
/// an opaque base64 scalar the staging sanitizer cannot see through,
/// so its decrypted content must not land on disk unsanitized. Pass
/// `None` for every other caller (encryption toggle, startup
/// reconciliation): the content is the user's own profile, encrypted
/// from disk as-is, and sanitizing it would strip keys the user
/// configured and discard ordinary comments. Files not in the set
/// are decrypted as-is. When encryption is on, the import reconcile
/// never decrypts, so the same guarantee is provided by
/// `sanitize_imported_encrypted_profiles` instead (decrypt, sanitize,
/// re-encrypt in place).
pub fn decrypt_all_profiles(
    profiles_dir: &Path,
    sanitize: Option<&std::collections::HashSet<PathBuf>>,
) -> Result<(), String> {
    let entries =
        fs::read_dir(profiles_dir).map_err(|e| format!("Failed to read profiles dir: {e}"))?;
    let mut failures = 0u32;
    for entry in entries.flatten() {
        let path = entry.path();
        let is_yaml = path
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|ext| ext.eq_ignore_ascii_case("yaml") || ext.eq_ignore_ascii_case("yml"));
        if !is_yaml || !path.is_file() {
            continue;
        }
        let content = match fs::read_to_string(&path) {
            Ok(c) => c,
            Err(e) => {
                crate::emit_warn!(
                    Config,
                    CONFIG_DECRYPT_READ_FAILED,
                    "decrypt: skip {}: {e}",
                    path.display()
                );
                failures += 1;
                continue;
            }
        };
        if !is_encrypted_content(&content) {
            continue; // already plaintext
        }
        match deobfuscate_string(&content) {
            Ok(decrypted) => {
                // The import staging sanitizer skips encrypted profiles
                // (they arrive as an opaque base64 scalar), so without
                // this the decrypted content would land on disk
                // unsanitized while every plaintext import is stripped.
                // Unparsable content is refused, not written as-is:
                // a multi-document document fails to parse as a whole
                // yet its first document can carry a dangerous key,
                // which would bypass the sanitizer and land on disk.
                // Refusing leaves the profile encrypted, so no
                // unsanitized content is ever written. Only files the
                // import delivered are sanitized; pre-existing profiles
                // decrypt as-is (see the `sanitize` parameter).
                let sanitize_this = sanitize.is_some_and(|set| set.contains(&path));
                let to_write = if sanitize_this {
                    if let Some(clean) = sanitize_decrypted_profile(&decrypted) {
                        clean
                    } else {
                        crate::emit_warn!(
                            Config,
                            CONFIG_DECRYPT_FAILED,
                            "decrypt: refusing to write unparsable decrypted profile {}",
                            path.display()
                        );
                        failures += 1;
                        continue;
                    }
                } else {
                    decrypted
                };
                if let Err(e) = write_file_secure_atomic(&path, &to_write) {
                    crate::emit_warn!(
                        Config,
                        CONFIG_DECRYPT_WRITE_FAILED,
                        "decrypt: write {}: {e}",
                        path.display()
                    );
                    failures += 1;
                }
            }
            Err(e) => {
                crate::emit_warn!(
                    Config,
                    CONFIG_DECRYPT_FAILED,
                    "decrypt: decrypt {}: {e}",
                    path.display()
                );
                failures += 1;
            }
        }
    }
    if failures > 0 {
        Err(format!("{failures} file(s) failed to decrypt"))
    } else {
        Ok(())
    }
}

/// Sanitize imported encrypted profiles in place, for the encryption-on
/// import path: the staging sanitizer cannot see through the base64
/// scalar, and the reconcile encryption branch never decrypts, so
/// without this an imported encrypted profile would sit on disk
/// unsanitized until encryption is turned off — and then decrypt onto
/// disk as-is (see `decrypt_all_profiles`). For each file in
/// `imported`, decrypt it, sanitize the plaintext, and re-encrypt it
/// when the sanitizer changed anything; a file the sanitizer cannot
/// parse is left encrypted and warned about, never written plaintext.
/// Plaintext files are untouched: staging already sanitized them.
/// Returns the files that could not be sanitized (empty when all
/// went through): the caller must not leave those in the profiles
/// dir — they would decrypt onto disk as-is — so it quarantines
/// them instead of warning and continuing.
#[must_use]
pub fn sanitize_imported_encrypted_profiles(
    imported: &std::collections::HashSet<PathBuf>,
) -> Vec<PathBuf> {
    let mut failures: Vec<PathBuf> = Vec::new();
    #[allow(clippy::iter_over_hash_type)]
    for path in imported {
        if !path.is_file() {
            continue;
        }
        let content = match fs::read_to_string(path) {
            Ok(c) => c,
            Err(e) => {
                crate::emit_warn!(
                    Config,
                    CONFIG_DECRYPT_READ_FAILED,
                    "sanitize-import: skip {}: {e}",
                    path.display()
                );
                failures.push(path.clone());
                continue;
            }
        };
        if !is_encrypted_content(&content) {
            continue; // plaintext: staging already sanitized it
        }
        match deobfuscate_string(&content) {
            Ok(decrypted) => {
                let Some(clean) = sanitize_decrypted_profile(&decrypted) else {
                    crate::emit_warn!(
                        Config,
                        CONFIG_DECRYPT_FAILED,
                        "sanitize-import: refusing to rewrite unparsable encrypted profile {}",
                        path.display()
                    );
                    failures.push(path.clone());
                    continue;
                };
                if clean == decrypted {
                    continue;
                }
                match obfuscate_string(&clean) {
                    Ok(encrypted) => {
                        if let Err(e) = write_file_secure_atomic(path, &encrypted) {
                            crate::emit_warn!(
                                Config,
                                CONFIG_DECRYPT_WRITE_FAILED,
                                "sanitize-import: write {}: {e}",
                                path.display()
                            );
                            failures.push(path.clone());
                        }
                    }
                    Err(e) => {
                        crate::emit_warn!(
                            Config,
                            CONFIG_DECRYPT_FAILED,
                            "sanitize-import: encrypt {}: {e}",
                            path.display()
                        );
                        failures.push(path.clone());
                    }
                }
            }
            Err(e) => {
                crate::emit_warn!(
                    Config,
                    CONFIG_DECRYPT_FAILED,
                    "sanitize-import: decrypt {}: {e}",
                    path.display()
                );
                failures.push(path.clone());
            }
        }
    }
    failures
}

/// Strip dangerous keys from a freshly decrypted profile, mirroring
/// the import staging sanitizer (which cannot see through the
/// encryption). A clean document is returned untouched, so its
/// comments survive; only a document the sanitizer rewrites is
/// re-serialized, with the subscription URL / info lines kept like
/// the staging does. Returns `None` when the content cannot be
/// parsed (or re-serialized after a rewrite): the caller must refuse
/// the write, because an unparsable document — a multi-document
/// input, for example — can still carry a dangerous key in its
/// first document.
fn sanitize_decrypted_profile(decrypted: &str) -> Option<String> {
    let Ok(mut value) = serde_yaml::from_str::<serde_yaml::Value>(decrypted) else {
        return None;
    };
    // A tagged root (e.g. `!profile` on a mapping) parses as a Tagged
    // value, not a Mapping: sanitize the tagged document itself.
    let mut target = &mut value;
    while let serde_yaml::Value::Tagged(tagged) = target {
        target = &mut tagged.value;
    }
    if !matches!(
        target,
        serde_yaml::Value::Mapping(_) | serde_yaml::Value::Sequence(_)
    ) {
        return Some(decrypted.to_owned());
    }
    let before = target.clone();
    zephyr_core::config::sanitizer::remove_dangerous_keys_internal_pub(target, false);
    if *target == before {
        return Some(decrypted.to_owned());
    }
    let Ok(serialized) = serde_yaml::to_string(&value) else {
        return None;
    };
    Some(crate::backup::preserve_subscription_comments(
        decrypted, serialized,
    ))
}

// ── Metadata concurrency ────────────────────────────────────────────────

/// Coarse-grained lock serializing all metadata read-modify-write sequences.
///
/// Prevents Lost Update races between user-initiated Tauri commands
/// (`update_config_url`, `delete_config`, `rename_config`, …) and the
/// background subscription scheduler (`download_sub_inner`).
///
/// The lock serializes metadata load-modify-save sequences and may be held
/// across synchronous file operations that are part of the transaction
/// (e.g., `save_metadata`, directory scans in `cleanup_metadata_cache`,
/// file renames in `rename_config` and `download_sub_inner`). It must
/// **never** be held across `.await` points.
///
/// # Poison safety
/// Recovers from poison via [`PoisonError::into_inner`], consistent with
/// the rest of the codebase — a panic in one command does not permanently
/// disable configuration management.
static METADATA_LOCK: Mutex<()> = Mutex::new(());

/// Acquire the global metadata lock.
///
/// The returned guard is dropped automatically at the end of the enclosing
/// scope. **Never hold it across `.await` points** — `std::sync::MutexGuard`
/// is `!Send`, so the compiler will reject that.
pub(crate) fn lock_metadata() -> std::sync::MutexGuard<'static, ()> {
    METADATA_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// # Concurrency
///
/// Safe to call without [`lock_metadata`] for read-only access (atomic
/// write ensures no torn reads). Must hold [`lock_metadata`] if the loaded
/// data will be modified and saved back via [`save_metadata`].
pub(super) fn load_metadata(paths: &AppPaths) -> ProfilesMetadata {
    let meta_path = paths.profiles_dir.join("metadata.json");
    match fs::read_to_string(&meta_path) {
        Ok(data) => match serde_json::from_str::<ProfilesMetadata>(&data) {
            Ok(mut meta) => {
                #[allow(clippy::iter_over_hash_type)]
                for config in meta.configs.values_mut() {
                    if let Some(url) = &config.url {
                        if !url.starts_with("http") {
                            config.url = deobfuscate_string(url).ok();
                        }
                    }
                    if let Some(info) = &config.sub_info {
                        if !info.contains(';') {
                            config.sub_info = deobfuscate_string(info).ok();
                        }
                    }
                }
                meta
            }
            Err(e) => {
                // Try recovering from backup if the primary file is corrupted
                let bak_path = paths.profiles_dir.join("metadata.json.bak");
                if let Ok(bak_data) = fs::read_to_string(&bak_path) {
                    if let Ok(mut meta) = serde_json::from_str::<ProfilesMetadata>(&bak_data) {
                        emit_warn!(
                            Core,
                            CORE_CRASHED,
                            "metadata.json was corrupt, restored from backup: {e}"
                        );
                        #[allow(clippy::iter_over_hash_type)]
                        for config in meta.configs.values_mut() {
                            if let Some(url) = &config.url {
                                if !url.starts_with("http") {
                                    config.url = deobfuscate_string(url).ok();
                                }
                            }
                            if let Some(info) = &config.sub_info {
                                if !info.contains(';') {
                                    config.sub_info = deobfuscate_string(info).ok();
                                }
                            }
                        }
                        return meta;
                    }
                }
                emit_warn!(
                    Core,
                    CORE_CRASHED,
                    "Failed to parse metadata.json: {e}. Using default."
                );
                ProfilesMetadata::default()
            }
        },
        Err(e) => {
            if meta_path.exists() {
                emit_warn!(
                    Core,
                    CORE_CRASHED,
                    "Failed to read metadata.json: {e}. Using default."
                );
            }
            ProfilesMetadata::default()
        }
    }
}

/// # Concurrency
///
/// Callers must hold [`lock_metadata`] before calling this function
/// to prevent Lost Update races.
pub(super) fn save_metadata(paths: &AppPaths, meta: &ProfilesMetadata) -> Result<(), String> {
    let mut obf_meta = ProfilesMetadata::default();
    #[allow(clippy::iter_over_hash_type)]
    for (k, v) in &meta.configs {
        obf_meta.configs.insert(
            k.clone(),
            ConfigMetadata {
                url: v.url.as_ref().and_then(|s| obfuscate_string(s).ok()),
                sub_info: v.sub_info.as_ref().and_then(|s| obfuscate_string(s).ok()),
                last_updated: v.last_updated,
                auto_update_interval: v.auto_update_interval,
                // user_agent is not sensitive — store as-is (no obfuscation)
                user_agent: v.user_agent.clone(),
            },
        );
    }

    let meta_path = paths.profiles_dir.join("metadata.json");
    let data = serde_json::to_string_pretty(&obf_meta)
        .map_err(|e| format!("Failed to serialize metadata: {e}"))?;

    // Durable atomic replace (temp file fsync, rename, directory fsync):
    // readers see either the old or the new file, and a power loss cannot
    // leave an empty metadata.json that load_metadata would read as "no
    // subscriptions". A transient handle that outlives the rename retries
    // falls back to a non-atomic direct write below.
    if let Err(e) = write_file_secure_atomic(&meta_path, &data) {
        // Keep a recoverable copy: an interrupted direct write truncates
        // metadata.json, and load_metadata would then silently degrade to
        // an empty default that the next save persists. Refuse the
        // destructive write when no backup could be made.
        let bak_path = paths.profiles_dir.join("metadata.json.bak");
        if meta_path.exists() && std::fs::copy(&meta_path, &bak_path).is_err() {
            return Err(format!(
                "Failed to persist metadata: atomic rename failed ({e}) and no backup could be created"
            ));
        }
        if let Err(write_err) = write_file_secure(&meta_path, &data) {
            // Restore from backup if the direct write failed
            if let Err(restore_err) = std::fs::rename(&bak_path, &meta_path) {
                emit_warn!(
                    Core,
                    CORE_CRASHED,
                    "metadata.json may be truncated: restore from {} failed: {restore_err}",
                    bak_path.display()
                );
                return Err(format!(
                    "Failed to persist metadata: atomic rename failed ({e}), direct write failed ({write_err}), restore failed ({restore_err}) — recover manually from {}",
                    bak_path.display()
                ));
            }
            return Err(format!("Failed to persist metadata: atomic rename failed ({e}), direct write also failed: {write_err}"));
        }
        // Direct write succeeded — clean up backup
        let _ = std::fs::remove_file(&bak_path);
        emit_warn!(
            Core,
            CORE_CRASHED,
            "Atomic rename of metadata.json failed, used direct write: {e}"
        );
    }

    Ok(())
}

/// Whether a metadata key still names a profile file on disk.
/// The filesystem decides the match (see [`cleanup_metadata_cache`]):
/// a key stored under one spelling still names the file on disk
/// under another on a case-insensitive volume, and names nothing on
/// a case-sensitive one. Only the exact `run_config.yaml` is the
/// generated runtime file; it carries no subscription metadata.
/// Only a direct filename counts: a key carrying a path (such as
/// `../outside.yaml`) names no managed profile even when that file
/// exists. A symlink to a directory does not count either: the
/// listing hides it, so keeping its metadata would attach stale
/// subscription data to a regular profile created under the same
/// name later. A dangling symlink still counts: its target may
/// return, and the metadata keeps the subscription alive meanwhile.
#[allow(clippy::filetype_is_file)]
// `is_file()` is deliberate here: only a regular file or a symlink
// (including a dangling one) counts as a profile. `!is_dir()`, the
// lint's suggestion, would also admit fifos, sockets, and devices.
fn key_names_existing_profile(profiles_dir: &Path, key: &str) -> bool {
    if key == "run_config.yaml" {
        return false;
    }
    if Path::new(key).file_name().and_then(std::ffi::OsStr::to_str) != Some(key) {
        return false;
    }
    let is_yaml = Path::new(key)
        .extension()
        .and_then(std::ffi::OsStr::to_str)
        .is_some_and(|ext| ext.eq_ignore_ascii_case("yaml") || ext.eq_ignore_ascii_case("yml"));
    if !is_yaml {
        return false;
    }
    match profiles_dir.join(key).symlink_metadata() {
        Ok(meta) => {
            let ft = meta.file_type();
            if ft.is_file() {
                return true;
            }
            if !ft.is_symlink() {
                return false;
            }
            // A link whose target cannot be read is still a config:
            // only a confirmed absence (NotFound) means the target is
            // gone. A transient I/O failure must not let the cleanup
            // drop the entry — the config is still on disk.
            match profiles_dir.join(key).metadata() {
                Ok(target) => target.is_file(),
                Err(_) => true,
            }
        }
        // Same rule for the link itself: any error other than NotFound
        // (a transient loss of access to the directory, an I/O
        // failure) keeps the entry — treating it as absent would let
        // the cleanup delete the metadata of a config that is still
        // there.
        Err(e) => e.kind() != std::io::ErrorKind::NotFound,
    }
}

/// Find the metadata entry for a profile file, preferring the exact
/// key and falling back to a case variant that names the same file.
/// The cleanup keeps a key stored under a different spelling than
/// the file on disk (see [`key_names_existing_profile`]), but a
/// plain exact lookup would miss it and the listing would hide the
/// profile's saved URL, update interval, and User-Agent. On a
/// case-sensitive volume the two spellings are distinct files, so
/// the fallback only counts when the filesystem resolves both to
/// the same entry.
pub(super) fn metadata_for_config<'a>(
    metadata: &'a ProfilesMetadata,
    profiles_dir: &Path,
    name: &str,
) -> Option<&'a ConfigMetadata> {
    metadata_key_for_config(metadata, profiles_dir, name).and_then(|key| metadata.configs.get(key))
}

/// The key [`metadata_for_config`] resolves to, for callers that
/// update the entry instead of only reading it (an edit that inserts
/// under the request spelling would otherwise leave a second record
/// beside the existing one, and the listing would prefer the new,
/// empty one). The fallback compares canonicalized paths, not
/// lowercased spellings: on macOS a composed (`café.yaml`, NFC)
/// and a decomposed (`café.yaml`, NFD) name point at the same file
/// but lowercase to different strings, so a lowercase pre-filter
/// would skip the very key the canonical comparison could match.
pub(super) fn metadata_key_for_config<'a>(
    metadata: &'a ProfilesMetadata,
    profiles_dir: &Path,
    name: &str,
) -> Option<&'a str> {
    if let Some((key, _)) = metadata.configs.get_key_value(name) {
        // An exact hit is a stale alias when the file's on-disk
        // spelling differs and names the same file: the alias is left
        // over from an earlier spelling, and the on-disk record is the
        // current one (the listing and the scheduler both read that
        // spelling). Fall through to the canonical fallback below,
        // which prefers the on-disk spelling — otherwise an overwrite
        // under the alias spelling would preserve the alias's stale
        // URL and interval, and the retain after it would delete the
        // current record. A symlink exact hit is not an alias: the
        // link is its own subscription, so it still returns at once.
        let on_disk = super::config_manager::actual_entry_name(profiles_dir, name);
        let stale_alias = !profiles_dir
            .join(name)
            .symlink_metadata()
            .is_ok_and(|m| m.file_type().is_symlink())
            && on_disk.as_str() != name
            && metadata.configs.contains_key(&on_disk);
        if !stale_alias {
            return Some(key.as_str());
        }
    }
    // A symlink entry resolves to its target: without this guard,
    // `alias.yaml -> target.yaml` would match the target's metadata key,
    // and URL/interval updates meant for the alias would be written into
    // the target's record instead — the alias would never get its own.
    // Only regular files go through the canonical fallback (NFC/NFD
    // spellings of the same file still match; they are not symlinks).
    if profiles_dir
        .join(name)
        .symlink_metadata()
        .is_ok_and(|m| m.file_type().is_symlink())
    {
        return None;
    }
    let resolved = profiles_dir.join(name).canonicalize().ok()?;
    let on_disk = super::config_manager::actual_entry_name(profiles_dir, name);
    metadata
        .configs
        .keys()
        .filter_map(|key| {
            // A candidate that is itself a symlink is a different
            // config, not a spelling of this file: without this, a
            // metadata record filed under `alias.yaml` would be
            // claimed by a lookup for its `target.yaml` (the same
            // guard as the query-name check above, on the other side).
            if profiles_dir
                .join(key)
                .symlink_metadata()
                .is_ok_and(|m| m.file_type().is_symlink())
            {
                return None;
            }
            let key_resolved = profiles_dir.join(key).canonicalize().ok()?;
            (key_resolved == resolved).then_some(key.as_str())
        })
        .min_by(|a, b| {
            // The on-disk spelling is the profile the listing and the
            // scheduler read; any other spelling is an alias left over
            // from an earlier spelling. Between aliases, the smallest
            // spelling wins deterministically — a `HashMap` scan would
            // pick a different one per process.
            match (*a == on_disk.as_str(), *b == on_disk.as_str()) {
                (true, false) => std::cmp::Ordering::Less,
                (false, true) => std::cmp::Ordering::Greater,
                _ => a.cmp(b),
            }
        })
}

/// Clean up metadata entries for configs that no longer exist on disk.
///
/// Acquires the metadata lock for the entire scan-modify-save sequence.
/// The directory scan is performed under the lock to prevent TOCTOU races:
/// if the scan were outside the lock, a concurrent writer could create a file
/// between the scan and the metadata modification, causing its entry to be
/// erroneously removed.
pub(super) fn cleanup_metadata_cache(paths: &AppPaths) {
    let _guard = lock_metadata();
    let mut metadata = load_metadata(paths);
    let mut changed = false;

    // Remove metadata entries for deleted configs. A key names a file
    // the way the filesystem does: ask the filesystem, not the
    // platform. Assuming macOS is case-insensitive would retain a
    // deleted profile's metadata on a case-sensitive volume (and a
    // later update could use its stale URL to recreate the profile).
    // `symlink_metadata` resolves the name case-insensitively on a
    // case-insensitive volume and exactly on a case-sensitive one,
    // and it sees a dangling symlink as a present entry. The scan
    // runs under the lock, so a concurrent writer cannot create a
    // file between the check and the metadata save. Directories are
    // not profiles.
    let keys_to_remove: Vec<String> = metadata
        .configs
        .keys()
        .filter(|key| !key_names_existing_profile(&paths.profiles_dir, key))
        .cloned()
        .collect();

    for key in keys_to_remove {
        metadata.configs.remove(&key);
        changed = true;
    }

    if changed {
        if let Err(e) = save_metadata(paths, &metadata) {
            emit_warn!(
                Core,
                CORE_CRASHED,
                "Failed to save metadata during cleanup: {e}"
            );
        }
    }
}

// ── Test-only wrappers ─────────────────────────────────────────────────────

#[cfg(test)]
#[allow(
    clippy::needless_borrows_for_generic_args,
    clippy::indexing_slicing,
    clippy::missing_const_for_fn
)]
pub mod test_helpers {
    use super::*;

    /// Encrypt a string with AES-256-GCM using an explicit key (test-only)
    /// so that tests do not depend on machine state.
    #[must_use]
    pub fn obfuscate_with_key(plaintext: &str, key: &[u8]) -> String {
        use aes_gcm::{
            aead::{Aead as _, KeyInit as _},
            Aes256Gcm, Nonce,
        };

        if key.len() != 32 {
            return String::new();
        }

        let cipher = match Aes256Gcm::new_from_slice(key) {
            Ok(c) => c,
            Err(_) => return String::new(),
        };

        let nonce_bytes: [u8; 12] = rand::rng().random();
        let nonce: Nonce<_> = nonce_bytes.into();

        match cipher.encrypt(&nonce, plaintext.as_bytes()) {
            Ok(ciphertext) => {
                let mut result = b"v2:".to_vec();
                result.extend(&nonce_bytes);
                result.extend(ciphertext);
                base64_standard.encode(&result)
            }
            Err(_) => String::new(),
        }
    }

    /// Decrypt a string encrypted with AES-256-GCM using an explicit key (test-only).
    #[must_use]
    pub fn deobfuscate_with_key(ciphertext: &str, key: &[u8]) -> String {
        use aes_gcm::{
            aead::{Aead as _, KeyInit as _},
            Aes256Gcm,
        };

        let Ok(decoded) = base64_standard.decode(ciphertext) else {
            return String::new();
        };

        if !decoded.starts_with(b"v2:") || decoded.len() < 31 {
            return String::new();
        }

        if key.len() != 32 {
            return String::new();
        }

        let nonce_bytes = &decoded[3..15];
        let ct = &decoded[15..];

        let Ok(cipher) = Aes256Gcm::new_from_slice(key) else {
            return String::new();
        };

        let Ok(nonce) = nonce_bytes.try_into() else {
            return String::new();
        };

        match cipher.decrypt(&nonce, ct) {
            Ok(pt) => String::from_utf8_lossy(&pt).into_owned(),
            Err(_) => String::new(),
        }
    }

    /// Derive a deterministic 32-byte key from a machine-id string using PBKDF2 (test-only).
    /// Mirrors the production key-derivation logic so tests can verify determinism
    /// without touching real hardware fingerprints.
    #[must_use]
    pub fn derive_key(machine_id: &str) -> [u8; 32] {
        use pbkdf2::pbkdf2_hmac;
        use sha2::Sha256;

        const SALT: &[u8] = b"Zephyr_AES256_Key_Derivation";
        let mut derived_key = [0u8; 32];
        pbkdf2_hmac::<Sha256>(machine_id.as_bytes(), SALT, 100_000, &mut derived_key);
        derived_key
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::test_helpers::*;
    use rand::RngExt as _;

    fn random_test_key() -> [u8; 32] {
        rand::rng().random()
    }

    /// Whether `dir` tells apart filenames that differ only by case.
    /// Probed at runtime, not by OS: the CI macOS runner's APFS
    /// volume is case-insensitive, so `foo.yaml` and `FOO.yaml` are
    /// one file there, while a case-sensitive volume holds both.
    fn dir_is_case_sensitive(dir: &std::path::Path) -> bool {
        let probe = dir.join("zephyr_case_probe");
        let _ = std::fs::create_dir_all(&probe);
        let _ = std::fs::write(probe.join("probe.yaml"), b"");
        let _ = std::fs::write(probe.join("PROBE.yaml"), b"");
        let count = std::fs::read_dir(&probe)
            .map(std::iter::Iterator::count)
            .unwrap_or(0);
        let _ = std::fs::remove_dir_all(&probe);
        count >= 2
    }

    #[test]
    fn test_encrypt_decrypt_roundtrip() {
        let key = random_test_key();
        let plaintext = "Hello, World!";
        let encrypted = obfuscate_with_key(plaintext, &key);
        assert_ne!(encrypted, plaintext);
        let decrypted = deobfuscate_with_key(&encrypted, &key);
        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn test_encrypt_empty_string() {
        let key = random_test_key();
        let encrypted = obfuscate_with_key("", &key);
        let decrypted = deobfuscate_with_key(&encrypted, &key);
        assert_eq!(decrypted, "");
    }

    #[test]
    fn test_encrypt_long_string() {
        let key = random_test_key();
        let plaintext = "a".repeat(10000);
        let encrypted = obfuscate_with_key(&plaintext, &key);
        let decrypted = deobfuscate_with_key(&encrypted, &key);
        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn test_encrypt_unicode() {
        let key = random_test_key();
        let plaintext =
            "\u{4f60}\u{597d}\u{4e16}\u{754c} \u{1f30d} \u{3053}\u{3093}\u{306b}\u{3061}\u{306f}";
        let encrypted = obfuscate_with_key(plaintext, &key);
        let decrypted = deobfuscate_with_key(&encrypted, &key);
        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn test_encrypt_produces_different_ciphertexts() {
        let key = random_test_key();
        let plaintext = "same input";
        let e1 = obfuscate_with_key(plaintext, &key);
        let e2 = obfuscate_with_key(plaintext, &key);
        assert_ne!(e1, e2);
    }

    #[test]
    fn test_decrypt_wrong_key_fails() {
        let key1 = random_test_key();
        let mut key2 = key1;
        key2[0] ^= 0xFF;
        let plaintext = "secret data";
        let encrypted = obfuscate_with_key(plaintext, &key1);
        let decrypted = deobfuscate_with_key(&encrypted, &key2);
        assert_ne!(decrypted, plaintext);
    }

    #[test]
    fn test_decrypt_wrong_key_returns_empty() {
        let key1 = random_test_key();
        let mut key2 = key1;
        key2[0] ^= 0xFF;
        let plaintext = "secret data";
        let encrypted = obfuscate_with_key(plaintext, &key1);
        let decrypted = deobfuscate_with_key(&encrypted, &key2);
        assert_eq!(decrypted, "");
    }

    #[test]
    fn test_decrypt_invalid_base64() {
        let key = random_test_key();
        let decrypted = deobfuscate_with_key("not-valid-base64!!!", &key);
        assert_eq!(decrypted, "");
    }

    #[test]
    fn test_decrypt_garbage_input() {
        let key = random_test_key();
        let decrypted = deobfuscate_with_key("", &key);
        assert_eq!(decrypted, "");
    }

    #[test]
    fn test_derive_key_deterministic() {
        let machine_id: String = rand::rng()
            .sample_iter(rand::distr::Alphanumeric)
            .take(16)
            .map(char::from)
            .collect();
        let k1 = derive_key(&machine_id);
        let k2 = derive_key(&machine_id);
        assert_eq!(k1, k2);
    }

    #[test]
    fn test_derive_key_different_inputs() {
        let m1: String = rand::rng()
            .sample_iter(rand::distr::Alphanumeric)
            .take(16)
            .map(char::from)
            .collect();
        let m2: String = format!("{m1}_different");
        let k1 = derive_key(&m1);
        let k2 = derive_key(&m2);
        assert_ne!(k1, k2);
    }

    #[test]
    fn test_derive_key_empty_input() {
        let k1 = derive_key("");
        let k2 = derive_key("");
        assert_eq!(k1, k2);
        assert_eq!(k1.len(), 32);
    }

    #[test]
    fn test_derive_key_roundtrip() {
        let machine_id: String = rand::rng()
            .sample_iter(rand::distr::Alphanumeric)
            .take(16)
            .map(char::from)
            .collect();
        let key = derive_key(&machine_id);
        let plaintext = "derived key integration test";
        let encrypted = obfuscate_with_key(plaintext, &key);
        let decrypted = deobfuscate_with_key(&encrypted, &key);
        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn test_encrypt_with_derived_key_different_from_zero_key() {
        let machine_id = "test-machine-id";
        let derived = derive_key(machine_id);
        assert!(derived.iter().any(|&b| b != 0));
    }

    #[test]
    fn cleanup_metadata_cache_uses_filesystem_identity() {
        // `foo.yaml` and `FOO.yaml` are distinct files on a
        // case-sensitive volume: a key for the deleted one must go
        // even though a case variant survives. On a
        // case-insensitive volume the two spellings name one file,
        // so the same filesystem check keeps both keys.
        let unique = format!("zephyr_test_meta_cache_{}", std::process::id());
        let dir = std::env::temp_dir().join(&unique);
        std::fs::create_dir_all(&dir).unwrap();
        let case_sensitive = dir_is_case_sensitive(&dir);
        let paths = super::AppPaths {
            app_data_dir: dir.clone(),
            core_dir: dir.clone(),
            profiles_dir: dir.clone(),
        };
        std::fs::write(dir.join("FOO.yaml"), "port: 7890\n").unwrap();
        let mut metadata = super::ProfilesMetadata::default();
        metadata.configs.insert(
            "foo.yaml".to_owned(),
            super::ConfigMetadata {
                url: Some("https://example.com/a".to_owned()),
                ..Default::default()
            },
        );
        metadata.configs.insert(
            "FOO.yaml".to_owned(),
            super::ConfigMetadata {
                url: Some("https://example.com/b".to_owned()),
                ..Default::default()
            },
        );
        super::save_metadata(&paths, &metadata).unwrap();
        super::cleanup_metadata_cache(&paths);
        let kept = super::load_metadata(&paths);
        if case_sensitive {
            assert!(!kept.configs.contains_key("foo.yaml"));
        } else {
            // Both spellings name the surviving file.
            assert!(kept.configs.contains_key("foo.yaml"));
        }
        assert!(kept.configs.contains_key("FOO.yaml"));

        // A directory carrying a YAML extension is not a profile:
        // its metadata must not survive the cleanup.
        std::fs::remove_file(dir.join("FOO.yaml")).unwrap();
        std::fs::create_dir(dir.join("FOO.yaml")).unwrap();
        super::save_metadata(&paths, &metadata).unwrap();
        super::cleanup_metadata_cache(&paths);
        let kept = super::load_metadata(&paths);
        assert!(!kept.configs.contains_key("FOO.yaml"));
        assert!(!kept.configs.contains_key("foo.yaml"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn key_names_existing_profile_rejects_paths_and_directory_links() {
        let unique = format!("zephyr_test_key_profile_{}", std::process::id());
        let dir = std::env::temp_dir().join(&unique);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("foo.yaml"), "port: 7890\n").unwrap();
        // A key carrying a path is not a managed profile, even when
        // the file it points at exists outside the directory.
        let outside_name = format!("zephyr_outside_{}.yaml", std::process::id());
        std::fs::write(dir.parent().unwrap().join(&outside_name), "port: 7891\n").unwrap();
        assert!(!super::key_names_existing_profile(
            &dir,
            &format!("../{outside_name}")
        ));
        assert!(!super::key_names_existing_profile(&dir, "sub/foo.yaml"));
        assert!(super::key_names_existing_profile(&dir, "foo.yaml"));
        assert!(!super::key_names_existing_profile(&dir, "run_config.yaml"));
        // A symlink to a directory is not a profile: the listing
        // hides it, so its metadata must not survive the cleanup.
        // A dangling symlink still counts: its target may return.
        // (Symlink creation needs privileges on Windows, so these
        // cases only run on unix.)
        #[cfg(unix)]
        {
            std::fs::create_dir(dir.join("realdir")).unwrap();
            std::os::unix::fs::symlink(dir.join("realdir"), dir.join("link.yaml")).unwrap();
            assert!(!super::key_names_existing_profile(&dir, "link.yaml"));
            std::os::unix::fs::symlink(dir.join("missing.yaml"), dir.join("dangling.yaml"))
                .unwrap();
            assert!(super::key_names_existing_profile(&dir, "dangling.yaml"));
            std::os::unix::fs::symlink(dir.join("foo.yaml"), dir.join("alias.yaml")).unwrap();
            assert!(super::key_names_existing_profile(&dir, "alias.yaml"));
        }

        let _ = std::fs::remove_file(dir.parent().unwrap().join(&outside_name));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn metadata_for_config_prefers_exact_key() {
        let unique = format!("zephyr_test_meta_lookup_{}", std::process::id());
        let dir = std::env::temp_dir().join(&unique);
        std::fs::create_dir_all(&dir).unwrap();
        let case_sensitive = dir_is_case_sensitive(&dir);
        std::fs::write(dir.join("FOO.yaml"), "port: 7890\n").unwrap();
        std::fs::write(dir.join("foo.yaml"), "port: 7891\n").unwrap();
        let mut metadata = super::ProfilesMetadata::default();
        metadata.configs.insert(
            "FOO.yaml".to_owned(),
            super::ConfigMetadata {
                url: Some("https://example.com/upper".to_owned()),
                ..Default::default()
            },
        );
        metadata.configs.insert(
            "foo.yaml".to_owned(),
            super::ConfigMetadata {
                url: Some("https://example.com/lower".to_owned()),
                ..Default::default()
            },
        );
        // Exact match wins when both spellings coexist as distinct
        // files. On a case-insensitive volume the two writes land on
        // one file, whose on-disk spelling is the first one written:
        // a lookup for the other spelling is a stale alias, so it
        // returns the on-disk record instead of the alias's own —
        // otherwise an overwrite under the alias spelling would
        // preserve the alias's stale URL and delete the current
        // record. (Only exercisable on a case-insensitive volume;
        // on Linux the two spellings are distinct files and the
        // exact-key branch is what runs.)
        let found = super::metadata_for_config(&metadata, &dir, "FOO.yaml").unwrap();
        assert_eq!(found.url.as_deref(), Some("https://example.com/upper"));
        let found = super::metadata_for_config(&metadata, &dir, "foo.yaml").unwrap();
        if case_sensitive {
            assert_eq!(found.url.as_deref(), Some("https://example.com/lower"));
        } else {
            assert_eq!(found.url.as_deref(), Some("https://example.com/upper"));
        }
        assert!(super::metadata_for_config(&metadata, &dir, "bar.yaml").is_none());

        // A case-variant key alone does not match on a
        // case-sensitive volume: the key names a different (missing)
        // file, so the fallback must not conflate it. On a
        // case-insensitive volume both spellings name the same file,
        // so the variant key is the file's record.
        let mut metadata = super::ProfilesMetadata::default();
        metadata.configs.insert(
            "foo.yaml".to_owned(),
            super::ConfigMetadata {
                url: Some("https://example.com/lower".to_owned()),
                ..Default::default()
            },
        );
        if case_sensitive {
            assert!(super::metadata_for_config(&metadata, &dir, "FOO.yaml").is_none());
        } else {
            let found = super::metadata_for_config(&metadata, &dir, "FOO.yaml").unwrap();
            assert_eq!(found.url.as_deref(), Some("https://example.com/lower"));
        }

        let _ = std::fs::remove_dir_all(&dir);
    }
}
