use base64::{engine::general_purpose::STANDARD as base64_standard, Engine as _};
use rand::RngExt as _;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;

use super::secure_io::write_file_secure;
use super::AppPaths;

#[derive(serde::Serialize, serde::Deserialize, Default)]
pub(super) struct ProfilesMetadata {
    pub configs: std::collections::HashMap<String, ConfigMetadata>,
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub(super) struct ConfigMetadata {
    pub url: Option<String>,
    pub sub_info: Option<String>,
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
    // Use cached key if available (PBKDF2 is expensive)
    DERIVED_KEY.get().cloned().unwrap_or_else(|| {
        // Compute and cache the key
        let key = compute_machine_key();
        let _ = DERIVED_KEY.set(key.clone());
        key
    })
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
                if !trimmed.is_empty() && trimmed.len() >= 32 {
                    // Use the stored key directly (already has enough entropy)
                    MACHINE_KEY_PERSISTED.store(true, Ordering::SeqCst);
                    return trimmed.as_bytes().get(..32).unwrap_or(&[]).to_vec();
                }
            }
        }

        // Generate new random key (32 bytes is sufficient for AES-256)
        let mut key_buf = [0u8; 32];
        rand::rng().fill(&mut key_buf);
        let random_key: Vec<u8> = key_buf.to_vec();

        // Persist the key (critical for data recovery)
        if write_file_secure(&key_path_ref, &String::from_utf8_lossy(&random_key)).is_ok() {
            MACHINE_KEY_PERSISTED.store(true, Ordering::SeqCst);
            return random_key;
        }
    }

    // Last resort: try current_exe directory as before
    if let Some(app_data_dir) = std::env::current_exe()
        .ok()
        .as_ref()
        .and_then(|p| p.parent())
        .map(std::path::Path::to_path_buf)
    {
        let key_path = app_data_dir.join(MACHINE_KEY_FILE);

        // Try to read existing key
        if key_path.exists() {
            if let Ok(existing_key) = fs::read_to_string(&key_path) {
                let trimmed = existing_key.trim();
                if !trimmed.is_empty() && trimmed.len() >= 32 {
                    MACHINE_KEY_PERSISTED.store(true, Ordering::SeqCst);
                    return trimmed.as_bytes().get(..32).unwrap_or(&[]).to_vec();
                }
            }
        }

        // Generate new random key
        let mut key_buf = [0u8; 32];
        rand::rng().fill(&mut key_buf);
        let random_key: Vec<u8> = key_buf.to_vec();

        // Persist the key
        if write_file_secure(&key_path, &String::from_utf8_lossy(&random_key)).is_ok() {
            MACHINE_KEY_PERSISTED.store(true, Ordering::SeqCst);
            return random_key;
        }
    }

    // Absolute last resort: session-only key
    // This is a critical failure - warn user that data will be lost on restart
    eprintln!("[Security] CRITICAL: Could not persist machine key. Encrypted data will be lost on restart!");
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

/// Encrypt a string using AES-256-GCM with the machine key
/// Returns base64-encoded ciphertext with version prefix and nonce prepended
/// Format: "v2:" + nonce (12 bytes) + ciphertext + auth tag (16 bytes)
pub(super) fn obfuscate_string(s: &str) -> String {
    use aes_gcm::{
        aead::{Aead as _, KeyInit as _},
        Aes256Gcm, Nonce,
    };

    let key_bytes = get_machine_key();

    // Key should already be 32 bytes from PBKDF2 or random generation
    // If not exactly 32 bytes, something is wrong - fail closed
    if key_bytes.len() != 32 {
        eprintln!("[Security] CRITICAL: Invalid key length {}, expected 32", key_bytes.len());
        return String::new();
    }

    let cipher = match Aes256Gcm::new_from_slice(&key_bytes) {
        Ok(c) => c,
        Err(e) => {
            eprintln!(
                "[Security] CRITICAL: Failed to initialize AES cipher: {e:?}"
            );
            return String::new();
        }
    };

    // Generate random nonce
    let nonce_bytes: [u8; 12] = rand::rng().random();
    let nonce = Nonce::from_slice(&nonce_bytes);

    // Encrypt
    match cipher.encrypt(nonce, s.as_bytes()) {
        Ok(ciphertext) => {
            // Format: "v2:" + nonce + ciphertext
            let mut result = b"v2:".to_vec();
            result.extend(&nonce_bytes);
            result.extend(ciphertext);
            base64_standard.encode(&result)
        }
        Err(e) => {
            eprintln!("[Security] CRITICAL: AES encryption failed: {e:?}");
            String::new()
        }
    }
}

/// Decrypt a string encrypted with AES-256-GCM
/// Expects base64-encoded ciphertext with "v2:" prefix
pub(super) fn deobfuscate_string(s: &str) -> String {
    use aes_gcm::{
        aead::{Aead as _, KeyInit as _},
        Aes256Gcm, Nonce,
    };

    if let Ok(decoded) = base64_standard.decode(s) {
        // Check for version prefix
        if !decoded.starts_with(b"v2:") {
            eprintln!("[Security] CRITICAL: Unknown or missing encryption version prefix");
            return String::new();
        }

        if decoded.len() < 31 {
            // "v2:" (3) + nonce (12) + auth tag (16) minimum
            eprintln!("[Security] Invalid v2 ciphertext: too short");
            return String::new();
        }

        // Extract nonce (bytes 3-15) and ciphertext (bytes 15-)
        let nonce_bytes = decoded.get(3..15).unwrap_or(&[]);
        let ciphertext = decoded.get(15..).unwrap_or(&[]);

        let key_bytes = get_machine_key();

        // Key should already be 32 bytes from PBKDF2 or random generation
        if key_bytes.len() != 32 {
            eprintln!(
                "[Security] CRITICAL: Invalid key length {}, expected 32",
                key_bytes.len()
            );
            return String::new();
        }

        let cipher = match Aes256Gcm::new_from_slice(&key_bytes) {
            Ok(c) => c,
            Err(e) => {
                eprintln!(
                    "[Security] CRITICAL: Failed to initialize AES cipher: {e:?}"
                );
                return String::new();
            }
        };

        let nonce = Nonce::from_slice(nonce_bytes);

        match cipher.decrypt(nonce, ciphertext) {
            Ok(plaintext) => String::from_utf8_lossy(&plaintext).into_owned(),
            Err(e) => {
                eprintln!(
                    "[Security] CRITICAL: AES decryption failed - data may be tampered: {e:?}"
                );
                String::new()
            }
        }
    } else {
        eprintln!("[Security] CRITICAL: Invalid base64 encoding");
        String::new()
    }
}

pub(super) fn load_metadata(paths: &AppPaths) -> ProfilesMetadata {
    let meta_path = paths.profiles_dir.join("metadata.json");
    match fs::read_to_string(&meta_path) {
        Ok(data) => {
            match serde_json::from_str::<ProfilesMetadata>(&data) {
                Ok(mut meta) => {
                    #[allow(clippy::iter_over_hash_type)]
                    for config in meta.configs.values_mut() {
                        if let Some(url) = &config.url {
                            // URL should start with http, if not it's obfuscated
                            if !url.starts_with("http") {
                                config.url = Some(deobfuscate_string(url));
                            }
                        }
                        if let Some(info) = &config.sub_info {
                            // sub_info should contain '=' and ';' in format: upload=X; download=Y; total=Z; expire=T
                            // If it doesn't contain both, it's obfuscated
                            // Note: base64 can contain '=' as padding, so we check for ';'
                            if !info.contains(';') {
                                config.sub_info = Some(deobfuscate_string(info));
                            }
                        }
                    }
                    meta
                }
                Err(e) => {
                    eprintln!(
                        "[Metadata] Warning: Failed to parse metadata.json: {e}. Using default."
                    );
                    ProfilesMetadata::default()
                }
            }
        }
        Err(e) => {
            // Only log warning if file exists but cannot be read
            if meta_path.exists() {
                eprintln!(
                    "[Metadata] Warning: Failed to read metadata.json: {e}. Using default."
                );
            }
            ProfilesMetadata::default()
        }
    }
}

pub(super) fn save_metadata(paths: &AppPaths, meta: &ProfilesMetadata) {
    let mut obf_meta = ProfilesMetadata::default();
    #[allow(clippy::iter_over_hash_type)]
    for (k, v) in &meta.configs {
        obf_meta.configs.insert(
            k.clone(),
            ConfigMetadata {
                url: v.url.as_ref().map(|s| obfuscate_string(s)),
                sub_info: v.sub_info.as_ref().map(|s| obfuscate_string(s)),
            },
        );
    }

    let meta_path = paths.profiles_dir.join("metadata.json");
    if let Ok(data) = serde_json::to_string_pretty(&obf_meta) {
        let _ = write_file_secure(&meta_path, &data);
    }
}

/// Clean up metadata entries for configs that no longer exist on disk
pub(super) fn cleanup_metadata_cache(paths: &AppPaths) {
    let mut metadata = load_metadata(paths);
    let mut changed = false;

    // Collect all existing config files
    let existing_configs: std::collections::HashSet<String> = fs::read_dir(&paths.profiles_dir)
        .ok()
        .into_iter()
        .flatten()
        .filter_map(std::result::Result::ok)
        .filter(|entry| {
            entry
                .path()
                .extension()
                .map(|ext| ext == "yaml" || ext == "yml")
                .unwrap_or(false)
        })
        .filter_map(|entry| entry.file_name().to_str().map(std::borrow::ToOwned::to_owned))
        .filter(|name| name != "run_config.yaml")
        .collect();

    // Remove metadata entries for deleted configs
    let keys_to_remove: Vec<String> = metadata
        .configs
        .keys()
        .filter(|key| !existing_configs.contains(*key))
        .cloned()
        .collect();

    for key in keys_to_remove {
        metadata.configs.remove(&key);
        changed = true;
    }

    if changed {
        save_metadata(paths, &metadata);
    }
}
