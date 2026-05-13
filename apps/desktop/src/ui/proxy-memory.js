// @ts-check
/**
 * Proxy memory - persist and restore proxy selection per profile.
 *
 * @module ui/proxy-memory
 */

import { invoke, switchProxy } from '../api.js';
import { COMMANDS } from '@zephyr/shared';
import { fetchProxyGroups } from './proxy-groups.js';
import { invalidateSettingsCache } from './cache.js';
import { proxyMemoryLogger } from '../utils/logger.js';

/** Maximum retries for waiting mihomo to be ready. */
const MAX_READY_RETRIES = 10;
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
 * @returns {Promise<boolean>} Whether mihomo is ready
 */
async function waitForMihomoReady() {
    for (let i = 0; i < MAX_READY_RETRIES; i++) {
        try {
            const result = await fetchProxyGroups();
            if (result && result.proxies && result.proxies.length > 0) {
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
        if (!savedNode) return false;

        // Wait for mihomo to be ready (poll with retries)
        const ready = await waitForMihomoReady();
        if (!ready) {
            proxyMemoryLogger.warn('Mihomo not ready after retries');
            return false;
        }

        const proxyGroupsResult = await fetchProxyGroups();
        if (!proxyGroupsResult) return false;

        if (proxyGroupsResult.proxies && proxyGroupsResult.proxies.includes(savedNode)) {
            const mainGroup = proxyGroupsResult.mainGroup || 'Proxy';
            return await switchProxy(mainGroup, savedNode);
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
