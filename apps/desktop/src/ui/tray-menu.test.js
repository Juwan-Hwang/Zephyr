// @ts-check
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { trayTestApi as api } from './tray-mocks.js';

const { updateTrayMenu } = await import('./tray.js');
const { trayMenuCache } = await import('./cache.js');

function deferred() {
    /** @type {(value: any) => void} */
    let resolve = () => {};
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
}

const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

describe('tray menu refresh ordering', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        api.getConfig.mockResolvedValue({ mode: 'rule' });
        api.getProxies.mockResolvedValue({ proxies: {} });
    });

    it('ignores an older read after a newer refresh updated the menu', async () => {
        const oldSettings = deferred();
        let reads = 0;
        api.invoke.mockImplementation(async (cmd) => {
            if (cmd === 'list_configs') return [{ name: 'old.yaml' }, { name: 'new.yaml' }];
            if (cmd === 'get_settings') return reads++ === 0 ? oldSettings.promise : { last_config: 'new.yaml' };
            return null;
        });
        const first = updateTrayMenu(true);
        await updateTrayMenu(true);
        oldSettings.resolve({ last_config: 'old.yaml' });
        await first;
        const writes = api.invoke.mock.calls.filter(([cmd]) => cmd === 'update_tray_full_menu');
        expect(writes).toHaveLength(1);
        expect(writes[0][1].params.configs.find((/** @type {any} */ c) => c.is_active)?.name).toBe('new.yaml');
        expect(trayMenuCache.configs.find((/** @type {any} */ c) => c.is_active)?.name).toBe('new.yaml');
    });

    it('waits for an already dispatched native write before dispatching the newer one', async () => {
        const oldWrite = deferred();
        let profile = 'old.yaml';
        api.invoke.mockImplementation(async (cmd, args) => {
            if (cmd === 'list_configs') return [{ name: 'old.yaml' }, { name: 'new.yaml' }];
            if (cmd === 'get_settings') return { last_config: profile };
            if (cmd === 'update_tray_full_menu' && args.params.configs[0].is_active) return oldWrite.promise;
            return null;
        });
        const first = updateTrayMenu(true);
        await flush();
        profile = 'new.yaml';
        const second = updateTrayMenu(true);
        await flush();
        expect(api.invoke.mock.calls.filter(([cmd]) => cmd === 'update_tray_full_menu')).toHaveLength(1);
        oldWrite.resolve(null);
        await Promise.all([first, second]);
        const writes = api.invoke.mock.calls.filter(([cmd]) => cmd === 'update_tray_full_menu');
        expect(writes).toHaveLength(2);
        expect(writes[1][1].params.configs[1].is_active).toBe(true);
    });
});
