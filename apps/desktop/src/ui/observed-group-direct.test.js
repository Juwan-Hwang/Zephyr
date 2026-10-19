import { describe, it, expect, vi } from 'vitest';

vi.mock('../api.js', () => ({
    getConnections: vi.fn(),
    isCoreReachable: vi.fn(() => true),
    SPECIAL_PROXY_NAMES: Object.freeze(new Set(['DIRECT', 'REJECT', 'REJECT-DROP', 'COMPATIBLE', 'PASS', 'PASS-RULE'])),
}));
vi.mock('./cache.js', () => ({ getProxiesCached: vi.fn() }));

const { computeObservedGroup } = await import('./observed-group.js');

const proxies = {
    Manual: { type: 'Selector', now: 'HK 01', all: ['HK 01'] },
    Apple: { type: 'Selector', now: 'DirectGroup', all: ['DirectGroup', 'Manual'] },
    DirectGroup: { type: 'Selector', now: 'DIRECT', all: ['DIRECT'] },
};

describe('computeObservedGroup', () => {
    it('ignores connections that leave DIRECT or are rejected', () => {
        const conns = [
            ...Array.from({ length: 6 }, () => ({ chains: ['DIRECT', 'DirectGroup', 'Apple'] })),
            ...Array.from({ length: 2 }, () => ({ chains: ['REJECT', 'Apple'] })),
            ...Array.from({ length: 3 }, () => ({ chains: ['HK 01', 'Manual'] })),
        ];
        const r = computeObservedGroup(conns, proxies);
        expect(r.name).toBe('Manual');
        expect(r.total).toBe(3);
        expect(r.ratio).toBe(1);
    });

    it('also ignores custom-named direct and reject outbounds', () => {
        const map = {
            ...proxies,
            Local: { type: 'Direct' },
            Block: { type: 'Reject' },
            Apple: { type: 'Selector', now: 'Local', all: ['Local', 'Block', 'Manual'] },
        };
        const conns = [
            ...Array.from({ length: 5 }, () => ({ chains: ['Local', 'Apple'] })),
            ...Array.from({ length: 2 }, () => ({ chains: ['Block', 'Apple'] })),
            ...Array.from({ length: 2 }, () => ({ chains: ['HK 01', 'Manual'] })),
        ];
        const r = computeObservedGroup(conns, map);
        expect(r.name).toBe('Manual');
        expect(r.total).toBe(2);
    });

    it('ignores reject-drop and dns outbounds by their core adapter type', () => {
        const map = {
            ...proxies,
            Drop: { type: 'RejectDrop' },
            Resolver: { type: 'Dns' },
            Apple: { type: 'Selector', now: 'Drop', all: ['Drop', 'Resolver', 'Manual'] },
        };
        const conns = [
            ...Array.from({ length: 4 }, () => ({ chains: ['Drop', 'Apple'] })),
            ...Array.from({ length: 4 }, () => ({ chains: ['Resolver', 'Apple'] })),
            ...Array.from({ length: 2 }, () => ({ chains: ['HK 01', 'Manual'] })),
        ];
        const r = computeObservedGroup(conns, map);
        expect(r.name).toBe('Manual');
        expect(r.total).toBe(2);
    });
});
