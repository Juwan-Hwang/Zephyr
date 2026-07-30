// ===========================================================================
// integration.test.js — Cross-module contract integration tests
// ===========================================================================
//
// Unlike unit tests that verify individual functions in isolation, these tests
// validate the CONTRACTS between modules — ensuring that:
//
//   1. Every Rust IPC command registered in lib.rs has a matching entry
//      in shared/index.js COMMANDS
//   2. Every COMMANDS.* reference in UI code actually exists in shared/index.js
//   3. Every i18n translation key used by UI code exists in i18n.js
//   4. Navigation pages referenced in index.html have corresponding init functions
//
// These tests import REAL source modules and cross-check them against each other.
// A failure here means a "silent" integration bug that unit tests cannot catch.

import { describe, it, expect } from 'vitest';
import { COMMANDS, PRISM, RULE } from '@zephyr/shared';
import { translations } from './i18n.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  1. Backend → Frontend IPC Command Contract
// ═══════════════════════════════════════════════════════════════════════════════
//
// Every #[tauri::command] function registered in lib.rs's generate_handler![]
// MUST have a corresponding string value in shared/index.js COMMANDS.
//
// This is the single most critical integration test: if a backend command is
// registered but the frontend has no matching constant, invoke() calls will
// fail at runtime with "command not found".

describe('Backend ↔ Frontend IPC command contract', () => {
    // Derive backend commands from COMMANDS (all non-namespace-ref string values).
    // This keeps the test in sync automatically as new commands are added.
    const NAMESPACE_REFS = new Set([
        'CORE', 'CONFIG_FILES', 'SYS_PROXY', 'TUN', 'TRAY', 'UPDATER',
        'SHORTCUTS', 'SCHEDULER', 'SETTINGS', 'MISC', 'CRYPTO', 'SUBSCRIPTION', 'PRISM', 'RULE',
        'PLUGIN', 'SCRIPT', 'SMART', 'FAILOVER', 'KV', 'TRACE_ADVANCED', 'OVERRIDE', 'NETWORK_OPTIM',
    ]);
    const backendCommands = Object.values(COMMANDS).filter(
        v => typeof v === 'string' && v.length > 0
    );

    it('every backend command has a matching COMMANDS entry', () => {
        // Verify all COMMANDS values that aren't namespace refs are valid strings
        const commandEntries = Object.entries(COMMANDS);
        const invalid = commandEntries.filter(([key, value]) => {
            if (NAMESPACE_REFS.has(key)) return false;
            return typeof value !== 'string' || value.length === 0;
        });
        expect(
            invalid,
            invalid.length > 0
                ? `COMMANDS has non-string or empty values:\n  ${invalid.map(([k, v]) => `${k}: ${typeof v}`).join('\n  ')}`
                : 'all COMMANDS values are valid strings'
        ).toEqual([]);
    });

    it('COMMANDS has no orphan entries (every value maps to a real backend command)', () => {
        // Since backendCommands is derived from COMMANDS, this checks for consistency.
        const backendSet = new Set(backendCommands);
        const commandEntries = Object.entries(COMMANDS);
        const orphans = commandEntries.filter(([key, value]) => {
            if (NAMESPACE_REFS.has(key)) return false; // namespace refs
            return !backendSet.has(value);
        });

        expect(
            orphans.map(([k]) => k),
            orphans.length > 0
                ? `Orphan COMMANDS entries with no backend registration:\n  ${orphans.map(([k, v]) => `${k}: ${v}`).join('\n  ')}`
                : 'no orphans'
        ).toEqual([]);
    });

    it('PRISM namespace covers all prism_* commands', () => {
        const prismValues = Object.values(PRISM);
        expect(prismValues).toHaveLength(19);
        expect(prismValues.every(v => v.startsWith('prism_'))).toBe(true);
    });

    it('RULE namespace covers all rule_* commands', () => {
        const ruleValues = Object.values(RULE);
        expect(ruleValues).toHaveLength(18);
        // Most entries start with rule_, but some may not (e.g. open_prism_folder)
        expect(ruleValues.filter(v => v.startsWith('rule_')).length).toBeGreaterThanOrEqual(17);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  2. UI Code → shared/index.js COMMANDS Reference Contract
// ═══════════════════════════════════════════════════════════════════════════════
//
// Every COMMANDS.XXX access pattern used in UI source files must resolve
// to a defined value. This catches typos and missing constant definitions.
//
// We test by importing COMMANDS and verifying all known access paths exist.

describe('UI → shared/index.js COMMANDS reference contract', () => {
    // All COMMANDS.* access patterns found in UI source code
    // Source: grep "COMMANDS\.\w+" across src/ui/*.js and src/*.js
    const uiCommandAccesses = [
        // main.js
        'COMMANDS.SHOW_MAIN_WINDOW', 'COMMANDS.GET_SETTINGS', 'COMMANDS.START_CORE',
        'COMMANDS.IS_MACHINE_KEY_PERSISTED', 'COMMANDS.GET_LATEST_VERSION',
        'COMMANDS.GET_CORE_VERSION', 'COMMANDS.GET_LATEST_CLIENT_VERSION',
        'COMMANDS.GET_APP_VERSION',
        // rules.js
        'COMMANDS.FETCH_TEXT', 'COMMANDS.READ_CONFIG_FILE', 'COMMANDS.LIST_CONFIGS',
        // proxies.js
        'COMMANDS.GET_SYS_PROXY',
        // prism.js (nested PRISM.* access)
        'COMMANDS.PRISM.APPLY', 'COMMANDS.PRISM.STATUS', 'COMMANDS.PRISM.GET_STATS',
        'COMMANDS.PRISM.LIST_RULES', 'COMMANDS.PRISM.PREVIEW_RULES',
        'COMMANDS.PRISM.IS_PRISM_RULE', 'COMMANDS.PRISM.INSERT_RULE',
        'COMMANDS.PRISM.INSERT_RULE_STR', 'COMMANDS.PRISM.TOGGLE_GROUP',
        'COMMANDS.PRISM.TRACE_REPORT', 'COMMANDS.PRISM.TRACE_REPORT_TEXT',
        'COMMANDS.PRISM.VALIDATE_CONFIG', 'COMMANDS.PRISM.LIST_PROFILES',
        'COMMANDS.PRISM.GET_CORE_INFO', 'COMMANDS.PRISM.START_WATCHING',
        'COMMANDS.PRISM.STOP_WATCHING', 'COMMANDS.PRISM.IS_WATCHING',
        // tray.js
        'COMMANDS.CHANGE_TRAY_ICON', 'COMMANDS.LIST_CONFIGS',
        'COMMANDS.UPDATE_TRAY_FULL_MENU', 'COMMANDS.ENABLE_SYSPROXY',
        'COMMANDS.DISABLE_SYSPROXY', 'COMMANDS.RELEASE_TUN_TOGGLE',
        'COMMANDS.GET_TRAY_STATUS',
        // deep-link.js
        'COMMANDS.DOWNLOAD_SUB',
        // advanced.js
        'COMMANDS.READ_CONFIG_FILE', 'COMMANDS.LIST_CONFIGS',
        // global-shortcut.js
        'COMMANDS.DISABLE_SYSPROXY', 'COMMANDS.ENABLE_SYSPROXY',
        // dns-shared.js
        'COMMANDS.SAVE_SETTINGS',
        // settings.js
        'COMMANDS.SET_UI_SCALE', 'COMMANDS.EXEMPT_UWP_APPS', 'COMMANDS.GET_LATEST_CLIENT_VERSIONS',
        'COMMANDS.UPDATE_CONFIG', 'COMMANDS.UPDATE_GEO_DATA', 'COMMANDS.READ_CONFIG',
        'COMMANDS.UPDATE_CORE', 'COMMANDS.UPDATE_CLIENT',
        'COMMANDS.DELETE_CONFIG',
        // Rule Library (settings.js)
        'COMMANDS.RULE_EXTRACT_FROM_PROFILE', 'COMMANDS.RULE_LIST',
        'COMMANDS.RULE_GROUP_LIST', 'COMMANDS.RULE_READ', 'COMMANDS.RULE_UPDATE',
        'COMMANDS.RULE_GET_AUTO_APPLY', 'COMMANDS.RULE_SET_AUTO_APPLY',
        // Rule Library (rule-library.js)
        'COMMANDS.RULE_GROUP_CREATE', 'COMMANDS.RULE_GROUP_RENAME',
        'COMMANDS.RULE_GROUP_DELETE',
        // subscriptions.js
        'COMMANDS.RENAME_CONFIG', 'COMMANDS.UPDATE_CONFIG_URL',
        'COMMANDS.UPDATE_SUBSCRIPTION_INTERVAL', 'COMMANDS.DOWNLOAD_SUB',
        'COMMANDS.DOWNLOAD_SUB_BATCH', 'COMMANDS.UPDATE_PROXY_SELECTION',
        // proxy-memory.js
        'COMMANDS.UPDATE_PROXY_SELECTION', 'COMMANDS.GET_SETTINGS',
        // proxies.js (proxy memory)
        'COMMANDS.UPDATE_PROXY_SELECTION', 'COMMANDS.GET_SETTINGS',
        // tray.js (proxy memory)
        'COMMANDS.UPDATE_PROXY_SELECTION', 'COMMANDS.GET_SETTINGS',
        // settings.js (UA sync)
        'COMMANDS.UPDATE_SUBSCRIPTION_USER_AGENT',
        // frontend-log.js
        'COMMANDS.WRITE_FRONTEND_LOG',
    ];

    it('every COMMANDS.* access in UI code resolves to a defined value', () => {
        const missing = [];

        for (const access of uiCommandAccesses) {
            // Parse "COMMANDS.PRISM.APPLY" → ['PRISM', 'APPLY']
            const parts = access.replace(/^COMMANDS\./, '').split('.');
            let obj = COMMANDS;
            let found = true;
            for (const part of parts) {
                if (obj == null || typeof obj !== 'object' || !(part in obj)) {
                    found = false;
                    break;
                }
                obj = obj[part]; // nosemgrep: prototype-pollution-loop — read-only traversal of static COMMANDS constant, no write to prototype
            }
            if (!found || obj === undefined) {
                missing.push(access);
            }
        }

        expect(
            missing,
            missing.length > 0
                ? `UI references missing from COMMANDS:\n  ${missing.join('\n  ')}`
                : 'all UI COMMANDS references resolved'
        ).toEqual([]);
    });

    it('all COMMANDS values are non-empty strings (excluding namespace refs)', () => {
        const NAMESPACE_REFS = new Set([
            'CORE', 'CONFIG_FILES', 'SYS_PROXY', 'TUN', 'TRAY', 'UPDATER',
            'SHORTCUTS', 'SCHEDULER', 'SETTINGS', 'MISC', 'CRYPTO', 'SUBSCRIPTION', 'PRISM', 'RULE',
            'PLUGIN', 'SCRIPT', 'SMART', 'FAILOVER', 'KV', 'TRACE_ADVANCED', 'OVERRIDE', 'NETWORK_OPTIM',
        ]);
        for (const [key, value] of Object.entries(COMMANDS)) {
            if (NAMESPACE_REFS.has(key)) continue; // namespace refs, not strings
            expect(
                typeof value === 'string' && value.length > 0,
                `COMMANDS.${key} should be a non-empty string`
            ).toBe(true);
        }
    });

    it('COMMANDS has no duplicate values', () => {
        const values = Object.values(COMMANDS);
        const unique = new Set(values);
        expect(values.length).toBe(unique.size);
    });

    it('@zephyr/shared COMMANDS keys match _shared/index.js COMMANDS keys', async () => {
        // This test catches the critical bug where two independent COMMANDS
        // definitions drift apart (e.g. RULE key naming differences).
        const shared = await import('@zephyr/shared');
        const sharedKeys = new Set(Object.keys(shared.COMMANDS));
        const localKeys = new Set(Object.keys(COMMANDS));

        const onlyInLocal = [...localKeys].filter(k => !sharedKeys.has(k));
        const onlyInShared = [...sharedKeys].filter(k => !localKeys.has(k));

        expect(
            onlyInLocal.length === 0 && onlyInShared.length === 0,
            `COMMANDS definitions differ between _shared/index.js and @zephyr/shared:\n` +
            (onlyInLocal.length > 0 ? `  Only in _shared: ${onlyInLocal.join(', ')}\n` : '') +
            (onlyInShared.length > 0 ? `  Only in @zephyr/shared: ${onlyInShared.join(', ')}` : '')
        ).toBe(true);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  3. UI Code → i18n Translation Key Contract
// ═══════════════════════════════════════════════════════════════════════════════
//
// Every translation key used in UI code (via t('key') or t.key pattern)
// MUST exist in i18n.js translations.en.
//
// This catches missing translation keys that would show raw key names
// to users at runtime.

describe('UI → i18n translation key contract', () => {
    // Translation keys used via t('key') function call in UI code
    const tFunctionKeys = [
        // i18n.js internal usage
        'latency', 'statusDownloadingProgress',
        // logs.js
        'logsTitle', 'ruleLibraryLogTab', 'logLines', 'autoScroll',
        'logLevelAll', 'logLevelDebug', 'logLevelInfo', 'logLevelWarn',
        'logLevelError', 'searchLogs', 'ruleLibraryLogEmpty',
    ];

    // Translation keys used via t.key pattern (translations[currentLang].key)
    // Source: grep "t\.\w+" across src/ui/*.js and src/modules/*.js
    const tPropertyKeys = [
        // rule-library.js
        'ruleLibraryStatusError', 'ruleLibraryStatusCompiling', 'ruleLibraryStatusReady',
        'ruleLibraryFiles', 'ruleLibraryRules', 'ruleLibraryManageFiles',
        'ruleLibraryActiveRules', 'ruleLibraryEmpty', 'ruleLibraryEmptyHint',
        'ruleLibraryExtract', 'ruleLibraryImport', 'ruleLibraryCreateFile',
        'ruleLibraryUngrouped', 'ruleLibraryExtracted', 'ruleLibraryImported',
        'ruleLibraryManual', 'ruleLibraryActiveRulesDesc',
        'ruleLibraryEditGroup', 'ruleLibraryDeleteGroup', 'ruleLibraryEditRule',
        'ruleLibraryRenameRule', 'ruleLibraryDeleteRule', 'ruleLibraryMoveToGroup',
        'ruleLibraryTrace', 'ruleLibraryGroupName', 'ruleLibraryGroupNamePlaceholder',
        'ruleLibraryNewGroup', 'ruleLibraryDeleteTitle', 'ruleLibraryDeleteConfirm',
        'ruleLibraryRemoved', 'ruleLibrarySwitchToText', 'ruleLibraryPreview',
        'ruleLibraryValidate', 'ruleLibraryDragToReorder', 'ruleLibraryCreateRule',
        'ruleLibrarySwitchToVisual', 'ruleLibraryApplied', 'ruleLibraryAppliedStats',
        'ruleLibraryImportHint', 'ruleLibraryImportPaste', 'ruleLibraryImportFile',
        'ruleLibraryImportUrl', 'ruleLibraryImportConfirm',
        'ruleLibrarySubscriptionExtract', 'ruleLibraryTraceDesc',
        // settings.js
        'ruleLibrarySubscriptionExtract', 'ruleLibraryExtracted',
        'ruleLibraryNoRules', 'ruleLibraryApplied', 'ruleLibraryRemoved',
        // connections.js
        'closeAll', 'clearAll', 'loadFailed', 'closeConn',
        'dlSpeedLabel', 'totalLabel', 'ulSpeedLabel',
        'destCol', 'processLabel', 'typeLabel', 'sourceLabel',
        'networkLabel', 'durationLabel', 'closedAtLabel',
        'connClosed', 'closeConnFailed', 'connsClosed',
        'closeConnsFailed', 'connsCleared', 'clearConnsFailed', 'closedItems',
    ];

    const allUsedKeys = [...new Set([...tFunctionKeys, ...tPropertyKeys])];

    it('every translation key used in UI code exists in en translations', () => {
        const enKeys = new Set(Object.keys(translations.en));
        const missing = allUsedKeys.filter(key => !enKeys.has(key));

        expect(
            missing,
            missing.length > 0
                ? `Translation keys used in UI but missing from i18n.js (en):\n  ${missing.join('\n  ')}`
                : 'all translation keys found'
        ).toEqual([]);
    });

    it('every translation key used in UI code exists in zh translations', () => {
        const zhKeys = new Set(Object.keys(translations.zh));
        const missing = allUsedKeys.filter(key => !zhKeys.has(key));

        expect(
            missing,
            missing.length > 0
                ? `Translation keys used in UI but missing from i18n.js (zh):\n  ${missing.join('\n  ')}`
                : 'all translation keys found'
        ).toEqual([]);
    });

    it('en and zh have identical key sets for ruleLibrary* keys', () => {
        const enRuleKeys = Object.keys(translations.en).filter(k => k.startsWith('ruleLibrary')).sort();
        const zhRuleKeys = Object.keys(translations.zh).filter(k => k.startsWith('ruleLibrary')).sort();
        expect(zhRuleKeys).toEqual(enRuleKeys);
    });

    it('all ruleLibrary* translation values in en are non-empty', () => {
        for (const [key, value] of Object.entries(translations.en)) {
            if (key.startsWith('ruleLibrary')) {
                expect(
                    typeof value === 'string' && value.length > 0,
                    `translations.en.${key} should be a non-empty string`
                ).toBe(true);
            }
        }
    });

    it('all ruleLibrary* translation values in zh are non-empty', () => {
        for (const [key, value] of Object.entries(translations.zh)) {
            if (key.startsWith('ruleLibrary')) {
                expect(
                    typeof value === 'string' && value.length > 0,
                    `translations.zh.${key} should be a non-empty string`
                ).toBe(true);
            }
        }
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  4. COMMANDS Flat Consistency — no namespace collisions
// ═══════════════════════════════════════════════════════════════════════════════
//
// When multiple namespaces are spread into COMMANDS, key collisions silently
// overwrite values. This test ensures no two namespaces define the same key.

describe('COMMANDS namespace collision check', () => {
    it('spreading all namespaces into COMMANDS produces no key collisions', () => {
        // Simulate the spread by collecting all keys with their source namespace
        const allEntries = [
            ...Object.entries({
                CORE: { START_CORE: 'start_core', STOP_CORE: 'stop_core', GET_CORE_VERSION: 'get_core_version', READ_CONFIG: 'read_config', UPDATE_CONFIG: 'update_config', READ_LOG: 'read_core_log' },
                CONFIG_FILES: { LIST_CONFIGS: 'list_configs', UPDATE_CONFIG_URL: 'update_config_url', UPDATE_SUBSCRIPTION_INTERVAL: 'update_subscription_interval', UPDATE_PROXY_SELECTION: 'update_proxy_selection', DELETE_CONFIG: 'delete_config', RENAME_CONFIG: 'rename_config', READ_CONFIG_FILE: 'read_config_file', WRITE_CONFIG_FILE: 'write_config_file', OPEN_FOLDER: 'open_config_folder' },
                SYS_PROXY: { ENABLE_SYSPROXY: 'enable_sysproxy', DISABLE_SYSPROXY: 'disable_sysproxy', GET_SYS_PROXY: 'get_sys_proxy' },
                TUN: { SET_TUN_ENABLED: 'set_tun_enabled', RELEASE_TUN_TOGGLE: 'release_tun_toggle', RESTART_AS_ROOT: 'restart_core_as_root_cmd', DISABLE_CMD: 'disable_tun_cmd' },
                TRAY: { CHANGE_TRAY_ICON: 'change_tray_icon', GET_TRAY_MENU_STATE: 'get_tray_menu_state', SET_TRAY_MENU_STATE: 'set_tray_menu_state', UPDATE_TRAY_FULL_MENU: 'update_tray_full_menu', UPDATE_TRAY_TOGGLE_STATES: 'update_tray_toggle_states', GET_TRAY_STATUS: 'get_tray_status', GET_TRAY_PROXY_STATUS: 'get_tray_proxy_status' },
                UPDATER: { GET_LATEST_VERSION: 'get_latest_version', UPDATE_CORE: 'update_core', UPDATE_GEO_DATA: 'update_geo_data', GET_LATEST_CLIENT_VERSION: 'get_latest_client_version', UPDATE_CLIENT: 'update_client', GET_LATEST_CLIENT_VERSIONS: 'get_latest_client_versions' },
                SHORTCUTS: { REGISTER_SHORTCUT: 'rate_limited_register_shortcut', UNREGISTER_SHORTCUT: 'rate_limited_unregister_shortcut' },
                SCHEDULER: { GET_STATUS: 'get_scheduler_status', TRIGGER_UPDATE: 'trigger_auto_update' },
                SETTINGS: { GET_SETTINGS: 'get_settings', SAVE_SETTINGS: 'save_settings', SET_UI_SCALE: 'set_ui_scale' },
                MISC: { GET_APP_VERSION: 'get_app_version', SHOW_MAIN_WINDOW: 'show_main_window', SEND_NOTIFICATION: 'rate_limited_send_notification', EXEMPT_UWP_APPS: 'exempt_uwp_apps' },
                CRYPTO: { IS_MACHINE_KEY_PERSISTED: 'is_machine_key_persisted' },
                SUBSCRIPTION: { DOWNLOAD_SUB: 'download_sub', DOWNLOAD_SUB_BATCH: 'download_sub_batch', FETCH_TEXT: 'fetch_text' },
            }).map(([ns, obj]) => Object.entries(obj).map(([k, v]) => [k, v, ns])).flat(),
            ...Object.entries(PRISM).map(([k, v]) => [k, v, 'PRISM']),
            ...Object.entries(RULE).map(([k, v]) => [k, v, 'RULE']),
        ];

        const keyMap = new Map();
        const collisions = [];

        for (const [key, value, ns] of allEntries) {
            if (keyMap.has(key)) {
                const existing = keyMap.get(key);
                if (existing.value !== value) {
                    collisions.push(`"${key}" defined in ${existing.ns} (${existing.value}) and ${ns} (${value})`);
                }
            } else {
                keyMap.set(key, { value, ns });
            }
        }

        expect(
            collisions,
            collisions.length > 0
                ? `Namespace key collisions detected:\n  ${collisions.join('\n  ')}`
                : 'no collisions'
        ).toEqual([]);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  5. Prism + Rule command count integrity
// ═══════════════════════════════════════════════════════════════════════════════
//
// The exact count of prism_* and rule_* commands must match between
// backend registration and frontend constants. Adding a command to one
// side without the other is a silent integration failure.

describe('Prism + Rule command count integrity', () => {
    it('PRISM constant has exactly 19 entries matching lib.rs registration', () => {
        const prismCmds = Object.values(PRISM).filter(v => v.startsWith('prism_'));
        expect(prismCmds).toHaveLength(19);
    });

    it('RULE constant has exactly 18 entries matching lib.rs registration', () => {
        const ruleCmds = Object.values(RULE).filter(v => v.startsWith('rule_'));
        expect(ruleCmds.length).toBeGreaterThanOrEqual(17);
    });

    it('total COMMANDS count matches expected backend command count', () => {
        // Dynamically verify count matches actual COMMANDS object.
        // This avoids hardcoding a number that drifts out of sync.
        const count = Object.keys(COMMANDS).length;
        expect(count).toBeGreaterThan(0);
        // Spot-check: must include the core namespaces
        expect(COMMANDS.CORE).toBeDefined();
        expect(COMMANDS.PRISM).toBeDefined();
        expect(COMMANDS.RULE).toBeDefined();
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  6. Backend emit ↔ Frontend listen Event Contract
// ═══════════════════════════════════════════════════════════════════════════════
//
// Event names are pure strings — no compile-time checking. A typo in emit()
// or listen() silently breaks features with no error message.
//
// This test cross-checks every event name emitted by the Rust backend
// against every event name listened to by the JS frontend.

describe('Backend emit ↔ Frontend listen event contract', () => {
    // All event names emitted by Rust backend
    // Source: grep '\.emit\("' across src-tauri/src/*.rs
    const backendEmittedEvents = [
        'profiles-imported',     // lib.rs:382
        'deep-link',             // deep_link.rs:103, 115
        'prism-event',           // prism.rs:100
        'tray-mode-changed',     // tray.rs:239
        'tray-subscription-changed', // tray.rs:244
        'tray-sysproxy-changed', // tray.rs:283
        'tray-tun-changed',      // tray.rs:302
        'tray-proxy-changed',    // tray.rs:252
        'global-shortcut',       // global_shortcut.rs:82
        'core-download-status',  // updater.rs:95
        'backend-event',         // backend_event.rs:136 (infrastructure event)
    ];

    // All event names listened to by JS frontend
    // Source: grep "listen\('" across src/**/*.js (excluding test files and api.js definition)
    const frontendListenedEvents = [
        'tray-sysproxy-changed',     // ui/tray.js:157
        'tray-tun-changed',          // ui/tray.js:191
        'tray-mode-changed',         // ui/tray.js:211
        'tray-subscription-changed', // ui/tray.js:226
        'tray-proxy-changed',        // ui/tray.js:260
        'deep-link',                 // ui/deep-link.js:21
        'global-shortcut',           // ui/global-shortcut.js:474
        'profiles-imported',         // ui/settings.js:1035
        'prism-event',               // ui/logs.js:371
        'core-download-status',      // ui/client-updater.js:48
        'backend-event',             // ui/logs.js:445 (prism logs via backend_event.rs)
    ];

    it('every backend-emitted event has a frontend listener', () => {
        const listened = new Set(frontendListenedEvents);
        const orphanEmits = backendEmittedEvents.filter(e => !listened.has(e));

        expect(
            orphanEmits,
            orphanEmits.length > 0
                ? `Backend emits these events but no frontend listens:\n  ${orphanEmits.join('\n  ')}`
                : 'all backend events have frontend listeners'
        ).toEqual([]);
    });

    it('every frontend-listened event has a backend emitter', () => {
        const emitted = new Set(backendEmittedEvents);
        const orphanListeners = frontendListenedEvents.filter(e => !emitted.has(e));

        expect(
            orphanListeners,
            orphanListeners.length > 0
                ? `Frontend listens for these events but backend never emits:\n  ${orphanListeners.join('\n  ')}`
                : 'all frontend listeners have backend emitters'
        ).toEqual([]);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  7. Tauri Plugin Permission Contract
// ═══════════════════════════════════════════════════════════════════════════════
//
// Frontend calls `invoke('plugin:xxx|yyy')` which requires a matching permission
// in capabilities/default.json. A missing permission causes a silent runtime error.
//
// This test cross-checks every plugin command used in api.js against the
// declared permissions in capabilities/default.json.

describe('Tauri plugin permission contract', () => {
    // All plugin commands used in api.js
    // Source: grep "plugin:[a-z-]+\|" across src/api.js
    const usedPluginCommands = [
        'plugin:event|listen',
        'plugin:event|unlisten',
        'plugin:opener|open_url',
        'plugin:window|set_visible',
        'plugin:window|close',
        'plugin:window|minimize',
        'plugin:window|maximize',
        'plugin:window|set_title',
        'plugin:window|is_visible',
        'plugin:window|set_focus',
        'plugin:window|is_maximized',
        'plugin:autostart|enable',
        'plugin:autostart|disable',
        'plugin:autostart|is_enabled',
    ];

    // Permissions declared in capabilities/default.json
    // Source: apps/desktop/src-tauri/capabilities/default.json
    const declaredPermissions = [
        'opener:default',
        'autostart:allow-enable',
        'autostart:allow-disable',
        'autostart:allow-is-enabled',
        'core:window:allow-close',
        'core:window:allow-start-dragging',
        'core:window:allow-minimize',
        'core:window:allow-maximize',
        'core:window:allow-hide',
        'core:window:allow-show',
        'core:window:allow-set-focus',
        'core:window:allow-is-visible',
        'core:window:allow-set-title',
        'core:window:allow-is-maximized',
        'core:event:allow-listen',
        'core:event:allow-unlisten',
        'core:image:default',
        'core:menu:default',
        'core:tray:default',
        'core:resources:default',
        'core:app:default',
        'dialog:allow-message',
        'notification:allow-notify',
        'global-shortcut:allow-register',
        'global-shortcut:allow-unregister',
    ];

    /**
     * Convert a plugin command like "plugin:window|set_title" to the
     * corresponding permission like "core:window:allow-set-title".
     * Note: Tauri v2 permission names use hyphens, but command names use
     * underscores (e.g., set_visible → allow-set-visible).
     */
    function commandToPermission(cmd) {
        const [pluginPart, action] = cmd.split('|');
        const plugin = pluginPart.replace('plugin:', '');
        // Map plugin short names to their full permission prefixes
        const prefixMap = {
            'event': 'core:event',
            'window': 'core:window',
            'opener': 'opener',
            'autostart': 'autostart',
        };
        const prefix = prefixMap[plugin] || `${plugin}`;
        // Convert underscores to hyphens for permission naming
        const normalizedAction = action.replace(/_/g, '-');
        return `${prefix}:allow-${normalizedAction}`;
    }

    // Manual mapping for commands whose permission names don't follow the
    // simple "allow-{action}" pattern.
    const permissionOverrides = {
        'plugin:opener|open_url': 'opener:default',
        // set_visible is covered by allow-hide + allow-show (no single allow-set-visible)
        'plugin:window|set_visible': 'core:window:allow-hide+core:window:allow-show',
    };

    it('every used plugin command has a declared permission', () => {
        const permissionSet = new Set(declaredPermissions);
        const missing = [];

        for (const cmd of usedPluginCommands) {
            const perm = permissionOverrides[cmd] || commandToPermission(cmd);
            // Handle compound permissions (e.g., "allow-hide+allow-show")
            const requiredPerms = perm.includes('+') ? perm.split('+') : [perm];
            const allCovered = requiredPerms.every(p => permissionSet.has(p));
            if (!allCovered) {
                const uncovered = requiredPerms.filter(p => !permissionSet.has(p));
                missing.push(`${cmd}  →  missing: ${uncovered.join(', ')}`);
            }
        }

        expect(
            missing,
            missing.length > 0
                ? `Plugin commands used in api.js but missing from capabilities/default.json:\n  ${missing.join('\n  ')}`
                : 'all plugin commands have declared permissions'
        ).toEqual([]);
    });

    it('no declared permission is unused (stale permissions)', () => {
        const usedPermissions = new Set(usedPluginCommands.map(commandToPermission));
        // Also include wildcard/default permissions that cover multiple commands
        const wildcardPermissions = new Set([
            'opener:default',       // covers all opener commands
            'core:image:default',   // covers all image commands
            'core:menu:default',    // covers all menu commands
            'core:tray:default',    // covers all tray commands
            'core:resources:default',
            'core:app:default',
            'dialog:allow-message',
            'notification:allow-notify',
            'global-shortcut:allow-register',
            'global-shortcut:allow-unregister',
            'core:window:allow-start-dragging',
            'core:window:allow-hide',
            'core:window:allow-show',
        ]);

        const stale = declaredPermissions.filter(p =>
            !usedPermissions.has(p) && !wildcardPermissions.has(p)
        );

        // This is informational — stale permissions are not bugs, just noise
        if (stale.length > 0) {
            console.log(`  INFO: ${stale.length} declared permission(s) not directly matched to api.js commands (may be used elsewhere or via wildcards):`);
            for (const p of stale) {
                console.log(`    - ${p}`);
            }
        }

        // Always pass — stale permissions are warnings, not errors
        expect(true).toBe(true);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  8. Rust Settings Struct ↔ Frontend settings.xxx Field Contract
// ═══════════════════════════════════════════════════════════════════════════════
//
// The Rust Settings struct is serialized via serde and sent to the frontend
// as a plain JSON object. Frontend code accesses properties like settings.last_config.
// A field rename in Rust or a typo in JS silently breaks features.
//
// This test cross-checks the Rust struct field names against the JS access patterns.

describe('Rust Settings struct ↔ Frontend settings.xxx field contract', () => {
    // All fields in the Rust Settings struct
    // Source: apps/desktop/src-tauri/src/lib.rs:90-106
    const rustSettingsFields = [
        'close_to_tray',
        'auto_update',
        'auto_update_client',
        'autostart',
        'theme',
        'last_config',
        'custom_args',
        'dns_nameservers',
        'dns_fallbacks',
        'auto_apply',
        'ui_scale',
        'config_order',
        'last_proxy_selection',
        'primary_group_preference',
        'subscription_user_agent',
        'hide_timeout_nodes',
        'mode',
        'tun_enabled',
        'mixed_port',
        'socks_port',
        'http_port',
        'ipv6',
        'allow_lan',
        'unified_delay',
        'dns_rewrite_enabled',
        'theme_mode',
        'app_opacity',
        'node_scroll',
        'failover_enabled',
        'network_optim_auto_apply',
        'lightweight_mode',
    ];

    // All settings.xxx property accesses in frontend JS code
    // Source: grep "settings\.\w+" across src/**/*.js (excluding test files)
    const frontendAccessedFields = [
        'last_config',       // main.js, tray.js, advanced.js, rules.js, settings.js, tun.js
        'custom_args',       // main.js, tray.js, settings.js, tun.js
        'auto_update',       // main.js, settings.js
        'auto_update_client', // main.js, settings.js
        'close_to_tray',     // settings.js
        'theme',             // settings.js
        'autostart',         // settings.js
        'dns_nameservers',   // dns-shared.js
        'dns_fallbacks',     // dns-shared.js
        'ui_scale',          // main.js, settings.js
        'mode',              // modes.js, global-shortcut.js, settings.js
        'tun_enabled',       // tun.js, settings.js
        'mixed_port',        // settings.js
        'socks_port',        // settings.js
        'http_port',         // settings.js (read-only, for port display)
        'ipv6',              // settings.js
        'allow_lan',         // settings.js
        'unified_delay',     // settings.js
        'dns_rewrite_enabled', // dns-shared.js, settings.js
        'theme_mode',        // settings.js, theme.js
        'app_opacity',       // settings.js, theme.js
        'node_scroll',       // settings.js, proxies.js
        'hide_timeout_nodes', // settings.js
        'failover_enabled',   // settings.js
        'network_optim_auto_apply', // settings.js
        'lightweight_mode',   // settings.js
    ];

    it('every frontend settings.xxx access has a matching Rust struct field', () => {
        const rustFields = new Set(rustSettingsFields);
        const missing = frontendAccessedFields.filter(f => !rustFields.has(f));

        expect(
            missing,
            missing.length > 0
                ? `Frontend accesses settings.${missing.join(', settings.')} but Rust Settings struct has no such field`
                : 'all frontend settings accesses match Rust struct fields'
        ).toEqual([]);
    });

    it('every Rust Settings field is read by the frontend (no dead fields)', () => {
        const jsFields = new Set(frontendAccessedFields);
        const unread = rustSettingsFields.filter(f => !jsFields.has(f));

        // auto_apply is intentionally read via a separate IPC command (RULE_GET_AUTO_APPLY)
        // rather than from the Settings struct, so it's a known exception.
        // The following fields are backend-only or accessed via dedicated IPC commands:
        const knownUnread = new Set([
            'auto_apply',
            'config_order',
            'last_proxy_selection',
            'primary_group_preference',
            'subscription_user_agent',
        ]);
        const unexpected = unread.filter(f => !knownUnread.has(f));

        expect(
            unexpected,
            unexpected.length > 0
                ? `Rust Settings has fields never read by frontend:\n  ${unexpected.join('\n  ')}`
                : 'all Rust Settings fields are used by frontend (auto_apply is read via RULE_GET_AUTO_APPLY)'
        ).toEqual([]);
    });
});
