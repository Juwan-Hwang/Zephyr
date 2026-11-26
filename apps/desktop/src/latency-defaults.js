/** Built-in latency test address (also what an empty setting means). */
export const DEFAULT_LATENCY_TEST_URL = 'https://www.gstatic.com/generate_204';

/** @param {unknown} value @returns {string} effective normalized HTTP(S) probe address */
export function normalizeLatencyTestUrl(value) {
    try {
        const url = new URL(typeof value === 'string' ? value.trim() : '');
        if ((url.protocol === 'http:' || url.protocol === 'https:') && url.hostname) return url.href;
    } catch { /* Invalid saved settings use the built-in address. */ }
    return DEFAULT_LATENCY_TEST_URL;
}
