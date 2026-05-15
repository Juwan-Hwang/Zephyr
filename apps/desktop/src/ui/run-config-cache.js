// @ts-check
/**
 * Run-config cache — TTL-based cache for the compiled run_config.yaml JSON.
 *
 * The run_config (read via COMMANDS.CORE.READ_CONFIG) contains the deterministic
 * proxy-groups order and rules that are essential for the Resolver in
 * proxy-groups.js.  We cache it with a short TTL to avoid hammering the
 * backend on every render while keeping data reasonably fresh.
 *
 * @module ui/run-config-cache
 */

import { invoke } from '../api.js';
import { COMMANDS } from '@zephyr/shared';

// --- State ---

/** @type {{ data: any, time: number } | null} */
let _cached = null;

/** TTL in milliseconds (3 seconds — matches the analysis requirement). */
const RUN_CONFIG_TTL = 3000;

// --- Public API ---

/**
 * Get the run_config JSON, using a short TTL cache.
 *
 * @param {{ force?: boolean }} [options]
 * @returns {Promise<any>} The run_config JSON object (or null on failure)
 */
export async function getRunConfigCached({ force = false } = {}) {
    const now = Date.now();

    // Return cached data if fresh and not forced
    if (!force && _cached && (now - _cached.time) < RUN_CONFIG_TTL) {
        return _cached.data;
    }

    try {
        const data = await invoke(COMMANDS.CORE.READ_CONFIG);
        _cached = { data, time: now };
        return data;
    } catch (_e) {
        // On failure, return stale data if available, otherwise null
        if (_cached) return _cached.data;
        return null;
    }
}

/**
 * Invalidate the run_config cache.
 * Must be called whenever the config is updated, subscription is switched,
 * or the core is restarted.
 */
export function invalidateRunConfigCache() {
    _cached = null;
}
