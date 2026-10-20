## 2026-07-16 - YAML Sanitization Gap in Rule Creation & Update
**Vulnerability:** `rule_create` and `rule_update` written `.prism.yaml` rule files directly to disk without stripping dangerous YAML keys (`script`, `external-controller-*`, `external-ui`, provider `path`), unlike `rule_import_*` functions which sanitized YAML.
**Learning:** High-level import wrappers sanitizing input can obscure missing sanitization in lower-level CRUD commands (`create`/`update`).
**Prevention:** Always apply `remove_dangerous_keys` across all IPC commands that accept user-provided or API-provided YAML configuration/rule inputs.
