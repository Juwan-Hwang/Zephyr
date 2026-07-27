# Cloudflare WARP Zero Trust 集成研究报告

> 研究日期: 2026-07-26
> 目标: 在 Zephyr 中集成 Cloudflare WARP Zero Trust，自动适配 WireGuard/MASQUE 协议，使用 Mihomo outbound 实现代理

---

## 一、背景

Cloudflare WARP 是 Cloudflare 的零信任 VPN 服务。Zero Trust（Team）模式通过组织名 + 浏览器 OAuth 登录注册设备，获取隧道配置。

Zephyr 使用 Mihomo（Clash Meta）作为代理核心，Mihomo 原生支持 MASQUE 协议（[文档](https://wiki.metacubex.one/config/proxies/masque/)）和 WireGuard 协议（[文档](https://wiki.metacubex.one/config/proxies/wg/)），因此可以直接将 WARP 的配置作为 Mihomo outbound 使用，无需安装官方 WARP 客户端。

---

## 二、核心发现

### 2.1 WARP 官方客户端是闭源的

官方客户端（`Cloudflare_WARP_2026.5.1155.1.msi`，53MB）闭源，核心组件：

| 文件 | 作用 |
|------|------|
| `warp-svc.exe` (61MB) | Rust 后台守护进程 |
| `warp-cli.exe` (13MB) | CLI 接口 |
| `wintun.dll` | WireGuard 隧道驱动 |
| `app.so` + Flutter 资源 | Flutter GUI |

### 2.2 Mihomo 支持 MASQUE 和 WireGuard

Mihomo 文档显示两种 outbound 配置格式：

**MASQUE**（[文档](https://wiki.metacubex.one/config/proxies/masque/)）：
```yaml
proxies:
  - name: "masque"
    type: masque
    server: server.com
    port: 443
    private-key: BASE64_ENCODED_ECDSA_PRIVATE_KEY
    public-key: BASE64_ENCODED_ECDSA_PUBLIC_KEY
    ip: 172.16.0.2/32
    ipv6: fd00::2/128
    mtu: 1280
    udp: true
```

**WireGuard**（[文档](https://wiki.metacubex.one/config/proxies/wg/)）：
```yaml
proxies:
  - name: "wg"
    type: wireguard
    server: server.com
    port: 2408
    ip: 172.16.0.2/32
    ipv6: fd00::2/128
    public-key: BASE64_ENCODED_X25519_PUBLIC_KEY
    private-key: BASE64_ENCODED_X25519_PRIVATE_KEY
    mtu: 1280
    udp: true
```

### 2.3 WARP API 是公开的

通过分析开源项目 [usque](https://github.com/Diniboy1123/usque)（Mihomo 文档推荐的 MASQUE 配置生成工具），完整逆向了 WARP 注册 API：

**API 端点和常量**（来自 `usque/internal/consts.go`）：

```go
ApiUrl        = "https://api.cloudflareclient.com"
ApiVersion    = "v0a4471"
ConnectSNI    = "consumer-masque.cloudflareclient.com"
KeyTypeWg     = "curve25519"
TunTypeWg     = "wireguard"
KeyTypeMasque = "secp256r1"
TunTypeMasque = "masque"

Headers = {
    "User-Agent":        "WARP for Android",
    "CF-Client-Version": "a-6.35-4471",
    "Content-Type":      "application/json; charset=UTF-8",
    "Connection":        "Keep-Alive",
}
```

---

## 三、完整注册流程（已验证）

### 3.1 两步注册流程

WARP 设备注册分两步。**第一步始终用 WireGuard 密钥注册**，第二步（可选）切换到 MASQUE：

#### Step 1: 注册设备（获取 device_id + access_token）

```
POST https://api.cloudflareclient.com/v0a4471/reg
Headers:
  User-Agent: WARP for Android
  CF-Client-Version: a-6.35-4471
  Content-Type: application/json; charset=UTF-8
  CF-Access-Jwt-Assertion: <JWT>    ← Zero Trust 必需，Consumer 留空

Body:
{
  "key": "<X25519公钥base64>",       ← 真实 WireGuard 公钥（非随机）
  "install_id": "",
  "fcm_token": "",
  "tos": "2026-07-26T00:00:00.000-07:00",
  "model": "PC",
  "serial_number": "<随机16位hex>",
  "os_version": "",
  "key_type": "curve25519",          ← 初始用 WireGuard 注册
  "tunnel_type": "wireguard",
  "locale": "en_US"
}

Response (200):
{
  "id": "<device_id>",              ← 设备 ID（Zero Trust 格式: t.xxxxx）
  "token": "<access_token>",        ← 后续 API 调用用
  "account": {
    "account_type": "team",         ← team = Zero Trust, free = Consumer
    "organization": "juwanhwang"    ← 组织名
  },
  "policy": {
    "tunnel_protocol": "wireguard"  ← 服务器配置的协议（wireguard 或 masque）
  },
  "config": {
    "peers": [{
      "public_key": "<服务器公钥>",
      "endpoint": { "v4": "162.159.193.10:0", "v6": "[...]:0" }
    }],
    "interface": { "addresses": { "v4": "100.96.0.4", "v6": "..." } }
  }
}
```

#### Step 2: Enroll MASQUE 密钥（仅当服务器配置为 MASQUE 时）

```
PATCH https://api.cloudflareclient.com/v0a4471/reg/<device_id>
Headers:
  Authorization: Bearer <access_token>
  ...其他同上

Body:
{
  "key": "<ECDSA P-256公钥base64>",  ← 客户端生成的 MASQUE 公钥
  "key_type": "secp256r1",           ← 切换到 MASQUE 密钥类型
  "tunnel_type": "masque",           ← 切换到 MASQUE 隧道
  "name": "Zephyr"                   ← 可选设备名
}

Response (200):
{
  "id": "<device_id>",
  "key_type": "secp256r1",
  "tunnel_type": "masque",
  "config": {
    "client_id": "plhT",
    "peers": [{
      "public_key": "-----BEGIN PUBLIC KEY-----\nMFkw...\n-----END PUBLIC KEY-----",
      "endpoint": {
        "v4": "162.159.197.2:0",
        "v6": "[2606:4700:102::2]:0",
        "host": "...",
        "ports": [443, 500, 1701, 4500, 4443, 8443, 8095]
      }
    }],
    "interface": {
      "addresses": {
        "v4": "100.96.0.2",
        "v6": "2606:4700:cf1:1000::2"
      }
    }
  }
}
```

**私钥**：客户端自己生成的密钥，base64 编码后存入 Mihomo 配置。

### 3.2 Zero Trust JWT 获取流程

Zero Trust 注册需要一个 Cloudflare Access JWT，通过浏览器 OAuth 获取：

1. **打开浏览器** → `https://<org>.cloudflareaccess.com/warp`
2. **用户认证** → Cloudflare Access 登录页（Google/GitHub/SSO）
3. **认证成功** → 页面 meta refresh 标签包含 JWT：

```html
<meta http-equiv="refresh"
  content="0;url=com.cloudflare.warp://<org>.cloudflareaccess.com/auth?token=<JWT>">
```

4. **提取 JWT** → 从 meta refresh 的 URL 参数 `token=` 中提取
5. **JWT 有效期** → 60 秒，必须在过期前立即调用 API

JWT claims 包含：
```json
{
  "iss": "https://juwanhwang.cloudflareaccess.com",
  "email": "juwan1573@gmail.com",
  "type": "app",
  "warp": true,
  "account_id": "bc8ca0db11cc1b1621eb299603ef5b3a",
  "sub": "04abc659-953e-5185-936b-73b3c76779be",
  "exp": 1785027455,
  "iat": 1785027395
}
```

### 3.3 密钥对生成

#### WireGuard X25519 密钥对（用于 WireGuard 模式）

```python
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey
from cryptography.hazmat.primitives import serialization
import base64

priv = X25519PrivateKey.generate()
# 私钥 → raw bytes → base64（用于 Mihomo private-key）
priv_raw = priv.private_bytes(
    encoding=serialization.Encoding.Raw,
    format=serialization.PrivateFormat.Raw,
    encryption_algorithm=serialization.NoEncryption(),
)
private_key_b64 = base64.b64encode(priv_raw).decode()
# 公钥 → raw bytes → base64（用于 API 注册的 key 字段）
pub_raw = priv.public_key().public_bytes(
    encoding=serialization.Encoding.Raw,
    format=serialization.PublicFormat.Raw,
)
public_key_b64 = base64.b64encode(pub_raw).decode()
```

#### ECDSA P-256 密钥对（用于 MASQUE 模式）

```python
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.backends import default_backend
import base64

# 生成密钥对
priv = ec.generate_private_key(ec.SECP256R1(), default_backend())
# 私钥 → DER → base64（用于 Mihomo private-key）
priv_der = priv.private_bytes(
    encoding=serialization.Encoding.DER,
    format=serialization.PrivateFormat.PKCS8,
    encryption_algorithm=serialization.NoEncryption(),
)
private_key_b64 = base64.b64encode(priv_der).decode()
# 公钥 → DER → base64（用于 PATCH 请求的 key 字段）
pub_der = priv.public_key().public_bytes(
    encoding=serialization.Encoding.DER,
    format=serialization.PublicFormat.SubjectPublicKeyInfo,
)
public_key_b64 = base64.b64encode(pub_der).decode()
```

Go 实现（来自 usque）：
```go
// WireGuard
// (usque 用随机密钥，但我们需要真实密钥用于连接)
privKey, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
marshalledPrivKey, _ := x509.MarshalECPrivateKey(privKey)    // DER (SEC1)
marshalledPubKey, _ := x509.MarshalPKIXPublicKey(&privKey.PublicKey)  // PKIX DER
```

---

## 四、自动协议适配（核心设计）

### 4.1 设计原理

协议由服务器端（Cloudflare Zero Trust 控制台）配置决定，客户端需要自动适配。注册时用**真实的 WireGuard X25519 密钥对**（而非随机密钥），然后根据 API 返回的 `policy.tunnel_protocol` 字段决定后续行为：

```
注册设备 (POST /reg，用真实 X25519 公钥)
    ↓
检查 response.policy.tunnel_protocol
    ├─ "wireguard" → 用 X25519 私钥 + Step 1 返回的配置 → Mihomo wireguard outbound
    │                 （不需要第二步 API 调用）
    └─ "masque"    → 生成 ECDSA P-256 密钥对 → PATCH enroll → Mihomo masque outbound
                     （需要第二步 API 调用切换协议）
```

### 4.2 关键区别

| 维度 | WireGuard | MASQUE |
|------|-----------|--------|
| 密钥类型 | X25519 (curve25519) | ECDSA P-256 (secp256r1) |
| 密钥格式 | Raw 32 bytes → base64 | DER → base64 |
| 服务器公钥格式 | Raw base64（无 PEM 头尾） | PEM 格式（需去掉头尾） |
| 端口 | 2408 | 443 |
| 服务器 IP (ZT) | 162.159.193.10 | 162.159.197.2 |
| 服务器 IP (Consumer) | N/A (Consumer 默认 MASQUE) | 162.159.198.2 |
| 需要 Step 2 | 否（Step 1 配置直接可用） | 是（需要 PATCH enroll） |
| Mihomo type | `wireguard` | `masque` |

---

## 五、测试结果

### 5.1 Consumer WARP + MASQUE（自动适配）✅

```
[09:07:39] Registering (Consumer, no JWT)...
[09:07:41] SUCCESS! Account type: free
           Server policy tunnel_protocol: masque
[09:07:41] Auto-adapt: Server configured for MASQUE → enrolling MASQUE key
[09:07:43] Protocol: MASQUE
           Server: 162.159.198.2:443
           IPv4: 172.16.0.2/32
           IPv6: 2606:4700:110:83f7:43cd:4c4b:b6c4:78e4/128
```

### 5.2 Zero Trust + WireGuard（自动适配）✅

```
[09:08:49] Registering (Zero Trust with JWT)...
[09:08:52] SUCCESS! Account type: team, Organization: juwanhwang
           Server policy tunnel_protocol: wireguard
[09:08:52] Auto-adapt: Server configured for WireGuard → using WireGuard outbound
           Protocol: WireGuard
           Server: 162.159.193.10:2408
           IPv4: 100.96.0.4/32
           IPv6: 2606:4700:cf1:1000::4/128
           Server pubkey: bmXOC+F1FxEMF9dyiK2H5/1SUtzH0JuVo51h2wPfgyo= (X25519)
```

### 5.3 Zero Trust + MASQUE（早期测试）✅

```
[08:57:30] Registering (Zero Trust with JWT)...
[08:57:33] SUCCESS! Organization: juwanhwang
           Server policy tunnel_protocol: masque (服务器之前配置)
[08:57:35] Enroll MASQUE: SUCCESS!
           Server: 162.159.197.2:443
           IPv4: 100.96.0.2
```

### 5.4 生成的 Mihomo 配置对比

**WireGuard 模式（Zero Trust，服务器配置为 WireGuard）**：
```yaml
proxies:
- name: WARP-ZeroTrust
  type: wireguard           # ← 自动适配
  server: 162.159.193.10
  port: 2408                # ← WireGuard 标准端口
  ip: 100.96.0.4/32
  ipv6: 2606:4700:cf1:1000::4/128
  public-key: bmXOC+F1FxEMF9dyiK2H5/1SUtzH0JuVo51h2wPfgyo=  # X25519 raw base64
  private-key: <X25519 私钥 raw base64>
  mtu: 1280
  udp: true
```

**MASQUE 模式（Zero Trust 或 Consumer）**：
```yaml
proxies:
- name: WARP-ZeroTrust
  type: masque              # ← 自动适配
  server: 162.159.197.2
  port: 443                 # ← MASQUE 端口
  ip: 100.96.0.2/32
  ipv6: 2606:4700:cf1:1000::2/128
  public-key: MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE...  # ECDSA P-256 DER base64
  private-key: MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0w...  # ECDSA P-256 DER base64
  mtu: 1280
  udp: true
```

---

## 六、Zephyr 集成方案

### 6.1 集成架构

```
用户输入组织名 → Tauri WebView 打开 Cloudflare Access 登录页
    ↓
用户浏览器认证 → 页面 meta refresh 包含 JWT
    ↓
Rust 提取 JWT → 生成 X25519 密钥对 → 调用 WARP API 注册设备
    ↓
检查 response.policy.tunnel_protocol
    ├─ "wireguard" → 用 X25519 私钥 + Step 1 配置 → 生成 wireguard outbound
    └─ "masque"    → 生成 ECDSA P-256 密钥对 → PATCH enroll → 生成 masque outbound
    ↓
Rust 生成 Mihomo outbound YAML（自动适配协议类型）
    ↓
用户连接 WARP → Mihomo 通过 WireGuard/MASQUE 隧道连接 Cloudflare
```

### 6.2 Rust 后端实现要点

1. **WireGuard X25519 密钥对生成**：使用 `x25519-dalek` crate
2. **ECDSA P-256 密钥对生成**：使用 `p256` crate
3. **HTTP 请求**：`reqwest` crate 调用 WARP API
4. **JWT 提取**：从 Tauri WebView 的页面 HTML 中正则提取 `token=` 参数
5. **协议适配**：检查 `policy.tunnel_protocol` 字段，自动选择 WireGuard 或 MASQUE 路径
6. **配置生成**：生成 Mihomo YAML 格式的 outbound

### 6.3 前端 UI 要点

1. **组织名输入**：用户输入 Zero Trust 组织名（如 `juwanhwang`）
2. **WebView 登录**：打开 `https://<org>.cloudflareaccess.com/warp`
3. **JWT 监听**：监听页面加载完成，从 HTML 中提取 meta refresh 中的 JWT
4. **连接按钮**：注册完成后，在节点列表中显示 WARP 节点
5. **Consumer 模式**：无需组织名，直接注册

### 6.4 Consumer WARP 支持

同时支持 Consumer WARP（免费版），无需 JWT：
- 直接调 API 注册
- Consumer 默认返回 `tunnel_protocol: masque`
- 端点不同：`162.159.198.2`（Consumer）vs `162.159.193.10/162.159.197.2`（Zero Trust）

---

## 七、参考项目

| 项目 | 语言 | 用途 |
|------|------|------|
| [usque](https://github.com/Diniboy1123/usque) | Go | WARP MASQUE 配置生成工具，Mihomo 文档推荐 |
| [wgcf](https://github.com/ViRb3/wgcf) | Go | Consumer WARP WireGuard 配置生成 |
| [hiddify-app](https://github.com/hiddify/hiddify-app) | Flutter + Go | sing-box 代理客户端，支持 WARP chain 模式 |
| [oblivion-desktop](https://github.com/bepass-org/oblivion-desktop) | TypeScript + Go | WARP/Gool/Psiphon/MASQUE 桌面客户端 |

---

## 八、生成的测试文件

| 文件 | 说明 |
|------|------|
| `.research/test_warp_auto.py` | **自动适配测试脚本**（WireGuard/MASQUE 自动检测） |
| `.research/test_warp_masque.py` | Consumer WARP MASQUE 注册测试脚本 |
| `.research/test_warp_zerotrust.py` | Zero Trust MASQUE 注册测试脚本 |
| `.research/warp_consumer_auto_mihomo.yaml` | Consumer WARP 自动适配 Mihomo 配置 |
| `.research/warp_zerotrust_auto_mihomo.yaml` | Zero Trust 自动适配 Mihomo 配置（WireGuard） |
| `.research/warp_consumer_usque.json` | Consumer WARP usque 格式配置 |
| `.research/warp_consumer_mihomo.yaml` | Consumer WARP Mihomo 配置（早期测试） |
| `.research/warp_zerotrust_usque.json` | Zero Trust usque 格式配置 |
| `.research/warp_zerotrust_mihomo.yaml` | Zero Trust Mihomo 配置（早期 MASQUE 测试） |
| `.research/extract_warp_keys.py` | WARP 客户端密钥提取工具 |
| `.research/read_warp_db.py` | WARP SQLite 数据库读取工具 |

---

## 九、注意事项

1. **JWT 有效期仅 60 秒**：从浏览器提取 JWT 后必须立即调用 API，不能延迟
2. **设备 ID 格式**：Zero Trust 设备 ID 以 `t.` 前缀开头（如 `t.019f9bed-...`），Consumer 无前缀
3. **端点差异**：
   - Consumer MASQUE: `162.159.198.2:443`
   - Zero Trust MASQUE: `162.159.197.2:443`
   - Zero Trust WireGuard: `162.159.193.10:2408`
4. **接口 IP 差异**：Consumer `172.16.0.x`，Zero Trust `100.96.0.x`
5. **私钥存储**：生成的密钥需安全存储，不要明文保存在配置文件中
6. **服务器公钥格式差异**：
   - WireGuard: API 返回 raw base64（32 字节），可直接用于 Mihomo
   - MASQUE: API 返回 PEM 格式，需去掉 `-----BEGIN/END PUBLIC KEY-----` 头尾和换行符
7. **端口差异**：WireGuard 端口 `2408`，MASQUE 端口 `443`
8. **API 返回端口 `:0`**：WireGuard 端点端口为 `:0` 时使用默认 `2408`，MASQUE 端点端口为 `:0` 时使用 `443`
9. **注册密钥**：必须用真实的 WireGuard X25519 密钥对注册（不能随机），因为 WireGuard 模式下私钥直接用于 Mihomo 连接
10. **协议由服务器决定**：`policy.tunnel_protocol` 字段决定客户端走 WireGuard 还是 MASQUE，客户端只需自动适配
11. **Consumer 默认 MASQUE**：Consumer WARP 不支持 WireGuard 协议配置，始终返回 `masque`
