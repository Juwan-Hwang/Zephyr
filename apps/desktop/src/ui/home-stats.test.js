import { describe, it, expect, vi } from 'vitest';

vi.mock('../api.js', () => ({ getConnections: vi.fn(), getProxiesMerged: vi.fn() }));
vi.mock('./cache.js', () => ({ getProxiesCached: vi.fn() }));

const { splitBytes, resolveLeaf, displayedLeaf } = await import('./home-stats.js');
const { appStore } = await import('./state.js');

describe('home stats helpers', () => {
    it('splits a formatted size into figure and unit', () => {
        expect(splitBytes(0)).toEqual(['0', 'B']);
        expect(splitBytes(1_500_000)).toEqual(['1.50', 'MB']);
        expect(splitBytes(-5)).toEqual(['0', 'B']);
    });

    it('follows a group chain down to the leaf node', () => {
        const proxies = {
            'Select': { name: 'Select', all: ['Auto', 'HK'], now: 'Auto' },
            'Auto': { name: 'Auto', all: ['HK'], now: 'HK' },
            'HK': { name: 'HK', history: [{ delay: 24 }] },
        };
        expect(resolveLeaf(proxies, 'Select')?.name).toBe('HK');
        expect(resolveLeaf(proxies, 'HK')?.name).toBe('HK');
        expect(resolveLeaf(proxies, 'missing')).toBeUndefined();
    });

    it('does not loop forever on a cyclic group', () => {
        const proxies = { A: { name: 'A', all: ['B'], now: 'B' }, B: { name: 'B', all: ['A'], now: 'A' } };
        expect(['A', 'B']).toContain(resolveLeaf(proxies, 'A')?.name);
    });

    it('names the observed exit node when it belongs to the selected group', () => {
        const proxies = {
            'Select': { name: 'Select', all: ['Auto', 'JP'], now: 'Auto' },
            'Auto': { name: 'Auto', all: ['HK', 'SG'], now: 'HK' },
            'HK': { name: 'HK' }, 'SG': { name: 'SG' }, 'JP': { name: 'JP' }, 'US': { name: 'US' },
        };
        appStore.set('observedGroupName', 'Auto');
        appStore.set('observedNodeName', 'SG');
        expect(displayedLeaf(proxies, 'Select')?.name).toBe('SG');
        appStore.set('observedNodeName', 'US');
        expect(displayedLeaf(proxies, 'Select')?.name).toBe('HK');
        appStore.set('observedNodeName', null);
        appStore.set('observedGroupName', null);
        expect(displayedLeaf(proxies, 'Select')?.name).toBe('HK');
    });
});
