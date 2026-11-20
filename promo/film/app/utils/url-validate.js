// @ts-check
/**
 * Live validation for links typed into dialogs (subscription add, override import).
 *
 * @module utils/url-validate
 */

/**
 * Check a link the way the backend will (http/https with a host).
 * Returns an error code, or '' when the link is fine.
 *  - 'empty'  : nothing typed
 *  - 'scheme' : parses, but is not http(s)
 *  - 'invalid': not a link at all
 *
 * @param {string | null | undefined} raw
 * @returns {'' | 'empty' | 'scheme' | 'invalid'}
 */
export function validateHttpUrl(raw) {
    const value = (raw ?? '').trim();
    if (!value) return 'empty';
    // The backend refuses control characters (the URL parser would silently drop tabs/newlines).
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(value)) return 'invalid';
    /** @type {URL} */
    let u;
    try {
        u = new URL(value);
    } catch {
        // "example.com/sub" without a scheme: a link, but not one we can fetch.
        return /^[\w-]+(\.[\w-]+)+(:\d+)?(\/|$)/.test(value) ? 'scheme' : 'invalid';
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'scheme';
    // Exactly "//" and then a host, as the backend wants ("https:example.com", "http:///x" fail there).
    if (!u.hostname || !/^https?:\/\/[^/\\]/i.test(value)) return 'invalid';
    return '';
}
