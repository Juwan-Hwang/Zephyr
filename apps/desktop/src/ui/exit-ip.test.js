import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../api.js', () => ({
    lookupExitIp: vi.fn(async () => ({ ip: '203.0.113.9', country: 'JP', source: 'ip-info.com', city: 'Osaka', junk: 1 })),
    speedTestPort: vi.fn(async () => 51000),
    selectSpeedTestNode: vi.fn(async () => {}),
    cancelExitIpLookups: vi.fn(async () => {}),
    getProxyRecord: vi.fn(async (/** @type {string} */ name) => ({ name, type: 'Shadowsocks' })),
    SPECIAL_PROXY_NAMES: new Set(['DIRECT', 'REJECT', 'REJECT-DROP', 'COMPATIBLE', 'PASS', 'PASS-RULE']),
    getProxies: vi.fn(async () => ({ proxies: {} })),
    getConfig: vi.fn(async () => ({})),
    invoke: vi.fn(async () => null),
}));
vi.mock('./cache.js', () => ({ getSettingsCached: vi.fn(async () => ({ show_exit_ip: true, mixed_port: 7897 })) }));
vi.mock('./speed-test.js', () => ({ withSpeedTestGroup: vi.fn((/** @type {() => any} */ fn) => fn()) }));

const api = await import('../api.js');
const cache = await import('./cache.js');
const { exitIpFor, resetExitIp, refreshExitIp, retryFailedExitIp, normalizeExitIp, EXIT_IP_SETTLE_MS } = await import('./exit-ip.js');

beforeEach(() => {
    vi.useFakeTimers();
    resetExitIp();
    vi.clearAllMocks();
});
afterEach(() => { vi.useRealTimers(); });

describe('exit address lookup', () => {
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
        expect(api.selectSpeedTestNode).toHaveBeenCalledWith('HK 01');
        expect(api.lookupExitIp).toHaveBeenCalledWith(51000, 'HK 01');
    });

    it('sends nothing when the setting is turned off while the node is being selected', async () => {
        /** @type {(v?: any) => void} */
        let resolve = () => {};
        /** @type {any} */ (api.selectSpeedTestNode).mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
        const p = exitIpFor('A', { immediate: true });
        await vi.advanceTimersByTimeAsync(0);
        resetExitIp();
        resolve();
        expect(await p).toBeNull();
        expect(api.lookupExitIp).not.toHaveBeenCalled();
    });

    it('drops a lookup that lands after the setting was turned off', async () => {
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

    it('keeps only known fields', () => {
        expect(normalizeExitIp({ ip: '', country: 'X' })).toBeNull();
        expect(normalizeExitIp({ ip: '1.1.1.1', asn: 13335, is_eu: false, latitude: 'x', city: ' ' })).toEqual({ ip: '1.1.1.1', country: '', source: '', asn: 13335, is_eu: false });
    });
});
