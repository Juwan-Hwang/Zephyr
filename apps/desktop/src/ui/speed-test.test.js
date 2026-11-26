import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const api = vi.hoisted(() => ({
    SPECIAL_PROXY_NAMES: new Set(['DIRECT', 'REJECT', 'REJECT-DROP', 'COMPATIBLE', 'PASS', 'PASS-RULE']),
    testProxy: vi.fn(),
    getProxyRecord: vi.fn(),
    getLatencyTestUrl: vi.fn(),
    abortLatencyTests: vi.fn(),
    speedTestPort: vi.fn(),
    speedTestGeneration: vi.fn(),
    speedTestReadyGeneration: vi.fn(),
    selectSpeedTestNode: vi.fn(),
    speedTestDownload: vi.fn(),
    speedTestCancel: vi.fn(),
    listen: vi.fn(),
}));
const settings = vi.hoisted(() => ({ value: /** @type {any} */ ({}) }));

vi.mock('../api.js', () => api);
vi.mock('./cache.js', () => ({ getSettingsCached: vi.fn(async () => settings.value) }));
vi.mock('./settings-helpers.js', () => ({ saveSettingsChecked: vi.fn(async () => {}) }));

const st = await import('./speed-test.js');
const { saveSettingsChecked } = await import('./settings-helpers.js');
const { getSettingsCached } = await import('./cache.js');

beforeEach(() => {
    vi.clearAllMocks();
    settings.value = {};
    st.clearSpeedResults();
    api.speedTestPort.mockResolvedValue(17999);
    api.speedTestGeneration.mockResolvedValue(0);
    api.speedTestReadyGeneration.mockResolvedValue(0);
    api.getLatencyTestUrl.mockReturnValue('https://latency.example/original');
    api.listen.mockResolvedValue(async () => {});
    api.speedTestCancel.mockReset().mockResolvedValue(undefined);
    api.selectSpeedTestNode.mockResolvedValue(undefined);
    api.testProxy.mockImplementation(async (/** @type {string} */ n) => (n === 'dead' ? -1 : 50));
    api.getProxyRecord.mockResolvedValue({ type: 'Shadowsocks' });
    api.speedTestDownload.mockReset().mockImplementation(async ({ id }) => ({
        bytes: 1000, elapsedMs: 1000, cancelled: false,
        peakBps: { a: 10 * 1048576, b: 25.04 * 1048576, c: 25.01 * 1048576 }[id] ?? 1048576,
    }));
});

// A case that failed with a run still held (a pending selection or
// download) must not leave the next case "busy".
afterEach(async () => {
    if (st.isSpeedTestRunning()) await st.stopSpeedTest();
});

describe('speed test helpers', () => {
    it('shows MB/s with one decimal', () => {
        expect(st.toMbps(41.24 * 1048576)).toBe(41.2);
        expect(st.toMbps(0)).toBe(0);
    });

    it('reads defaults and only accepts the offered time limits', async () => {
        expect(await st.readSpeedTestSettings()).toMatchObject({ url: st.DEFAULT_SPEED_TEST_URL, maxSecs: 10 });
        settings.value = { speed_test_url: 'https://example.com/f.bin', speed_test_max_secs: 45 };
        const r = await st.readSpeedTestSettings();
        expect(r).toMatchObject({ url: 'https://example.com/f.bin', maxSecs: 10, file: null });
    });

    it('saves the defaults as null so a later default change applies', async () => {
        await st.saveSpeedTestSettings({ url: st.DEFAULT_SPEED_TEST_URL, maxSecs: 10 });
        expect(saveSettingsChecked).toHaveBeenCalledWith({ speed_test_url: null, speed_test_max_secs: null });
        await st.saveSpeedTestSettings({ url: ' https://x.test/a ', maxSecs: 30 });
        expect(saveSettingsChecked).toHaveBeenLastCalledWith({ speed_test_url: 'https://x.test/a', speed_test_max_secs: 30 });
    });

    it('validates custom addresses', () => {
        expect(st.isValidSpeedTestUrl('https://a.b/c')).toBe(true);
        expect(st.isValidSpeedTestUrl('ftp://a.b/c')).toBe(false);
        expect(st.isValidSpeedTestUrl('nope')).toBe(false);
    });

    it('estimates traffic from the file, or the per-node cap for a custom address', () => {
        expect(st.maxTrafficBytes(3, st.SPEED_TEST_FILES[1])).toBe(30 * 1048576);
        expect(st.maxTrafficBytes(3, null)).toBe(3 * st.CUSTOM_MAX_BYTES);
    });
});

describe('startSpeedTest', () => {
    it.each([1, null])('sends no probes when readiness changes during setup: %s', async (ready) => {
        if (ready === null) api.speedTestReadyGeneration.mockRejectedValueOnce(new Error('reload active'));
        else api.speedTestReadyGeneration.mockResolvedValueOnce(ready);
        expect(await st.startSpeedTest(['a'])).toBe(ready === null ? 'unavailable' : 'stopped');
        expect(api.abortLatencyTests).not.toHaveBeenCalled();
        expect(api.testProxy).not.toHaveBeenCalled();
        expect(api.speedTestDownload).not.toHaveBeenCalled();
        expect(st.isSpeedTestRunning()).toBe(false);
    });
    it('reports unavailable when the initial native generation cannot be read', async () => {
        api.speedTestGeneration.mockRejectedValueOnce(new Error('IPC unavailable'));
        expect(await st.startSpeedTest(['a'])).toBe('unavailable');
        expect(st.isSpeedTestRunning()).toBe(false);
        expect(api.speedTestDownload).not.toHaveBeenCalled();
    });
    it('restores the prior speed when Stop interrupts generation confirmation after a failed precheck', async () => {
        await st.startSpeedTest(['a']);
        const previous = st.speedOf('a');
        let release = (/** @type {number} */ _value) => {};
        api.speedTestGeneration.mockClear().mockResolvedValueOnce(0)
            .mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
        api.testProxy.mockResolvedValueOnce(-1);
        const running = st.startSpeedTest(['a']);
        try {
            await vi.waitFor(() => expect(api.speedTestGeneration).toHaveBeenCalledTimes(2));
            expect(st.speedOf('a')?.state).toBe('skipped');
            await st.stopSpeedTest();
            expect(await running).toBe('stopped');
            expect(st.speedOf('a')).toEqual(previous);
        } finally { release(0); }
    });
    it.each([false, true])('keeps an earlier skipped result when setup cannot finish (stop=%s)', async (stop) => {
        await st.startSpeedTest(['dead']);
        const previous = st.speedOf('dead');
        expect(previous).toEqual({ state: 'skipped' });
        api.speedTestPort.mockClear();
        let release = () => {};
        api.speedTestPort.mockImplementationOnce(() => stop
            ? new Promise((resolve) => { release = () => resolve(17999); }) : Promise.resolve(null));
        const pending = st.startSpeedTest(['dead']);
        try {
            if (stop) {
                await vi.waitFor(() => expect(api.speedTestPort).toHaveBeenCalledOnce());
                await st.stopSpeedTest();
            }
            expect(await pending).toBe(stop ? 'stopped' : 'unavailable');
            expect(st.speedOf('dead')).toEqual(previous);
        } finally { release(); }
    });
    it.each([{ type: 'Direct' }, {}])('does not select an unconfirmed proxy outbound: %j', async (record) => {
        api.getProxyRecord.mockResolvedValueOnce(record);
        await st.startSpeedTest(['custom-name']);
        expect(api.selectSpeedTestNode).not.toHaveBeenCalled();
        expect(api.speedTestDownload).not.toHaveBeenCalled();
        expect(st.speedOf('custom-name')?.state).toBe('skipped');
    });
    it('continues after progress registration times out and removes a late listener', async () => {
        vi.useFakeTimers();
        /** @type {(unlisten: () => Promise<void>) => void} */
        let finishListening = () => {};
        const unlisten = vi.fn(async () => {});
        api.listen.mockImplementationOnce(() => new Promise((resolve) => { finishListening = resolve; }));
        try {
            const running = st.startSpeedTest(['a']);
            await vi.advanceTimersByTimeAsync(3001);
            await expect(running).resolves.toBe('done');
            expect(api.speedTestDownload).toHaveBeenCalledOnce();
            finishListening(unlisten);
            await vi.advanceTimersByTimeAsync(0);
            expect(unlisten).toHaveBeenCalledOnce();
        } finally {
            vi.useRealTimers();
        }
    });
    it('downloads a node whose successful precheck rounded to zero milliseconds', async () => {
        api.testProxy.mockResolvedValueOnce(0);
        expect(await st.startSpeedTest(['a'])).toBe('done');
        expect(api.speedTestDownload).toHaveBeenCalledOnce();
        expect(st.speedOf('a')?.state).toBe('done');
    });
    it.each([45, -1])('discards a native-cancelled latency precheck (delay=%s)', async (delay) => {
        api.speedTestGeneration.mockResolvedValue(17);
        api.speedTestReadyGeneration.mockResolvedValue(17);
        api.testProxy.mockImplementation(async () => {
            api.speedTestGeneration.mockResolvedValue(18);
            return delay;
        });
        expect(await st.startSpeedTest(['a', 'b'])).toBe('stopped');
        expect(api.speedTestGeneration).toHaveBeenCalledTimes(2);
        expect(api.speedTestDownload).not.toHaveBeenCalled();
        expect(st.speedOf('a')).toBeUndefined();
        expect(st.speedOf('b')).toBeUndefined();
    });

    it('keeps earlier measurements when the post-precheck generation is unreadable', async () => {
        await st.startSpeedTest(['a']);
        const previous = st.speedOf('a');
        api.speedTestDownload.mockClear();
        api.speedTestGeneration.mockResolvedValueOnce(0).mockRejectedValueOnce(new Error('IPC unavailable'));
        expect(await st.startSpeedTest(['b'])).toBe('stopped');
        expect(st.speedOf('a')).toEqual(previous);
        expect(st.speedOf('b')).toBeUndefined();
        expect(api.speedTestDownload).not.toHaveBeenCalled();
    });

    it.each([false, true])('handles selection errors according to their generation (changed=%s)', async (changed) => {
        await st.startSpeedTest(['a']);
        const previous = st.speedOf('a');
        api.speedTestDownload.mockClear();
        api.selectSpeedTestNode.mockImplementationOnce(async () => {
            if (changed) api.speedTestGeneration.mockResolvedValue(1);
            throw new Error(changed ? 'diagnostic selection cancelled' : 'missing node');
        });
        expect(await st.startSpeedTest(['b', 'c'])).toBe(changed ? 'stopped' : 'done');
        if (changed) {
            expect(st.speedOf('a')).toBeUndefined();
            expect(st.speedOf('b')).toBeUndefined();
            expect(st.speedOf('c')).toBeUndefined();
            expect(api.speedTestDownload).not.toHaveBeenCalled();
        } else {
            expect(st.speedOf('a')).toEqual(previous);
            expect(st.speedOf('b')?.state).toBe('failed');
            expect(st.speedOf('c')?.state).toBe('done');
        }
    });
    it('never substitutes a different download when settings cannot be read', async () => {
        vi.mocked(getSettingsCached).mockRejectedValueOnce(new Error('Settings unavailable'));
        await expect(st.startSpeedTest(['a'])).rejects.toThrow('Settings unavailable');
        expect(api.speedTestDownload).not.toHaveBeenCalled();
        expect(api.selectSpeedTestNode).not.toHaveBeenCalled();
        expect(st.isSpeedTestRunning()).toBe(false);
    });
    it('keeps the latency destination fixed while queued prechecks run', async () => {
        let address = 'https://latency.example/original';
        api.getLatencyTestUrl.mockImplementation(() => address);
        api.testProxy.mockImplementation(async () => {
            address = 'https://latency.example/changed';
            return 50;
        });
        await st.startSpeedTest(['a', 'b', 'c', 'd', 'e', 'f', 'g']);
        expect(api.testProxy).toHaveBeenCalledTimes(7);
        for (const call of api.testProxy.mock.calls) expect(call[3].url).toBe('https://latency.example/original');
    });

    it('discards prior results and stops the batch after backend cancellation', async () => {
        await st.startSpeedTest(['a']);
        const previous = st.speedOf('a');
        expect(previous).toMatchObject({ state: 'done' });
        api.speedTestDownload.mockClear();
        api.speedTestDownload.mockResolvedValueOnce({ bytes: 1000, elapsedMs: 200, peakBps: 999999, cancelled: true });
        expect(await st.startSpeedTest(['a', 'b'])).toBe('stopped');
        expect(st.speedOf('a')).toBeUndefined();
        expect(st.speedOf('b')).toBeUndefined();
        expect(api.speedTestDownload).toHaveBeenCalledTimes(1);
    });
    it('skips timed-out nodes, tests the rest one by one and sorts by speed', async () => {
        const out = await st.startSpeedTest(['a', 'dead', 'b']);
        expect(out).toBe('done');
        expect(st.speedOf('dead')).toEqual({ state: 'skipped' });
        expect(st.speedOf('a')).toMatchObject({ state: 'done', mbps: 10 });
        expect(st.speedOf('b')).toMatchObject({ state: 'done', mbps: 25 });
        expect(api.speedTestDownload).toHaveBeenCalledTimes(2);
        expect(api.speedTestDownload.mock.calls.map((c) => c[0].id)).toEqual(['a', 'b']);
        expect(api.selectSpeedTestNode).toHaveBeenCalledWith('a', 0, expect.any(String));
        expect(st.isSpeedTestRunning()).toBe(false);
        expect(st.sortBySpeed(['x', 'dead', 'a', 'b'])).toEqual(['b', 'a', 'x', 'dead']);
    });

    it('ranks by the measured rate, not the rounded one shown', async () => {
        await st.startSpeedTest(['c', 'b']);
        expect(st.speedOf('c')).toMatchObject({ mbps: 25 });
        expect(st.sortBySpeed(['c', 'b'])).toEqual(['b', 'c']);
    });

    it('starts the next download only after the previous one ends', async () => {
        /** @type {(v: any) => void} */
        let finishA = () => {};
        api.speedTestDownload.mockImplementation(({ id }) => (id === 'a'
            ? new Promise((r) => { finishA = r; })
            : Promise.resolve({ bytes: 1000, elapsedMs: 1000, cancelled: false, peakBps: 1048576 })));
        const running = st.startSpeedTest(['a', 'b']);
        try {
            await vi.waitFor(() => expect(api.speedTestDownload).toHaveBeenCalledTimes(1));
            await new Promise((r) => setTimeout(r, 20));
            expect(api.speedTestDownload).toHaveBeenCalledTimes(1);
            expect(api.selectSpeedTestNode.mock.calls).toEqual([['a', 0, expect.any(String)]]);
        } finally {
            // Always released: a failed assertion must not leave the run going for the next test.
            finishA({ bytes: 1000, elapsedMs: 1000, cancelled: false, peakBps: 1048576 });
        }
        expect(await running).toBe('done');
        expect(api.speedTestDownload.mock.calls.map((c) => c[0].id)).toEqual(['a', 'b']);
    });

    it('Stop ends a run whose setup is still pending, without stopping latency tests', async () => {
        api.speedTestPort.mockReturnValue(new Promise(() => {}));
        const running = st.startSpeedTest(['a']);
        await vi.waitFor(() => expect(api.speedTestPort).toHaveBeenCalled());
        await st.stopSpeedTest();
        expect(await running).toBe('stopped');
        expect(st.isSpeedTestRunning()).toBe(false);
        expect(api.abortLatencyTests).not.toHaveBeenCalled();
    });

    it('leaves latency tests alone when the profile has no download test', async () => {
        api.speedTestPort.mockResolvedValue(null);
        expect(await st.startSpeedTest(['a'])).toBe('unavailable');
        expect(api.abortLatencyTests).not.toHaveBeenCalled();
    });

    it('reports a profile without the speed-test listener', async () => {
        api.speedTestPort.mockResolvedValue(null);
        expect(await st.startSpeedTest(['a'])).toBe('unavailable');
        expect(api.speedTestDownload).not.toHaveBeenCalled();
    });

    it('marks a node whose download fails', async () => {
        api.speedTestDownload.mockRejectedValueOnce(new Error('HTTP 403'));
        await st.startSpeedTest(['a']);
        expect(st.speedOf('a')).toEqual({ state: 'failed' });
    });

    it('stop ends the run and clears nodes that never got their turn', async () => {
        /** @type {(v: any) => void} */
        let finish = () => {};
        api.speedTestDownload.mockImplementationOnce(() => new Promise((r) => { finish = r; }));
        api.speedTestCancel.mockImplementation(async () => finish({ bytes: 10, elapsedMs: 10, peakBps: 0, cancelled: true }));
        const run = st.startSpeedTest(['a', 'b']);
        await vi.waitFor(() => expect(api.speedTestDownload).toHaveBeenCalledTimes(1));
        expect(st.speedOf('a')?.state).toBe('testing');
        expect(st.speedTestProgress()).toEqual({ done: 0, total: 2 });
        await st.stopSpeedTest();
        expect(await run).toBe('stopped');
        expect(st.speedOf('a')).toBeUndefined();
        expect(st.speedOf('b')).toBeUndefined();
        expect(api.speedTestDownload).toHaveBeenCalledTimes(1);
    });

    it('refuses a second run while one is going', async () => {
        /** @type {(v: any) => void} */
        let finish = () => {};
        api.speedTestDownload.mockImplementationOnce(() => new Promise((r) => { finish = r; }));
        const run = st.startSpeedTest(['a']);
        try {
            // Claimed before the first await: a start right after is refused.
            expect(st.isSpeedTestRunning()).toBe(true);
            expect(await st.startSpeedTest(['b'])).toBe('busy');
            await vi.waitFor(() => expect(api.speedTestDownload).toHaveBeenCalled());
        } finally {
            await st.stopSpeedTest();
            finish({ bytes: 1, elapsedMs: 1, peakBps: 1048576, cancelled: false });
            await run;
        }
        expect(api.speedTestDownload).toHaveBeenCalledTimes(1);
    });

    it('keeps latency blocked after Stop until the native download settles', async () => {
        /** @type {(value: any) => void} */
        let finish = () => {};
        api.speedTestDownload.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
        const states = [];
        const unsubscribe = st.onSpeedTestChange(() => states.push(st.isSpeedTestBusy()));
        const running = st.startSpeedTest(['a']);
        try {
            await vi.waitFor(() => expect(api.speedTestDownload).toHaveBeenCalledOnce());
            await st.stopSpeedTest();
            expect(await running).toBe('stopped');
            expect(st.isSpeedTestRunning()).toBe(false);
            expect(st.isSpeedTestBusy()).toBe(true);
        } finally {
            finish({ bytes: 0, elapsedMs: 0, peakBps: 0, cancelled: true });
            await st.withSpeedTestGroup(async () => {});
            unsubscribe();
        }
        expect(st.isSpeedTestBusy()).toBe(false);
        expect(states.at(-1)).toBe(false);
    });

    it('keeps valid previous results when the user stops a retest', async () => {
        await st.startSpeedTest(['a']);
        const previous = st.speedOf('a');
        expect(previous?.state).toBe('done');
        /** @type {(value: any) => void} */
        let finish = () => {};
        api.speedTestDownload.mockClear();
        api.speedTestDownload.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
        const pending = st.startSpeedTest(['a']);
        try {
            await vi.waitFor(() => expect(api.speedTestDownload).toHaveBeenCalledOnce());
            await st.stopSpeedTest();
            expect(await pending).toBe('stopped');
            expect(st.speedOf('a')).toEqual(previous);
        } finally {
            finish({ bytes: 0, elapsedMs: 0, peakBps: 0, cancelled: true });
            await st.withSpeedTestGroup(async () => {});
        }
    });

    it('restores a prior speed when Stop interrupts the latency precheck', async () => {
        await st.startSpeedTest(['a']);
        const previous = st.speedOf('a');
        let release = () => {};
        api.testProxy.mockImplementation((name) => name === 'a' ? Promise.resolve(-1)
            : new Promise((resolve) => { release = () => resolve(-1); }));
        const pending = st.startSpeedTest(['a', 'b']);
        try {
            await vi.waitFor(() => expect(st.speedOf('a')?.state).toBe('skipped'));
            await st.stopSpeedTest();
            expect(await pending).toBe('stopped');
            expect(st.speedOf('a')).toEqual(previous);
            expect(st.speedOf('b')).toBeUndefined();
        } finally { release(); }
    });

    it('starts no download when stopped while the node is being selected', async () => {
        /** @type {(v?: any) => void} */
        let selected = () => {};
        api.selectSpeedTestNode.mockImplementationOnce(() => new Promise((r) => { selected = r; }));
        const run = st.startSpeedTest(['a']);
        await vi.waitFor(() => expect(api.selectSpeedTestNode).toHaveBeenCalled());
        await st.stopSpeedTest();
        selected();
        expect(await run).toBe('stopped');
        expect(api.speedTestDownload).not.toHaveBeenCalled();
        expect(st.speedOf('a')).toBeUndefined();
    });

    it('forgets results when the core restarts', async () => {
        const { Bus, Events } = await import('./events.js');
        await st.startSpeedTest(['a']);
        expect(st.speedOf('a')?.state).toBe('done');
        Bus.emit(Events.CORE_RESTARTED, {});
        expect(st.speedOf('a')).toBeUndefined();
    });
    it('forgets results after a confirmed background reload', async () => {
        const { Bus, Events } = await import('./events.js');
        await st.startSpeedTest(['a']);
        Bus.emit(Events.DIAGNOSTICS_INVALIDATED);
        expect(st.speedOf('a')).toBeUndefined();
    });
});
