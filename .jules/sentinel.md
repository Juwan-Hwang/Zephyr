# Sentinel Security Journal

## 2025-05-18 - Restrict URL Schemes for Opener IPC
**Vulnerability:** Untrusted or arbitrary URI schemes passed to `plugin:opener|open_url` can trigger OS protocol handlers or execute local files/commands.
**Learning:** Desktop webview APIs wrapping native shell/opener commands must strictly restrict URLs to `http:` and `https:` schemes.
**Prevention:** Always validate URL schemes using regex or URL parser before invoking native opener IPC commands in desktop applications.

## 2026-07-16 - YAML Sanitization Gap in Rule Creation & Update
**Vulnerability:** `rule_create` and `rule_update` written `.prism.yaml` rule files directly to disk without stripping dangerous YAML keys (`script`, `external-controller-*`, `external-ui`, provider `path`), unlike `rule_import_*` functions which sanitized YAML.
**Learning:** High-level import wrappers sanitizing input can obscure missing sanitization in lower-level CRUD commands (`create`/`update`).
**Prevention:** Always apply `remove_dangerous_keys` across all IPC commands that accept user-provided or API-provided YAML configuration/rule inputs.

## 2026-07-17 - Missing YAML Sanitization in Prism Overrides System
**Vulnerability:** `override_create`, `override_set_content`, `override_refresh_remote`, and `override_import` wrote user-provided, imported, and remote Prism YAML overrides to disk without stripping dangerous YAML keys (`script`, `external-controller-*`, `external-ui`, provider `path`).
**Learning:** Adding new override or patch compilation mechanisms in the Tauri command layer can re-introduce YAML injection vectors if sanitization is not consistently applied across all YAML ingestion paths.
**Prevention:** Always invoke `remove_dangerous_keys_internal_pub` or a `sanitize_override_yaml` wrapper whenever user or remote YAML content is persisted or processed.
