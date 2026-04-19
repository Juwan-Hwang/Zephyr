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
    FETCH_TEXT: "fetch_text",
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
});
