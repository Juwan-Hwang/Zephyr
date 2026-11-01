import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

vi.mock('./known-selection.js', () => ({ noteKnownSelection: vi.fn() }));

import { switchProxy, invoke } from '../api.js';
import { getProxiesCached } from './cache.js';
import { noteKnownSelection } from './known-selection.js';
import { handleFailoverAction } from './proxies.js';

const proxyMap = {
    Main: { type: 'Selector', now: 'failed.example.com', all: ['failed.example.com', 'good.example.com'] },
    'failed.example.com': { type: 'Vmess', history: [] },
    'good.example.com': { type: 'Vmess', history: [{ delay: 80 }] },
};

describe('failover switch', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        getProxiesCached.mockResolvedValue({ proxies: proxyMap });
        invoke.mockImplementation(async (cmd) => (cmd === 'get_settings' ? { last_config: 'a.yaml' } : null));
    });

    it('records the node it switched to as the known choice of the running profile', async () => {
        switchProxy.mockResolvedValue(true);
        await handleFailoverAction({ failedNode: 'failed.example.com', failureCount: 3, target: 'next' });
        expect(switchProxy).toHaveBeenCalledWith('Main', 'good.example.com');
        expect(noteKnownSelection).toHaveBeenCalledWith('a.yaml', { group: 'Main', node: 'good.example.com' });
    });

    it('records nothing when the switch was not applied', async () => {
        switchProxy.mockResolvedValue(false);
        await handleFailoverAction({ failedNode: 'failed.example.com', failureCount: 3, target: 'next' });
        expect(noteKnownSelection).not.toHaveBeenCalled();
    });
});
