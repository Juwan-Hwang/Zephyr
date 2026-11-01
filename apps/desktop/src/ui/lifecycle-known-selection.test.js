import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const api = {
    abortLatencyTests: vi.fn(),
    closeAllConnections: vi.fn(async () => {}),
    restartCore: vi.fn(),
    invoke: vi.fn(),
    proxySwitchMark: vi.fn(() => 0),
    proxySwitchedSince: vi.fn(() => false),
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
const { noteKnownSelection, knownSelection, renameKnownSelection, knownSelectionRevision, knownSelectionChangedSince, MAX_KNOWN_PROFILES } = await import('./known-selection.js');

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
        appStore.set('knownSelections', []);
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

    it('does not save a known choice when no group is picked in the UI', async () => {
        // The UI group was reset (its group is gone): the known choice may be
        // from a group the profile no longer has.
        appStore.set('uiGroupName', null);
        noteKnownSelection('a.yaml', { group: 'Old', node: 'node-6.example.com' });
        await switchWhileCoreBusy('b.yaml');
        expect(memory.saveProxySelection).not.toHaveBeenCalled();
    });

    it('a late save for another profile does not replace the running profile\'s choice', async () => {
        // b.yaml runs now; a node click on a.yaml saved after the switch lands late.
        api.invoke.mockImplementation(async (cmd) => (cmd === 'get_settings' ? { last_config: 'b.yaml' } : null));
        api.restartCore.mockResolvedValue({ secret: 's', port: 9090, active_config: 'c.yaml' });
        noteKnownSelection('b.yaml', { group: 'Main', node: 'node-b.example.com' });
        noteKnownSelection('a.yaml', { group: 'Main', node: 'node-a.example.com' });
        await switchWhileCoreBusy('c.yaml');
        expect(memory.saveProxySelection).toHaveBeenCalledWith('b.yaml', { node: 'node-b.example.com', group: 'Main' });
    });

    it('prefers the live selection when the core answers', async () => {
        noteKnownSelection('a.yaml', { group: 'Main', node: 'stale.example.com' });
        groups.fetchProxyGroups.mockResolvedValue({ current: 'live.example.com', uiGroupName: 'Main' });
        await switchToConfig('b.yaml');
        expect(memory.saveProxySelection).toHaveBeenCalledWith('a.yaml', { node: 'live.example.com', group: 'Main' });
    });

    it('does not save the live node over a choice made while the settings were read', async () => {
        groups.fetchProxyGroups.mockResolvedValue({ current: 'older.example.com', uiGroupName: 'Main' });
        let first = true;
        api.invoke.mockImplementation(async (cmd) => {
            if (cmd !== 'get_settings') return null;
            // The user's newer pick lands while the settings are read.
            if (first) noteKnownSelection('a.yaml', { group: 'Main', node: 'newer.example.com' });
            first = false;
            return { last_config: 'a.yaml' };
        });
        await switchToConfig('b.yaml');
        expect(memory.saveProxySelection).not.toHaveBeenCalledWith('a.yaml', { node: 'older.example.com', group: 'Main' });
    });

    it('does not save the live node while a node switch waits for the core', async () => {
        groups.fetchProxyGroups.mockResolvedValue({ current: 'replaced.example.com', uiGroupName: 'Main' });
        // The user's switch is sent but not answered: its node is not recorded yet.
        api.proxySwitchedSince.mockReturnValue(true);
        try {
            await switchToConfig('b.yaml');
        } finally {
            api.proxySwitchedSince.mockReturnValue(false);
        }
        expect(memory.saveProxySelection).not.toHaveBeenCalledWith('a.yaml', { node: 'replaced.example.com', group: 'Main' });
    });

    it('saves nothing when the core answers with no selection', async () => {
        // A read that succeeded is not a timeout: the known choice is not
        // what the core runs now, so it does not replace the saved one.
        noteKnownSelection('a.yaml', { group: 'Main', node: 'stale.example.com' });
        groups.fetchProxyGroups.mockResolvedValue({ current: null, uiGroupName: 'Main' });
        await switchToConfig('b.yaml');
        expect(memory.saveProxySelection).not.toHaveBeenCalled();
    });
});

describe('known selection cache', () => {
    beforeEach(() => {
        appStore.set('knownSelections', []);
    });

    it('changes its revision with every record', () => {
        const before = knownSelectionRevision();
        noteKnownSelection('a.yaml', { group: 'Main', node: 'n.example.com' });
        const afterNote = knownSelectionRevision();
        expect(afterNote).not.toBe(before);
        noteKnownSelection('a.yaml', {});
        expect(knownSelectionRevision()).not.toBe(afterNote);
    });

    it('tells a record for this profile from one for another', () => {
        const since = knownSelectionRevision();
        noteKnownSelection('b.yaml', { group: 'Main', node: 'n.example.com' });
        expect(knownSelectionChangedSince(since, 'a.yaml')).toBe(false);
        expect(knownSelectionChangedSince(since, 'b.yaml')).toBe(true);
        renameKnownSelection('b.yaml', 'c.yaml');
        expect(knownSelectionChangedSince(since, 'c.yaml')).toBe(true);
        // The old name no longer names the profile: a save for it is stale.
        expect(knownSelectionChangedSince(since, 'b.yaml')).toBe(true);
    });

    it('a rename counts as a change for the old name, so a save still running for it records nothing', () => {
        noteKnownSelection('old.yaml', { group: 'Main', node: 'node-1.example.com' });
        const since = knownSelectionRevision();
        renameKnownSelection('old.yaml', 'new.yaml');
        expect(knownSelectionChangedSince(since, 'old.yaml')).toBe(true);
        // The moved record keeps its time under the new name.
        expect(knownSelectionChangedSince(since, 'new.yaml')).toBe(false);
    });

    it('a rename from a profile with no known choice drops the one under the new name', () => {
        noteKnownSelection('target.yaml', { group: 'Main', node: 'old-file.example.com' });
        const since = knownSelectionRevision();
        renameKnownSelection('unknown.yaml', 'target.yaml');
        // The file now called target.yaml is another one: its choice is unknown,
        // and a save still running for the file that had the name counts as older.
        expect(knownSelection('target.yaml')).toBeNull();
        expect(knownSelectionChangedSince(since, 'target.yaml')).toBe(true);
    });

    it('keeps record times for a bounded number of profiles; a dropped one still counts as newer', () => {
        const since = knownSelectionRevision();
        noteKnownSelection('first.yaml', {});
        for (let i = 0; i < 100; i++) noteKnownSelection(`p${i}.yaml`, {});
        // first.yaml's time was dropped, but it may be newer than `since`.
        expect(knownSelectionChangedSince(since, 'first.yaml')).toBe(true);
        // Asked from after the drops, nothing newer was recorded for it.
        expect(knownSelectionChangedSince(knownSelectionRevision(), 'first.yaml')).toBe(false);
        expect(knownSelectionChangedSince(since, 'p99.yaml')).toBe(true);
    });

    it('does not count records of other profiles leaving the bound as a newer choice', () => {
        const since = knownSelectionRevision();
        for (let i = 0; i < 100; i++) noteKnownSelection(`other${i}.yaml`, {});
        // never.yaml has no record: other profiles' records being dropped
        // from the recent set is no choice made for it.
        expect(knownSelectionChangedSince(since, 'never.yaml')).toBe(false);
        // An evicted record keeps its own time, and moves on a rename.
        expect(knownSelectionChangedSince(since, 'other0.yaml')).toBe(true);
        renameKnownSelection('other0.yaml', 'renamed0.yaml');
        expect(knownSelectionChangedSince(since, 'renamed0.yaml')).toBe(true);
        expect(knownSelectionChangedSince(since, 'other0.yaml')).toBe(true);
    });

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

    it('follows a renamed profile to its new name', () => {
        noteKnownSelection('a.yaml', { group: 'Main', node: 'a.example.com' });
        noteKnownSelection('b.yaml', { group: 'Main', node: 'b.example.com' });
        noteKnownSelection('c.yaml', { group: 'Main', node: 'c.example.com' });
        // c.yaml becomes b.yaml: the old b.yaml record belonged to a file that
        // no longer has that name.
        renameKnownSelection('c.yaml', 'b.yaml');
        expect(knownSelection('c.yaml')).toBeNull();
        expect(knownSelection('b.yaml', 'Main')?.node).toBe('c.example.com');
        expect(appStore.get('knownSelections')).toHaveLength(2);
        renameKnownSelection('a.yaml', 'a.yaml');
        renameKnownSelection('missing.yaml', 'd.yaml');
        expect(knownSelection('a.yaml', 'Main')?.node).toBe('a.example.com');
        expect(knownSelection('d.yaml')).toBeNull();
    });

    it('keeps one choice per profile, bounded, dropping the oldest record first', () => {
        noteKnownSelection('a.yaml', { group: 'Main', node: 'a.example.com' });
        noteKnownSelection('b.yaml', { group: 'Main', node: 'b.example.com' });
        expect(knownSelection('a.yaml', 'Main')?.node).toBe('a.example.com');
        expect(knownSelection('b.yaml', 'Main')?.node).toBe('b.example.com');
        // A profile name that is an Object.prototype key is just a name.
        noteKnownSelection('__proto__', { group: 'Main', node: 'p.example.com' });
        expect(knownSelection('__proto__', 'Main')?.node).toBe('p.example.com');
        expect(knownSelection('constructor')).toBeNull();

        // a.yaml recorded again: now the most recent, so it outlives b.yaml.
        noteKnownSelection('a.yaml', { group: 'Main', node: 'a2.example.com' });
        for (let i = 0; i < MAX_KNOWN_PROFILES - 1; i++) {
            noteKnownSelection(`p${i}.yaml`, { group: 'Main', node: `n${i}.example.com` });
        }
        expect(appStore.get('knownSelections')).toHaveLength(MAX_KNOWN_PROFILES);
        expect(knownSelection('b.yaml')).toBeNull();
        expect(knownSelection('__proto__')).toBeNull();
        expect(knownSelection('a.yaml', 'Main')?.node).toBe('a2.example.com');
    });
});
