/**
 * Restore Defaults saves the whole settings object, seconds after it read it
 * (the reset first runs its live steps). These helpers keep that save from
 * undoing a save that landed meanwhile.
 */

/**
 * Same stored value: settings are plain JSON.
 * @param {unknown} a
 * @param {unknown} b
 */
const sameValue = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The settings the reset saves: `stored` (read just before the save) with
 * what the reset changed in its snapshot — every key that differs between
 * `before` (the snapshot as first read) and `reset` (the snapshot now), and
 * every key in `forced`, as `reset` has it (a key missing there is removed).
 * Keys the reset left alone keep their stored value.
 * @param {Record<string, unknown>} stored
 * @param {Record<string, unknown>} before
 * @param {Record<string, unknown>} reset
 * @param {string[]} [forced]
 * @returns {Record<string, unknown>}
 */
export function withResetChanges(stored, before, reset, forced = []) {
    const out = { ...stored };
    const keys = new Set([...Object.keys(before), ...Object.keys(reset), ...forced]);
    for (const key of keys) {
        if (!forced.includes(key) && sameValue(before[key], reset[key])) continue;
        if (Object.prototype.hasOwnProperty.call(reset, key)) out[key] = reset[key];
        else delete out[key];
    }
    return out;
}
