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

const { withPageBusy, restartedProfile } = await import('./lifecycle.js');

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

    it('refuses to restart over another operation holding the lock, and leaves its lock alone', async () => {
        store.set('isNetworkUpdating', true);
        const fn = vi.fn(async () => {});
        await expect(withPageBusy(fn)).rejects.toThrow('Another network change is in progress');
        expect(fn).not.toHaveBeenCalled();
        expect(store.get('isNetworkUpdating')).toBe(true);
        store.set('isNetworkUpdating', false);
    });

    it('hands back what the work returns', async () => {
        store.set('isNetworkUpdating', false);
        expect(await withPageBusy(async () => ({ failed: 2 }))).toEqual({ failed: 2 });
    });
});

describe('restartedProfile', () => {
    it('recovers the profile the restart loaded, not the one asked for', () => {
        expect(restartedProfile({ active_config: 'b.yaml' }, 'a.yaml')).toBe('b.yaml');
        // The minimal config: nothing saved to restore.
        expect(restartedProfile({ active_config: null }, 'a.yaml')).toBe('');
        // An older backend that does not say.
        expect(restartedProfile({}, 'a.yaml')).toBe('a.yaml');
        expect(restartedProfile(undefined, 'a.yaml')).toBe('a.yaml');
    });
});
