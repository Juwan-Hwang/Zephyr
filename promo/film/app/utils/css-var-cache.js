// @ts-check
/**
 * Cached reads of CSS custom properties.
 *
 * `getComputedStyle(...).getPropertyValue()` forces a style recalculation,
 * which is wasteful when it runs on every chart repaint and the value only
 * changes with the theme. The cache keeps resolved values until either
 * `invalidate()` is called (wire it to theme events) or the root element's
 * `class`/`style` attributes change — the two places theme state lives —
 * so a missed event can never leave a stale color behind.
 *
 * @module utils/css-var-cache
 */

/**
 * @typedef {Object} CssVarCache
 * @property {(name: string) => string} get  Trimmed computed value of a custom property.
 * @property {() => void} invalidate  Drop every cached value.
 */

/**
 * @param {() => Element} [getRoot]  Element to read from (default: <html>).
 * @returns {CssVarCache}
 */
export function createCssVarCache(getRoot = () => document.documentElement) {
    /** @type {Map<string, string>} */
    let values = new Map();
    /** @type {string | null} */
    let stamp = null;

    /** @type {Element | null} */
    let cachedRoot = null;
    /** @param {Element} root */
    function rootStamp(root) {
        return `${root.getAttribute('class') ?? ''}\u0000${root.getAttribute('style') ?? ''}`;
    }

    return {
        get(name) {
            const root = getRoot();
            const current = rootStamp(root);
            if (root !== cachedRoot || current !== stamp) {
                values = new Map();
                stamp = current;
                cachedRoot = root;
            }
            let value = values.get(name);
            if (value === undefined) {
                value = getComputedStyle(root).getPropertyValue(name).trim();
                values.set(name, value);
            }
            return value;
        },
        invalidate() {
            values = new Map();
            stamp = null;
            cachedRoot = null;
        },
    };
}
