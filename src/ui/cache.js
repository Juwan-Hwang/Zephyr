// @ts-check
/**
 * Unified cache system for all API data.
 * Provides TTL-based caching with coordinated invalidation
 * across API cache and tray menu cache, and in-flight request deduplication.
 */

import { getConfig, getProxies } from '../api.js';
import { invoke } from '../api.js';

// --- API Cache ---

/** @type {Record<string, {data: any, time: number}>} */
const apiCache = {
    config: { data: null, time: 0 },
    proxies: { data: null, time: 0 },
    settings: { data: null, time: 0 },
    configs: { data: null, time: 0 },
};

const CACHE_TTL = 2000; // 2 seconds cache TTL

// --- In-flight request deduplication ---

/** @type {Map<string, Promise<any>>} Tracks in-flight requests by cache key. */
const inFlight = new Map();

function clearInFlight() {
    inFlight.clear();
}

/**
 * @param {string} key
 * @param {() => Promise<any>} fetcher
 * @returns {Promise<any>}
 */
function getCached(key, fetcher) {
    const now = Date.now();
    const entry = apiCache[key];
    if (entry.data && (now - entry.time) < CACHE_TTL) {
        return Promise.resolve(entry.data);
    }

    // Deduplicate: if a request is already in-flight, share its Promise.
    const pending = inFlight.get(key);
    if (pending) return pending;

    const promise = fetcher().then(/** @param {any} data */ (data) => {
        entry.data = data;
        entry.time = Date.now();
        inFlight.delete(key);
        return data;
    }).catch(/** @param {any} err */ (err) => {
        inFlight.delete(key);
        throw err;
    });

    inFlight.set(key, promise);
    return promise;
}

export async function getConfigCached() {
    return getCached('config', getConfig);
}

export async function getProxiesCached() {
    return getCached('proxies', getProxies);
}

export async function getSettingsCached() {
    return getCached('settings', () => invoke('get_settings'));
}

export async function getConfigsCached() {
    return getCached('configs', () => invoke('list_configs'));
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
    apiCache.config = { data: null, time: 0 };
    clearInFlight();
    resetTrayMenuCache();
}

export function invalidateProxiesCache() {
    apiCache.proxies = { data: null, time: 0 };
    clearInFlight();
    resetTrayMenuCache();
}

export function invalidateSettingsCache() {
    apiCache.settings = { data: null, time: 0 };
    clearInFlight();
}

export function invalidateConfigsCache() {
    apiCache.configs = { data: null, time: 0 };
    clearInFlight();
    resetTrayMenuCache();
}

export function invalidateAllCaches() {
    Object.keys(apiCache).forEach(/** @param {string} key */ (key) => {
        apiCache[key] = { data: null, time: 0 };
    });
    clearInFlight();
    resetTrayMenuCache();
}
