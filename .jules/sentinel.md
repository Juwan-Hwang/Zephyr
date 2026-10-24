# Sentinel Security Journal

## 2025-05-18 - Restrict URL Schemes for Opener IPC
**Vulnerability:** Untrusted or arbitrary URI schemes passed to `plugin:opener|open_url` can trigger OS protocol handlers or execute local files/commands.
**Learning:** Desktop webview APIs wrapping native shell/opener commands must strictly restrict URLs to `http:` and `https:` schemes.
**Prevention:** Always validate URL schemes using regex or URL parser before invoking native opener IPC commands in desktop applications.

## 2026-07-16 - Missing YAML Sanitization and Filename Validation in Backup Archive Import
**Vulnerability:** Backup ZIP import extracted `profiles/*.yaml` and `run_config.yaml` without stripping dangerous YAML keys (`script`, `external-controller-*`, `external-ui`, provider `path`) or validating profile filenames.
**Learning:** Archives generated outside the application or by legacy software can carry dangerous or malformed YAML keys and filenames into storage upon restore if sanitization is omitted during extraction/staging.
**Prevention:** Always validate filenames with `sanitize_config_file_name` and apply `remove_dangerous_keys_internal_pub` to extracted YAML configuration files prior to committing staged archive contents.

## 2026-07-16 - YAML Sanitization Gap in Rule Creation & Update
**Vulnerability:** `rule_create` and `rule_update` written `.prism.yaml` rule files directly to disk without stripping dangerous YAML keys (`script`, `external-controller-*`, `external-ui`, provider `path`), unlike `rule_import_*` functions which sanitized YAML.
**Learning:** High-level import wrappers sanitizing input can obscure missing sanitization in lower-level CRUD commands (`create`/`update`).
**Prevention:** Always apply `remove_dangerous_keys` across all IPC commands that accept user-provided or API-provided YAML configuration/rule inputs.
