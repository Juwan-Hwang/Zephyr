<div align="center">

<img src="apps/desktop/src-tauri/icons/icon.png" alt="Zephyr - Modern Mihomo GUI Client Logo" width="128" height="128">

# Zephyr - Modern Lightweight  Mihomo / Clash Meta GUI Client 

**Security First · Minimalist Aesthetics · Lightweight & Efficient**

> A modern, security-focused Mihomo (Clash Meta) GUI client with built-in Prism Engine rule engine.
>
> Built with Tauri v2, Rust, native JavaScript, Tailwind CSS, and Prism Engine.

[English](README_en.md) | [简体中文](README.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-blue)](#installation)
[![Tauri](https://img.shields.io/badge/Tauri-v2-24c8db)](https://tauri.app)
[![Rust](https://img.shields.io/badge/Rust-1.92+-orange)](https://www.rust-lang.org/)
[![Release](https://img.shields.io/github/v/release/Juwan-Hwang/Zephyr)](https://github.com/Juwan-Hwang/Zephyr/releases)
[![Security](https://img.shields.io/badge/Security-CodeQL%20%7C%20Semgrep%20%7C%20cargo--deny%20%7C%20Clippy-green)](#security-features)
[![Rust Tests](https://img.shields.io/badge/dynamic/json?url=https://gist.githubusercontent.com/Juwan-Hwang/6f7cfd1b6927a9a224ffe8cb21f5e9d4/raw/rust-tests.json&query=$.message&label=Rust%20Tests&color=green)](https://github.com/Juwan-Hwang/Zephyr/actions)
[![JS Tests](https://img.shields.io/badge/dynamic/json?url=https://gist.githubusercontent.com/Juwan-Hwang/6f7cfd1b6927a9a224ffe8cb21f5e9d4/raw/js-tests.json&query=$.message&label=JS%20Tests&color=brightgreen)](https://github.com/Juwan-Hwang/Zephyr/actions)


</div>

---

## Project Status

Zephyr was created for a simple reason: I couldn't find a Mihomo GUI that matched my aesthetic preferences, so I built one.

This project primarily serves my personal use cases. It pursues two things: a more pleasing desktop proxy management interface, and clearer security boundaries—including subscription downloads, configuration handling, file writes, script execution, deep link imports, and update verification.

**All content in this project is AI-generated** (including this text). Security, stability, and performance should not be assumed to be fully verified. Please assess risks before use. If you discover security issues or bugs, feel free to submit an Issue. PRs are not guaranteed to be merged—if you have specific needs, forking and modifying directly is usually faster.

---

## Screenshots

![Zephyr Home - macOS Light Mode Mihomo Proxy Client Interface](apps/desktop/assets/screenshot-home.png)

<details>
<summary>More Screenshots</summary>

| Settings Page | Dark Mode |
|:---:|:---:|
| ![Zephyr Settings - System Proxy and TUN Configuration](apps/desktop/assets/screenshot-settings.png) | ![Zephyr Dark Mode - Proxy Node Management Interface](apps/desktop/assets/screenshot-dark.png) |

</details>

---

## Why Zephyr?

Zephyr is not a "more features is better" client. It focuses on three directions:

- **Visual Experience**: Glassmorphism cards, gradient icons, dark mode, animation details, and restrained typography—making proxy clients feel less like temporary tools.
- **Security Boundaries**: Clear restrictions on subscriptions, configurations, scripts, files, updates, and deep link entry points—reducing common attack surfaces in proxy clients.
- **Rule Capabilities**: Built-in Prism Engine extends Mihomo configuration capabilities with declarative rule patches, rule libraries, smart node selection, and script sandboxing.

See [FEATURES.md](FEATURES.md) for the complete feature list.

## Community Growth

Zephyr is gaining traction among developers and users.

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

- **Mihomo Core Management**: Start, stop, restart proxy core
- **Multi-Configuration Management**: Create, edit, switch YAML configurations
- **Subscription Management**: URL, file, QR code, drag-and-drop import, and Base64 auto-decoding
- **Proxy Mode Switching**: Rule, Global, Direct modes
- **System Proxy**: Native system proxy management for Windows / macOS / Linux
- **TUN Mode**: System-wide transparent proxy
- **Connections & Traffic**: Real-time connection list, connection closing, up/down speeds, and historical trends

### Prism Engine

Zephyr includes a rule engine based on `clash-prism-*` crates to enhance Mihomo configuration management:

- **Declarative Rule Patches**: `.prism.yaml` supports `$prepend`, `$append`, `$filter`, `$override`, and `__when__` conditions
- **Rule Library Management**: Rule file CRUD, grouping, import, auto-apply, and file watching
- **Smart Node Selection**: EMA scoring and adaptive scheduling based on latency, success rate, and stability
- **Failover**: Automatic node switching on failure, with threshold, cooldown, and fallback strategies
- **Script Sandbox**: QuickJS execution environment with time, memory, string length, loop, and recursion resource limits
- **Plugin System**: Plugin discovery, loading, lifecycle hooks, and fine-grained permission control
- **KV Storage**: Persistent key-value storage capability

### Security Features

- **Machine-Bound Encryption**: Configuration encryption uses hardware fingerprint-derived keys
- **SSRF Protection**: DNS verification before subscription/rule URL downloads; redirects to private IPs are blocked (user-initiated private address input is allowed)
- **DNS Leak Prevention**: TUN mode auto-injects `dns-hijack` to hijack all DNS traffic to Mihomo
- **Configuration Sanitization**: Recursively removes dangerous YAML fields, limits provider path traversal
- **Script Permission Control**: Script execution constrained by resource limits and permission restrictions
- **Input Validation**: Length, format, and UTF-8 safety checks at IPC command entry points
- **Rate Limiting**: Dual throttling—fixed cooldown for original commands + sliding window for Prism commands
- **File Security**: Secure permissions, UUID temp files, archive path traversal protection, symlink rejection, compression bomb detection
- **Update Integrity**: SHA256 verification, trusted host restrictions, resource name validation, atomic updates with automatic rollback
- **Deep Link Security**: Restricted `clash://` protocol entry and URL scheme handling
- **CSP & Build Hardening**: Restricted script and connection sources, release builds with LTO, strip, `panic=abort`

### System Integration

- System tray status icon and quick menu
- Global hotkeys: Window show, system proxy, TUN, proxy mode switching
- `clash://` deep link subscription import
- Windows UWP loopback exemption
- Mihomo core, GeoIP/GeoSite data, and Zephyr client updates
- Auto-start on boot, system notifications, config directory opening

### UI / UX

- Transparent frameless window with custom title bar
- **UI Scaling**: 0.5x - 2.0x interface scaling for different resolutions
- Virtual scroll logs with level filtering and regex search
- CodeMirror 6 editor with Prism DSL highlighting and completion
- Proxy node card 3D interaction effects
- Theme system: Preset themes and custom colors
- i18n: English base, complete Chinese translation, Japanese/Korean are skeleton translations that fall back to English
- Frontend event bus, centralized state, and cache layer

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

Download the appropriate package for your platform from [GitHub Releases](https://github.com/Juwan-Hwang/Zephyr/releases).

Zephyr releases come in three types:

| Type | Description | Use Case |
|:---:|------|---------|
| **Full** | Includes Mihomo core and GeoIP/GeoSite data | First-time install, offline use |
| **Lite** | Smaller size, no core resources included | Users with existing local core resources |
| **Portable** | Extract and run, data stored in program directory | USB drive, multi-device use |

### Portable Version Usage

1. Download `Zephyr-windows-portable.zip` or `Zephyr-linux-portable.tar.gz`
2. Extract to any directory
3. Ensure `.portable` marker file exists in the directory
4. Run the executable

> **Portable Limitations**: No auto-start on boot, no in-client updates. See [PORTABLE.md](PORTABLE.md) for details.

Platform support is subject to actual Release artifacts.

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

### Common Verification Commands

```bash
pnpm run typecheck
pnpm run test
pnpm run lint
pnpm run check:i18n
```

Desktop package can also be run separately:

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

## Contributing

This project primarily serves personal use cases, so not all PRs are guaranteed to be merged. If you have different needs, the most direct approach is usually to fork and modify according to your usage.

Welcome submissions:

- Reproducible bug reports
- Security issue feedback
- Clear, well-scoped small fixes
- Quality improvements that don't change project direction

---

## License

This project uses the [MIT License](LICENSE).

---

## Acknowledgments

- [Mihomo](https://github.com/MetaCubeX/mihomo)
- [Tauri](https://tauri.app)
- [Tailwind CSS](https://tailwindcss.com)
- [CodeMirror](https://codemirror.net)
- [clash-prism-*](https://github.com/Juwan-Hwang/Clash-Prism-Engine) — Declarative rule engine for Clash

---

<div align="center">

**Conjured by Juwan**

[Back to Top](#zephyr---modern-lightweight-mihomo-gui-client)

</div>
