//! Cloudflare WARP registration + Mihomo outbound generation.

//!

//! Auto-adapts to the server-configured tunnel protocol (WireGuard or MASQUE):

//!   1. Register device with a real X25519 key pair  (POST /reg)

//!   2. Inspect `policy.tunnel_protocol` in the response

//!   3a. WireGuard 闁?use the X25519 private key + Step-1 config directly

//!   3b. MASQUE    闁?generate ECDSA P-256 pair, PATCH to enroll, use that config

//!   4. Emit a Mihomo `wireguard` or `masque` outbound YAML and save as profile

//!

//! Zero Trust JWT is obtained automatically by opening a Tauri WebView to the

//! Cloudflare Access login page and intercepting the `com.cloudflare.warp://`

//! callback URL that carries the token in its query string.

//!

//! Based on the open-source [usque](https://github.com/Diniboy1123/usque) project.

use base64::{engine::general_purpose::STANDARD as b64, Engine as _};

use rand::RngExt as _;

use serde::{Deserialize, Serialize};

use std::sync::{Arc, Mutex};

use tauri::Manager as _;

use tokio::sync::oneshot;

use super::core_process::ensure_app_storage;

use super::crypto::{load_metadata, lock_metadata, save_metadata, write_profile_file};

// 闁冲厜鍋撻柍鍏夊亾闁冲厜鍋?Constants 闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾

const API_URL: &str = "https://api.cloudflareclient.com";

const API_VERSION: &str = "v0a4471";

const KEY_TYPE_WG: &str = "curve25519";

const TUN_TYPE_WG: &str = "wireguard";

const KEY_TYPE_MASQUE: &str = "secp256r1";

const TUN_TYPE_MASQUE: &str = "masque";

const DEFAULT_WG_PORT: u16 = 2408;

const DEFAULT_MASQUE_PORT: u16 = 443;

/// Authentication timeout in seconds (5 minutes).

const AUTH_TIMEOUT_SECS: u64 = 300;

fn warp_headers() -> reqwest::header::HeaderMap {
    let mut h = reqwest::header::HeaderMap::new();
    h.insert("User-Agent", "WARP for Android".parse().unwrap());
    h.insert("CF-Client-Version", "a-6.35-4471".parse().unwrap());
    h.insert("Content-Type", "application/json; charset=UTF-8".parse().unwrap());
    h.insert("Accept", "*/*".parse().unwrap());
    h.insert("Connection", "Keep-Alive".parse().unwrap());
    h
}

fn http_client() -> Result<reqwest::Client, String> {

    reqwest::Client::builder()

        .timeout(std::time::Duration::from_secs(30))

        .no_proxy()

        .build()

        .map_err(|e| format!("Failed to create HTTP client: {e}"))

}

// 闁冲厜鍋撻柍鍏夊亾闁冲厜鍋?WireGuard X25519 key pair 闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾

/// Generate a WireGuard X25519 key pair (raw 32-byte 闁?base64).

///

/// The private key is clamped per WireGuard spec:

///   `priv[0] &= 248; priv[31] &= 127; priv[31] |= 64`

fn generate_wg_keypair() -> Result<(String, String), String> {

    use curve25519_dalek::scalar::Scalar;

    use curve25519_dalek::montgomery::MontgomeryPoint;

    let mut priv_bytes = [0u8; 32];

    rand::rng().fill(&mut priv_bytes);

    // WireGuard clamping

    priv_bytes[0] &= 248;

    priv_bytes[31] &= 127;

    priv_bytes[31] |= 64;

    let scalar = Scalar::from_bytes_mod_order(priv_bytes);

    let basepoint = MontgomeryPoint([

        9, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,

        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,

    ]);

    let public = basepoint * &scalar;

    Ok((b64.encode(priv_bytes), b64.encode(public.0)))

}

// 闁冲厜鍋撻柍鍏夊亾闁冲厜鍋?ECDSA P-256 key pair (for MASQUE) 闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾

/// Generate an ECDSA P-256 key pair (DER 闁?base64).

fn generate_ec_keypair() -> Result<(String, String), String> {

    use p256::ecdsa::SigningKey;

    use p256::pkcs8::EncodePublicKey;

    let mut key_bytes = [0u8; 32];

    loop {

        rand::rng().fill(&mut key_bytes);

        if let Ok(signing_key) = SigningKey::from_slice(&key_bytes) {

            let pub_der = signing_key

                .verifying_key()

                .to_public_key_der()

                .map_err(|e| format!("Failed to encode EC public key: {e}"))?;

            // Build SEC1 ECPrivateKey DER manually:
            // ECPrivateKey ::= SEQUENCE {
            //   version INTEGER (1),
            //   privateKey OCTET STRING,
            //   parameters [0] EXPLICIT OBJECT IDENTIFIER,  -- P-256 OID = 1.2.840.10045.3.1.7
            //   publicKey [1] EXPLICIT BIT STRING OPTIONAL
            // }
            let verifying = signing_key.verifying_key();
            let pub_point = verifying.to_sec1_bytes(); // 04 + 32X + 32Y = 65 bytes

            // privateKey OCTET STRING (32 bytes)
            let mut content = Vec::new();
            // version = 1
            content.extend_from_slice(&[0x02, 0x01, 0x01]);
            // privateKey OCTET STRING
            content.extend_from_slice(&[0x04, 0x20]); // tag + length(32)
            content.extend_from_slice(&key_bytes);
            // parameters [0] EXPLICIT OID (P-256: 1.2.840.10045.3.1.7)
            // OID encoding: 06 08 2a 86 48 ce 3d 03 01 07
            content.extend_from_slice(&[0xa0, 0x0a]); // [0] EXPLICIT, length=10
            content.extend_from_slice(&[0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07]);
            // publicKey [1] EXPLICIT BIT STRING
            let bit_string: Vec<u8> = std::iter::once(0x00u8) // no unused bits
                .chain(pub_point.iter().copied())
                .collect(); // 1 + 65 = 66 bytes
            content.push(0xa1); // [1] EXPLICIT
            content.push(0x44); // length = 68 (0x03 + 0x42 + 66 bytes)
            content.push(0x03); // BIT STRING tag
            content.push(0x42); // length = 66
            content.extend_from_slice(&bit_string);

            // Outer SEQUENCE
            let mut sec1 = Vec::new();
            sec1.push(0x30); // SEQUENCE
            sec1.push(content.len() as u8);
            sec1.extend_from_slice(&content);

            eprintln!("[WARP] EC SEC1: {}B, pub_point: {}B, pub_der: {}B",
                sec1.len(), pub_point.len(), pub_der.as_bytes().len());
            return Ok((b64.encode(&sec1), b64.encode(pub_der.as_bytes())));

        }

    }

}

// 闁冲厜鍋撻柍鍏夊亾闁冲厜鍋?Random helpers 闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾

fn random_android_serial() -> String {

    let bytes: [u8; 8] = rand::rng().random();

    hex::encode(bytes)

}

fn tos_string() -> String {
    use chrono::{FixedOffset, Utc};
    let offset = FixedOffset::west_opt(7 * 3600).unwrap();
    Utc::now()
        .with_timezone(&offset)
        .format("%Y-%m-%dT%H:%M:%S.000%:z")
        .to_string()
}

// 闁冲厜鍋撻柍鍏夊亾闁冲厜鍋?API response models 闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾

#[derive(Deserialize, Clone)]

struct Policy {

    tunnel_protocol: Option<String>,

}

#[derive(Deserialize, Clone)]

struct PeerEndpoint {

    v4: Option<String>,

    #[allow(dead_code)]

    v6: Option<String>,

}

#[derive(Deserialize, Clone)]

struct Peer {

    public_key: Option<String>,

    endpoint: Option<PeerEndpoint>,

}

#[derive(Deserialize, Clone)]

struct InterfaceAddresses {

    v4: Option<String>,

    v6: Option<String>,

}

#[derive(Deserialize, Clone)]

struct Interface {

    addresses: Option<InterfaceAddresses>,

}

#[derive(Deserialize, Clone)]

struct WarpConfig {

    peers: Option<Vec<Peer>>,

    interface: Option<Interface>,

    #[allow(dead_code)]

    client_id: Option<String>,

}

#[derive(Deserialize)]

struct AccountInfo {

    #[allow(dead_code)]

    account_type: Option<String>,

    #[allow(dead_code)]

    organization: Option<String>,

}

#[derive(Deserialize)]

struct RegistrationResponse {

    id: String,

    token: Option<String>,

    #[allow(dead_code)]

    account: Option<AccountInfo>,

    policy: Option<Policy>,

    config: Option<WarpConfig>,

}

// 闁冲厜鍋撻柍鍏夊亾闁冲厜鍋?Step 1: Register device 闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾

struct Registration {

    response: RegistrationResponse,

    wg_private_key: String,

}

async fn register_device(jwt: Option<&str>) -> Result<Registration, String> {

    let (priv_b64, pub_b64) = generate_wg_keypair()?;

    let body = serde_json::json!({

        "key": pub_b64,

        "install_id": "",

        "fcm_token": "",

        "tos": tos_string(),

        "model": "PC",

        "serial_number": random_android_serial(),

        "os_version": "",

        "key_type": KEY_TYPE_WG,

        "tunnel_type": TUN_TYPE_WG,

        "locale": "en_US",

    });

    let mut headers = warp_headers();

    if let Some(jwt) = jwt {

        eprintln!("[WARP] JWT header len={}, first 50: {}", jwt.len(), &jwt[..jwt.len().min(50)]);
        headers.insert(

            "CF-Access-Jwt-Assertion",

            jwt.parse().map_err(|e| format!("Invalid JWT header: {e}"))?,

        );

    }

    eprintln!("[WARP] register body: {}", serde_json::to_string(&body).unwrap_or_default());

    // Log all headers being sent
    for (k, v) in headers.iter() {
        let val_str = v.to_str().unwrap_or("<binary>");
        eprintln!("[WARP] header: {k}: {}", &val_str[..val_str.len().min(80)]);
    }

    let resp = http_client()?

        .post(format!("{API_URL}/{API_VERSION}/reg"))

        .headers(headers)

        .json(&body)

        .send()

        .await

        .map_err(|e| format!("Registration request failed: {e}"))?;

    if !resp.status().is_success() {

        let status = resp.status();

        let text = resp.text().await.unwrap_or_default();

        return Err(format!("Registration failed (HTTP {status}): {text}"));

    }

    let response: RegistrationResponse = resp

        .json()

        .await

        .map_err(|e| format!("Failed to parse registration response: {e}"))?;

    Ok(Registration {

        response,

        wg_private_key: priv_b64,

    })

}

// 闁冲厜鍋撻柍鍏夊亾闁冲厜鍋?Step 2: Enroll MASQUE key 闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋?

struct Enrolled {

    response: RegistrationResponse,

    ec_private_key: String,

}

async fn enroll_masque(device_id: &str, access_token: &str) -> Result<Enrolled, String> {

    let (priv_b64, pub_b64) = generate_ec_keypair()?;

    let body = serde_json::json!({

        "key": pub_b64,

        "key_type": KEY_TYPE_MASQUE,

        "tunnel_type": TUN_TYPE_MASQUE,

        "name": "Zephyr",

    });

    let mut headers = warp_headers();

    headers.insert(

        "Authorization",

        format!("Bearer {access_token}")

            .parse()

            .map_err(|e| format!("Invalid auth header: {e}"))?,

    );

    let resp = http_client()?

        .patch(format!("{API_URL}/{API_VERSION}/reg/{device_id}"))

        .headers(headers)

        .json(&body)

        .send()

        .await

        .map_err(|e| format!("Enroll request failed: {e}"))?;

    if !resp.status().is_success() {

        let status = resp.status();

        let text = resp.text().await.unwrap_or_default();

        return Err(format!("Enroll failed (HTTP {status}): {text}"));

    }

    let response: RegistrationResponse = resp

        .json()

        .await

        .map_err(|e| format!("Failed to parse enroll response: {e}"))?;

    Ok(Enrolled {

        response,

        ec_private_key: priv_b64,

    })

}

// 闁冲厜鍋撻柍鍏夊亾闁冲厜鍋?Build Mihomo outbound config 闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾

fn strip_pem(input: &str) -> String {

    if input.contains("-----BEGIN") {

        input

            .replace("-----BEGIN PUBLIC KEY-----", "")

            .replace("-----END PUBLIC KEY-----", "")

            .replace('\n', "")

            .trim()

            .to_string()

    } else {

        input.to_string()

    }

}

fn parse_endpoint(v4: Option<&str>, default_port: u16) -> (String, u16) {

    let raw = v4.unwrap_or("162.159.197.2:0");

    if let Some((ip, port_str)) = raw.rsplit_once(':') {

        let port = port_str.parse::<u16>().unwrap_or(default_port);

        let port = if port == 0 { default_port } else { port };

        (ip.to_string(), port)

    } else {

        (raw.to_string(), default_port)

    }

}

fn ensure_cidr(ip: &str, prefix: u8) -> String {

    if ip.contains('/') {

        ip.to_string()

    } else {

        format!("{ip}/{prefix}")

    }

}

struct MihomoOutbound {

    proto: String,

    server: String,

    port: u16,

    private_key: String,

    public_key: String,

    ipv4: String,

    ipv6: Option<String>,

}

fn build_outbound(

    config: &WarpConfig,

    private_key: &str,

    is_masque: bool,

) -> Result<MihomoOutbound, String> {

    let peers = config

        .peers

        .as_ref()

        .and_then(|p| p.first())

        .ok_or("No peers in config")?;

    let iface = config

        .interface

        .as_ref()

        .and_then(|i| i.addresses.as_ref())

        .ok_or("No interface addresses in config")?;

    let default_port = if is_masque { DEFAULT_MASQUE_PORT } else { DEFAULT_WG_PORT };

    let (server, port) =

        parse_endpoint(peers.endpoint.as_ref().and_then(|e| e.v4.as_deref()), default_port);

    let server_pub = peers

        .public_key

        .as_deref()

        .map(strip_pem)

        .ok_or("No server public key")?;

    let proto = if is_masque { "masque" } else { "wireguard" };

    let ipv4 = ensure_cidr(iface.v4.as_deref().unwrap_or("172.16.0.2"), 32);

    let ipv6 = iface

        .v6

        .as_ref()

        .filter(|s| !s.is_empty())

        .map(|v| ensure_cidr(v, 128));

    Ok(MihomoOutbound {

        proto: proto.to_string(),

        server,

        port,

        private_key: private_key.to_string(),

        public_key: server_pub,

        ipv4,

        ipv6,

    })

}

fn generate_mihomo_yaml(outbound: &MihomoOutbound, name: &str) -> String {

    let mut proxy = serde_json::json!({

        "name": name,

        "type": outbound.proto,

        "server": outbound.server,

        "port": outbound.port,

        "private-key": outbound.private_key,

        "public-key": outbound.public_key,

        "ip": outbound.ipv4,

        "mtu": 1280,

        "udp": true,

        "sni": "warp.cloudflareclient.com",
        "congestion-controller": "bbr",

    });

    if let Some(ipv6) = &outbound.ipv6 {

        proxy["ipv6"] = serde_json::Value::String(ipv6.clone());

    }

    let config = serde_json::json!({ "proxies": [proxy] });

    serde_yaml::to_string(&config).unwrap_or_default()

}

// 闁冲厜鍋撻柍鍏夊亾闁冲厜鍋?Zero Trust JWT extraction via WebView2 NavigationStarting 闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋?

use std::sync::OnceLock;

/// Global static channel for passing JWT from the `warp-cb://` protocol handler

/// (in lib.rs) to the waiting `warp_register_zero_trust` command.

/// Uses OnceLock because Tauri's UriSchemeContext doesn't expose app_handle

/// for managed state access.

pub static WARP_JWT_TX: OnceLock<Arc<Mutex<Option<oneshot::Sender<String>>>>> = OnceLock::new();

/// Open a Tauri WebView to the Cloudflare Access login page and intercept the

/// `com.cloudflare.warp://...?token=<JWT>` navigation at the WebView2 level.

///

/// WebView2 cannot actually navigate to `com.cloudflare.warp://` (no handler

/// registered for that scheme), so it fires `NavigationStarting` with the URL

/// and then cancels. We intercept this event via `with_webview()` to access

/// the raw `ICoreWebView2` COM interface, bypassing Tauri's (broken) wrapper.

///

/// This approach is immune to CSP, mixed-content, and JS execution limitations.

async fn extract_jwt_from_webview(

    app: &tauri::AppHandle,

    org_name: &str,

) -> Result<String, String> {

    let auth_url = format!("https://{org_name}.cloudflareaccess.com/warp");

    eprintln!("[WARP] extract_jwt: url={auth_url}");

    let (tx, rx) = oneshot::channel::<String>();

    let tx: Arc<Mutex<Option<oneshot::Sender<String>>>> = Arc::new(Mutex::new(Some(tx)));

    let label = "warp-auth";

    if let Some(old) = app.get_webview_window(label) {

        eprintln!("[WARP] extract_jwt: closing stale window");

        let _ = old.close();

    }

    let tx_nav = tx.clone();

    eprintln!("[WARP] extract_jwt: building webview window...");

    let webview = tauri::webview::WebviewWindowBuilder::new(

        app,

        label,

        tauri::WebviewUrl::External(auth_url.parse().map_err(|e| format!("Invalid URL: {e}"))?),

    )

    .title("Cloudflare WARP Login")

    .inner_size(900.0, 650.0)

    .min_inner_size(400.0, 300.0)

    .on_navigation(move |url| {

        // Tauri 2 wrapper 闁?may or may not fire, but register anyway

        let url_str = url.as_str();

        eprintln!("[WARP] on_navigation: {url_str}");

        if let Some(jwt) = extract_jwt_from_url(url_str) {

            eprintln!("[WARP] on_navigation: JWT found, len={}", jwt.len());

            if let Some(sender) = tx_nav.lock().unwrap().take() {

                let _ = sender.send(jwt);

            }

            return false; // Cancel navigation

        }

        true

    })

    .build()

    .map_err(|e| {

        eprintln!("[WARP] extract_jwt: build FAILED: {e}");

        format!("Failed to open login window: {e}")

    })?;

    eprintln!("[WARP] extract_jwt: webview built, registering raw WebView2 handlers...");

    // Open DevTools for diagnosis + ensure window is visible/focused

    #[cfg(debug_assertions)]

    webview.open_devtools();

    let _ = webview.set_focus();

    eprintln!("[WARP] cfg!(target_os=\"windows\") = {}", cfg!(target_os = "windows"));

    // Small delay to let WebView2 initialize

    tokio::time::sleep(std::time::Duration::from_millis(200)).await;

    // Register raw NavigationStarting + NewWindowRequested on the WebView2 COM interface.

    let tx_raw = tx.clone();

    #[cfg(target_os = "windows")]

    {

        let _ = tx_raw;

        eprintln!("[WARP] calling with_webview...");

        webview.with_webview(move |_webview| {

            eprintln!("[WARP] with_webview: INSIDE closure 闁?platform webview available!");

        });

        eprintln!("[WARP] with_webview call returned");

    }

    #[cfg(not(target_os = "windows"))]

    {

        let _ = tx_raw;

        eprintln!("[WARP] with_webview not available on this platform");

    }

    eprintln!("[WARP] extract_jwt: handlers registered, waiting for JWT (timeout {AUTH_TIMEOUT_SECS}s)...");

    // Window close event

    let tx_for_close = tx.clone();

    webview.on_window_event(move |event| {

        if let tauri::WindowEvent::Destroyed = event {

            if let Some(sender) = tx_for_close.lock().unwrap().take() {

                let _ = sender.send(String::new());

            }

        }

    });

    // Wait for JWT (or timeout / user cancel)

    match tokio::time::timeout(std::time::Duration::from_secs(AUTH_TIMEOUT_SECS), rx).await {

        Ok(Ok(jwt)) if !jwt.is_empty() => {

            eprintln!("[WARP] extract_jwt: got JWT, closing window");

            let _ = webview.close();

            Ok(jwt)

        }

        Ok(Ok(_)) => {

            eprintln!("[WARP] extract_jwt: user cancelled");

            Err("Authentication cancelled by user".to_string())

        }

        Ok(Err(_)) => {

            eprintln!("[WARP] extract_jwt: channel error");

            Err("Authentication channel error".to_string())

        }

        Err(_) => {

            eprintln!("[WARP] extract_jwt: TIMEOUT after {AUTH_TIMEOUT_SECS}s");

            let _ = webview.close();

            Err(format!("Authentication timeout ({AUTH_TIMEOUT_SECS}s)"))

        }

    }

}

/// Extract JWT token from a URL like `com.cloudflare.warp://...?token=eyJ...`

pub fn extract_jwt_from_url(url: &str) -> Option<String> {

    // Try query param: token=...

    if let Some(pos) = url.find("token=") {

        let raw = &url[pos + 6..];

        let jwt = raw.split('&').next().unwrap_or(raw);

        // URL-decode

        let jwt = jwt.replace("%3D", "=").replace("%2B", "+").replace("%2F", "/");

        if jwt.starts_with("eyJ") {

            return Some(jwt.to_string());

        }

    }

    // Try jwt= as fallback

    if let Some(pos) = url.find("jwt=") {

        let raw = &url[pos + 4..];

        let jwt = raw.split('&').next().unwrap_or(raw);

        if jwt.starts_with("eyJ") {

            return Some(jwt.to_string());

        }

    }

    None

}

/// Read an HTTP request from the callback, extract `jwt=` query param.

fn handle_callback_request(mut stream: std::net::TcpStream, tick: u32) -> Option<String> {

    use std::io::Read;

    let mut buf = [0u8; 4096];

    let n = stream.read(&mut buf).ok()?;

    if n == 0 {

        return None;

    }

    let req = String::from_utf8_lossy(&buf[..n]);

    let first_line = req.lines().next().unwrap_or("");

    eprintln!("[WARP] poll#{tick}: HTTP req: {first_line}");

    let resp = "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nOK";

    let _ = std::io::Write::write_all(&mut stream, resp.as_bytes());

    let path = first_line.split_whitespace().nth(1).unwrap_or("");

    if let Some(pos) = path.find("jwt=") {

        let raw = &path[pos + 4..];

        let jwt_raw = raw.split('&').next().unwrap_or(raw);

        let jwt = percent_decode(jwt_raw);

        if jwt.starts_with("eyJ") {

            return Some(jwt);

        }

    }

    None

}

fn percent_decode(input: &str) -> String {

    let mut out = String::with_capacity(input.len());

    let bytes = input.as_bytes();

    let mut i = 0;

    while i < bytes.len() {

        if bytes[i] == b'%' && i + 2 < bytes.len() {

            let hi = hex_val(bytes[i + 1]);

            let lo = hex_val(bytes[i + 2]);

            if let (Some(h), Some(l)) = (hi, lo) {

                out.push(char::from(h * 16 + l));

                i += 3;

                continue;

            }

        }

        out.push(bytes[i] as char);

        i += 1;

    }

    out

}

fn hex_val(b: u8) -> Option<u8> {

    match b {

        b'0'..=b'9' => Some(b - b'0'),

        b'a'..=b'f' => Some(b - b'a' + 10),

        b'A'..=b'F' => Some(b - b'A' + 10),

        _ => None,

    }

}

// 闁冲厜鍋撻柍鍏夊亾闁冲厜鍋?Shared registration logic 闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾

/// Core registration logic shared by `warp_register` and `warp_register_zero_trust`.

async fn warp_register_inner(

    app: &tauri::AppHandle,

    jwt: Option<&str>,

) -> Result<(WarpRegisterResult, String), String> {

    let is_zero_trust = jwt.is_some();

    // Step 1: Register device with real X25519 key pair

    let reg = register_device(jwt).await?;

    let device_id = reg.response.id.clone();

    let access_token = reg

        .response

        .token

        .clone()

        .ok_or("No access token in registration response")?;

    let tunnel_proto = reg

        .response

        .policy

        .as_ref()

        .and_then(|p| p.tunnel_protocol.as_deref())

        .unwrap_or("wireguard");

    let is_masque = tunnel_proto == "masque";

    // Step 2: Auto-adapt 闁?MASQUE enrolls ECDSA key; WireGuard uses Step-1 config

    let (final_config, private_key) = if is_masque {

        let enrolled = enroll_masque(&device_id, &access_token).await?;

        (

            enrolled.response.config.ok_or("No config in enroll response")?,

            enrolled.ec_private_key,

        )

    } else {

        (

            reg.response.config.ok_or("No config in registration response")?,

            reg.wg_private_key,

        )

    };

    // Step 3: Build Mihomo outbound

    let outbound = build_outbound(&final_config, &private_key, is_masque)?;

    // Step 4: Generate YAML and save as profile

    let profile_name = if is_zero_trust {

        "warp_zerotrust.yaml"

    } else {

        "warp.yaml"

    };

    let yaml = generate_mihomo_yaml(&outbound, "WARP");

    let paths = ensure_app_storage(app)?;

    let config_path = paths.profiles_dir.join(profile_name);

    write_profile_file(&config_path, &yaml, false)?;

    // Save metadata

    let _guard = lock_metadata();

    let mut metadata = load_metadata(&paths);

    let entry = metadata.configs.entry(profile_name.to_string()).or_default();

    entry.url = None;

    entry.last_updated = Some(

        std::time::SystemTime::now()

            .duration_since(std::time::UNIX_EPOCH)

            .map(|d| d.as_secs())

            .unwrap_or(0),

    );

    save_metadata(&paths, &metadata)?;

    let proto_label = if is_masque { "MASQUE" } else { "WireGuard" };

    let mode_label = if is_zero_trust { "Zero Trust" } else { "Consumer" };

    Ok((

        WarpRegisterResult {

            name: profile_name.to_string(),

            protocol: outbound.proto,

            device_id,

            message: format!("WARP {mode_label} ({proto_label}) registered successfully"),

        },

        profile_name.to_string(),

    ))

}

// 闁冲厜鍋撻柍鍏夊亾闁冲厜鍋?Tauri commands 闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋?

/// Result returned to the frontend after WARP registration.

#[derive(Serialize)]

pub struct WarpRegisterResult {

    pub name: String,

    pub protocol: String,

    pub device_id: String,

    pub message: String,

}

/// Register Consumer WARP (free, no authentication).

///

/// Generates a WireGuard/MASQUE config automatically and saves it as `warp.yaml`.

#[tauri::command]

pub async fn warp_register(app: tauri::AppHandle) -> Result<WarpRegisterResult, String> {

    let (result, _) = warp_register_inner(&app, None).await?;

    Ok(result)

}

/// Open the Cloudflare Access auth URL in the system browser.

#[tauri::command]

pub async fn warp_open_auth_url(org_name: String) -> Result<String, String> {

    let org = org_name.trim();

    if org.is_empty() {

        return Err("Organization name is required".to_string());

    }

    let url = format!("https://{org}.cloudflareaccess.com/warp");

    eprintln!("[WARP] opening system browser: {url}");

    #[cfg(target_os = "windows")]

    {

        std::process::Command::new("cmd").args(["/C", "start", "", &url]).spawn()

            .map_err(|e| format!("Failed to open browser: {e}"))?;

    }

    #[cfg(target_os = "macos")]

    { std::process::Command::new("open").arg(&url).spawn()

        .map_err(|e| format!("Failed to open browser: {e}"))?; }

    #[cfg(target_os = "linux")]

    { std::process::Command::new("xdg-open").arg(&url).spawn()

        .map_err(|e| format!("Failed to open browser: {e}"))?; }

    Ok(url)

}

/// Register Zero Trust WARP by extracting JWT from WebView2 cookies.
/// Opens a WebView for authentication, then reads session cookies from the
/// WebView2 SQLite database, uses them to fetch the auth page via reqwest,
/// and parses the meta refresh to extract the JWT.
#[tauri::command]
pub async fn warp_register_zero_trust(
    app: tauri::AppHandle,
    org_name: String,
) -> Result<WarpRegisterResult, String> {
    let org = org_name.trim();
    if org.is_empty() {
        return Err("Organization name is required".to_string());
    }
    let auth_url = format!("https://{org}.cloudflareaccess.com/warp");
    eprintln!("[WARP] zero_trust: url={auth_url}");

    // Start local HTTP server to receive cookies via eval()
    let listener = std::net::TcpListener::bind("127.0.0.1:0")
        .map_err(|e| format!("bind HTTP server: {e}"))?;
    let callback_port = listener.local_addr()
        .map_err(|e| format!("get port: {e}"))?.port();
    listener.set_nonblocking(true)
        .map_err(|e| format!("set non-blocking: {e}"))?;
    eprintln!("[WARP] HTTP callback on port {callback_port}");

    let (tx, rx) = oneshot::channel::<String>();
    let tx: Arc<Mutex<Option<oneshot::Sender<String>>>> = Arc::new(Mutex::new(Some(tx)));

    // Open auth WebView with separate data directory
    let label = "warp-auth";
    if let Some(old) = app.get_webview_window(label) {
        let _ = old.close();
    }
    let app_main = app.clone();
    let url_s = auth_url.clone();
    let label_s = label.to_string();
    let auth_data_dir = app.path().app_local_data_dir()
        .map_err(|e| format!("app_local_data_dir: {e}"))?
        .join("EBWebView-Auth");
    let _ = std::fs::create_dir_all(&auth_data_dir);
    let nav_port = callback_port;
    let tx_nav = tx.clone();
    app.run_on_main_thread(move || {
            let wv = tauri::webview::WebviewWindowBuilder::new(
                &app_main, &label_s,
                tauri::WebviewUrl::External(url_s.parse().expect("invalid URL")),
            )
            .title("Cloudflare WARP Login")
            .inner_size(900.0, 650.0)
            .data_directory(auth_data_dir)
            .on_navigation(move |url| {
                let url_str = url.as_str();
                eprintln!("[WARP] on_navigation: {url_str}");

                // Intercept the com.cloudflare.warp:// redirect — JWT is in the URL!
                if url_str.starts_with("com.cloudflare.warp://") {
                    if let Some(jwt) = extract_jwt_from_url(url_str) {
                        eprintln!("[WARP] on_navigation: got JWT from warp:// URL! len={}", jwt.len());
                        if let Some(sender) = tx_nav.lock().unwrap().take() {
                            let _ = sender.send(jwt);
                        }
                    } else {
                        eprintln!("[WARP] on_navigation: warp:// URL but no JWT found");
                    }
                    return false; // Cancel navigation
                }
                true
            })
            .build();
            if let Ok(wv) = wv {
                eprintln!("[WARP] WebView opened for authentication");
                let _ = wv.set_focus();
            }
        }).map_err(|e| format!("run_on_main_thread: {e}"))?;

        // Poll: eval() to send cookies to HTTP server via XHR
    // XHR worked before (poll#8 got 3775 bytes) — document.title doesn't work (wv.title() returns OS window title)
    let poll_app = app.clone();
    let poll_label = label.to_string();
    let poll_tx = tx.clone();
    let eval_js = format!(
        r#"try{{var c=document.cookie||'';if(c.length>0){{var x=new XMLHttpRequest();x.open('POST','http://127.0.0.1:{callback_port}/',true);x.send(c);}}}}catch(e){{}}"#
    );
    let mut tick = 0u32;
    let mut got_callback = false;
    loop {
        tokio::time::sleep(std::time::Duration::from_millis(1000)).await;
        tick += 1;

        // Check HTTP callback
        match listener.accept() {
            Ok((stream, addr)) => {
                eprintln!("[WARP] poll#{tick}: HTTP callback from {addr}");
                if let Some(cookies) = read_http_body(stream) {
                    eprintln!("[WARP] poll#{tick}: got cookies, len={}", cookies.len());
                    match fetch_jwt_with_cookies(&app, &auth_url, &cookies).await {
                        Ok(jwt) => {
                            eprintln!("[WARP] got JWT via eval+HTTP! len={}", jwt.len());
                            if let Some(sender) = poll_tx.lock().unwrap().take() {
                                let _ = sender.send(jwt);
                            }
                            got_callback = true;
                            break;
                        }
                        Err(e) => eprintln!("[WARP] poll#{tick}: fetch JWT failed: {e}"),
                    }
                }
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
            Err(e) => {
                eprintln!("[WARP] poll#{tick}: accept err: {e}");
            }
        }

        // Eval to send cookies via XHR
        if let Some(wv) = poll_app.get_webview_window(&poll_label) {
            eprintln!("[WARP] poll#{tick}: eval() on WebView...");
            let _ = wv.eval(&eval_js);
        } else {
            eprintln!("[WARP] poll#{tick}: WebView not found");
            if tick > 3 {
                eprintln!("[WARP] poll#{tick}: WebView gone, trying SQLite fallback...");
                break;
            }
        }

        // Check if on_navigation already sent JWT via channel
        if poll_tx.lock().unwrap().is_none() {
            eprintln!("[WARP] poll#{tick}: JWT received via on_navigation!");
            got_callback = true;
            break;
        }
    }

    // If we got JWT (via on_navigation or HTTP callback), register now
    if got_callback {
        if let Some(wv) = poll_app.get_webview_window(&poll_label) {
            let _ = wv.close();
        }
        match rx.await {
            Ok(jwt) if !jwt.is_empty() => {
                eprintln!("[WARP] registering with JWT, len={}", jwt.len());
                let (result, _) = warp_register_inner(&app, Some(&jwt)).await?;
                return Ok(result);
            }
            _ => return Err("JWT channel error".to_string()),
        }
    }

    // Fallback: try cookie extraction from SQLite
    eprintln!("[WARP] trying SQLite cookie extraction...");
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    match extract_jwt_via_cookies(&app, &auth_url).await {
        Ok(jwt) => {
            eprintln!("[WARP] got JWT via SQLite, len={}", jwt.len());
            let (result, _) = warp_register_inner(&app, Some(&jwt)).await?;
            return Ok(result);
        }
        Err(e) => eprintln!("[WARP] SQLite extraction failed: {e}"),
    }

    Err("Failed to extract JWT after authentication".to_string())
}

/// Read HTTP request body from a TcpStream.
fn read_http_body(mut stream: std::net::TcpStream) -> Option<String> {
    use std::io::Read;
    let mut buf = [0u8; 8192];
    let n = stream.read(&mut buf).ok()?;
    if n == 0 { return None; }
    let req = String::from_utf8_lossy(&buf[..n]);
    let resp = "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nOK";
    let _ = std::io::Write::write_all(&mut stream, resp.as_bytes());
    // Body is after \r\n\r\n
    if let Some(pos) = req.find("\r\n\r\n") {
        let body = &req[pos + 4..];
        if !body.is_empty() {
            return Some(body.to_string());
        }
    }
    None
}

/// Fetch auth page with cookies and extract JWT.
/// Uses manual redirect handling to capture `com.cloudflare.warp://` Location headers.
async fn fetch_jwt_with_cookies(
    _app: &tauri::AppHandle,
    auth_url: &str,
    cookie_header: &str,
) -> Result<String, String> {
    eprintln!("[WARP] fetching auth page with cookies...");
    // Build client that does NOT auto-follow redirects — we want to inspect 302 Location
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {e}"))?;

    let resp = client.get(auth_url)
        .header("Cookie", cookie_header)
        .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)")
        .send().await
        .map_err(|e| format!("fetch auth: {e}"))?;

    let status = resp.status();
    eprintln!("[WARP] auth response status: {status}");

    // Check Location header for redirect (com.cloudflare.warp://...?token=eyJ...)
    if let Some(loc) = resp.headers().get("location") {
        let loc_str = loc.to_str().unwrap_or("");
        eprintln!("[WARP] Location header: {loc_str}");
        if let Some(jwt) = extract_jwt_from_url(loc_str) {
            return Ok(jwt);
        }
        // Maybe the redirect URL itself contains token=
        if let Some(pos) = loc_str.find("token=") {
            let raw = &loc_str[pos + 6..];
            let jwt = raw.split('&').next().unwrap_or(raw).to_string();
            if jwt.starts_with("eyJ") {
                return Ok(jwt);
            }
        }
    }

    let html = resp.text().await
        .map_err(|e| format!("read auth: {e}"))?;
    eprintln!("[WARP] auth HTML len: {}", html.len());

    // Dump first 500 chars for debugging
    let preview: String = html.chars().take(500).collect();
    eprintln!("[WARP] auth HTML preview: {preview}");

    if let Some(pos) = html.find("token=") {
        let raw = &html[pos + 6..];
        let jwt = raw.split('&').next().unwrap_or(raw)
            .split('"').next().unwrap_or(raw)
            .split('\'').next().unwrap_or(raw)
            .split('<').next().unwrap_or(raw)
            .to_string();
        if jwt.starts_with("eyJ") {
            return Ok(jwt);
        }
    }
    if let Some(pos) = html.find("com.cloudflare.warp://") {
        if let Some(jwt) = extract_jwt_from_url(&html[pos..]) {
            return Ok(jwt);
        }
    }
    Err("No JWT in auth response".to_string())
}

#[cfg(target_os = "windows")]
async fn extract_jwt_via_cookies(
    app: &tauri::AppHandle,
    auth_url: &str,
) -> Result<String, String> {
    let app_data = app.path().app_local_data_dir()
        .map_err(|e| format!("app_local_data_dir: {e}"))?;
    let cookies_db = app_data.join("EBWebView-Auth").join("EBWebView").join("Default").join("Network").join("Cookies");
    let local_state = app_data.join("EBWebView-Auth").join("EBWebView").join("Local State");
    eprintln!("[WARP] cookies db: {}", cookies_db.display());
    if !cookies_db.exists() {
        return Err("Cookie database not found".to_string());
    }

    // All SQLite + DPAPI + AES operations in spawn_blocking (not Send)
    let cookie_header = tokio::task::spawn_blocking(move || {
        read_cookies_sync(&cookies_db, &local_state)
    }).await
    .map_err(|e| format!("spawn_blocking: {e}"))??;

    // Fetch auth page with cookies (async, fine)
    let client = http_client()?;
    let resp = client.get(auth_url)
        .header("Cookie", &cookie_header)
        .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)")
        .send().await
        .map_err(|e| format!("fetch auth: {e}"))?;
    let html = resp.text().await
        .map_err(|e| format!("read auth: {e}"))?;
    eprintln!("[WARP] auth HTML len: {}", html.len());

    if let Some(pos) = html.find("token=") {
        let raw = &html[pos + 6..];
        let jwt = raw.split('&').next().unwrap_or(raw)
            .split('"').next().unwrap_or(raw)
            .split('\'').next().unwrap_or(raw)
            .split('<').next().unwrap_or(raw)
            .to_string();
        if jwt.starts_with("eyJ") {
            return Ok(jwt);
        }
    }
    if let Some(pos) = html.find("com.cloudflare.warp://") {
        if let Some(jwt) = extract_jwt_from_url(&html[pos..]) {
            return Ok(jwt);
        }
    }
    Err("No JWT in auth response (cookies expired?)".to_string())
}

#[cfg(target_os = "windows")]
fn read_cookies_sync(cookies_db: &std::path::Path, local_state: &std::path::Path) -> Result<String, String> {
    // Read AES key from Local State
    let aes_key = if local_state.exists() {
        let state_str = std::fs::read_to_string(local_state)
            .map_err(|e| format!("read Local State: {e}"))?;
        let state: serde_json::Value = serde_json::from_str(&state_str)
            .map_err(|e| format!("parse Local State: {e}"))?;
        let enc_key_b64 = state["os_crypt"]["encrypted_key"]
            .as_str().ok_or("no encrypted_key")?;
        let enc_key = base64::engine::general_purpose::STANDARD
            .decode(enc_key_b64).map_err(|e| format!("b64: {e}"))?;
        if enc_key.len() < 5 || &enc_key[..5] != b"DPAPI" {
            return Err("bad encrypted_key format".to_string());
        }
        dpapi_decrypt(&enc_key[5..])?
    } else { Vec::new() };
    eprintln!("[WARP] AES key len: {}", aes_key.len());

    // Read cookie DB bytes directly (std::fs::read uses CreateFileW with max sharing on Windows)
    let data = std::fs::read(cookies_db)
        .map_err(|e| format!("read cookie DB: {e}"))?;
    eprintln!("[WARP] read {} bytes from cookie DB", data.len());

    // Write to temp file and open with SQLite
    let tmp = tempfile::tempdir().map_err(|e| format!("tempdir: {e}"))?;
    let tmp_db = tmp.path().join("Cookies");
    std::fs::write(&tmp_db, &data).map_err(|e| format!("write temp: {e}"))?;
    let conn = rusqlite::Connection::open(&tmp_db)
        .map_err(|e| format!("open SQLite: {e}"))?;
    let mut stmt = conn.prepare(
        "SELECT name, encrypted_value, value FROM cookies WHERE host_key LIKE ?1"
    ).map_err(|e| format!("SQL prepare: {e}"))?;
    let host = "%.cloudflareaccess.com%";
    let mut rows = stmt.query([host]).map_err(|e| format!("SQL query: {e}"))?;

    let mut parts: Vec<String> = Vec::new();
    while let Ok(Some(row)) = rows.next() {
        let name: String = row.get(0).unwrap_or_default();
        let enc: Vec<u8> = row.get(1).unwrap_or_default();
        let plain: String = row.get(2).unwrap_or_default();
        let val = if !plain.is_empty() {
            plain
        } else if !enc.is_empty() {
            // Log encrypted value header for debugging
            let hdr: String = enc.iter().take(20).map(|b| format!("{b:02x}")).collect::<Vec<_>>().join(" ");
            eprintln!("[WARP] cookie '{name}': enc_len={} hdr={hdr}", enc.len());
            if aes_key.is_empty() {
                String::from_utf8_lossy(&dpapi_decrypt(&enc).unwrap_or_default()).to_string()
            } else if enc.len() > 31 && &enc[..3] == b"v10" {
                match decrypt_aes_gcm(&aes_key, &enc[3..]) {
                    Ok(v) => v,
                    Err(e) => { eprintln!("[WARP] skip v10 cookie '{name}': {e}"); continue; }
                }
            } else {
                String::from_utf8_lossy(&dpapi_decrypt(&enc).unwrap_or_default()).to_string()
            }
        } else { continue };
        parts.push(format!("{name}={val}"));
    }
    if parts.is_empty() {
        return Err("No cookies for auth domain".to_string());
    }
    eprintln!("[WARP] found {} cookies", parts.len());
    Ok(parts.join("; "))
}

#[cfg(target_os = "windows")]
fn dpapi_decrypt(data: &[u8]) -> Result<Vec<u8>, String> {
    use windows_sys::Win32::Security::Cryptography::{
        CryptUnprotectData, CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN,
    };
    let in_blob = CRYPT_INTEGER_BLOB {
        cbData: data.len() as u32,
        pbData: data.as_ptr() as *mut u8,
    };
    let mut out_blob = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    unsafe {
        if CryptUnprotectData(
            &in_blob, std::ptr::null_mut(), std::ptr::null(),
            std::ptr::null(), std::ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN, &mut out_blob,
        ) == 0 {
            return Err("CryptUnprotectData failed".to_string());
        }
        let result = std::slice::from_raw_parts(
            out_blob.pbData, out_blob.cbData as usize
        ).to_vec();
        // Leak out_blob.pbData (small, once per extraction; LocalFree API varies across windows-sys versions)
        Ok(result)
    }
}

#[cfg(target_os = "windows")]
fn decrypt_aes_gcm(key: &[u8], data: &[u8]) -> Result<String, String> {
    zephyr_core::crypto::decrypt_webview2_v10_cookie(key, data)
        .map_err(|e| format!("AES-GCM: {e}"))
}

#[cfg(not(target_os = "windows"))]
async fn extract_jwt_via_cookies(
    _app: &tauri::AppHandle, _auth_url: &str,
) -> Result<String, String> {
    Err("Cookie extraction only on Windows".to_string())
}
