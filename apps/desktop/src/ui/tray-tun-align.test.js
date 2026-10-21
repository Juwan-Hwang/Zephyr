// @ts-nocheck
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const api = { getConfig: vi.fn(async () => ({})), invoke: vi.fn(), getProxies: vi.fn(), switchProxy: vi.fn(), closeAllConnections: vi.fn(), listen: vi.fn() };

vi.mock('../api.js', () => api);
vi.mock('./sysproxy.js', () => ({ restoreSysProxy: vi.fn(async () => {}), refreshSysProxyStatus: vi.fn(async () => {}) }));
vi.mock('./lifecycle.js', () => ({ switchToConfig: vi.fn() }));
vi.mock('./notifications.js', () => ({ showNotification: vi.fn() }));
vi.mock('../utils/logger.js', () => {
    const log = () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });
    return { trayLogger: log(), createLogger: log, apiLogger: log(), settingsLogger: log() };
});
vi.mock('./cache.js', () => ({ trayMenuCache: {}, TRAY_CACHE_TTL: 0, invalidateProxiesCache: vi.fn() }));
vi.mock('./run-config-cache.js', () => ({ invalidateRunConfigCache: vi.fn() }));
vi.mock('@zephyr/shared', () => ({
    COMMANDS: {
        GET_SYS_PROXY: 'get_sys_proxy',
        HAS_SYSPROXY_OWNERSHIP: 'has_sysproxy_ownership',
        GET_TRAY_PROXY_STATUS: 'get_tray_proxy_status',
        GET_TRAY_ICON_MODE: 'get_tray_icon_mode',
        GET_SETTINGS: 'get_settings',
        IS_PROCESS_ELEVATED: 'is_process_elevated',
        CORE: { READ_CONFIG: 'read_config' },
    },
}));

const { startUnifiedSync, stopUnifiedSync } = await import('./tray.js');
const { appStore } = await import('./state.js');

const realUa = navigator.userAgent;
const setUa = (ua) => Object.defineProperty(navigator, 'userAgent', { value: ua, configurable: true });

async function tick() {
    await vi.advanceTimersByTimeAsync(10000);
    for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe('TUN switch while the core is stopped', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.clearAllMocks();
        appStore.set('isNetworkUpdating', false);
        appStore.set('isTunEnabled', true);
    });
    afterEach(() => {
        stopUnifiedSync();
        vi.useRealTimers();
        setUa(realUa);
    });

    const backend = (elevated) => async (cmd) => ({
        get_sys_proxy: false,
        has_sysproxy_ownership: false,
        get_tray_proxy_status: 'stopped',
        get_tray_icon_mode: 'default',
        get_settings: { tun_enabled: true },
        is_process_elevated: elevated,
    })[cmd];

    it('shows TUN off on Windows when this process is not elevated', async () => {
        setUa('Mozilla/5.0 (Windows NT 10.0; Win64; x64)');
        api.invoke.mockImplementation(backend(false));
        startUnifiedSync();
        await tick();
        expect(appStore.get('isTunEnabled')).toBe(false);
    });

    it('keeps the saved preference when elevated', async () => {
        setUa('Mozilla/5.0 (Windows NT 10.0; Win64; x64)');
        api.invoke.mockImplementation(backend(true));
        startUnifiedSync();
        await tick();
        expect(appStore.get('isTunEnabled')).toBe(true);
    });

    it('does not ask about elevation off Windows', async () => {
        setUa('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)');
        api.invoke.mockImplementation(backend(false));
        startUnifiedSync();
        await tick();
        expect(appStore.get('isTunEnabled')).toBe(true);
        expect(api.invoke).not.toHaveBeenCalledWith('is_process_elevated');
    });
});
