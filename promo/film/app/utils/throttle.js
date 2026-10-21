// @ts-check
/**
 * Creates a throttled function that only invokes func at most once per limit ms.
 *
 * @param {Function} func - Function to throttle
 * @param {number} limit - Minimum interval between invocations in milliseconds
 * @returns {Function} Throttled function
 *
 * @example
 * const onScroll = throttle(handleScroll, 100);
 * window.addEventListener('scroll', onScroll);
 */
export function throttle(func, limit) {
    /** @type {number|undefined} */
    let lastTimeoutId;
    let lastCallTime = 0;

    return /** @this {*} */ function throttled(/** @type {...*} */ ...args) {
        const now = Date.now();

        const nextCall = () => {
            func.apply(/** @type {*} */ (this), args);
            lastCallTime = now;
        };

        if (!lastCallTime) {
            nextCall();
            return;
        }

        clearTimeout(lastTimeoutId);

        const waitTime = Math.max(0, limit - (now - lastCallTime));
        lastTimeoutId = setTimeout(nextCall, waitTime);
    };
}
