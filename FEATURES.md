# Features

## Core

- **Mihomo Proxy Engine** — Start/stop/restart the Mihomo core process
- **Multi-profile Management** — Create, read, edit, delete, and switch between YAML configurations
- **Subscription Management** — Download and update subscriptions (URL/file/QR/drag-and-drop), base64 auto-decode
- **Subscription Auto-Update** — Per-subscription configurable interval (30 min – 24 h), background tokio scheduler, manual trigger-all
- **Subscription Edit** — Inline edit subscription URL and update interval, URL validation (http/https only), preserve user-defined names
- **Subscription Drag-and-Drop Sort** — Reorder subscription list via drag-and-drop, auto-persist
- **Batch Subscription Update** — One-click update all subscriptions (bypasses per-command rate limit)
- **Proxy Node Memory (v2)** — Remember group + node selection per profile, auto-restore on switch, v1→v2 migration
- **Primary Group Resolver** — Deterministic 7-level priority chain (UI selection → saved preference → FINAL/MATCH rule → YAML order → GLOBAL.all → keyword scoring → fallback)
- **observedGroup Watcher** — Background polling (5 s interval) to detect actual proxy group usage from connections (30-sample, K=3 consecutive confirmation)
- **Hide Timeout Nodes** — Toggle to hide unavailable proxy nodes (delay ≤ 0 or ≥ 999999), always keep active node
- **Port Configuration Modal** — Visual editor for mixed-port, socks-port, redir-port, tproxy-port (range 0–65535, duplicate check, all-disabled prevention)
- **Proxy Modes** — Rule-based routing, Global proxy, Direct connection
- **System Proxy** — Cross-platform (Windows/macOS/Linux with GNOME/KDE/XFCE support), automatic bypass for private networks
- **TUN Mode** — Virtual network interface (Windows/macOS/Linux), atomic lock, auto-recovery on failure, auto-inject dns-hijack
- **Linux GPU Acceleration** — WebKitGTK GPU compositing with Wayland support, hardware-accelerated rendering
- **Linux AppImage** — linuxdeploy-plugin-gtk packaging for improved GTK/WebKitGTK compatibility
- **Linux Custom Titlebar** — Borderless window with custom traffic light buttons (close/minimize/maximize), consistent with Windows/macOS
- **AUR Auto-Update** — Automatic Arch User Repository package update on release publish
- **Connection Management** — Real-time connection list with details and close capability
- **Traffic Statistics** — Real-time upload/download speed and historical trends
- **Portable Mode** — Extract-and-run, data stored in program directory, `.portable` marker file
- **Lightweight Mode** — Destroy WebView on window close to free memory, keep only system tray; auto-disable when "minimize to tray" is off
- **mihomo -t Config Pre-check** — Validate configuration with `mihomo -t -f` before core start, preventing crash-restart loops
- **Log Persistence** — Backend log persistence with daily rotation, severity-level filtering, and one-click export; 6 log management IPC commands
- **Network Optimization** — Three-layer system: Mihomo config defaults (tcp-concurrent, keep-alive, fake-ip persistence) + OS TCP tuning (Fast Open, ECN, buffer) + DNS optimization; standalone Apply/Revert/Status UI

## Prism Engine (`clash-prism-*`)

- **Rule Engine** — Compile and apply rule patches via Prism DSL (`$prepend`/`$append`/`$filter`/`$override` + `__when__` conditions)
- **Rule Library** — CRUD for `.prism.yaml` rule files, groups, import (text/file/URL), auto-apply, file watching
- **Smart Proxy Selector** — EMA scoring (latency/success rate/stability), adaptive scheduler, auto-select best node, observed group/node tracking with special group exclusion
- **Failover** — Automatic node switching on failure, configurable thresholds, cooldown, and fallback groups
- **Script Engine** — JavaScript sandbox with 9 resource limits (time, memory, string length, loop iterations, recursion depth, etc.) and 4 permission controls (network, filesystem, child process, workers)
- **Plugin System** — Discovery, loading, lifecycle hooks, fine-grained permission checks
- **KV Store** — Persistent key-value storage (`kv_store.db`)
- **Override System** — Prism DSL + JavaScript dual-engine config overrides, scope management (global/per-profile), drag-reorder, import/export, remote override support

## Security

- **AES-GCM + PBKDF2** — Configuration encryption with hardware-fingerprint-derived machine key (hex-encoded, strict UTF-8 on decrypt); optional config file encryption (v2: `djI6` base64 prefix)
- **SSRF Protection** — DNS validation for subscription/rule URLs; user-initiated private address input allowed, but redirects to private IPs are blocked
- **DNS Leak Prevention** — TUN mode auto-injects `dns-hijack` to route all DNS traffic through Mihomo
- **Config Sanitizer** — Recursive removal of dangerous YAML keys (`script`, `script-path`, 6 CFW legacy keys), provider path traversal prevention, Billion Laughs attack defense (MAX_YAML_DEPTH = 100)
- **REALITY short-id Protection** — Quote hex values before YAML parsing to prevent scientific notation misinterpretation
- **Input Validation** — Length limits, format checks, UTF-8 safe truncation across all IPC commands
- **XSS Prevention** — `escapeHtml` (NFKC + browser round-trip), `escapeAttr`, `sanitizeHtml` (whitelist + `<template>` parsing + `STRIP_CONTENT_TAGS`), `html`/`safeHtml` tagged template literals, `eslint-plugin-no-unsanitized` enforcement
- **Rate Limiting** — Sliding-window rate limiter for sensitive commands (`script_execute`, `rule_import_url`, notifications, shortcuts)
- **File Security** — Unix 0600 permissions / Windows ACL, UUID temp files, ZIP/TAR path traversal protection, symlink rejection, compression bomb detection
- **Update Integrity** — SHA256 verification + Minisign Ed25519 signature verification, trusted host allowlist (github.com only), asset name validation, atomic update with auto-rollback
- **Deep Link Safety** — Protocol restriction (`clash://`), URL scheme allowlist, path traversal prevention
- **CSP** — Strict Content Security Policy with `frame-ancestors 'none'` (clickjacking prevention)
- **Clippy** — 165+ deny rules including `unwrap_used`, `expect_used`, `indexing_slicing`, `undocumented_unsafe_blocks`
- **Release Hardening** — LTO, single codegen unit, strip symbols, panic=abort
- **URL Leakage Prevention** — `get_config_url` demoted to internal function (not exposed to frontend)
- **Backend Event System** — Structured logging with 4 levels (Fatal/Error/Warn/Info), 10 modules, 48 error codes; automatic path redaction; frontend event bus with Toast notifications for Fatal/Error

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
- **UI Scaling** — 1x – 1.5x interface scaling with CSS `transform: scale()`, dropdown/context-menu position correction under transform
- **Virtual Scroll Log Viewer** — O(log n) binary search, incremental polling, 5-level filtering, regex search
- **CodeMirror 6 Editor** — Prism DSL syntax highlighting and auto-completion
- **3D Card Effect** — Perspective transform on proxy node cards
- **Theme System** — 5 presets (purple, blue, green, orange, pink) + custom hex color
- **i18n** — 4 languages (en, zh, ja, ko)
- **Event Bus** — Inter-module communication (`Bus`/`Events`)
- **Centralized State** — `appStore` for reactive state management
- **Cache Layer** — Config and proxy data caching with invalidation, run-config TTL cache (5 s) with request coalescing

## Architecture

```
apps/desktop/src-tauri/src/
  lib.rs                    — App entry, command registration, state management, rate limiting
  backend_event.rs          — Structured event system, error codes, path redaction, frontend dispatch
  config_manager.rs         — Settings read/write
  os_notification.rs        — OS-level notification dispatch
  core/                     — Mihomo process, TUN, config, crypto, subscription
    config_manager.rs       — Profile CRUD, subscription edit, proxy selection memory
    subscription.rs         — Subscription download, batch update, base64 decode
    subscription_scheduler.rs — Background auto-update scheduler (per-subscription interval)
    core_log.rs             — Mihomo core log reader with line truncation (64 KB)
    crypto.rs               — AES-256-GCM encryption/decryption, machine key management
    config_sanitizer.rs     — Dangerous YAML key removal, CFW legacy cleanup
    network_optim.rs        — Network optimization (TCP params apply/revert/check_status, cross-platform sysctl/netsh/osascript)
    log_writer.rs           — Log persistence (daily rotation, severity filtering, export)
    minisign_verify.rs      — Minisign Ed25519 signature verification (client update integrity)
  prism/                    — Prism engine (95 IPC commands)
    commands_core.rs        — Core Prism commands (apply, validate, watch, trace, rebuild, preview, insert, toggle, stats)
    rule_library.rs         — Rule CRUD, import, extract, groups
    smart_commands.rs       — Smart proxy selector (EMA scoring, scheduler)
    smart_state.rs          — Smart State async persistence (WAL + DashMap + mpsc)
    failover_commands.rs    — Failover detection and policy
    script_commands.rs      — JS sandbox execution and limits
    plugin_commands.rs      — Plugin lifecycle and permissions
    kv_commands.rs          — Persistent key-value store
    rate_limiter.rs         — Sliding-window rate limiter
    overrides_commands.rs   — Override system (14 commands)
    pipeline.rs             — Override execution pipeline (batch apply, hot reload, test)
  sys_proxy.rs              — System proxy (Windows/macOS/Linux)
  tray.rs                   — System tray management
  updater.rs                — Core/client/geo update system
  global_shortcut.rs        — Global keyboard shortcuts
  deep_link.rs              — Protocol URL handling
  uwp_loopback.rs           — Windows UWP loopback exemption
```

158 IPC commands · 348 Rust tests · Tauri 2.11 · Rust 1.92
- **Theme System** — 5 presets (purple, blue, green, orange, pink) + custom hex color
- **i18n** — 4 languages (en, zh, ja, ko)
- **Event Bus** — Inter-module communication (`Bus`/`Events`)
- **Centralized State** — `appStore` for reactive state management
- **Cache Layer** — Config and proxy data caching with invalidation, run-config TTL cache (5 s) with request coalescing

## Architecture

```
apps/desktop/src-tauri/src/
  lib.rs                    — App entry, command registration, state management, rate limiting
  backend_event.rs          — Structured event system, error codes, path redaction, frontend dispatch
  config_manager.rs         — Settings read/write
  os_notification.rs        — OS-level notification dispatch
  core/                     — Mihomo process, TUN, config, crypto, subscription
    config_manager.rs       — Profile CRUD, subscription edit, proxy selection memory
    subscription.rs         — Subscription download, batch update, base64 decode
    subscription_scheduler.rs — Background auto-update scheduler (per-subscription interval)
    core_log.rs             — Mihomo core log reader with line truncation (64 KB)
    crypto.rs               — AES-256-GCM encryption/decryption, machine key management
    config_sanitizer.rs     — Dangerous YAML key removal, CFW legacy cleanup
  prism/                    — Prism engine (95 IPC commands)
    commands_core.rs        — Core Prism commands (apply, validate, watch, trace, rebuild, preview, insert, toggle, stats)
    rule_library.rs         — Rule CRUD, import, extract, groups
    smart_commands.rs       — Smart proxy selector (EMA scoring, scheduler)
    smart_state.rs          — Smart State async persistence (WAL + DashMap + mpsc)
    failover_commands.rs    — Failover detection and policy
    script_commands.rs      — JS sandbox execution and limits
    plugin_commands.rs      — Plugin lifecycle and permissions
    kv_commands.rs          — Persistent key-value store
    rate_limiter.rs         — Sliding-window rate limiter
    overrides_commands.rs   — Override system (14 commands)
    pipeline.rs             — Override execution pipeline (batch apply, hot reload, test)
  sys_proxy.rs              — System proxy (Windows/macOS/Linux)
  tray.rs                   — System tray management
  updater.rs                — Core/client/geo update system
  global_shortcut.rs        — Global keyboard shortcuts
  deep_link.rs              — Protocol URL handling
  uwp_loopback.rs           — Windows UWP loopback exemption
```

145 IPC commands · 348 Rust tests · Tauri 2.11 · Rust 1.92
