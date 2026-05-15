// @ts-check
/**
 * Run-config cache — TTL-based cache for the compiled run_config.yaml JSON.
 *
 * The run_config (read via COMMANDS.CORE.READ_CONFIG) contains the deterministic
 * proxy-groups order and rules that are essential for the Resolver in
 * proxy-groups.js.  We cache it with a short TTL to avoid hammering the
 * backend on every render while keeping data reasonably fresh.
 *
 * Implements request coalescing: if multiple callers request the config
 * concurrently (e.g., during a full render cycle), only one IPC call is
 * dispatched and all callers share the same in-flight promise.
 *
 * Uses a generation counter to prevent stale in-flight requests from
 * overwriting the cache after invalidation (e.g., config/subscription switch).
 *
 * @module ui/run-config-cache
 */

import { invoke } from '../api.js';
import { COMMANDS } from '@zephyr/shared';

// --- State ---

/** @type {{ data: any, time: number } | null} */
let _cached = null;

/** @type {Promise<any> | null} In-flight request for coalescing */
let _pending = null;

/** Generation counter — incremented on invalidation so stale in-flight
 *  requests know to discard their results. */
let _generation = 0;

/** TTL in milliseconds (5 seconds). Config changes are rare and always trigger
 * explicit invalidation, so this only bounds the window for missed invalidations.
 * A 5s ceiling keeps worst-case staleness tolerable while still collapsing
 * redundant IPC calls within a render cycle. */
const RUN_CONFIG_TTL = 5000;

// --- Public API ---

/**
 * Get the run_config JSON, using a short TTL cache.
 * Concurrent calls are coalesced — only one IPC call is in-flight at a time.
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

    // Coalesce: if a request is already in-flight, reuse it
    if (_pending) return _pending;

    // Capture current generation to detect stale responses
    const gen = _generation;

    const p = (async () => {
        try {
            const data = await invoke(COMMANDS.CORE.READ_CONFIG);
            // Only cache if generation hasn't changed (i.e., no invalidation happened)
            if (_generation === gen) {
                _cached = { data, time: Date.now() };
            }
            return data;
        } catch (_e) {
            // On failure, return stale data if available, otherwise null
            if (_cached) return _cached.data;
            return null;
        } finally {
            // Only clear _pending if it still refers to this promise,
            // so we don't accidentally wipe a newer request started after invalidation.
            if (_pending === p) {
                _pending = null;
            }
        }
    })();
    _pending = p;

    return _pending;
}

/**
 * Invalidate the run_config cache.
 * Must be called whenever the config is updated, subscription is switched,
 * or the core is restarted.
 */
export function invalidateRunConfigCache() {
    _cached = null;
    _pending = null;
    _generation++;
}
