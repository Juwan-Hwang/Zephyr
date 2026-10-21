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

    it('falls back to GLOBAL in global mode', async () => {
        api.getConfig.mockResolvedValue({ mode: 'Global' });
        groups.fetchProxyGroups.mockResolvedValue({
            ...result,
            data: { proxies: { GLOBAL: { type: 'Selector', all: ['HK'] }, ...result.data.proxies } },
        });
        api.switchProxy.mockImplementation(async (group) => group === 'GLOBAL');
        await expect(restoreProxySelectionResult('a.yaml')).resolves.toBe('restored');
        expect(api.switchProxy.mock.calls).toEqual([['Main', 'HK'], ['Backup', 'HK'], ['GLOBAL', 'HK']]);
        expect(store.set).toHaveBeenCalledWith('uiGroupName', 'GLOBAL');
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
});
