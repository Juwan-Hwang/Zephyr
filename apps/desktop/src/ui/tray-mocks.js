// @ts-nocheck
// Shared stubs for tests that import `./tray.js`.
//
// tray.js pulls Tauri IPC and app state in at module load, so tests import
// it behind these mocks. The block lives in one place: copying it per test
// file trips the duplication gate, and stubs that drift between files make
// failures depend on which test file ran. Importing this module registers
// the mocks; the mocked modules are loaded lazily when the test imports
// `./tray.js` afterwards.
import { vi } from 'vitest';

/** Captured `listen` handlers, keyed by event name. */
export const trayTestHandlers = {};

export const trayTestApi = {
    getConfig: vi.fn(async () => ({})),
    invoke: vi.fn(),
    getProxies: vi.fn(async () => ({ proxies: {} })),
    // Runs the caller's `prepare` as the real queue does, so what tray.js
    // records there (the core it sends to) is set in the default case.
    switchProxyResult: vi.fn(async (_group, _node, options) => {
        const prepared = await options?.prepare?.();
        return { ok: true, reason: null, seq: 1, prepared };
    }),
    isLatestSwitch: vi.fn(() => true),
    coreReplacements: vi.fn(() => 0),
    SWITCH_BUSY: 'busy',
    closeAllConnections: vi.fn(async () => {}),
    listen: vi.fn(async (name, fn) => { trayTestHandlers[name] = fn; return () => {}; }),
};

export const trayTestMemory = { saveProxySelection: vi.fn(async () => {}) };

export const trayTestNotifications = { showNotification: vi.fn() };

vi.mock('../api.js', () => trayTestApi);
vi.mock('./proxy-memory.js', () => trayTestMemory);
vi.mock('./lifecycle.js', () => ({ switchToConfig: vi.fn() }));
vi.mock('./notifications.js', () => trayTestNotifications);
vi.mock('./proxies.js', () => ({ syncCoreConfig: vi.fn(async () => {}), refreshProxies: vi.fn(async () => {}) }));
vi.mock('../utils/logger.js', () => {
    const log = () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });
    return { trayLogger: log(), createLogger: log, apiLogger: log(), settingsLogger: log() };
});
vi.mock('./cache.js', () => ({ trayMenuCache: {}, TRAY_CACHE_TTL: 0, invalidateProxiesCache: vi.fn() }));
vi.mock('./run-config-cache.js', () => ({ invalidateRunConfigCache: vi.fn() }));
vi.mock('@zephyr/shared', () => ({ COMMANDS: {
    GET_SETTINGS: 'get_settings',
    LIST_CONFIGS: 'list_configs',
    UPDATE_TRAY_MENU: 'update_tray_menu',
    UPDATE_TRAY_FULL_MENU: 'update_tray_full_menu',
} }));
