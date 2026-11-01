// @ts-nocheck
// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    trayTestApi as api,
    trayTestMemory as memory,
    trayTestNotifications as notifications,
    trayTestHandlers as handlers,
} from './tray-mocks.js';

const { initTrayEventListeners } = await import('./tray.js');
await initTrayEventListeners();

describe('a node picked in the tray', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        api.switchProxyResult.mockResolvedValue({ ok: true, reason: null, seq: 1 });
        api.isLatestSwitch.mockReturnValue(true);
    });

    it('is remembered for the running profile, so a later restart restores it', async () => {
        api.invoke.mockImplementation(async (cmd) => (cmd === 'get_settings' ? { last_config: 'sub.yaml' } : null));
        await handlers['tray-proxy-changed']({ payload: { group: 'Proxy', proxy: 'Tokyo' } });
        expect(memory.saveProxySelection).toHaveBeenCalledWith('sub.yaml', { node: 'Tokyo', group: 'Proxy' });
    });

    it('is remembered for the profile running when it was picked, even if a profile switch lands meanwhile', async () => {
        let profile = 'old.yaml';
        api.invoke.mockImplementation(async (cmd) => (cmd === 'get_settings' ? { last_config: profile } : null));
        api.switchProxyResult.mockImplementation(async () => { profile = 'new.yaml'; return { ok: true, reason: null, seq: 1 }; });
        await handlers['tray-proxy-changed']({ payload: { group: 'Proxy', proxy: 'Tokyo' } });
        expect(memory.saveProxySelection).toHaveBeenCalledWith('old.yaml', { node: 'Tokyo', group: 'Proxy' });
    });

    it('is not remembered when the switch was refused', async () => {
        api.switchProxyResult.mockResolvedValue({ ok: false, reason: null, seq: 1 });
        api.invoke.mockImplementation(async (cmd) => (cmd === 'get_settings' ? { last_config: 'sub.yaml' } : null));
        await handlers['tray-proxy-changed']({ payload: { group: 'Proxy', proxy: 'Tokyo' } });
        expect(memory.saveProxySelection).not.toHaveBeenCalled();
    });

    it('runs tray clicks in click order, also when the first one\'s profile read is slower', async () => {
        // The first read is held; every later one answers at once.
        /** @type {() => void} */
        let releaseFirst = () => {};
        let held = false;
        api.invoke.mockImplementation((cmd) => {
            if (cmd !== 'get_settings') return Promise.resolve(null);
            if (held) return Promise.resolve({ last_config: 'sub.yaml' });
            held = true;
            return new Promise((resolve) => { releaseFirst = () => resolve({ last_config: 'sub.yaml' }); });
        });
        const first = handlers['tray-proxy-changed']({ payload: { group: 'Proxy', proxy: 'Tokyo' } });
        const second = handlers['tray-proxy-changed']({ payload: { group: 'Proxy', proxy: 'Osaka' } });
        await new Promise((r) => setTimeout(r, 20));
        // The second click waits for the first.
        expect(api.switchProxyResult).not.toHaveBeenCalled();
        releaseFirst();
        await Promise.all([first, second]);
        expect(api.switchProxyResult.mock.calls.map((c) => c[1])).toEqual(['Tokyo', 'Osaka']);
        expect(memory.saveProxySelection.mock.calls.map((c) => c[1].node)).toEqual(['Tokyo', 'Osaka']);
    });

    it('is not remembered when a later switch of the group stands over it', async () => {
        api.isLatestSwitch.mockReturnValue(false);
        api.invoke.mockImplementation(async (cmd) => (cmd === 'get_settings' ? { last_config: 'sub.yaml' } : null));
        await handlers['tray-proxy-changed']({ payload: { group: 'Proxy', proxy: 'Tokyo' } });
        expect(memory.saveProxySelection).not.toHaveBeenCalled();
    });

    it('is not sent when a network change begins while it waits behind another switch', async () => {
        const { appStore } = await import('./state.js');
        api.invoke.mockImplementation(async (cmd) => (cmd === 'get_settings' ? { last_config: 'sub.yaml' } : null));
        let sendable;
        api.switchProxyResult.mockImplementation(async (_g, _n, opts) => {
            // Its turn comes after a mode change began and ended.
            appStore.set('isNetworkUpdating', true);
            await new Promise((r) => setTimeout(r, 0));
            appStore.set('isNetworkUpdating', false);
            await new Promise((r) => setTimeout(r, 0));
            sendable = opts.canSend();
            return sendable ? { ok: true, reason: null, seq: 1 } : { ok: false, reason: api.SWITCH_BUSY, seq: 1 };
        });
        await handlers['tray-proxy-changed']({ payload: { group: 'Proxy', proxy: 'Tokyo' } });
        expect(sendable).toBe(false);
        expect(memory.saveProxySelection).not.toHaveBeenCalled();
        expect(notifications.showNotification).toHaveBeenCalledWith(expect.any(String), 'warning');
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
        expect(api.switchProxyResult).not.toHaveBeenCalled();
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
        expect(api.switchProxyResult).not.toHaveBeenCalled();
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
        // The tray still moves its check mark to the new profile.
        expect(api.getProxies).toHaveBeenCalled();
        const { appStore } = await import('./state.js');
        expect(appStore.get('isNetworkUpdating')).toBe(false);
    });
});
