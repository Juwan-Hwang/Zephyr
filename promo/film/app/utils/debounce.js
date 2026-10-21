// @ts-check
/**
 * Creates a debounced function that delays invoking fn until after delayMs
 * have elapsed since the last time the debounced function was invoked.
 *
 * @param {Function} fn - Function to debounce
 * @param {number} delayMs - Delay in milliseconds
 * @param {boolean} [immediate=false] - Trigger on leading edge instead of trailing
 * @returns {Function} Debounced function with an attached .cancel() method
 *
 * @example
 * const onSave = debounce(saveHandler, 300);
 * input.addEventListener('input', onSave);
 * // Later, if you need to cancel the pending call:
 * onSave.cancel();
 */
export function debounce(fn, delayMs, immediate = false) {
    /** @type {number|undefined} */
    let timerId;

    const debounced = /** @this {*} */ function (/** @type {...*} */ ...args) {
        const shouldCallNow = immediate && !timerId;

        clearTimeout(timerId);

        if (shouldCallNow) {
            fn.apply(/** @type {*} */ (this), args);
        }

        timerId = setTimeout(() => {
            timerId = undefined;
            if (!immediate) {
                fn.apply(/** @type {*} */ (this), args);
            }
        }, delayMs);
    };

    /**
     * Cancel any pending debounced invocation.
     */
    debounced.cancel = () => {
        clearTimeout(timerId);
        timerId = undefined;
    };

    return debounced;
}
