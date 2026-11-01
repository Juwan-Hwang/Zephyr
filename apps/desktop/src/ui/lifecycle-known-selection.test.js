import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const api = {
    abortLatencyTests: vi.fn(),
    closeAllConnections: vi.fn(async () => {}),
    restartCore: vi.fn(),
    invoke: vi.fn(),
};
vi.mock('../api.js', () => api);
vi.mock('./notifications.js', () => ({ showNotification: vi.fn() }));
vi.mock('./prism.js', () => ({ rebuild: vi.fn(async () => {}), overrideApplyAll: vi.fn(async () => []) }));
vi.mock('./proxy-memory.js', () => ({
    restoreProxySelection: vi.fn(async () => {}),
    restoreProxySelectionResult: vi.fn(async () => 'restored'),
    saveProxySelection: vi.fn(async () => {}),
    waitForMihomoReady: vi.fn(async () => true),
}));
vi.mock('./proxy-groups.js', () => ({ fetchProxyGroups: vi.fn() }));
vi.mock('./proxies.js', () => ({ startSmartAutoTest: vi.fn(), syncCoreConfig: vi.fn(async () => {}) }));

const { switchToConfig } = await import('./lifecycle.js');
const memory = await import('./proxy-memory.js');
const groups = await import('./proxy-groups.js');
const { appStore } = await import('./state.js');
const { noteKnownSelection, knownSelection } = await import('./known-selection.js');

/** Switch while the core never answers the group read; let the 500 ms timeout fire. */
async function switchWhileCoreBusy(target) {
    groups.fetchProxyGroups.mockImplementation(() => new Promise(() => {}));
    const pending = switchToConfig(target);
    await vi.advanceTimersByTimeAsync(600);
    return pending;
}

describe('saving the selection before a profile switch', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();
        appStore.set('uiGroupName', 'Main');
        appStore.set('lastKnownSelection', null);
        api.restartCore.mockResolvedValue({ secret: 's', port: 9090, active_config: 'b.yaml' });
        api.invoke.mockImplementation(async (cmd) => (cmd === 'get_settings' ? { last_config: 'a.yaml' } : null));
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('fetch timeout still saves the known selection', async () => {
        noteKnownSelection('a.yaml', { group: 'Main', node: 'node-1.example.com' });
        await switchWhileCoreBusy('b.yaml');
        expect(memory.saveProxySelection).toHaveBeenCalledWith('a.yaml', { node: 'node-1.example.com', group: 'Main' });
    });

    it('a failed read also falls back to the known selection', async () => {
        noteKnownSelection('a.yaml', { group: 'Main', node: 'node-2.example.com' });
        groups.fetchProxyGroups.mockRejectedValue(new Error('core busy'));
        await switchToConfig('b.yaml');
        expect(memory.saveProxySelection).toHaveBeenCalledWith('a.yaml', { node: 'node-2.example.com', group: 'Main' });
    });

    it('does not save a choice known for another profile', async () => {
        noteKnownSelection('c.yaml', { group: 'Main', node: 'node-3.example.com' });
        await switchWhileCoreBusy('b.yaml');
        expect(memory.saveProxySelection).not.toHaveBeenCalled();
    });

    it('does not save a choice known for another group', async () => {
        noteKnownSelection('a.yaml', { group: 'Other', node: 'node-4.example.com' });
        await switchWhileCoreBusy('b.yaml');
        expect(memory.saveProxySelection).not.toHaveBeenCalled();
    });

    it('does not save a choice whose group is unknown for the current group', async () => {
        noteKnownSelection('a.yaml', { node: 'node-5.example.com' });
        await switchWhileCoreBusy('b.yaml');
        expect(memory.saveProxySelection).not.toHaveBeenCalled();
    });

    it('prefers the live selection when the core answers', async () => {
        noteKnownSelection('a.yaml', { group: 'Main', node: 'stale.example.com' });
        groups.fetchProxyGroups.mockResolvedValue({ current: 'live.example.com', uiGroupName: 'Main' });
        await switchToConfig('b.yaml');
        expect(memory.saveProxySelection).toHaveBeenCalledWith('a.yaml', { node: 'live.example.com', group: 'Main' });
    });
});

describe('known selection cache', () => {
    it('is bound to profile and group, and clears on an empty record', () => {
        noteKnownSelection('a.yaml', { group: 'Main', node: 'n.example.com' });
        expect(knownSelection('a.yaml', 'Main')).toEqual({ profile: 'a.yaml', group: 'Main', node: 'n.example.com' });
        expect(knownSelection('a.yaml')).not.toBeNull();
        expect(knownSelection('b.yaml', 'Main')).toBeNull();
        expect(knownSelection('a.yaml', 'Other')).toBeNull();
        noteKnownSelection('a.yaml', { node: 'n.example.com' });
        expect(knownSelection('a.yaml', 'Main')).toBeNull();
        expect(knownSelection('a.yaml')).toEqual({ profile: 'a.yaml', group: null, node: 'n.example.com' });
        noteKnownSelection('a.yaml', { group: '', node: '' });
        expect(knownSelection('a.yaml')).toBeNull();
    });
});
