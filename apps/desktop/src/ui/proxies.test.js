import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Tests for proxies.js: the provider poller and the failover switch.

// ─── Mock all proxies.js dependencies ──────────────────────────────────────
// The tests drive the poller and handleFailoverAction through the mocks below;
// all other imports are mocked as no-ops so the module loads cleanly.

// NOTE: Can't use importOriginal() because it loads the real api.js module graph
// (websocket.js, events.js, etc.) which requires logger exports not mocked here.
vi.mock('../api.js', () => ({
    testProxy: vi.fn(),
    abortLatencyTests: vi.fn(),
    closeAllConnections: vi.fn(),
    getConfig: vi.fn().mockResolvedValue({ mode: 'rule' }),
    invoke: vi.fn(),
    getLatencyTestSignal: vi.fn(),
    resetLatencyTestController: vi.fn(),
    restartCore: vi.fn(),
    getProxies: vi.fn(),
    getProxiesMerged: vi.fn().mockImplementation((data) => Promise.resolve(data)),
    SPECIAL_PROXY_NAMES: Object.freeze(new Set(['DIRECT', 'REJECT', 'REJECT-DROP', 'COMPATIBLE', 'PASS', 'PASS-RULE'])),
    proxySwitchMark: vi.fn(() => 0),
    proxySwitchedSince: vi.fn(() => false),
    isLatestSwitch: vi.fn(() => true),
    coreReplacements: vi.fn(() => 0),
    // Like api.js: the switch counts as started, then waits for its turn,
    // where canSend may drop it; switchProxy stands for the core's answer.
    ...(() => {
        let starts = 0;
        const api = {
            switchProxy: vi.fn(),
            proxySwitchStartCount: vi.fn(() => starts),
            SWITCH_BUSY: 'busy',
            switchProxyResult: vi.fn(async (group, name, opts = {}) => {
                starts += 1;
                if (opts.canSend && !opts.canSend()) return { ok: false, reason: 'busy', seq: starts };
                try {
                    return { ok: !!(await api.switchProxy(group, name)), reason: null, seq: starts };
                } catch (error) {
                    return { ok: false, reason: error, error, seq: starts };
                }
            }),
        };
        return api;
    })(),
}));

vi.mock('../utils/logger.js', () => ({ proxyLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../utils/sanitize.js', () => ({ escapeHtml: vi.fn(s => s) }));
vi.mock('../utils/format.js', () => ({ getDelayColorClass: vi.fn(() => '') }));
vi.mock('../utils/array.js', () => ({ buildLatencyPriorityQueue: vi.fn(() => []) }));
vi.mock('../utils/debounce.js', () => ({ debounce: vi.fn(fn => fn) }));
vi.mock('../i18n.js', () => ({
    translations: { en: {}, zh: {} },
    currentLang: 'en',
    // Read as fields (t.loadingNodes) and called with a key (t('failoverSwitched')).
    t: Object.assign(vi.fn((key) => key), { loadingNodes: 'Loading…', noGroupsFound: 'No groups', providerPollExhausted: 'Exhausted', retry: 'Retry' }),
}));
vi.mock('./notifications.js', () => ({ showNotification: vi.fn() }));
vi.mock('./icons.js', () => ({ SVG_ICONS: { loading: '' } }));
vi.mock('./3d-effect.js', () => ({ setup3DEffect: vi.fn() }));
vi.mock('../utils/roving-tabindex.js', () => ({ createRovingTabindex: vi.fn(() => ({ destroy: vi.fn() })) }));
vi.mock('@zephyr/shared', () => ({ COMMANDS: { GET_SETTINGS: 'get_settings' } }));
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
vi.mock('./lifecycle.js', () => ({ postRestartRecovery: vi.fn(), restartedProfile: vi.fn(() => ''), withPageBusy: (fn) => fn() }));
vi.mock('./observed-group.js', () => ({
    startObservedGroupWatcher: vi.fn(),
    stopObservedGroupWatcher: vi.fn(),
    resetObservedGroup: vi.fn(),
}));
vi.mock('./navigation.js', () => ({ switchPage: vi.fn() }));
vi.mock('./known-selection.js', () => {
    const knownSelectionRevision = vi.fn(() => 0);
    return {
        noteKnownSelection: vi.fn(),
        knownSelectionRevision,
        // Any revision change counts here as a record for the running profile.
        knownSelectionChangedSince: vi.fn((since) => knownSelectionRevision() > since),
    };
});

// Import after mocks are set up
import { switchProxy, invoke, getProxies, proxySwitchedSince } from '../api.js';
import { proxyLogger } from '../utils/logger.js';
import { getConfigCached, getProxiesCached, invalidateProxiesCache } from './cache.js';
import { fetchProxyGroups } from './proxy-groups.js';
import { saveProxySelection } from './proxy-memory.js';
import { appStore } from './state.js';
import { knownSelectionRevision } from './known-selection.js';
import { startProviderPoll, stopProviderPoll, handleFailoverAction } from './proxies.js';

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

        it('does not retry when all[] contains special names (DIRECT, COMPATIBLE) alongside detailed nodes', async () => {
            vi.useFakeTimers();

            // Group has DIRECT + COMPATIBLE (special, no detail records) + real nodes
            getProxies.mockResolvedValue({ proxies: { MyGroup: { type: 'Selector', all: ['DIRECT', 'COMPATIBLE', 'n1'] }, n1: { type: 'Shadowsocks' } } });
            getConfigCached.mockResolvedValue({ mode: 'rule' });
            fetchProxyGroups.mockResolvedValue({
                proxies: ['DIRECT', 'COMPATIBLE', 'n1'],
                providerLoading: false,
                uiGroupName: 'MyGroup',
            });

            startProviderPoll('MyGroup', 'MyGroup', 0);
            await vi.advanceTimersByTimeAsync(1500);

            // Should call invalidateProxiesCache — special names are excluded from check
            expect(invalidateProxiesCache).toHaveBeenCalledTimes(1);
        });

        it('handles lowercase and mixed-case special names (direct, Compatible)', async () => {
            vi.useFakeTimers();

            // Mixed-case special names should also be excluded (case-insensitive)
            getProxies.mockResolvedValue({ proxies: { MyGroup: { type: 'Selector', all: ['direct', 'Compatible', 'n1'] }, n1: { type: 'Shadowsocks' } } });
            getConfigCached.mockResolvedValue({ mode: 'rule' });
            fetchProxyGroups.mockResolvedValue({
                proxies: ['direct', 'Compatible', 'n1'],
                providerLoading: false,
                uiGroupName: 'MyGroup',
            });

            startProviderPoll('MyGroup', 'MyGroup', 0);
            await vi.advanceTimersByTimeAsync(1500);

            // Should call invalidateProxiesCache — lowercase specials are excluded too
            expect(invalidateProxiesCache).toHaveBeenCalledTimes(1);
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

// The UI group is Main and failover is on unless a test says otherwise.
const failoverStore = (enabled = true) => (key) => (key === 'uiGroupName' ? 'Main' : key === 'failoverEnabled' ? enabled : null);
// The current node of Main failed three times; the engine asks for `target`.
const failover = (target, ...args) => handleFailoverAction({ failedNode: 'failed.example.com', failureCount: 3, target }, ...args);

const proxyMap = {
    Main: { type: 'Selector', now: 'failed.example.com', all: ['failed.example.com', 'good.example.com'] },
    'failed.example.com': { type: 'Vmess', history: [] },
    'good.example.com': { type: 'Vmess', history: [{ delay: 80 }] },
};

describe('failover switch', () => {
    afterEach(() => {
        appStore.get.mockReset();
    });

    beforeEach(() => {
        vi.clearAllMocks();
        appStore.get.mockImplementation(failoverStore());
        knownSelectionRevision.mockImplementation(() => 0);
        getProxiesCached.mockResolvedValue({ proxies: proxyMap });
        // The live read sees what the cached one saw unless a test says otherwise.
        getProxies.mockImplementation(() => getProxiesCached());
        invoke.mockImplementation(async (cmd) => (cmd === 'get_settings' ? { last_config: 'a.yaml' } : null));
    });

    it('saves the node it switched to as the choice of the running profile', async () => {
        switchProxy.mockResolvedValue(true);
        await failover('next');
        expect(switchProxy).toHaveBeenCalledWith('Main', 'good.example.com');
        expect(saveProxySelection).toHaveBeenCalledWith('a.yaml', { group: 'Main', node: 'good.example.com' });
    });

    it('records nothing when the switch was not applied', async () => {
        switchProxy.mockResolvedValue(false);
        await failover('next');
        expect(saveProxySelection).not.toHaveBeenCalled();
    });

    it('records nothing when another profile runs once the switch is done', async () => {
        const running = ['a.yaml', 'a.yaml', 'b.yaml'];
        invoke.mockImplementation(async (cmd) => (cmd === 'get_settings' ? { last_config: running.shift() ?? 'b.yaml' } : null));
        switchProxy.mockResolvedValue(true);
        await failover('next');
        expect(switchProxy).toHaveBeenCalledWith('Main', 'good.example.com');
        expect(saveProxySelection).not.toHaveBeenCalled();
    });

    it('does not switch when another profile came up while the groups loaded', async () => {
        const running = ['a.yaml', 'b.yaml'];
        invoke.mockImplementation(async (cmd) => (cmd === 'get_settings' ? { last_config: running.shift() ?? 'b.yaml' } : null));
        switchProxy.mockResolvedValue(true);
        await failover('next');
        expect(switchProxy).not.toHaveBeenCalled();
        expect(saveProxySelection).not.toHaveBeenCalled();
    });

    it('does not switch once Stop aborted the test that called for it', async () => {
        switchProxy.mockResolvedValue(true);
        const stopped = new AbortController();
        stopped.abort();
        await failover('next', 'a.yaml', stopped.signal);
        expect(switchProxy).not.toHaveBeenCalled();
        // Also when Stop comes while the live selection is read: the run is
        // the current one until then, so the check reaches that read.
        const { getLatencyTestSignal } = await import('../api.js');
        const later = new AbortController();
        vi.mocked(getLatencyTestSignal).mockReturnValue(later.signal);
        getProxies.mockImplementation(async () => {
            later.abort();
            return getProxiesCached();
        });
        await failover('next', 'a.yaml', later.signal);
        expect(getProxies).toHaveBeenCalled();
        expect(later.signal.aborted).toBe(true);
        expect(switchProxy).not.toHaveBeenCalled();
        vi.mocked(getLatencyTestSignal).mockReset();
    });

    it('does not switch once a newer test of the failed node replaced the one that failed', async () => {
        switchProxy.mockResolvedValue(true);
        await failover('next', 'a.yaml', undefined, () => false);
        expect(switchProxy).not.toHaveBeenCalled();
        await failover('next', 'a.yaml', undefined, () => true);
        expect(switchProxy).toHaveBeenCalled();
    });

    it('does not switch for a test that a newer test run replaced', async () => {
        const { getLatencyTestSignal } = await import('../api.js');
        switchProxy.mockResolvedValue(true);
        const older = new AbortController();
        const newer = new AbortController();
        vi.mocked(getLatencyTestSignal).mockReturnValue(newer.signal);
        await failover('next', 'a.yaml', older.signal);
        expect(switchProxy).not.toHaveBeenCalled();
        await failover('next', 'a.yaml', newer.signal);
        expect(switchProxy).toHaveBeenCalled();
        vi.mocked(getLatencyTestSignal).mockReset();
    });

    it('does not switch while a profile, mode or TUN change is under way', async () => {
        // Failover on: only the network change stops it.
        appStore.get.mockImplementation((key) => (key === 'isNetworkUpdating' ? true : failoverStore()(key)));
        try {
            switchProxy.mockResolvedValue(true);
            await failover('next');
            expect(switchProxy).not.toHaveBeenCalled();
        } finally {
            appStore.get.mockImplementation(failoverStore());
        }
    });

    it('does not switch once failover was turned off while the checks ran', async () => {
        // On when failover begins, turned off while the live selection is read.
        let enabled = true;
        appStore.get.mockImplementation((key) => failoverStore(enabled)(key));
        const live = getProxies.getMockImplementation();
        getProxies.mockImplementation(async (...args) => {
            enabled = false;
            return live ? live(...args) : getProxiesCached();
        });
        try {
            switchProxy.mockResolvedValue(true);
            await failover('next');
            expect(getProxies).toHaveBeenCalled();
            expect(switchProxy).not.toHaveBeenCalled();
        } finally {
            if (live) getProxies.mockImplementation(live);
            appStore.get.mockImplementation(failoverStore());
        }
    });

    it('never switches to an outbound that hands the traffic back to the rules', async () => {
        getProxiesCached.mockResolvedValue({
            proxies: {
                Main: { type: 'Selector', now: 'failed.example.com', all: ['failed.example.com', 'PASS-RULE', 'Again', 'Real'] },
                'failed.example.com': { type: 'Vmess', history: [] },
                'PASS-RULE': { type: 'PassRule', history: [{ delay: 1 }] },
                Again: { type: 'Rematch', history: [{ delay: 1 }] },
                Real: { type: 'Vmess', history: [{ delay: 90 }] },
            },
        });
        switchProxy.mockResolvedValue(true);
        await failover('PASS-RULE');
        expect(switchProxy).toHaveBeenCalledTimes(1);
        expect(switchProxy).toHaveBeenCalledWith('Main', 'Real');
    });

    it('picks the engine target when it is a candidate, else the lowest delay', async () => {
        getProxiesCached.mockResolvedValue({
            proxies: {
                Main: { type: 'Selector', now: 'failed.example.com', all: ['failed.example.com', 'slow.example.com', 'fast.example.com', 'none.example.com', 'block'] },
                'failed.example.com': { type: 'Vmess', history: [] },
                'slow.example.com': { type: 'Vmess', history: [{ delay: 300 }] },
                'fast.example.com': { type: 'Vmess', history: [{ delay: 900 }, { delay: 40 }] },
                'none.example.com': { type: 'Vmess', history: [{ delay: 0 }] },
                block: { type: 'Reject', history: [{ delay: 1 }] },
            },
        });
        switchProxy.mockResolvedValue(true);
        await failover('next');
        expect(switchProxy).toHaveBeenLastCalledWith('Main', 'fast.example.com');
        await failover('slow.example.com');
        expect(switchProxy).toHaveBeenLastCalledWith('Main', 'slow.example.com');
        await failover('block');
        expect(switchProxy).toHaveBeenLastCalledWith('Main', 'fast.example.com');
    });
    it('keeps a choice recorded while the switch ran', async () => {
        // The user picked a node during the switch: that record is newer.
        // (Read before, when the switch's turn comes, and after it.)
        const revisions = [4, 4, 5];
        knownSelectionRevision.mockImplementation(() => revisions.shift() ?? 5);
        switchProxy.mockResolvedValue(true);
        await failover('next');
        expect(switchProxy).toHaveBeenCalledWith('Main', 'good.example.com');
        expect(saveProxySelection).not.toHaveBeenCalled();
    });

    it('is not sent when the user\'s pick was started after the checks, ahead of it', async () => {
        const { switchProxyResult, proxySwitchedSince: switchedSince } = await import('../api.js');
        switchProxy.mockResolvedValue(true);
        // The user's switch starts between the checks and the failover's
        // turn: against the checks' mark, more started than its own.
        let bumped = false;
        switchedSince.mockImplementation((mark, own = 0) => bumped && own === 1);
        switchProxyResult.mockImplementationOnce(async (group, name, opts) => {
            bumped = true;
            return opts.canSend() ? { ok: true, reason: null, seq: 1 } : { ok: false, reason: 'busy', seq: 1 };
        });
        try {
            await failover('next');
            expect(switchProxy).not.toHaveBeenCalled();
            expect(saveProxySelection).not.toHaveBeenCalled();
            // Checked against the mark the checks used, allowing its own switch.
            expect(switchedSince).toHaveBeenLastCalledWith(0, 1, { ownInFlight: 1 });
        } finally {
            switchedSince.mockReset();
            switchedSince.mockReturnValue(false);
        }
    });

    it('leaves the user\'s later switch alone: no save, no notice, no closed connections', async () => {
        const api = await import('../api.js');
        const { showNotification } = await import('./notifications.js');
        vi.mocked(showNotification).mockClear();
        vi.mocked(api.closeAllConnections).mockClear();
        switchProxy.mockResolvedValue(true);
        api.isLatestSwitch.mockReturnValue(false);
        try {
            await failover('next');
            expect(switchProxy).toHaveBeenCalled();
            expect(saveProxySelection).not.toHaveBeenCalled();
            expect(showNotification).not.toHaveBeenCalled();
            expect(api.closeAllConnections).not.toHaveBeenCalled();
        } finally {
            api.isLatestSwitch.mockReturnValue(true);
        }
    });

    it('is not sent when failover was turned off before its turn came', async () => {
        const { switchProxyResult } = await import('../api.js');
        let enabled = true;
        appStore.get.mockImplementation((key) => failoverStore(enabled)(key));
        switchProxy.mockResolvedValue(true);
        switchProxyResult.mockImplementationOnce(async (group, name, opts) => {
            // Turned off while it waited behind an earlier switch.
            enabled = false;
            return opts.canSend() ? { ok: true, reason: null, seq: 1 } : { ok: false, reason: 'busy', seq: 1 };
        });
        try {
            await failover('next');
            expect(switchProxy).not.toHaveBeenCalled();
            expect(saveProxySelection).not.toHaveBeenCalled();
        } finally {
            appStore.get.mockImplementation(failoverStore());
        }
    });

    it('is not sent when a choice was recorded before its turn came', async () => {
        const revisions = [4, 5];
        knownSelectionRevision.mockImplementation(() => revisions.shift() ?? 5);
        switchProxy.mockResolvedValue(true);
        await failover('next');
        expect(switchProxy).not.toHaveBeenCalled();
    });

    it('never switches to an outbound that is not a proxy', async () => {
        getProxiesCached.mockResolvedValue({
            proxies: {
                Main: { type: 'Selector', now: 'failed.example.com', all: ['failed.example.com', 'DIRECT', 'drop', 'dns-out'] },
                'failed.example.com': { type: 'Vmess', history: [] },
                DIRECT: { type: 'Direct', history: [{ delay: 1 }] },
                drop: { type: 'RejectDrop', history: [{ delay: 1 }] },
                'dns-out': { type: 'Dns', history: [{ delay: 1 }] },
            },
        });
        switchProxy.mockResolvedValue(true);
        await failover('DIRECT');
        expect(switchProxy).not.toHaveBeenCalled();
    });

    it('never switches to a nested group that leads to a non-proxy outbound', async () => {
        getProxiesCached.mockResolvedValue({
            proxies: {
                Main: { type: 'Selector', now: 'failed.example.com', all: ['failed.example.com', 'Bypass', 'Listed', 'blocked', 'Real'] },
                'failed.example.com': { type: 'Vmess', history: [] },
                // A selector sitting on DIRECT (not listed in the map itself).
                Bypass: { type: 'Selector', now: 'DIRECT', all: ['DIRECT'], history: [{ delay: 1 }] },
                // A selector sitting on a listed reject outbound.
                Listed: { type: 'Selector', now: 'drop', all: ['drop'], history: [{ delay: 1 }] },
                drop: { type: 'Reject-Drop', history: [{ delay: 1 }] },
                blocked: { type: 'Reject-Drop', history: [{ delay: 1 }] },
                Real: { type: 'Selector', now: 'good.example.com', all: ['good.example.com'] },
                'good.example.com': { type: 'Vmess', history: [{ delay: 80 }] },
            },
        });
        switchProxy.mockResolvedValue(true);
        await failover('Bypass');
        expect(switchProxy).toHaveBeenCalledTimes(1);
        expect(switchProxy).toHaveBeenCalledWith('Main', 'Real');
    });

    it('never switches to another group that leads to the node a failed group leads to', async () => {
        getProxiesCached.mockResolvedValue({
            proxies: {
                Main: { type: 'Selector', now: 'Auto', all: ['Auto', 'Manual', 'Real'] },
                Auto: { type: 'Selector', now: 'bad.example.com', all: ['bad.example.com'] },
                Manual: { type: 'Selector', now: 'bad.example.com', all: ['bad.example.com'] },
                'bad.example.com': { type: 'Vmess', history: [{ delay: 1 }] },
                Real: { type: 'Selector', now: 'good.example.com', all: ['good.example.com'] },
                'good.example.com': { type: 'Vmess', history: [{ delay: 80 }] },
            },
        });
        switchProxy.mockResolvedValue(true);
        await handleFailoverAction({ failedNode: 'Auto', failureCount: 3, target: 'Manual' });
        expect(switchProxy).toHaveBeenCalledTimes(1);
        expect(switchProxy).toHaveBeenCalledWith('Main', 'Real');
    });

    it('never switches to a load balancer that has DIRECT among its members', async () => {
        getProxiesCached.mockResolvedValue({
            proxies: {
                Main: { type: 'Selector', now: 'failed.example.com', all: ['failed.example.com', 'Balance', 'good.example.com'] },
                Balance: { type: 'LoadBalance', all: ['fast.example.com', 'DIRECT'] },
                'fast.example.com': { type: 'Vmess', history: [{ delay: 1 }] },
                DIRECT: { type: 'Direct' },
                'failed.example.com': { type: 'Vmess', history: [{ delay: 0 }] },
                'good.example.com': { type: 'Vmess', history: [{ delay: 90 }] },
            },
        });
        switchProxy.mockResolvedValue(true);
        await failover('Balance');
        expect(switchProxy).toHaveBeenCalledTimes(1);
        expect(switchProxy).toHaveBeenCalledWith('Main', 'good.example.com');
    });

    it('never switches to a load balancer with a DIRECT member, even when it reports a now', async () => {
        getProxiesCached.mockResolvedValue({
            proxies: {
                Main: { type: 'Selector', now: 'failed.example.com', all: ['failed.example.com', 'Balance', 'good.example.com'] },
                Balance: { type: 'LoadBalance', now: 'fast.example.com', all: ['fast.example.com', 'DIRECT'] },
                'fast.example.com': { type: 'Vmess', history: [{ delay: 1 }] },
                DIRECT: { type: 'Direct' },
                'failed.example.com': { type: 'Vmess', history: [{ delay: 0 }] },
                'good.example.com': { type: 'Vmess', history: [{ delay: 90 }] },
            },
        });
        switchProxy.mockResolvedValue(true);
        await failover('Balance');
        expect(switchProxy).toHaveBeenCalledTimes(1);
        expect(switchProxy).toHaveBeenCalledWith('Main', 'good.example.com');
    });

    it.each([['URLTest'], ['Fallback']])('never switches to a %s group that lists DIRECT, wherever it sits now', async (type) => {
        getProxiesCached.mockResolvedValue({
            proxies: {
                Main: { type: 'Selector', now: 'failed.example.com', all: ['failed.example.com', 'Auto', 'good.example.com'] },
                // On a proxy now, but free to move to DIRECT on its own later.
                Auto: { type, now: 'fast.example.com', all: ['fast.example.com', 'DIRECT'] },
                'fast.example.com': { type: 'Vmess', history: [{ delay: 1 }] },
                DIRECT: { type: 'Direct' },
                'failed.example.com': { type: 'Vmess', history: [{ delay: 0 }] },
                'good.example.com': { type: 'Vmess', history: [{ delay: 90 }] },
            },
        });
        switchProxy.mockResolvedValue(true);
        await failover('Auto');
        expect(switchProxy).toHaveBeenCalledTimes(1);
        expect(switchProxy).toHaveBeenCalledWith('Main', 'good.example.com');
    });

    it.each([
        ['with a DIRECT member the core does not list', 'DIRECT'],
        ['that lists the failed node', 'failed.example.com'],
    ])('never switches to a load balancer %s', async (_case, member) => {
        getProxiesCached.mockResolvedValue({
            proxies: {
                Main: { type: 'Selector', now: 'failed.example.com', all: ['failed.example.com', 'Balance', 'good.example.com'] },
                Balance: { type: 'LoadBalance', all: ['fast.example.com', member] },
                'fast.example.com': { type: 'Vmess', history: [{ delay: 1 }] },
                'failed.example.com': { type: 'Vmess', history: [{ delay: 0 }] },
                'good.example.com': { type: 'Vmess', history: [{ delay: 90 }] },
            },
        });
        switchProxy.mockResolvedValue(true);
        await failover('Balance');
        expect(switchProxy).toHaveBeenCalledTimes(1);
        expect(switchProxy).toHaveBeenCalledWith('Main', 'good.example.com');
    });

    it('keeps a choice recorded while the running profile was read', async () => {
        // The snapshot is taken before the first await of the switch flow.
        const revisions = [4, 5];
        knownSelectionRevision.mockImplementation(() => revisions.shift() ?? 5);
        invoke.mockImplementation(async (cmd) => (cmd === 'get_settings' ? { last_config: 'a.yaml' } : null));
        switchProxy.mockResolvedValue(true);
        await failover('next');
        expect(knownSelectionRevision.mock.invocationCallOrder[0]).toBeLessThan(invoke.mock.invocationCallOrder[0]);
        expect(saveProxySelection).not.toHaveBeenCalled();
    });

    it('does not replace a node the user picked while the failover ran', async () => {
        getProxies.mockResolvedValue({ proxies: { ...proxyMap, Main: { ...proxyMap.Main, now: 'good.example.com' } } });
        switchProxy.mockResolvedValue(true);
        await failover('next');
        expect(switchProxy).not.toHaveBeenCalled();
    });

    it('does not switch when the running profile cannot be read', async () => {
        for (const failing of [1, 2]) {
            let calls = 0;
            invoke.mockImplementation(async (cmd) => {
                if (cmd !== 'get_settings') return null;
                calls += 1;
                if (calls === failing) throw new Error('settings unavailable');
                return { last_config: 'a.yaml' };
            });
            switchProxy.mockResolvedValue(true);
            await failover('next');
        }
        expect(switchProxy).not.toHaveBeenCalled();
        expect(saveProxySelection).not.toHaveBeenCalled();
    });

    it('does not switch while a node switch is on its way', async () => {
        proxySwitchedSince.mockReturnValueOnce(true);
        switchProxy.mockResolvedValue(true);
        await failover('next');
        expect(switchProxy).not.toHaveBeenCalled();
    });

    it('does not switch when a node switch starts during the checks', async () => {
        // None at the first check; one counted at the last check before switching.
        proxySwitchedSince.mockReturnValueOnce(false).mockReturnValue(true);
        try {
            switchProxy.mockResolvedValue(true);
            await failover('next');
            expect(switchProxy).not.toHaveBeenCalled();
        } finally {
            proxySwitchedSince.mockReset();
            proxySwitchedSince.mockReturnValue(false);
        }
    });

    it('a failed settings read is not taken for the minimal config', async () => {
        // '' = the minimal config runs; a failed read must not match it.
        let calls = 0;
        invoke.mockImplementation(async (cmd) => {
            if (cmd !== 'get_settings') return null;
            calls += 1;
            if (calls === 3) throw new Error('settings unavailable');
            return { last_config: 'a.yaml' };
        });
        switchProxy.mockResolvedValue(true);
        await failover('next');
        expect(switchProxy).toHaveBeenCalledTimes(1);
        expect(saveProxySelection).not.toHaveBeenCalled();
    });
    it('does not switch to a target the core has moved to DIRECT since the cached read', async () => {
        const nested = {
            Main: { type: 'Selector', now: 'failed.example.com', all: ['failed.example.com', 'Sub'] },
            Sub: { type: 'Selector', now: 'good.example.com', all: ['good.example.com', 'DIRECT'] },
            'failed.example.com': { type: 'Vmess', history: [] },
            'good.example.com': { type: 'Vmess', history: [{ delay: 80 }] },
            DIRECT: { type: 'Direct' },
        };
        getProxiesCached.mockResolvedValue({ proxies: nested });
        getProxies.mockResolvedValue({ proxies: { ...nested, Sub: { ...nested.Sub, now: 'DIRECT' } } });
        switchProxy.mockResolvedValue(true);
        await failover('next');
        expect(switchProxy).not.toHaveBeenCalled();
        // Still a proxy live: switched.
        getProxies.mockResolvedValue({ proxies: nested });
        await failover('next');
        expect(switchProxy).toHaveBeenCalledWith('Main', 'Sub');
    });

    it('reads the live selection before the last profile check', async () => {
        switchProxy.mockResolvedValue(true);
        await failover('next');
        const settingsReads = invoke.mock.calls
            .map((call, i) => (call[0] === 'get_settings' ? invoke.mock.invocationCallOrder[i] : null))
            .filter((order) => order !== null);
        // Read 2 is the check right before the switch: after the live read.
        expect(getProxies.mock.invocationCallOrder[0]).toBeLessThan(settingsReads[1]);
        expect(settingsReads[1]).toBeLessThan(switchProxy.mock.invocationCallOrder[0]);
    });

    it('does nothing for a test that ran under another profile', async () => {
        switchProxy.mockResolvedValue(true);
        await failover('next', 'b.yaml');
        await failover('next', null);
        expect(switchProxy).not.toHaveBeenCalled();
        await failover('next', 'a.yaml');
        expect(switchProxy).toHaveBeenCalledWith('Main', 'good.example.com');
    });

    it('logs a switch the core refused', async () => {
        switchProxy.mockRejectedValue(new Error('HTTP 400: Bad Request'));
        await failover('next');
        expect(proxyLogger.warn).toHaveBeenCalledWith(
            expect.stringContaining('good.example.com'),
            expect.any(Error),
        );
        expect(saveProxySelection).not.toHaveBeenCalled();
    });
});
