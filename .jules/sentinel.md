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

## 2026-07-19 - String Prefix Boundary Check Bypass in validate_path_within_dir
**Vulnerability:** `validate_path_within_dir` used raw string `starts_with()` when validating paths that do not yet exist on disk, permitting traversal sequences (e.g. `/base/dir/../../etc/passwd`) and sibling directories that share a name prefix (e.g. `/base/dir_evil/file`).
**Learning:** Comparing file paths via string prefix matching fails to enforce path component boundaries and fails to resolve relative path elements (`..` / `.`) when canonicalization cannot be performed on non-existent paths.
**Prevention:** Always normalize paths lexically across components using `Path::components()` and verify boundary containment at the path component level (`Path::starts_with()`) rather than substring matching.

## 2026-11-02 - Enforce HTTPS Scheme and Strict Domain Suffix for Core Updaters
**Vulnerability:** `is_trusted_update_url` and `parse_github_release_info` validated hostname strings against trusted GitHub hosts without verifying `parsed.scheme() == "https"`, allowing plaintext HTTP downloads of updater binaries and opening vectors for on-path adversary MITM attacks. Additionally, host check avoided allocation via suffix stripping with dot delimiter.
**Learning:** Checking hostname patterns without enforcing encrypted transport protocol schemes permits silent fallback to plaintext traffic in updater workflows.
**Prevention:** Always enforce `parsed.scheme() == "https"` alongside strict domain/subdomain checks on all URL-evaluating security boundary functions.
