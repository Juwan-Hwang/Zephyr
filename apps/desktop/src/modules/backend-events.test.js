import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { listen, clearProviderCache, emit, runtimeDnsReady } = vi.hoisted(() => ({
    listen: vi.fn(), clearProviderCache: vi.fn(), emit: vi.fn(), runtimeDnsReady: vi.fn(),
}));
vi.mock('../api.js', () => ({ listen, clearProviderCache, runtimeDnsReady, isIpcAvailable: () => true }));
vi.mock('../ui/events.js', () => ({ Bus: { emit }, Events: { DIAGNOSTICS_INVALIDATED: 'diagnostics-invalidated', CONFIG_UPDATED: 'config-updated' } }));
vi.mock('../ui/notifications.js', () => ({ showNotification: vi.fn() }));
vi.mock('../utils/logger.js', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));

const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

describe('diagnostics listener registration', () => {
    beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); runtimeDnsReady.mockResolvedValue(null); vi.useFakeTimers(); });
    afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

    it.each([true, false])('reconciles runtime DNS after registration catches up (confirmed=%s)', async (confirmed) => {
        runtimeDnsReady.mockResolvedValue(confirmed);
        listen.mockResolvedValue(async () => {});
        const events = await import('./backend-events.js');
        try {
            await events.initBackendEventListeners();
            await flush();
            expect(emit).toHaveBeenCalledWith('config-updated', { reloaded: confirmed, restoreRuntime: true });
        } finally { events.cleanupBackendEventListeners(); }
    });

    it('does not publish an older readiness read after a new reload event', async () => {
        let finish = (/** @type {boolean} */ _ready) => {};
        let dispatch = (/** @type {any} */ _event) => {};
        runtimeDnsReady.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
        listen.mockImplementation(async (event, handler) => {
            if (event === 'diagnostics-invalidated') dispatch = handler;
            return async () => {};
        });
        const events = await import('./backend-events.js');
        try {
            await events.initBackendEventListeners();
            await flush();
            dispatch({ payload: { reloadUnconfirmed: true } });
            finish(true);
            await flush();
            expect(emit).toHaveBeenCalledWith('config-updated', { reloaded: false, restoreRuntime: true });
            expect(emit).not.toHaveBeenCalledWith('config-updated', { reloaded: true, restoreRuntime: true });
        } finally { finish(true); events.cleanupBackendEventListeners(); }
    });

    it('keeps registration catch-up after a diagnostic-only event', async () => {
        let finish = (/** @type {boolean} */ _ready) => {};
        let dispatch = (/** @type {any} */ _event) => {};
        runtimeDnsReady.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
        listen.mockImplementation(async (event, handler) => {
            if (event === 'diagnostics-invalidated') dispatch = handler;
            return async () => {};
        });
        const events = await import('./backend-events.js');
        try {
            await events.initBackendEventListeners();
            await flush();
            dispatch({ payload: { rulesChanged: false } });
            finish(true);
            await flush();
            expect(emit).toHaveBeenCalledWith('config-updated', { reloaded: true, restoreRuntime: true });
        } finally { finish(true); events.cleanupBackendEventListeners(); }
    });

    it('retries a readiness read invalidated by diagnostic cancellation', async () => {
        let finish = (/** @type {any} */ _error) => {};
        let dispatch = (/** @type {any} */ _event) => {};
        runtimeDnsReady.mockImplementationOnce(() => new Promise((_resolve, reject) => { finish = reject; })).mockResolvedValue(true);
        listen.mockImplementation(async (event, handler) => {
            if (event === 'diagnostics-invalidated') dispatch = handler;
            return async () => {};
        });
        const events = await import('./backend-events.js');
        try {
            await events.initBackendEventListeners();
            await flush();
            dispatch({ payload: { rulesChanged: false } });
            finish(new Error('generation changed'));
            await flush();
            expect(runtimeDnsReady).toHaveBeenCalledTimes(2);
            expect(emit).toHaveBeenCalledWith('config-updated', { reloaded: true, restoreRuntime: true });
        } finally { finish(new Error('cleanup')); events.cleanupBackendEventListeners(); }
    });

    it('restores runtime DNS only for a confirmed background replacement', async () => {
        let dispatch = (/** @type {any} */ _event) => {};
        listen.mockImplementation(async (event, handler) => {
            if (event === 'diagnostics-invalidated') dispatch = handler;
            return async () => {};
        });
        const events = await import('./backend-events.js');
        try {
            await events.initBackendEventListeners();
            await flush();
            emit.mockClear();
            dispatch({ payload: null });
            expect(emit).not.toHaveBeenCalledWith('config-updated', expect.anything());
            dispatch({ payload: { restoreRuntime: true } });
            expect(emit).toHaveBeenCalledWith('config-updated', { reloaded: true });
            dispatch({ payload: { reloadUnconfirmed: true } });
            expect(emit).toHaveBeenCalledWith('config-updated', { reloaded: false, restoreRuntime: true });
            emit.mockClear();
            dispatch({ payload: { rulesChanged: false } });
            expect(emit).toHaveBeenCalledWith('diagnostics-invalidated', { rulesChanged: false });
            expect(emit).not.toHaveBeenCalledWith('config-updated', expect.anything());
            clearProviderCache.mockClear();
            dispatch({ payload: { selectionsPreserved: true } });
            expect(clearProviderCache).toHaveBeenCalledWith({ selectionsPreserved: true });
            expect(emit).not.toHaveBeenCalledWith('config-updated', expect.anything());
            clearProviderCache.mockClear();
            dispatch({ payload: { selectionsPreserved: true, reloadUnconfirmed: true } });
            expect(clearProviderCache).toHaveBeenCalledWith();
        } finally { events.cleanupBackendEventListeners(); }
    });

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
