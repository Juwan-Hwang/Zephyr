import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    ApiError,
    stripSpeedTestGroup,
    SPEED_TEST_GROUP,
    setBaseUrl,
    setSecret,
    isCoreReachable,
    setCoreReachable,
    getProxies,
    getProxiesMerged,
    clearProviderCache,
    SPECIAL_PROXY_NAMES,
    switchProxy,
    getConfig,
    patchConfig,
    reloadConfig,
    closeAllConnections,
    getConnections,
    closeConnection,
    abortLatencyTests,
    resetLatencyTestController,
    testProxy,
    enableAutoStart,
    disableAutoStart,
    isAutoStartEnabled,
    openConfigFolder,
    restartCore,
    readCoreLog,
    invoke,
    listen,
    openUrl,
    getCurrentWindow,
} from './api.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  ApiError
// ═══════════════════════════════════════════════════════════════════════════════


/**
 * Stubs fetch so each request waits until the test answers it.
 * @returns {Array<{ body: string, answer: (v: any) => void }>} the requests, in the order sent
 */
function holdFetches() {
    /** @type {Array<{ body: string, answer: (v: any) => void }>} */
    const sent = [];
    vi.stubGlobal('fetch', vi.fn((url, init) => new Promise((resolve) => {
        sent.push({ body: `${url} ${init.body}`, answer: resolve });
    })));
    return sent;
}

describe('ApiError', () => {
    it('is an Error instance', () => {
        const err = new ApiError('test');
        expect(err).toBeInstanceOf(Error);
        expect(err).toBeInstanceOf(ApiError);
    });

    it('has name ApiError', () => {
        expect(new ApiError('test').name).toBe('ApiError');
    });

    it('stores message', () => {
        expect(new ApiError('something failed').message).toBe('something failed');
    });

    it('defaults status/endpoint/cause to null', () => {
        const err = new ApiError('test');
        expect(err.status).toBeNull();
        expect(err.endpoint).toBeNull();
        expect(err.cause).toBeNull();
    });

    it('accepts status', () => {
        expect(new ApiError('test', { status: 404 }).status).toBe(404);
    });

    it('accepts endpoint', () => {
        expect(new ApiError('test', { endpoint: '/proxies' }).endpoint).toBe('/proxies');
    });

    it('accepts cause', () => {
        const cause = new Error('original');
        expect(new ApiError('test', { cause }).cause).toBe(cause);
    });

    it('accepts all options', () => {
        const cause = new TypeError('network');
        const err = new ApiError('HTTP 500: Internal Server Error', {
            status: 500,
            endpoint: '/configs',
            cause,
        });
        expect(err.message).toBe('HTTP 500: Internal Server Error');
        expect(err.status).toBe(500);
        expect(err.endpoint).toBe('/configs');
        expect(err.cause).toBe(cause);
    });

    it('ignores extra properties in options', () => {
        // @ts-expect-error -- intentionally passing unknown property to test it is ignored
        const err = new ApiError('test', { status: 200, extra: 'ignored' });
        expect(err.status).toBe(200);
        expect(err).not.toHaveProperty('extra');
    });

    it('defaults to empty options object when omitted', () => {
        const err = new ApiError('no opts');
        expect(err.status).toBeNull();
        expect(err.endpoint).toBeNull();
        expect(err.cause).toBeNull();
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  setBaseUrl
// ═══════════════════════════════════════════════════════════════════════════════

describe('setBaseUrl', () => {
    it('changes the base URL without error', () => {
        expect(() => setBaseUrl('http://localhost:8080')).not.toThrow();
    });

    it('accepts various URL formats', () => {
        expect(() => setBaseUrl('http://127.0.0.1:9090')).not.toThrow();
        expect(() => setBaseUrl('https://example.com:8080')).not.toThrow();
        expect(() => setBaseUrl('http://192.168.1.1:7890')).not.toThrow();
    });

    it('is a function', () => {
        expect(typeof setBaseUrl).toBe('function');
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  setSecret
// ═══════════════════════════════════════════════════════════════════════════════

describe('setSecret', () => {
    it('sets secret without error', () => {
        expect(() => setSecret('my-secret')).not.toThrow();
    });

    it('handles empty string', () => {
        expect(() => setSecret('')).not.toThrow();
    });

    it('handles falsy values', () => {
        expect(() => setSecret(/** @type {any} */ (null))).not.toThrow();
        expect(() => setSecret(/** @type {any} */ (undefined))).not.toThrow();
    });

    it('is a function', () => {
        expect(typeof setSecret).toBe('function');
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  isCoreReachable / setCoreReachable
// ═══════════════════════════════════════════════════════════════════════════════

describe('isCoreReachable', () => {
    afterEach(() => {
        setCoreReachable(true);
    });

    it('returns true by default', () => {
        expect(isCoreReachable()).toBe(true);
    });

    it('returns false after setCoreReachable(false)', () => {
        setCoreReachable(false);
        expect(isCoreReachable()).toBe(false);
    });

    it('returns true after setCoreReachable(true)', () => {
        setCoreReachable(false);
        setCoreReachable(true);
        expect(isCoreReachable()).toBe(true);
    });

    it('is a function', () => {
        expect(typeof isCoreReachable).toBe('function');
    });
});

describe('setCoreReachable', () => {
    afterEach(() => {
        setCoreReachable(true);
    });

    it('does not throw', () => {
        expect(() => setCoreReachable(true)).not.toThrow();
        expect(() => setCoreReachable(false)).not.toThrow();
    });

    it('is a function', () => {
        expect(typeof setCoreReachable).toBe('function');
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  API functions — existence & type checks
// ═══════════════════════════════════════════════════════════════════════════════

describe('API exports', () => {
    it('exports getProxies as async function', () => {
        expect(typeof getProxies).toBe('function');
    });

    it('exports switchProxy as async function', () => {
        expect(typeof switchProxy).toBe('function');
    });

    it('exports getConfig as async function', () => {
        expect(typeof getConfig).toBe('function');
    });

    it('exports patchConfig as async function', () => {
        expect(typeof patchConfig).toBe('function');
    });

    it('exports reloadConfig as async function', () => {
        expect(typeof reloadConfig).toBe('function');
    });

    it('exports closeAllConnections as async function', () => {
        expect(typeof closeAllConnections).toBe('function');
    });

    it('exports getConnections as async function', () => {
        expect(typeof getConnections).toBe('function');
    });

    it('exports closeConnection as async function', () => {
        expect(typeof closeConnection).toBe('function');
    });

    it('exports abortLatencyTests as function', () => {
        expect(typeof abortLatencyTests).toBe('function');
    });

    it('exports testProxy as async function', () => {
        expect(typeof testProxy).toBe('function');
    });

    it('exports enableAutoStart as async function', () => {
        expect(typeof enableAutoStart).toBe('function');
    });

    it('exports disableAutoStart as async function', () => {
        expect(typeof disableAutoStart).toBe('function');
    });

    it('exports isAutoStartEnabled as async function', () => {
        expect(typeof isAutoStartEnabled).toBe('function');
    });

    it('exports openConfigFolder as async function', () => {
        expect(typeof openConfigFolder).toBe('function');
    });

    it('exports restartCore as async function', () => {
        expect(typeof restartCore).toBe('function');
    });

    it('exports readCoreLog as async function', () => {
        expect(typeof readCoreLog).toBe('function');
    });

    it('exports invoke as function', () => {
        expect(typeof invoke).toBe('function');
    });

    it('exports listen as async function', () => {
        expect(typeof listen).toBe('function');
    });

    it('exports openUrl as async function', () => {
        expect(typeof openUrl).toBe('function');
    });

    it('exports getCurrentWindow as function', () => {
        expect(typeof getCurrentWindow).toBe('function');
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  API functions — behavior via mocked fetch
// ═══════════════════════════════════════════════════════════════════════════════

describe('getProxies', () => {
    it.each([true, false])('keeps controller data when one native generation read fails (before=%s)', async (before) => {
        let reads = 0;
        const invokeSpy = vi.fn(async (command) => {
            if (command === 'speed_test_group_owned') return false;
            reads += 1;
            if (reads === (before ? 1 : 2)) throw new Error('IPC unavailable');
            return 7;
        });
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke: invokeSpy, transformCallback: vi.fn() });
        const request = vi.fn(async () => ({ ok: true, json: async () => ({ proxies: {
            Proxy: { now: 'node' },
            'ZEPHYR-SPEED-TEST': { type: 'Selector', all: ['node'] },
        } }) }));
        vi.stubGlobal('fetch', request);
        vi.resetModules();
        try {
            const api = await import('./api.js');
            expect(await api.getProxies()).toEqual({ proxies: { Proxy: { now: 'node' } } });
            expect(request).toHaveBeenCalledOnce();
        } finally { vi.unstubAllGlobals(); vi.resetModules(); }
    });
    it.each([false, true])('retries a failed read only across a reload (changed=%s)', async (changed) => {
        const api = await import('./api.js');
        const request = vi.fn().mockImplementationOnce(async () => {
            if (changed) api.clearProviderCache();
            return new Response('busy', { status: 503 });
        }).mockResolvedValue(new Response('{"proxies":{}}'));
        vi.stubGlobal('fetch', request);
        try {
            if (changed) await expect(api.getProxies()).resolves.toEqual({ proxies: {} });
            else await expect(api.getProxies()).rejects.toMatchObject({ status: 503 });
            expect(request).toHaveBeenCalledTimes(changed ? 2 : 1);
        } finally { vi.unstubAllGlobals(); }
    });
    it('retries a native generation change when the reserved group is absent', async () => {
        let nativeGeneration = 1;
        let reads = 0;
        vi.stubGlobal('__TAURI_INTERNALS__', {
            invoke: vi.fn(async () => nativeGeneration),
            transformCallback: vi.fn(),
        });
        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => {
            reads += 1;
            if (reads === 1) nativeGeneration += 1;
            return { proxies: { Proxy: { now: reads === 1 ? 'old' : 'current' } } };
        } })));
        vi.resetModules();
        try {
            const api = await import('./api.js');
            expect(await api.getProxies()).toEqual({ proxies: { Proxy: { now: 'current' } } });
            expect(reads).toBe(2);
        } finally {
            vi.unstubAllGlobals();
            vi.resetModules();
        }
    });
    it('retries a response invalidated by a configuration reload', async () => {
        let reads = 0;
        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => {
            reads += 1;
            if (reads === 1) clearProviderCache();
            return { proxies: { Proxy: { now: reads === 1 ? 'old' : 'current' } } };
        } })));
        try {
            expect(await getProxies()).toEqual({ proxies: { Proxy: { now: 'current' } } });
            expect(reads).toBe(2);
        } finally {
            resetLatencyTestController();
            vi.unstubAllGlobals();
        }
    });
    it('returns parsed JSON on success', async () => {
        const mockData = { proxies: { 'GLOBAL': { name: 'GLOBAL', type: 'Selector' } } };
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: true,
            json: () => Promise.resolve(mockData),
        }));

        const result = await getProxies();
        expect(result).toEqual(mockData);
        vi.unstubAllGlobals();
    });

    it('throws ApiError on non-ok response', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: false,
            status: 503,
            statusText: 'Service Unavailable',
        }));

        await expect(getProxies()).rejects.toThrow('HTTP 503');
        vi.unstubAllGlobals();
    });
});

describe('switchProxy', () => {
    // Cleanup runs even when an assertion fails, so a stubbed Tauri bridge or
    // fetch never leaks into later tests.
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.resetModules();
    });

    it('never falls back to a direct HTTP PUT for GLOBAL switches', async () => {
        // Without IPC the GLOBAL path fails closed. Re-import api.js after
        // stubbing, since the bridge is captured at module load.
        const fetchSpy = vi.fn();
        vi.stubGlobal('fetch', fetchSpy);
        vi.stubGlobal('__TAURI_INTERNALS__', undefined);
        vi.resetModules();
        const api = await import('./api.js');

        const result = await api.switchProxy('GLOBAL', 'Auto');
        expect(result).toBe(false);
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('invokes switch_global_node when IPC is available', async () => {
        // Provide IPC before importing api.js (the bridge is captured at module
        // load), then verify the command name and arguments.
        const invokeSpy = vi.fn().mockResolvedValue(undefined);
        vi.stubGlobal('__TAURI_INTERNALS__', {
            invoke: invokeSpy,
            transformCallback: vi.fn(),
        });
        vi.resetModules();
        const api = await import('./api.js');

        const result = await api.switchProxy('GLOBAL', 'Auto');
        expect(result).toBe(true);
        expect(invokeSpy).toHaveBeenCalledWith('switch_global_node', { name: 'Auto' });

        // A user-defined group named "Global" uses the ordinary native lock.
        const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
        vi.stubGlobal('fetch', fetchSpy);
        const otherResult = await api.switchProxy('Global', 'Node1');
        expect(otherResult).toBe(true);
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(invokeSpy).toHaveBeenCalledWith('switch_proxy_node', { group: 'Global', name: 'Node1' });
        expect(invokeSpy).toHaveBeenCalledTimes(2);

    });

    it('readAutoStartEnabled throws when the state cannot be read, unlike isAutoStartEnabled', async () => {
        vi.stubGlobal('__TAURI_INTERNALS__', {
            invoke: vi.fn().mockRejectedValue(new Error('registry unavailable')),
            transformCallback: vi.fn(),
        });
        vi.resetModules();
        const api = await import('./api.js');
        await expect(api.readAutoStartEnabled()).rejects.toThrow('registry unavailable');
        await expect(api.isAutoStartEnabled()).resolves.toBe(false);
    });

    it('disableAutoStart still disables when the state cannot be read', async () => {
        const invokeSpy = vi.fn((cmd) => (cmd === 'plugin:autostart|is_enabled'
            ? Promise.reject(new Error('registry unavailable'))
            : Promise.resolve(null)));
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke: invokeSpy, transformCallback: vi.fn() });
        vi.resetModules();
        const api = await import('./api.js');
        await expect(api.disableAutoStart()).resolves.toBe(true);
        expect(invokeSpy.mock.calls.map(([cmd]) => cmd)).toContain('plugin:autostart|disable');
    });

    it('reports a rejected backend GLOBAL switch as false', async () => {
        // The backend rejects with a plain Error carrying the real reason (e.g.
        // "Subscription update in progress", "GLOBAL proxy group no longer
        // contains node '<name>'"). `switchProxy` is boolean-returning, so the
        // contract callers rely on is `false` plus no HTTP fallback.
        const invokeSpy = vi.fn().mockRejectedValue(new Error('GLOBAL proxy group no longer contains node \'Auto\''));
        vi.stubGlobal('__TAURI_INTERNALS__', {
            invoke: invokeSpy,
            transformCallback: vi.fn(),
        });
        vi.resetModules();
        const api = await import('./api.js');

        const fetchSpy = vi.fn();
        vi.stubGlobal('fetch', fetchSpy);

        const result = await api.switchProxy('GLOBAL', 'Auto');
        expect(result).toBe(false);
        expect(invokeSpy).toHaveBeenCalledWith('switch_global_node', { name: 'Auto' });
        // Never retried as a direct PUT: that would bypass the restore lock.
        expect(fetchSpy).not.toHaveBeenCalled();

    });

    it.each([false, true])('keeps native ordinary switch uncertainty explicit (unconfirmed=%s)', async (unconfirmed) => {
        const reason = unconfirmed ? 'Proxy switch outcome is unconfirmed: timed out' : 'Group has no such node';
        const invokeSpy = vi.fn(async () => { throw new Error(reason); });
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke: invokeSpy, transformCallback: vi.fn() });
        vi.stubGlobal('fetch', vi.fn());
        vi.resetModules();
        try {
            const api = await import('./api.js');
            expect(await api.switchProxyResult('Proxy', 'node')).toMatchObject({ ok: false, maybeApplied: unconfirmed });
            expect(invokeSpy).toHaveBeenCalledWith('switch_proxy_node', { group: 'Proxy', name: 'node' });
            expect(fetch).not.toHaveBeenCalled();
        } finally { vi.unstubAllGlobals(); vi.resetModules(); }
    });

    it('returns true on success', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: true,
        }));

        const result = await switchProxy('Proxy', 'Auto');
        expect(result).toBe(true);
        vi.unstubAllGlobals();
    });

    it('throws ApiError on failure', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: false,
            status: 404,
            statusText: 'Not Found',
        }));

        await expect(switchProxy('Proxy', 'Bad')).rejects.toThrow();
        vi.unstubAllGlobals();
    });

    it('skips only when the queued group read already selects the requested node', async () => {
        const api = await import('./api.js');
        vi.stubGlobal('fetch', vi.fn(async (_url, init) => init.method === 'PUT'
            ? { ok: true }
            : { ok: true, json: async () => ({ proxies: { Proxy: { now: 'node-a.example' } } }) }));
        const first = await api.switchProxyResult('Proxy', 'node-a.example');
        const beforeSend = vi.fn();
        const result = await api.switchProxyResult('Proxy', 'node-a.example', { skipIfCurrent: true, beforeSend });
        expect(result).toMatchObject({ ok: true, unchanged: true });
        expect(beforeSend).not.toHaveBeenCalled();
        expect(vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(1);
        expect(api.isLatestSwitch('Proxy', first.seq)).toBe(true);
    });

    it('sends the requested selection when the queued group read reports another node', async () => {
        const api = await import('./api.js');
        vi.stubGlobal('fetch', vi.fn(async (_url, init) => init.method === 'PUT'
            ? { ok: true }
            : { ok: true, json: async () => ({ proxies: { Proxy: { now: 'node-b.example' } } }) }));
        const beforeSend = vi.fn();
        const result = await api.switchProxyResult('Proxy', 'node-a.example', { skipIfCurrent: true, beforeSend });
        expect(result.ok).toBe(true);
        expect(beforeSend).toHaveBeenCalledOnce();
        expect(result.unchanged).not.toBe(true);
        expect(vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(1);
    });

    it('still sends a switch if the optional current-selection read fails', async () => {
        const api = await import('./api.js');
        vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
            if (init.method === 'PUT') return { ok: true };
            throw new Error('temporary read failure');
        }));
        await expect(api.switchProxyResult('Proxy', 'node-a.example', { skipIfCurrent: true })).resolves.toMatchObject({ ok: true });
        expect(vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(1);
    });

    it('counts a switch as started and in flight until it is answered', async () => {
        const api = await import('./api.js');
        /** @type {(v: any) => void} */
        let answer = () => {};
        vi.stubGlobal('fetch', vi.fn(() => new Promise((resolve) => { answer = resolve; })));
        const mark = api.proxySwitchMark();
        expect(api.proxySwitchedSince(mark)).toBe(false);
        const pending = api.switchProxyResult('Proxy', 'node-a.example');
        expect(api.proxySwitchedSince(mark)).toBe(true);
        await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
        answer({ ok: true });
        expect(await pending).toMatchObject({ ok: true, reason: null });
        // Answered: only the newer start counts now.
        expect(api.proxySwitchedSince(mark)).toBe(true);
        expect(api.proxySwitchedSince(api.proxySwitchMark())).toBe(false);
        // Not when it was the caller's own (answered) switch.
        expect(api.proxySwitchedSince(mark, 1)).toBe(false);
        vi.unstubAllGlobals();
    });

    it('a refused switch does not count when only landed ones matter', async () => {
        const api = await import('./api.js');
        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 400, text: async () => 'no' })));
        const mark = api.proxySwitchMark();
        expect((await api.switchProxyResult('Proxy', 'gone.example')).ok).toBe(false);
        expect(api.proxySwitchedSince(mark)).toBe(true);
        expect(api.proxySwitchedSince(mark, 0, { landedOnly: true })).toBe(false);
        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })));
        expect((await api.switchProxyResult('Proxy', 'node.example')).ok).toBe(true);
        expect(api.proxySwitchedSince(mark, 0, { landedOnly: true })).toBe(true);
        vi.unstubAllGlobals();
    });

    it('reports a direct switch that timed out as possibly applied, not as an error', async () => {
        const api = await import('./api.js');
        vi.stubGlobal('fetch', vi.fn(async () => { throw new DOMException('Aborted', 'AbortError'); }));
        const result = await api.switchProxyResult('Proxy', 'node.example');
        expect(result.ok).toBe(false);
        expect(result.maybeApplied).toBe(true);
        expect(result.error).toBeUndefined();
        // A connection that failed outright still rejects: nothing went out.
        vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
        await expect(api.switchProxyResult('Proxy', 'node.example')).rejects.toBeTruthy();
        vi.unstubAllGlobals();
    });

    it('counts a sent switch that got no answer as possibly landed', async () => {
        const api = await import('./api.js');
        // The core may have applied it before the connection dropped.
        vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('network down'); }));
        const mark = api.proxySwitchMark();
        await expect(api.switchProxyResult('Proxy', 'node.example')).rejects.toBeTruthy();
        expect(api.proxySwitchedSince(mark, 0, { landedOnly: true })).toBe(true);
        // One whose prepare threw never went out: it changed nothing.
        const mark2 = api.proxySwitchMark();
        await expect(api.switchProxyResult('Proxy', 'node.example', {
            prepare: async () => { throw new Error('no profile'); },
        })).rejects.toBeTruthy();
        expect(api.proxySwitchedSince(mark2, 0, { landedOnly: true })).toBe(false);
        vi.unstubAllGlobals();
    });

    it('sends switches of one group in the order they were made', async () => {
        const api = await import('./api.js');
        const sent = holdFetches();
        const first = api.switchProxyResult('Proxy', 'node-a.example');
        const second = api.switchProxyResult('Proxy', 'node-b.example');
        const other = api.switchProxyResult('Other', 'node-c.example');
        await vi.waitFor(() => expect(sent).toHaveLength(2));
        // The second switch of Proxy waits for the first; Other does not.
        expect(sent.map((s) => s.body)).toEqual([
            expect.stringContaining('/proxies/Proxy {"name":"node-a.example"}'),
            expect.stringContaining('/proxies/Other {"name":"node-c.example"}'),
        ]);
        sent[0].answer({ ok: false, status: 500, statusText: 'Error', text: async () => '' });
        await vi.waitFor(() => expect(sent).toHaveLength(3));
        expect(sent[2].body).toContain('/proxies/Proxy {"name":"node-b.example"}');
        sent[1].answer({ ok: true });
        sent[2].answer({ ok: true });
        expect((await first).ok).toBe(false);
        expect((await second).ok).toBe(true);
        expect((await other).ok).toBe(true);
    });

    it('drops a switch still waiting when the core restarts', async () => {
        let finishSwitch = () => {};
        vi.stubGlobal('__TAURI_INTERNALS__', {
            invoke: vi.fn(async (command) => command === 'switch_proxy_node'
                ? new Promise((resolve) => { finishSwitch = () => resolve(undefined); })
                : { port: 9091, secret: 's', active_config: 'b.yaml' }),
            transformCallback: vi.fn(),
        });
        vi.resetModules();
        const api = await import('./api.js');
        const bridge = globalThis.__TAURI_INTERNALS__.invoke;
        const first = api.switchProxyResult('Proxy', 'node-a.example');
        const waiting = api.switchProxyResult('Proxy', 'node-b.example');
        await vi.waitFor(() => expect(bridge).toHaveBeenCalledWith('switch_proxy_node', { group: 'Proxy', name: 'node-a.example' }));
        await api.restartCore('b.yaml');
        finishSwitch();
        expect((await first).ok).toBe(true);
        expect(await waiting).toMatchObject({ ok: false, reason: api.SWITCH_BUSY });
        expect(bridge.mock.calls.filter(([command]) => command === 'switch_proxy_node')).toHaveLength(1);
        vi.unstubAllGlobals();
    });

    it('drops a switch whose turn comes while the core restarts', async () => {
        /** @type {(v: any) => void} */
        let finishStart = () => {};
        let finishSwitch = () => {};
        vi.stubGlobal('__TAURI_INTERNALS__', {
            invoke: vi.fn((command) => new Promise((resolve) => {
                if (command === 'switch_proxy_node') finishSwitch = () => resolve(undefined);
                else finishStart = resolve;
            })),
            transformCallback: vi.fn(),
        });
        vi.resetModules();
        const api = await import('./api.js');
        const bridge = globalThis.__TAURI_INTERNALS__.invoke;
        const first = api.switchProxyResult('Proxy', 'node-a.example');
        const waiting = api.switchProxyResult('Proxy', 'node-b.example');
        await vi.waitFor(() => expect(bridge).toHaveBeenCalledWith('switch_proxy_node', { group: 'Proxy', name: 'node-a.example' }));
        const restart = api.restartCore('b.yaml');
        // Its turn comes before the restart has finished.
        finishSwitch();
        expect((await first).ok).toBe(true);
        expect(await waiting).toMatchObject({ ok: false, reason: api.SWITCH_BUSY });
        expect(bridge.mock.calls.filter(([command]) => command === 'switch_proxy_node')).toHaveLength(1);
        finishStart({ port: 9091, secret: 's', active_config: 'b.yaml' });
        await restart;
        vi.unstubAllGlobals();
    });

    it('prepares each switch in its turn and drops one the caller no longer lets go out', async () => {
        vi.resetModules();
        const api = await import('./api.js');
        /** @type {Array<(v: any) => void>} */
        const answers = [];
        vi.stubGlobal('fetch', vi.fn(() => new Promise((resolve) => { answers.push(resolve); })));
        /** @type {string[]} */
        const order = [];
        /** @type {(v: string) => void} */
        let finishRead = () => {};
        // The first click's read is slow: the second click still goes out after it.
        const first = api.switchProxyResult('Proxy', 'node-a.example', {
            prepare: () => new Promise((resolve) => { finishRead = (v) => { order.push('read a'); resolve(v); }; }),
        });
        let busy = false;
        const second = api.switchProxyResult('Proxy', 'node-b.example', {
            prepare: async () => { order.push('read b'); return 'b.yaml'; },
            canSend: () => !busy,
        });
        await Promise.resolve();
        expect(fetch).not.toHaveBeenCalled();
        finishRead('a.yaml');
        await vi.waitFor(() => expect(answers).toHaveLength(1));
        busy = true;
        answers[0]({ ok: true });
        expect(await first).toMatchObject({ ok: true, reason: null, prepared: 'a.yaml' });
        expect(await second).toMatchObject({ ok: false, reason: api.SWITCH_BUSY, prepared: 'b.yaml' });
        expect(order).toEqual(['read a', 'read b']);
        expect(fetch).toHaveBeenCalledTimes(1);
        vi.unstubAllGlobals();
    });

    it('lets a canSend check leave out the switch it is made for, but not another one', async () => {
        vi.resetModules();
        const api = await import('./api.js');
        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })));
        const mark = api.proxySwitchMark();
        // Its own switch alone is running: not superseded.
        const own = await api.switchProxyResult('Proxy', 'node-a.example', {
            canSend: () => !api.proxySwitchedSince(mark, 1, { ownInFlight: 1 }),
        });
        expect(own).toMatchObject({ ok: true });
        // Without ownInFlight its own running switch counts as a newer one.
        const mark2 = api.proxySwitchMark();
        const blind = await api.switchProxyResult('Proxy', 'node-a.example', {
            canSend: () => !api.proxySwitchedSince(mark2, 1),
        });
        expect(blind).toMatchObject({ ok: false, reason: api.SWITCH_BUSY });
        // Another switch started meanwhile still counts.
        const mark3 = api.proxySwitchMark();
        const other = api.switchProxyResult('Other', 'node-x.example');
        const late = await api.switchProxyResult('Proxy', 'node-b.example', {
            canSend: () => !api.proxySwitchedSince(mark3, 1, { ownInFlight: 1 }),
        });
        await other;
        expect(late).toMatchObject({ ok: false, reason: api.SWITCH_BUSY });
        vi.unstubAllGlobals();
    });

    it('counts a switch unanswered when the mark was taken as one made after it', async () => {
        vi.resetModules();
        const api = await import('./api.js');
        /** @type {Array<(v: any) => void>} */
        const answers = [];
        vi.stubGlobal('fetch', vi.fn(() => new Promise((resolve) => { answers.push(resolve); })));
        const pending = api.switchProxyResult('Proxy', 'node-a.example');
        await vi.waitFor(() => expect(answers).toHaveLength(1));
        const mark = api.proxySwitchMark();
        answers[0]({ ok: true });
        await pending;
        // Answered after the mark: its caller may not have recorded its node yet.
        expect(api.proxySwitchedSince(mark, 0, { landedOnly: true })).toBe(true);
        expect(api.proxySwitchedSince(api.proxySwitchMark())).toBe(false);
        vi.unstubAllGlobals();
    });

    it('drops a switch whose turn comes while restartCore runs', async () => {
        /** @type {(v: any) => void} */
        let finishStart = () => {};
        vi.stubGlobal('__TAURI_INTERNALS__', {
            invoke: vi.fn(() => new Promise((resolve) => { finishStart = resolve; })),
            transformCallback: vi.fn(),
        });
        vi.resetModules();
        const api = await import('./api.js');
        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })));
        const restart = api.restartCore('b.yaml');
        // Made while the restart runs, with no switch ahead of it.
        expect(await api.switchProxyResult('Proxy', 'node-a.example')).toMatchObject({ ok: false, reason: api.SWITCH_BUSY });
        expect(fetch).not.toHaveBeenCalled();
        finishStart({ port: 9091, secret: 's', active_config: 'b.yaml' });
        await restart;
        vi.unstubAllGlobals();
    });

    it('waits for running switches before a profile switch reads the node', async () => {
        vi.resetModules();
        const api = await import('./api.js');
        /** @type {Array<(v: any) => void>} */
        const answers = [];
        vi.stubGlobal('fetch', vi.fn(() => new Promise((resolve) => { answers.push(resolve); })));
        expect(await api.settleProxySwitches(10)).toBe(true);
        const first = api.switchProxyResult('Proxy', 'node-a.example');
        const second = api.switchProxyResult('Proxy', 'node-b.example');
        await vi.waitFor(() => expect(answers).toHaveLength(1));
        // Still running at the timeout.
        expect(await api.settleProxySwitches(10)).toBe(false);
        const settled = api.settleProxySwitches(5000);
        answers[0]({ ok: true });
        await vi.waitFor(() => expect(answers).toHaveLength(2));
        answers[1]({ ok: true });
        expect(await settled).toBe(true);
        await Promise.all([first, second]);
        // Nothing in flight once settled.
        expect(api.proxySwitchedSince(api.proxySwitchMark())).toBe(false);
        vi.unstubAllGlobals();
    });

    it('keeps an accepted switch the newest when a later one waiting for its answer fails', async () => {
        vi.resetModules();
        const api = await import('./api.js');
        /** @type {Array<(v: any) => void>} */
        const answers = [];
        vi.stubGlobal('fetch', vi.fn(() => new Promise((resolve) => { answers.push(resolve); })));
        const first = api.switchProxyResult('Proxy', 'node-a.example');
        const second = api.switchProxyResult('Proxy', 'node-b.example');
        await vi.waitFor(() => expect(answers).toHaveLength(1));
        answers[0]({ ok: true });
        const a = await first;
        // The later one is still waiting: the accepted one stands for now.
        expect(api.isLatestSwitch('Proxy', a.seq)).toBe(true);
        await vi.waitFor(() => expect(answers).toHaveLength(2));
        answers[1]({ ok: false, status: 400, text: async () => 'no' });
        const b = await second;
        expect(b.ok).toBe(false);
        expect(api.isLatestSwitch('Proxy', a.seq)).toBe(true);
        // Once the core is replaced, it runs its own selection.
        api.noteCoreReplaced();
        expect(api.isLatestSwitch('Proxy', a.seq)).toBe(false);
        vi.unstubAllGlobals();
    });

    it('an accepted switch is no longer the newest once a later one went out and got no answer', async () => {
        vi.resetModules();
        const api = await import('./api.js');
        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })));
        const a = await api.switchProxyResult('Proxy', 'node-a.example');
        // B reaches the core, but the connection drops before its answer:
        // the core may run it.
        vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('connection reset'); }));
        await expect(api.switchProxyResult('Proxy', 'node-b.example')).rejects.toBeTruthy();
        expect(api.isLatestSwitch('Proxy', a.seq)).toBe(false);
        vi.unstubAllGlobals();
    });

    it('a GLOBAL switch the core did not confirm counts as possibly landed, a refused one does not', async () => {
        const invokeSpy = vi.fn(async () => undefined);
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke: invokeSpy, transformCallback: vi.fn() });
        vi.resetModules();
        const api = await import('./api.js');
        const a = await api.switchProxyResult('GLOBAL', 'node-a.example');
        expect(a.ok).toBe(true);
        // Refused by the backend: the core did not switch.
        invokeSpy.mockRejectedValueOnce("GLOBAL proxy group no longer contains node 'node-b.example'");
        const b = await api.switchProxyResult('GLOBAL', 'node-b.example');
        expect(b.ok).toBe(false);
        expect(api.isLatestSwitch('GLOBAL', a.seq)).toBe(true);
        // Sent but not confirmed (a timeout): the core may run it.
        // Not sent (no core, or an error answer): it changed nothing.
        invokeSpy.mockRejectedValueOnce('The core did not switch the GLOBAL proxy group');
        const n = await api.switchProxyResult('GLOBAL', 'node-n.example');
        expect(n.ok).toBe(false);
        expect(api.isLatestSwitch('GLOBAL', a.seq)).toBe(true);
        invokeSpy.mockRejectedValueOnce('Failed to switch GLOBAL proxy group (no answer from the core)');
        const c = await api.switchProxyResult('GLOBAL', 'node-c.example');
        expect(c.ok).toBe(false);
        expect(api.isLatestSwitch('GLOBAL', a.seq)).toBe(false);
        vi.unstubAllGlobals();
    });

    it('records GLOBAL selection intent even when the UI permits no-op shortcuts', async () => {
        const invokeSpy = vi.fn(async () => undefined);
        const request = vi.fn(async () => ({ ok: true, json: async () => ({ proxies: { GLOBAL: { now: 'selected-node' } } }) }));
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke: invokeSpy, transformCallback: vi.fn() });
        vi.stubGlobal('fetch', request);
        vi.resetModules();
        const api = await import('./api.js');
        try {
            expect(await api.switchProxyResult('GLOBAL', 'selected-node', { skipIfCurrent: true })).toMatchObject({ ok: true });
            expect(invokeSpy).toHaveBeenCalledWith('switch_global_node', { name: 'selected-node' });
            expect(request).not.toHaveBeenCalled();
        } finally { vi.unstubAllGlobals(); }
    });

    it.each([true, false])('confirms native readiness before reporting an unchanged selection (busy=%s)', async (busy) => {
        const invokeSpy = vi.fn(async (command) => {
            if (command === 'speed_test_ready_generation' && busy) throw new Error('reload active');
            return 7;
        });
        const request = vi.fn(async () => ({ ok: true, json: async () => ({ proxies: { Proxy: { now: 'selected-node' } } }) }));
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke: invokeSpy, transformCallback: vi.fn() });
        vi.stubGlobal('fetch', request);
        vi.resetModules();
        try {
            const api = await import('./api.js');
            const result = await api.switchProxyResult('Proxy', 'selected-node', { skipIfCurrent: true });
            expect(result.ok).toBe(!busy);
            if (busy) expect(result.reason).toBe(api.SWITCH_BUSY);
            else expect(result.unchanged).toBe(true);
            expect(request).toHaveBeenCalledOnce();
        } finally { vi.unstubAllGlobals(); vi.resetModules(); }
    });

    it.each([true, false])('checks the native generation before an optional switch precheck (changed=%s)', async (changed) => {
        let generation = 7;
        const invokeSpy = vi.fn(async () => generation);
        const request = vi.fn(async (_url, options) => {
            if (options?.method === 'PUT') return { ok: true };
            if (changed) generation = 8;
            return { ok: true, json: async () => ({ proxies: { Proxy: { now: 'old-node' } } }) };
        });
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke: invokeSpy, transformCallback: vi.fn() });
        vi.stubGlobal('fetch', request);
        vi.resetModules();
        try {
            const api = await import('./api.js');
            const result = await api.switchProxyResult('Proxy', 'selected-node', { skipIfCurrent: true });
            expect(result.ok).toBe(!changed);
            if (changed) expect(result.reason).toBe(api.SWITCH_BUSY);
            expect(request.mock.calls.filter(([, options]) => options?.method === 'PUT')).toHaveLength(0);
            expect(invokeSpy.mock.calls.filter(([command]) => command === 'switch_proxy_node')).toHaveLength(changed ? 0 : 1);
        } finally { vi.unstubAllGlobals(); vi.resetModules(); }
    });

    it('uses native generation and ownership admission for diagnostic selection', async () => {
        const invokeSpy = vi.fn(async () => undefined);
        const fetchSpy = vi.fn();
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke: invokeSpy, transformCallback: vi.fn() });
        vi.stubGlobal('fetch', fetchSpy);
        vi.resetModules();
        const api = await import('./api.js');
        try {
            await api.selectSpeedTestNode('node-a', 17, 'run-a');
            expect(invokeSpy).toHaveBeenCalledWith('speed_test_select_node', { name: 'node-a', generation: 17, run: 'run-a' });
            expect(fetchSpy).not.toHaveBeenCalled();
        } finally { vi.unstubAllGlobals(); }
    });

    it('an older accepted switch stays outdated after many refused switches of the group', async () => {
        vi.resetModules();
        const api = await import('./api.js');
        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })));
        const a = await api.switchProxyResult('Proxy', 'node-a.example');
        const b = await api.switchProxyResult('Proxy', 'node-b.example');
        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 400, text: async () => 'no' })));
        for (let i = 0; i < 300; i += 1) await api.switchProxyResult('Proxy', `node-${i}.example`);
        expect(api.isLatestSwitch('Proxy', a.seq)).toBe(false);
        expect(api.isLatestSwitch('Proxy', b.seq)).toBe(true);
        vi.unstubAllGlobals();
    });

    it('a later accepted switch stands over an earlier one', async () => {
        vi.resetModules();
        const api = await import('./api.js');
        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })));
        const a = await api.switchProxyResult('Proxy', 'node-a.example');
        const b = await api.switchProxyResult('Proxy', 'node-b.example');
        expect(api.isLatestSwitch('Proxy', a.seq)).toBe(false);
        expect(api.isLatestSwitch('Proxy', b.seq)).toBe(true);
        vi.unstubAllGlobals();
    });

    it('a later accepted switch in another group stands over an earlier one (one saved selection per profile)', async () => {
        vi.resetModules();
        const api = await import('./api.js');
        /** @type {Array<(v: any) => void>} */
        const answers = [];
        vi.stubGlobal('fetch', vi.fn(() => new Promise((resolve) => { answers.push(resolve); })));
        const tokyo = api.switchProxyResult('Proxy', 'node-tokyo.example');
        const osaka = api.switchProxyResult('Auto', 'node-osaka.example');
        await vi.waitFor(() => expect(answers).toHaveLength(2));
        // The later click (another group) is answered first.
        answers[1]({ ok: true });
        const b = await osaka;
        answers[0]({ ok: true });
        const a = await tokyo;
        expect(api.isLatestSwitch('Proxy', a.seq)).toBe(false);
        expect(api.isLatestSwitch('Auto', b.seq)).toBe(true);
        // Accepted by a core since replaced: it no longer stands over anything.
        api.noteCoreReplaced();
        const c = await (async () => {
            const next = api.switchProxyResult('Proxy', 'node-kyoto.example');
            await vi.waitFor(() => expect(answers).toHaveLength(3));
            answers[2]({ ok: true });
            return next;
        })();
        expect(api.isLatestSwitch('Proxy', c.seq)).toBe(true);
        vi.unstubAllGlobals();
    });

    it.each(['restart', 'reload'])('drops a waiting switch after a backend %s', async (change) => {
        vi.resetModules();
        const api = await import('./api.js');
        /** @type {Array<(v: any) => void>} */
        const answers = [];
        vi.stubGlobal('fetch', vi.fn(() => new Promise((resolve) => { answers.push(resolve); })));
        const first = api.switchProxyResult('Proxy', 'node-a.example');
        const waiting = api.switchProxyResult('Proxy', 'node-b.example');
        await vi.waitFor(() => expect(answers).toHaveLength(1));
        if (change === 'restart') api.noteCoreReplaced();
        else api.clearProviderCache();
        answers[0]({ ok: true });
        expect((await first).ok).toBe(true);
        expect(await waiting).toMatchObject({ ok: false, reason: api.SWITCH_BUSY });
        expect(fetch).toHaveBeenCalledTimes(1);
        vi.unstubAllGlobals();
    });

    it.each(['before-reply', 'after-reply'])('does not persist a switch invalidated by a hot reload (%s)', async (when) => {
        vi.resetModules();
        const api = await import('./api.js');
        let answer = (/** @type {any} */ _value) => {};
        vi.stubGlobal('fetch', vi.fn(() => new Promise((resolve) => { answer = resolve; })));
        try {
            const pending = api.switchProxyResult('Proxy', 'old-node');
            await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
            if (when === 'before-reply') api.clearProviderCache();
            answer({ ok: true });
            const result = await pending;
            if (when === 'after-reply') api.clearProviderCache();
            expect(result.ok).toBe(true);
            expect(api.isLatestSwitch('Proxy', result.seq)).toBe(false);
        } finally { vi.unstubAllGlobals(); }
    });
});

describe('getConfig', () => {
    it('returns parsed JSON on success', async () => {
        const mockConfig = { port: 9090, 'socks-port': 7891 };
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: true,
            json: () => Promise.resolve(mockConfig),
        }));

        const result = await getConfig();
        expect(result).toEqual(mockConfig);
        vi.unstubAllGlobals();
    });
});

describe('patchConfig', () => {
    it('returns true on success', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));

        const result = await patchConfig({ mode: 'rule' });
        expect(result).toBe(true);
        vi.unstubAllGlobals();
    });

    it('throws ApiError on failure', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: false,
            status: 500,
            statusText: 'Internal Server Error',
        }));

        await expect(patchConfig({ mode: 'rule' })).rejects.toThrow();
        vi.unstubAllGlobals();
    });
});

describe('reloadConfig', () => {
    it('returns true on success', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));

        const result = await reloadConfig();
        expect(result).toBe(true);
        vi.unstubAllGlobals();
    });

    it('returns false on network error', async () => {
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));

        const result = await reloadConfig();
        expect(result).toBe(false);
        vi.unstubAllGlobals();
    });
});

describe('closeAllConnections', () => {
    it('does not throw on success', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));

        await expect(closeAllConnections()).resolves.toBeUndefined();
        vi.unstubAllGlobals();
    });

    it('throws on failure', async () => {
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('fail')));

        await expect(closeAllConnections()).rejects.toThrow('fail');
        vi.unstubAllGlobals();
    });
});

describe('getConnections', () => {
    it('returns parsed JSON on success', async () => {
        const mockData = { connections: [], downloadTotal: 0, uploadTotal: 0 };
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: true,
            json: () => Promise.resolve(mockData),
        }));

        const result = await getConnections();
        expect(result).toEqual(mockData);
        vi.unstubAllGlobals();
    });

    it('gives up on a body that never arrives and aborts its request', async () => {
        vi.useFakeTimers();
        try {
            /** @type {AbortSignal|undefined} */
            let signal;
            vi.stubGlobal('fetch', vi.fn((_url, init) => {
                signal = init.signal;
                // A real streaming body that stalls mid-JSON: res.json() locks it.
                // Aborting the request errors the body, as fetch does.
                const stream = new ReadableStream({
                    start(c) {
                        c.enqueue(new TextEncoder().encode('{"connections":['));
                        signal?.addEventListener('abort', () => c.error(new DOMException('Aborted', 'AbortError')));
                    },
                });
                return Promise.resolve(new Response(stream, { status: 200 }));
            }));
            const pending = getConnections();
            const failed = expect(pending).rejects.toBeInstanceOf(ApiError);
            await vi.advanceTimersByTimeAsync(10_000);
            await failed;
            expect(signal?.aborted).toBe(true);
        } finally {
            vi.useRealTimers();
            vi.unstubAllGlobals();
        }
    });

    it('leaves a request whose body arrived alone', async () => {
        /** @type {AbortSignal|undefined} */
        let signal;
        vi.stubGlobal('fetch', vi.fn((_url, init) => {
            signal = init.signal;
            return Promise.resolve(new Response('{"connections":[]}', { status: 200 }));
        }));
        await expect(getConnections()).resolves.toEqual({ connections: [] });
        expect(signal?.aborted).toBe(false);
        vi.unstubAllGlobals();
    });
});

describe('closeConnection', () => {
    it('does not throw on success', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));

        await expect(closeConnection('conn-id')).resolves.toBeUndefined();
        vi.unstubAllGlobals();
    });

    it('throws on failure', async () => {
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('fail')));

        await expect(closeConnection('conn-id')).rejects.toThrow('fail');
        vi.unstubAllGlobals();
    });

    it('accepts array of IDs', async () => {
        const fetchMock = vi.fn().mockResolvedValue({ ok: true });
        vi.stubGlobal('fetch', fetchMock);

        await expect(closeConnection(['id1', 'id2'])).resolves.toBeUndefined();
        // One DELETE /connections/:id each; never the bare close-all endpoint
        const urls = fetchMock.mock.calls.map((c) => String(c[0]));
        expect(urls.some((u) => u.endsWith('/connections/id1'))).toBe(true);
        expect(urls.some((u) => u.endsWith('/connections/id2'))).toBe(true);
        vi.unstubAllGlobals();
    });
});

describe('abortLatencyTests', () => {
    it('does not throw', () => {
        expect(() => abortLatencyTests()).not.toThrow();
    });

    it('can be called multiple times', () => {
        expect(() => {
            abortLatencyTests();
            abortLatencyTests();
            abortLatencyTests();
        }).not.toThrow();
    });
});

describe('testProxy', () => {
    it('discards a body whose completion is followed by Stop', async () => {
        const api = await import('./api.js');
        api.resetLatencyTestController();
        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => {
            api.abortLatencyTests();
            return { delay: 45 };
        } })));
        try { expect(await api.testProxy('node')).toBe(-1); }
        finally { api.resetLatencyTestController(); vi.unstubAllGlobals(); }
    });
    it('does not discover providers after Stop aborts a missing-proxy response', async () => {
        const api = await import('./api.js');
        api.resetLatencyTestController();
        const request = vi.fn(async () => ({
            ok: false, status: 404, statusText: 'Not Found',
            text: async () => { api.abortLatencyTests(); return ''; },
        }));
        vi.stubGlobal('fetch', request);
        try {
            expect(await api.testProxy('node')).toBe(-1);
            expect(request).toHaveBeenCalledOnce();
        } finally { api.resetLatencyTestController(); vi.unstubAllGlobals(); }
    });
    it('aborts the shared pass when a configuration reload invalidates its probe', async () => {
        const api = await import('./api.js');
        api.resetLatencyTestController();
        const signal = api.getLatencyTestSignal();
        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => {
            api.clearProviderCache();
            return { delay: 45 };
        } })));
        try {
            expect(await api.testProxy('node')).toBe(-1);
            expect(signal.aborted).toBe(true);
        } finally {
            api.resetLatencyTestController();
            vi.unstubAllGlobals();
        }
    });
    it('returns delay on success', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: true,
            json: () => Promise.resolve({ delay: 120 }),
        }));

        const result = await testProxy('Auto');
        expect(result).toBe(120);
        vi.unstubAllGlobals();
    });

    it('returns -1 on HTTP error', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: false,
            status: 404,
            statusText: 'Not Found',
        }));

        const result = await testProxy('BadProxy');
        expect(result).toBe(-1);
        vi.unstubAllGlobals();
    });

    it('returns -1 on network error', async () => {
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Connection refused')));

        const result = await testProxy('BadProxy');
        expect(result).toBe(-1);
        vi.unstubAllGlobals();
    });

    /** A delay answer whose body stalls mid-JSON until its request is aborted. */
    function stallingDelayBody() {
        /** @type {{ signal?: AbortSignal }} */
        const seen = {};
        vi.stubGlobal('fetch', vi.fn((_url, init) => {
            seen.signal = init.signal;
            const stream = new ReadableStream({
                start(c) {
                    c.enqueue(new TextEncoder().encode('{"delay":'));
                    init.signal?.addEventListener('abort', () => c.error(new DOMException('Aborted', 'AbortError')));
                },
            });
            return Promise.resolve(new Response(stream, { status: 200 }));
        }));
        return seen;
    }

    it('ends a test whose body stalls when its timeout passes', async () => {
        vi.useFakeTimers();
        try {
            const seen = stallingDelayBody();
            const pending = testProxy('Stalled', 1000);
            await vi.advanceTimersByTimeAsync(2_000);
            await expect(pending).resolves.toBe(-1);
            expect(seen.signal?.aborted).toBe(true);
        } finally {
            vi.useRealTimers();
            vi.unstubAllGlobals();
        }
    });

    it('ends a test whose body stalls when the tests are stopped', async () => {
        const seen = stallingDelayBody();
        resetLatencyTestController();
        const pending = testProxy('Stalled', 60_000);
        await vi.waitFor(() => expect(seen.signal).toBeDefined());
        await new Promise((r) => setTimeout(r, 0));
        abortLatencyTests();
        await expect(pending).resolves.toBe(-1);
        expect(seen.signal?.aborted).toBe(true);
        vi.unstubAllGlobals();
    });
});

describe('proxy reads used by serialized actions', () => {
    afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

    it('does not retry a vanished provider route when forced discovery fails', async () => {
        const api = await import('./api.js');
        api.clearProviderCache();
        let vanished = false;
        const request = vi.fn(async (url) => {
            const path = new URL(String(url)).pathname;
            if (path === '/providers/proxies') return vanished ? new Response('', { status: 503 })
                : new Response(JSON.stringify({ providers: { first: { proxies: [{ name: 'node' }] } } }));
            if (!vanished && path === '/providers/proxies/first/node') return new Response('{"name":"node"}');
            return new Response('', { status: 404 });
        });
        vi.stubGlobal('fetch', request);
        await api.getProxyRecord('node');
        vanished = true;
        request.mockClear();
        await expect(api.getProxyRecord('node')).rejects.toMatchObject({ status: 404 });
        expect(request.mock.calls.filter(([url]) => new URL(String(url)).pathname === '/providers/proxies/first/node')).toHaveLength(1);
    });

    it.each([false, true])('does not choose a provider by response order for duplicate names (reverse=%s)', async (reverse) => {
        const api = await import('./api.js');
        api.clearProviderCache();
        const entries = [['one', { proxies: [{ name: 'node' }] }], ['two', { proxies: [{ name: 'node' }] }]];
        if (reverse) entries.reverse();
        const request = vi.fn(async (url) => new URL(String(url)).pathname === '/providers/proxies'
            ? new Response(JSON.stringify({ providers: Object.fromEntries(entries) })) : new Response('', { status: 404 }));
        vi.stubGlobal('fetch', request);
        await expect(api.getProxyRecord('node')).rejects.toMatchObject({ status: 404 });
        expect(request.mock.calls.some(([url]) => new URL(String(url)).pathname.startsWith('/providers/proxies/'))).toBe(false);
    });

    it.each(['body', 'discovery', 'provider'])('cancels a node record during %s without later fallback requests', async (stage) => {
        const api = await import('./api.js');
        api.clearProviderCache();
        vi.useFakeTimers();
        const controller = new AbortController();
        let release = (/** @type {any} */ _value) => {};
        const request = vi.fn(async (url, init) => {
            const path = new URL(String(url)).pathname;
            if (stage !== 'body' && path === '/proxies/node') return new Response('', { status: 404 });
            if (path === '/providers/proxies') {
                if (stage === 'discovery') return { ok: true, json: () => new Promise((resolve) => { release = resolve; }) };
                return new Response(JSON.stringify({ providers: { remote: { proxies: [{ name: 'node' }] } } }));
            }
            return stalledBody(init.signal);
        });
        vi.stubGlobal('fetch', request);
        const pending = api.getProxyRecord('node', controller.signal);
        const cancelled = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
        try {
            await vi.advanceTimersByTimeAsync(0);
            expect(request).toHaveBeenCalledTimes(stage === 'body' ? 1 : stage === 'discovery' ? 2 : 3);
            controller.abort();
            await cancelled;
            const calls = request.mock.calls.length;
            release({ providers: { remote: { proxies: [{ name: 'node' }] } } });
            await vi.advanceTimersByTimeAsync(0);
            expect(request).toHaveBeenCalledTimes(calls);
        } finally { release({ providers: {} }); }
    });

    /** @param {AbortSignal} signal */
    function stalledBody(signal) {
        return new Response(new ReadableStream({
            start(controller) {
                controller.enqueue(new TextEncoder().encode('{'));
                signal.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')));
            },
        }));
    }

    it('aborts a stalled configuration body so startup can continue', async () => {
        vi.useFakeTimers();
        let bodySignal;
        vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
            bodySignal = init.signal;
            return stalledBody(init.signal);
        }));
        const failed = expect(getConfig()).rejects.toMatchObject({ name: 'ApiError', endpoint: '/configs' });
        await vi.advanceTimersByTimeAsync(10_001);
        await failed;
        expect(bodySignal?.aborted).toBe(true);
    });

    it.each([false, true])('refreshes a cached provider route after a node moves (latency=%s)', async (latency) => {
        const api = await import('./api.js');
        api.clearProviderCache();
        let owner = 'first';
        let providerReads = 0;
        vi.stubGlobal('fetch', vi.fn(async (url) => {
            const path = new URL(String(url)).pathname;
            if (path === '/providers/proxies') {
                providerReads++;
                return new Response(JSON.stringify({ providers: { [owner]: { proxies: [{ name: 'node' }] } } }));
            }
            if (path === `/providers/proxies/${owner}/node${latency ? '/healthcheck' : ''}`) {
                return new Response(JSON.stringify(latency ? { delay: 42 } : { name: 'node', owner }));
            }
            return new Response('', { status: 404 });
        }));
        const read = () => latency ? api.testProxy('node') : api.getProxyRecord('node');
        await read();
        owner = 'second';
        const result = await read();
        if (latency) expect(result).toBe(42);
        else expect(result).toMatchObject({ owner: 'second' });
        expect(providerReads).toBe(2);
    });

    it('releases the switch queue when the optional proxy body stalls', async () => {
        const api = await import('./api.js');
        vi.useFakeTimers();
        vi.stubGlobal('fetch', vi.fn(async (_url, init) => init.method === 'PUT'
            ? new Response(null, { status: 204 }) : stalledBody(init.signal)));
        const pending = api.switchProxyResult('Proxy', 'new-node', { skipIfCurrent: true });
        await vi.advanceTimersByTimeAsync(10_001);
        await expect(pending).resolves.toMatchObject({ ok: true });
        expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(true);
    });

    it.each([false, true])('aborts a stalled node-record body (provider=%s)', async (provider) => {
        const api = await import('./api.js');
        api.clearProviderCache();
        vi.useFakeTimers();
        let bodySignal;
        vi.stubGlobal('fetch', vi.fn(async (url, init) => {
            const path = new URL(String(url)).pathname;
            if (provider && path === '/proxies/node') return new Response('', { status: 404 });
            if (path === '/providers/proxies') return new Response(JSON.stringify({ providers: { remote: { proxies: [{ name: 'node' }] } } }));
            bodySignal = init.signal;
            return stalledBody(init.signal);
        }));
        const pending = api.getProxyRecord('node');
        const failed = expect(pending).rejects.toMatchObject({ name: 'ApiError' });
        await vi.advanceTimersByTimeAsync(10_001);
        await failed;
        expect(bodySignal?.aborted).toBe(true);
    });
});

describe('getCurrentWindow', () => {
    it('returns an object with expected methods', () => {
        const win = getCurrentWindow();
        expect(win).toHaveProperty('label');
        expect(typeof win.hide).toBe('function');
        expect(typeof win.show).toBe('function');
        expect(typeof win.close).toBe('function');
        expect(typeof win.minimize).toBe('function');
        expect(typeof win.maximize).toBe('function');
        expect(typeof win.setTitle).toBe('function');
        expect(typeof win.isVisible).toBe('function');
        expect(typeof win.setFocus).toBe('function');
    });

    it('has default label "main" when no Tauri internals', () => {
        const win = getCurrentWindow();
        expect(win.label).toBe('main');
    });
});

describe('invoke', () => {
    it('throws when Tauri IPC is not available', () => {
        expect(() => invoke('test_cmd')).toThrow('[API] Tauri IPC not available');
    });
});

describe('listen', () => {
    it('throws when Tauri IPC is not available', async () => {
        await expect(listen('event', () => {})).rejects.toThrow('[API] Tauri IPC not available');
    });
});

describe('openUrl', () => {
    it('throws when Tauri IPC is not available for valid URLs', async () => {
        await expect(openUrl('https://example.com')).rejects.toThrow('[API] Tauri IPC not available');
    });

    it('rejects non-http and non-https URL schemes', async () => {
        await expect(openUrl('file:///C:/Windows/System32/calc.exe')).rejects.toThrow('openUrl only supports http and https URLs');
        // eslint-disable-next-line no-script-url
        await expect(openUrl('javascript:alert(1)')).rejects.toThrow('openUrl only supports http and https URLs');
        await expect(openUrl('data:text/html,hello')).rejects.toThrow('openUrl only supports http and https URLs');
        await expect(openUrl('powershell:Start-Process calc')).rejects.toThrow('openUrl only supports http and https URLs');
        await expect(openUrl('vbscript:msgbox(1)')).rejects.toThrow('openUrl only supports http and https URLs');
        await expect(openUrl('http:///missing-hostname')).rejects.toThrow('openUrl only supports http and https URLs');
        await expect(openUrl(' \u0001 javascript:alert(1) \u0001 ')).rejects.toThrow('openUrl only supports http and https URLs');
        await expect(openUrl(/** @type {any} */ (null))).rejects.toThrow('openUrl only supports http and https URLs');
    });

    it('invokes opener plugin for valid http and https URLs', async () => {
        const invokeSpy = vi.fn().mockResolvedValue(undefined);
        vi.stubGlobal('__TAURI_INTERNALS__', {
            invoke: invokeSpy,
            transformCallback: vi.fn(),
        });
        vi.resetModules();
        const api = await import('./api.js');

        await api.openUrl('  https://example.com/test  ');
        expect(invokeSpy).toHaveBeenCalledWith('plugin:opener|open_url', { url: 'https://example.com/test' });

        // A bare host normalizes to a trailing slash: the opener receives
        // exactly the URL that passed validation, not the raw input.
        await api.openUrl('http://127.0.0.1:8080');
        expect(invokeSpy).toHaveBeenCalledWith('plugin:opener|open_url', { url: 'http://127.0.0.1:8080/' });

        // Embedded tab/CR/LF are stripped by the URL parser and must not
        // reach the OS handler inside the forwarded string.
        await api.openUrl('http://exa\tmple.com');
        expect(invokeSpy).toHaveBeenCalledWith('plugin:opener|open_url', { url: 'http://example.com/' });

        vi.unstubAllGlobals();
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  getProxiesMerged / SPECIAL_PROXY_NAMES / clearProviderCache
// ═══════════════════════════════════════════════════════════════════════════════

describe('SPECIAL_PROXY_NAMES', () => {
    it('contains expected built-in proxy names', () => {
        expect(SPECIAL_PROXY_NAMES.has('DIRECT')).toBe(true);
        expect(SPECIAL_PROXY_NAMES.has('REJECT')).toBe(true);
        expect(SPECIAL_PROXY_NAMES.has('REJECT-DROP')).toBe(true);
        expect(SPECIAL_PROXY_NAMES.has('PASS')).toBe(true);
        expect(SPECIAL_PROXY_NAMES.has('PASS-RULE')).toBe(true);
        expect(SPECIAL_PROXY_NAMES.has('COMPATIBLE')).toBe(true);
    });

    it('does not contain GLOBAL (GLOBAL is a real group)', () => {
        expect(SPECIAL_PROXY_NAMES.has('GLOBAL')).toBe(false);
    });
});

describe('getProxiesMerged', () => {
    beforeEach(() => {
        clearProviderCache();
        vi.restoreAllMocks();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('returns data as-is when no proxies are missing', async () => {
        const data = {
            proxies: {
                'GLOBAL': { name: 'GLOBAL', all: ['node1', 'node2'] },
                'node1': { name: 'node1', type: 'Shadowsocks' },
                'node2': { name: 'node2', type: 'Vmess' },
            },
        };
        const result = await getProxiesMerged(data);
        expect(result).toEqual(data); // No merge needed — same data returned
    });

    it('returns data as-is when only special names are missing', async () => {
        const data = {
            proxies: {
                'GLOBAL': { name: 'GLOBAL', all: ['DIRECT', 'REJECT'] },
            },
        };
        const result = await getProxiesMerged(data);
        expect(result).toEqual(data);
    });

    it('returns data unchanged when data.proxies is missing', async () => {
        const data = { mode: 'rule' };
        const result = await getProxiesMerged(data);
        expect(result).toEqual(data);
    });

    it('merges provider-backed nodes missing from /proxies', async () => {
        const data = {
            proxies: {
                'GLOBAL': { name: 'GLOBAL', all: ['provider-node'] },
            },
        };
        const providerNode = { name: 'provider-node', type: 'Shadowsocks' };
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ providers: { 'p1': { proxies: [providerNode] } } }),
        }));

        const result = await getProxiesMerged(data);

        expect(result.proxies['provider-node']).toEqual(providerNode);
        // Original data must not be mutated.
        expect(data.proxies['provider-node']).toBeUndefined();
    });

    it('returns original data when provider fetch fails', async () => {
        const data = {
            proxies: {
                'GLOBAL': { name: 'GLOBAL', all: ['missing-node'] },
            },
        };
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));

        const result = await getProxiesMerged(data);

        // Should return data with the original proxies (no crash).
        expect(result.proxies['GLOBAL']).toBeDefined();
        expect(result.proxies['missing-node']).toBeUndefined();
    });
});

describe('stripSpeedTestGroup', () => {
    it('withholds only the reserved entry when ownership is unknown', () => {
        const data = { proxies: { [SPEED_TEST_GROUP]: { type: 'Selector', all: ['a'], hidden: true }, GLOBAL: { all: ['Proxy', SPEED_TEST_GROUP] }, Proxy: { all: ['a'] }, a: {} } };
        stripSpeedTestGroup(data, null);
        expect(Object.keys(data.proxies)).toEqual(['GLOBAL', 'Proxy', 'a']);
        expect(data.proxies.GLOBAL.all).toEqual(['Proxy']);
    });
    it('drops the hidden speed-test group and its GLOBAL entry', () => {
        const data = { proxies: { [SPEED_TEST_GROUP]: { all: ['a'], hidden: true }, GLOBAL: { all: ['Proxy', SPEED_TEST_GROUP] }, Proxy: { all: ['a'] }, a: {} } };
        stripSpeedTestGroup(data, true);
        expect(Object.keys(data.proxies)).toEqual(['GLOBAL', 'Proxy', 'a']);
        expect(data.proxies.GLOBAL.all).toEqual(['Proxy']);
    });
    it.each([true, null])('keeps a profile-owned node or visible group (ownership=%s)', (owned) => {
        const group = { proxies: { [SPEED_TEST_GROUP]: { all: ['a'], hidden: false }, GLOBAL: { all: [SPEED_TEST_GROUP] } } };
        stripSpeedTestGroup(group, owned);
        expect(group.proxies.GLOBAL.all).toEqual([SPEED_TEST_GROUP]);
        expect(group.proxies[SPEED_TEST_GROUP]).toBeDefined();
        const node = { proxies: { [SPEED_TEST_GROUP]: { type: 'Shadowsocks' }, GLOBAL: { all: [SPEED_TEST_GROUP] } } };
        stripSpeedTestGroup(node, owned);
        expect(node.proxies[SPEED_TEST_GROUP]).toBeDefined();
    });
    it('keeps a user-owned hidden group and its parent membership', () => {
        const data = { proxies: { [SPEED_TEST_GROUP]: { type: 'URLTest', all: ['a'], hidden: true }, GLOBAL: { all: [SPEED_TEST_GROUP] } } };
        stripSpeedTestGroup(data, false);
        expect(data.proxies[SPEED_TEST_GROUP]).toBeDefined();
        expect(data.proxies.GLOBAL.all).toEqual([SPEED_TEST_GROUP]);
    });
    it('leaves other bodies alone', () => {
        const data = { proxies: { GLOBAL: { all: ['Proxy'] } } };
        expect(stripSpeedTestGroup(data)).toBe(data);
        expect(stripSpeedTestGroup(null)).toBeNull();
    });
});
