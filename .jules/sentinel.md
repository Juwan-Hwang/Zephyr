# Sentinel Security Journal

## 2025-05-18 - Restrict URL Schemes for Opener IPC
**Vulnerability:** Untrusted or arbitrary URI schemes passed to `plugin:opener|open_url` can trigger OS protocol handlers or execute local files/commands.
**Learning:** Desktop webview APIs wrapping native shell/opener commands must strictly restrict URLs to `http:` and `https:` schemes.
**Prevention:** Always validate URL schemes using regex or URL parser before invoking native opener IPC commands in desktop applications.

## 2026-07-16 - YAML Sanitization Gap in Rule Creation & Update
**Vulnerability:** `rule_create` and `rule_update` written `.prism.yaml` rule files directly to disk without stripping dangerous YAML keys (`script`, `external-controller-*`, `external-ui`, provider `path`), unlike `rule_import_*` functions which sanitized YAML.
**Learning:** High-level import wrappers sanitizing input can obscure missing sanitization in lower-level CRUD commands (`create`/`update`).
**Prevention:** Always apply `remove_dangerous_keys` across all IPC commands that accept user-provided or API-provided YAML configuration/rule inputs.

## 2026-07-17 - Missing YAML Sanitization in Configuration File Writer
**Vulnerability:** `write_config_file` stored user-edited or imported YAML content directly to disk without running `remove_dangerous_keys`, potentially allowing dangerous keys (`script`, `external-controller-*`, `external-ui`, provider `path`) to be persisted in profile YAML files.
**Learning:** Direct file editing/saving commands exposed over IPC must apply the same sanitization pipelines as initial config import paths.
**Prevention:** Always sanitize YAML content before persisting configuration files in `write_config_file_inner`.
