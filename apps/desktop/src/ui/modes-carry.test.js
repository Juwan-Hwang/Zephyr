import { describe, it, expect, vi, beforeEach } from 'vitest';

const api = {
    invoke: vi.fn(),
    closeAllConnections: vi.fn(async () => {}),
    switchProxy: vi.fn(),
    getProxies: vi.fn(async () => ({ proxies: {} })),
    SPECIAL_PROXY_NAMES: new Set(['DIRECT', 'REJECT', 'COMPATIBLE', 'PASS']),
};
vi.mock('../api.js', () => api);
vi.mock('./proxy-groups.js', () => ({ fetchProxyGroups: vi.fn() }));
vi.mock('./notifications.js', () => ({ showNotification: vi.fn() }));
vi.mock('../i18n.js', () => ({ translations: { en: {} }, currentLang: 'en' }));
vi.mock('./cache.js', () => ({ invalidateSettingsCache: vi.fn() }));
vi.mock('./events.js', () => ({ Bus: { emit: vi.fn(), on: vi.fn() }, Events: { MODE_CHANGED: 'mode-changed' } }));
vi.mock('../utils/logger.js', () => ({ modesLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
const store = new Map();
vi.mock('./state.js', () => ({ appStore: { get: (k) => store.get(k), set: (k, v) => store.set(k, v) } }));
vi.mock('./proxies.js', () => ({ refreshProxies: vi.fn(async () => {}), syncCoreConfig: vi.fn(async () => {}) }));

const { applyMode } = await import('./modes.js');
const groups = await import('./proxy-groups.js');
const { appStore } = await import('./state.js');
const { noteKnownSelection, knownSelection } = await import('./known-selection.js');

describe('carrying the node over on a mode switch', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        appStore.set('isNetworkUpdating', false);
        appStore.set('uiGroupName', 'GLOBAL');
        appStore.set('knownSelections', []);
        api.invoke.mockImplementation(async (cmd) => (cmd === 'get_settings' ? { last_config: 'a.yaml' } : null));
        api.switchProxy.mockResolvedValue(true);
        // Before the switch GLOBAL runs node-b; after it the rule group offers it.
        groups.fetchProxyGroups
            .mockResolvedValueOnce({ current: 'node-b.example.com', uiGroupName: 'GLOBAL', proxies: [] })
            .mockResolvedValueOnce({ current: 'node-a.example.com', uiGroupName: 'Proxy', proxies: ['node-a.example.com', 'node-b.example.com'] });
    });

    it('records the carried node as the known choice of the running profile', async () => {
        noteKnownSelection('a.yaml', { group: 'Proxy', node: 'node-a.example.com' });
        await expect(applyMode('rule', { silent: true })).resolves.toBe('ok');
        expect(api.switchProxy).toHaveBeenCalledWith('Proxy', 'node-b.example.com');
        expect(knownSelection('a.yaml', 'Proxy')).toEqual({ profile: 'a.yaml', group: 'Proxy', node: 'node-b.example.com' });
    });

    it('records nothing when another profile runs once the switch is done', async () => {
        const running = ['a.yaml', 'b.yaml'];
        api.invoke.mockImplementation(async (cmd) => (cmd === 'get_settings' ? { last_config: running.shift() ?? 'b.yaml' } : null));
        await applyMode('rule', { silent: true });
        expect(api.switchProxy).toHaveBeenCalledWith('Proxy', 'node-b.example.com');
        expect(knownSelection('a.yaml')).toBeNull();
        expect(knownSelection('b.yaml')).toBeNull();
    });

    it('keeps a choice the user made while the node was carried over', async () => {
        api.switchProxy.mockImplementation(async () => {
            noteKnownSelection('a.yaml', { group: 'Proxy', node: 'node-c.example.com' });
            return true;
        });
        await applyMode('rule', { silent: true });
        expect(knownSelection('a.yaml', 'Proxy')?.node).toBe('node-c.example.com');
    });

    it('keeps a choice recorded while the running profile was read', async () => {
        let reads = 0;
        api.invoke.mockImplementation(async (cmd) => {
            if (cmd !== 'get_settings') return null;
            // A node click lands during the first read, before the switch.
            if (reads++ === 0) noteKnownSelection('a.yaml', { group: 'Proxy', node: 'node-c.example.com' });
            return { last_config: 'a.yaml' };
        });
        await applyMode('rule', { silent: true });
        expect(api.switchProxy).toHaveBeenCalledWith('Proxy', 'node-b.example.com');
        expect(knownSelection('a.yaml', 'Proxy')?.node).toBe('node-c.example.com');
    });

    it('still records its node when a choice lands for another profile meanwhile', async () => {
        api.switchProxy.mockImplementation(async () => {
            noteKnownSelection('b.yaml', { group: 'Proxy', node: 'node-c.example.com' });
            return true;
        });
        await applyMode('rule', { silent: true });
        expect(knownSelection('a.yaml', 'Proxy')?.node).toBe('node-b.example.com');
        expect(knownSelection('b.yaml', 'Proxy')?.node).toBe('node-c.example.com');
    });

    it('leaves a group the user opened while the running profile was read', async () => {
        let reads = 0;
        api.invoke.mockImplementation(async (cmd) => {
            if (cmd !== 'get_settings') return null;
            if (reads++ === 0) appStore.set('uiGroupName', 'Streaming');
            return { last_config: 'a.yaml' };
        });
        await applyMode('rule', { silent: true });
        expect(api.switchProxy).toHaveBeenCalledWith('Proxy', 'node-b.example.com');
        expect(appStore.get('uiGroupName')).toBe('Streaming');
    });

    it('leaves a group the user opened while the switch ran', async () => {
        api.switchProxy.mockImplementation(async () => {
            appStore.set('uiGroupName', 'Streaming');
            return true;
        });
        await applyMode('rule', { silent: true });
        expect(appStore.get('uiGroupName')).toBe('Streaming');
    });
});
