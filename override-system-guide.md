# Zephyr 覆写系统完整指南

> Zephyr 提供两种覆写格式：**Prism DSL（YAML）** 和 **JavaScript 脚本**，两者共享统一的管道、作用域和排序机制。

---

## 目录

1. [架构总览](#1-架构总览)
2. [Prism DSL vs JS 脚本：如何选择？](#2-prism-dsl-vs-js-脚本如何选择)
3. [覆写管道与执行顺序](#3-覆写管道与执行顺序)
4. [作用域系统](#4-作用域系统)
5. [Prism DSL 详解](#5-prism-dsl-详解)
   - 5.1 [DSL 操作符一览](#51-dsl-操作符一览)
   - 5.2 [`$prepend` / `$append` — 数组前后插入](#52-prepend--append--数组前后插入)
   - 5.3 [`$override` — 强制覆盖](#53-override--强制覆盖)
   - 5.4 [`$default` — 默认值注入](#54-default--默认值注入)
   - 5.5 [`$filter` — 元素过滤](#55-filter--元素过滤)
   - 5.6 [`$transform` — 元素变换](#56-transform--元素变换)
   - 5.7 [`$remove` — 元素删除](#57-remove--元素删除)
   - 5.8 [`$filter` / `$transform` / `$remove` 中可用的属性](#58-filter--transform--remove-中可用的属性)
6. [条件系统 `__when__`](#6-条件系统 __when__)
7. [变量模板 `{{var}}`](#7-变量模板 var)
   - [`__vars__` 文件级变量声明](#__vars__-文件级变量声明)
8. [依赖声明 `__after__`](#8-依赖声明 __after__)
9. [JavaScript 脚本详解](#9-javascript-脚本详解)
   - 9.1 [脚本入口函数](#91-脚本入口函数)
   - 9.2 [可用 API](#92-可用-api)
   - 9.3 [沙箱安全机制](#93-沙箱安全机制)
   - 9.4 [资源限制](#94-资源限制)
   - 9.5 [禁止操作](#95-禁止操作)
10. [规则库与 `{{proxy}}` 变量](#10-规则库与-proxy-变量)
11. [示例脚本集合](#11-示例脚本集合)
12. [常见问题与注意事项](#12-常见问题与注意事项)

---

## 1. 架构总览

```
订阅原始配置 (profile.yaml)
    │
    ▼
┌─ Phase 1: Prism DSL 引擎 ─────────────────────────┐
│  .prism.yaml 文件按 __after__ 依赖排序执行          │
│  7 种显式操作 + DeepMerge + 条件执行 + 变量模板     │
└────────────────────────────────────────────────────┘
    │
    ▼
┌─ Phase 2: JS 覆写管道 ────────────────────────────┐
│  按 UI 中拖拽顺序依次执行                           │
│  每个: main(config) → 返回修改后的 config           │
│  容错: 单个失败不中断管道，记录日志继续              │
│  沙箱: QuickJS + 5 层纵深防御                       │
└────────────────────────────────────────────────────┘
    │
    ▼
┌─ Phase 3: GlobalPreferences 注入 ─────────────────┐
│  mode / tun / port / ipv6 / allow-lan 等 UI 设置   │
└────────────────────────────────────────────────────┘
    │
    ▼
  最终配置 → 热重载 (PUT /configs，无需重启内核)
```

**关键设计**：
- Prism DSL 在前，JS 覆写在后。JS 可以读取和修改 Prism 处理后的结果。
- GlobalPreferences 最后注入，确保 UI 设置始终拥有最高优先级。
- 热重载而非重启内核进程，配置变更瞬时生效。

---

## 2. Prism DSL vs JS 脚本：如何选择？

| 维度 | Prism DSL（YAML） | JavaScript 脚本 |
|------|-------------------|------------------|
| **格式** | YAML + DSL 操作符 | 标准 JavaScript |
| **适用场景** | 规则注入、DNS/TUN 配置、代理组微调 | 动态分组、条件逻辑、复杂数据变换 |
| **学习曲线** | 低（声明式，YAML 即配置） | 中（需要编程基础） |
| **灵活性** | 中（DSL 操作符覆盖常见场景） | 高（图灵完备，任意逻辑） |
| **安全性** | 高（纯数据，无代码执行） | 高（QuickJS 沙箱 + 5 层纵深防御） |
| **调试** | Prism Trace 报告 | `log.*` 输出 + 执行结果面板 |
| **编辑器** | Prism DSL 高亮 + 自动补全 | JavaScript 语法高亮 + 自动补全 |
| **条件执行** | `__when__` 块 | 脚本内 `if` 判断 |
| **变量模板** | `{{var\|default}}` | 直接 JS 变量 |

**选择建议**：
- ✅ 简单的规则注入、DNS 配置 → **Prism DSL**
- ✅ 需要条件执行、变量模板 → **Prism DSL**（内置支持）
- ✅ 需要动态分组、复杂遍历逻辑 → **JavaScript**
- ✅ 两者可组合使用 — Prism 先注入基础配置，JS 再做动态调整

---

## 3. 覆写管道与执行顺序

所有覆写项在管道中按以下规则排序执行：

1. **Prism YAML 覆写**：按 `__after__` 依赖拓扑排序（无依赖则按文件名排序）
2. **JS 覆写**：按 UI 中拖拽排列的 `order` 字段顺序执行
3. **容错机制**：单个覆写失败只记录日志和警告，不中断后续覆写

每个 JS 覆写接收上一个覆写输出的 config 作为输入，形成链式处理：

```
原始 config → Prism patches → JS 覆写 #1 → JS 覆写 #2 → ... → GlobalPrefs → 最终 config
```

---

## 4. 作用域系统

每个覆写项有两种作用域：

| 作用域 | 说明 | 行为 |
|--------|------|------|
| **全局** (`global: true`) | 对所有订阅生效 | 默认创建即为全局 |
| **指定订阅** (`global: false`) | 仅对勾选的订阅生效 | 需手动关联订阅 |

**操作方式**：
- 新建覆写 → 默认全局，保存即对所有订阅生效
- 需要限定范围：点击卡片上的"全局"标签 → 切换为"指定订阅" → 勾选目标订阅

**作用域过滤规则**：执行 `override_apply_all` 时，仅应用满足以下条件之一的覆写：
- `global == true`
- `profile_ids` 包含当前活动订阅的文件名

---

## 5. Prism DSL 详解

Prism DSL 是标准 YAML 的超集，在 YAML 值位置引入了 `$` 前缀操作符，用于精确控制配置合并行为。

### 5.1 DSL 操作符一览

| 操作符 | 适用类型 | 作用 |
|--------|---------|------|
| `$prepend` | 数组 | 在数组头部插入元素 |
| `$append` | 数组 | 在数组尾部追加元素 |
| `$override` | 字典 | 强制覆盖（不合并，直接替换） |
| `$default` | 字典 | 仅在字段不存在或为 null 时注入默认值（空数组 `[]` 和空字典 `{}` 不触发） |
| `$filter` | 数组 | 用 JS 表达式过滤元素 |
| `$transform` | 数组 | 用 JS 表达式变换元素 |
| `$remove` | 数组 | 用 JS 表达式删除匹配元素 |

> **执行顺序**：当同一个键下声明了多个操作时，按以下固定顺序执行，不依赖 YAML 键的书写顺序：
>
> ```
> $filter → $remove → $transform → $default → $prepend → $append → DeepMerge → $override
> ```
>
> 理由：先过滤/删除（减少），再变换（修改），再注入默认值（兜底），最后插入（增加）。`$override` 是独占操作，不可与其他操作混用。DeepMerge 是无标签的默认行为。

### 5.2 `$prepend` / `$append` — 数组前后插入

最常用的操作符，用于向 `rules`、`proxies`、`proxy-groups` 等数组字段插入元素。

```yaml
# 在规则列表头部注入广告拦截规则（优先匹配）
rules:
  $prepend:
    - "DOMAIN-SUFFIX,ads.google.com,REJECT"
    - "DOMAIN-KEYWORD,adservice,REJECT"
    - "DOMAIN,ad.doubleclick.net,REJECT"

# 在规则列表尾部追加兜底规则
rules:
  $append:
    - "MATCH,{{proxy}}"
```

```yaml
# 在代理组列表头部插入自定义组
proxy-groups:
  $prepend:
    - name: "🚀 Proxy"
      type: select
      proxies:
        - DIRECT
        - "{{proxy}}"
```

> **注意**：`$prepend` 和 `$append` 可以在同一个键上同时使用，Prism 引擎会自动组合。
>
> **关键语义**：`$prepend`/`$append` 插入的元素**不受** `$filter` 约束。`$filter` 只作用于执行前数组中已存在的元素，新插入的元素直接进入最终数组。

### 5.3 `$override` — 强制覆盖

默认情况下，字典类型的值会深度合并（DeepMerge）。使用 `$override` 可以强制替换整个值，不进行合并。

```yaml
# 强制覆盖 DNS 配置（不与原始配置合并）
dns:
  $override:
    enable: true
    enhanced-mode: fake-ip
    fake-ip-range: 198.18.0.1/16
    nameserver:
      - https://doh.pub/dns-query
      - https://dns.alidns.com/dns-query
```

### 5.4 `$default` — 默认值注入

仅在目标配置中**不存在**该字段或字段值为 `null` 时才注入值。空数组 `[]` 和空字典 `{}` 是有效值，**不会**触发默认值注入。适合注入安全的默认配置，不影响用户已有设置。

```yaml
# 仅在配置中不存在 dns 字段时注入
dns:
  $default:
    enable: true
    enhanced-mode: redir-host
    nameserver:
      - 223.5.5.5
      - 119.29.29.29

# 仅在配置中不存在 tun 字段时注入
tun:
  $default:
    enable: false
    stack: system
```

### 5.5 `$filter` — 元素过滤

用 JS 表达式过滤数组元素。表达式中的 `p` 代表当前元素，返回 `true` 保留，`false` 移除。

```yaml
# 过滤掉名称包含"过期"的节点
proxies:
  $filter: "p.name.includes('过期')"

# 过滤掉 TLS 未启用的节点
proxies:
  $filter: "p.tls === true"

# 过滤掉 skip-cert-verify 为 true 的节点
proxies:
  $filter: "!p['skip-cert-verify']"
```

### 5.6 `$transform` — 元素变换

用 JS 表达式变换数组元素。可以修改 `p` 的属性，修改后保留该元素。

```yaml
# 节点名称规范化：去掉名称中的括号备注
proxies:
  $transform: "p.name = p.name.replace(/\\s*\\(.*\\)/, '')"

# 为所有节点启用 TLS
proxies:
  $transform: "p.tls = true"
```

### 5.7 `$remove` — 元素删除

用 JS 表达式删除匹配的数组元素。表达式返回 `true` 时删除该元素。

```yaml
# 删除名称包含"官网"的节点
proxies:
  $remove: "p.name.includes('官网')"

# 删除 server 为内网地址的节点
proxies:
  $remove: "p.server.startsWith('10.') || p.server.startsWith('192.168.')"
```

### 5.8 `$filter` / `$transform` / `$remove` 中可用的属性

在 JS 表达式中，`p` 代表当前代理节点元素，可访问以下属性：

| 属性 | 类型 | 说明 |
|------|------|------|
| `p.name` | string | 节点名称 |
| `p.type` | string | 协议类型（ss, vmess, trojan, vless, hysteria...） |
| `p.server` | string | 服务器地址 |
| `p.port` | number | 端口号 |
| `p.uuid` | string | UUID（ss/vmess） |
| `p.cipher` | string | 加密方式 |
| `p.tls` | boolean | 是否启用 TLS |
| `p.sni` | string | SNI 主机名 |
| `p.network` | string | 传输协议（ws, grpc, h2...） |
| `p.flow` | string | 流控（vless XTLS） |
| `p.fingerprint` | string | TLS 指纹 |
| `p.alpn` | string[] | ALPN 协议列表 |
| `p.skip-cert-verify` | boolean | 是否跳过证书验证 |

---

## 6. 条件系统 `__when__`

Prism DSL 支持 `__when__` 条件块，实现**条件执行**。只有所有条件满足时，该文件中的 patch 才会被应用。

```yaml
__when__:
  profile: [SubA, SubB]
  time: "20:00-23:59"
  platform: windows
  enabled: true

rules:
  $prepend:
    - "DOMAIN-SUFFIX,netflix.com,{{proxy}}"
```

### 支持的条件字段

| 字段 | 类型 | 说明 | 示例 |
|------|------|------|------|
| `enabled` | boolean | 开关，`false` 时整个文件不执行 | `enabled: false` |
| `profile` | string 或 string[] | 当前订阅名匹配时执行（支持正则） | `profile: [SubA, SubB]` |
| `time` | string | 时间范围，格式 `HH:mm-HH:mm` | `time: "09:00-18:00"` |
| `platform` | string 或 string[] | 操作系统匹配 | `platform: [windows, macos]` |
| `core` | string | 内核类型匹配 | `core: mihomo` |
| `ssid` | string | WiFi SSID 匹配 | `ssid: "Office-WiFi"` |

### `profile` 条件详解

`profile` 字段支持两种格式：

```yaml
# 列表格式（精确匹配文件名，不含扩展名）
__when__:
  profile: [SubA, SubB, SubC]

# 正则表达式（匹配订阅名）
__when__:
  profile: /流媒体|解锁/
```

### `platform` 条件详解

`platform` 支持 5 个值，也可以使用数组匹配多个平台：

```yaml
# 单个平台
__when__:
  platform: windows

# 多个平台（任一匹配即生效）
__when__:
  platform: [windows, macos, linux]
```

| 值 | 说明 |
|------|------|
| `windows` | Windows 系统 |
| `macos` | macOS 系统 |
| `linux` | Linux 系统 |
| `android` | Android 系统 |
| `ios` | iOS 系统 |

### 规则库中的 `__when__`

从订阅提取规则到规则库时，会自动添加 `__when__: { enabled: false }`，防止新提取的规则立即生效。用户需要通过右键菜单手动关联订阅后才会启用。

---

## 7. 变量模板 `{{var}}`

Prism DSL 支持 `{{var}}` 和 `{{var|default}}` 格式的变量模板，在 patch 应用时动态替换。

### 内置变量

| 变量 | 说明 | 来源 |
|------|------|------|
| `{{proxy}}` | 当前订阅的第一个可用代理组名 | 从 `run_config.yaml` 的 `proxy-groups[0].name` 提取 |
| `{{组名}}` | 指定代理组的名称（身份映射） | 如 `{{SubA}}` → `SubA`（如果该组存在） |

### 变量解析规则

1. 引擎读取当前 `run_config.yaml` 中所有 `proxy-groups[].name` 构建变量表
2. `proxy` = 第一个非特殊组名（跳过 GLOBAL/DIRECT/REJECT/PASS）
3. 每个组名同时作为自身变量（`{{SubA}}` → `SubA`），用于跨订阅引用特定组
4. 支持 `{{var|default}}` 语法，变量不存在时使用默认值
5. 文件级变量声明 `__vars__` 可提供变量默认值（优先级低于运行时值）

### `__vars__` 文件级变量声明

在 `.prism.yaml` 文件中使用 `__vars__` 声明变量默认值，当运行时变量表中不存在该变量时使用：

```yaml
__vars__:
  proxy: DIRECT        # 为 {{proxy}} 提供默认值
  region: 亚太          # 自定义变量默认值

rules:
  $append:
    - "DOMAIN-SUFFIX,example.com,{{proxy|DIRECT}}"
    - "DOMAIN-KEYWORD,{{region}},{{proxy}}"
```

> **优先级**：`PrismHost.get_variables()` 运行时值 > `__vars__` 文件默认值 > `{{var|default}}` 语法默认值

### `{{proxy}}` 的典型用法

```yaml
# 规则中的代理策略使用 {{proxy}} 实现跨订阅兼容
rules:
  $append:
    - "DOMAIN-SUFFIX,google.com,{{proxy}}"
    - "DOMAIN-KEYWORD,youtube,{{proxy}}"
    - "GEOIP,CN,DIRECT"
    - "MATCH,{{proxy}}"            # 兜底规则也使用 {{proxy}}
```

> **重要**：所有从订阅提取的规则，非内置策略（DIRECT/REJECT/PASS）都会自动替换为 `{{proxy}}`，包括 `MATCH,组名` 格式的兜底规则。

---

## 8. 依赖声明 `__after__`

当多个 `.prism.yaml` 文件有执行顺序依赖时，使用 `__after__` 声明依赖：

```yaml
# 01-dns.prism.yaml — 基础 DNS 配置
dns:
  $default:
    enable: true
    enhanced-mode: fake-ip
```

```yaml
# 02-dns-override.prism.yaml — 依赖 01-dns 先执行
__after__: "01-dns"

dns:
  nameserver:
    $append:
      - tls://8.8.8.8:853
```

Prism 引擎会自动进行拓扑排序，确保 `01-dns` 在 `02-dns-override` 之前执行。

> **引用格式**：`__after__` 支持完整文件名（如 `"01-dns.prism.yaml"`）和短名称（如 `"01-dns"`），引擎自动匹配。同级无依赖的文件按文件名字典序排列（确定性输出）。

---

## 9. JavaScript 脚本详解

JS 覆写脚本运行在 **QuickJS 沙箱**中，拥有完整的 JavaScript 运行时能力，但受严格的安全限制。

### 9.1 脚本入口函数

每个 JS 覆写必须导出一个 `main` 函数：

```javascript
/**
 * 覆写入口函数
 * @param {Object} config - 当前 Mihomo 配置（JSON 对象）
 * @returns {Object} 修改后的配置（必须返回）
 */
function main(config) {
    // 读取配置
    var port = config['mixed-port'];

    // 修改配置
    config['mixed-port'] = 7890;

    // 必须返回修改后的配置
    return config;
}
```

**关键规则**：
- 函数名必须是 `main`
- 参数 `config` 是当前配置的深拷贝（JSON 冻结，不会污染原始配置）
- **必须返回**修改后的 config 对象，不返回或返回 `undefined` 将导致配置丢失
- 返回的 config 会作为下一个覆写的输入

### 9.2 可用 API

#### `log` — 日志输出

```javascript
log.info('信息日志');     // 普通信息
log.warn('警告日志');     // 警告
log.error('错误日志');    // 错误
log.debug('调试日志');    // 调试（默认不显示）
```

日志会显示在覆写卡片的"输出"面板中，方便调试。

#### `config` — 配置读写

```javascript
config.get()              // 获取完整配置对象
config.get('mixed-port')  // 获取指定字段
config.set('key', value)  // 修改配置（返回 Patch IR）
```

#### `env` — 环境信息（只读）

```javascript
env.coreType      // "mihomo" | "clash-rs"
env.coreVersion   // 版本字符串
env.platform      // "windows" | "macos" | "linux"
env.profileName   // 当前 Profile 名称
```

#### `utils` — 结构化工具（推荐使用）

```javascript
// 代理节点工具
utils.proxies.filter(pred)               // 过滤代理节点
utils.proxies.rename(regex, replacement) // 批量重命名
utils.proxies.remove(pred)               // 删除匹配的代理
utils.proxies.sort(field, order?)        // 排序
utils.proxies.deduplicate(by?)           // 去重
utils.proxies.groupBy(pattern)           // 按正则分组

// 规则工具
utils.rules.prepend(...rules)            // 规则前置插入
utils.rules.append(...rules)             // 规则末尾追加
utils.rules.insertAt(idx, ...rules)      // 指定位置插入
utils.rules.remove(pred)                 // 删除规则
utils.rules.deduplicate()                // 规则去重

// 代理组工具
utils.groups.get(name)                   // 获取代理组
utils.groups.addProxy(group, ...names)   // 向组添加代理
utils.groups.removeProxy(group, ...names)// 从组移除代理
utils.groups.create(group)               // 创建新代理组
utils.groups.remove(name)                // 删除代理组

// 基础工具函数
utils.match(pattern, str)               // glob 模式匹配
utils.includes(arr, item)               // 数组包含检查
utils.now()                             // 当前时间戳（毫秒）
utils.random(min, max)                  // [min, max] 范围随机整数
utils.hash(str)                         // 字符串哈希值
```

#### `patch` — Patch 生成（高级用法）

```javascript
patch.add(patchObj)    // 注册一个 Patch（高级条件化配置变换）
```

#### `store` — KV 持久存储（跨脚本）

```javascript
store.get(key)         // 读取值（不存在返回 undefined）
store.set(key, value)  // 写入值
store.delete(key)      // 删除键
store.keys()           // 列出所有键名
```

#### `main(config)` 中的 config 结构

`main(config)` 的参数 `config` 是完整的 Mihomo 配置对象，常用字段：

```javascript
config['mixed-port']           // 混合端口
config.port                    // HTTP 端口
config['socks-port']           // SOCKS5 端口
config.mode                    // 运行模式: rule / global / direct
config.proxies                 // 代理节点数组
config['proxy-groups']         // 代理组数组
config.rules                   // 规则数组
config.dns                     // DNS 配置
config.tun                     // TUN 配置
```

**config.proxies 结构**：

```javascript
config.proxies.forEach(function(proxy) {
    proxy.name       // 节点名称
    proxy.type       // 协议: ss, vmess, trojan, vless, hysteria...
    proxy.server     // 服务器地址
    proxy.port       // 端口
    proxy.tls        // 是否启用 TLS
    // ...其他协议特有字段
});
```

**config['proxy-groups'] 结构**：

```javascript
config['proxy-groups'].forEach(function(group) {
    group.name       // 组名
    group.type       // 类型: select, url-test, fallback, load-balance
    group.proxies    // 包含的代理/组名列表
    group.now        // 当前选中的代理（select 类型）
    group.url        // 测试 URL（url-test 类型）
    group.interval   // 测试间隔（url-test 类型）
});
```

### 9.3 沙箱安全机制

Zephyr 使用 **5 层纵深防御**：

| 层级 | 机制 | 说明 |
|------|------|------|
| 第 1 层 | 词法验证 | 编译前拒绝 `eval`/`Function`/`require` 等危险标识符 |
| 第 2 层 | 危险属性删除 | 运行时删除 `globalThis.eval`/`Function`/`require` 等全局属性 |
| 第 3 层 | Per-property 锁定 | `Object.defineProperty` 将危险属性设为不可配置 accessor（getter/setter 均抛异常） |
| 第 4 层 | 原型链阻断 | 内置构造器的 `prototype.constructor` 设为不可配置 getter，阻止 `constructor.constructor` 逃逸 |
| 第 5 层 | Strict mode + JSON 冻结 | `'use strict'` 执行，`JSON` 对象冻结，config 为深拷贝 |

### 9.4 资源限制

| 限制项 | 默认值 | 说明 |
|--------|--------|------|
| `maxExecutionTimeMs` | 5000 ms | 单个脚本最大执行时间 |
| `maxMemoryBytes` | 50 MB | 单个脚本最大内存占用 |
| `maxOutputSizeBytes` | 1 MB | 脚本输出最大大小 |
| `maxLogEntries` | 500 条 | 最大日志条数 |
| `maxScriptSizeBytes` | 10 MB | 脚本源码最大大小 |
| `maxConfigBytes` | 10 MB | 配置最大大小 |
| `maxStringLength` | 1 MB | 单个字符串最大长度 |
| `maxLoopIterations` | 100,000 次 | 循环最大迭代次数 |
| `maxRecursionDepth` | 32 层 | 最大递归深度 |

超出限制将终止脚本执行并记录错误。

### 9.5 禁止操作

以下操作在沙箱中被严格禁止：

```javascript
eval("code");                    // ❌ 禁止动态代码执行
new Function("return 1");        // ❌ 禁止 Function 构造器
require('fs');                   // ❌ 禁止模块加载
import('fs');                    // ❌ 禁止动态导入
fetch('http://...');             // ❌ 禁止网络请求（默认）
XMLHttpRequest;                  // ❌ 禁止网络请求
process.exit();                  // ❌ 禁止进程操作
Deno;                            // ❌ 禁止 Deno API
```

> **注意**：`var` 和 `let`/`const` 均可使用。由于 QuickJS 对 ES6+ 支持良好，推荐使用 `var` 以获得最大兼容性。

---

## 10. 规则库与 `{{proxy}}` 变量

### 规则提取

从订阅 Profile 提取规则到规则库时，Prism 引擎自动处理代理组名替换：

- **标准规则** `DOMAIN-SUFFIX,google.com,Proxy` → `DOMAIN-SUFFIX,google.com,{{proxy}}`
- **MATCH 规则** `MATCH,Proxy` → `MATCH,{{proxy}}`
- **内置策略** 保持不变：`DIRECT`、`REJECT`、`PASS`

### 为什么需要 `{{proxy}}`？

不同订阅有不同的代理组名：

| 订阅 | 主代理组名 |
|------|-----------|
| SubA | `SubA` |
| SubB | `Proxy` |
| SubC | `Select` |

如果规则硬编码了 `MATCH,Proxy`，切换到 SubA 时会报 `proxy [Proxy] not found`。使用 `MATCH,{{proxy}}` 后，引擎会自动替换为当前订阅的第一个代理组名。

### 手动编写规则时的建议

```yaml
rules:
  $append:
    # ✅ 正确：使用 {{proxy}} 跨订阅兼容
    - "DOMAIN-SUFFIX,google.com,{{proxy}}"
    - "MATCH,{{proxy}}"

    # ❌ 错误：硬编码组名，切换订阅会 400
    # - "DOMAIN-SUFFIX,google.com,SomeGroup"
    # - "MATCH,SomeGroup"

    # ✅ 内置策略不需要模板
    - "GEOIP,CN,DIRECT"
    - "DOMAIN-KEYWORD,adservice,REJECT"
```

---

## 11. 示例脚本集合

### 示例 1：广告拦截规则注入（Prism DSL）

```yaml
# 广告拦截规则
# 作用范围：全局

rules:
  $prepend:
    - "DOMAIN-SUFFIX,ads.google.com,REJECT"
    - "DOMAIN-SUFFIX,adservice.google.com,REJECT"
    - "DOMAIN-KEYWORD,adservice,REJECT"
    - "DOMAIN-SUFFIX,ad.doubleclick.net,REJECT"
    - "DOMAIN-SUFFIX,pagead2.googlesyndication.com,REJECT"
    - "DOMAIN,ad.doubanio.com,REJECT"
```

### 示例 2：DNS 配置注入（Prism DSL）

```yaml
# 统一 DNS 配置
# 仅在配置中不存在 dns 字段时注入

dns:
  $default:
    enable: true
    enhanced-mode: fake-ip
    fake-ip-range: 198.18.0.1/16
    fake-ip-filter:
      - "*.lan"
      - "localhost.ptlogin2.qq.com"
    nameserver:
      - https://doh.pub/dns-query
      - https://dns.alidns.com/dns-query
    fallback:
      - https://dns.google/dns-query
      - https://cloudflare-dns.com/dns-query
    fallback-filter:
      geoip: true
      geoip-code: CN
```

### 示例 3：仅特定订阅生效（Prism DSL）

```yaml
# 流媒体规则 — 仅 SubA 和 SubB 使用

__when__:
  profile: [SubA, SubB]

rules:
  $prepend:
    - "DOMAIN-SUFFIX,netflix.com,{{proxy}}"
    - "DOMAIN-SUFFIX,netflix.net,{{proxy}}"
    - "DOMAIN-SUFFIX,nflximg.com,{{proxy}}"
    - "DOMAIN-SUFFIX,nflxvideo.net,{{proxy}}"
    - "DOMAIN-SUFFIX,disneyplus.com,{{proxy}}"
    - "DOMAIN-SUFFIX,disney-plus.net,{{proxy}}"
```

### 示例 4：按地区动态分组（JavaScript）

```javascript
// ══════════════════════════════════════════════════════════
//  按地区动态分组
//  作用范围：全局
// ══════════════════════════════════════════════════════════

function main(config) {
    var proxies = config.proxies || [];
    var groups = config['proxy-groups'] || [];

    if (proxies.length === 0) {
        log.info('没有代理节点，跳过分组');
        return config;
    }

    // 地区关键字映射（按优先级排列，先匹配先生效）
    var regionMap = [
        { key: '香港',   flag: '🇭🇰', type: 'url-test', keywords: ['香港', '港', 'HK', 'Hong Kong'] },
        { key: '日本',   flag: '🇯🇵', type: 'url-test', keywords: ['日本', '东京', '大阪', 'JP', 'Japan'] },
        { key: '韩国',   flag: '🇰🇷', type: 'url-test', keywords: ['韩国', '首尔', 'KR', 'Korea'] },
        { key: '美国',   flag: '🇺🇸', type: 'url-test', keywords: ['美国', '洛杉矶', '硅谷', 'US', 'United States'] },
        { key: '新加坡', flag: '🇸🇬', type: 'url-test', keywords: ['新加坡', '狮城', 'SG', 'Singapore'] },
        { key: '欧洲',   flag: '🇪🇺', type: 'url-test', keywords: ['欧洲', '伦敦', '法兰克福', '德国', '法国', 'UK', 'DE', 'EU'] },
        { key: '澳洲',   flag: '🇦🇺', type: 'url-test', keywords: ['澳洲', '澳大利亚', '悉尼', 'AU', 'Australia'] },
    ];

    // 按关键字将节点分配到地区组
    var regionProxies = {};
    var unclassified = [];

    for (var i = 0; i < proxies.length; i++) {
        var name = proxies[i].name || '';
        var matched = false;
        for (var r = 0; r < regionMap.length; r++) {
            var region = regionMap[r];
            for (var k = 0; k < region.keywords.length; k++) {
                if (name.indexOf(region.keywords[k]) !== -1) {
                    if (!regionProxies[region.key]) regionProxies[region.key] = [];
                    regionProxies[region.key].push(name);
                    matched = true;
                    break;
                }
            }
            if (matched) break;
        }
        if (!matched) unclassified.push(name);
    }

    // 创建地区策略组
    var newGroups = [];
    var regionGroupNames = [];

    for (var r = 0; r < regionMap.length; r++) {
        var region = regionMap[r];
        var nodes = regionProxies[region.key];
        if (!nodes || nodes.length === 0) continue;
        var groupName = region.flag + ' ' + region.key;
        regionGroupNames.push(groupName);
        newGroups.push({
            name: groupName,
            type: region.type,
            url: 'http://www.gstatic.com/generate_204',
            interval: 300,
            tolerance: 50,
            proxies: nodes,
        });
    }

    // 未匹配节点归入"其他"
    if (unclassified.length > 0) {
        var otherName = '🌍 其他';
        regionGroupNames.push(otherName);
        newGroups.push({
            name: otherName,
            type: 'select',
            proxies: unclassified,
        });
    }

    // 创建总选择组
    if (newGroups.length > 0) {
        var selectProxies = ['DIRECT'];
        for (var i = 0; i < regionGroupNames.length; i++) {
            selectProxies.push(regionGroupNames[i]);
        }
        newGroups.unshift({
            name: '🚀 Proxy',
            type: 'select',
            proxies: selectProxies,
        });
    }

    // ⚠️ 注意：创建组前检查是否已存在同名组，避免 duplicate group name 错误
    var existingNames = {};
    for (var i = 0; i < groups.length; i++) {
        existingNames[groups[i].name] = true;
    }
    var filtered = [];
    for (var i = 0; i < newGroups.length; i++) {
        if (!existingNames[newGroups[i].name]) {
            filtered.push(newGroups[i]);
        }
    }

    // 合并：新组在前，原始组在后
    for (var i = 0; i < groups.length; i++) {
        filtered.push(groups[i]);
    }
    config['proxy-groups'] = filtered;

    var stats = [];
    for (var r = 0; r < regionMap.length; r++) {
        var n = regionProxies[regionMap[r].key] ? regionProxies[regionMap[r].key].length : 0;
        if (n > 0) stats.push(regionMap[r].key + ':' + n);
    }
    log.info('地区分组完成: ' + filtered.length + ' 个组 | ' + stats.join(' '));

    return config;
}
```

### 示例 5：统一链式代理注入（JavaScript）

```javascript
// 为所有订阅注入链式代理入口

function main(config) {
    var groups = config['proxy-groups'] || [];

    // 定义链式代理节点（按需修改）
    var chainNodes = ['WARP', '前置代理A', '前置代理B'];

    // 为所有 select/url-test/fallback 组注入链式入口
    for (var i = 0; i < groups.length; i++) {
        var group = groups[i];
        if (group.type === 'select' || group.type === 'url-test' || group.type === 'fallback') {
            var existing = {};
            for (var j = 0; j < (group.proxies || []).length; j++) {
                existing[group.proxies[j]] = true;
            }
            for (var j = 0; j < chainNodes.length; j++) {
                if (!existing[chainNodes[j]]) {
                    group.proxies.unshift(chainNodes[j]);
                }
            }
        }
    }

    // 确保链式代理组存在
    var chainGroupName = '🔗 链式代理';
    var exists = false;
    for (var i = 0; i < groups.length; i++) {
        if (groups[i].name === chainGroupName) { exists = true; break; }
    }
    if (!exists) {
        groups.unshift({
            name: chainGroupName,
            type: 'select',
            proxies: ['DIRECT'].concat(chainNodes),
        });
    }

    config['proxy-groups'] = groups;
    log.info('链式代理已注入: ' + chainNodes.join(', '));
    return config;
}
```

### 示例 6：过滤无效节点（Prism DSL）

```yaml
# 过滤掉名称包含"过期"、"官网"、"剩余"的无效节点

proxies:
  $remove: "p.name.includes('过期') || p.name.includes('官网') || p.name.includes('剩余')"
```

### 示例 7：节点名称规范化（Prism DSL）

```yaml
# 去掉节点名称中的括号备注，如 "香港 01 (IPLC)" → "香港 01"

proxies:
  $transform: "p.name = p.name.replace(/\\s*\\(.*\\)/, '')"
```

### 示例 8：修改端口和基础配置（JavaScript）

```javascript
// 修改基础网络配置

function main(config) {
    config['mixed-port'] = 7890;
    config['allow-lan'] = true;
    config['bind-address'] = '*';
    config.mode = 'rule';
    config['log-level'] = 'info';
    config['ipv6'] = false;

    log.info('基础配置已修改: mixed-port=7890, allow-lan=true');
    return config;
}
```

### 示例 9：远程覆写（从 URL 加载）

远程覆写支持从 URL 自动下载脚本内容并执行。创建时选择"远程"类型并填入 URL，Zephyr 会通过当前代理下载脚本（解决 GFW 问题），并在每次应用时重新拉取最新版本。

---

## 12. 常见问题与注意事项

### Q: Prism DSL 和 JS 覆写可以同时使用吗？

**可以**。两者在管道中按顺序执行：Prism patches 先应用，JS 覆写后应用。JS 脚本可以读取和修改 Prism 处理后的结果。

### Q: 为什么切换订阅后报 `proxy [xxx] not found`？

规则中硬编码了代理组名（如 `MATCH,SomeGroup`），但当前订阅没有该组。解决方法：
1. 使用 `{{proxy}}` 变量替代硬编码组名
2. 重新从订阅提取规则（提取时会自动替换）

### Q: 为什么报 `duplicate group name`？

JS 覆写脚本创建了与原始配置中同名的代理组。解决方法：
1. 在创建组前检查是否已存在同名组
2. 使用不同的组名避免冲突

### Q: 脚本修改了 config 但没有生效？

检查以下几点：
1. 是否 `return config;` — 不返回或返回 `undefined` 会导致配置丢失
2. 脚本是否启用了（卡片上的开关）
3. 脚本作用域是否包含当前订阅（全局或指定订阅）
4. 查看"输出"面板的日志和错误信息

### Q: Prism DSL 的 `$filter` / `$transform` 表达式支持什么语法？

支持标准 JavaScript 表达式，但有以下限制：
- `p` 代表当前元素
- 不能使用 `eval`、`Function` 等动态代码
- 表达式必须是单个表达式，不能是语句块
- 可以使用逻辑运算符（`&&`、`||`、`!`）、比较运算符、字符串方法（`includes`、`startsWith`、`indexOf`、`replace`）

### Q: 远程覆写的 URL 无法访问怎么办？

Zephyr 会通过当前 Mihomo 代理下载远程脚本，因此只要代理可用就能下载。如果代理本身不可用，则下载会失败。

### Q: 如何调试覆写脚本？

1. 使用 `log.info()` / `log.warn()` / `log.error()` 输出调试信息
2. 查看覆写卡片的"输出"面板
3. 点击"保存并执行"按钮测试单条覆写
4. 使用 `script_validate` 命令检查脚本安全性

### Q: 覆写的执行顺序如何调整？

- **Prism YAML**：通过 `__after__` 声明依赖关系，引擎自动拓扑排序
- **JS 覆写**：在 UI 中拖拽卡片调整顺序，`order` 值越小越先执行

### Q: 切换订阅后覆写会自动重新应用吗？

**会**。切换订阅时 `switchToConfig` 会依次执行：
1. `rebuild()` — 重置并重新应用所有 Prism patches
2. `overrideApplyAll()` — 重新应用所有启用的 JS 覆写
3. 清缓存 + 延迟刷新前端代理组数据

### Q: `{{proxy}}` 解析为哪个组？

引擎读取 `run_config.yaml` 中 `proxy-groups` 列表的第一个非特殊组名（跳过 GLOBAL/DIRECT/REJECT/PASS）。通常是订阅的主选择器组。

---

