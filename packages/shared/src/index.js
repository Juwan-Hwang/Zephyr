/**
 * @fileoverview Single source of truth for Tauri IPC command names.
 *
 * All invoke() calls in the desktop app MUST reference COMMANDS from this
 * file. When a Rust command is renamed, updating this constant causes
 * TypeScript to flag every call site that needs updating.
 *
 * This is the foundation for future tauri-specta integration (Phase 2),
 * at which point this file will be auto-generated.
 */

// ---------------------------------------------------------------------------
// Core commands
// ---------------------------------------------------------------------------

export const CORE = Object.freeze({
    START_CORE: "start_core",
    STOP_CORE: "stop_core",
    GET_CORE_VERSION: "get_core_version",
    READ_CONFIG: "read_config",
    UPDATE_CONFIG: "update_config",
    READ_LOG: "read_core_log",
});

// ---------------------------------------------------------------------------
// Config file management
// ---------------------------------------------------------------------------

export const CONFIG_FILES = Object.freeze({
    LIST_CONFIGS: "list_configs",
    GET_CONFIG_URL: "get_config_url",
    DELETE_CONFIG: "delete_config",
    RENAME_CONFIG: "rename_config",
    READ_CONFIG_FILE: "read_config_file",
    WRITE_CONFIG_FILE: "write_config_file",
    OPEN_FOLDER: "open_config_folder",
});

// ---------------------------------------------------------------------------
// System proxy
// ---------------------------------------------------------------------------

export const SYS_PROXY = Object.freeze({
    ENABLE_SYSPROXY: "enable_sysproxy",
    DISABLE_SYSPROXY: "disable_sysproxy",
    GET_SYS_PROXY: "get_sys_proxy",
});

// ---------------------------------------------------------------------------
// Crypto
// ---------------------------------------------------------------------------

export const CRYPTO = Object.freeze({
    IS_MACHINE_KEY_PERSISTED: "is_machine_key_persisted",
});

// ---------------------------------------------------------------------------
// TUN
// ---------------------------------------------------------------------------

export const TUN = Object.freeze({
    SET_TUN_ENABLED: "set_tun_enabled",
    RELEASE_TUN_TOGGLE: "release_tun_toggle",
    RESTART_AS_ROOT: "restart_core_as_root_cmd",
    KILL_ALL_AS_ROOT: "kill_all_mihomo_as_root_cmd",
    DISABLE_CMD: "disable_tun_cmd",
});

// ---------------------------------------------------------------------------
// Tray
// ---------------------------------------------------------------------------

export const TRAY = Object.freeze({
    CHANGE_TRAY_ICON: "change_tray_icon",
    GET_TRAY_MENU_STATE: "get_tray_menu_state",
    SET_TRAY_MENU_STATE: "set_tray_menu_state",
    UPDATE_TRAY_FULL_MENU: "update_tray_full_menu",
    UPDATE_TRAY_TOGGLE_STATES: "update_tray_toggle_states",
    GET_TRAY_STATUS: "get_tray_status",
    GET_TRAY_PROXY_STATUS: "get_tray_proxy_status",
});

// ---------------------------------------------------------------------------
// Updater
// ---------------------------------------------------------------------------

export const UPDATER = Object.freeze({
    GET_LATEST_VERSION: "get_latest_version",
    UPDATE_CORE: "update_core",
    UPDATE_GEO_DATA: "update_geo_data",
    GET_LATEST_CLIENT_VERSION: "get_latest_client_version",
    UPDATE_CLIENT: "update_client",
    GET_LATEST_CLIENT_VERSIONS: "get_latest_client_versions",
});

// ---------------------------------------------------------------------------
// Global shortcuts (rate-limited wrappers)
// ---------------------------------------------------------------------------

export const SHORTCUTS = Object.freeze({
    REGISTER_SHORTCUT: "rate_limited_register_shortcut",
    UNREGISTER_SHORTCUT: "rate_limited_unregister_shortcut",
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export const SETTINGS = Object.freeze({
    GET_SETTINGS: "get_settings",
    SAVE_SETTINGS: "save_settings",
    SET_UI_SCALE: "set_ui_scale",
});

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

export const MISC = Object.freeze({
    GET_APP_VERSION: "get_app_version",
    SHOW_MAIN_WINDOW: "show_main_window",
    SEND_NOTIFICATION: "rate_limited_send_notification",
    EXEMPT_UWP_APPS: "exempt_uwp_apps",
});

// ---------------------------------------------------------------------------
// Subscription
// ---------------------------------------------------------------------------

export const SUBSCRIPTION = Object.freeze({
    DOWNLOAD_SUB: "download_sub",
    DOWNLOAD_SUB_BATCH: "download_sub_batch",
    FETCH_TEXT: "fetch_text",
});

// ---------------------------------------------------------------------------
// Prism Engine
// ---------------------------------------------------------------------------

export const PRISM = Object.freeze({
    APPLY: "prism_apply",
    STATUS: "prism_status",
    LIST_RULES: "prism_list_rules",
    PREVIEW_RULES: "prism_preview_rules",
    IS_PRISM_RULE: "prism_is_prism_rule",
    INSERT_RULE: "prism_insert_rule",
    INSERT_RULE_STR: "prism_insert_rule_str",
    TOGGLE_GROUP: "prism_toggle_group",
    TRACE_REPORT: "prism_trace_report",
    TRACE_REPORT_TEXT: "prism_trace_report_text",
    VALIDATE_CONFIG: "prism_validate_config",
    LIST_PROFILES: "prism_list_profiles",
    GET_CORE_INFO: "prism_get_core_info",
    START_WATCHING: "prism_start_watching",
    STOP_WATCHING: "prism_stop_watching",
    IS_WATCHING: "prism_is_watching",
    GET_STATS: "prism_get_stats",
    READ_RAW_PROFILE: "prism_read_raw_profile",
    REBUILD: "prism_rebuild",
});

// ---------------------------------------------------------------------------
// Rule Library (R2)
// ---------------------------------------------------------------------------

export const RULE = Object.freeze({
    // File CRUD
    RULE_LIST: "rule_list",
    RULE_READ: "rule_read",
    RULE_CREATE: "rule_create",
    RULE_UPDATE: "rule_update",
    RULE_DELETE: "rule_delete",
    RULE_RENAME: "rule_rename",
    // Rule extraction
    RULE_EXTRACT_FROM_PROFILE: "rule_extract_from_profile",
    // Rule import
    RULE_IMPORT_TEXT: "rule_import_text",
    RULE_IMPORT_FILE: "rule_import_file",
    RULE_IMPORT_URL: "rule_import_url",
    // Group management
    RULE_GROUP_LIST: "rule_group_list",
    RULE_GROUP_CREATE: "rule_group_create",
    RULE_GROUP_RENAME: "rule_group_rename",
    RULE_GROUP_DELETE: "rule_group_delete",
    RULE_GROUP_MOVE: "rule_group_move",
    // Settings
    RULE_GET_AUTO_APPLY: "rule_get_auto_apply",
    RULE_SET_AUTO_APPLY: "rule_set_auto_apply",
    // Folder
    OPEN_PRISM_FOLDER: "open_prism_folder",
});

// ---------------------------------------------------------------------------
// Plugin System
// ---------------------------------------------------------------------------

export const PLUGIN = Object.freeze({
    DISCOVER: "plugin_discover",
    LOAD: "plugin_load",
    UNLOAD: "plugin_unload",
    ENABLE: "plugin_enable",
    DELETE: "plugin_delete",
    LIST_LOADED: "plugin_list_loaded",
    EXECUTE_HOOK: "plugin_execute_hook",
    LIST_HOOKS: "plugin_list_hooks",
    EXECUTE: "plugin_execute",
    LIST_PERMISSIONS: "plugin_list_permissions",
    CHECK_PERMISSION: "plugin_check_permission",
});

// ---------------------------------------------------------------------------
// Script Engine
// ---------------------------------------------------------------------------

export const SCRIPT = Object.freeze({
    EXECUTE: "script_execute",
    VALIDATE: "script_validate",
    GET_SANDBOX: "script_get_sandbox",
    SET_SANDBOX: "script_set_sandbox",
    GET_LIMITS: "script_get_limits",
    SET_LIMITS: "script_set_limits",
    GRANT_PLUGIN: "script_grant_plugin",
    REVOKE_PLUGIN: "script_revoke_plugin",
    CHECK_PLUGIN_PERMISSION: "script_check_plugin_permission",
    IS_SANDBOX_SAFE: "script_is_sandbox_safe",
});

// ---------------------------------------------------------------------------
// Smart Proxy Selector
// ---------------------------------------------------------------------------

export const SMART = Object.freeze({
    SCORE: "smart_score",
    CONFIG: "smart_config",
    CONFIG_SAVE: "smart_config_save",
    NEXT_INTERVAL: "smart_next_interval",
    RANK: "smart_rank",
    SELECT_BEST: "smart_select_best",
    CLEAR_HISTORY: "smart_clear_history",
    SCORE_AT: "smart_score_at",
    VALIDATE_CONFIG: "smart_validate_config",
    SCHEDULER_CONFIG: "smart_scheduler_config",
    TRIM_HISTORY: "smart_trim_history",
});

// ---------------------------------------------------------------------------
// Failover
// ---------------------------------------------------------------------------

export const FAILOVER = Object.freeze({
    REPORT: "failover_report",
    GET_POLICY: "failover_get_policy",
    SET_POLICY: "failover_set_policy",
    FAILURE_COUNT: "failover_failure_count",
    RESET: "failover_reset",
});

// ---------------------------------------------------------------------------
// KV Store
// ---------------------------------------------------------------------------

export const KV = Object.freeze({
    GET: "kv_get",
    SET: "kv_set",
    DELETE: "kv_delete",
    KEYS: "kv_keys",
});

// ---------------------------------------------------------------------------
// Trace Advanced
// ---------------------------------------------------------------------------

export const TRACE_ADVANCED = Object.freeze({
    STATISTICS: "trace_statistics",
    FILTER_BY_SOURCE: "trace_filter_by_source",
});

// ---------------------------------------------------------------------------
// Convenience: all command names in one flat object
// ---------------------------------------------------------------------------

export const COMMANDS = Object.freeze({
    ...CORE,
    ...CONFIG_FILES,
    ...SYS_PROXY,
    ...TUN,
    ...TRAY,
    ...UPDATER,
    ...SHORTCUTS,
    ...SETTINGS,
    ...MISC,
    ...CRYPTO,
    ...SUBSCRIPTION,
    ...PRISM,
    ...RULE,
    ...PLUGIN,
    ...SCRIPT,
    ...SMART,
    ...FAILOVER,
    ...KV,
    ...TRACE_ADVANCED,
    // Preserve namespace access for code that uses COMMANDS.NAMESPACE.X
    CORE, CONFIG_FILES, SYS_PROXY, TUN, TRAY,
    UPDATER, SHORTCUTS, SETTINGS, MISC, CRYPTO,
    SUBSCRIPTION, PRISM, RULE, PLUGIN, SCRIPT, SMART,
    FAILOVER, KV, TRACE_ADVANCED,
});
