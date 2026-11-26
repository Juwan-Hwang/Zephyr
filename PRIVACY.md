# 隐私政策 · Privacy Policy

更新日期：2026-11-26 · Last updated: 2026-11-26

[中文](#中文) · [English](#english)

---

## 中文

### 简单说

Zephyr 没有账号，不收集使用统计，也没有自己的服务器。你的配置、订阅、规则、日志和设置保存在你自己的电脑上。

### Zephyr 自己会连接哪些地址

下面列出 Zephyr 应用本身会发出的网络请求（已对照源代码核对）。这些请求不带账号、设备编号或使用记录。

| 连接到 | 什么时候 | 发送了什么 | 用来做什么 |
|---|---|---|---|
| `api.github.com`（MetaCubeX/mihomo 的发布信息），不通时改用 `github.com/MetaCubeX/mihomo/releases.atom` | 打开「自动检查内核更新」后每次启动时（默认关闭），或你手动检查内核更新时 | 普通的网页请求。先直接连接，连不上再经过 Zephyr 自己的内核连接 | 查看内核有没有新版本 |
| `github.com/MetaCubeX/mihomo/releases/download/…`、`objects.githubusercontent.com` | 你选择更新内核时 | 同上 | 下载内核 |
| `api.github.com`（Juwan-Hwang/Zephyr 的发布信息） | 打开「自动检查应用更新」后每次启动时（默认关闭），或你手动检查更新时 | 同上 | 查看 Zephyr 有没有新版本 |
| `github.com/Juwan-Hwang/Zephyr/releases/download/…`、`objects.githubusercontent.com` | 你选择更新 Zephyr 时 | 同上 | 下载新版本 |
| `github.com/MetaCubeX/meta-rules-dat/releases/…` | 你在「Geo 数据库」点「立即更新」时 | 同上 | 下载 GeoIP / GeoSite 数据和校验值 |
| `api.github.com`（clash-verge-rev、mihomo-party、FlClash 三个项目的发布信息） | 「启用订阅客户端伪装」打开时（默认打开），应用启动后读取一次；在单个订阅里选用其中一个客户端并保存时也会读取 | 同上 | 取得这些客户端的最新版本号，下载订阅时填进 User-Agent |
| `www.gstatic.com/generate_204`（默认，可在设置里改成别的地址，例如 `cp.cloudflare.com`、`captive.apple.com`、`connect.rom.miui.com`） | 测试节点延迟时：你点测试，或控制台首页自动测当前节点 | 经由被测节点发出，对方看到的是节点的地址 | 测量节点延迟 |
| `cachefly.cachefly.net`（默认），或 `speed.cloudflare.com`、你自己填的地址 | 只有你开始测速时 | 经由被测节点发出，对方看到的是节点的地址 | 测下载速度 |
| `ip-info.com/json`，查不到时改用 `www.cloudflare.com/cdn-cgi/trace` | 只有打开「显示 IP 地址」后（默认关闭）：启动时、换节点后、你点「重新查询」时各查一次 | 经由当前节点发出，对方看到的是节点的地址，不是你的真实地址；无法这样查询的节点（例如 DIRECT）不会查询。结果只留在内存里，不写入磁盘或日志 | 显示网站看到的 IP 地址、大致位置和运营商。数据由 ip-info.com（Shifter）提供，见其[隐私政策](https://ip-info.com/privacy) |
| DNS 服务器：`doh.pub`、`dns.alidns.com`，备用 `dns.cloudflare.com`、`dns.google`；用来找到它们的 `223.5.5.5`、`119.29.29.29`、`1.1.1.1`、`8.8.8.8` | 「DNS 防泄漏」打开时（默认打开），由代理内核在需要解析域名时连接。服务器可以在设置里改 | 要解析的域名 | 解析域名，避免 DNS 绕过代理 |

### 你自己添加的地址

你添加的订阅链接、远程规则或脚本地址，以及订阅里的节点，Zephyr 会按你的设置去连接（例如下载、更新订阅）。这些服务由你选择，它们怎样处理数据，以各自的隐私政策为准。

### 代理内核

Zephyr 使用 mihomo 作为代理内核。内核替你电脑上的程序连接它们要访问的网站：按你的配置经节点转发，或在直连（DIRECT）模式和直连规则下直接连接。除此之外，内核只连接配置里的地址：你的节点、DNS 服务器和规则集地址。Zephyr 不会额外让内核连接其他地方。

### 打开外部网页

在「关于」里点 GitHub 主页、隐私政策或更新说明里的链接，会用你的默认浏览器打开这些网页。

### 联系我们

有疑问请到 [项目主页](https://github.com/Juwan-Hwang/Zephyr) 联系；安全漏洞请按 [SECURITY.md](SECURITY.md) 的方式私下报告。

这份政策有变化时，会更新本页和上面的日期。

---

## English

### In short

Zephyr has no account, does not collect usage statistics, and has no server of its own. Your profiles, subscriptions, rules, logs and settings are stored on your own computer.

### What Zephyr itself connects to

Below are the network requests the Zephyr app itself makes (checked against the source code). They do not include an account, device ID or usage history.

| Connects to | When | What is sent | Why |
|---|---|---|---|
| `api.github.com` (MetaCubeX/mihomo releases); if unreachable, `github.com/MetaCubeX/mihomo/releases.atom` | On every start when "Check for core updates" is on (off by default), or when you check for core updates | An ordinary web request. Sent directly first, then through Zephyr's own core if the direct route fails | See whether a newer core is available |
| `github.com/MetaCubeX/mihomo/releases/download/…`, `objects.githubusercontent.com` | When you choose to update the core | Same as above | Download the core |
| `api.github.com` (Juwan-Hwang/Zephyr releases) | On every start when "Check for app updates" is on (off by default), or when you check for updates | Same as above | See whether a newer Zephyr is available |
| `github.com/Juwan-Hwang/Zephyr/releases/download/…`, `objects.githubusercontent.com` | When you choose to update Zephyr | Same as above | Download the new version |
| `github.com/MetaCubeX/meta-rules-dat/releases/…` | When you click "Update Now" under "Geo Databases" | Same as above | Download the GeoIP / GeoSite data and checksums |
| `api.github.com` (clash-verge-rev, mihomo-party and FlClash releases) | Once after start while "Subscription Fake Client" is on (on by default), and again when you pick one of those clients for a single subscription and save | Same as above | Get those clients' latest version numbers for the User-Agent used when downloading subscriptions |
| `www.gstatic.com/generate_204` (default; you can change it in Settings, e.g. to `cp.cloudflare.com`, `captive.apple.com` or `connect.rom.miui.com`) | When a node's latency is tested: when you test, or when the console home tests the current node | Sent through the node being tested, so the site sees the node's address | Measure latency |
| `cachefly.cachefly.net` (default), or `speed.cloudflare.com` or an address you enter | Only when you start a speed test | Sent through the node being tested, so the site sees the node's address | Measure download speed |
| `ip-info.com/json`; if that fails, `www.cloudflare.com/cdn-cgi/trace` | Only when "Show IP Address" is on (off by default): once at start, after a node switch, and when you click "Look up again" | Sent through the node in use, so the site sees the node's address, not your real one; a node that cannot be reached this way (for example DIRECT) is not looked up. The result stays in memory only and is never written to disk or logs | Show the IP address sites see, its approximate location and network. Data provided by ip-info.com (Shifter); see their [privacy policy](https://ip-info.com/privacy) |
| DNS servers: `doh.pub`, `dns.alidns.com`, fallback `dns.cloudflare.com`, `dns.google`; and `223.5.5.5`, `119.29.29.29`, `1.1.1.1`, `8.8.8.8` to reach them | While "DNS Leak Protection" is on (on by default), by the proxy core when it needs to resolve a name. You can change the servers in Settings | The domain names being resolved | Resolve names so DNS does not bypass the proxy |

### Addresses you add

Subscription links, remote rule or script addresses and the nodes in your subscriptions are contacted because you set them up (for example to download or refresh a subscription). Those services are your choice, and their own privacy policies apply.

### The proxy core

Zephyr runs mihomo as its proxy core. The core connects to the sites the programs on your computer ask for: through your nodes as your configuration says, or directly in DIRECT mode and for direct rules. Beyond that, it only connects to addresses in your configuration: your nodes, the DNS servers and the rule sets. Zephyr does not make the core connect anywhere else.

### Opening web pages

Links in About (GitHub homepage, this privacy policy, release notes) open in your default browser.

### Contact

Questions: see the [project page](https://github.com/Juwan-Hwang/Zephyr). Security vulnerabilities: please report them privately as described in [SECURITY.md](SECURITY.md).

When this policy changes, this page and the date above are updated.
