// @ts-check
/**
 * Observed Group Watcher - monitors active connections to detect
 * the actual proxy group being used (fact-based, vs rule-inferred effectiveGroup).
 *
 * Only updates appStore when statistical thresholds are met:
 *   - top1 frequency >= 3 and ratio >= 30%
 *   - K=3 consecutive consistent results
 *
 * @module ui/observed-group
 */

import { getConnections, getProxies } from '../api.js';
import { isWritableGroupType } from './proxy-groups.js';
import { appStore } from './state.js';
import { observedGroupLogger } from '../utils/logger.js';

/** Maximum connections to sample (most recent). */
const MAX_SAMPLE = 30;
/** Minimum frequency for top-1 candidate to be considered reliable. */
const MIN_FREQ = 3;
/** Minimum ratio (0-1) for top-1 candidate. */
const MIN_RATIO = 0.3;
/** Number of consecutive consistent observations to confirm. */
const CONSECUTIVE_K = 3;
/** Polling interval in ms. */
const POLL_INTERVAL = 5000;

let _timer = null;
let _polling = false;
let _active = false;
let _consecutiveCount = 0;
let _lastCandidate = null;

/**
 * Compute the observed group from active connections.
 * Pure function — no side effects.
 *
 * Scans chains of active connections, finds the first name that is
 * a writable group (selector/select) in the proxy map.
 *
 * @param {Array} connections - Active connections from /connections API
 * @param {Object} proxiesData - Full proxy map from /proxies
 * @returns {{ name: string|null, freq: number, total: number, ratio: number }}
 */
export function computeObservedGroup(connections, proxiesData) {
    if (!connections?.length || !proxiesData) {
        return { name: null, freq: 0, total: 0, ratio: 0 };
    }

    // Take most recent connections (API usually returns oldest first)
    const sampled = connections.slice(-MAX_SAMPLE);
    const freq = Object.create(null);

    for (const conn of sampled) {
        const chains = conn.chains || [];
        for (const chainName of chains) {
            const group = proxiesData[chainName];
            if (!group) continue;
            if (!isWritableGroupType(group.type)) continue;
            if (group.hidden) continue;
            freq[chainName] = (freq[chainName] || 0) + 1;
            break; // Only count the first writable group per chain
        }
    }

    const entries = Object.entries(freq).sort((a, b) => b[1] - a[1]);
    if (entries.length === 0) {
        return { name: null, freq: 0, total: sampled.length, ratio: 0 };
    }

    const [topName, topFreq] = entries[0];
    const total = sampled.length;
    const ratio = total > 0 ? topFreq / total : 0;

    return { name: topName, freq: topFreq, total, ratio };
}

/**
 * Start the observed group watcher.
 * Idempotent — safe to call multiple times.
 */
export function startObservedGroupWatcher() {
    if (_active) return;
    _active = true;
    _scheduleNext();
}

/**
 * Stop the observed group watcher.
 */
export function stopObservedGroupWatcher() {
    _active = false;
    if (_timer) {
        clearTimeout(_timer);
        _timer = null;
    }
    // Don't clear _polling here — let _poll()'s finally block release it.
    // This prevents overlapping polls if user quickly re-enters the page
    // while a network request is still in flight.
}

/**
 * Reset consecutive counter (e.g., on profile/config change).
 */
export function resetObservedGroup() {
    _consecutiveCount = 0;
    _lastCandidate = null;
    if (appStore.get('observedGroupName')) {
        appStore.set('observedGroupName', null);
    }
}

function _scheduleNext() {
    if (!_active) return;
    _timer = setTimeout(() => {
        _timer = null;
        _poll().finally(() => {
            _scheduleNext();
        });
    }, POLL_INTERVAL);
}

async function _poll() {
    if (_polling) return;
    _polling = true;
    try {
        const [connData, proxiesData] = await Promise.all([
            getConnections(),
            _getProxiesData(),
        ]);

        const connections = connData?.connections || connData || [];
        const proxies = proxiesData?.proxies || proxiesData;

        const result = computeObservedGroup(connections, proxies);

        if (!result.name || result.freq < MIN_FREQ || result.ratio < MIN_RATIO) {
            // Not reliable enough — reset streak and clear store to avoid stale warnings
            _consecutiveCount = 0;
            _lastCandidate = null;
            if (appStore.get('observedGroupName')) {
                appStore.set('observedGroupName', null);
            }
            return;
        }

        if (result.name === _lastCandidate) {
            _consecutiveCount++;
        } else {
            _lastCandidate = result.name;
            _consecutiveCount = 1;
        }

        if (_consecutiveCount >= CONSECUTIVE_K) {
            const prev = appStore.get('observedGroupName');
            if (prev !== result.name) {
                appStore.set('observedGroupName', result.name);
                observedGroupLogger.info(`Observed group confirmed: ${result.name} (freq=${result.freq}/${result.total}, ratio=${(result.ratio * 100).toFixed(0)}%)`);
            }
        }
    } catch (err) {
        observedGroupLogger.debug('Observed group poll failed:', err);
        // Clear stale state when polling fails (core stopped, network error, etc.)
        if (appStore.get('observedGroupName')) {
            appStore.set('observedGroupName', null);
        }
    } finally {
        _polling = false;
    }
}

async function _getProxiesData() {
    try {
        return await getProxies();
    } catch {
        return null;
    }
}
