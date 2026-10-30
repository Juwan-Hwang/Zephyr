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

## 2026-07-16 - Missing YAML Sanitization and Filename Validation in Backup Archive Import
**Vulnerability:** Backup ZIP import extracted `profiles/*.yaml` and `run_config.yaml` without stripping dangerous YAML keys (`script`, `external-controller-*`, `external-ui`, provider `path`) or validating profile filenames.
**Learning:** Archives generated outside the application or by legacy software can carry dangerous or malformed YAML keys and filenames into storage upon restore if sanitization is omitted during extraction/staging.
**Prevention:** Always validate filenames with `sanitize_config_file_name` and apply `remove_dangerous_keys_internal_pub` to extracted YAML configuration files prior to committing staged archive contents.

## 2026-07-17 - Missing YAML Sanitization in Configuration File Writer
**Vulnerability:** `write_config_file` stored user-edited or imported YAML content directly to disk without running `remove_dangerous_keys`, potentially allowing dangerous keys (`script`, `external-controller-*`, `external-ui`, provider `path`) to be persisted in profile YAML files.
**Learning:** Direct file editing/saving commands exposed over IPC must apply the same sanitization pipelines as initial config import paths.
**Prevention:** Always sanitize YAML content before persisting configuration files in `write_config_file_inner`.

## 2026-07-18 - Missing Plugin ID Validation in Script Sandbox Permission Management
**Vulnerability:** `script_grant_plugin`, `script_revoke_plugin`, and `script_check_plugin_permission` accepted `plugin_id` directly without invoking `validate_plugin_id`, allowing unsanitized plugin IDs (containing path traversal sequences, reserved names, or control characters) into the script sandbox permission configuration.
**Learning:** Commands in secondary modules that manipulate plugin permissions or settings can easily omit validation routines implemented in the primary plugin module.
**Prevention:** Always enforce `validate_plugin_id` on every IPC handler accepting a `plugin_id` parameter regardless of module boundary.

## 2026-07-19 - Unvalidated User-Agent Input in IPC Commands
**Vulnerability:** `update_subscription_user_agent` accepted arbitrary string inputs over IPC without length or control character checks. Passing newlines (`\r\n`) or oversized strings persisted invalid header values into settings, causing HTTP client building during subscription downloads to fail permanently and leading to persistent DoS.
**Learning:** Setting values that map directly to HTTP request headers must be validated for length limits and control characters prior to persistence.
**Prevention:** Always validate User-Agent strings (`validate_user_agent`) to enforce maximum length limits (<= 512 chars) and reject control characters (`\r`, `\n`, `\0`) before writing to settings or constructing HTTP clients.
