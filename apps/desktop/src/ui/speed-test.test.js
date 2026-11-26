import { describe, it, expect, vi, beforeEach } from 'vitest';

const api = vi.hoisted(() => ({
    testProxy: vi.fn(),
    speedTestPort: vi.fn(),
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

beforeEach(() => {
    vi.clearAllMocks();
    settings.value = {};
    st.clearSpeedResults();
    api.speedTestPort.mockResolvedValue(17999);
    api.listen.mockResolvedValue(async () => {});
    api.selectSpeedTestNode.mockResolvedValue(undefined);
    api.testProxy.mockImplementation(async (/** @type {string} */ n) => (n === 'dead' ? -1 : 50));
    api.speedTestDownload.mockImplementation(async ({ id }) => ({
        bytes: 1000, elapsedMs: 1000, cancelled: false,
        peakBps: { a: 10 * 1048576, b: 25.04 * 1048576 }[id] ?? 1048576,
    }));
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
    it('skips timed-out nodes, tests the rest one by one and sorts by speed', async () => {
        const out = await st.startSpeedTest(['a', 'dead', 'b']);
        expect(out).toBe('done');
        expect(st.speedOf('dead')).toEqual({ state: 'skipped' });
        expect(st.speedOf('a')).toEqual({ state: 'done', mbps: 10 });
        expect(st.speedOf('b')).toEqual({ state: 'done', mbps: 25 });
        expect(api.speedTestDownload).toHaveBeenCalledTimes(2);
        expect(api.speedTestDownload.mock.calls.map((c) => c[0].id)).toEqual(['a', 'b']);
        expect(api.selectSpeedTestNode).toHaveBeenCalledWith('a');
        expect(st.isSpeedTestRunning()).toBe(false);
        expect(st.sortBySpeed(['x', 'dead', 'a', 'b'])).toEqual(['b', 'a', 'x', 'dead']);
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
        await vi.waitFor(() => expect(st.speedOf('a')?.state).toBe('testing'));
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
        // Claimed before the first await: a start right after is refused.
        expect(st.isSpeedTestRunning()).toBe(true);
        expect(await st.startSpeedTest(['b'])).toBe('busy');
        await vi.waitFor(() => expect(api.speedTestDownload).toHaveBeenCalled());
        finish({ bytes: 1, elapsedMs: 1, peakBps: 1048576, cancelled: false });
        await run;
        expect(api.speedTestDownload).toHaveBeenCalledTimes(1);
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
});
