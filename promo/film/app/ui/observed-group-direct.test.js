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
    it('never credits a group with connections that leave DIRECT or are rejected', () => {
        const conns = [
            ...Array.from({ length: 6 }, () => ({ chains: ['DIRECT', 'DirectGroup', 'Apple'] })),
            ...Array.from({ length: 2 }, () => ({ chains: ['REJECT', 'Apple'] })),
            ...Array.from({ length: 3 }, () => ({ chains: ['HK 01', 'Manual'] })),
        ];
        const r = computeObservedGroup(conns, proxies);
        expect(r.name).toBe('Manual');
        expect(r.freq).toBe(3);
        // Apple offers Manual too, so what it sent direct still dilutes the share.
        expect(r.total).toBe(11);
    });

    it('leaves rule-level and direct-only-group traffic out of the share', () => {
        const conns = [
            ...Array.from({ length: 5 }, () => ({ chains: ['DIRECT'] })),
            ...Array.from({ length: 4 }, () => ({ chains: ['DIRECT', 'DirectGroup'] })),
            ...Array.from({ length: 3 }, () => ({ chains: ['HK 01', 'Manual'] })),
        ];
        const r = computeObservedGroup(conns, proxies);
        expect(r.name).toBe('Manual');
        expect(r.total).toBe(3);
        expect(r.ratio).toBe(1);
    });

    it('does not let a small group look dominant when the user picked DIRECT in their own group', () => {
        const map = {
            'HK 01': { type: 'Shadowsocks' },
            'US 01': { type: 'Shadowsocks' },
            Proxy: { type: 'Selector', now: 'DIRECT', all: ['DIRECT', 'HK 01'] },
            Netflix: { type: 'Selector', now: 'US 01', all: ['US 01'] },
        };
        const conns = [
            ...Array.from({ length: 10 }, () => ({ chains: ['DIRECT', 'Proxy'] })),
            ...Array.from({ length: 3 }, () => ({ chains: ['US 01', 'Netflix'] })),
        ];
        const r = computeObservedGroup(conns, map);
        expect(r.name).toBe('Netflix');
        expect(r.total).toBe(13);
        expect(r.ratio).toBeLessThan(0.3);
    });

    it('counts direct traffic an outer selector chose through a direct-only group of any name', () => {
        const map = {
            ...proxies,
            Domestic: { type: 'Selector', now: 'DIRECT', all: ['DIRECT'] },
            Media: { type: 'Selector', now: 'Domestic', all: ['Domestic', 'Manual'] },
        };
        const conns = [
            ...Array.from({ length: 6 }, () => ({ chains: ['DIRECT', 'Domestic', 'Media'] })),
            ...Array.from({ length: 4 }, () => ({ chains: ['DIRECT', 'Domestic'] })),
            ...Array.from({ length: 3 }, () => ({ chains: ['HK 01', 'Manual'] })),
        ];
        const r = computeObservedGroup(conns, map);
        expect(r.name).toBe('Manual');
        // Media offers Manual, so its six count; Domestic alone offers only DIRECT.
        expect(r.total).toBe(9);
        expect(r.ratio).toBeLessThan(0.34);
    });

    it('also ignores custom-named direct and reject outbounds', () => {
        const map = {
            ...proxies,
            Local: { type: 'Direct' },
            Block: { type: 'Reject' },
            LocalOnly: { type: 'Selector', now: 'Local', all: ['Local', 'Block'] },
        };
        const conns = [
            ...Array.from({ length: 5 }, () => ({ chains: ['Local', 'LocalOnly'] })),
            ...Array.from({ length: 2 }, () => ({ chains: ['Block', 'LocalOnly'] })),
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
            Sink: { type: 'Selector', now: 'Drop', all: ['Drop', 'Resolver'] },
        };
        const conns = [
            ...Array.from({ length: 4 }, () => ({ chains: ['Drop', 'Sink'] })),
            ...Array.from({ length: 4 }, () => ({ chains: ['Resolver', 'Sink'] })),
            ...Array.from({ length: 2 }, () => ({ chains: ['HK 01', 'Manual'] })),
        ];
        const r = computeObservedGroup(conns, map);
        expect(r.name).toBe('Manual');
        expect(r.total).toBe(2);
    });
});
