// @ts-check
/**
 * Global cleanup function registry.
 *
 * Provides a simple module-scoped `Set` where any part of the application
 * can register async cleanup callbacks. On shutdown (e.g. Tauri
 * `close_requested` or `window.unload`), call `runCleanup()` to drain
 * all registered functions concurrently.
 *
 * ES module with a singleton registry.
 *
 * @module utils/cleanup-registry
 */

/** @private @type {Set<Function>} */
const registry = new Set();

/**
 * Register an async cleanup function.
 *
 * The function will be invoked (with no arguments) when `runCleanup()` is
 * called. If the same function reference is registered multiple times it
 * is only stored once (Set semantics).
 *
 * @param {() => void | Promise<void>} fn - Cleanup callback (sync or async).
 * @returns {() => void} Unregister function — call to remove `fn` from the registry.
 *
 * @example
 * const unsub = registerCleanup(async () => {
 *     await websocket.disconnect();
 * });
 *
 * // Later, if the resource is cleaned up early:
 * unsub();
 */
export function registerCleanup(fn) {
    registry.add(fn);
    return () => { registry.delete(fn); };
}

/**
 * Run all registered cleanup functions concurrently.
 *
 * Each function is awaited independently — a rejection in one does not
 * prevent the others from running. Errors are silently swallowed to
 * ensure best-effort cleanup.
 *
 * @returns {Promise<void>} Resolves when all cleanup functions have settled.
 *
 * @example
 * window.addEventListener('beforeunload', () => {
 *     runCleanup();
 * });
 */
export async function runCleanup() {
    const fns = [...registry];
    await Promise.all(fns.map(async (fn) => {
        try {
            await fn();
        } catch {
            // Best-effort — do not let one failure block others.
        }
    }));
}
