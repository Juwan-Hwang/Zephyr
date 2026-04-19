// @ts-check
/**
 * Fetch proxy groups data and determine the main group based on config mode.
 * Extracted from ui.js for reuse across modules.
 */

import { getProxies, getConfig } from '../api.js';

/**
 * @param {Object} options
 * @param {Object} [options.existingData] - Pre-fetched proxies data
 * @param {Object} [options.existingConfig] - Pre-fetched config
 * @returns {Promise<{data: Object, config: Object, groups: string[], mainGroup: string, proxies: string[], current: string|null}|null>}
 */
export async function fetchProxyGroups(options = {}) {
    /** @type {{proxies?: Record<string, {type?: string, all?: string[], now?: string|null}>}} */
    const data = options.existingData || await getProxies();
    if (!data || !data.proxies) {
        return null;
    }

    /** @type {{mode?: string}} */
    const config = options.existingConfig || await getConfig();

    // Filter out selector/select type groups
    const proxyMap = data.proxies;
    const groups = Object.keys(proxyMap).filter(name => {
        const type = proxyMap[name]?.type?.toLowerCase() || '';
        return type === 'selector' || type === 'select';
    });

    // Determine main group based on mode
    let mainGroup = 'GLOBAL';
    const mode = config?.mode?.toLowerCase();

    if (mode === 'direct') {
        mainGroup = 'DIRECT';
    } else if (mode !== 'global') {
        mainGroup = groups.find(g => g.toLowerCase().includes('proxy')) || groups[0];
    }

    // Fallback if mainGroup is missing
    if (!proxyMap[mainGroup]) {
        mainGroup = groups.find(g => g.toLowerCase().includes('proxy')) || groups[0];
    }

    // Last resort fallback
    if (!proxyMap[mainGroup]) {
        mainGroup = groups[0];
    }

    if (!mainGroup || !proxyMap[mainGroup]) {
        return null;
    }

    const proxies = proxyMap[mainGroup]?.all || [];
    const current = proxyMap[mainGroup]?.now || null;

    return { data, config, groups, mainGroup, proxies, current };
}
