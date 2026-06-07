<div align="center">

<img src="apps/desktop/src-tauri/icons/icon.png" alt="Zephyr - Modern Mihomo GUI Client Logo" width="128" height="128">

# Zephyr

**Secure by Design · Light by Nature · Beautiful by Choice**

*A Mihomo GUI.*

[![Stars](https://badgen.net/github/stars/Juwan-Hwang/Zephyr?icon=github&color=blue)](https://github.com/Juwan-Hwang/Zephyr/stargazers)
[![Release](https://badgen.net/github/release/Juwan-Hwang/Zephyr?icon=git&color=cyan)](https://github.com/Juwan-Hwang/Zephyr/releases)
[![License](https://badgen.net/badge/license/MIT/blue)](https://github.com/Juwan-Hwang/Zephyr/blob/main/LICENSE)
[![Platform](https://badgen.net/badge/Platform/Windows%20%7C%20macOS%20%7C%20Linux/08C)](https://github.com/Juwan-Hwang/Zephyr/releases)
[![Downloads](https://img.shields.io/github/downloads/Juwan-Hwang/Zephyr/total.svg?style=flat&label=Downloads&color=08C&labelColor=555)](https://github.com/Juwan-Hwang/Zephyr/releases)
[![Security](https://badgen.net/badge/Security/CodeQL%20%7C%20Semgrep%20%7C%20cargo--deny%20%7C%20Clippy/green)](https://github.com/Juwan-Hwang/Zephyr/wiki/Security)
[![Rust Tests](https://img.shields.io/badge/dynamic/json?url=https://gist.githubusercontent.com/Juwan-Hwang/6f7cfd1b6927a9a224ffe8cb21f5e9d4/raw/rust-tests.json&query=$.message&label=Rust%20Tests&color=3C1&style=flat&labelColor=555)](https://github.com/Juwan-Hwang/Zephyr/actions)
[![JS Tests](https://img.shields.io/badge/dynamic/json?url=https://gist.githubusercontent.com/Juwan-Hwang/6f7cfd1b6927a9a224ffe8cb21f5e9d4/raw/js-tests.json&query=$.message&label=JS%20Tests&color=3C1&style=flat&labelColor=555)](https://github.com/Juwan-Hwang/Zephyr/actions)
[![Tauri](https://badgen.net/badge/Tauri/v2/24c8db)](https://tauri.app)
[![Rust](https://badgen.net/badge/Rust/1.92+/dea584)](https://www.rust-lang.org/)

[English](README_en.md) | [简体中文](README.md)

</div>

---

## Quick Start

**5 minutes to get started:**

1. **Download** — Get the latest release from [GitHub Releases](https://github.com/Juwan-Hwang/Zephyr/releases)
2. **Install** — Run the installer (or extract Portable version)
3. **Import** — Add your subscription via URL or file
4. **Select** — Choose a proxy node from the list
5. **Enable** — Toggle System Proxy or TUN Mode

That's it. Your traffic is now routed through the selected proxy.

> **Transparency Notice**: All content in this project is AI-generated (including this text). Security measures are implemented—see [Security Design](#security-design)—but should not be assumed to be fully verified. Please assess risks before use. Security issue reports are welcome.

---

## Screenshots

![Zephyr Home - macOS Light Mode Mihomo Proxy Client Interface](apps/desktop/assets/screenshot-home.png)

<details>
<summary>More Screenshots</summary>

| Dark Mode | Settings |
|:---:|:---:|
| ![Zephyr Dark Mode - Proxy Node Management Interface](apps/desktop/assets/screenshot-dark.png) | ![Zephyr Settings - System Proxy & TUN Configuration](apps/desktop/assets/screenshot-settings.png) |

</details>

---

## Why Zephyr?

Zephyr was born from frustration. Every Mihomo GUI I found looked like a temporary tool. So I vibe coded one.

**Visual Experience.** Frosted glass cards. Gradient icons. Dark mode. Animation details. Typography that breathes. A proxy client that feels designed, not assembled.

**Security Boundaries.** Explicit constraints on subscriptions, configs, scripts, files, updates, and deep links. Defense in depth.

**Rule Capabilities.** Prism Engine brings declarative rule patches, smart node selection, and script sandbox. More power, less complexity.

See [FEATURES.md](FEATURES.md) for the complete feature list.

---

## Growing Community

Zephyr is gaining attention from developers and users.

<a href="https://www.star-history.com/?repos=Juwan-Hwang%2FZephyr&type=timeline&legend=top-left">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=Juwan-Hwang/Zephyr&type=timeline&theme=dark&legend=top-left" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=Juwan-Hwang/Zephyr&type=timeline&legend=top-left" />
    <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=Juwan-Hwang/Zephyr&type=timeline&legend=top-left" width="450" />
  </picture>
</a>

---

## Features

### Core Capabilities

- **Mihomo Core Management** — Start, stop, restart the proxy core
- **Multi-Config Management** — Create, edit, switch YAML configurations
- **Subscription Management** — URL, file, drag-and-drop import, Base64 auto-decoding
- **Proxy Mode Switching** — Rule, Global, Direct modes
- **System Proxy** — Native system proxy management for Windows / macOS / Linux
- **TUN Mode** — System-level proxy
- **Connections & Traffic** — Real-time connection list, connection termination, up/down speeds, historical trends

### Prism Engine

Zephyr includes a rule engine based on `clash-prism-*` crates to enhance Mihomo configuration:

| Feature | Description |
|---------|-------------|
| **Declarative Rule Patches** | `.prism.yaml` supports `$prepend`, `$append`, `$filter`, `$override`, and `__when__` conditions |
| **Rule Library Management** | CRUD operations, grouping, import, auto-apply, file watching |
| **Smart Node Selection** | EMA scoring and adaptive scheduling based on latency, success rate, stability |
| **Failover** | Automatic node switching on failure, with thresholds, cooldown, and rollback strategies |
| **Script Sandbox** | QuickJS execution environment with time, memory, string length, loop, and recursion limits |
| **Plugin System** | Plugin discovery, loading, lifecycle hooks, and fine-grained permission control |
| **KV Storage** | Persistent key-value storage capabilities |

### Security Design

Zephyr implements defense-in-depth security measures:

| Layer | Protection | Implementation |
|-------|------------|----------------|
| **Encryption** | Machine-bound encryption | Hardware fingerprint-derived keys for subscription metadata; proxy configs (YAML) stored in plaintext |
| **Network** | SSRF Protection | DNS validation before subscription/rule URL downloads; redirects to private addresses blocked |
| **Network** | DNS Leak Prevention | TUN mode auto-injects `dns-hijack`, capturing all DNS traffic to Mihomo |
| **Config** | Config Sanitization | Recursive removal of dangerous YAML fields, provider path traversal limits |
| **Script** | Permission Control | Script execution constrained by resource limits and permission restrictions |
| **Input** | Input Validation | IPC command entry points with length, format, and UTF-8 safety checks |
| **Rate Limit** | Dual Rate Limiting | Fixed cooldown for standard commands + sliding window for Prism commands |
| **File** | File Security | Secure permissions, UUID temp files, archive path traversal protection, symlink rejection, zip bomb detection |
| **Update** | Update Integrity | SHA256 verification, trusted host restrictions, atomic updates with auto-rollback |
| **Deep Link** | Deep Link Security | Restricted `clash://` protocol entry points and URL schemes |
| **Build** | CSP & Hardening | Limited script and connection sources; release builds with LTO, strip, `panic=abort` |

### System Integration

- System tray status icon and quick menu
- Global hotkeys: Window show, system proxy, TUN, proxy mode switching
- `clash://` deep link subscription import
- Windows UWP loopback exemption
- Mihomo core, GeoIP/GeoSite data, and Zephyr client updates
- Auto-start on boot, system notifications, config directory access

### UI / UX

- Transparent frameless window with custom title bar
- **UI Scaling**: 1x - 1.5x interface scaling for different resolutions
- Virtual scrolling logs with level filtering and regex search
- CodeMirror 6 editor with Prism DSL highlighting and completion
- Proxy node card 3D interaction effects
- Theme system: preset themes and custom colors
- i18n: English baseline, complete Chinese translation, Japanese/Korean partial (fallback to English)
- Frontend event bus, centralized state, and caching layer

---

## Tech Stack

| Layer | Technology | Description |
|:---:|:---:|:---|
| Desktop Framework | Tauri v2 | Lightweight desktop application framework |
| Backend | Rust 1.92+ | IPC, system integration, core management, security boundaries |
| Frontend | Native JavaScript | No frontend framework dependencies |
| Styling | Tailwind CSS v4 | Modern atomic CSS system |
| Editor | CodeMirror 6 | Prism DSL editing experience |
| Rule Engine | clash-prism-* | Rule patches, plugins, script sandbox, smart selection |
| Package Manager | pnpm workspace | `apps/*` + `packages/*` monorepo |
| Proxy Core | Mihomo | Clash Meta core |

---

## Installation

### System Requirements

| Platform | Minimum Version |
|:--------:|----------------|
| Windows | Windows 10 1809+ |
| macOS | macOS 10.15 (Catalina)+ |
| Linux | glibc 2.31+ (Ubuntu 20.04+, Debian 11+, Fedora 34+) |

**Hardware**: ~300MB RAM, ~50MB disk space (Full version)

### Download

Get the appropriate package from [GitHub Releases](https://github.com/Juwan-Hwang/Zephyr/releases).

| Type | Description | Use Case |
|:---:|------|---------|
| **Full** | Includes Mihomo core and GeoIP/GeoSite data | First-time install, offline use |
| **Lite** | Smaller size, no core resources | Already have local core resources |
| **Portable** | Unzip and run, data stored in program directory | USB drive use, multi-device use |

### Portable Version Usage

1. Download `Zephyr-windows-portable.zip` or `Zephyr-linux-portable.tar.gz`
2. Extract to any directory
3. Create an empty file named `.portable` in the directory (or it will be auto-created on first run)
4. Run the executable

> **Portable Limitations**: No auto-start on boot or in-client updates. See [PORTABLE.md](PORTABLE.md) for details.

---

## Running from Source

### Prerequisites

- Rust 1.92 or higher
- Node.js 18 or higher
- pnpm 10 or higher
- Platform-specific Tauri system dependencies

### Development Mode

```bash
pnpm install
pnpm run dev
```

### Build

```bash
pnpm run build
```

### Verification Commands

```bash
pnpm run typecheck
pnpm run test
pnpm run lint
pnpm run check:i18n
```

Desktop package commands:

```bash
pnpm --filter @zephyr/desktop typecheck
pnpm --filter @zephyr/desktop test
pnpm --filter @zephyr/desktop lint
pnpm --filter @zephyr/desktop build:css
```

Rust-side verification:

```bash
cd apps/desktop/src-tauri
cargo check
cargo test
cargo clippy --all-targets --all-features
```

---

## Project Structure

```text
.
├── apps/
│   └── desktop/                 # Tauri desktop application
│       ├── src/                 # Native JS frontend, styles, UI modules
│       └── src-tauri/           # Rust backend, IPC, system integration, Prism capabilities
├── packages/
│   ├── shared/                  # Frontend shared code
│   └── scripts/                 # Project scripts, e.g., i18n check
├── FEATURES.md                  # Current feature list
├── package.json                 # Workspace root scripts
└── pnpm-workspace.yaml          # pnpm workspace configuration
```

---

## FAQ

<details>
<summary><strong>Is it safe to use?</strong></summary>

Zephyr implements defense-in-depth security: SSRF protection, script sandboxing, update integrity verification, and more. The codebase is scanned by CodeQL and Semgrep in CI. See [Security Design](#security-design) for details.

However, all content is AI-generated. Security, stability, and performance should not be assumed to be fully verified—please assess risks before use. If you discover security issues, please refer to [SECURITY.md](https://github.com/Juwan-Hwang/Zephyr/blob/main/SECURITY.md).
</details>

<details>
<summary><strong>Will my PR be merged?</strong></summary>

This project serves personal use cases first. PRs are not guaranteed to be merged. If you have different needs, forking and modifying directly is usually faster.
</details>

<details>
<summary><strong>What's the difference between Full and Lite?</strong></summary>

**Full** includes Mihomo core and GeoIP/GeoSite data—ready for first-time install or offline use. **Lite** is smaller but requires existing local core resources.
</details>

---

## Community

- [GitHub Issues](https://github.com/Juwan-Hwang/Zephyr/issues) — Bug reports & feature requests
- [GitHub Releases](https://github.com/Juwan-Hwang/Zephyr/releases) — Changelog & download

> **Note**: This project serves personal use cases first. PRs are not guaranteed to be merged. For specific needs, forking is often faster.

---

## Contributing

Welcome contributions:

- Reproducible bug reports
- Security issue feedback
- Clear, well-scoped small fixes
- Quality improvements that don't change project direction

---

## License

This project uses [MIT License](LICENSE).

---

## Acknowledgments

- [Mihomo](https://github.com/MetaCubeX/mihomo) — the core
- [Tauri](https://tauri.app) — the framework
- [Tailwind CSS](https://tailwindcss.com) — the style
- [CodeMirror](https://codemirror.net) — the editor
- [clash-prism-*](https://github.com/Juwan-Hwang/Clash-Prism-Engine) — the rules

---

**Conjured by Juwan**

[Back to Top](#zephyr)
