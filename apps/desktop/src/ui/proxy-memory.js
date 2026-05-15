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

/**
 * Save current proxy selection for a profile (v2: group + node).
 * Uses atomic backend command to avoid Read-Modify-Write race conditions.
 * Invalidates settings cache to ensure subsequent reads get fresh data.
 * @param {string} profileName - Profile filename (e.g., "my-sub.yaml")
 * @param {object} selection
 * @param {string} selection.node - Selected proxy node name
 * @param {string} [selection.group] - Group name where the node was selected
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
            return { group: parsed.group || null, node: parsed.node || null };
        } catch {
            // Malformed JSON, treat as legacy node name
            return { group: null, node: raw };
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
async function waitForMihomoReady() {
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
        const primaryGroup = await getPrimaryGroupPreference(profileName);
        const preferredGroupName = primaryGroup || saved.group || appStore.get('uiGroupName') || null;

        const proxyGroupsResult = await fetchProxyGroups({
            preferredGroupName,
        });
        if (!proxyGroupsResult) return false;

        // Use the resolved uiGroupName (from resolver) instead of the old
        // keyword-guessed mainGroup.  This fixes the core bug where the
        // restored selection was applied to the wrong group.
        const uiGroupName = proxyGroupsResult.uiGroupName
            || proxyGroupsResult.mainGroup;

        // Try the resolved uiGroupName first
        if (proxyGroupsResult.proxies && proxyGroupsResult.proxies.includes(saved.node)) {
            const success = await switchProxy(uiGroupName, saved.node);
            if (success) {
                appStore.set('uiGroupName', uiGroupName);
            }
            return success;
        }

        // Fallback: search all writable groups for the saved node.
        // After profile/core switches, the saved node may belong to a different
        // selector group than the resolved primary.
        const proxyMap = proxyGroupsResult.data?.proxies;
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
