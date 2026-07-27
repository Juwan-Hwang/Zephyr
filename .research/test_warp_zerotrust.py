#!/usr/bin/env python3
"""
Extract JWT from Cloudflare Access WARP callback page and immediately
run Zero Trust registration + MASQUE enrollment.
"""
import re, sys, json, base64, secrets, time, requests, os
from datetime import datetime, timezone, timedelta
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.backends import default_backend
import yaml

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

def generate_ec_keypair():
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

def register_zerotrust(jwt):
    wg_key = base64.b64encode(secrets.token_bytes(32)).decode()
    serial = secrets.token_bytes(8).hex()
    tos_time = (datetime.now(timezone.utc) - timedelta(hours=7)).strftime("%Y-%m-%dT%H:%M:%S.000-07:00")

    data = {
        "key": wg_key, "install_id": "", "fcm_token": "", "tos": tos_time,
        "model": "PC", "serial_number": serial, "os_version": "",
        "key_type": "curve25519", "tunnel_type": "wireguard", "locale": "en_US",
    }
    headers = dict(HEADERS)
    headers["CF-Access-Jwt-Assertion"] = jwt

    log(f"POST {API_URL}/{API_VERSION}/reg (Zero Trust with JWT)")
    resp = requests.post(f"{API_URL}/{API_VERSION}/reg", json=data, headers=headers, timeout=30)
    if resp.status_code != 200:
        log(f"ERROR: HTTP {resp.status_code} - {resp.text[:300]}", "ERROR")
        return None

    account = resp.json()
    log(f"SUCCESS! Device ID: {account.get('id')}")
    log(f"  Account type: {account.get('account', {}).get('account_type')}")
    log(f"  Organization: {account.get('account', {}).get('organization', 'N/A')}")
    return account

def enroll_masque(device_id, access_token):
    priv_b64, pub_b64 = generate_ec_keypair()
    data = {"key": pub_b64, "key_type": "secp256r1", "tunnel_type": "masque", "name": "Zephyr-ZT"}
    headers = dict(HEADERS)
    headers["Authorization"] = f"Bearer {access_token}"

    log(f"PATCH {API_URL}/{API_VERSION}/reg/{device_id} (enroll MASQUE)")
    resp = requests.patch(f"{API_URL}/{API_VERSION}/reg/{device_id}", json=data, headers=headers, timeout=30)
    if resp.status_code != 200:
        log(f"ERROR: HTTP {resp.status_code} - {resp.text[:300]}", "ERROR")
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

    result = {
        "private_key": priv_b64,
        "public_key_server": server_pub_b64,
        "server": server_ip, "port": 443,
        "ipv4": iface.get("v4", ""), "ipv6": iface.get("v6", ""),
        "client_id": config.get("client_id", ""),
        "device_id": device_id, "access_token": access_token,
    }
    log(f"SUCCESS! Key type: {updated.get('key_type')}, Tunnel: {updated.get('tunnel_type')}")
    log(f"  Server: {server_ip}, IPv4: {iface.get('v4')}, IPv6: {iface.get('v6')}")
    return result

def generate_mihomo_config(warp_config, name="WARP-ZeroTrust"):
    ipv4 = warp_config["ipv4"]
    if "/" not in ipv4: ipv4 = f"{ipv4}/32"
    ipv6 = warp_config["ipv6"]
    if ipv6 and "/" not in ipv6: ipv6 = f"{ipv6}/128"

    proxy = {
        "name": name, "type": "masque",
        "server": warp_config["server"], "port": warp_config["port"],
        "private-key": warp_config["private_key"],
        "public-key": warp_config["public_key_server"],
        "ip": ipv4, "mtu": 1280, "udp": True,
    }
    if ipv6: proxy["ipv6"] = ipv6

    yaml_str = yaml.dump({"proxies": [proxy]}, default_flow_style=False, allow_unicode=True)
    return yaml_str

def main():
    # JWT from browser (extracted from meta refresh tag)
    jwt = sys.argv[1] if len(sys.argv) > 1 else ""
    if not jwt:
        log("Usage: python test_warp_zerotrust.py <JWT>", "ERROR")
        return 1

    print("=" * 70)
    print("  WARP Zero Trust + MASQUE Registration Test")
    print("=" * 70)

    # Step 1: Register with JWT
    print("\n-- Step 1: Register device (Zero Trust) --")
    account = register_zerotrust(jwt)
    if not account:
        return 1
    device_id = account["id"]
    access_token = account.get("token", "")
    if not access_token:
        log("No access token!", "ERROR")
        return 1

    # Step 2: Enroll MASQUE
    print("\n-- Step 2: Enroll MASQUE key --")
    warp_config = enroll_masque(device_id, access_token)
    if not warp_config:
        return 1

    # Step 3: Generate + save Mihomo config
    print("\n-- Step 3: Generate Mihomo config --")
    mihomo_yaml = generate_mihomo_config(warp_config)

    usque_path = os.path.join(OUTPUT_DIR, "warp_zerotrust_usque.json")
    mihomo_path = os.path.join(OUTPUT_DIR, "warp_zerotrust_mihomo.yaml")

    usque_config = {
        "private_key": warp_config["private_key"],
        "endpoint_v4": f"{warp_config['server']}:0",
        "endpoint_v6": "",
        "endpoint_pub_key": f"-----BEGIN PUBLIC KEY-----\n{warp_config['public_key_server']}\n-----END PUBLIC KEY-----",
        "id": warp_config["device_id"],
        "access_token": warp_config["access_token"],
        "ipv4": warp_config["ipv4"],
        "ipv6": warp_config["ipv6"],
    }
    with open(usque_path, "w") as f: json.dump(usque_config, f, indent=2)
    with open(mihomo_path, "w") as f: f.write(mihomo_yaml)
    log(f"Saved: {usque_path}")
    log(f"Saved: {mihomo_path}")

    print("\n" + "=" * 70)
    print("  [OK] Zero Trust registration flow completed!")
    print(f"  Device ID:    {device_id}")
    print(f"  Server:       {warp_config['server']}:{warp_config['port']}")
    print(f"  IPv4:         {warp_config['ipv4']}")
    print(f"  IPv6:         {warp_config['ipv6']}")
    print("=" * 70)
    return 0

if __name__ == "__main__":
    sys.exit(main())
