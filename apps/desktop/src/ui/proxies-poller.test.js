import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Mock all proxies.js dependencies ──────────────────────────────────────
// The poller only uses: getProxies (api), getConfigCached + invalidateProxiesCache
// (cache), fetchProxyGroupsShared (proxy-groups).  All other imports are mocked
// as no-ops so the module loads cleanly.

vi.mock('../api.js', () => ({
    switchProxy: vi.fn(),
    testProxy: vi.fn(),
    abortLatencyTests: vi.fn(),
    closeAllConnections: vi.fn(),
    getConfig: vi.fn().mockResolvedValue({ mode: 'rule' }),
    invoke: vi.fn(),
    getLatencyTestSignal: vi.fn(),
    resetLatencyTestController: vi.fn(),
    restartCore: vi.fn(),
    getProxies: vi.fn(),
}));

vi.mock('../utils/logger.js', () => ({ proxyLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../utils/sanitize.js', () => ({ escapeHtml: vi.fn(s => s) }));
vi.mock('../utils/format.js', () => ({ getDelayColorClass: vi.fn(() => '') }));
vi.mock('../utils/array.js', () => ({ buildLatencyPriorityQueue: vi.fn(() => []) }));
vi.mock('../utils/debounce.js', () => ({ debounce: vi.fn(fn => fn) }));
vi.mock('../i18n.js', () => ({
    translations: { en: {}, zh: {} },
    currentLang: 'en',
    t: { loadingNodes: 'Loading…', noGroupsFound: 'No groups', providerPollExhausted: 'Exhausted', retry: 'Retry' },
}));
vi.mock('./notifications.js', () => ({ showNotification: vi.fn() }));
vi.mock('./icons.js', () => ({ SVG_ICONS: { loading: '' } }));
vi.mock('./3d-effect.js', () => ({ setup3DEffect: vi.fn() }));
vi.mock('../utils/roving-tabindex.js', () => ({ createRovingTabindex: vi.fn(() => ({ destroy: vi.fn() })) }));
vi.mock('@zephyr/shared', () => ({ COMMANDS: {} }));
vi.mock('./cache.js', () => ({
    getConfigCached: vi.fn(),
    getProxiesCached: vi.fn(),
    getSettingsCached: vi.fn(),
    invalidateProxiesCache: vi.fn(),
}));
vi.mock('./state.js', () => ({ appStore: { get: vi.fn(), set: vi.fn(), subscribe: vi.fn() } }));
vi.mock('./prism.js', () => ({
    smartScore: vi.fn(), smartNextInterval: vi.fn(), smartSelectBest: vi.fn(),
    smartRank: vi.fn(), smartConfig: vi.fn(), failoverReport: vi.fn(),
}));
vi.mock('./proxy-groups.js', () => ({
    fetchProxyGroups: vi.fn(),
    isWritableGroupType: vi.fn(() => true),
}));
vi.mock('./events.js', () => ({
    Bus: { on: vi.fn(), off: vi.fn(), emit: vi.fn(), offAll: vi.fn() },
    Events: {},
}));
vi.mock('./proxy-memory.js', () => ({
    saveProxySelection: vi.fn(),
    savePrimaryGroupPreference: vi.fn(),
}));
vi.mock('./run-config-cache.js', () => ({ invalidateRunConfigCache: vi.fn() }));
vi.mock('./lifecycle.js', () => ({ postRestartRecovery: vi.fn() }));
vi.mock('./observed-group.js', () => ({
    startObservedGroupWatcher: vi.fn(),
    stopObservedGroupWatcher: vi.fn(),
    resetObservedGroup: vi.fn(),
}));
vi.mock('./navigation.js', () => ({ switchPage: vi.fn() }));

// Import after mocks are set up
import { getProxies } from '../api.js';
import { getConfigCached, invalidateProxiesCache } from './cache.js';
import { fetchProxyGroups } from './proxy-groups.js';
import { startProviderPoll, stopProviderPoll } from './proxies.js';

describe('Provider poller state machine', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        stopProviderPoll(); // Reset all poller state
    });

    afterEach(() => {
        stopProviderPoll();
        vi.useRealTimers();
    });

    // ─── Cancellation ───────────────────────────────────────────────────
    describe('cancellation', () => {
        it('stopProviderPoll prevents scheduled timer callback from executing', () => {
            vi.useFakeTimers();

            startProviderPoll('MyGroup', 'MyGroup', 0);
            stopProviderPoll();

            vi.advanceTimersByTime(5000);

            expect(getProxies).not.toHaveBeenCalled();
        });

        it('stopProviderPoll during in-flight await prevents stale update', async () => {
            vi.useFakeTimers();

            // Make getProxies return a promise that we control
            let resolveGetProxies;
            getProxies.mockReturnValue(new Promise(r => { resolveGetProxies = r; }));

            startProviderPoll('MyGroup', 'MyGroup', 0);
            vi.advanceTimersByTime(1500); // Fire the timer

            // getProxies is now in-flight — cancel while awaiting
            stopProviderPoll();

            // Resolve the in-flight promise — should be ignored due to generation check
            resolveGetProxies({ proxies: { MyGroup: { type: 'Selector', all: ['n1'] } } });
            await vi.advanceTimersByTimeAsync(100);

            expect(invalidateProxiesCache).not.toHaveBeenCalled();
        });
    });

    // ─── Success ────────────────────────────────────────────────────────
    describe('successful node delivery', () => {
        it('calls invalidateProxiesCache when nodes arrive during polling', async () => {
            vi.useFakeTimers();

            const proxyData = { proxies: { MyGroup: { type: 'Selector', all: ['n1', 'n2'] }, n1: { type: 'Shadowsocks' }, n2: { type: 'Shadowsocks' } } };
            getProxies.mockResolvedValue(proxyData);
            getConfigCached.mockResolvedValue({ mode: 'rule' });
            fetchProxyGroups.mockResolvedValue({
                proxies: ['n1', 'n2'],
                providerLoading: false,
                uiGroupName: 'MyGroup',
            });

            startProviderPoll('MyGroup', 'MyGroup', 0);
            await vi.advanceTimersByTimeAsync(1500);

            expect(getProxies).toHaveBeenCalledTimes(1);
            expect(getConfigCached).toHaveBeenCalledTimes(1);
            expect(fetchProxyGroups).toHaveBeenCalledTimes(1);
            expect(invalidateProxiesCache).toHaveBeenCalledTimes(1);
        });

        it('retries when fetchProxyGroups returns empty proxies', async () => {
            vi.useFakeTimers();

            getProxies.mockResolvedValue({ proxies: { MyGroup: { type: 'Selector', all: [] } } });
            getConfigCached.mockResolvedValue({ mode: 'rule' });
            fetchProxyGroups.mockResolvedValue({
                proxies: [],
                providerLoading: true,
                uiGroupName: 'MyGroup',
            });

            startProviderPoll('MyGroup', 'MyGroup', 0);
            await vi.advanceTimersByTimeAsync(1500);

            // After first poll with empty result, it should schedule another attempt
            // Verify by checking that getProxies was called once and a new timer is set
            expect(getProxies).toHaveBeenCalledTimes(1);

            // Advance to the next poll
            await vi.advanceTimersByTimeAsync(1500);
            expect(getProxies).toHaveBeenCalledTimes(2);
        });
    });

    // ─── Missing node details ─────────────────────────────────────────
    describe('missing node details', () => {
        it('retries when proxy names exist in all[] but details missing from data.proxies', async () => {
            vi.useFakeTimers();

            // Group has nodes in all[], but data.proxies doesn't have their details
            // (mihomo half-updated state)
            getProxies.mockResolvedValue({ proxies: { MyGroup: { type: 'Selector', all: ['n1', 'n2'] } } });
            getConfigCached.mockResolvedValue({ mode: 'rule' });
            fetchProxyGroups.mockResolvedValue({
                proxies: ['n1', 'n2'],
                providerLoading: false,
                uiGroupName: 'MyGroup',
            });

            startProviderPoll('MyGroup', 'MyGroup', 0);
            await vi.advanceTimersByTimeAsync(1500);

            // Should NOT call invalidateProxiesCache — nodes are still missing details
            expect(invalidateProxiesCache).not.toHaveBeenCalled();
            // Should retry — schedule next poll
            expect(getProxies).toHaveBeenCalledTimes(1);

            await vi.advanceTimersByTimeAsync(1500);
            expect(getProxies).toHaveBeenCalledTimes(2);
        });
    });


    // ─── Exhaustion ─────────────────────────────────────────────────────
    describe('exhaustion after max retries', () => {
        it('stops polling after PROVIDER_POLL_MAX attempts', async () => {
            vi.useFakeTimers();

            // Always return empty — simulate provider that never loads
            getProxies.mockResolvedValue({ proxies: { MyGroup: { type: 'Selector', all: [] } } });
            getConfigCached.mockResolvedValue({ mode: 'rule' });
            fetchProxyGroups.mockResolvedValue({
                proxies: [],
                providerLoading: true,
                uiGroupName: 'MyGroup',
            });

            startProviderPoll('MyGroup', 'MyGroup', 0);

            // Advance through 20 poll cycles (PROVIDER_POLL_MAX = 20)
            for (let i = 0; i < 20; i++) {
                await vi.advanceTimersByTimeAsync(1500);
            }

            // After exhaustion, no more polls should be scheduled
            const callsAfterExhaustion = getProxies.mock.calls.length;
            await vi.advanceTimersByTimeAsync(5000);
            expect(getProxies.mock.calls.length).toBe(callsAfterExhaustion);
        });

        it('handles malformed response as retryable', async () => {
            vi.useFakeTimers();

            getProxies.mockResolvedValue(null); // Malformed response
            getConfigCached.mockResolvedValue({ mode: 'rule' });

            startProviderPoll('MyGroup', 'MyGroup', 0);
            await vi.advanceTimersByTimeAsync(1500);

            // Should have retried — schedule next poll
            expect(getProxies).toHaveBeenCalledTimes(1);

            await vi.advanceTimersByTimeAsync(1500);
            expect(getProxies).toHaveBeenCalledTimes(2);
        });
    });

    // ─── Network error recovery ─────────────────────────────────────────
    describe('network error handling', () => {
        it('retries on network error', async () => {
            vi.useFakeTimers();

            getProxies.mockRejectedValue(new Error('Network error'));
            getConfigCached.mockResolvedValue({ mode: 'rule' });

            startProviderPoll('MyGroup', 'MyGroup', 0);
            await vi.advanceTimersByTimeAsync(1500);

            // Should retry despite the error
            expect(getProxies).toHaveBeenCalledTimes(1);

            await vi.advanceTimersByTimeAsync(1500);
            expect(getProxies).toHaveBeenCalledTimes(2);
        });
    });

    // ─── stopProviderPoll state cleanup ─────────────────────────────────
    describe('stopProviderPoll cleanup', () => {
        it('can be called multiple times without error', () => {
            expect(() => {
                stopProviderPoll();
                stopProviderPoll();
                stopProviderPoll();
            }).not.toThrow();
        });

        it('allows starting a new poll after stop', async () => {
            vi.useFakeTimers();

            getProxies.mockResolvedValue({ proxies: { G: { type: 'Selector', all: ['n1'] }, n1: { type: 'Shadowsocks' } } });
            getConfigCached.mockResolvedValue({ mode: 'rule' });
            fetchProxyGroups.mockResolvedValue({ proxies: ['n1'], providerLoading: false });

            startProviderPoll('G', 'G', 0);
            vi.advanceTimersByTime(1000); // Before timer fires
            stopProviderPoll();

            // Start fresh
            startProviderPoll('G', 'G', 0);
            await vi.advanceTimersByTimeAsync(1500);

            expect(getProxies).toHaveBeenCalled();
            expect(invalidateProxiesCache).toHaveBeenCalled();
        });
    });
});
