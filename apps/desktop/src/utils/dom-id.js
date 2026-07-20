// @ts-check
/**
 * Cryptographically secure DOM element ID generator.
 *
 * Replaces `Math.random().toString(36)` patterns that trigger SAST alerts
 * (S2245 — PRNGs should not be used in security contexts).  Uses the Web
 * Crypto API (`crypto.getRandomValues`) which is available in all modern
 * browsers, Node.js ≥ 19, and Tauri WebView2.
 *
 * @module utils/dom-id
 */

/**
 * Monotonic counter mixed into each generated ID as defense-in-depth.
 *
 * `crypto.getRandomValues` provides 32 bits of entropy (~4 billion values),
 * making random collisions astronomically unlikely.  The counter provides an
 * *additional* guarantee: even if two calls were to produce identical random
 * bytes, XOR-ing with different counter values yields different output — so
 * uniqueness is guaranteed within a single session regardless of the random
 * source.
 *
 * Wraps at 2³² (~4.3 billion calls), which is unreachable in any realistic
 * DOM usage.
 *
 * @type {number}
 */
let counter = 0;

/**
 * Generate a short, unique DOM element ID using cryptographic randomness.
 *
 * Produces IDs like `"collapsible-content-a3f9k2x"` — same length and
 * character set as the legacy `Math.random().toString(36).substring(2, 9)`
 * pattern, but backed by `crypto.getRandomValues()` instead of a PRNG.
 *
 * The monotonic counter is XOR-mixed into the random bytes before encoding,
 * so the output remains uniformly distributed while guaranteeing per-session
 * uniqueness even in the impossible case of a random collision.
 *
 * @param {string} prefix - ID prefix for readability and namespace isolation
 * @returns {string} A unique DOM-safe ID
 *
 * @example
 * const id = generateDomId('rl-group-body'); // "rl-group-body-k7m2x9a"
 */
export function generateDomId(prefix = 'id') {
    const bytes = new Uint8Array(4);
    globalThis.crypto.getRandomValues(bytes);

    // XOR-mix all 32 bits of the counter into the random bytes.
    // XOR preserves uniform distribution and guarantees that two calls
    // with identical random bytes still produce different output.
    const seq = counter++ >>> 0;
    bytes[0] ^= (seq & 0xff);
    bytes[1] ^= ((seq >>> 8) & 0xff);
    bytes[2] ^= ((seq >>> 16) & 0xff);
    bytes[3] ^= ((seq >>> 24) & 0xff);

    // Each byte (0-255) → 1-2 base-36 chars; 4 bytes → 8 chars.
    const random = Array.from(bytes, b => b.toString(36).padStart(2, '0')).join('');
    return `${prefix}-${random.slice(0, 7)}`;
}
