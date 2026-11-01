// @ts-nocheck
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Switch bookkeeping like api.js: the restore's own switches (switchProxy
// calls) plus the user's, started or still waiting for the core.
// A restore switch counts as started when it is made, as in api.js, and
// is sent (switchProxy called) only if canSend still allows it then.
const user = { starts: 0, inFlight: 0, cores: 0, own: 0, beforeCanSend: null, afterDrop: null };
const api = {
    invoke: vi.fn(),
    switchProxy: vi.fn(),
    // Running (in flight) from the start until its answer, canSend
    // included, as in api.js.
    switchProxyResult: async (group, name, opts = {}) => {
        user.own += 1;
        user.inFlight += 1;
        try {
            user.beforeCanSend?.();
            if (opts.canSend && !opts.canSend()) {
                user.afterDrop?.();
                return { ok: false, reason: 'busy' };
            }
            return { ok: await api.switchProxy(group, name), reason: null };
        } catch (error) {
            return { ok: false, reason: error, error };
        } finally {
            user.inFlight -= 1;
        }
    },
    getConfig: vi.fn(),
    proxySwitchMark: () => user.starts + user.own,
    proxySwitchedSince: (mark, own = 0, opts = {}) => user.starts + user.own - own !== mark
        || user.inFlight - (opts.ownInFlight ?? 0) > 0,
    coreReplacements: () => user.cores,
};
const groups = { fetchProxyGroups: vi.fn(), isWritableGroupType: (type) => type === 'Selector' };
const store = { set: vi.fn(), get: vi.fn(() => null) };

vi.mock('../api.js', () => api);
vi.mock('@zephyr/shared', () => ({ COMMANDS: { GET_SETTINGS: 'get_settings' } }));
vi.mock('./proxy-groups.js', () => groups);
vi.mock('./cache.js', () => ({ invalidateSettingsCache: vi.fn() }));
vi.mock('../utils/logger.js', () => ({ proxyMemoryLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('./state.js', () => ({ appStore: store }));

const { restoreProxySelectionResult } = await import('./proxy-memory.js');

const result = {
    uiGroupName: 'Main',
    proxies: ['HK'],
    data: {
        proxies: {
            Main: { type: 'Selector', all: ['HK'] },
            Auto: { type: 'URLTest', all: ['HK'] },
            Backup: { type: 'Selector', all: ['HK'] },
        },
    },
};

describe('restoreProxySelectionResult', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        user.starts = 0;
        user.inFlight = 0;
        user.own = 0;
        user.cores = 0;
        user.beforeCanSend = null;
        user.afterDrop = null;
        api.invoke.mockResolvedValue({ last_proxy_selection: { 'a.yaml': JSON.stringify({ group: 'Main', node: 'HK' }) } });
        groups.fetchProxyGroups.mockResolvedValue(result);
        api.getConfig.mockResolvedValue({ mode: 'rule' });
    });

    it('does not switch a core started for another profile while the restore waited', async () => {
        // Another profile's core starts while the groups are read.
        groups.fetchProxyGroups.mockImplementation(async () => { user.cores += 1; return result; });
        api.switchProxy.mockResolvedValue(true);
        await expect(restoreProxySelectionResult('a.yaml')).resolves.toBe('nothing');
        expect(api.switchProxy).not.toHaveBeenCalled();
    });

    it('falls back to another writable group when the core refuses the resolved one', async () => {
        api.switchProxy.mockImplementation(async (group) => group === 'Backup');
        await expect(restoreProxySelectionResult('a.yaml')).resolves.toBe('restored');
        expect(api.switchProxy.mock.calls).toEqual([['Main', 'HK'], ['Backup', 'HK']]);
        expect(store.set).toHaveBeenCalledWith('uiGroupName', 'Backup');
    });

    it('does not switch while a node switch of the user waits for the core', async () => {
        // Sent before the restore began, not answered yet: a restore switch
        // would go out after it and replace it.
        user.starts = 1;
        user.inFlight = 1;
        api.switchProxy.mockResolvedValue(true);
        await expect(restoreProxySelectionResult('a.yaml')).resolves.toBe('nothing');
        expect(api.switchProxy).not.toHaveBeenCalled();
    });

    it('stops trying groups once the user sends a switch during its own', async () => {
        api.switchProxy.mockImplementation(async (group) => {
            if (group === 'Main') user.starts += 1;
            return false;
        });
        await expect(restoreProxySelectionResult('a.yaml')).resolves.toBe('nothing');
        expect(api.switchProxy.mock.calls).toEqual([['Main', 'HK']]);
    });

    it('tries no other group once a switch is dropped unsent for a newer choice', async () => {
        // A switch of the user's is waiting when the restore's first one
        // gets its turn, and is answered before the restore looks again.
        user.beforeCanSend = () => {
            user.beforeCanSend = null;
            user.inFlight += 1;
            user.afterDrop = () => { user.inFlight -= 1; };
        };
        api.switchProxy.mockResolvedValue(true);
        await expect(restoreProxySelectionResult('a.yaml')).resolves.toBe('nothing');
        expect(api.switchProxy).not.toHaveBeenCalled();
    });

    it('still tries the other group when the core answers the first with an error', async () => {
        api.switchProxy.mockImplementation(async (group) => {
            if (group === 'Main') throw new Error('HTTP 400');
            return true;
        });
        await expect(restoreProxySelectionResult('a.yaml')).resolves.toBe('restored');
        expect(api.switchProxy.mock.calls).toEqual([['Main', 'HK'], ['Backup', 'HK']]);
        expect(store.set).toHaveBeenCalledWith('uiGroupName', 'Backup');
    });

    it('keeps going through every writable group that lists the node', async () => {
        groups.fetchProxyGroups.mockResolvedValue({
            ...result,
            data: { proxies: { ...result.data.proxies, Games: { type: 'Selector', all: ['HK'] } } },
        });
        api.switchProxy.mockImplementation(async (group) => group === 'Games');
        await expect(restoreProxySelectionResult('a.yaml')).resolves.toBe('restored');
        expect(api.switchProxy.mock.calls).toEqual([['Main', 'HK'], ['Backup', 'HK'], ['Games', 'HK']]);
        expect(store.set).toHaveBeenCalledWith('uiGroupName', 'Games');
    });

    it('tries the GLOBAL group only after every other group', async () => {
        groups.fetchProxyGroups.mockResolvedValue({
            ...result,
            data: { proxies: { GLOBAL: { type: 'Selector', all: ['HK'] }, ...result.data.proxies } },
        });
        api.switchProxy.mockImplementation(async (group) => group !== 'Main');
        await expect(restoreProxySelectionResult('a.yaml')).resolves.toBe('restored');
        expect(api.switchProxy.mock.calls).toEqual([['Main', 'HK'], ['Backup', 'HK']]);
        expect(store.set).toHaveBeenCalledWith('uiGroupName', 'Backup');
    });

    it('does not count a GLOBAL switch as restored in rule mode', async () => {
        groups.fetchProxyGroups.mockResolvedValue({
            ...result,
            data: { proxies: { GLOBAL: { type: 'Selector', all: ['HK'] }, ...result.data.proxies } },
        });
        api.switchProxy.mockImplementation(async (group) => group === 'GLOBAL');
        await expect(restoreProxySelectionResult('a.yaml')).resolves.toBe('failed');
        expect(api.switchProxy.mock.calls).toEqual([['Main', 'HK'], ['Backup', 'HK']]);
        expect(store.set).not.toHaveBeenCalled();
    });

    it('reports a failure when only GLOBAL lists the node and the mode is unreadable', async () => {
        api.getConfig.mockRejectedValue(new Error('core down'));
        groups.fetchProxyGroups.mockResolvedValue({
            uiGroupName: 'Main',
            proxies: [],
            data: { proxies: { GLOBAL: { type: 'Selector', all: ['HK'] }, Main: { type: 'Selector', all: ['JP'] } } },
        });
        await expect(restoreProxySelectionResult('a.yaml')).resolves.toBe('failed');
        expect(api.switchProxy).not.toHaveBeenCalled();
    });

    it('reports nothing to restore when no writable group lists the node', async () => {
        groups.fetchProxyGroups.mockResolvedValue({
            uiGroupName: 'Main',
            proxies: [],
            data: { proxies: { Main: { type: 'Selector', all: ['JP'] } } },
        });
        await expect(restoreProxySelectionResult('a.yaml')).resolves.toBe('nothing');
        expect(api.switchProxy).not.toHaveBeenCalled();
    });

    it('switches GLOBAL alone in global mode, even when another group would accept', async () => {
        api.getConfig.mockResolvedValue({ mode: 'Global' });
        groups.fetchProxyGroups.mockResolvedValue({
            ...result,
            data: { proxies: { GLOBAL: { type: 'Selector', all: ['HK'] }, ...result.data.proxies } },
        });
        api.switchProxy.mockResolvedValue(true);
        await expect(restoreProxySelectionResult('a.yaml')).resolves.toBe('restored');
        expect(api.switchProxy.mock.calls).toEqual([['GLOBAL', 'HK']]);
        expect(store.set).toHaveBeenCalledWith('uiGroupName', 'GLOBAL');
    });

    it('does not count another group as restored when GLOBAL routes and refuses', async () => {
        api.getConfig.mockResolvedValue({ mode: 'global' });
        groups.fetchProxyGroups.mockResolvedValue({
            ...result,
            uiGroupName: 'GLOBAL',
            data: { proxies: { GLOBAL: { type: 'Selector', all: ['HK'] }, ...result.data.proxies } },
        });
        api.switchProxy.mockImplementation(async (group) => group !== 'GLOBAL');
        await expect(restoreProxySelectionResult('a.yaml')).resolves.toBe('failed');
        expect(api.switchProxy.mock.calls).toEqual([['GLOBAL', 'HK']]);
        expect(store.set).not.toHaveBeenCalled();
    });

    it('does not switch a resolved GLOBAL group once the core left global mode', async () => {
        groups.fetchProxyGroups.mockResolvedValue({
            ...result,
            uiGroupName: 'GLOBAL',
            data: { proxies: { GLOBAL: { type: 'Selector', all: ['HK'] }, ...result.data.proxies } },
        });
        api.switchProxy.mockImplementation(async (group) => group === 'GLOBAL');
        await expect(restoreProxySelectionResult('a.yaml')).resolves.toBe('failed');
        expect(api.switchProxy.mock.calls).toEqual([['Main', 'HK'], ['Backup', 'HK']]);
        expect(store.set).not.toHaveBeenCalled();
    });

    it('does not count another group as restored when GLOBAL was resolved and the mode is unreadable', async () => {
        api.getConfig.mockRejectedValue(new Error('core down'));
        groups.fetchProxyGroups.mockResolvedValue({
            ...result,
            uiGroupName: 'GLOBAL',
            data: { proxies: { GLOBAL: { type: 'Selector', all: ['HK'] }, ...result.data.proxies } },
        });
        api.switchProxy.mockResolvedValue(true);
        await expect(restoreProxySelectionResult('a.yaml')).resolves.toBe('failed');
        expect(api.switchProxy).not.toHaveBeenCalled();
        expect(store.set).not.toHaveBeenCalled();
    });

    it('reports a failure only once every group refused the switch', async () => {
        api.switchProxy.mockResolvedValue(false);
        await expect(restoreProxySelectionResult('a.yaml')).resolves.toBe('failed');
        expect(api.switchProxy).toHaveBeenCalledTimes(2);
        expect(store.set).not.toHaveBeenCalled();
    });

    it('tries the resolved group first and stops there when it works', async () => {
        api.switchProxy.mockResolvedValue(true);
        await expect(restoreProxySelectionResult('a.yaml')).resolves.toBe('restored');
        expect(api.switchProxy.mock.calls).toEqual([['Main', 'HK']]);
    });

    it('leaves a group the user opened while the restore ran', async () => {
        const open = ['Main', 'Other'];
        store.get.mockImplementation((key) => (key === 'uiGroupName' ? (open.length > 1 ? open.shift() : open[0]) : null));
        api.switchProxy.mockImplementation(async (group) => group === 'Backup');
        await expect(restoreProxySelectionResult('a.yaml')).resolves.toBe('restored');
        expect(store.set).not.toHaveBeenCalledWith('uiGroupName', expect.anything());
        store.get.mockImplementation(() => null);
    });

    it('records a restored node as the known selection of its profile and group', async () => {
        api.switchProxy.mockResolvedValue(true);
        store.get.mockImplementation((key) => (key === 'uiGroupName' ? 'Main' : null));
        await expect(restoreProxySelectionResult('a.yaml')).resolves.toBe('restored');
        expect(store.set).toHaveBeenCalledWith('knownSelections', [{ profile: 'a.yaml', group: 'Main', node: 'HK' }]);
        store.get.mockImplementation(() => null);
    });

    it('keeps a choice the user made while the restore switch ran', async () => {
        /** @type {any[]} */
        let known = [];
        store.get.mockImplementation((key) => (key === 'uiGroupName' ? 'Main' : key === 'knownSelections' ? known : null));
        store.set.mockImplementation((key, value) => { if (key === 'knownSelections') known = value; });
        const { noteKnownSelection } = await import('./known-selection.js');
        api.switchProxy.mockImplementation(async () => {
            noteKnownSelection('a.yaml', { group: 'Main', node: 'picked.example.com' });
            return true;
        });
        // The user's choice is the newer one: the restore does not report
        // its own node as the one that stands.
        await expect(restoreProxySelectionResult('a.yaml')).resolves.toBe('nothing');
        expect(known).toEqual([{ profile: 'a.yaml', group: 'Main', node: 'picked.example.com' }]);
        store.get.mockImplementation(() => null);
        store.set.mockImplementation(() => {});
    });
    it('keeps a choice the user made while the saved settings were read', async () => {
        /** @type {any[]} */
        let known = [];
        store.get.mockImplementation((key) => (key === 'uiGroupName' ? 'Main' : key === 'knownSelections' ? known : null));
        store.set.mockImplementation((key, value) => { if (key === 'knownSelections') known = value; });
        const { noteKnownSelection } = await import('./known-selection.js');
        api.invoke.mockImplementation(async () => {
            noteKnownSelection('a.yaml', { group: 'Main', node: 'picked.example.com' });
            return { last_proxy_selection: { 'a.yaml': JSON.stringify({ group: 'Main', node: 'HK' }) } };
        });
        api.switchProxy.mockResolvedValue(true);
        // The user's node is newer: the saved one is not switched to at all.
        await expect(restoreProxySelectionResult('a.yaml')).resolves.toBe('nothing');
        expect(api.switchProxy).not.toHaveBeenCalled();
        expect(known).toEqual([{ profile: 'a.yaml', group: 'Main', node: 'picked.example.com' }]);
        store.get.mockImplementation(() => null);
        store.set.mockImplementation(() => {});
    });

    it('stops trying further groups once the user picked a node', async () => {
        /** @type {any[]} */
        let known = [];
        store.get.mockImplementation((key) => (key === 'knownSelections' ? known : null));
        store.set.mockImplementation((key, value) => { if (key === 'knownSelections') known = value; });
        const { noteKnownSelection } = await import('./known-selection.js');
        api.switchProxy.mockImplementation(async () => {
            // Refused, and meanwhile the user picked a node.
            noteKnownSelection('a.yaml', { group: 'Main', node: 'picked.example.com' });
            return false;
        });
        await expect(restoreProxySelectionResult('a.yaml')).resolves.toBe('nothing');
        expect(api.switchProxy.mock.calls).toEqual([['Main', 'HK']]);
        store.get.mockImplementation(() => null);
        store.set.mockImplementation(() => {});
    });

    it('reports nothing, not a failure, when the last group refuses after the user picked a node', async () => {
        /** @type {any[]} */
        let known = [];
        store.get.mockImplementation((key) => (key === 'knownSelections' ? known : null));
        store.set.mockImplementation((key, value) => { if (key === 'knownSelections') known = value; });
        const { noteKnownSelection } = await import('./known-selection.js');
        // Only one group lists the node, so its refusal is the last try.
        groups.fetchProxyGroups.mockResolvedValue({
            uiGroupName: 'Main',
            proxies: ['HK'],
            data: { proxies: { Main: { type: 'Selector', all: ['HK'] } } },
        });
        api.switchProxy.mockImplementation(async () => {
            noteKnownSelection('a.yaml', { group: 'Main', node: 'picked.example.com' });
            return false;
        });
        await expect(restoreProxySelectionResult('a.yaml')).resolves.toBe('nothing');
        store.get.mockImplementation(() => null);
        store.set.mockImplementation(() => {});
    });

    it('does not clear a stale entry once a newer choice replaced it', async () => {
        /** @type {any[]} */
        let known = [];
        store.get.mockImplementation((key) => (key === 'knownSelections' ? known : null));
        store.set.mockImplementation((key, value) => { if (key === 'knownSelections') known = value; });
        const { noteKnownSelection } = await import('./known-selection.js');
        api.invoke.mockImplementation(async (cmd) => {
            if (cmd !== 'get_settings') return null;
            return { last_proxy_selection: { 'a.yaml': JSON.stringify({ group: 'Main', node: 'Main' }) } };
        });
        // Picked while the restore waits for the core: the stale Main/Main
        // entry read before it still reaches the cleanup.
        groups.fetchProxyGroups.mockImplementationOnce(async () => {
            noteKnownSelection('a.yaml', { group: 'Main', node: 'picked.example.com' });
            return result;
        });
        await expect(restoreProxySelectionResult('a.yaml')).resolves.toBe('nothing');
        expect(api.invoke.mock.calls.filter(([cmd]) => cmd !== 'get_settings')).toEqual([]);
        expect(known).toEqual([{ profile: 'a.yaml', group: 'Main', node: 'picked.example.com' }]);
        store.get.mockImplementation(() => null);
        store.set.mockImplementation(() => {});
    });
    it('keeps a group the user opens while the restore waits for the core', async () => {
        let open = 'Main';
        store.get.mockImplementation((key) => (key === 'uiGroupName' ? open : null));
        store.set.mockImplementation((key, value) => { if (key === 'uiGroupName') open = value; });
        groups.fetchProxyGroups.mockImplementationOnce(async () => {
            open = 'Games';
            return result;
        });
        api.switchProxy.mockImplementation(async (group) => group === 'Backup');
        await expect(restoreProxySelectionResult('a.yaml')).resolves.toBe('restored');
        expect(open).toBe('Games');
        store.get.mockImplementation(() => null);
        store.set.mockImplementation(() => {});
    });

    it('restores the choice recorded in this session over an older saved one', async () => {
        // The user picked JP; writing it to the settings failed, so they
        // still hold HK.
        /** @type {any[]} */
        let known = [];
        store.get.mockImplementation((key) => (key === 'knownSelections' ? known : null));
        store.set.mockImplementation((key, value) => { if (key === 'knownSelections') known = value; });
        const { noteKnownSelection } = await import('./known-selection.js');
        noteKnownSelection('a.yaml', { group: 'Main', node: 'JP' });
        groups.fetchProxyGroups.mockResolvedValue({
            uiGroupName: 'Main',
            proxies: ['HK', 'JP'],
            data: { proxies: { Main: { type: 'Selector', all: ['HK', 'JP'] } } },
        });
        api.switchProxy.mockResolvedValue(true);
        await expect(restoreProxySelectionResult('a.yaml')).resolves.toBe('restored');
        expect(api.switchProxy.mock.calls).toEqual([['Main', 'JP']]);
        store.get.mockImplementation(() => null);
        store.set.mockImplementation(() => {});
    });
});
