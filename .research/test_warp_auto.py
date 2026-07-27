#!/usr/bin/env python3
"""
WARP Auto-Adaptive Registration Test
Auto-detects tunnel protocol (WireGuard or MASQUE) from server policy
and generates the appropriate Mihomo outbound config.
"""

import os, sys, json, base64, secrets, time, requests, yaml
from datetime import datetime, timezone, timedelta
from cryptography.hazmat.primitives.asymmetric import ec, x25519
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.backends import default_backend

API_URL = "https://api.cloudflareclient.com"
API_VERSION = "v0a4471"
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

# ─── WireGuard X25519 key pair ───────────────────────────────────────────────

def generate_wg_keypair():
    """Generate a real WireGuard X25519 key pair (raw bytes, base64)."""
    priv = x25519.X25519PrivateKey.generate()
    priv_raw = priv.private_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PrivateFormat.Raw,
        encryption_algorithm=serialization.NoEncryption(),
    )
    pub_raw = priv.public_key().public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw,
    )
    return base64.b64encode(priv_raw).decode(), base64.b64encode(pub_raw).decode()

# ─── ECDSA P-256 key pair (for MASQUE) ──────────────────────────────────────

def generate_ec_keypair():
    """Generate ECDSA P-256 key pair (DER, base64) for MASQUE."""
    priv = ec.generate_private_key(ec.SECP256R1(), default_backend())
    priv_der = priv.private_bytes(
        encoding=serialization.Encoding.DER,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )
    pub_der = priv.public_key().public_bytes(
        encoding=serialization.Encoding.DER,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    )
    return base64.b64encode(priv_der).decode(), base64.b64encode(pub_der).decode()

# ─── Random helpers ─────────────────────────────────────────────────────────

def generate_android_serial():
    return secrets.token_bytes(8).hex()

def tos_string():
    return (datetime.now(timezone.utc) - timedelta(hours=7)).strftime("%Y-%m-%dT%H:%M:%S.000-07:00")

# ─── Step 1: Register device ────────────────────────────────────────────────

def register(jwt=""):
    """Register with a REAL WireGuard key pair (not random).
    The server's policy.tunnel_protocol determines WireGuard vs MASQUE.
    """
    priv_b64, pub_b64 = generate_wg_keypair()
    serial = generate_android_serial()

    data = {
        "key": pub_b64,
        "install_id": "", "fcm_token": "", "tos": tos_string(),
        "model": "PC", "serial_number": serial, "os_version": "",
        "key_type": "curve25519", "tunnel_type": "wireguard",
        "locale": "en_US",
    }
    headers = dict(HEADERS)
    if jwt:
        headers["CF-Access-Jwt-Assertion"] = jwt
        log("Registering (Zero Trust with JWT)...")
    else:
        log("Registering (Consumer, no JWT)...")

    resp = requests.post(f"{API_URL}/{API_VERSION}/reg", json=data, headers=headers, timeout=30)
    if resp.status_code != 200:
        log(f"ERROR: HTTP {resp.status_code} - {resp.text[:300]}", "ERROR")
        return None, None

    account = resp.json()
    tunnel_proto = account.get("policy", {}).get("tunnel_protocol", "unknown")
    log(f"  SUCCESS! Device ID: {account.get('id')}")
    log(f"  Account type: {account.get('account', {}).get('account_type', 'N/A')}")
    if account.get('account', {}).get('organization'):
        log(f"  Organization: {account['account']['organization']}")
    log(f"  Server policy tunnel_protocol: {tunnel_proto}")

    # Save the WireGuard private key for WireGuard mode
    account["_wg_private_key"] = priv_b64
    return account, tunnel_proto

# ─── Step 2a: Build WireGuard config from registration response ─────────────

def build_wireguard_config(account, wg_priv_b64):
    """Build Mihomo WireGuard outbound from the registration response.
    No second API call needed - the config is in the Step 1 response.
    """
    config = account.get("config", {})
    peers = config.get("peers", [])
    iface = config.get("interface", {}).get("addresses", {})

    if not peers:
        log("ERROR: No peers in config!", "ERROR")
        return None

    peer = peers[0]
    endpoint = peer.get("endpoint", {})

    # Parse endpoint
    ep_v4 = endpoint.get("v4", "162.159.197.2:2408")
    if ":" in ep_v4:
        server_ip, server_port_str = ep_v4.rsplit(":", 1)
        # Port might be :0, use default WireGuard port 2408
        server_port = int(server_port_str) if int(server_port_str) > 0 else 2408
    else:
        server_ip, server_port = ep_v4, 2408

    # Server public key (PEM format → strip headers → base64)
    server_pub_pem = peer.get("public_key", "")
    server_pub_b64 = server_pub_pem.replace("-----BEGIN PUBLIC KEY-----", "") \
                                    .replace("-----END PUBLIC KEY-----", "") \
                                    .replace("\n", "").strip()

    ipv4 = iface.get("v4", "")
    if "/" not in ipv4: ipv4 = f"{ipv4}/32"
    ipv6 = iface.get("v6", "")
    if ipv6 and "/" not in ipv6: ipv6 = f"{ipv6}/128"

    result = {
        "type": "wireguard",
        "server": server_ip,
        "port": server_port,
        "private_key": wg_priv_b64,           # Our WireGuard private key
        "public_key_server": server_pub_b64,   # Server's WireGuard public key
        "ipv4": ipv4,
        "ipv6": ipv6,
        "device_id": account.get("id"),
        "access_token": account.get("token"),
    }

    log(f"  Protocol: WireGuard")
    log(f"  Server: {server_ip}:{server_port}")
    log(f"  IPv4: {ipv4}, IPv6: {ipv6}")
    log(f"  Private key: {wg_priv_b64[:40]}...")
    log(f"  Server pubkey: {server_pub_b64[:40]}...")
    return result

# ─── Step 2b: Enroll MASQUE key + build MASQUE config ────────────────────────

def build_masque_config(device_id, access_token):
    """Enroll an ECDSA P-256 MASQUE key and build Mihomo MASQUE outbound."""
    priv_b64, pub_b64 = generate_ec_keypair()

    data = {"key": pub_b64, "key_type": "secp256r1", "tunnel_type": "masque", "name": "Zephyr"}
    headers = dict(HEADERS)
    headers["Authorization"] = f"Bearer {access_token}"

    log(f"  Enrolling MASQUE key (PATCH /reg/{device_id})...")
    resp = requests.patch(f"{API_URL}/{API_VERSION}/reg/{device_id}", json=data, headers=headers, timeout=30)
    if resp.status_code != 200:
        log(f"  ERROR: HTTP {resp.status_code} - {resp.text[:300]}", "ERROR")
        return None

    updated = resp.json()
    config = updated.get("config", {})
    peers = config.get("peers", [])
    iface = config.get("interface", {}).get("addresses", {})
    peer = peers[0] if peers else {}
    endpoint = peer.get("endpoint", {})

    ep_v4 = endpoint.get("v4", "162.159.197.2:0")
    server_ip = ep_v4.rsplit(":", 1)[0] if ":" in ep_v4 else "162.159.197.2"

    server_pub_pem = peer.get("public_key", "")
    server_pub_b64 = server_pub_pem.replace("-----BEGIN PUBLIC KEY-----", "") \
                                    .replace("-----END PUBLIC KEY-----", "") \
                                    .replace("\n", "").strip()

    ipv4 = iface.get("v4", "")
    if "/" not in ipv4: ipv4 = f"{ipv4}/32"
    ipv6 = iface.get("v6", "")
    if ipv6 and "/" not in ipv6: ipv6 = f"{ipv6}/128"

    result = {
        "type": "masque",
        "server": server_ip,
        "port": 443,
        "private_key": priv_b64,
        "public_key_server": server_pub_b64,
        "ipv4": ipv4,
        "ipv6": ipv6,
        "device_id": device_id,
        "access_token": access_token,
    }

    log(f"  Protocol: MASQUE")
    log(f"  Server: {server_ip}:443")
    log(f"  IPv4: {ipv4}, IPv6: {ipv6}")
    log(f"  Private key: {priv_b64[:40]}...")
    log(f"  Server pubkey: {server_pub_b64[:40]}...")
    return result

# ─── Step 3: Generate Mihomo YAML ───────────────────────────────────────────

def generate_mihomo_yaml(warp_config, name="WARP"):
    proto = warp_config["type"]
    proxy = {
        "name": name,
        "type": proto,
        "server": warp_config["server"],
        "port": warp_config["port"],
        "private-key": warp_config["private_key"],
        "public-key": warp_config["public_key_server"],
        "ip": warp_config["ipv4"],
        "mtu": 1280,
        "udp": True,
    }
    if warp_config.get("ipv6"):
        proxy["ipv6"] = warp_config["ipv6"]

    return yaml.dump({"proxies": [proxy]}, default_flow_style=False, allow_unicode=True)

# ─── Main ───────────────────────────────────────────────────────────────────

def main():
    jwt = sys.argv[1] if len(sys.argv) > 1 else ""
    is_zt = bool(jwt)

    print("=" * 70)
    print("  WARP Auto-Adaptive Registration Test")
    print(f"  Mode: {'Zero Trust' if is_zt else 'Consumer'}")
    print("=" * 70)

    # Step 1: Register with real WireGuard key pair
    print("\n-- Step 1: Register device --")
    account, tunnel_proto = register(jwt)
    if not account:
        return 1

    device_id = account["id"]
    access_token = account.get("token", "")
    wg_priv_b64 = account["_wg_private_key"]

    # Step 2: Auto-adapt based on server policy
    print(f"\n-- Step 2: Auto-adapt (server policy: {tunnel_proto}) --")

    if tunnel_proto == "wireguard":
        log("Server configured for WireGuard → using WireGuard outbound")
        warp_config = build_wireguard_config(account, wg_priv_b64)
    elif tunnel_proto == "masque":
        log("Server configured for MASQUE → enrolling MASQUE key")
        warp_config = build_masque_config(device_id, access_token)
    else:
        log(f"Unknown tunnel_protocol: {tunnel_proto}, trying WireGuard first", "WARN")
        warp_config = build_wireguard_config(account, wg_priv_b64)
        if not warp_config:
            log("WireGuard failed, trying MASQUE...", "WARN")
            warp_config = build_masque_config(device_id, access_token)

    if not warp_config:
        log("Failed to build config!", "ERROR")
        return 1

    # Step 3: Generate Mihomo config
    print("\n-- Step 3: Generate Mihomo config --")
    name = "WARP-ZeroTrust" if is_zt else "WARP-Consumer"
    mihomo_yaml = generate_mihomo_yaml(warp_config, name=name)

    for line in mihomo_yaml.strip().split("\n"):
        if "private-key" in line:
            log(f"  {line.split(':')[0]}: <REDACTED>")
        else:
            log(f"  {line}")

    # Step 4: Save
    print("\n-- Step 4: Save --")
    prefix = "warp_zerotrust_auto" if is_zt else "warp_consumer_auto"
    mihomo_path = os.path.join(OUTPUT_DIR, f"{prefix}_mihomo.yaml")
    usque_path = os.path.join(OUTPUT_DIR, f"{prefix}_usque.json")

    with open(mihomo_path, "w") as f:
        f.write(mihomo_yaml)
    log(f"  Mihomo config: {mihomo_path}")

    usque_config = {
        "protocol": warp_config["type"],
        "private_key": warp_config["private_key"],
        "endpoint_v4": f"{warp_config['server']}:{warp_config['port']}",
        "endpoint_pub_key": f"-----BEGIN PUBLIC KEY-----\n{warp_config['public_key_server']}\n-----END PUBLIC KEY-----",
        "id": warp_config["device_id"],
        "access_token": warp_config["access_token"],
        "ipv4": warp_config["ipv4"],
        "ipv6": warp_config.get("ipv6", ""),
    }
    with open(usque_path, "w") as f:
        json.dump(usque_config, f, indent=2)
    log(f"  Usque config: {usque_path}")

    # Summary
    print("\n" + "=" * 70)
    print(f"  [OK] Auto-adaptive registration completed!")
    print(f"  Protocol:     {warp_config['type']}")
    print(f"  Device ID:    {warp_config['device_id']}")
    print(f"  Server:       {warp_config['server']}:{warp_config['port']}")
    print(f"  IPv4:         {warp_config['ipv4']}")
    print(f"  IPv6:         {warp_config.get('ipv6', 'N/A')}")
    print("=" * 70)
    return 0

if __name__ == "__main__":
    sys.exit(main())
