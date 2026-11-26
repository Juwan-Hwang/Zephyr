# 隐私政策 · Privacy Policy

更新日期：2026-11-28 · Last updated: 2026-11-28

[中文](#中文) · [English](#english)

---

## 中文

### 简单说

Zephyr 没有账号，不收集使用统计，也没有自己的服务器。你的配置、订阅、规则、日志和设置保存在你自己的电脑上。

### Zephyr 自己会连接哪些地址

下面列出 Zephyr 应用本身会发出的网络请求（已对照源代码核对）。Zephyr 不会主动附加账号、设备编号或使用记录；你自定义的网址会按填写的内容发送，包括其中的查询参数或凭据。

| 连接到 | 什么时候 | 发送了什么 | 用来做什么 |
|---|---|---|---|
| `api.github.com`（MetaCubeX/mihomo 的发布信息）和 `github.com/MetaCubeX/mihomo/releases.atom`（版本检查时两者同时请求，用先回来的那个；补取校验值只请求 API） | 打开「自动检查内核更新」后每次启动时（默认关闭），你手动检查内核更新时，更新内核需要补取校验值时，或更新 Zephyr 时需要自动选择安装包类型时 | 普通的网页请求。先直接连接，连不上再经过 Zephyr 自己的内核连接 | 查看内核有没有新版本、选择安装包类型，或取得 SHA256 校验值以验证下载的内核 |
| `github.com/MetaCubeX/mihomo/releases/download/…`、`objects.githubusercontent.com`、`release-assets.githubusercontent.com` | 你选择更新内核时 | 同上 | 下载内核 |
| `api.github.com`（Juwan-Hwang/Zephyr 的发布信息） | 打开「自动检查应用更新」后每次启动时（默认关闭），你手动检查更新时，或选择更新 Zephyr、下载安装包之前 | 同上 | 查看 Zephyr 有没有新版本，取得安装包信息及用于完整性验证的校验值 |
| `github.com/Juwan-Hwang/Zephyr/releases/download/…`、`objects.githubusercontent.com`、`release-assets.githubusercontent.com` | 你选择更新 Zephyr 时 | 同上 | 下载新版本 |
| `github.com/MetaCubeX/meta-rules-dat/releases/…`、`objects.githubusercontent.com`、`release-assets.githubusercontent.com` | 你在「Geo 数据库」点「立即更新」时 | 同上 | 下载 GeoIP / GeoSite 数据和校验值 |
| `api.github.com`（clash-verge-rev、mihomo-party、FlClash 三个项目的发布信息） | 「启用订阅客户端伪装」打开时（默认打开），应用启动后读取一次；启动后再打开该选项时，如本次会话尚未成功读取版本，会立即发起读取；在单个订阅里选用其中一个客户端并保存时也会读取 | 同上 | 取得这些客户端的最新版本号，下载订阅时填进 User-Agent |
| `www.gstatic.com/generate_204`（默认，可在设置里改成别的地址，例如 `cp.cloudflare.com`、`captive.apple.com`、`connect.rom.miui.com`） | 测试节点延迟时：你点测试，控制台首页自动测当前节点，或同时打开「节点评分」和「定时测速」后（默认关闭）定期测试所有节点 | 经由被测节点发出，对方看到的是节点的地址；被测的是 DIRECT（直连）时不经过代理，对方看到的是你自己的公网地址 | 测量节点延迟 |
| `cachefly.cachefly.net`（默认），或 `speed.cloudflare.com`、你自己填的地址 | 只有你开始测速时 | 经由被测节点发出，对方看到的是节点的地址 | 测下载速度 |
| `ip-info.com/json`，查不到时改用 `www.cloudflare.com/cdn-cgi/trace` | 只有打开「显示 IP 地址」后（默认关闭）：启动时、换节点后、你点「重新查询」时各查一次；ip-info.com 暂时不可用（连不上或返回 503/504）时，会在 1、2、4 秒后最多再试 3 次，仍不行才改用 Cloudflare；某次没查到时，30 秒后再试一次 | 经由当前节点发出，对方看到的是节点的出口地址；若节点与你共用同一公网出口（例如同一路由器下的自建节点），这就是你自己的公网地址；无法这样查询的节点（例如 DIRECT）不会查询。结果只留在内存里，不写入磁盘或日志 | 显示网站看到的 IP 地址、大致位置和运营商。数据由 ip-info.com（Shifter）提供，见其[隐私政策](https://ip-info.com/privacy) |
| DNS 服务器：`doh.pub`、`dns.alidns.com`，备用 `dns.cloudflare.com`、`dns.google`；用来找到它们的 `223.5.5.5`、`119.29.29.29`、`1.1.1.1`、`8.8.8.8` | 「DNS 防泄漏」打开时（默认打开），由代理内核在需要解析域名时连接。服务器可以在设置里改 | 要解析的域名 | 解析域名，避免 DNS 绕过代理 |

### 你自己添加的地址

你添加的订阅链接、远程规则或脚本地址，以及订阅里的节点，Zephyr 会按你的设置去连接（例如下载、更新订阅）。这些服务由你选择，它们怎样处理数据，以各自的隐私政策为准。

### 代理内核

Zephyr 使用 mihomo 作为代理内核。内核替你电脑上的程序连接它们要访问的网站：按你的配置经节点转发，或在直连（DIRECT）模式和直连规则下直接连接。除此之外，内核只连接配置里的地址（你的节点、DNS 服务器和规则集地址），以及上表里 Zephyr 交给内核发出的延迟测试、测速和 IP 查询地址。测试直连（DIRECT）的延迟时，请求由内核直接发出；出口 IP 查询只针对可用的代理节点，不查询 DIRECT。Zephyr 不会额外让内核连接其他地方。

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

Below are the network requests the Zephyr app itself makes (checked against the source code). Zephyr does not add account details, device IDs or usage history. Custom URLs are sent as entered, including any query parameters or credentials you put in them.

| Connects to | When | What is sent | Why |
|---|---|---|---|
| `api.github.com` (MetaCubeX/mihomo releases) and `github.com/MetaCubeX/mihomo/releases.atom` (version checks request both at once and use the first answer; missing digests use only the API) | On every start when "Check for core updates" is on (off by default), when you check for core updates, when a core update needs a missing digest, or when a Zephyr update needs to choose an installer variant automatically | An ordinary web request. Sent directly first, then through Zephyr's own core if the direct route fails | Check for a newer core, choose an installer variant, or obtain the SHA256 digest to verify the downloaded core |
| `github.com/MetaCubeX/mihomo/releases/download/…`, `objects.githubusercontent.com`, `release-assets.githubusercontent.com` | When you choose to update the core | Same as above | Download the core |
| `api.github.com` (Juwan-Hwang/Zephyr releases) | On every start when "Check for app updates" is on (off by default), when you check for updates, or before downloading the installer when you choose to update Zephyr | Same as above | Check for a newer Zephyr and obtain installer details and the digest used for integrity verification |
| `github.com/Juwan-Hwang/Zephyr/releases/download/…`, `objects.githubusercontent.com`, `release-assets.githubusercontent.com` | When you choose to update Zephyr | Same as above | Download the new version |
| `github.com/MetaCubeX/meta-rules-dat/releases/…`, `objects.githubusercontent.com`, `release-assets.githubusercontent.com` | When you click "Update Now" under "Geo Databases" | Same as above | Download the GeoIP / GeoSite data and checksums |
| `api.github.com` (clash-verge-rev, mihomo-party and FlClash releases) | Once after start while "Subscription Fake Client" is on (on by default); enabling it after startup starts a lookup immediately if versions have not already been fetched successfully in that session; also when you pick one of those clients for a single subscription and save | Same as above | Get those clients' latest version numbers for the User-Agent used when downloading subscriptions |
| `www.gstatic.com/generate_204` (default; you can change it in Settings, e.g. to `cp.cloudflare.com`, `captive.apple.com` or `connect.rom.miui.com`) | When a node's latency is tested: when you test, when the console home tests the current node, or, with both "Node Scoring" and "Scheduled Speed Test" on (off by default), every node at regular intervals | Sent through the node being tested, so the site sees the node's address; when DIRECT is tested, the request does not go through a proxy and the site sees your own public address | Measure latency |
| `cachefly.cachefly.net` (default), or `speed.cloudflare.com` or an address you enter | Only when you start a speed test | Sent through the node being tested, so the site sees the node's address | Measure download speed |
| `ip-info.com/json`; if that fails, `www.cloudflare.com/cdn-cgi/trace` | Only when "Show IP Address" is on (off by default): once at start, after a node switch, and when you click "Look up again"; if ip-info.com cannot be reached or answers 503/504, it is retried up to 3 times after 1, 2 and 4 seconds before Cloudflare is tried; a lookup that finds nothing is tried once more 30 seconds later | Sent through the node in use, so the site sees that node's exit address; if the node shares your public network (for example a self-hosted node behind the same router), that is your own public address; a node that cannot be reached this way (for example DIRECT) is not looked up. The result stays in memory only and is never written to disk or logs | Show the IP address sites see, its approximate location and network. Data provided by ip-info.com (Shifter); see their [privacy policy](https://ip-info.com/privacy) |
| DNS servers: `doh.pub`, `dns.alidns.com`, fallback `dns.cloudflare.com`, `dns.google`; and `223.5.5.5`, `119.29.29.29`, `1.1.1.1`, `8.8.8.8` to reach them | While "DNS Leak Protection" is on (on by default), by the proxy core when it needs to resolve a name. You can change the servers in Settings | The domain names being resolved | Resolve names so DNS does not bypass the proxy |

### Addresses you add

Subscription links, remote rule or script addresses and the nodes in your subscriptions are contacted because you set them up (for example to download or refresh a subscription). Those services are your choice, and their own privacy policies apply.

### The proxy core

Zephyr runs mihomo as its proxy core. The core connects to the sites the programs on your computer ask for: through your nodes as your configuration says, or directly in DIRECT mode and for direct rules. Beyond that, it only connects to addresses in your configuration (your nodes, the DNS servers and the rule sets) and to the latency-test, speed-test and IP-lookup addresses in the table above, which Zephyr sends through the core. Latency requests for DIRECT are sent directly by the core; exit-IP lookups only target usable proxy nodes and do not query DIRECT. Zephyr does not make the core connect anywhere else.

### Opening web pages

Links in About (GitHub homepage, this privacy policy, release notes) open in your default browser.

### Contact

Questions: see the [project page](https://github.com/Juwan-Hwang/Zephyr). Security vulnerabilities: please report them privately as described in [SECURITY.md](SECURITY.md).

When this policy changes, this page and the date above are updated.
