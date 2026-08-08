# Features

## Core

- **Mihomo Proxy Engine** — Start/stop/restart the Mihomo core process, CPU v3 (AVX2/BMI1/2/FMA) runtime detection with 3-branch asset selection (v3 optimized → compatible → generic)
- **Multi-profile Management** — Create, read, edit, delete, and switch between YAML configurations
- **Subscription Management** — Download and update subscriptions (URL/file/QR/drag-and-drop), base64 auto-decode, 3-tier download fallback (direct → Mihomo proxy → system proxy)
- **Subscription Auto-Update** — Per-subscription configurable interval (30 min – 24 h), background tokio scheduler, manual trigger-all
- **Subscription Edit** — Inline edit subscription URL and update interval, URL validation (http/https only), preserve user-defined names
- **Subscription Drag-and-Drop Sort** — Reorder subscription list via drag-and-drop, auto-persist
- **Batch Subscription Update** — One-click update all subscriptions (bypasses per-command rate limit)
- **Proxy Node Memory (v2)** — Remember group + node selection per profile, auto-restore on switch, v1→v2 migration
- **Primary Group Resolver** — Deterministic 7-level priority chain (UI selection → saved preference → FINAL/MATCH rule → YAML order → GLOBAL.all → keyword scoring → fallback)
- **observedGroup Watcher** — Background polling (5 s interval) to detect actual proxy group usage from connections (30-sample, K=3 consecutive confirmation)
- **Hide Timeout Nodes** — Toggle to hide unavailable proxy nodes (delay ≤ 0 or ≥ 999999), always keep active node; safety valve preserves original list if all nodes hidden; GLOBAL group treated as include-all (bypasses filtering)
- **Port Configuration Modal** — Visual editor for mixed-port, socks-port, redir-port, tproxy-port (range 0–65535, duplicate check, all-disabled prevention)
- **Proxy Modes** — Rule-based routing, Global proxy, Direct connection
- **System Proxy** — Cross-platform (Windows/macOS/Linux with GNOME/KDE/XFCE support), automatic bypass for private networks, ownership guard with tamper detection and auto-restore
- **Clipboard Environment Variable Copy** — 5 shell formats (bash/fish/cmd/powershell/nushell) with unified case output (`http_proxy` + `HTTP_PROXY`); platform defaults (Windows→powershell, others→bash); Linux tray clipboard via Rust `arboard` crate (Wayland support via `wayland-data-control` feature), `spawn_blocking` to avoid UI thread blocking
- **TUN Mode** — Virtual network interface (Windows/macOS/Linux), atomic lock, auto-recovery on failure, auto-inject dns-hijack
- **ARM64 Native Support** — Linux ARM64 native builds (ubuntu-22.04-arm runner), Windows ARM64 cross-compilation (aarch64-pc-windows-msvc), mihomo binary adaptation with `arch` parameter
- **Linux GPU Acceleration** — WebKitGTK GPU compositing with Wayland support, hardware-accelerated rendering
- **Linux AppImage** — linuxdeploy-plugin-gtk packaging for improved GTK/WebKitGTK compatibility
- **Linux Custom Titlebar** — Borderless window with custom traffic light buttons (close/minimize/maximize), consistent with Windows/macOS
- **AUR Auto-Update** — Automatic Arch User Repository package update on release publish
- **Connection Management** — Real-time connection list with details and close capability
- **Traffic Statistics** — Real-time upload/download speed and historical trends
- **Portable Mode** — Extract-and-run, data stored in program directory, `.portable` marker file; ARM64 portable for Windows and Linux; portable exe reuses SignPath-signed Full build binary
- **Lightweight Mode** — Destroy WebView on window close to free memory, keep only system tray; auto-disable when "minimize to tray" is off
- **Silent Start** — Launch with main window hidden, only tray icon visible; toggle via Settings → General
- **mihomo -t Config Pre-check** — Validate configuration with `mihomo -t -f` before core start, preventing crash-restart loops
- **Log Persistence** — Backend log persistence with daily rotation, severity-level filtering, and one-click export; 6 log management IPC commands
- **Network Optimization** — Three-layer system: Mihomo config defaults (tcp-concurrent, keep-alive, fake-ip persistence) + OS TCP tuning (Fast Open, ECN, buffer) + DNS optimization; standalone Apply/Revert/Status UI
- **Configuration Backup & Restore** — Transactional ZIP export/import with manifest.json (SHA-256 + version + timestamp), 3-phase commit (verify → stage → atomic commit), auto-rollback on failure, 200MB/200:1 compression limits
- **WebView Crash Recovery (Windows)** — 3-layer defense: ProcessFailed event-driven reload/recreate, frontend heartbeat (15s interval), show-time detection (45s timeout); AtomicBool prevents concurrent reconstruction
- **System Resume Recovery** — Listen for `RunEvent::Resumed`, 3 TCP health checks (2s timeout each), auto-restart core on failure; ResumeGuard prevents concurrent handlers
- **Settings Schema Migration** — Versioned settings.json with `schema_version`, v0→v1 auto-migration, corrupt file backup to `settings.corrupt.<timestamp>.json`
- **catch_unwind Guards** — Critical functions (`start_core`, `write_config_file`, `update_core`) wrapped in `AssertUnwindSafe` + `catch_unwind`, panic converted to user-friendly errors
- **Dual-Source Update Check** — Race GitHub REST API against Atom Feed via `tokio::select!`, first successful response wins, version consistency check, DIGEST_CACHE for SHA-256 caching
- **Window State Persistence** — Persist window position, size, maximized state across sessions via `tauri-plugin-window-state`; create hidden → restore → show to avoid flicker
- **Render Pause on Hide** — Pause connection polling and traffic chart rendering when window hidden/minimized, auto-resume on visible
- **Provider Loading Poller** — 1.5 s interval polling for async provider loading, generation token for race cancellation, in-flight tracking, terminal exhaustion state (20 polls → Retry button), lifecycle cleanup on page leave
- **Golden (Snapshot) Tests** — `insta` crate for input/output contract testing (68 scenarios across 14 test files: `sanitize_name`, `truncate_str`, `format_proxy_env`, `mask_url`, `parse_version`, etc.)
- **Workspace Unified Lint** — `[workspace.lints]` in `Cargo.toml` (170 deny rules, 4-tier classification: correctness/security → concurrency/memory → alloc perf → CPU/algorithm), all member crates inherit via `[lints] workspace = true`
- **rust-toolchain Pinning** — `rust-toolchain.toml` fixed to specific Rust version, GitHub Actions locked to commit SHA (not floating tags)

## Prism Engine (`clash-prism-*`)

- **Rule Engine** — Compile and apply rule patches via Prism DSL (`$prepend`/`$append`/`$filter`/`$override` + `__when__` conditions)
- **Rule Library** — CRUD for `.prism.yaml` rule files, groups, import (text/file/URL), auto-apply, file watching
- **Smart Proxy Selector** — EMA scoring (latency/success rate/stability), adaptive scheduler, auto-select best node, observed group/node tracking with special group exclusion
- **Failover** — Automatic node switching on failure, configurable thresholds, cooldown, and fallback groups
- **Script Engine** — JavaScript sandbox with 9 resource limits (time, memory, string length, loop iterations, recursion depth, etc.) and 4 permission controls (network, filesystem, child process, workers)
- **Plugin System** — Discovery, loading, lifecycle hooks, fine-grained permission checks
- **KV Store** — Persistent key-value storage (`kv_store.db`)
- **Override System** — Prism DSL + JavaScript dual-engine config overrides, scope management (global/per-profile), drag-reorder, import/export, remote override support, failure status indicator

## Security

- **AES-GCM + PBKDF2** — Configuration encryption with hardware-fingerprint-derived machine key (hex-encoded, strict UTF-8 on decrypt); optional config file encryption (v2: `djI6` base64 prefix)
- **SSRF Protection** — DNS validation for subscription/rule URLs; user-initiated private address input allowed, but redirects to private IPs are blocked; DNS rebinding protection via IP Pinning
- **DNS Leak Prevention** — TUN mode auto-injects `dns-hijack` to route all DNS traffic through Mihomo
- **Config Sanitizer** — Recursive removal of dangerous YAML keys (`script`, `script-path`, 6 CFW legacy keys), provider path traversal prevention, Billion Laughs attack defense (MAX_YAML_DEPTH = 100)
- **REALITY short-id Protection** — Quote hex values before YAML parsing to prevent scientific notation misinterpretation
- **Input Validation** — Length limits, format checks, UTF-8 safe truncation across all IPC commands
- **XSS Prevention** — `escapeHtml` (NFKC + browser round-trip), `escapeAttr`, `sanitizeHtml` (whitelist + `<template>` parsing + `STRIP_CONTENT_TAGS`), `html`/`safeHtml` tagged template literals, `eslint-plugin-no-unsanitized` enforcement
- **Rate Limiting** — Sliding-window rate limiter for sensitive commands (`script_execute`, `rule_import_url`, notifications, shortcuts)
- **File Security** — Unix 0600 permissions / Windows ACL, UUID temp files, ZIP/TAR path traversal protection, symlink rejection, compression bomb detection, secure_io.rs module
- **Update Integrity** — SHA256 verification + Minisign Ed25519 signature verification, trusted host allowlist (github.com only), asset name validation, atomic update with auto-rollback
- **Deep Link Safety** — Protocol restriction (`clash://`), URL scheme allowlist, path traversal prevention (13 dangerous chars including Windows reserved `< > : " | ? *`), Windows reserved device name handling (CON/PRN/AUX/NUL/COM1-9/LPT1-9), trailing space cleanup
- **CSP** — Strict Content Security Policy with `frame-ancestors 'none'` (clickjacking prevention)
- **DOM ID CSPRNG** — `crypto.getRandomValues()` replaces `Math.random()` in `dom-id.js` (Semgrep S2245 fix)
- **Clippy** — 170 deny rules (workspace-level `[workspace.lints.clippy]`, 4-tier classification), including `unwrap_used`, `expect_used`, `indexing_slicing`, `undocumented_unsafe_blocks`
- **Release Hardening** — LTO, single codegen unit, strip symbols, panic=unwind (with catch_unwind guards)
- **URL Leakage Prevention** — `get_config_url` demoted to internal function (not exposed to frontend)
- **Backend Event System** — Structured logging with 4 levels (Fatal/Error/Warn/Info), 10 modules, 83 error codes; automatic path redaction; frontend event bus with Toast notifications for Fatal/Error
- **CI Security Pipeline** — 12-job security workflow: cargo-audit, cargo-deny (AGPL-3.0 deny), Clippy (170 rules), Semgrep SAST + SARIF upload, Trufflehog (SHA-pinned) + custom grep, OSSF Scorecard (SARIF + artifact), Tauri audit, build verification, macOS cross-compile check
- **SBOM Generation** — CycloneDX format (Rust via `cargo cyclonedx` + frontend via `npm sbom`), merged via `scripts/merge-sboms.py`, published as Release asset
- **SignPath Code Signing** — Windows Authenticode signing (NSIS + MSI + Portable exe) via SignPath Foundation, x64 + ARM64, 4-step flow with partial-signing prevention
- **Supply Chain Hardening** — All GitHub Actions pinned to commit SHA, `persist-credentials: false` on checkout, `pnpm overrides` for transitive vulnerability fixes (nanoid/brace-expansion/ws), `engines.node >= 20.18.1`

## System Integration

- **System Tray** — Status-aware icon (default/sysproxy/tun), full context menu with proxy/config/mode controls
- **Global Shortcuts** — 6 configurable actions (toggle-window, toggle-proxy, toggle-tun, mode-rule, mode-global, mode-direct), platform-aware display (⌘ vs Ctrl)
- **Deep Link** — `clash://` protocol association for subscription import
- **UWP Loopback Exemption** — Allow Windows Store apps to access local proxy (with user confirmation + cooldown)
- **Auto-update** — Mihomo core, GeoIP/GeoSite databases, Zephyr client; dual-source race check, download progress reporting, atomic binary replacement; Windows binaries Authenticode-signed via SignPath
- **Auto-start** — Launch on system startup via `tauri-plugin-autostart`
- **OS Notifications** — System-level notifications with correct app identity (AUMID)
- **File Manager Integration** — Open config/Prism folders in system file manager

## UI/UX

- **Custom Window** — Frameless transparent window with custom title bar, Linux custom titlebar with traffic light buttons
- **UI Scaling** — 0.5x – 2.0x interface scaling with CSS `transform: scale()`, dropdown/context-menu position correction under transform
- **Virtual Scroll Log Viewer** — O(log n) binary search, incremental polling, 5-level filtering, regex search
- **CodeMirror 6 Editor** — Prism DSL syntax highlighting and auto-completion
- **Navigation Micro-animations** — Luxury-grade sidebar icon animation system with Draw-On engine (pathLength=1 normalization + stroke-dashoffset), page-specific animations (Home/Proxies/Subscriptions/Connections/Rules/Logs/Settings), is-active/is-leaving state management, prefers-reduced-motion support
- **3D Card Effect** — Perspective transform on proxy node cards, performance optimized (cached getBoundingClientRect, pageX/pageY for scroll immunity, WeakMap timeout management)
- **Design Token System** — Style Dictionary pipeline with 3 layers (Primitive → Semantic → Component), 4-level radius system (Control 8px / Surface 12px / Overlay 16px / Full 9999px), semantic surface layers (page/raised/elevated/input/overlay), hardcoded color elimination
- **Component System** — Unified Form Control (sm/md/lg sizes + mono variant), Status Dot (online/offline/error/warning), Latency Badge (fast/medium/slow color-coded), Danger Zone styling, Status Ring (SVG stroke-dashoffset circular progress), Button State Matrix (disabled/loading/aria-busy)
- **Accessibility Enhancements** — Unified disabled state across all interactive elements, hover protection for disabled buttons, collapsible ARIA (role/button/tabindex/aria-expanded/aria-controls/keyboard), dropdown disabled guards, proxies reduced-motion support, theme-aware focus ring via color-mix, transition tokens
- **Theme System** — 5 presets (purple, blue, green, orange, pink) + custom hex color, automatic dark/light switching via CSS custom properties
- **i18n** — 4 languages (en, zh, ja, ko)
- **Event Bus** — Inter-module communication (`Bus`/`Events`)
- **Centralized State** — `appStore` for reactive state management
- **Cache Layer** — Config and proxy data caching with invalidation, run-config TTL cache (5 s) with request coalescing
- **UnoCSS** — Migrated from Tailwind CSS v4 to UnoCSS presetWind4, instant on-demand atomic CSS engine, `uno.config.js` with dark class mode

## Architecture

```
apps/desktop/src-tauri/src/
  lib.rs                    — App entry, command registration (170+ IPC), state management, rate limiting, resume handler
  backend_event.rs          — Structured event system, 83 error codes, path redaction, frontend dispatch
  config_manager.rs         — Tauri commands for runtime config read/update (delegates logic to zephyr_core)
  core_manager.rs           — Core state management, profile file I/O, app storage helpers
  core_event_bridge.rs      — Bridge between backend events and Tauri frontend
  os_notification.rs        — OS-level notification dispatch, UTF-8 safe truncation
  prism.rs                  — Prism Engine Tauri command layer (77 commands, thin wrappers around clash-prism crates)
  backup.rs                 — Transactional config export/import: ZIP + manifest + SHA-256 + 3-phase commit + rollback
  webview_recovery.rs       — WebView2 crash recovery: ProcessFailed → reload/recreate, heartbeat
  minisign_verify.rs        — Minisign Ed25519 signature verification (hardcoded public key)
  sys_proxy.rs              — System proxy: Windows/macOS/Linux native, ownership guard, env var copy
  tray.rs                   — System tray management, proxy env var formatting (5 shell formats)
  updater.rs                — Core/client/geo update system, dual-source race, atomic replace
  global_shortcut.rs        — Global keyboard shortcuts
  deep_link.rs              — Protocol URL handling, sanitize_name (13 dangerous chars + Windows reserved names)
  uwp_loopback.rs           — Windows UWP loopback exemption
  core/                     — Mihomo process, TUN, config, crypto, subscription (13 submodules)
    mod.rs                  — Module facade, types, global atomics
    core_process.rs         — Process management: start/stop/version/binary replace/health check/port wait, runtime config injection, mihomo -t precheck, orphan protection (Job Object / process group + PR_SET_PDEATHSIG), catch_unwind guard
    crypto.rs               — AES-256-GCM encryption, PBKDF2, machine fingerprint, config encryption
    subscription.rs         — Subscription download, SSRF, DNS pinning, error diagnostics
    subscription_scheduler.rs — Background subscription auto-update scheduler (tokio)
    tun_manager.rs          — TUN mode, privilege escalation (osascript/pkexec/setcap/polkit), cleanup
    network_optim.rs        — Network optimization (sysctl/netsh/osascript)
    config_manager.rs       — Profile CRUD, encrypted config read/write
    log_writer.rs           — Log persistence, daily rotation, export
    secure_io.rs            — Secure file writing (Unix 0o600 / Windows DACL)
    fetch_util.rs           — HTTP fetch utilities, host:port formatting, URL building
    core_log.rs             — Mihomo core log incremental reading
    network_optim_tests.rs  — Golden snapshot tests (generate_linux_optim_script)
    subscription_scheduler_test.rs — Subscription scheduler tests
  prism/                    — Prism engine (21 files, 4700+ lines, 119+ tests)
    commands_core.rs        — Core Prism commands (apply/validate/status/config/watch/trace)
    rule_library.rs         — Rule CRUD, import, extract, groups
    smart_commands.rs       — Smart proxy selector (EMA scoring, scheduler)
    smart_state.rs          — Smart State async persistence (WAL + DashMap + mpsc)
    smart_state_tests.rs    — Smart State Golden snapshot tests
    plugin_commands.rs      — Plugin lifecycle and permissions
    script_commands.rs      — JS sandbox execution and limits
    overrides.rs            — Override system entry
    overrides/              — Override submodules (model/store/commands/pipeline)
    overrides_model.rs      — Override model, version parsing
    overrides_model_tests.rs — Override model Golden snapshot tests
    overrides_store.rs      — Override persistence store
    overrides_commands.rs   — Override system IPC (14 commands)
    overrides_commands_tests.rs — Override commands Golden snapshot tests
    pipeline.rs             — Override execution pipeline
    types.rs                — Type definitions, input validation
    host.rs                 — PrismHost trait implementation
    rate_limiter.rs         — Sliding-window rate limiter
    rule_groups.rs          — Rule group parsing
    failover_commands.rs    — Failover detection and policy
    kv_commands.rs          — Persistent key-value store
    trace_commands.rs       — Configuration trace
  tray_tests.rs             — Tray Golden snapshot tests (format_proxy_env, 7 scenarios)
  os_notification_tests.rs  — Notification Golden snapshot tests (truncate_str, 9 scenarios)
  prism_tests.rs            — Prism integration tests (1397 lines)

crates/core/                 — Cross-platform core library (FFI-safe, no Tauri dependency)
  lib.rs                    — Crate root, module re-exports
  config/                   — Config merge, sanitizer, subscription, types, overrides model, pipeline types
    merge.rs                — YAML deep merge, mask_url (UTF-8 safe)
    sanitizer.rs            — Dangerous YAML key removal, Billion Laughs defense
    subscription.rs         — Subscription URL quoting, percent-decode, redaction
    fetch_util.rs           — HTTP fetch utilities
  crypto.rs                 — AES-256-GCM, PBKDF2, machine fingerprint
  error.rs                  — AppError type, error mapping
  event.rs                  — Backend event types, path redaction
  process.rs                — Mihomo version parsing
  updater.rs                — Asset URL building, version comparison
  rate_limiter.rs           — Sliding-window rate limiter
  smart_selector.rs         — EMA scoring, smart node selection
  failover.rs               — Failover policy validation
  state.rs                  — Core state types
  (24 .snap files across config/ + src/ for Golden snapshot tests)

crates/core-ffi/             — UniFFI bindings for core crate (generates FFI for future mobile/desktop reuse)
```

170+ IPC commands · 524 Rust tests + 376 frontend test cases · Tauri 2.x · Rust 1.96.0 · 83 error codes
