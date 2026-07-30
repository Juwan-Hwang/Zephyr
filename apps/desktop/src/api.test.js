import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    ApiError,
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
    it('returns true on success', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: true,
        }));

        const result = await switchProxy('GLOBAL', 'Auto');
        expect(result).toBe(true);
        vi.unstubAllGlobals();
    });

    it('throws ApiError on failure', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: false,
            status: 404,
            statusText: 'Not Found',
        }));

        await expect(switchProxy('GLOBAL', 'Bad')).rejects.toThrow();
        vi.unstubAllGlobals();
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
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));

        await expect(closeConnection(['id1', 'id2'])).resolves.toBeUndefined();
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
    it('throws when Tauri IPC is not available', async () => {
        await expect(openUrl('https://example.com')).rejects.toThrow('[API] Tauri IPC not available');
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
