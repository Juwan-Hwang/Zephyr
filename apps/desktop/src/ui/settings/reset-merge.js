/**
 * Restore Defaults first runs its live steps, then patches only the fields it
 * changed. Concurrent writes to all other settings remain intact.
 */

/**
 * Same stored value: settings are plain JSON.
 * @param {unknown} a
 * @param {unknown} b
 */
const sameValue = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Only the fields reset by this operation. Sending them as an atomic patch
 * preserves concurrent writes to every other field, including backend writes.
 * @param {Record<string, unknown>} before
 * @param {Record<string, unknown>} reset
 * @param {string[]} [forced]
 * @returns {Record<string, unknown>}
 */
export function resetChangesPatch(before, reset, forced = []) {
    /** @type {Record<string, unknown>} */
    const patch = {};
    for (const key of new Set([...Object.keys(before), ...Object.keys(reset), ...forced])) {
        if (forced.includes(key) || !sameValue(before[key], reset[key])) patch[key] = reset[key] ?? null;
    }
    return patch;
}

