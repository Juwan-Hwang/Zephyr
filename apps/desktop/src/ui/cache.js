// @ts-check
/**
 * Unified cache system for all API data.
 * Provides LRU-evicted, TTL-based caching with stale-while-revalidate,
 * coordinated invalidation across API cache and tray menu cache,
 * and in-flight request deduplication.
 */

import { getConfig, getProxies } from '../api.js';
import { invoke } from '../api.js';
import { COMMANDS } from '@zephyr/shared';

// --- API Cache (LRU + Stale-While-Revalidate) ---

const MAX_CACHE_ENTRIES = 50; // LRU eviction threshold
const CACHE_TTL = 2000;       // 2 seconds fresh TTL
const SWR_WINDOW = 5000;      // 5 seconds stale-while-revalidate window

/** @type {Map<string, {data: any, time: number}>} */
const apiCache = new Map([
    ['config',   { data: null, time: 0 }],
    ['proxies',  { data: null, time: 0 }],
    ['settings', { data: null, time: 0 }],
    ['configs',  { data: null, time: 0 }],
]);

/** @type {string[]} Access-order tracking: most recent at end. */
const _lruKeys = ['config', 'proxies', 'settings', 'configs'];

// --- In-flight request deduplication ---

/** @type {Map<string, Promise<any>>} Tracks in-flight requests by cache key. */
const inFlight = new Map();

/** @type {Set<string>} Tracks keys currently refreshing in background (SWR). */
const _bgRefreshing = new Set();

function clearInFlight() {
    inFlight.clear();
}

// --- LRU helpers ---

/**
 * Move a key to the end of LRU order (most recently used).
 * @param {string} key
 */
function _lruTouch(key) {
    const idx = _lruKeys.indexOf(key);
    if (idx !== -1) _lruKeys.splice(idx, 1);
    _lruKeys.push(key);
}

/**
 * Evict least recently used entries if over capacity.
 */
function _lruEvict() {
    while (_lruKeys.length > MAX_CACHE_ENTRIES) {
        const oldest = /** @type {string} */ (_lruKeys.shift());
        apiCache.delete(oldest);
    }
}

/**
 * Ensure a cache entry exists for the given key.
 * @param {string} key
 */
function _ensureEntry(key) {
    if (!apiCache.has(key)) {
        apiCache.set(key, { data: null, time: 0 });
        _lruKeys.push(key);
    }
}

// --- Stale-While-Revalidate ---

/**
 * Fire a background refresh without blocking the caller.
 * Updates cache silently on success; never throws.
 * Skipped if a foreground or background request is already in-flight.
 *
 * @param {string} key
 * @param {() => Promise<any>} fetcher
 */
function _backgroundRefresh(key, fetcher) {
    if (_bgRefreshing.has(key) || inFlight.has(key)) return;
    _bgRefreshing.add(key);

    // Identity Guard: snapshot current entry reference for later comparison
    const entrySnapshot = apiCache.get(key);

    fetcher().then((data) => {
        // Identity Guard: only update if the entry hasn't been replaced
        // (e.g. invalidateXxxCache() was called during refresh)
        if (apiCache.get(key) === entrySnapshot) {
            _ensureEntry(key);
            const e = apiCache.get(key);
            if (e) {
                e.data = data;
                e.time = Date.now();
                _lruTouch(key);
            }
        }
    }).catch(() => {
        // Refresh failed — only clear if entry hasn't been replaced
        if (apiCache.get(key) === entrySnapshot) {
            apiCache.delete(key);
            const idx = _lruKeys.indexOf(key);
            if (idx !== -1) _lruKeys.splice(idx, 1);
        }
    }).finally(() => {
        _bgRefreshing.delete(key);
    });
}

// --- Core cache function ---

/**
 * @param {string} key
 * @param {() => Promise<any>} fetcher
 * @returns {Promise<any>}
 */
function getCached(key, fetcher) {
    const now = Date.now();
    const entry = apiCache.get(key);

    // Fresh cache hit
    if (entry && entry.data && (now - entry.time) < CACHE_TTL) {
        _lruTouch(key);
        return Promise.resolve(entry.data);
    }

    // Stale-while-revalidate: serve stale data if within SWR window
    if (entry && entry.data && (now - entry.time) < (CACHE_TTL + SWR_WINDOW)) {
        _lruTouch(key);
        _backgroundRefresh(key, fetcher);
        return Promise.resolve(entry.data);
    }

    // Cache miss or fully expired — fetch fresh data
    const pending = inFlight.get(key);
    if (pending) return pending;

    const promise = fetcher().then(/** @param {any} data */ (data) => {
        _ensureEntry(key);
        const e = apiCache.get(key);
        if (e) {
            e.data = data;
            e.time = Date.now();
        }
        _lruTouch(key);
        _lruEvict();
        inFlight.delete(key);
        return data;
    }).catch(/** @param {any} err */ (err) => {
        inFlight.delete(key);
        throw err;
    });

    inFlight.set(key, promise);
    return promise;
}

// --- Public API ---

export async function getConfigCached() {
    return getCached('config', getConfig);
}

export async function getProxiesCached() {
    return getCached('proxies', getProxies);
}

export async function getSettingsCached() {
    return getCached('settings', () => invoke(COMMANDS.GET_SETTINGS));
}

export async function getConfigsCached() {
    return getCached('configs', () => invoke(COMMANDS.LIST_CONFIGS));
}

// --- Tray Menu Cache ---

/** @type {{ config: any, configs: any, proxyGroups: any, lastUpdate: number }} */
export let trayMenuCache = {
    config: null,
    configs: null,
    proxyGroups: null,
    lastUpdate: 0,
};

export const TRAY_CACHE_TTL = 2000; // 2 seconds cache

// --- Invalidation ---

function resetTrayMenuCache() {
    trayMenuCache = { config: null, configs: null, proxyGroups: null, lastUpdate: 0 };
}

export function invalidateConfigCache() {
    apiCache.set('config', { data: null, time: 0 });
    clearInFlight();
    resetTrayMenuCache();
}

export function invalidateProxiesCache() {
    apiCache.set('proxies', { data: null, time: 0 });
    clearInFlight();
    resetTrayMenuCache();
}

export function invalidateSettingsCache() {
    apiCache.set('settings', { data: null, time: 0 });
    clearInFlight();
}

export function invalidateConfigsCache() {
    apiCache.set('configs', { data: null, time: 0 });
    clearInFlight();
    resetTrayMenuCache();
}

export function invalidateAllCaches() {
    for (const key of apiCache.keys()) {
        apiCache.set(key, { data: null, time: 0 });
    }
    clearInFlight();
    resetTrayMenuCache();
}
