import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../api.js', () => ({
    lookupExitIp: vi.fn(async () => ({ ip: '203.0.113.9', country: 'JP', source: 'ip-info.com', city: 'Osaka', junk: 1 })),
    speedTestPort: vi.fn(async () => 51000),
    speedTestGeneration: vi.fn(async () => 17),
    speedTestReadyGeneration: vi.fn(async () => 17),
    selectSpeedTestNode: vi.fn(async () => {}),
    cancelExitIpLookups: vi.fn(async () => {}),
    getProxyRecord: vi.fn(async (/** @type {string} */ name) => ({ name, type: 'Shadowsocks' })),
    SPECIAL_PROXY_NAMES: new Set(['DIRECT', 'REJECT', 'REJECT-DROP', 'COMPATIBLE', 'PASS', 'PASS-RULE']),
    getProxies: vi.fn(async () => ({ proxies: {} })),
    getConfig: vi.fn(async () => ({})),
    invoke: vi.fn(async () => null),
}));
vi.mock('./cache.js', () => ({ getSettingsCached: vi.fn(async () => ({ show_exit_ip: true, mixed_port: 7897 })) }));
const speed = vi.hoisted(() => ({ running: false, changed: /** @type {() => void} */ (() => {}) }));
vi.mock('./speed-test.js', () => ({
    withSpeedTestGroup: vi.fn((/** @type {() => any} */ fn) => fn()),
    isSpeedTestRunning: () => speed.running,
    onSpeedTestChange: (fn) => { speed.changed = fn; return () => {}; },
}));

const api = await import('../api.js');
const cache = await import('./cache.js');
const { appStore } = await import('./state.js');
const { exitIpFor, resetExitIp, refreshExitIp, retryFailedExitIp, normalizeExitIp, onExitIpRefreshed, EXIT_IP_SETTLE_MS } = await import('./exit-ip.js');

beforeEach(async () => {
    vi.useFakeTimers();
    speed.running = false;
    speed.changed();
    appStore.set('currentOutboundMode', 'rule');
    await Promise.resolve();
    resetExitIp();
    vi.clearAllMocks();
});
afterEach(() => { vi.useRealTimers(); });

describe('exit address lookup', () => {
    it.each([{}, { type: '' }, { type: ' ' }])('does not select an untyped outbound record: %j', async (record) => {
        vi.mocked(api.getProxyRecord).mockResolvedValueOnce(record);
        expect(await exitIpFor('A', { immediate: true })).toBeNull();
        expect(api.selectSpeedTestNode).not.toHaveBeenCalled();
        expect(api.lookupExitIp).not.toHaveBeenCalled();
    });
    it('retries settings on the next ordinary lookup after a transient read failure', async () => {
        vi.mocked(cache.getSettingsCached).mockRejectedValueOnce(new Error('settings unavailable'));
        expect(await exitIpFor('A', { immediate: true })).toBeNull();
        expect(api.lookupExitIp).not.toHaveBeenCalled();
        expect((await exitIpFor('A', { immediate: true }))?.ip).toBe('203.0.113.9');
        expect(cache.getSettingsCached).toHaveBeenCalledTimes(2);
    });
    it('does not claim the shared route while the node record is pending', async () => {
        const mocked = await import('./speed-test.js');
        let answer = (/** @type {any} */ _value) => {};
        vi.mocked(api.getProxyRecord).mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
        const pending = exitIpFor('A', { immediate: true });
        try {
            await vi.advanceTimersByTimeAsync(0);
            expect(api.getProxyRecord).toHaveBeenCalledExactlyOnceWith('A');
            expect(mocked.withSpeedTestGroup).not.toHaveBeenCalled();
            speed.running = true;
            speed.changed();
            answer({ type: 'Shadowsocks' });
            expect(await pending).toBeNull();
            expect(api.selectSpeedTestNode).not.toHaveBeenCalled();
        } finally { answer({ type: 'Shadowsocks' }); }
    });
    it('holds the real shared route until the active lookup settles', async () => {
        const actual = await vi.importActual('./speed-test.js');
        const mocked = await import('./speed-test.js');
        vi.mocked(mocked.withSpeedTestGroup).mockImplementation(actual.withSpeedTestGroup);
        let answer = (/** @type {any} */ _value) => {};
        vi.mocked(api.lookupExitIp).mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
        const pending = exitIpFor('A', { immediate: true });
        let second;
        try {
            await vi.advanceTimersByTimeAsync(0);
            expect(api.lookupExitIp).toHaveBeenCalledExactlyOnceWith(51000, 'A');
            second = actual.withSpeedTestGroup(() => api.selectSpeedTestNode('B', 17));
            await vi.advanceTimersByTimeAsync(0);
            expect(api.selectSpeedTestNode).toHaveBeenCalledExactlyOnceWith('A', 17);
        } finally {
            answer({ ip: '203.0.113.9' });
            await pending;
            await second;
            vi.mocked(mocked.withSpeedTestGroup).mockImplementation((fn) => fn());
        }
        expect(api.selectSpeedTestNode).toHaveBeenLastCalledWith('B', 17);
    });
    it('hides cached proxy addresses in direct mode and looks up again on return', async () => {
        expect(await exitIpFor('A', { immediate: true })).not.toBeNull();
        appStore.set('currentOutboundMode', 'direct');
        expect(await exitIpFor('A', { immediate: true })).toBeNull();
        expect(api.lookupExitIp).toHaveBeenCalledTimes(1);
        appStore.set('currentOutboundMode', 'rule');
        await Promise.resolve();
        expect(await exitIpFor('A', { immediate: true })).not.toBeNull();
        expect(api.lookupExitIp).toHaveBeenCalledTimes(2);
    });

    it('discards a proxy address answered after direct mode was selected', async () => {
        let answer = (/** @type {any} */ _value) => {};
        vi.mocked(api.lookupExitIp).mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
        const pending = exitIpFor('A', { immediate: true });
        await vi.advanceTimersByTimeAsync(0);
        expect(api.lookupExitIp).toHaveBeenCalledExactlyOnceWith(51000, 'A');
        appStore.set('currentOutboundMode', 'direct');
        answer({ ip: '203.0.113.9' });
        expect(await pending).toBeNull();
    });

    it('cancels an optional address request when a download test starts', async () => {
        let answer = (/** @type {any} */ _value) => {};
        vi.mocked(api.lookupExitIp).mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
        const pending = exitIpFor('A', { immediate: true });
        await vi.advanceTimersByTimeAsync(0);
        expect(api.lookupExitIp).toHaveBeenCalledOnce();
        vi.mocked(api.cancelExitIpLookups).mockClear();
        speed.running = true;
        speed.changed();
        await vi.advanceTimersByTimeAsync(0);
        expect(api.cancelExitIpLookups).toHaveBeenCalledOnce();
        answer(null);
        expect(await pending).toBeNull();
        expect(await exitIpFor('B', { immediate: true })).toBeNull();
        expect(api.lookupExitIp).toHaveBeenCalledOnce();
        speed.running = false;
        speed.changed();
        expect(await exitIpFor('A', { immediate: true })).not.toBeNull();
    });
    it('cancels an abandoned native lookup before starting the new node', async () => {
        await vi.advanceTimersByTimeAsync(0);
        let answerOld = (/** @type {any} */ _value) => {};
        vi.mocked(api.lookupExitIp).mockImplementationOnce(() => new Promise((resolve) => { answerOld = resolve; }));
        const old = exitIpFor('A', { immediate: true });
        await vi.advanceTimersByTimeAsync(0);
        let releaseCancel = () => {};
        vi.mocked(api.cancelExitIpLookups).mockImplementationOnce(() => new Promise((resolve) => {
            releaseCancel = () => { answerOld(null); resolve(); };
        }));
        const current = exitIpFor('B', { immediate: true });
        try {
            await vi.advanceTimersByTimeAsync(0);
            expect(api.selectSpeedTestNode).toHaveBeenCalledTimes(1);
            expect(api.lookupExitIp).toHaveBeenCalledTimes(1);
        } finally { releaseCancel(); }
        expect(await old).toBeNull();
        expect((await current)?.ip).toBe('203.0.113.9');
        expect((await exitIpFor('A', { immediate: true }))?.ip).toBe('203.0.113.9');
    });

    it('drops a manual refresh after switching nodes while selection is pending', async () => {
        let selected = () => {};
        vi.mocked(api.selectSpeedTestNode).mockImplementationOnce(() => new Promise((resolve) => { selected = resolve; }));
        const old = refreshExitIp('A');
        await vi.advanceTimersByTimeAsync(0);
        const current = exitIpFor('B', { immediate: true });
        selected();
        expect(await old).toBeNull();
        expect((await current)?.ip).toBe('203.0.113.9');
        expect(api.lookupExitIp).toHaveBeenCalledExactlyOnceWith(51000, 'B');
    });
    it('keeps the last successful address when a manual refresh fails', async () => {
        const previous = await exitIpFor('A', { immediate: true });
        expect(previous?.ip).toBe('203.0.113.9');
        vi.mocked(api.lookupExitIp).mockResolvedValueOnce(null);
        expect(await refreshExitIp('A')).toBeNull();
        expect(await exitIpFor('A', { immediate: true })).toEqual(previous);
        expect(api.lookupExitIp).toHaveBeenCalledTimes(2);
    });

    it('keeps the previous address when a download interrupts its manual refresh', async () => {
        const previous = await exitIpFor('A', { immediate: true });
        let answer = (/** @type {any} */ _value) => {};
        vi.mocked(api.lookupExitIp).mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
        const pending = refreshExitIp('A');
        await vi.advanceTimersByTimeAsync(0);
        expect(api.lookupExitIp).toHaveBeenCalledTimes(2);
        speed.running = true;
        speed.changed();
        answer(null);
        expect(await pending).toBeNull();
        speed.running = false;
        speed.changed();
        expect(await exitIpFor('A', { immediate: true })).toEqual(previous);
        expect(api.lookupExitIp).toHaveBeenCalledTimes(2);
    });

    it('keeps the previous address when a manual refresh is abandoned for another node', async () => {
        const previous = await exitIpFor('A', { immediate: true });
        let answer = (/** @type {any} */ _value) => {};
        vi.mocked(api.lookupExitIp).mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
        const pending = refreshExitIp('A');
        await vi.advanceTimersByTimeAsync(0);
        const other = exitIpFor('B', { immediate: true });
        answer(null);
        expect(await pending).toBeNull();
        expect(await other).not.toBeNull();
        const reads = vi.mocked(api.lookupExitIp).mock.calls.length;
        expect(await exitIpFor('A', { immediate: true })).toEqual(previous);
        expect(api.lookupExitIp).toHaveBeenCalledTimes(reads);
    });

    it('drops cached addresses after an uncertain reload requests runtime restoration', async () => {
        const { Bus, Events } = await import('./events.js');
        await exitIpFor('A', { immediate: true });
        Bus.emit(Events.CONFIG_UPDATED, { reloaded: false, restoreRuntime: true });
        await exitIpFor('A', { immediate: true });
        expect(api.lookupExitIp).toHaveBeenCalledTimes(2);
    });

    it('cancels the active lookup before refreshing the same node', async () => {
        let answerOld = (/** @type {any} */ _value) => {};
        vi.mocked(api.lookupExitIp).mockImplementationOnce(() => new Promise((resolve) => { answerOld = resolve; }));
        const old = exitIpFor('A', { immediate: true });
        await vi.advanceTimersByTimeAsync(0);
        expect(api.lookupExitIp).toHaveBeenCalledOnce();
        vi.mocked(api.cancelExitIpLookups).mockClear();
        vi.mocked(api.cancelExitIpLookups).mockImplementationOnce(async () => { answerOld(null); });
        const fresh = refreshExitIp('A');
        expect(await old).toBeNull();
        expect(await fresh).not.toBeNull();
        expect(api.cancelExitIpLookups).toHaveBeenCalledOnce();
        expect(api.lookupExitIp).toHaveBeenCalledTimes(2);
    });

    it('does not publish a refresh from before a reset', async () => {
        let answer = (/** @type {any} */ _value) => {};
        vi.mocked(api.lookupExitIp).mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
        const notified = vi.fn();
        const off = onExitIpRefreshed(notified);
        try {
            const refreshing = refreshExitIp('A');
            await vi.advanceTimersByTimeAsync(0);
            expect(api.lookupExitIp).toHaveBeenCalledWith(51000, 'A');
            resetExitIp();
            answer({ ip: '203.0.113.9' });
            expect(await refreshing).toBeNull();
            expect(notified).not.toHaveBeenCalled();
        } finally { off(); }
    });

    it('waits for reset cancellation before dispatching the next lookup', async () => {
        await vi.advanceTimersByTimeAsync(0);
        let release = () => {};
        vi.mocked(api.cancelExitIpLookups).mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
        resetExitIp();
        const pending = exitIpFor('A', { immediate: true });
        try {
            await vi.advanceTimersByTimeAsync(0);
            expect(api.lookupExitIp).not.toHaveBeenCalled();
        } finally { release(); }
        expect((await pending)?.ip).toBe('203.0.113.9');
    });
    it('does not select the diagnostic route after cancellation during the record read', async () => {
        let answer = (/** @type {any} */ _value) => {};
        vi.mocked(api.getProxyRecord).mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
        const pending = exitIpFor('A', { immediate: true });
        await vi.advanceTimersByTimeAsync(0);
        expect(api.getProxyRecord).toHaveBeenCalledExactlyOnceWith('A');
        resetExitIp();
        answer({ type: 'Shadowsocks' });
        expect(await pending).toBeNull();
        expect(api.selectSpeedTestNode).not.toHaveBeenCalled();
    });

    it('does not cache a failure from an abandoned automatic visit', async () => {
        let rejectOld = (/** @type {any} */ _error) => {};
        vi.mocked(api.lookupExitIp).mockImplementationOnce(() => new Promise((_, reject) => { rejectOld = reject; }));
        const old = exitIpFor('A');
        await vi.advanceTimersByTimeAsync(EXIT_IP_SETTLE_MS);
        const other = exitIpFor('B');
        rejectOld(new Error('request failed'));
        expect(await old).toBeNull();
        const returned = exitIpFor('A');
        await vi.advanceTimersByTimeAsync(EXIT_IP_SETTLE_MS);
        expect(await other).toBeNull();
        expect((await returned)?.ip).toBe('203.0.113.9');
    });
    it('starts a fresh settle period when returning to an unfinished node', async () => {
        const first = exitIpFor('A');
        await vi.advanceTimersByTimeAsync(500);
        const other = exitIpFor('B');
        await vi.advanceTimersByTimeAsync(500);
        const returned = exitIpFor('A');
        await vi.advanceTimersByTimeAsync(500);
        expect(await first).toBeNull();
        expect(api.lookupExitIp).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1000);
        expect(await other).toBeNull();
        expect((await returned)?.ip).toBe('203.0.113.9');
        expect(api.lookupExitIp).toHaveBeenCalledExactlyOnceWith(51000, 'A');
    });
    it('does nothing while the setting is off', async () => {
        /** @type {any} */ (cache.getSettingsCached).mockResolvedValueOnce({ show_exit_ip: false, mixed_port: 7897 });
        const p = exitIpFor('A');
        await vi.advanceTimersByTimeAsync(EXIT_IP_SETTLE_MS);
        expect(await p).toBeNull();
        expect(api.lookupExitIp).not.toHaveBeenCalled();
    });

    it('never asks without the pinned listener', async () => {
        /** @type {any} */ (api.speedTestPort).mockResolvedValueOnce(null);
        const p = exitIpFor('A', { immediate: true });
        expect(await p).toBeNull();
        expect(api.lookupExitIp).not.toHaveBeenCalled();
    });

    it('never asks for DIRECT, though the hidden group would accept it', async () => {
        expect(await exitIpFor('DIRECT', { immediate: true })).toBeNull();
        expect(api.selectSpeedTestNode).not.toHaveBeenCalled();
        expect(api.lookupExitIp).not.toHaveBeenCalled();
    });

    it('never asks for a direct-type node or a group', async () => {
        /** @type {any} */ (api.getProxyRecord).mockResolvedValueOnce({ name: 'home', type: 'Direct' });
        expect(await exitIpFor('home', { immediate: true })).toBeNull();
        /** @type {any} */ (api.getProxyRecord).mockResolvedValueOnce({ name: 'Auto', type: 'URLTest', all: ['a'] });
        expect(await exitIpFor('Auto', { immediate: true })).toBeNull();
        expect(api.selectSpeedTestNode).not.toHaveBeenCalled();
        expect(api.lookupExitIp).not.toHaveBeenCalled();
    });

    it('never asks for a node the hidden group refuses', async () => {
        /** @type {any} */ (api.selectSpeedTestNode).mockRejectedValueOnce(new Error('not a member'));
        expect(await exitIpFor('X', { immediate: true })).toBeNull();
        expect(api.lookupExitIp).not.toHaveBeenCalled();
    });

    it('asks once for the node quick switching settles on, and caches it', async () => {
        const a = exitIpFor('A');
        await vi.advanceTimersByTimeAsync(500);
        const b = exitIpFor('B');
        await vi.advanceTimersByTimeAsync(EXIT_IP_SETTLE_MS);
        expect(await a).toBeNull();
        expect(await b).toEqual({ ip: '203.0.113.9', country: 'JP', source: 'ip-info.com', city: 'Osaka' });
        expect(api.lookupExitIp).toHaveBeenCalledTimes(1);
        expect(api.lookupExitIp).toHaveBeenCalledWith(51000, 'B');
        await exitIpFor('B');
        expect(api.lookupExitIp).toHaveBeenCalledTimes(1);
        await refreshExitIp('B');
        expect(api.lookupExitIp).toHaveBeenCalledTimes(2);
    });

    it('keeps a failed lookup until its one retry', async () => {
        /** @type {any} */ (api.lookupExitIp).mockRejectedValueOnce(new Error('timed out'));
        expect(await exitIpFor('A', { immediate: true })).toBeNull();
        // Another page asking on its own sends nothing.
        expect(await exitIpFor('A', { immediate: true })).toBeNull();
        expect(api.lookupExitIp).toHaveBeenCalledTimes(1);
        retryFailedExitIp('A');
        expect((await exitIpFor('A', { immediate: true }))?.ip).toBe('203.0.113.9');
        expect(api.lookupExitIp).toHaveBeenCalledTimes(2);
        // A found address is not looked up again by a retry.
        retryFailedExitIp('A');
        await exitIpFor('A', { immediate: true });
        expect(api.lookupExitIp).toHaveBeenCalledTimes(2);
    });

    it('goes through the speed-test listener pinned to the node', async () => {
        await exitIpFor('HK 01', { immediate: true });
        expect(api.selectSpeedTestNode).toHaveBeenCalledWith('HK 01', 17);
        expect(api.lookupExitIp).toHaveBeenCalledWith(51000, 'HK 01');
    });

    it('sends nothing after a reset while the node is being selected', async () => {
        /** @type {(v?: any) => void} */
        let resolve = () => {};
        /** @type {any} */ (api.selectSpeedTestNode).mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
        const p = exitIpFor('A', { immediate: true });
        await vi.advanceTimersByTimeAsync(0);
        expect(api.selectSpeedTestNode).toHaveBeenCalledWith('A', 17);
        resetExitIp();
        resolve();
        expect(await p).toBeNull();
        expect(api.lookupExitIp).not.toHaveBeenCalled();
    });

    it('drops a lookup that lands after a reset', async () => {
        /** @type {(v: any) => void} */
        let resolve = () => {};
        /** @type {any} */ (api.lookupExitIp).mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
        const p = exitIpFor('A', { immediate: true });
        await vi.advanceTimersByTimeAsync(0);
        // The request is out: this is a late answer, not one never sent.
        expect(api.lookupExitIp).toHaveBeenCalledWith(51000, 'A');
        resetExitIp();
        resolve({ ip: '203.0.113.9', country: 'JP' });
        expect(await p).toBeNull();
    });
    it('does not return an earlier response after a manual refresh replaces it', async () => {
        let answerOld = (/** @type {any} */ _value) => {};
        vi.mocked(api.lookupExitIp).mockImplementationOnce(() => new Promise((resolve) => { answerOld = resolve; }));
        const old = exitIpFor('A', { immediate: true });
        await vi.advanceTimersByTimeAsync(0);
        const refreshed = refreshExitIp('A');
        await vi.advanceTimersByTimeAsync(0);
        answerOld({ ip: '203.0.113.1', country: 'US' });
        expect(await old).toBeNull();
        expect((await refreshed)?.ip).toBe('203.0.113.9');
    });

    it('keeps only known fields', () => {
        expect(normalizeExitIp({ ip: '', country: 'X' })).toBeNull();
        expect(normalizeExitIp({ ip: '1.1.1.1', asn: 13335, is_eu: false, latitude: 'x', city: ' ' })).toEqual({ ip: '1.1.1.1', country: '', source: '', asn: 13335, is_eu: false });
    });
});
