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

/** @private @type {Promise<void> | null} In-flight cleanup promise for concurrent callers. */
let cleanupPromise = null;

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
        // Catch both sync throws and async rejections (best-effort).
        try {
            Promise.resolve(fn()).catch(() => {});
        } catch { /* best-effort */ }
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
export function runCleanup() {
    if (cleanedUp) return cleanupPromise ?? Promise.resolve();
    cleanedUp = true;
    const fns = [...registry];
    registry.clear();
    // Use a deferred promise so cleanupPromise is assigned BEFORE any
    // callback runs. This preserves the reentrancy guarantee: a callback
    // that synchronously calls runCleanup() receives the same in-flight
    // promise. Callbacks are invoked synchronously (not deferred to a
    // microtask) so synchronous teardown runs during beforeunload.
    //
    // Note: a callback that *awaits* runCleanup() will deadlock because
    // it waits for cleanupPromise which in turn waits for the callback.
    // This is an intentional limitation — callbacks should not
    // recursively await their own cleanup.
    /** @type {() => void} */
    const noop = () => {};
    let resolveCleanup = noop;
    cleanupPromise = new Promise((resolve) => { resolveCleanup = resolve; });
    Promise.all(
        fns.map((fn) => {
            try {
                return Promise.resolve(fn()).catch(() => {});
            } catch {
                // Synchronous throw — treat as already-settled.
                return Promise.resolve();
            }
        })
    ).then(() => resolveCleanup());
    return cleanupPromise;
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
    cleanupPromise = null;
}
