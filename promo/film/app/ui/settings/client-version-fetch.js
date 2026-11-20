// @ts-check
/**
 * Retry controller for the fake-client (UA spoofing) version lookup.
 *
 * The lookup used to be re-triggered synchronously from its own `finally`
 * block, so a backend that failed fast (offline, rate-limited, empty reply)
 * produced a tight request loop that could starve the main thread. This
 * controller owns the lookup instead:
 *
 * - at most one request is in flight at a time;
 * - a failed or empty result schedules the next attempt with exponential
 *   backoff (`baseDelayMs * 2^n`, capped at `maxDelayMs`);
 * - after `maxAttempts` consecutive failures automatic retries stop until
 *   the caller explicitly asks again (`retryNow()`, e.g. on a user action);
 * - once a lookup succeeds, further requests are no-ops;
 * - `pause()` (feature switched off) cancels a scheduled retry and keeps a
 *   failing in-flight lookup from scheduling another one;
 * - a `retryNow()` that arrives while a lookup is in flight is remembered:
 *   if that lookup fails, a fresh budget starts right after it settles.
 *
 * @module ui/settings/client-version-fetch
 */

export const DEFAULT_BASE_DELAY_MS = 2000;
export const DEFAULT_MAX_DELAY_MS = 5 * 60 * 1000;
export const DEFAULT_MAX_ATTEMPTS = 6;

/**
 * @typedef {{ verge: string, mihomo_party: string, flclash: string }} ClientVersions
 */

/**
 * Whether a backend reply carries every version string the UI needs.
 * @param {unknown} value
 * @returns {value is ClientVersions}
 */
export function isValidClientVersions(value) {
    if (!value || typeof value !== 'object') return false;
    const v = /** @type {Record<string, unknown>} */ (value);
    return ['verge', 'mihomo_party', 'flclash'].every(
        (k) => typeof v[k] === 'string' && /** @type {string} */ (v[k]).trim() !== '',
    );
}

/**
 * Delay before retry number `failures` (1-based), with exponential growth and a cap.
 * @param {number} failures
 * @param {number} [baseDelayMs]
 * @param {number} [maxDelayMs]
 * @returns {number}
 */
export function computeBackoffDelay(failures, baseDelayMs = DEFAULT_BASE_DELAY_MS, maxDelayMs = DEFAULT_MAX_DELAY_MS) {
    const exp = Math.max(0, failures - 1);
    // Clamp the exponent so the multiplication can never overflow to Infinity.
    const delay = baseDelayMs * Math.pow(2, Math.min(exp, 30));
    return Math.min(delay, maxDelayMs);
}

/**
 * @template T
 * @param {{
 *   fetch: () => Promise<unknown>,
 *   onSuccess: (value: T) => void,
 *   isValid?: (value: unknown) => boolean,
 *   onFailure?: (err: unknown, info: { failures: number, nextDelayMs: number | null }) => void,
 *   onSettled?: () => void,
 *   baseDelayMs?: number,
 *   maxDelayMs?: number,
 *   maxAttempts?: number,
 * }} options
 */
export function createClientVersionFetcher(options) {
    const {
        fetch,
        onSuccess,
        isValid = (v) => v !== null && v !== undefined,
        onFailure,
        onSettled,
        baseDelayMs = DEFAULT_BASE_DELAY_MS,
        maxDelayMs = DEFAULT_MAX_DELAY_MS,
        maxAttempts = DEFAULT_MAX_ATTEMPTS,
    } = options;

    let inFlight = false;
    let done = false;
    let disposed = false;
    let failures = 0;
    let paused = false;
    let retryRequested = false;
    /** @type {ReturnType<typeof setTimeout> | null} */
    let retryTimer = null;

    function clearRetry() {
        if (retryTimer !== null) {
            clearTimeout(retryTimer);
            retryTimer = null;
        }
    }

    async function run() {
        inFlight = true;
        let succeeded = false;
        try {
            const value = await fetch();
            if (disposed) return;
            if (!isValid(value)) throw new Error('Empty or incomplete client version response');
            failures = 0;
            retryRequested = false;
            done = true;
            succeeded = true;
            onSuccess(/** @type {T} */ (value));
        } catch (err) {
            if (disposed) return;
            if (!succeeded && retryRequested && !paused) {
                // The user asked again while this attempt was running: give
                // them a fresh budget and try once more as soon as it settles.
                retryRequested = false;
                failures = 0;
                retryTimer = setTimeout(() => {
                    retryTimer = null;
                    if (!disposed && !done && !inFlight && !paused) void run();
                }, 0);
                onFailure?.(err, { failures: 1, nextDelayMs: 0 });
            } else if (!succeeded) {
                failures += 1;
                const canRetry = !paused && failures < maxAttempts;
                const nextDelayMs = canRetry ? computeBackoffDelay(failures, baseDelayMs, maxDelayMs) : null;
                if (nextDelayMs !== null) {
                    retryTimer = setTimeout(() => {
                        retryTimer = null;
                        if (!disposed && !done && !inFlight && !paused) void run();
                    }, nextDelayMs);
                }
                onFailure?.(err, { failures, nextDelayMs });
            } else {
                // onSuccess itself threw; do not retry the network call for a UI error.
                onFailure?.(err, { failures, nextDelayMs: null });
            }
        } finally {
            inFlight = false;
            if (!disposed) onSettled?.();
        }
    }

    return {
        /**
         * Start a lookup unless one is in flight, a retry is already scheduled,
         * the lookup already succeeded, or automatic retries are exhausted.
         * Safe to call repeatedly (e.g. from a visibility refresh).
         */
        request() {
            if (disposed || done) return;
            paused = false;
            if (inFlight || retryTimer !== null) return;
            if (failures >= maxAttempts) return;
            void run();
        },
        /**
         * User-initiated retry: resets the failure budget and starts a lookup
         * now (unless one is in flight or the lookup already succeeded).
         */
        retryNow() {
            if (disposed || done) return;
            paused = false;
            if (inFlight) {
                retryRequested = true;
                return;
            }
            clearRetry();
            failures = 0;
            void run();
        },
        /**
         * Stop automatic retries (e.g. the feature was switched off). A
         * lookup already in flight finishes, but a failure no longer
         * schedules another attempt. `request()`/`retryNow()` resume.
         */
        pause() {
            paused = true;
            retryRequested = false;
            clearRetry();
        },
        /** Cancel any pending retry and ignore late results. */
        dispose() {
            disposed = true;
            clearRetry();
        },
        get state() {
            return { inFlight, done, failures, paused, retryScheduled: retryTimer !== null };
        },
    };
}
