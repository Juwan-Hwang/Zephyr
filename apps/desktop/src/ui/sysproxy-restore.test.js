// @ts-nocheck
import { describe, it, expect, vi, beforeEach } from 'vitest';

const api = { getConfig: vi.fn(), invoke: vi.fn(async () => false) };
const store = { set: vi.fn(), get: vi.fn() };

vi.mock('../api.js', () => api);
vi.mock('./state.js', () => ({ appStore: store }));
vi.mock('./tray.js', () => ({ updateTrayStatus: vi.fn() }));
vi.mock('./notifications.js', () => ({ showNotification: vi.fn() }));
vi.mock('../i18n.js', () => ({ translations: {}, currentLang: 'en', t: (k) => k }));
vi.mock('../utils/logger.js', () => ({
    sysproxyLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@zephyr/shared', () => ({
    COMMANDS: { RESTORE_SYS_PROXY: 'restore_sys_proxy', GET_SYS_PROXY: 'get_sys_proxy' },
}));

const { restoreSysProxy } = await import('./sysproxy.js');

const restoreCalls = () => api.invoke.mock.calls.filter(([cmd]) => cmd === 'restore_sys_proxy');

describe('restoreSysProxy', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        api.invoke.mockImplementation(async () => false);
    });

    it('restores toward the port the running core listens on', async () => {
        api.getConfig.mockResolvedValue({ 'mixed-port': 7897 });
        await restoreSysProxy();
        expect(restoreCalls()).toEqual([['restore_sys_proxy', { server: '127.0.0.1:7897' }]]);
        expect(store.set).toHaveBeenCalledWith('isSysProxyEnabled', true);
    });

    it('falls back to the legacy http port', async () => {
        api.getConfig.mockResolvedValue({ port: 8080 });
        await restoreSysProxy();
        expect(restoreCalls()).toEqual([['restore_sys_proxy', { server: '127.0.0.1:8080' }]]);
    });

    it('leaves the proxy off when the core has no http listener', async () => {
        api.getConfig.mockResolvedValue({ 'socks-port': 7891 });
        await restoreSysProxy();
        expect(restoreCalls()).toEqual([]);
        expect(store.set).not.toHaveBeenCalledWith('isSysProxyEnabled', true);
    });
});
