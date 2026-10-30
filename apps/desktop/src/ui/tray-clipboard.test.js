// @ts-nocheck
// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

const { copyToClipboard } = await import('./tray.js');

describe('copyToClipboard', () => {
    let originalClipboard;
    let execCommandSpy;

    beforeEach(() => {
        vi.useFakeTimers();
        originalClipboard = navigator.clipboard;
        // happy-dom has no execCommand; provide one so the fallback path
        // can be observed.
        document.execCommand = vi.fn().mockReturnValue(true);
        execCommandSpy = document.execCommand;
    });

    afterEach(() => {
        vi.useRealTimers();
        delete document.execCommand;
        Object.defineProperty(navigator, 'clipboard', {
            value: originalClipboard,
            configurable: true,
            writable: true,
        });
    });

    function mockClipboard(writeTextImpl) {
        Object.defineProperty(navigator, 'clipboard', {
            value: { writeText: vi.fn(writeTextImpl) },
            configurable: true,
            writable: true,
        });
        return navigator.clipboard.writeText;
    }

    it('uses writeText when it resolves', async () => {
        const writeText = mockClipboard(async () => {});
        await copyToClipboard('hello');
        expect(writeText).toHaveBeenCalledWith('hello');
        expect(execCommandSpy).not.toHaveBeenCalled();
    });

    it('falls back to the textarea path when writeText rejects', async () => {
        mockClipboard(async () => { throw new Error('denied'); });
        await copyToClipboard('hello');
        expect(execCommandSpy).toHaveBeenCalledWith('copy');
    });

    it('falls back instead of hanging when writeText never settles', async () => {
        const writeText = mockClipboard(() => new Promise(() => {}));
        const promise = copyToClipboard('hello');
        await vi.advanceTimersByTimeAsync(5000);
        await promise;
        expect(writeText).toHaveBeenCalledWith('hello');
        expect(execCommandSpy).toHaveBeenCalledWith('copy');
    });
});
