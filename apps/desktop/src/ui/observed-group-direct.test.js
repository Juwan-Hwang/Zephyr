import { describe, it, expect, vi } from 'vitest';

vi.mock('../api.js', () => ({ getConnections: vi.fn(), isCoreReachable: vi.fn(() => true) }));
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
});
