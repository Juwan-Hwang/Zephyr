// @ts-nocheck
import { describe, it, expect, vi } from 'vitest';

const store = new Map();
vi.mock('../api.js', () => ({ abortLatencyTests: vi.fn(), closeAllConnections: vi.fn(), restartCore: vi.fn(), invoke: vi.fn() }));
vi.mock('@zephyr/shared', () => ({ COMMANDS: {} }));
vi.mock('./state.js', () => ({ appStore: { get: (k) => store.get(k), set: (k, v) => store.set(k, v) } }));
vi.mock('./cache.js', () => ({ invalidateSettingsCache: vi.fn(), invalidateProxiesCache: vi.fn(), invalidateConfigCache: vi.fn() }));
vi.mock('./run-config-cache.js', () => ({ invalidateRunConfigCache: vi.fn() }));
vi.mock('../utils/logger.js', () => ({ apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('./notifications.js', () => ({ showNotification: vi.fn() }));
vi.mock('../i18n.js', () => ({ t: (_k, fb) => fb }));

const { withPageBusy } = await import('./lifecycle.js');

describe('withPageBusy', () => {
    it('holds the network lock while the work runs and releases it after, even on failure', async () => {
        store.set('isNetworkUpdating', false);
        let during;
        await withPageBusy(async () => { during = store.get('isNetworkUpdating'); });
        expect(during).toBe(true);
        expect(store.get('isNetworkUpdating')).toBe(false);
        await expect(withPageBusy(async () => { throw new Error('restart failed'); })).rejects.toThrow('restart failed');
        expect(store.get('isNetworkUpdating')).toBe(false);
    });

    it('leaves a lock another operation holds to that operation', async () => {
        store.set('isNetworkUpdating', true);
        await withPageBusy(async () => {});
        expect(store.get('isNetworkUpdating')).toBe(true);
    });
});
