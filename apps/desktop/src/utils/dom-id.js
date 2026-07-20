// @ts-check
/**
 * Cryptographically secure DOM element ID generator.
 *
 * Replaces `Math.random().toString(36)` patterns that trigger SAST alerts
 * (S2245 — PRNGs should not be used in security contexts).  Uses the Web
 * Crypto API (`crypto.getRandomValues`) which is available in all modern
 * browsers, Node.js ≥ 19, and Tauri WebView2.  When Web Crypto is
 * unavailable the monotonic counter alone provides per-session uniqueness —
 * no PRNG fallback is used, keeping the module S2245-compliant.
 *
 * @module utils/dom-id
 */

/**
 * Monotonic counter appended to each generated ID.
 *
 * The counter is XOR-mixed into the random component to add additional
 * entropy, and is *also* appended as a separate ID component so that
 * even if two calls produce identical random bytes, the counter still
 * differs — guaranteeing per-session uniqueness without sacrificing
 * any random entropy.
 *
 * Wraps at 2³² (~4.3 billion calls), which is unreachable in any realistic
 * DOM usage.
 *
 * @type {number}
 */
let counter = 0;

/**
 * Sanitize a prefix to ensure the resulting DOM ID is valid.
 *
 * DOM IDs must start with a letter and contain only alphanumerics, hyphens,
 * and underscores.  Whitespace and other special characters (which would
 * break `aria-controls` / `aria-labelledby` IDREF resolution) are replaced.
 * If the prefix is empty or becomes empty after sanitization, the default
 * `'id'` is used.
 *
 * @param {string} prefix
 * @returns {string}
 */
function sanitizePrefix(prefix) {
    if (typeof prefix !== 'string') return 'id';
    // Replace any character that is not alphanumeric, hyphen, or underscore.
    const cleaned = prefix.replace(/[^a-zA-Z0-9_-]/g, '-');
    // If no alphanumeric character survives, use the default.
    if (!/[a-zA-Z0-9]/.test(cleaned)) return 'id';
    // Ensure the first character is a letter (HTML4 compat / ARIA IDREF safe).
    if (!/^[a-zA-Z]/.test(cleaned)) return `id-${cleaned}`;
    return cleaned;
}

/**
 * Generate a short, collision-resistant DOM element ID using cryptographic
 * randomness.
 *
 * Produces IDs like `"collapsible-content-a3f9k2x-0"` — backed by
 * `crypto.getRandomValues()` instead of a PRNG.  The monotonic counter
 * is appended as a separate component to guarantee per-session uniqueness.
 *
 * @param {string} prefix - ID prefix for readability and namespace isolation
 * @returns {string} A unique DOM-safe ID
 *
 * @example
 * const id = generateDomId('rl-group-body'); // "rl-group-body-k7m2x9a-0"
 */
export function generateDomId(prefix = 'id') {
    const crypto = globalThis.crypto;
    const seq = counter++ >>> 0;
    const safePrefix = sanitizePrefix(prefix);

    let randomPart;
    if (crypto && typeof crypto.getRandomValues === 'function') {
        const randomValue = new Uint32Array(1);
        crypto.getRandomValues(randomValue);
        // XOR-mix the counter into the random value for additional entropy,
        // then encode as a 7-character base-36 string.  All 32 bits are
        // preserved — no truncation, no entropy loss.  The counter is also
        // appended as a separate suffix component to guarantee per-session
        // uniqueness even if random values collide.
        randomPart = ((randomValue[0] ^ seq) >>> 0).toString(36).padStart(7, '0');
    } else {
        // Fallback for environments without Web Crypto (e.g. Node.js < 19).
        // No PRNG is used — derive a deterministic 7-character component
        // from the monotonic counter to preserve the ID format contract.
        // (Sonar S2245 compliant — no Math.random.)
        randomPart = seq.toString(36).padStart(7, '0');
    }

    return `${safePrefix}-${randomPart}-${seq.toString(36)}`;
}
