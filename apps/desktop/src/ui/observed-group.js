// @ts-check
/**
 * Observed Group Watcher - monitors active connections to detect
 * the actual proxy group and node being used.
 *
 * Only updates appStore when statistical thresholds are met:
 *   - top1 frequency >= 3 and ratio >= 30%
 *   - K=3 consecutive consistent results
 *
 * @module ui/observed-group
 */

import { getConnections, isCoreReachable } from '../api.js';
import { getProxiesCached } from './cache.js';
import { isWritableGroupType } from './proxy-groups.js';
import { appStore } from './state.js';
import { observedGroupLogger } from '../utils/logger.js';
import { Bus, Events } from './events.js';

/** Special groups to exclude from observed group detection (DIRECT, REJECT, etc.) */
const SPECIAL_GROUPS = new Set(['DIRECT', 'REJECT', 'PASS', 'COMPATIBLE', '🎯 DIRECT']);

/** Maximum connections to sample (most recent). */
const MAX_SAMPLE = 30;
/** Minimum frequency for top-1 candidate to be considered reliable. */
const MIN_FREQ = 3;
/** Minimum ratio (0-1) for top-1 candidate. */
const MIN_RATIO = 0.3;
/** Number of consecutive consistent observations to confirm. */
const CONSECUTIVE_K = 3;
/** Polling interval in ms (optimized for responsiveness). */
const POLL_INTERVAL = 2000;

/** @type {ReturnType<typeof setTimeout>|null} */
let _timer = null;
let _polling = false;
let _active = false;
let _consecutiveCount = 0;
/** @type {string|null} */
let _lastCandidate = null;
/** @type {Record<string, any> | null} Module-level cache for static proxy group structures */
let _staticProxiesCache = null;

// Invalidate cache on config/core changes
Bus.on(Events.CONFIG_UPDATED, () => { _staticProxiesCache = null; });
Bus.on(Events.CORE_RESTARTED, () => { _staticProxiesCache = null; });

/**
 * Compute the observed group and node from active connections.
 * Pure function — no side effects.
 *
 * Scans chains of active connections, finds the first name that is
 * a writable group (selector/select) in the proxy map, and extracts
 * the final node name from the chain — keyed per group to ensure
 * the reported node actually belongs to the reported group.
 *
 * @param {Array<{ chains?: string[] }>} connections - Active connections from /connections API
 * @param {Record<string, any>} proxiesData - Full proxy map from /proxies
 * @returns {{ name: string|null, node: string|null, freq: number, total: number, ratio: number }}
 */
export function computeObservedGroup(connections, proxiesData) {
    if (!connections?.length || !proxiesData) {
        return { name: null, node: null, freq: 0, total: 0, ratio: 0 };
    }

    // Take most recent connections (API usually returns oldest first)
    const sampled = connections.slice(-MAX_SAMPLE);
    const freq = Object.create(null);
    const groupNodeFreq = Object.create(null);

    for (const conn of sampled) {
        const chains = conn.chains || [];

        for (let i = 0; i < chains.length; i++) {
            const chainName = chains[i];
            const group = proxiesData[chainName];
            if (!group) continue;
            if (!isWritableGroupType(group.type)) continue;
            if (group.hidden) continue;
            if (SPECIAL_GROUPS.has(chainName.toUpperCase()) || chainName.toUpperCase().includes('DIRECT')) continue;

            // Found the first writable group
            freq[chainName] = (freq[chainName] || 0) + 1;

            // Track node frequency per group
            // chains order: [actual_node, group_name] or [node1, node2, group]
            // The actual exit node is the first element
            const finalNode = chains[0];
            if (finalNode) {
                if (!groupNodeFreq[chainName]) {
                    groupNodeFreq[chainName] = Object.create(null);
                }
                groupNodeFreq[chainName][finalNode] = (groupNodeFreq[chainName][finalNode] || 0) + 1;
            }

            break; // Only count the first writable group per chain
        }
    }

    const entries = Object.entries(freq).sort((a, b) => b[1] - a[1]);
    if (entries.length === 0) {
        return { name: null, node: null, freq: 0, total: sampled.length, ratio: 0 };
    }

    const [topName, topFreq] = entries[0];
    const total = sampled.length;
    const ratio = total > 0 ? topFreq / total : 0;

    // Get the most frequent node within the top group
    const topGroupNodes = groupNodeFreq[topName];
    const topNode = topGroupNodes
        ? Object.entries(topGroupNodes).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
        : null;

    return { name: topName, node: topNode, freq: topFreq, total, ratio };
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
    if (appStore.get('observedNodeName')) {
        appStore.set('observedNodeName', null);
    }
}

function _scheduleNext() {
    if (!_active || _timer) return;
    _timer = setTimeout(() => {
        _timer = null;
        _poll().finally(() => {
            _scheduleNext();
        });
    }, POLL_INTERVAL);
}

async function _poll() {
    if (_polling) return;
    if (!isCoreReachable()) return; // 内核不可达时跳过轮询
    _polling = true;
    try {
        const [connData, proxiesData] = await Promise.all([
            getConnections(),
            _getProxiesData(),
        ]);

        const connections = connData?.connections || connData || [];
        /** @type {Record<string, any>} */
        const proxies = proxiesData?.proxies || proxiesData;

        const result = computeObservedGroup(connections, proxies);

        if (!result.name || result.freq < MIN_FREQ || result.ratio < MIN_RATIO) {
            _consecutiveCount = 0;
            _lastCandidate = null;
            if (appStore.get('observedGroupName')) {
                appStore.set('observedGroupName', null);
            }
            if (appStore.get('observedNodeName')) {
                appStore.set('observedNodeName', null);
            }
            return;
        }

        // Only track consecutive by group name for stability
        // Node can fluctuate within the same group (load balancing, etc.)
        if (result.name === _lastCandidate) {
            _consecutiveCount++;
        } else {
            _lastCandidate = result.name;
            _consecutiveCount = 1;
        }

        if (_consecutiveCount >= CONSECUTIVE_K) {
            const prevGroup = appStore.get('observedGroupName');
            const prevNode = appStore.get('observedNodeName');
            if (prevGroup !== result.name || prevNode !== result.node) {
                appStore.set('observedGroupName', result.name);
                appStore.set('observedNodeName', result.node);
                // Only log at info level when group changes; use debug for node-only updates
                if (prevGroup !== result.name) {
                    observedGroupLogger.info(`Observed group confirmed: ${result.name} (node: ${result.node}, freq=${result.freq}/${result.total}, ratio=${(result.ratio * 100).toFixed(0)}%)`);
                } else {
                    observedGroupLogger.debug(`Observed node updated: ${result.node} (group: ${result.name})`);
                }
            }
        }
    } catch (err) {
        observedGroupLogger.debug('Observed group poll failed:', err);
        if (appStore.get('observedGroupName')) {
            appStore.set('observedGroupName', null);
        }
        if (appStore.get('observedNodeName')) {
            appStore.set('observedNodeName', null);
        }
    } finally {
        _polling = false;
    }
}

async function _getProxiesData() {
    if (_staticProxiesCache) return _staticProxiesCache;
    try {
        // Cache proxy data at module level to avoid redundant API calls during 2s polling
        // Proxy group structures are static and only change on config/core updates
        _staticProxiesCache = await getProxiesCached();
        return _staticProxiesCache;
    } catch {
        return null;
    }
}
