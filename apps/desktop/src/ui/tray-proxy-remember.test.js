// @ts-nocheck
// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';

const handlers = {};
const api = {
    getConfig: vi.fn(async () => ({})),
    invoke: vi.fn(),
    getProxies: vi.fn(async () => ({ proxies: {} })),
    switchProxy: vi.fn(async () => true),
    closeAllConnections: vi.fn(async () => {}),
    listen: vi.fn(async (name, fn) => { handlers[name] = fn; return () => {}; }),
};
const memory = { saveProxySelection: vi.fn(async () => {}) };

vi.mock('../api.js', () => api);
vi.mock('./proxy-memory.js', () => memory);
vi.mock('./lifecycle.js', () => ({ switchToConfig: vi.fn() }));
const notifications = { showNotification: vi.fn() };
vi.mock('./notifications.js', () => notifications);
vi.mock('./proxies.js', () => ({ syncCoreConfig: vi.fn(async () => {}), refreshProxies: vi.fn(async () => {}) }));
vi.mock('../utils/logger.js', () => {
    const log = () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });
    return { trayLogger: log(), createLogger: log, apiLogger: log(), settingsLogger: log() };
});
vi.mock('./cache.js', () => ({ trayMenuCache: {}, TRAY_CACHE_TTL: 0, invalidateProxiesCache: vi.fn() }));
vi.mock('./run-config-cache.js', () => ({ invalidateRunConfigCache: vi.fn() }));
vi.mock('@zephyr/shared', () => ({ COMMANDS: { GET_SETTINGS: 'get_settings', UPDATE_TRAY_MENU: 'update_tray_menu' } }));

const { initTrayEventListeners } = await import('./tray.js');
await initTrayEventListeners();

describe('a node picked in the tray', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        api.switchProxy.mockResolvedValue(true);
    });

    it('is remembered for the running profile, so a later restart restores it', async () => {
        api.invoke.mockImplementation(async (cmd) => (cmd === 'get_settings' ? { last_config: 'sub.yaml' } : null));
        await handlers['tray-proxy-changed']({ payload: { group: 'Proxy', proxy: 'Tokyo' } });
        expect(memory.saveProxySelection).toHaveBeenCalledWith('sub.yaml', { node: 'Tokyo', group: 'Proxy' });
    });

    it('is remembered for the profile running when it was picked, even if a profile switch lands meanwhile', async () => {
        let profile = 'old.yaml';
        api.invoke.mockImplementation(async (cmd) => (cmd === 'get_settings' ? { last_config: profile } : null));
        api.switchProxy.mockImplementation(async () => { profile = 'new.yaml'; return true; });
        await handlers['tray-proxy-changed']({ payload: { group: 'Proxy', proxy: 'Tokyo' } });
        expect(memory.saveProxySelection).toHaveBeenCalledWith('old.yaml', { node: 'Tokyo', group: 'Proxy' });
    });

    it('is not remembered when the switch was refused', async () => {
        api.switchProxy.mockResolvedValue(false);
        api.invoke.mockImplementation(async (cmd) => (cmd === 'get_settings' ? { last_config: 'sub.yaml' } : null));
        await handlers['tray-proxy-changed']({ payload: { group: 'Proxy', proxy: 'Tokyo' } });
        expect(memory.saveProxySelection).not.toHaveBeenCalled();
    });

    it('is refused while another network change runs, as the node cards refuse it', async () => {
        const { appStore } = await import('./state.js');
        api.invoke.mockImplementation(async (cmd) => (cmd === 'get_settings' ? { last_config: 'sub.yaml' } : null));
        appStore.set('isNetworkUpdating', true);
        try {
            await handlers['tray-proxy-changed']({ payload: { group: 'Proxy', proxy: 'Tokyo' } });
        } finally {
            appStore.set('isNetworkUpdating', false);
        }
        expect(api.switchProxy).not.toHaveBeenCalled();
        expect(memory.saveProxySelection).not.toHaveBeenCalled();
        expect(notifications.showNotification).toHaveBeenCalledWith(expect.any(String), 'warning');
    });

    it('is refused when another network change starts while the profile is read', async () => {
        const { appStore } = await import('./state.js');
        api.invoke.mockImplementation(async (cmd) => {
            if (cmd !== 'get_settings') return null;
            appStore.set('isNetworkUpdating', true);
            return { last_config: 'sub.yaml' };
        });
        try {
            await handlers['tray-proxy-changed']({ payload: { group: 'Proxy', proxy: 'Tokyo' } });
        } finally {
            appStore.set('isNetworkUpdating', false);
        }
        expect(api.switchProxy).not.toHaveBeenCalled();
        expect(memory.saveProxySelection).not.toHaveBeenCalled();
    });
});

describe('a profile picked in the tray', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('is not reported as failed when only the refresh after the switch fails', async () => {
        const lifecycle = await import('./lifecycle.js');
        lifecycle.switchToConfig.mockResolvedValue({ fallbackOccurred: false });
        const proxies = await import('./proxies.js');
        proxies.syncCoreConfig.mockRejectedValueOnce(new Error('core busy'));
        api.invoke.mockImplementation(async (cmd) => (cmd === 'get_settings' ? { last_config: 'old.yaml', custom_args: [] } : null));
        await handlers['tray-subscription-changed']({ payload: 'new.yaml' });
        expect(lifecycle.switchToConfig).toHaveBeenCalledWith('new.yaml', []);
        expect(notifications.showNotification).toHaveBeenCalledWith(expect.stringContaining('new.yaml'), 'info');
        expect(notifications.showNotification).not.toHaveBeenCalledWith(expect.anything(), 'error');
        const { appStore } = await import('./state.js');
        expect(appStore.get('isNetworkUpdating')).toBe(false);
    });
});
