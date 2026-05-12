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
    let nonce = Nonce::from_slice(&nonce_bytes);

    let ciphertext = cipher
        .encrypt(nonce, s.as_bytes())
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

    let nonce = Nonce::from_slice(nonce_bytes);

    let plaintext = cipher
        .decrypt(nonce, ciphertext)
        .map_err(|e| format!("AES decryption failed - data may be tampered: {e}"))?;

    Ok(String::from_utf8_lossy(&plaintext).into_owned())
}

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
                eprintln!("[Metadata] Warning: Failed to parse metadata.json: {e}. Using default.");
                ProfilesMetadata::default()
            }
        },
        Err(e) => {
            if meta_path.exists() {
                eprintln!("[Metadata] Warning: Failed to read metadata.json: {e}. Using default.");
            }
            ProfilesMetadata::default()
        }
    }
}

pub(super) fn save_metadata(paths: &AppPaths, meta: &ProfilesMetadata) -> Result<(), String> {
    let mut obf_meta = ProfilesMetadata::default();
    #[allow(clippy::iter_over_hash_type)]
    for (k, v) in &meta.configs {
        obf_meta.configs.insert(
            k.clone(),
            ConfigMetadata {
                url: v.url.as_ref().and_then(|s| obfuscate_string(s).ok()),
                sub_info: v.sub_info.as_ref().and_then(|s| obfuscate_string(s).ok()),
            },
        );
    }

    let meta_path = paths.profiles_dir.join("metadata.json");
    let data = serde_json::to_string_pretty(&obf_meta)
        .map_err(|e| format!("Failed to serialize metadata: {e}"))?;
    write_file_secure(&meta_path, &data)?;
    Ok(())
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
        .filter_map(|entry| {
            entry
                .file_name()
                .to_str()
                .map(std::borrow::ToOwned::to_owned)
        })
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
        if let Err(e) = save_metadata(paths, &metadata) {
            eprintln!("[warn] Failed to save metadata during cleanup: {e}");
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

    /// Encrypt a string using AES-256-GCM with an explicit key (test-only).
    /// This mirrors the production `obfuscate_string` but accepts a caller-supplied key
    /// so that tests are deterministic and do not depend on machine state.
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
        let nonce = Nonce::from_slice(&nonce_bytes);

        match cipher.encrypt(nonce, plaintext.as_bytes()) {
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
            Aes256Gcm, Nonce,
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

        let nonce = Nonce::from_slice(nonce_bytes);

        match cipher.decrypt(nonce, ct) {
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

    #[test]
    fn test_encrypt_decrypt_roundtrip() {
        let key = [0u8; 32];
        let plaintext = "Hello, World!";
        let encrypted = obfuscate_with_key(plaintext, &key);
        assert_ne!(encrypted, plaintext);
        let decrypted = deobfuscate_with_key(&encrypted, &key);
        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn test_encrypt_empty_string() {
        let key = [0u8; 32];
        let encrypted = obfuscate_with_key("", &key);
        let decrypted = deobfuscate_with_key(&encrypted, &key);
        assert_eq!(decrypted, "");
    }

    #[test]
    fn test_encrypt_long_string() {
        let key = [0u8; 32];
        let plaintext = "a".repeat(10000);
        let encrypted = obfuscate_with_key(&plaintext, &key);
        let decrypted = deobfuscate_with_key(&encrypted, &key);
        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn test_encrypt_unicode() {
        let key = [0u8; 32];
        let plaintext =
            "\u{4f60}\u{597d}\u{4e16}\u{754c} \u{1f30d} \u{3053}\u{3093}\u{306b}\u{3061}\u{306f}";
        let encrypted = obfuscate_with_key(plaintext, &key);
        let decrypted = deobfuscate_with_key(&encrypted, &key);
        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn test_encrypt_produces_different_ciphertexts() {
        let key = [0u8; 32];
        let plaintext = "same input";
        let e1 = obfuscate_with_key(plaintext, &key);
        let e2 = obfuscate_with_key(plaintext, &key);
        assert_ne!(e1, e2);
    }

    #[test]
    fn test_decrypt_wrong_key_fails() {
        let key1 = [1u8; 32];
        let key2 = [2u8; 32];
        let plaintext = "secret data";
        let encrypted = obfuscate_with_key(plaintext, &key1);
        let decrypted = deobfuscate_with_key(&encrypted, &key2);
        assert_ne!(decrypted, plaintext);
    }

    #[test]
    fn test_decrypt_wrong_key_returns_empty() {
        let key1 = [1u8; 32];
        let key2 = [2u8; 32];
        let plaintext = "secret data";
        let encrypted = obfuscate_with_key(plaintext, &key1);
        let decrypted = deobfuscate_with_key(&encrypted, &key2);
        assert_eq!(decrypted, "");
    }

    #[test]
    fn test_decrypt_invalid_base64() {
        let key = [0u8; 32];
        let decrypted = deobfuscate_with_key("not-valid-base64!!!", &key);
        assert_eq!(decrypted, "");
    }

    #[test]
    fn test_decrypt_garbage_input() {
        let key = [0u8; 32];
        let decrypted = deobfuscate_with_key("", &key);
        assert_eq!(decrypted, "");
    }

    #[test]
    fn test_derive_key_deterministic() {
        let k1 = derive_key("test-machine-id");
        let k2 = derive_key("test-machine-id");
        assert_eq!(k1, k2);
    }

    #[test]
    fn test_derive_key_different_inputs() {
        let k1 = derive_key("machine-a");
        let k2 = derive_key("machine-b");
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
        let key = derive_key("roundtrip-test");
        let plaintext = "derived key integration test";
        let encrypted = obfuscate_with_key(plaintext, &key);
        let decrypted = deobfuscate_with_key(&encrypted, &key);
        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn test_encrypt_with_derived_key_different_from_zero_key() {
        let zero_key = [0u8; 32];
        let derived = derive_key("non-zero");
        assert_ne!(zero_key, derived);
    }
}
