// @ts-nocheck
import { describe, it, expect, vi, beforeEach } from 'vitest';

const api = { invoke: vi.fn(), switchProxy: vi.fn(), getConfig: vi.fn() };
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
        api.invoke.mockResolvedValue({ last_proxy_selection: { 'a.yaml': JSON.stringify({ group: 'Main', node: 'HK' }) } });
        groups.fetchProxyGroups.mockResolvedValue(result);
        api.getConfig.mockResolvedValue({ mode: 'rule' });
    });

    it('falls back to another writable group when the core refuses the resolved one', async () => {
        api.switchProxy.mockImplementation(async (group) => group === 'Backup');
        await expect(restoreProxySelectionResult('a.yaml')).resolves.toBe('restored');
        expect(api.switchProxy.mock.calls).toEqual([['Main', 'HK'], ['Backup', 'HK']]);
        expect(store.set).toHaveBeenCalledWith('uiGroupName', 'Backup');
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
        await expect(restoreProxySelectionResult('a.yaml')).resolves.toBe('restored');
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

    it('does not clear a stale entry once a newer choice replaced it', async () => {
        /** @type {any[]} */
        let known = [];
        store.get.mockImplementation((key) => (key === 'knownSelections' ? known : null));
        store.set.mockImplementation((key, value) => { if (key === 'knownSelections') known = value; });
        const { noteKnownSelection } = await import('./known-selection.js');
        api.invoke.mockImplementation(async (cmd) => {
            if (cmd !== 'get_settings') return null;
            noteKnownSelection('a.yaml', { group: 'Main', node: 'picked.example.com' });
            return { last_proxy_selection: { 'a.yaml': JSON.stringify({ group: 'Main', node: 'Main' }) } };
        });
        await expect(restoreProxySelectionResult('a.yaml')).resolves.toBe('nothing');
        expect(api.invoke.mock.calls.filter(([cmd]) => cmd !== 'get_settings')).toEqual([]);
        expect(known).toEqual([{ profile: 'a.yaml', group: 'Main', node: 'picked.example.com' }]);
        store.get.mockImplementation(() => null);
        store.set.mockImplementation(() => {});
    });
});
