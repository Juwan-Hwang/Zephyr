import { describe, it, expect, vi } from 'vitest';

vi.mock('../api.js', () => ({ getConnections: vi.fn(), getProxiesMerged: vi.fn(), lookupExitIp: vi.fn(), SPECIAL_PROXY_NAMES: new Set(['DIRECT', 'REJECT', 'REJECT-DROP', 'COMPATIBLE', 'PASS', 'PASS-RULE']) }));
vi.mock('./cache.js', () => ({ getProxiesCached: vi.fn(), getSettingsCached: vi.fn(async () => ({})) }));
vi.mock('./exit-ip.js', () => ({ exitIpFor: vi.fn(async () => null), resetExitIp: vi.fn(), retryFailedExitIp: vi.fn(), onExitIpRefreshed: vi.fn(() => () => {}) }));
vi.mock('./node-details.js', () => ({ exitIpSummary: vi.fn(), openNodeDetails: vi.fn(), closeNodeDetails: vi.fn(), adoptNodeDetails: vi.fn(), dropOrphanedNodeDetails: vi.fn() }));

const { splitBytes, resolveLeaf, displayedLeaf, initHomeStats, splitFlag, lastDelay, lowerLatencyNodes } = await import('./home-stats.js');
const api = await import('../api.js');
const cache = await import('./cache.js');
const ip = await import('./exit-ip.js');
const details = await import('./node-details.js');
const { appStore } = await import('./state.js');
const { Bus, Events } = await import('./events.js');

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

    it('follows chains deeper than eight groups', () => {
        /** @type {Record<string, any>} */
        const proxies = { Leaf: { name: 'Leaf' } };
        for (let i = 0; i < 12; i++) proxies[`G${i}`] = { name: `G${i}`, all: ['x'], now: i === 11 ? 'Leaf' : `G${i + 1}` };
        expect(resolveLeaf(proxies, 'G0')?.name).toBe('Leaf');
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

    it('ignores an observed node outside the group even when the group name matches', () => {
        const proxies = {
            'Select': { name: 'Select', all: ['HK'], now: 'HK' },
            'HK': { name: 'HK' }, 'US': { name: 'US' },
        };
        appStore.set('observedGroupName', 'Select');
        appStore.set('observedNodeName', 'US');
        expect(displayedLeaf(proxies, 'Select')?.name).toBe('HK');
        appStore.set('observedNodeName', 'Select');
        expect(displayedLeaf(proxies, 'Select')?.name).toBe('HK');
        appStore.set('observedNodeName', null);
        appStore.set('observedGroupName', null);
    });

    it('reads the proxy map for latency only every fifth poll unless the node changes', async () => {
        vi.useFakeTimers();
        document.body.innerHTML = '<div data-page="home"><div id="home-node"><span id="current-node-name" data-group="HK">HK</span><span id="home-node-name"></span><span id="home-node-sub"></span></div></div>';
        vi.mocked(api.getConnections).mockResolvedValue({ connections: [] });
        vi.mocked(cache.getProxiesCached).mockResolvedValue({ HK: { name: 'HK', history: [{ delay: 30 }] } });
        const stop = initHomeStats();
        const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
        await flush();
        expect(cache.getProxiesCached).toHaveBeenCalledTimes(1);
        for (let i = 0; i < 4; i++) { await vi.advanceTimersByTimeAsync(2000); await flush(); }
        expect(api.getConnections).toHaveBeenCalledTimes(5);
        expect(cache.getProxiesCached).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(2000); await flush();
        expect(cache.getProxiesCached).toHaveBeenCalledTimes(2);
        const pill = document.getElementById('current-node-name');
        if (pill) pill.dataset.group = 'JP';
        await vi.advanceTimersByTimeAsync(2000); await flush();
        expect(cache.getProxiesCached).toHaveBeenCalledTimes(3);
        // Switching node inside the same group keeps data-group but relabels the pill.
        if (pill) pill.textContent = 'JP - Tokyo 02';
        await vi.advanceTimersByTimeAsync(2000); await flush();
        expect(cache.getProxiesCached).toHaveBeenCalledTimes(4);
        stop();
        vi.useRealTimers();
        document.body.innerHTML = '';
    });

    it('keeps the exit address button and its focus when only the latency changes', async () => {
        vi.useFakeTimers();
        document.body.innerHTML = '<div data-page="home"><div id="home-node"><span id="current-node-name" data-group="HK">HK</span><span id="home-node-name"></span><span id="home-node-sub"></span></div></div>';
        appStore.set('uiGroupName', null);
        appStore.set('uiPrimaryGroupName', null);
        vi.mocked(api.getConnections).mockResolvedValue({ connections: [] });
        vi.mocked(cache.getProxiesCached).mockResolvedValue({ HK: { name: 'HK', history: [{ delay: 40 }] } });
        vi.mocked(ip.exitIpFor).mockResolvedValue({ ip: '192.0.2.1', country: 'US', source: 'cloudflare' });
        vi.mocked(details.exitIpSummary).mockReturnValue({ ip: 'IP 192.0.2.1', place: 'US', title: '' });
        const stop = initHomeStats();
        try {
            await vi.advanceTimersByTimeAsync(0);
            const button = /** @type {HTMLButtonElement} */ (document.querySelector('.home-ip-btn'));
            expect(button).not.toBeNull();
            button.focus();
            vi.mocked(cache.getProxiesCached).mockResolvedValue({ HK: { name: 'HK', history: [{ delay: 45 }] } });
            await vi.advanceTimersByTimeAsync(10_000);
            expect(document.querySelector('.home-ip-btn')).toBe(button);
            expect(document.activeElement).toBe(button);
            expect(document.querySelector('.home-ms-value')?.textContent).toBe('45 ms');
        } finally {
            stop();
            vi.useRealTimers();
            vi.mocked(ip.exitIpFor).mockResolvedValue(null);
            document.body.innerHTML = '';
        }
    });

    it('does not let a stopped instance update a newly mounted home', async () => {
        vi.useFakeTimers();
        document.body.innerHTML = '<div data-page="home"><div id="home-node"><span id="current-node-name" data-group="HK">HK</span><span id="home-node-name"></span><span id="home-node-sub"></span></div><span id="home-total-down"></span></div>';
        /** @type {(value: any) => void} */
        let finishOld = () => {};
        vi.mocked(api.getConnections).mockReturnValueOnce(new Promise((resolve) => { finishOld = resolve; }));
        const stopOld = initHomeStats();
        stopOld();
        document.body.innerHTML = '<div data-page="home"><div id="home-node"><span id="current-node-name" data-group="HK">HK</span><span id="home-node-name"></span><span id="home-node-sub"></span></div><span id="home-total-down"></span></div>';
        vi.mocked(api.getConnections).mockResolvedValue({ downloadTotal: 1234, connections: [] });
        vi.mocked(cache.getProxiesCached).mockResolvedValue({ HK: { name: 'HK', history: [{ delay: 10 }] } });
        const stopNew = initHomeStats();
        try {
            await vi.advanceTimersByTimeAsync(0);
            const before = document.getElementById('home-total-down')?.textContent;
            expect(before).not.toBe('');
            const nodeReads = vi.mocked(cache.getProxiesCached).mock.calls.length;
            finishOld({ downloadTotal: 9999999, connections: [] });
            await vi.advanceTimersByTimeAsync(0);
            expect(document.getElementById('home-total-down')?.textContent).toBe(before);
            expect(cache.getProxiesCached).toHaveBeenCalledTimes(nodeReads);
        } finally {
            stopNew();
            vi.useRealTimers();
            document.body.innerHTML = '';
        }
    });

    it('drops connection counters from a core replaced while the request was pending', async () => {
        vi.useFakeTimers();
        document.body.innerHTML = '<div data-page="home"><div id="home-node"><span id="current-node-name">HK</span><span id="home-node-name"></span><span id="home-node-sub"></span></div><span id="home-total-down"></span><span id="home-total-up"></span><span id="home-conn-text"></span></div>';
        /** @type {(value: any) => void} */
        let finish = () => {};
        vi.mocked(api.getConnections).mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
        const stop = initHomeStats();
        try {
            Bus.emit(Events.CORE_RESTARTED);
            finish({ downloadTotal: 999999, uploadTotal: 55555, connections: [{}] });
            await vi.advanceTimersByTimeAsync(0);
            expect(document.getElementById('home-total-down')?.textContent).toBe('—');
            expect(document.getElementById('home-conn-text')?.textContent).toBe('—');
        } finally {
            stop();
            vi.useRealTimers();
            document.body.innerHTML = '';
        }
    });

    it('splits a leading flag off a node name', () => {
        expect(splitFlag('🇭🇰 香港 03')).toEqual({ flag: '🇭🇰', label: '香港 03' });
        expect(splitFlag('Tokyo 01')).toEqual({ flag: '', label: 'Tokyo 01' });
    });

    it('reads the newest delay and treats timeouts as none', () => {
        expect(lastDelay({ history: [{ delay: 40 }, { delay: 22 }] })).toBe(22);
        expect(lastDelay({ history: [{ delay: 0 }] })).toBeNull();
        expect(lastDelay({})).toBeNull();
    });

    it('offers the group\'s fastest real nodes, current one and groups left out', () => {
        const proxies = {
            Select: { all: ['Auto', 'DIRECT', 'Resolver', 'A', 'B', 'C', 'D'] },
            Auto: { all: ['A'], history: [{ delay: 5 }] },
            DIRECT: { type: 'Direct', history: [{ delay: 1 }] },
            A: { history: [{ delay: 60 }] },
            B: { history: [{ delay: 20 }] },
            C: { history: [{ delay: 0 }] },
            D: { history: [{ delay: 40 }] },
            Resolver: { type: 'Dns', history: [{ delay: 2 }] },
        };
        expect(lowerLatencyNodes(proxies, 'Select', 'B')).toEqual([]);
        expect(lowerLatencyNodes(proxies, 'Select', 'A')).toEqual([{ name: 'B', delay: 20 }, { name: 'D', delay: 40 }]);
        expect(lowerLatencyNodes(proxies, 'Select', 'X', 1)).toEqual([{ name: 'B', delay: 20 }]);
        expect(lowerLatencyNodes(proxies, 'missing', 'X')).toEqual([]);
    });
});
