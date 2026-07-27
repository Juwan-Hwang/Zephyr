#!/usr/bin/env python3
"""
WARP Zero Trust + MASQUE Registration Test
Verifies the complete flow: register → enroll MASQUE → generate Mihomo config

Based on usque (https://github.com/Diniboy1123/usque) source code.
"""

import os
import sys
import json
import base64
import secrets
import time
import requests
from datetime import datetime, timezone, timedelta
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.backends import default_backend

# ─── Constants (from usque/internal/consts.go) ───────────────────────────────

API_URL = "https://api.cloudflareclient.com"
API_VERSION = "v0a4471"
CONNECT_SNI = "consumer-masque.cloudflareclient.com"
DEFAULT_MODEL = "PC"
KEY_TYPE_WG = "curve25519"
TUN_TYPE_WG = "wireguard"
KEY_TYPE_MASQUE = "secp256r1"
TUN_TYPE_MASQUE = "masque"
DEFAULT_LOCALE = "en_US"

HEADERS = {
    "User-Agent": "WARP for Android",
    "CF-Client-Version": "a-6.35-4471",
    "Content-Type": "application/json; charset=UTF-8",
    "Connection": "Keep-Alive",
}

OUTPUT_DIR = os.path.dirname(os.path.abspath(__file__))


def log(msg, level="INFO"):
    ts = datetime.now().strftime("%H:%M:%S")
    print(f"[{ts}] {level}: {msg}")


# ─── Step 1: Generate keys ──────────────────────────────────────────────────

def generate_wg_pubkey():
    """Generate a random 32-byte WireGuard-like public key (base64)."""
    key = secrets.token_bytes(32)
    return base64.b64encode(key).decode()


def generate_android_serial():
    """Generate a random 8-byte Android-like serial number (hex)."""
    serial = secrets.token_bytes(8)
    return serial.hex()


def generate_ec_keypair():
    """Generate an ECDSA P-256 (secp256r1) key pair for MASQUE.
    Returns (private_key_der_b64, public_key_pkix_der_b64, public_key_pem_str).
    """
    priv = ec.generate_private_key(ec.SECP256R1(), default_backend())

    # Private key in ASN.1 DER (SEC1) format, base64
    priv_der = priv.private_bytes(
        encoding=serialization.Encoding.DER,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )
    priv_b64 = base64.b64encode(priv_der).decode()

    # Public key in PKIX DER format
    pub_der = priv.public_key().public_bytes(
        encoding=serialization.Encoding.DER,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    )
    pub_b64 = base64.b64encode(pub_der).decode()

    # Public key in PEM format (for display)
    pub_pem = priv.public_key().public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    ).decode()

    return priv_b64, pub_b64, pub_pem


# ─── Step 2: Register device ────────────────────────────────────────────────

def register(jwt=""):
    """Register a new device with the WARP API.
    If jwt is provided, registers as Zero Trust (Team) account.
    Otherwise, registers as Consumer (free) account.
    """
    wg_key = generate_wg_pubkey()
    serial = generate_android_serial()
    tos_time = (datetime.now(timezone.utc) - timedelta(hours=7)).strftime("%Y-%m-%dT%H:%M:%S.000-07:00")

    data = {
        "key": wg_key,
        "install_id": "",
        "fcm_token": "",
        "tos": tos_time,
        "model": DEFAULT_MODEL,
        "serial_number": serial,
        "os_version": "",
        "key_type": KEY_TYPE_WG,
        "tunnel_type": TUN_TYPE_WG,
        "locale": DEFAULT_LOCALE,
    }

    headers = dict(HEADERS)
    if jwt:
        headers["CF-Access-Jwt-Assertion"] = jwt
        log(f"Registering as Zero Trust (Team) account with JWT...")
    else:
        log(f"Registering as Consumer (free) account...")

    log(f"  WG pubkey: {wg_key[:40]}...")
    log(f"  Serial: {serial}")
    log(f"  TOS: {tos_time}")

    url = f"{API_URL}/{API_VERSION}/reg"
    log(f"  POST {url}")

    resp = requests.post(url, json=data, headers=headers, timeout=30)

    if resp.status_code != 200:
        log(f"  ERROR: HTTP {resp.status_code}", "ERROR")
        try:
            err = resp.json()
            log(f"  {json.dumps(err, indent=2)}", "ERROR")
        except:
            log(f"  Body: {resp.text[:500]}", "ERROR")
        return None

    account = resp.json()
    log(f"  SUCCESS! HTTP 200")
    log(f"  Device ID: {account.get('id')}")
    log(f"  Token: {account.get('token', '')[:40]}...")
    log(f"  Account type: {account.get('account', {}).get('account_type', 'unknown')}")
    if account.get('account', {}).get('organization'):
        log(f"  Organization: {account['account']['organization']}")
    log(f"  Key type: {account.get('key_type')}")
    log(f"  Tunnel type: {account.get('tunnel_type')}")

    return account


# ─── Step 3: Enroll MASQUE key ───────────────────────────────────────────────

def enroll_masque(device_id, access_token, device_name="Zephyr-Test"):
    """Enroll a new MASQUE (ECDSA P-256) key, switching from WireGuard to MASQUE."""
    priv_b64, pub_b64, pub_pem = generate_ec_keypair()

    log(f"  Generated ECDSA P-256 key pair")
    log(f"  Private key (DER b64, first 50): {priv_b64[:50]}...")
    log(f"  Public key (DER b64, first 50): {pub_b64[:50]}...")

    data = {
        "key": pub_b64,
        "key_type": KEY_TYPE_MASQUE,
        "tunnel_type": TUN_TYPE_MASQUE,
        "name": device_name,
    }

    headers = dict(HEADERS)
    headers["Authorization"] = f"Bearer {access_token}"

    url = f"{API_URL}/{API_VERSION}/reg/{device_id}"
    log(f"  PATCH {url}")

    resp = requests.patch(url, json=data, headers=headers, timeout=30)

    if resp.status_code != 200:
        log(f"  ERROR: HTTP {resp.status_code}", "ERROR")
        try:
            err = resp.json()
            log(f"  {json.dumps(err, indent=2)}", "ERROR")
        except:
            log(f"  Body: {resp.text[:500]}", "ERROR")
        return None, None

    updated = resp.json()
    log(f"  SUCCESS! HTTP 200")
    log(f"  Key type: {updated.get('key_type')}")
    log(f"  Tunnel type: {updated.get('tunnel_type')}")

    # Extract config
    config = updated.get("config", {})
    peers = config.get("peers", [])
    iface = config.get("interface", {}).get("addresses", {})

    if peers:
        peer = peers[0]
        endpoint = peer.get("endpoint", {})
        log(f"  Server public key (PEM): {peer.get('public_key', '')[:60]}...")
        log(f"  Endpoint v4: {endpoint.get('v4')}")
        log(f"  Endpoint v6: {endpoint.get('v6')}")
        log(f"  Client ID: {config.get('client_id', '')}")

    if iface:
        log(f"  Interface v4: {iface.get('v4')}")
        log(f"  Interface v6: {iface.get('v6')}")

    # Parse endpoint (strip :0 suffix)
    ep_v4 = endpoint.get("v4", "162.159.197.2:0")
    server_ip = ep_v4.rsplit(":", 1)[0] if ":" in ep_v4 else "162.159.197.2"
    server_port = 443  # Default MASQUE port

    # Parse server public key (strip PEM headers)
    server_pub_pem = peer.get("public_key", "")
    server_pub_b64 = server_pub_pem.replace("-----BEGIN PUBLIC KEY-----", "") \
                                    .replace("-----END PUBLIC KEY-----", "") \
                                    .replace("\n", "").strip()

    result = {
        "private_key": priv_b64,
        "public_key_server": server_pub_b64,
        "server": server_ip,
        "port": server_port,
        "ipv4": iface.get("v4", ""),
        "ipv6": iface.get("v6", ""),
        "client_id": config.get("client_id", ""),
        "device_id": device_id,
        "access_token": access_token,
    }

    return result, priv_b64


# ─── Step 4: Generate Mihomo config ─────────────────────────────────────────

def generate_mihomo_config(warp_config, name="WARP"):
    """Generate a Mihomo MASQUE outbound config."""
    ipv4 = warp_config["ipv4"]
    if "/" not in ipv4:
        ipv4 = f"{ipv4}/32"

    ipv6 = warp_config["ipv6"]
    if ipv6 and "/" not in ipv6:
        ipv6 = f"{ipv6}/128"

    proxy = {
        "name": name,
        "type": "masque",
        "server": warp_config["server"],
        "port": warp_config["port"],
        "private-key": warp_config["private_key"],
        "public-key": warp_config["public_key_server"],
        "ip": ipv4,
        "mtu": 1280,
        "udp": True,
    }
    if ipv6:
        proxy["ipv6"] = ipv6

    import yaml
    config = {"proxies": [proxy]}
    yaml_str = yaml.dump(config, default_flow_style=False, allow_unicode=True)

    log(f"  Generated Mihomo MASQUE config:")
    for line in yaml_str.strip().split("\n"):
        if "private-key" in line:
            log(f"    {line.split(':')[0]}: <REDACTED>")
        else:
            log(f"    {line}")

    return yaml_str


# ─── Step 5: Save config ─────────────────────────────────────────────────────

def save_config(warp_config, mihomo_yaml, prefix="warp"):
    """Save both the usque-style config and Mihomo config."""
    usque_config = {
        "private_key": warp_config["private_key"],
        "endpoint_v4": f"{warp_config['server']}:0",
        "endpoint_v6": "",
        "endpoint_h2_v4": "162.159.198.2",
        "endpoint_h2_v6": "",
        "endpoint_pub_key": f"-----BEGIN PUBLIC KEY-----\n{warp_config['public_key_server']}\n-----END PUBLIC KEY-----",
        "id": warp_config["device_id"],
        "access_token": warp_config["access_token"],
        "ipv4": warp_config["ipv4"],
        "ipv6": warp_config["ipv6"],
    }

    usque_path = os.path.join(OUTPUT_DIR, f"{prefix}_usque.json")
    mihomo_path = os.path.join(OUTPUT_DIR, f"{prefix}_mihomo.yaml")

    with open(usque_path, "w") as f:
        json.dump(usque_config, f, indent=2)
    log(f"  Saved usque config → {usque_path}")

    with open(mihomo_path, "w") as f:
        f.write(mihomo_yaml)
    log(f"  Saved Mihomo config → {mihomo_path}")

    return usque_path, mihomo_path


# ─── Main ────────────────────────────────────────────────────────────────────

def main():
    jwt = ""
    if len(sys.argv) > 1:
        jwt = sys.argv[1]

    print("=" * 70)
    print("  WARP MASQUE Registration Test")
    print("  Based on usque (https://github.com/Diniboy1123/usque)")
    print("=" * 70)

    # Step 1: Register
    print("\n── Step 1: Register device ─────────────────────────────────────")
    account = register(jwt)
    if not account:
        log("Registration failed!", "ERROR")
        return 1

    device_id = account["id"]
    access_token = account.get("token", "")
    if not access_token:
        log("No access token in response!", "ERROR")
        return 1

    # Step 2: Enroll MASQUE key
    print("\n── Step 2: Enroll MASQUE key ──────────────────────────────────")
    warp_config, priv_key = enroll_masque(device_id, access_token)
    if not warp_config:
        log("MASQUE enrollment failed!", "ERROR")
        return 1

    # Step 3: Generate Mihomo config
    print("\n── Step 3: Generate Mihomo config ─────────────────────────────")
    mihomo_yaml = generate_mihomo_config(warp_config, name="WARP-Test")

    # Step 4: Save configs
    print("\n── Step 4: Save configs ───────────────────────────────────────")
    prefix = "warp_zerotrust" if jwt else "warp_consumer"
    save_config(warp_config, mihomo_yaml, prefix=prefix)

    # Summary
    print("\n" + "=" * 70)
    print("  [OK] Registration flow completed successfully!")
    print(f"  Device ID:    {device_id}")
    print(f"  Server:       {warp_config['server']}:{warp_config['port']}")
    print(f"  IPv4:         {warp_config['ipv4']}")
    print(f"  IPv6:         {warp_config['ipv6']}")
    print(f"  Private key:  {warp_config['private_key'][:40]}...")
    print(f"  Server pubkey:{warp_config['public_key_server'][:40]}...")
    print("=" * 70)

    return 0


if __name__ == "__main__":
    sys.exit(main())
