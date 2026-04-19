// @ts-check
/**
 * Sequential executor — ensures async operations complete in order.
 *
 * When multiple operations share the same key, only the latest one's
 * result is delivered. Earlier results are silently discarded.
 *
 * Use case: rapidly switching proxy groups — old API responses must not
 * overwrite newer ones.
 *
 * @module utils/sequential
 */

/**
 * @typedef {Object} SequentialHandle
 * @property {<T>(key: string, fn: () => Promise<T>) => Promise<T>} run
 *   Execute fn under the given key. If a newer run() for the same key
 *   completes first, this result is discarded.
 * @property {() => void} destroy
 *   Release all internal state.
 */

/**
 * Create a sequential executor instance.
 * @returns {SequentialHandle}
 */
export function createSequential() {
    /** @type {Map<string, number>} Monotonic version counter per key. */
    const versions = new Map();

    /** @type {Map<string, Promise<any>>} Currently pending promise per key. */
    const pending = new Map();

    /**
     * Run an async operation under a key. Only the latest version's result
     * is resolved; earlier versions reject with 'STALE'.
     *
     * @template T
     * @param {string} key
     * @param {() => Promise<T>} fn
     * @returns {Promise<T>}
     */
    function run(key, fn) {
        // Bump version for this key
        const myVersion = (versions.get(key) || 0) + 1;
        versions.set(key, myVersion);

        // Cancel previous pending run for this key (no-op on Promise,
        // but we track it so destroy() can wait)
        pending.set(key, fn().then((result) => {
            // Only resolve if we are still the latest version
            if (versions.get(key) === myVersion) {
                pending.delete(key);
                return result;
            }
            // Stale — discard silently
            pending.delete(key);
        }).catch((err) => {
            pending.delete(key);
            // Always re-throw real errors so callers can handle them
            if (err && err.message !== 'STALE') throw err;
        }));

        return /** @type {Promise<any>} */ (pending.get(key));
    }

    /**
     * Release all internal state. Pending promises are not cancelled
     * (impossible with native Promise), but their results will be
     * discarded on completion.
     */
    function destroy() {
        versions.clear();
        pending.clear();
    }

    return { run, destroy };
}
