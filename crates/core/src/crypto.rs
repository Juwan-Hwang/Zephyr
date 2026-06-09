use crate::error::AppError;
use base64::Engine as _;
use rand::Rng as _;

/// Encrypt a string using AES-256-GCM with the provided key.
/// Returns base64-encoded ciphertext with "v2:" prefix and nonce prepended.
///
/// Key management is platform-specific:
/// - Desktop: hardware fingerprints via `get_machine_key()`
/// - Android: Android Keystore
/// - iOS: Keychain
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn encrypt_with_key(key: Vec<u8>, plaintext: String) -> Result<String, AppError> {
    obfuscate_string(&key, &plaintext)
}

/// Decrypt a string encrypted with AES-256-GCM.
/// Expects base64-encoded ciphertext with "v2:" prefix.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn decrypt_with_key(key: Vec<u8>, ciphertext: String) -> Result<String, AppError> {
    deobfuscate_string(&key, &ciphertext)
}

/// Internal: Encrypt a string using AES-256-GCM with the provided key.
pub fn obfuscate_string(key: &[u8], plaintext: &str) -> Result<String, AppError> {
    use aes_gcm::{
        aead::{Aead as _, KeyInit as _},
        Aes256Gcm, Nonce,
    };

    if key.len() != 32 {
        return Err(AppError::CryptoError(format!(
            "Invalid key length {}, expected 32",
            key.len()
        )));
    }

    let cipher = Aes256Gcm::new_from_slice(key)
        .map_err(|e| AppError::CryptoError(format!("Failed to initialize AES cipher: {e}")))?;

    let nonce_bytes: [u8; 12] = rand::rng().random();
    let nonce = Nonce::from_slice(&nonce_bytes);

    let ciphertext = cipher
        .encrypt(nonce, plaintext.as_bytes())
        .map_err(|e| AppError::CryptoError(format!("AES encryption failed: {e}")))?;

    let mut result = b"v2:".to_vec();
    result.extend(&nonce_bytes);
    result.extend(ciphertext);
    Ok(base64::engine::general_purpose::STANDARD.encode(&result))
}

/// Internal: Decrypt a string encrypted with AES-256-GCM.
pub fn deobfuscate_string(key: &[u8], ciphertext: &str) -> Result<String, AppError> {
    use aes_gcm::{
        aead::{Aead as _, KeyInit as _},
        Aes256Gcm, Nonce,
    };

    let decoded = base64::engine::general_purpose::STANDARD
        .decode(ciphertext)
        .map_err(|e| AppError::CryptoError(format!("Invalid base64 encoding: {e}")))?;

    if !decoded.starts_with(b"v2:") {
        return Err(AppError::CryptoError(
            "Unknown or missing encryption version prefix".to_owned(),
        ));
    }

    if decoded.len() < 31 {
        return Err(AppError::CryptoError(
            "Invalid v2 ciphertext: too short".to_owned(),
        ));
    }

    let nonce_bytes = decoded
        .get(3..15)
        .ok_or_else(|| AppError::CryptoError("Invalid ciphertext: missing nonce".to_owned()))?;
    let ct = decoded
        .get(15..)
        .ok_or_else(|| AppError::CryptoError("Invalid ciphertext: missing data".to_owned()))?;

    if key.len() != 32 {
        return Err(AppError::CryptoError(format!(
            "Invalid key length {}, expected 32",
            key.len()
        )));
    }

    let cipher = Aes256Gcm::new_from_slice(key)
        .map_err(|e| AppError::CryptoError(format!("Failed to initialize AES cipher: {e}")))?;

    let nonce = Nonce::from_slice(nonce_bytes);

    let plaintext = cipher
        .decrypt(nonce, ct)
        .map_err(|e| AppError::CryptoError(format!("AES decryption failed: {e}")))?;

    String::from_utf8(plaintext)
        .map_err(|e| AppError::CryptoError(format!("Decrypted data is not valid UTF-8: {e}")))
}
