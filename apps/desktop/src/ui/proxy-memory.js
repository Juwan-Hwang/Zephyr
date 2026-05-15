// @ts-check
/**
 * Proxy memory - persist and restore proxy selection per profile.
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
 * Save current proxy selection for a profile.
 * Uses atomic backend command to avoid Read-Modify-Write race conditions.
 * Invalidates settings cache to ensure subsequent reads get fresh data.
 * @param {string} profileName - Profile filename (e.g., "my-sub.yaml")
 * @param {string} nodeName - Selected proxy node name
 */
export async function saveProxySelection(profileName, nodeName) {
    try {
        await invoke(COMMANDS.UPDATE_PROXY_SELECTION, { profileName, nodeName });
        // Invalidate cache so subsequent restoreProxySelection reads fresh data
        invalidateSettingsCache();
    } catch (e) {
        proxyMemoryLogger.warn('Failed to save proxy selection:', e);
    }
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
            // API is ready if we get a valid response with groups data.
            // mainGroup may be null if no writable groups exist, so check
            // the groups array (populated from proxyMap, not the resolver).
            if (result && (result.groups?.length > 0 || result.mainGroup)) {
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
        const savedNode = settings.last_proxy_selection?.[profileName];

        // Always wait for mihomo to be ready, even if no saved node exists.
        // Callers removed their hardcoded delays and rely on this function
        // to ensure the core is ready before proceeding.
        const ready = await waitForMihomoReady();
        if (!ready) {
            proxyMemoryLogger.warn('Mihomo not ready after retries');
            return false;
        }

        if (!savedNode) return false;

        const proxyGroupsResult = await fetchProxyGroups({
            preferredGroupName: appStore.get('uiGroupName') || null,
        });
        if (!proxyGroupsResult) return false;

        // Use the resolved uiGroupName (from resolver) instead of the old
        // keyword-guessed mainGroup.  This fixes the core bug where the
        // restored selection was applied to the wrong group.
        const uiGroupName = proxyGroupsResult.uiGroupName
            || proxyGroupsResult.mainGroup;

        // Try the resolved uiGroupName first
        if (proxyGroupsResult.proxies && proxyGroupsResult.proxies.includes(savedNode)) {
            const success = await switchProxy(uiGroupName, savedNode);
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
                if (group.all && group.all.includes(savedNode)) {
                    const success = await switchProxy(groupName, savedNode);
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
 * @returns {Promise<string|null>}
 */
export async function getProxySelection(profileName) {
    try {
        const settings = await invoke(COMMANDS.GET_SETTINGS);
        return settings.last_proxy_selection?.[profileName] || null;
    } catch {
        return null;
    }
}
