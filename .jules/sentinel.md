# Sentinel Security Journal

## 2025-05-18 - Restrict URL Schemes for Opener IPC
**Vulnerability:** Untrusted or arbitrary URI schemes passed to `plugin:opener|open_url` can trigger OS protocol handlers or execute local files/commands.
**Learning:** Desktop webview APIs wrapping native shell/opener commands must strictly restrict URLs to `http:` and `https:` schemes.
**Prevention:** Always validate URL schemes using regex or URL parser before invoking native opener IPC commands in desktop applications.

## 2026-07-16 - YAML Sanitization Gap in Rule Creation & Update
**Vulnerability:** `rule_create` and `rule_update` written `.prism.yaml` rule files directly to disk without stripping dangerous YAML keys (`script`, `external-controller-*`, `external-ui`, provider `path`), unlike `rule_import_*` functions which sanitized YAML.
**Learning:** High-level import wrappers sanitizing input can obscure missing sanitization in lower-level CRUD commands (`create`/`update`).
**Prevention:** Always apply `remove_dangerous_keys` across all IPC commands that accept user-provided or API-provided YAML configuration/rule inputs.

## 2026-07-20 - Plugin ID Path Traversal and Directory Removal Gap
**Vulnerability:** `validate_plugin_id` did not reject bare `.` or trimmed dot/space paths (e.g. `. `, `%2e`), allowing `plugin_delete` to resolve `dir.join(".")` to the `<prism_workspace>/plugins` base directory and delete all installed plugins via `remove_dir_all`.
**Learning:** Checking for substrings like `".."` or `"/"` is insufficient for path safety when `Path::join` interprets `.` as the target directory itself or when Windows canonicalization trims trailing spaces and dots.
**Prevention:** Always URL-decode and trim leading/trailing spaces and dots from user-controlled identifier inputs before validating against `.` and `..`, and reject colons, control characters, and reserved system filenames.
