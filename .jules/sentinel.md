# Sentinel Security Journal

## 2025-05-18 - Restrict URL Schemes for Opener IPC
**Vulnerability:** Untrusted or arbitrary URI schemes passed to `plugin:opener|open_url` can trigger OS protocol handlers or execute local files/commands.
**Learning:** Desktop webview APIs wrapping native shell/opener commands must strictly restrict URLs to `http:` and `https:` schemes.
**Prevention:** Always validate URL schemes using regex or URL parser before invoking native opener IPC commands in desktop applications.

## 2026-07-16 - YAML Sanitization Gap in Rule Creation & Update
**Vulnerability:** `rule_create` and `rule_update` written `.prism.yaml` rule files directly to disk without stripping dangerous YAML keys (`script`, `external-controller-*`, `external-ui`, provider `path`), unlike `rule_import_*` functions which sanitized YAML.
**Learning:** High-level import wrappers sanitizing input can obscure missing sanitization in lower-level CRUD commands (`create`/`update`).
**Prevention:** Always apply `remove_dangerous_keys` across all IPC commands that accept user-provided or API-provided YAML configuration/rule inputs.

## 2026-07-17 - Plugin ID Validation Gap & Missing Deletion Boundary Check
**Vulnerability:** `validate_plugin_id` checked for `/`, `\`, `..`, and `\0`, but permitted colons (`:`), control characters, and reserved Windows device names (`CON`, `NUL`), allowing potential stream syntax or drive references, while `plugin_delete` lacked directory boundary checks.
**Learning:** Simple path traversal filters checking only `..` or `/` can be bypassed by NTFS stream syntax (`:`), Windows device names, or trailing dot/space normalizations.
**Prevention:** Always check both input validation (rejecting `:`, control characters, reserved names, trailing dots/spaces) and explicit directory boundary validation (`validate_path_within_dir`) prior to filesystem deletions.
