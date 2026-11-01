import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock all proxies.js dependencies ──────────────────────────────────────
// Same module mocks as proxies-poller.test.js. The poller only uses: getProxies (api), getConfigCached + invalidateProxiesCache
// (cache), fetchProxyGroupsShared (proxy-groups).  All other imports are mocked
// as no-ops so the module loads cleanly.

// NOTE: Can't use importOriginal() because it loads the real api.js module graph
// (websocket.js, events.js, etc.) which requires logger exports not mocked here.
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
    getProxiesMerged: vi.fn().mockImplementation((data) => Promise.resolve(data)),
    SPECIAL_PROXY_NAMES: Object.freeze(new Set(['DIRECT', 'REJECT', 'REJECT-DROP', 'COMPATIBLE', 'PASS', 'PASS-RULE'])),
    proxySwitchMark: vi.fn(() => 0),
    proxySwitchedSince: vi.fn(() => false),
}));

vi.mock('../utils/logger.js', () => ({ proxyLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../utils/sanitize.js', () => ({ escapeHtml: vi.fn(s => s) }));
vi.mock('../utils/format.js', () => ({ getDelayColorClass: vi.fn(() => '') }));
vi.mock('../utils/array.js', () => ({ buildLatencyPriorityQueue: vi.fn(() => []) }));
vi.mock('../utils/debounce.js', () => ({ debounce: vi.fn(fn => fn) }));
vi.mock('../i18n.js', () => ({
    translations: { en: {}, zh: {} },
    currentLang: 'en',
    t: vi.fn((key) => key),
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
vi.mock('./state.js', () => ({ appStore: { get: vi.fn((key) => (key === 'uiGroupName' ? 'Main' : null)), set: vi.fn(), subscribe: vi.fn() } }));
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

import { switchProxy, invoke, getProxies, proxySwitchedSince } from '../api.js';
import { proxyLogger } from '../utils/logger.js';
import { saveProxySelection } from './proxy-memory.js';
import { getProxiesCached } from './cache.js';
import { knownSelectionRevision } from './known-selection.js';
import { handleFailoverAction } from './proxies.js';

const proxyMap = {
    Main: { type: 'Selector', now: 'failed.example.com', all: ['failed.example.com', 'good.example.com'] },
    'failed.example.com': { type: 'Vmess', history: [] },
    'good.example.com': { type: 'Vmess', history: [{ delay: 80 }] },
};

describe('failover switch', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        knownSelectionRevision.mockImplementation(() => 0);
        getProxiesCached.mockResolvedValue({ proxies: proxyMap });
        // The live read sees what the cached one saw unless a test says otherwise.
        getProxies.mockImplementation(() => getProxiesCached());
        invoke.mockImplementation(async (cmd) => (cmd === 'get_settings' ? { last_config: 'a.yaml' } : null));
    });

    it('saves the node it switched to as the choice of the running profile', async () => {
        switchProxy.mockResolvedValue(true);
        await handleFailoverAction({ failedNode: 'failed.example.com', failureCount: 3, target: 'next' });
        expect(switchProxy).toHaveBeenCalledWith('Main', 'good.example.com');
        expect(saveProxySelection).toHaveBeenCalledWith('a.yaml', { group: 'Main', node: 'good.example.com' });
    });

    it('records nothing when the switch was not applied', async () => {
        switchProxy.mockResolvedValue(false);
        await handleFailoverAction({ failedNode: 'failed.example.com', failureCount: 3, target: 'next' });
        expect(saveProxySelection).not.toHaveBeenCalled();
    });

    it('records nothing when another profile runs once the switch is done', async () => {
        const running = ['a.yaml', 'a.yaml', 'b.yaml'];
        invoke.mockImplementation(async (cmd) => (cmd === 'get_settings' ? { last_config: running.shift() ?? 'b.yaml' } : null));
        switchProxy.mockResolvedValue(true);
        await handleFailoverAction({ failedNode: 'failed.example.com', failureCount: 3, target: 'next' });
        expect(switchProxy).toHaveBeenCalledWith('Main', 'good.example.com');
        expect(saveProxySelection).not.toHaveBeenCalled();
    });

    it('does not switch when another profile came up while the groups loaded', async () => {
        const running = ['a.yaml', 'b.yaml'];
        invoke.mockImplementation(async (cmd) => (cmd === 'get_settings' ? { last_config: running.shift() ?? 'b.yaml' } : null));
        switchProxy.mockResolvedValue(true);
        await handleFailoverAction({ failedNode: 'failed.example.com', failureCount: 3, target: 'next' });
        expect(switchProxy).not.toHaveBeenCalled();
        expect(saveProxySelection).not.toHaveBeenCalled();
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
        await handleFailoverAction({ failedNode: 'failed.example.com', failureCount: 3, target: 'PASS-RULE' });
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
        await handleFailoverAction({ failedNode: 'failed.example.com', failureCount: 3, target: 'next' });
        expect(switchProxy).toHaveBeenLastCalledWith('Main', 'fast.example.com');
        await handleFailoverAction({ failedNode: 'failed.example.com', failureCount: 3, target: 'slow.example.com' });
        expect(switchProxy).toHaveBeenLastCalledWith('Main', 'slow.example.com');
        await handleFailoverAction({ failedNode: 'failed.example.com', failureCount: 3, target: 'block' });
        expect(switchProxy).toHaveBeenLastCalledWith('Main', 'fast.example.com');
    });
    it('keeps a choice recorded while the switch ran', async () => {
        // The user picked a node during the switch: that record is newer.
        const revisions = [4, 5];
        knownSelectionRevision.mockImplementation(() => revisions.shift() ?? 5);
        switchProxy.mockResolvedValue(true);
        await handleFailoverAction({ failedNode: 'failed.example.com', failureCount: 3, target: 'next' });
        expect(switchProxy).toHaveBeenCalledWith('Main', 'good.example.com');
        expect(saveProxySelection).not.toHaveBeenCalled();
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
        await handleFailoverAction({ failedNode: 'failed.example.com', failureCount: 3, target: 'DIRECT' });
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
        await handleFailoverAction({ failedNode: 'failed.example.com', failureCount: 3, target: 'Bypass' });
        expect(switchProxy).toHaveBeenCalledTimes(1);
        expect(switchProxy).toHaveBeenCalledWith('Main', 'Real');
    });

    it('keeps a choice recorded while the running profile was read', async () => {
        // The snapshot is taken before the first await of the switch flow.
        const revisions = [4, 5];
        knownSelectionRevision.mockImplementation(() => revisions.shift() ?? 5);
        invoke.mockImplementation(async (cmd) => (cmd === 'get_settings' ? { last_config: 'a.yaml' } : null));
        switchProxy.mockResolvedValue(true);
        await handleFailoverAction({ failedNode: 'failed.example.com', failureCount: 3, target: 'next' });
        expect(knownSelectionRevision.mock.invocationCallOrder[0]).toBeLessThan(invoke.mock.invocationCallOrder[0]);
        expect(saveProxySelection).not.toHaveBeenCalled();
    });

    it('does not replace a node the user picked while the failover ran', async () => {
        getProxies.mockResolvedValue({ proxies: { ...proxyMap, Main: { ...proxyMap.Main, now: 'good.example.com' } } });
        switchProxy.mockResolvedValue(true);
        await handleFailoverAction({ failedNode: 'failed.example.com', failureCount: 3, target: 'next' });
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
            await handleFailoverAction({ failedNode: 'failed.example.com', failureCount: 3, target: 'next' });
        }
        expect(switchProxy).not.toHaveBeenCalled();
        expect(saveProxySelection).not.toHaveBeenCalled();
    });

    it('does not switch while a node switch is on its way', async () => {
        proxySwitchedSince.mockReturnValueOnce(true);
        switchProxy.mockResolvedValue(true);
        await handleFailoverAction({ failedNode: 'failed.example.com', failureCount: 3, target: 'next' });
        expect(switchProxy).not.toHaveBeenCalled();
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
        await handleFailoverAction({ failedNode: 'failed.example.com', failureCount: 3, target: 'next' });
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
        await handleFailoverAction({ failedNode: 'failed.example.com', failureCount: 3, target: 'next' });
        expect(switchProxy).not.toHaveBeenCalled();
        // Still a proxy live: switched.
        getProxies.mockResolvedValue({ proxies: nested });
        await handleFailoverAction({ failedNode: 'failed.example.com', failureCount: 3, target: 'next' });
        expect(switchProxy).toHaveBeenCalledWith('Main', 'Sub');
    });

    it('reads the live selection before the last profile check', async () => {
        switchProxy.mockResolvedValue(true);
        await handleFailoverAction({ failedNode: 'failed.example.com', failureCount: 3, target: 'next' });
        const settingsReads = invoke.mock.calls
            .map((call, i) => (call[0] === 'get_settings' ? invoke.mock.invocationCallOrder[i] : null))
            .filter((order) => order !== null);
        // Read 2 is the check right before the switch: after the live read.
        expect(getProxies.mock.invocationCallOrder[0]).toBeLessThan(settingsReads[1]);
        expect(settingsReads[1]).toBeLessThan(switchProxy.mock.invocationCallOrder[0]);
    });

    it('does nothing for a test that ran under another profile', async () => {
        switchProxy.mockResolvedValue(true);
        await handleFailoverAction({ failedNode: 'failed.example.com', failureCount: 3, target: 'next' }, 'b.yaml');
        await handleFailoverAction({ failedNode: 'failed.example.com', failureCount: 3, target: 'next' }, null);
        expect(switchProxy).not.toHaveBeenCalled();
        await handleFailoverAction({ failedNode: 'failed.example.com', failureCount: 3, target: 'next' }, 'a.yaml');
        expect(switchProxy).toHaveBeenCalledWith('Main', 'good.example.com');
    });

    it('logs a switch the core refused', async () => {
        switchProxy.mockRejectedValue(new Error('HTTP 400: Bad Request'));
        await handleFailoverAction({ failedNode: 'failed.example.com', failureCount: 3, target: 'next' });
        expect(proxyLogger.warn).toHaveBeenCalledWith(
            expect.stringContaining('good.example.com'),
            expect.any(Error),
        );
        expect(saveProxySelection).not.toHaveBeenCalled();
    });
});
