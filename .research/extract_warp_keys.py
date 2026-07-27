"""
Extract WARP MASQUE/WireGuard private key from Windows Credential Manager.
The WARP service (warp-svc.exe) runs as SYSTEM, so credentials are stored
at SYSTEM level. This script attempts multiple methods to read them.
"""
import ctypes
import ctypes.wintypes as w
import json
import os
import base64
import struct

# Method 1: Try keyring with different target names
def try_keyring():
    print("=== Method 1: Python keyring ===")
    try:
        import keyring
        for service in ["WARP", "WARPSecret", "WARPSecret.WARP"]:
            for user in ["WARPSecret", "WARP", "", None]:
                try:
                    cred = keyring.get_password(service, user)
                    if cred:
                        print(f"  Found! service={service}, user={user}, len={len(cred)}")
                        return cred
                except:
                    pass
        print("  Not found via keyring")
    except ImportError:
        print("  keyring module not available")
    return None

# Method 2: Use Windows CredRead API directly
def try_wincred():
    print("\n=== Method 2: Windows CredRead API ===")
    CRED_TYPE_GENERIC = 1
    
    class CREDENTIAL(ctypes.Structure):
        _fields_ = [
            ("Flags", w.DWORD),
            ("Type", w.DWORD),
            ("TargetName", w.LPWSTR),
            ("Comment", w.LPWSTR),
            ("LastWritten", w.FILETIME),
            ("CredentialBlobSize", w.DWORD),
            ("CredentialBlob", ctypes.POINTER(ctypes.c_byte)),
            ("Persist", w.DWORD),
            ("AttributeCount", w.DWORD),
            ("Attributes", ctypes.c_void_p),
            ("TargetAlias", w.LPWSTR),
            ("UserName", w.LPWSTR),
        ]
    
    cred = ctypes.POINTER(CREDENTIAL)()
    
    targets = [
        "WARPSecret.WARP",
        "WARP:WARPSecret",
        "WARP",
    ]
    
    for target in targets:
        print(f"  Trying target: {target}")
        if ctypes.windll.advapi32.CredReadW(
            ctypes.c_wchar_p(target),
            CRED_TYPE_GENERIC,
            0,
            ctypes.byref(cred)
        ):
            print(f"  SUCCESS! Found credential for {target}")
            print(f"    UserName: {cred.contents.UserName}")
            print(f"    TargetName: {cred.contents.TargetName}")
            print(f"    BlobSize: {cred.contents.CredentialBlobSize}")
            
            blob_size = cred.contents.CredentialBlobSize
            if blob_size > 0:
                blob_data = ctypes.string_at(cred.contents.CredentialBlob, blob_size)
                # Try to decode as UTF-16 (Windows stores strings as wide chars)
                try:
                    text = blob_data.decode('utf-16-le')
                    print(f"    Blob (UTF-16): {text[:200]}...")
                    # Check if it's JSON
                    if text.startswith('{'):
                        data = json.loads(text)
                        print(f"    Parsed JSON keys: {list(data.keys())}")
                        return text
                except:
                    # Try as raw bytes
                    print(f"    Blob (raw hex): {blob_data[:100].hex()}")
                    return blob_data
            
            ctypes.windll.advapi32.CredFree(cred)
        else:
            error = ctypes.GetLastError()
            print(f"    Failed (error {error})")
    
    return None

# Method 3: Try WMI to find the credential
def try_wmi():
    print("\n=== Method 3: Check via PowerShell ===")
    import subprocess
    # Run as admin to access SYSTEM credentials
    ps_script = '''
    $ErrorActionPreference = "Stop"
    # Try to enumerate all credentials
    $sig = @"
    using System;
    using System.Runtime.InteropServices;
    public class CredMan {
        [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
        public static extern bool CredEnumerateW(string filter, uint flags, out uint count, out IntPtr creds);
        
        [DllImport("advapi32.dll")]
        public static extern void CredFree(IntPtr cred);
    }
"@
    Add-Type -TypeDefinition $sig
    $count = 0
    $creds = [IntPtr]::Zero
    $ok = [CredMan]::CredEnumerateW($null, 1, [ref]$count, [ref]$creds)
    if ($ok) {
        $credSize = [System.Runtime.InteropServices.Marshal]::SizeOf([System.Type][pscustomobject])
        Write-Host "Found $count credentials"
        for ($i = 0; $i -lt $count; $i++) {
            $offset = [IntPtr]::Add($creds, $i * 52)  # approximate credential struct size
            try {
                $cred = [System.Runtime.InteropServices.Marshal]::PtrToStructure($offset, [pscustomobject])
            } catch {
                # just list what we can
            }
        }
    }
    # Also try cmdkey as SYSTEM
    Write-Host "---"
    # List all generic credentials visible
    $store = New-Object -ComObject "PWABuilder.Store.1" -ErrorAction SilentlyContinue
    '''
    try:
        result = subprocess.run(
            ["powershell", "-Command", ps_script],
            capture_output=True, text=True, timeout=10
        )
        print(result.stdout)
        if result.stderr:
            print(f"  STDERR: {result.stderr[:200]}")
    except Exception as e:
        print(f"  Error: {e}")
    return None

# Method 4: Check if conf.json has everything we need
def check_conf_json():
    print("\n=== Method 4: Analyze conf.json ===")
    conf_path = r"C:\ProgramData\Cloudflare\conf.json"
    if not os.path.exists(conf_path):
        print(f"  {conf_path} not found")
        return None
    
    with open(conf_path, 'r', encoding='utf-8') as f:
        conf = json.load(f)
    
    print(f"  tunnel_type: {conf.get('tunnel_key_data', {}).get('tunnel_type')}")
    print(f"  key_type: {conf.get('tunnel_key_data', {}).get('key_type')}")
    print(f"  own_public_key: {conf.get('own_public_key', '')[:80]}...")
    print(f"  server_public_key (PEM): {conf.get('public_key', '')[:80]}...")
    print(f"  interface v4: {conf.get('interface', {}).get('v4')}")
    print(f"  interface v6: {conf.get('interface', {}).get('v6')}")
    print(f"  endpoints: {conf.get('endpoints', [])[:3]}")
    print(f"  account_type: {conf.get('account', {}).get('account_type')}")
    print(f"  organization: {conf.get('account', {}).get('organization')}")
    
    # Extract server public key (remove PEM headers)
    server_pub_pem = conf.get('public_key', '')
    # Remove PEM headers and newlines
    server_pub_b64 = server_pub_pem.replace('-----BEGIN PUBLIC KEY-----', '') \
                                    .replace('-----END PUBLIC KEY-----', '') \
                                    .replace('\n', '').strip()
    print(f"\n  Server public key (base64, no PEM): {server_pub_b64[:80]}...")
    print(f"  Own public key (base64): {conf.get('own_public_key', '')[:80]}...")
    
    return conf

if __name__ == "__main__":
    conf = check_conf_json()
    
    # Try to get private key
    result = try_keyring()
    if not result:
        result = try_wincred()
    if not result:
        try_wmi()
    
    if conf and result:
        print("\n=== SUCCESS: Full MASQUE config available ===")
        print(f"Private key found (first 50 chars): {str(result)[:50]}...")
    else:
        print("\n=== Partial: Private key not accessible from user level ===")
        print("Need to run as admin/SYSTEM to access the credential store")
        print("\nAlternative: Register a NEW device via API to get fresh keys")
