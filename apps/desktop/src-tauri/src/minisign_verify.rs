use std::path::Path;

/// Hardcoded Minisign Ed25519 public key for verifying Zephyr release signatures.
const ZEPHYR_PUBLIC_KEY: &str = "RWRkVQqGWolsGBbhZRpFQ3sPG/i4A2dGlf2E0NXJvZAviVd/I+sUzw1Z";

/// Verify a Minisign Ed25519 signature against a file.
///
/// # Arguments
/// * `file_path` - Path to the file whose signature is being verified.
/// * `signature_content` - The full content of the `.minisig` signature file.
///
/// # Errors
/// Returns an error string if the public key cannot be parsed, the signature
/// cannot be decoded, the file cannot be read, or the signature verification fails.
pub fn verify_minisign_signature(file_path: &Path, signature_content: &str) -> Result<(), String> {
    let public_key = minisign::PublicKey::from_base64(ZEPHYR_PUBLIC_KEY)
        .map_err(|e| format!("Failed to parse Minisign public key: {e}"))?;

    let signature_box = minisign::SignatureBox::from_string(signature_content)
        .map_err(|e| format!("Failed to decode Minisign signature: {e}"))?;

    let mut file = std::fs::File::open(file_path)
        .map_err(|e| format!("Failed to open file for signature verification: {e}"))?;

    // We need to read the file content and provide it to verify.
    // minisign::verify requires Read + Seek, and File implements both.
    minisign::verify(&public_key, &signature_box, &mut file, true, false, false)
        .map_err(|e| format!("Minisign signature verification failed: {e}"))?;

    Ok(())
}
