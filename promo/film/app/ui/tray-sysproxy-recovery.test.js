// @ts-nocheck
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const api = { getConfig: vi.fn(), invoke: vi.fn(), getProxies: vi.fn(), switchProxy: vi.fn(), closeAllConnections: vi.fn(), listen: vi.fn() };
const sysproxy = { restoreSysProxy: vi.fn(async () => {}) };

vi.mock('../api.js', () => api);
vi.mock('./sysproxy.js', () => sysproxy);
vi.mock('./lifecycle.js', () => ({ switchToConfig: vi.fn() }));
vi.mock('./notifications.js', () => ({ showNotification: vi.fn() }));
vi.mock('../utils/logger.js', () => {
    const log = () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });
    return { trayLogger: log(), createLogger: log, apiLogger: log(), settingsLogger: log() };
});
vi.mock('./cache.js', () => ({ trayMenuCache: {}, TRAY_CACHE_TTL: 0, invalidateProxiesCache: vi.fn() }));
vi.mock('./run-config-cache.js', () => ({ invalidateRunConfigCache: vi.fn() }));
vi.mock('@zephyr/shared', () => ({ COMMANDS: { GET_SYS_PROXY: 'get_sys_proxy', HAS_SYSPROXY_OWNERSHIP: 'has_sysproxy_ownership', GET_TRAY_STATUS: 'get_tray_status' } }));

const { startUnifiedSync, stopUnifiedSync } = await import('./tray.js');

const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); };

describe('system proxy recovery at startup', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        api.invoke.mockImplementation(async (cmd) => ({ get_sys_proxy: false, has_sysproxy_ownership: true, get_tray_status: 'default' })[cmd]);
    });
    afterEach(() => stopUnifiedSync());

    it('puts an owned system proxy back once the core answers', async () => {
        api.getConfig.mockResolvedValue({});
        startUnifiedSync();
        await flush();
        expect(sysproxy.restoreSysProxy).toHaveBeenCalledTimes(1);
    });

    it('leaves it off while the core does not answer', async () => {
        api.getConfig.mockRejectedValue(new Error('connection refused'));
        startUnifiedSync();
        await flush();
        expect(sysproxy.restoreSysProxy).not.toHaveBeenCalled();
    });
});
