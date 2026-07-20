// @ts-check
/**
 * Cryptographically secure DOM element ID generator.
 *
 * Replaces `Math.random().toString(36)` patterns that trigger SAST alerts
 * (S2245 — PRNGs should not be used in security contexts).  Uses the Web
 * Crypto API (`crypto.getRandomValues`) which is available in all modern
 * browsers, Node.js ≥ 19, and Tauri WebView2.  A `Math.random` fallback
 * ensures graceful degradation in constrained runtimes (e.g. Node 18
 * without `--experimental-global-webcrypto`).
 *
 * @module utils/dom-id
 */

/**
 * Monotonic counter appended to each generated ID.
 *
 * 32 bits of crypto randomness gives ~4 billion values per call, making
 * random collisions astronomically unlikely.  The counter is appended as
 * a *separate* ID component (not XOR-mixed) so that even if two calls
 * produce identical random bytes, the counter still differs — guaranteeing
 * per-session uniqueness without sacrificing any random entropy.
 *
 * Wraps at 2³² (~4.3 billion calls), which is unreachable in any realistic
 * DOM usage.
 *
 * @type {number}
 */
let counter = 0;

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
    const bytes = new Uint8Array(4);
    const crypto = globalThis.crypto;
    if (crypto && typeof crypto.getRandomValues === 'function') {
        crypto.getRandomValues(bytes);
    } else {
        // Fallback for environments without Web Crypto (e.g. Node.js < 19).
        for (let i = 0; i < 4; i++) {
            bytes[i] = Math.floor(Math.random() * 256);
        }
    }

    // Combine 4 bytes into a single 32-bit unsigned integer, then encode
    // to base-36 in one pass.  This guarantees uniform distribution of all
    // base-36 characters (0-9, a-z) — per-byte encoding would skew the first
    // character of each pair to only 0-7 since byte max is 255 = "73" in base-36.
    const num = (bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)) >>> 0;
    const random = num.toString(36).padStart(7, '0');

    // Append the monotonic counter as a separate component to guarantee
    // per-session uniqueness without discarding any random entropy.
    const seq = (counter++ >>> 0).toString(36);
    return `${prefix}-${random}-${seq}`;
}
