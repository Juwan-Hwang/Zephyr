import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { listen, clearProviderCache, emit } = vi.hoisted(() => ({
    listen: vi.fn(), clearProviderCache: vi.fn(), emit: vi.fn(),
}));
vi.mock('../api.js', () => ({ listen, clearProviderCache, isIpcAvailable: () => true }));
vi.mock('../ui/events.js', () => ({ Bus: { emit }, Events: { DIAGNOSTICS_INVALIDATED: 'diagnostics-invalidated' } }));
vi.mock('../ui/notifications.js', () => ({ showNotification: vi.fn() }));
vi.mock('../utils/logger.js', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));

const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

describe('diagnostics listener registration', () => {
    beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); vi.useFakeTimers(); });
    afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

    it('bounds pending callbacks and invalidates caches after a late successful first registration', async () => {
        /** @type {(value: () => Promise<void>) => void} */
        let registered = () => {};
        listen.mockImplementation(async (event) => event === 'diagnostics-invalidated'
            ? new Promise((resolve) => { registered = resolve; }) : async () => {});
        const events = await import('./backend-events.js');
        await events.initBackendEventListeners();
        await vi.advanceTimersByTimeAsync(60_000);
        await events.initBackendEventListeners();
        expect(listen.mock.calls.filter(([event]) => event === 'diagnostics-invalidated')).toHaveLength(1);
        registered(async () => {});
        await flush();
        expect(clearProviderCache).toHaveBeenCalledOnce();
        expect(emit).toHaveBeenCalledWith('diagnostics-invalidated');
        events.cleanupBackendEventListeners();
    });

    it('removes a registration that completes after cleanup instead of installing it', async () => {
        /** @type {(value: () => Promise<void>) => void} */
        let registered = () => {};
        const unlisten = vi.fn(async () => {});
        listen.mockImplementation(async (event) => event === 'diagnostics-invalidated'
            ? new Promise((resolve) => { registered = resolve; }) : async () => {});
        const events = await import('./backend-events.js');
        await events.initBackendEventListeners();
        events.cleanupBackendEventListeners();
        registered(unlisten);
        await flush();
        expect(unlisten).toHaveBeenCalledOnce();
        expect(clearProviderCache).not.toHaveBeenCalled();
        expect(emit).not.toHaveBeenCalled();
    });
});
