import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock API + run-config-cache so fetchProxyGroups can be tested in isolation
vi.mock('../api.js', async (importOriginal) => {
    const real = await importOriginal();
    return {
        ...real,
        getProxies: vi.fn(),
        getConfig: vi.fn(),
    };
});
vi.mock('./run-config-cache.js', () => ({
    getRunConfigCached: vi.fn(),
    invalidateRunConfigCache: vi.fn(),
}));

import { getProxies, getConfig } from '../api.js';
import { getRunConfigCached } from './run-config-cache.js';
import { buildIncludeAllSet, fetchProxyGroups } from './proxy-groups.js';

// ─── buildIncludeAllSet ─────────────────────────────────────────────────────

describe('buildIncludeAllSet', () => {
    it('returns empty set for null runConfig', () => {
        expect(buildIncludeAllSet(null).size).toBe(0);
    });

    it('returns empty set for undefined runConfig', () => {
        expect(buildIncludeAllSet(undefined).size).toBe(0);
    });

    it('returns empty set when proxy-groups is missing', () => {
        expect(buildIncludeAllSet({ mode: 'rule' }).size).toBe(0);
    });

    it('returns empty set when proxy-groups is empty', () => {
        expect(buildIncludeAllSet({ 'proxy-groups': [] }).size).toBe(0);
    });

    it('returns empty set when no groups use include-all', () => {
        const rc = { 'proxy-groups': [{ name: 'Auto', type: 'url-test', proxies: ['A'] }] };
        expect(buildIncludeAllSet(rc).size).toBe(0);
    });

    it('detects include-all flag', () => {
        const rc = { 'proxy-groups': [{ name: 'All', type: 'select', 'include-all': true }] };
        const set = buildIncludeAllSet(rc);
        expect(set.has('All')).toBe(true);
        expect(set.size).toBe(1);
    });

    it('detects include-all-providers flag', () => {
        const rc = { 'proxy-groups': [{ name: 'Providers', type: 'select', 'include-all-providers': true }] };
        const set = buildIncludeAllSet(rc);
        expect(set.has('Providers')).toBe(true);
    });

    it('detects both flags across multiple groups', () => {
        const rc = {
            'proxy-groups': [
                { name: 'A', 'include-all': true },
                { name: 'B', 'include-all-providers': true },
                { name: 'C', proxies: ['x'] },            // neither flag
                { name: 'D', 'include-all': false },       // explicit false
            ],
        };
        const set = buildIncludeAllSet(rc);
        expect(set.size).toBe(2);
        expect(set.has('A')).toBe(true);
        expect(set.has('B')).toBe(true);
        expect(set.has('C')).toBe(false);
        expect(set.has('D')).toBe(false);
    });

    it('skips entries without a name', () => {
        const rc = { 'proxy-groups': [{ 'include-all': true }, { name: 'OK', 'include-all': true }] };
        const set = buildIncludeAllSet(rc);
        expect(set.size).toBe(1);
        expect(set.has('OK')).toBe(true);
    });

    it('handles non-array proxy-groups gracefully', () => {
        expect(buildIncludeAllSet({ 'proxy-groups': 'not-an-array' }).size).toBe(0);
    });
});

// ─── providerLoading detection via fetchProxyGroups ─────────────────────────

describe('fetchProxyGroups providerLoading', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    async function setup(opts = {}) {
        const {
            proxies = {},
            mode = 'rule',
            runConfig = {},
            preferredGroupName = null,
        } = opts;

        getProxies.mockResolvedValue({ proxies });
        getConfig.mockResolvedValue({ mode });
        getRunConfigCached.mockResolvedValue(runConfig);

        return fetchProxyGroups({ preferredGroupName });
    }

    it('providerLoading=true when include-all group has empty all[] and proxy-providers exist', async () => {
        const result = await setup({
            proxies: {
                GLOBAL: { type: 'Selector', all: [], now: null },
                MyGroup: { type: 'Selector', all: [], now: null },
            },
            mode: 'rule',
            runConfig: {
                'proxy-providers': { 'prov1': { type: 'http', url: 'http://example.com' } },
                'proxy-groups': [
                    { name: 'MyGroup', type: 'select', 'include-all': true },
                ],
            },
            preferredGroupName: 'MyGroup',
        });
        expect(result).not.toBeNull();
        expect(result.providerLoading).toBe(true);
    });

    it('providerLoading=false when include-all group has nodes', async () => {
        const result = await setup({
            proxies: {
                MyGroup: { type: 'Selector', all: ['node1', 'node2'], now: 'node1' },
            },
            runConfig: {
                'proxy-providers': { 'prov1': { type: 'http' } },
                'proxy-groups': [{ name: 'MyGroup', 'include-all': true }],
            },
            preferredGroupName: 'MyGroup',
        });
        expect(result.providerLoading).toBe(false);
        expect(result.proxies).toEqual(['node1', 'node2']);
    });

    it('providerLoading=false when no proxy-providers configured', async () => {
        const result = await setup({
            proxies: {
                MyGroup: { type: 'Selector', all: [], now: null },
            },
            runConfig: {
                'proxy-groups': [{ name: 'MyGroup', 'include-all': true }],
            },
            preferredGroupName: 'MyGroup',
        });
        expect(result.providerLoading).toBe(false);
    });

    it('providerLoading=false when group does not use include-all', async () => {
        const result = await setup({
            proxies: {
                ManualGroup: { type: 'Selector', all: [], now: null },
            },
            runConfig: {
                'proxy-providers': { 'prov1': { type: 'http' } },
                'proxy-groups': [{ name: 'ManualGroup', proxies: ['A'] }],
            },
            preferredGroupName: 'ManualGroup',
        });
        expect(result.providerLoading).toBe(false);
    });

    it('providerLoading=true when all[] has only COMPATIBLE (the reported bug)', async () => {
        const result = await setup({
            proxies: {
                MyGroup: { type: 'Selector', all: ['COMPATIBLE'], now: 'COMPATIBLE' },
            },
            runConfig: {
                'proxy-providers': { 'prov1': { type: 'http' } },
                'proxy-groups': [{ name: 'MyGroup', 'include-all': true }],
            },
            preferredGroupName: 'MyGroup',
        });
        expect(result.providerLoading).toBe(true);
    });

    it('providerLoading=true when all[] has only lowercase special entries', async () => {
        const result = await setup({
            proxies: {
                MyGroup: { type: 'Selector', all: ['compatible', 'reject'], now: 'compatible' },
            },
            runConfig: {
                'proxy-providers': { 'prov1': { type: 'http' } },
                'proxy-groups': [{ name: 'MyGroup', 'include-all': true }],
            },
            preferredGroupName: 'MyGroup',
        });
        expect(result.providerLoading).toBe(true);
    });

    it('providerLoading=false when all[] has special entries mixed with real nodes', async () => {
        const result = await setup({
            proxies: {
                MyGroup: { type: 'Selector', all: ['COMPATIBLE', 'real-node'], now: 'real-node' },
            },
            runConfig: {
                'proxy-providers': { 'prov1': { type: 'http' } },
                'proxy-groups': [{ name: 'MyGroup', 'include-all': true }],
            },
            preferredGroupName: 'MyGroup',
        });
        expect(result.providerLoading).toBe(false);
        expect(result.proxies).toEqual(['COMPATIBLE', 'real-node']);
    });

    it('providerLoading=true when all[] has only local proxies (not from providers)', async () => {
        // This is the exact bug from the 2026-07-28 log:
        // all=['🟢 直连'] where 🟢 直连 is a local proxy, not from a provider.
        // The old code treated it as "loaded" because 🟢 直连 was not in
        // SPECIAL_GROUPS.  The new code checks runConfig.proxies to identify
        // local proxies and correctly detects the loading state.
        const result = await setup({
            proxies: {
                MyGroup: { type: 'Selector', all: ['🟢 直连'], now: '🟢 直连' },
            },
            runConfig: {
                'proxy-providers': { 'prov1': { type: 'http' } },
                'proxies': [
                    { name: '🟢 直连', type: 'direct' },
                ],
                'proxy-groups': [{ name: 'MyGroup', 'include-all': true }],
            },
            preferredGroupName: 'MyGroup',
        });
        expect(result.providerLoading).toBe(true);
    });

    it('providerLoading=true when all[] has local proxies + group refs but no provider proxies', async () => {
        const result = await setup({
            proxies: {
                MyGroup: { type: 'Selector', all: ['🟢 直连', '♻️ 自动选择'], now: '🟢 直连' },
            },
            runConfig: {
                'proxy-providers': { 'prov1': { type: 'http' } },
                'proxies': [
                    { name: '🟢 直连', type: 'direct' },
                ],
                'proxy-groups': [
                    { name: 'MyGroup', 'include-all': true },
                    { name: '♻️ 自动选择', type: 'url-test', 'include-all': true },
                ],
            },
            preferredGroupName: 'MyGroup',
        });
        expect(result.providerLoading).toBe(true);
    });

    it('providerLoading=false when local proxies mixed with provider proxies', async () => {
        const result = await setup({
            proxies: {
                MyGroup: { type: 'Selector', all: ['🟢 直连', 'provider-node-1'], now: 'provider-node-1' },
            },
            runConfig: {
                'proxy-providers': { 'prov1': { type: 'http' } },
                'proxies': [
                    { name: '🟢 直连', type: 'direct' },
                ],
                'proxy-groups': [{ name: 'MyGroup', 'include-all': true }],
            },
            preferredGroupName: 'MyGroup',
        });
        expect(result.providerLoading).toBe(false);
        expect(result.proxies).toEqual(['🟢 直连', 'provider-node-1']);
    });

it('GLOBAL group treated as include-all in global mode', async () => {
const result = await setup({
proxies: {
GLOBAL: { type: 'Selector', all: [], now: null },
},
mode: 'global',
runConfig: {
'proxy-providers': { 'prov1': { type: 'http' } },
'proxy-groups': [],
},
});
expect(result.uiGroupName).toBe('GLOBAL');
// GLOBAL's all[] contains group references, not direct provider proxies,
// so providerLoading is never true for GLOBAL — it's handled by the
// include-all groups it references.
expect(result.providerLoading).toBe(false);
});

    it('providerLoading=false when proxy-providers object is empty', async () => {
        const result = await setup({
            proxies: {
                MyGroup: { type: 'Selector', all: [], now: null },
            },
            runConfig: {
                'proxy-providers': {},
                'proxy-groups': [{ name: 'MyGroup', 'include-all': true }],
            },
            preferredGroupName: 'MyGroup',
        });
        expect(result.providerLoading).toBe(false);
    });

    it('returns null when getProxies returns null', async () => {
        getProxies.mockResolvedValue(null);
        getConfig.mockResolvedValue({ mode: 'rule' });
        getRunConfigCached.mockResolvedValue({});
        const result = await fetchProxyGroups();
        expect(result).toBeNull();
    });
});
