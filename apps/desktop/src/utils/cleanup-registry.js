// @ts-check
/**
 * Global cleanup function registry.
 *
 * Provides a simple module-scoped `Set` where any part of the application
 * can register async cleanup callbacks. On shutdown (e.g. Tauri
 * `close_requested` or `window.unload`), call `runCleanup()` to drain
 * all registered functions concurrently.
 *
 * If `runCleanup()` has already been called, any subsequently registered
 * cleanup function is invoked immediately rather than silently dropped.
 * This prevents late-arriving listeners (e.g. async `listen()` promises
 * that resolve after `beforeunload`) from leaking backend subscriptions.
 *
 * @module utils/cleanup-registry
 */

/** @private @type {Set<Function>} */
const registry = new Set();

/** @private @type {boolean} Whether `runCleanup()` has already been called. */
let cleanedUp = false;

/**
 * Register an async cleanup function.
 *
 * The function will be invoked (with no arguments) when `runCleanup()` is
 * called. If `runCleanup()` has already been called, `fn` is invoked
 * immediately (best-effort, errors swallowed).
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
    if (cleanedUp) {
        // Cleanup already ran — invoke immediately so the resource is not leaked.
        try { fn(); } catch { /* best-effort */ }
        return () => {};
    }
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
 * After this call, any future `registerCleanup()` call will invoke its
 * callback immediately.
 *
 * @returns {Promise<void>} Resolves when all cleanup functions have settled.
 *
 * @example
 * window.addEventListener('beforeunload', () => {
 *     runCleanup();
 * });
 */
export async function runCleanup() {
    if (cleanedUp) return;
    cleanedUp = true;
    const fns = [...registry];
    registry.clear();
    await Promise.all(fns.map(async (fn) => {
        try {
            await fn();
        } catch {
            // Best-effort — do not let one failure block others.
        }
    }));
}

/**
 * Reset the cleanup state back to its initial (pre-run) configuration.
 *
 * This is intended **only for tests** that share the module instance and
 * need to verify `registerCleanup` / `runCleanup` behaviour in isolation.
 * Calling it in production would mask leaked listeners.
 *
 * @internal
 */
export function _resetCleanupStateForTests() {
    registry.clear();
    cleanedUp = false;
}
