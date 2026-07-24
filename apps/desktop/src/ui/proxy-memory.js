// @ts-check
/**
 * Proxy memory v2 - persist and restore proxy selection per profile.
 * Stores profile + group + node triplet for accurate restoration.
 *
 * @module ui/proxy-memory
 */

import { invoke, switchProxy } from '../api.js';
import { COMMANDS } from '@zephyr/shared';
import { fetchProxyGroups, isWritableGroupType } from './proxy-groups.js';
import { invalidateSettingsCache } from './cache.js';
import { proxyMemoryLogger } from '../utils/logger.js';
import { appStore } from './state.js';

/** Maximum retries for waiting mihomo to be ready. */
const MAX_READY_RETRIES = 50;
/** Delay between retries in ms. */
const READY_RETRY_DELAY = 100;

// ── Provider-loading wait constants ─────────────────────────────────────
//
// When a config uses proxy-providers (e.g., substore subscriptions),
// mihomo's /proxies API is immediately available after start, but the
// actual proxy nodes are downloaded asynchronously via separate HTTP
// requests.  Groups with `include-all: true` have empty `all[]` arrays
// until the downloads complete.
//
// restoreProxySelection() must wait for these downloads before attempting
// node restoration — otherwise the saved node cannot be found in any
// group's `all[]` and restoration silently fails.

/** Maximum retries for waiting proxy-providers (≈30 s at 1.5 s interval). */
const PROVIDER_WAIT_MAX = 20;
/** Delay between provider-loading retries in ms. */
const PROVIDER_WAIT_DELAY = 1500;
/**
 * Extra retries after providerLoading clears, for staggered provider
 * downloads where some providers finish after others (≈4.5 s at 1.5 s).
 */
const PROVIDER_STAGGER_RETRIES = 3;

/**
 * Save current proxy selection for a profile (v2: group + node).
 * Uses atomic backend command to avoid Read-Modify-Write race conditions.
 * Invalidates settings cache to ensure subsequent reads get fresh data.
 * @param {string} profileName - Profile filename (e.g., "my-sub.yaml")
 * @param {{ node?: string, group?: string }} [selection]
 */
export async function saveProxySelection(profileName, { node, group } = {}) {
    try {
        await invoke(COMMANDS.UPDATE_PROXY_SELECTION, {
            profileName,
            nodeName: node,
            groupName: group || null,
        });
        // Invalidate cache so subsequent restoreProxySelection reads fresh data
        invalidateSettingsCache();
    } catch (e) {
        proxyMemoryLogger.warn('Failed to save proxy selection:', e);
    }
}

/**
 * Save primary group preference for a profile.
 * @param {string} profileName
 * @param {string} groupName
 */
export async function savePrimaryGroupPreference(profileName, groupName) {
    try {
        await invoke(COMMANDS.UPDATE_PRIMARY_GROUP_PREFERENCE, {
            profileName,
            groupName,
        });
        invalidateSettingsCache();
    } catch (e) {
        proxyMemoryLogger.warn('Failed to save primary group preference:', e);
    }
}

/**
 * Get the primary group preference for a profile.
 * @param {string} profileName
 * @returns {Promise<string|null>}
 */
export async function getPrimaryGroupPreference(profileName) {
    try {
        const settings = await invoke(COMMANDS.GET_SETTINGS);
        return settings.primary_group_preference?.[profileName] || null;
    } catch {
        return null;
    }
}

/**
 * Parse a stored proxy selection value.
 * Handles migration from legacy format (plain string) to v2 ({group, node}).
 * @param {string|undefined|null} raw
 * @returns {{ group: string|null, node: string|null }}
 */
function parseSelection(raw) {
    if (!raw) return { group: null, node: null };
    // v2: JSON { group, node }
    if (raw.startsWith('{')) {
        try {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object' && 'node' in parsed) {
                return { group: parsed.group || null, node: parsed.node || null };
            }
        } catch {
            // Malformed JSON, fall through to legacy treatment
        }
    }
    // Legacy: plain node name string
    return { group: null, node: raw };
}

/**
 * Wait for mihomo to be ready by polling proxy groups.
 * Considers the API ready if proxy groups are returned (even with empty proxy list,
 * e.g., in DIRECT mode where no proxy candidates exist).
 * @returns {Promise<boolean>} Whether mihomo is ready
 */
export async function waitForMihomoReady() {
    for (let i = 0; i < MAX_READY_RETRIES; i++) {
        try {
            const result = await fetchProxyGroups();
            // API is ready if we get a valid response — regardless of whether
            // writable groups exist (some profiles only have non-writable groups).
            // The key signal is that /proxies responded successfully.
            if (result) {
                return true;
            }
        } catch {
            // Ignore errors, keep retrying
        }
        await new Promise((r) => setTimeout(r, READY_RETRY_DELAY));
    }
    return false;
}

/**
 * Wait for proxy-providers to finish downloading nodes.
 *
 * Polls `fetchProxyGroups()` until `providerLoading` becomes false (first
 * nodes have arrived), then continues for a few extra retries to handle
 * staggered provider downloads where some providers finish after others.
 *
 * If `savedNode` is provided, returns early as soon as the node appears in
 * any writable group — this is the common-case optimization that avoids
 * unnecessary waiting when all providers finish at roughly the same time.
 *
 * The loop budget is `PROVIDER_WAIT_MAX + PROVIDER_STAGGER_RETRIES` to
 * guarantee that stagger retries always run, even if `providerLoading`
 * flips to false near the end of the wait phase.
 *
 * @param {string|null} preferredGroupName - Group to target for resolution
 * @param {string} [savedNode] - If provided, returns early when this node appears
 * @returns {Promise<any>} The final `fetchProxyGroups` result, or the
 *   last non-null result on timeout/failure (may still have `providerLoading: true`)
 */
async function waitForProvidersLoaded(preferredGroupName, savedNode) {
    let lastResult = null;
    let staggerCount = 0;
    // fetchProxyGroups expects `preferredGroupName: string | undefined`, not `null`
    const groupName = preferredGroupName || undefined;

    // Loop budget includes +1 to guarantee the full stagger phase runs even
    // if providerLoading clears on the last iteration of the wait phase.
    for (let i = 0; i < PROVIDER_WAIT_MAX + PROVIDER_STAGGER_RETRIES + 1; i++) {
        let result;
        try {
            result = await fetchProxyGroups({ preferredGroupName: groupName });
        } catch {
            // Transient API errors (e.g., mihomo briefly unreachable) should
            // not abort the wait — keep polling until budget is exhausted.
            result = null;
        }
        if (!result) {
            await new Promise((r) => setTimeout(r, PROVIDER_WAIT_DELAY));
            continue;
        }
        lastResult = result;

        // Check for early return on every iteration.  `providerLoading` only
        // reflects the resolved UI group's `all[]`; the saved node may already
        // exist in a different writable group while `providerLoading` is
        // still true.
        if (savedNode && nodeInWritableGroup(result, savedNode)) {
            return result;
        }

        if (result.providerLoading) {
            // Phase 1: providers still downloading — reset stagger counter
            // in case providers reload after briefly becoming ready.
            staggerCount = 0;
        } else {
            // Phase 2: providerLoading is false — first proxies arrived.
            // Count stagger retries for providers that finish out of order.
            // Use > (not >=) so that PROVIDER_STAGGER_RETRIES full sleep
            // intervals elapse before returning — e.g. with value 3,
            // polls 1,2,3 each sleep (3 × 1.5 s = ~4.5 s) and poll 4 returns.
            staggerCount++;
            if (staggerCount > PROVIDER_STAGGER_RETRIES) {
                return result;
            }
        }

        await new Promise((r) => setTimeout(r, PROVIDER_WAIT_DELAY));
    }
    return lastResult;
}

/**
 * Check if a node exists in any writable (selector) group of the result.
 * @param {any} result - `fetchProxyGroups` result
 * @param {string} node - Node name to find
 * @returns {boolean}
 */
function nodeInWritableGroup(result, node) {
    // Check the resolved UI group's candidates first (fast path)
    if (result.proxies && result.proxies.includes(node)) return true;
    // Check all writable groups (node may be in a different selector)
    const proxyMap = /** @type {any} */ (result.data)?.proxies;
    if (proxyMap) {
        for (const groupName of Object.keys(proxyMap)) {
            const group = proxyMap[groupName];
            if (isWritableGroupType(group?.type) && !group.hidden
                && Array.isArray(group.all) && group.all.includes(node)) {
                return true;
            }
        }
    }
    return false;
}

/**
 * Restore proxy selection for a profile after core restart.
 * Uses polling to wait for mihomo to be ready instead of hardcoded delay.
 * Reads directly from backend (bypasses cache) to ensure fresh data.
 * @param {string} profileName - Profile filename
 * @returns {Promise<boolean>} Whether restoration succeeded
 */
export async function restoreProxySelection(profileName) {
    try {
        // Read directly from backend to avoid stale cache
        const settings = await invoke(COMMANDS.GET_SETTINGS);
        const raw = settings.last_proxy_selection?.[profileName];
        const saved = parseSelection(raw);

        // Always wait for mihomo to be ready, even if no saved node exists.
        // Callers removed their hardcoded delays and rely on this function
        // to ensure the core is ready before proceeding.
        const ready = await waitForMihomoReady();
        if (!ready) {
            proxyMemoryLogger.warn('Mihomo not ready after retries');
            return false;
        }

        if (!saved.node) return false;

        // Resolve preferred group: primary preference > saved group > current UI group
        const primaryGroup = settings.primary_group_preference?.[profileName] || null;
        const preferredGroupName = primaryGroup || saved.group || appStore.get('uiGroupName') || null;

        let proxyGroupsResult = await fetchProxyGroups({
            preferredGroupName,
        });
        if (!proxyGroupsResult) return false;

        // If proxy-providers are still downloading (e.g., substore configs),
        // wait for nodes to arrive before attempting restoration.
        // Without this, include-all groups have empty `all[]` arrays and
        // the saved node cannot be found — causing silent restoration failure.
        if (proxyGroupsResult.providerLoading) {
            proxyMemoryLogger.info(
                '[restoreProxySelection] proxy-providers still loading, waiting…',
            );
            proxyGroupsResult = await waitForProvidersLoaded(
                preferredGroupName,
                saved.node,
            );
            // If providers never finished loading (timeout), abort — unless
            // the saved node was already found in another writable group
            // (providerLoading only reflects the resolved UI group's all[]).
            // In that case, the fallback search below will still locate and
            // switch to the correct group.
            if (!proxyGroupsResult
                || (proxyGroupsResult.providerLoading
                    && !nodeInWritableGroup(proxyGroupsResult, saved.node))) {
                proxyMemoryLogger.warn(
                    '[restoreProxySelection] providers still loading after timeout, aborting restoration',
                );
                return false;
            }
        }

        // Use the resolved uiGroupName (from resolver) instead of the old
        // keyword-guessed mainGroup.  This fixes the core bug where the
        // restored selection was applied to the wrong group.
        const uiGroupName = proxyGroupsResult.uiGroupName
            || proxyGroupsResult.mainGroup || '';

        // Try the resolved uiGroupName first
        if (uiGroupName && proxyGroupsResult.proxies && proxyGroupsResult.proxies.includes(saved.node)) {
            const success = await switchProxy(uiGroupName, saved.node);
            if (success) {
                appStore.set('uiGroupName', uiGroupName);
            }
            return success;
        }

        // Fallback: search all writable groups for the saved node.
        // After profile/core switches, the saved node may belong to a different
        // selector group than the resolved primary.
        /** @type {Record<string, any>|undefined} */
        const proxyMap = /** @type {any} */ (proxyGroupsResult.data)?.proxies;
        if (proxyMap) {
            for (const groupName of Object.keys(proxyMap)) {
                const group = proxyMap[groupName];
                if (!isWritableGroupType(group?.type)) continue;
                if (group.hidden) continue;
                if (group.all && group.all.includes(saved.node)) {
                    const success = await switchProxy(groupName, saved.node);
                    if (success) {
                        appStore.set('uiGroupName', groupName);
                        return true;
                    }
                }
            }
        }

        return false;
    } catch (e) {
        proxyMemoryLogger.warn('Failed to restore proxy selection:', e);
        return false;
    }
}

/**
 * Get the saved proxy selection for a profile.
 * Reads directly from backend to avoid stale cache.
 * @param {string} profileName
 * @returns {Promise<{group: string|null, node: string|null}>}
 */
export async function getProxySelection(profileName) {
    try {
        const settings = await invoke(COMMANDS.GET_SETTINGS);
        const raw = settings.last_proxy_selection?.[profileName];
        return parseSelection(raw);
    } catch {
        return { group: null, node: null };
    }
}
