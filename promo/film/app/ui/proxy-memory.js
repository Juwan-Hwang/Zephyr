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
 * Poll `fetchProxyGroups` once, swallowing transient API errors.
 * Returns the result, or `null` if the call threw.
 * @param {string|undefined} groupName
 * @returns {Promise<any>}
 */
async function pollFetchProxyGroups(groupName) {
    try {
        return await fetchProxyGroups({ preferredGroupName: groupName });
    } catch {
        // Transient API errors (e.g., mihomo briefly unreachable) should
        // not abort the wait — caller keeps polling until budget is exhausted.
        return null;
    }
}

/**
 * Wait for proxy-providers to finish downloading nodes.
 *
 * Two-phase poller with **separate budgets** so that the stagger phase
 * always runs in full, regardless of when `providerLoading` clears:
 *
 * - Phase 1 (up to `PROVIDER_WAIT_MAX` polls): wait while
 *   `providerLoading` is true; break as soon as it becomes false.
 * - Phase 2 (exactly `PROVIDER_STAGGER_RETRIES` polls): additional
 *   delayed polls to catch out-of-order provider downloads.
 *
 * If `savedNode` is provided, returns early as soon as the node appears
 * in any writable group (checked on every poll in both phases).
 *
 * @param {string|null} preferredGroupName - Group to target for resolution
 * @param {string} [savedNode] - If provided, returns early when this node appears
 * @returns {Promise<any>} The final `fetchProxyGroups` result, or the
 *   last non-null result on timeout/failure (may still have `providerLoading: true`)
 */
async function waitForProvidersLoaded(preferredGroupName, savedNode) {
    let lastResult = null;
    // fetchProxyGroups expects `preferredGroupName: string | undefined`, not `null`
    const groupName = preferredGroupName || undefined;

    // ── Phase 1: wait for providerLoading to become false ────────────
    for (let i = 0; i < PROVIDER_WAIT_MAX; i++) {
        const result = await pollFetchProxyGroups(groupName);
        if (!result) {
            await new Promise((r) => setTimeout(r, PROVIDER_WAIT_DELAY));
            continue;
        }
        lastResult = result;

        // Check for early return on every poll.  `providerLoading` only
        // reflects the resolved UI group's `all[]`; the saved node may
        // already exist in a different writable group.
        if (savedNode && nodeInWritableGroup(result, savedNode)) {
            return result;
        }

        if (!result.providerLoading) {
            break; // Phase 1 done — proceed to stagger phase
        }

        await new Promise((r) => setTimeout(r, PROVIDER_WAIT_DELAY));
    }

    // ── Phase 2: guaranteed stagger polls ───────────────────────────
    // Each iteration sleeps first, then polls — producing exactly
    // PROVIDER_STAGGER_RETRIES delayed polls (~4.5 s at 1.5 s each).
    for (let i = 0; i < PROVIDER_STAGGER_RETRIES; i++) {
        await new Promise((r) => setTimeout(r, PROVIDER_WAIT_DELAY));
        const result = await pollFetchProxyGroups(groupName);
        if (!result) continue;
        lastResult = result;

        if (savedNode && nodeInWritableGroup(result, savedNode)) {
            return result;
        }
    }

    return lastResult;
}

/**
 * Find the first writable (selector) group that contains `node`.
 * @param {Record<string, any>|undefined|null} proxyMap - `/proxies` response map
 * @param {string} node - Node name to find
 * @returns {string|null} Group name, or null if not found
 */
function findWritableGroupWithNode(proxyMap, node) {
    if (!proxyMap) return null;
    for (const groupName of Object.keys(proxyMap)) {
        const group = proxyMap[groupName];
        if (isWritableGroupType(group?.type) && !group.hidden
            && Array.isArray(group.all) && group.all.includes(node)) {
            return groupName;
        }
    }
    return null;
}

/**
 * Check if a node exists in any writable (selector) group of the result.
 * @param {any} result - `fetchProxyGroups` result
 * @param {string} node - Node name to find
 * @returns {boolean}
 */
function nodeInWritableGroup(result, node) {
    // Check the resolved UI group's candidates first (fast path)
    if (result.proxies?.includes(node)) return true;
    // Check all writable groups (node may be in a different selector)
    return findWritableGroupWithNode(
        /** @type {any} */ (result.data)?.proxies, node,
    ) !== null;
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

        // Defensive: if saved.node === saved.group, the node was saved
        // incorrectly by a previous version of switchToConfig (which fetched
        // from the effective group instead of the preferred group, causing the
        // group name to be saved as the node).  Clear the stale entry and
        // skip restoration.  This check is precise: a valid group-as-node
        // selection always has different group and node names (e.g.,
        // group="兜底分流", node="手动切换"), so legitimate restorations
        // are never blocked.
        if (saved.node === saved.group) {
            proxyMemoryLogger.warn(
                `[restoreProxySelection] saved.node "${saved.node}" equals saved.group — stale data from previous bug, clearing and skipping restoration`,
            );
            // Clear the stale entry to prevent repeated warnings on every run.
            // Use empty strings because the Rust backend's update_proxy_selection
            // requires node_name as String (not Option<String>).
            // parseSelection() treats "" as null via the `|| null` check.
            try {
                await saveProxySelection(profileName, { node: '', group: '' });
            } catch { /* ignore cleanup errors */ }
            return false;
        }

        // Resolve preferred group: primary preference > saved group > current UI group
        const primaryGroup = settings.primary_group_preference?.[profileName] || null;
        const preferredGroupName = primaryGroup || saved.group || appStore.get('uiGroupName') || null;

        let proxyGroupsResult = await fetchProxyGroups({
            preferredGroupName,
        });
        if (!proxyGroupsResult) return false;

        // If proxy-providers are still downloading (e.g., substore configs),
        // wait for nodes to arrive before attempting restoration.
        // Also wait if the config HAS proxy-providers but the saved node
        // isn't found yet — `providerLoading` only signals an empty UI
        // group, but other providers may still be downloading even after
        // the UI group has some nodes.
        const needsProviderWait = proxyGroupsResult.providerLoading
            || (proxyGroupsResult.hasProxyProviders
                && !nodeInWritableGroup(proxyGroupsResult, saved.node));
        if (needsProviderWait) {
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
        const proxyMap = /** @type {any} */ (proxyGroupsResult.data)?.proxies;
        const fallbackGroup = findWritableGroupWithNode(proxyMap, saved.node);
        if (fallbackGroup) {
            const success = await switchProxy(fallbackGroup, saved.node);
            if (success) {
                appStore.set('uiGroupName', fallbackGroup);
                return true;
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
