// @ts-check
/**
 * Proxy memory - persist and restore proxy selection per profile.
 *
 * @module ui/proxy-memory
 */

import { invoke, switchProxy } from '../api.js';
import { COMMANDS } from '@zephyr/shared';
import { fetchProxyGroups } from './proxy-groups.js';

/**
 * Save current proxy selection for a profile.
 * @param {string} profileName - Profile filename (e.g., "my-sub.yaml")
 * @param {string} nodeName - Selected proxy node name
 */
export async function saveProxySelection(profileName, nodeName) {
    try {
        const settings = await invoke(COMMANDS.GET_SETTINGS);
        settings.last_proxy_selection = settings.last_proxy_selection || {};
        settings.last_proxy_selection[profileName] = nodeName;
        await invoke(COMMANDS.SAVE_SETTINGS, { settings });
    } catch { /* ignore */ }
}

/**
 * Restore proxy selection for a profile after core restart.
 * @param {string} profileName - Profile filename
 * @returns {Promise<boolean>} Whether restoration succeeded
 */
export async function restoreProxySelection(profileName) {
    try {
        const settings = await invoke(COMMANDS.GET_SETTINGS);
        const savedNode = settings.last_proxy_selection?.[profileName];
        if (!savedNode) return false;

        // Wait for mihomo to be ready
        await new Promise((r) => setTimeout(r, 500));

        const proxyGroupsResult = await fetchProxyGroups();
        if (!proxyGroupsResult) return false;

        if (proxyGroupsResult.proxies && proxyGroupsResult.proxies.includes(savedNode)) {
            const mainGroup = proxyGroupsResult.mainGroup || 'Proxy';
            return await switchProxy(mainGroup, savedNode);
        }
        return false;
    } catch { return false; }
}

/**
 * Get the saved proxy selection for a profile.
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
