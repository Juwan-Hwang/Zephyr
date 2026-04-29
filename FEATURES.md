# Features

## Core

- **Mihomo Proxy Engine** — Start/stop/restart the Mihomo core process
- **Multi-profile Management** — Create, read, edit, delete, and switch between YAML configurations
- **Subscription Management** — Download and update subscriptions (URL/file/QR/drag-and-drop), base64 auto-decode
- **Proxy Modes** — Rule-based routing, Global proxy, Direct connection
- **System Proxy** — Cross-platform (Windows/macOS/Linux with GNOME/KDE/XFCE support), automatic bypass for private networks
- **TUN Mode** — Virtual network interface (Windows/macOS/Linux), atomic lock, auto-recovery on failure
- **Connection Management** — Real-time connection list with details and close capability
- **Traffic Statistics** — Real-time upload/download speed and historical trends

## Prism Engine (`clash-prism-*`)

- **Rule Engine** — Compile and apply rule patches via Prism DSL (`$prepend`/`$append`/`$filter`/`$override` + `__when__` conditions)
- **Rule Library** — CRUD for `.prism.yaml` rule files, groups, import (text/file/URL), auto-apply, file watching
- **Smart Proxy Selector** — EMA scoring (latency/success rate/stability), adaptive scheduler, auto-select best node
- **Failover** — Automatic node switching on failure, configurable thresholds, cooldown, and fallback groups
- **Script Engine** — JavaScript sandbox with 9 resource limits (time, memory, string length, loop iterations, recursion depth, etc.) and 4 permission controls (network, filesystem, child process, workers)
- **Plugin System** — Discovery, loading, lifecycle hooks, fine-grained permission checks
- **KV Store** — Persistent key-value storage (`kv_store.db`)

## Security

- **AES-GCM + PBKDF2** — Configuration encryption with hardware-fingerprint-derived machine key
- **SSRF Protection** — DNS validation + private IP interception for subscription/rule URLs
- **Script Sandbox** — 9 resource limits + 4 permission controls + per-plugin grant/revoke
- **Config Sanitizer** — Recursive removal of dangerous YAML keys (`script`, `script-path`), provider path traversal prevention
- **Input Validation** — Length limits, format checks, UTF-8 safe truncation across all IPC commands
- **Rate Limiting** — Sliding-window rate limiter for sensitive commands (`script_execute`, `rule_import_url`, notifications, shortcuts)
- **File Security** — Unix 0600 permissions / Windows ACL, UUID temp files, ZIP/TAR path traversal protection
- **Update Integrity** — SHA256 verification, trusted host allowlist (github.com only), asset name validation
- **Deep Link Safety** — Protocol restriction (`clash://`), URL scheme allowlist, path traversal prevention
- **CSP** — Strict Content Security Policy with `frame-ancestors 'none'` (clickjacking prevention)
- **Clippy** — 165+ deny rules including `unwrap_used`, `expect_used`, `indexing_slicing`, `undocumented_unsafe_blocks`
- **Release Hardening** — LTO, single codegen unit, strip symbols, panic=abort

## System Integration

- **System Tray** — Status-aware icon (default/sysproxy/tun), full context menu with proxy/config/mode controls
- **Global Shortcuts** — 6 configurable actions (toggle-window, toggle-proxy, toggle-tun, mode-rule, mode-global, mode-direct), platform-aware display (⌘ vs Ctrl)
- **Deep Link** — `clash://` protocol association for subscription import
- **UWP Loopback Exemption** — Allow Windows Store apps to access local proxy (with user confirmation + cooldown)
- **Auto-update** — Mihomo core, GeoIP/GeoSite databases, Zephyr client; download progress reporting
- **Auto-start** — Launch on system startup via `tauri-plugin-autostart`
- **OS Notifications** — System-level notifications with correct app identity (AUMID)
- **File Manager Integration** — Open config/Prism folders in system file manager

## UI/UX

- **Custom Window** — Frameless transparent window with custom title bar
- **Virtual Scroll Log Viewer** — O(log n) binary search, incremental polling, 5-level filtering, regex search
- **CodeMirror 6 Editor** — Prism DSL syntax highlighting and auto-completion
- **3D Card Effect** — Perspective transform on proxy node cards
- **Theme System** — 5 presets (purple, blue, green, orange, pink) + custom hex color
- **i18n** — 4 languages (en, zh, ja, ko)
- **Event Bus** — Inter-module communication (`Bus`/`Events`)
- **Centralized State** — `appStore` for reactive state management
- **Cache Layer** — Config and proxy data caching with invalidation

## Architecture

```
apps/desktop/src-tauri/src/
  lib.rs                    — App entry, command registration, state management, rate limiting
  config_manager.rs         — Settings read/write
  os_notification.rs        — OS-level notification dispatch
  core/                     — Mihomo process, TUN, config, crypto, subscription
  prism/                    — Prism engine (81 IPC commands)
    commands_core.rs        — Core Prism commands (apply, validate, watch, trace, rebuild, preview, insert, toggle, stats)
    rule_library.rs         — Rule CRUD, import, extract, groups
    smart_commands.rs       — Smart proxy selector (EMA scoring, scheduler)
    failover_commands.rs    — Failover detection and policy
    script_commands.rs      — JS sandbox execution and limits
    plugin_commands.rs      — Plugin lifecycle and permissions
    kv_commands.rs          — Persistent key-value store
    rate_limiter.rs         — Sliding-window rate limiter
  sys_proxy.rs              — System proxy (Windows/macOS/Linux)
  tray.rs                   — System tray management
  updater.rs                — Core/client/geo update system
  global_shortcut.rs        — Global keyboard shortcuts
  deep_link.rs              — Protocol URL handling
  uwp_loopback.rs           — Windows UWP loopback exemption
```

127 IPC commands · 300 Rust tests · Tauri 2 · Rust 1.92
