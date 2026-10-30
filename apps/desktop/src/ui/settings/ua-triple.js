// @ts-check
/**
 * Map the User-Agent string the backend last accepted back to the
 * fake-client triple the settings UI edits.
 *
 * The backend stores a single UA string (`subscription_user_agent`), while
 * the UI edits a triple (enabled / preset-or-custom / custom text). When a
 * sync is rejected before any sync has succeeded this session there is no
 * in-memory snapshot to roll back to, so the accepted value is read back
 * from the backend and converted here: a preset UA maps back to its preset,
 * anything else is a custom text value.
 *
 * A null or empty backend value means the backend holds nothing, and the
 * state that matches it is the disabled triple: the backend uses its
 * default UA exactly when the feature is off, so restoring "disabled"
 * keeps storage, controls and backend in agreement instead of leaving
 * the rejected draft enabled to be rejected again on the next sync.
 *
 * A stored value that fails the backend's own validation (over 512 bytes,
 * or control characters) is not trustworthy as a rollback snapshot: the
 * backend never uses it for downloads, so it must not be marked accepted.
 * That case returns null, and the caller keeps the user's edit and says
 * the sync failed instead of claiming a revert.
 *
 * A missing or non-string value is different again: the read produced no
 * answer, so it also returns null and the caller keeps the edit.
 *
 * @module ui/settings/ua-triple
 */

/** The backend's `validate_user_agent` limit, in bytes (see `crates/core/src/config/subscription.rs`). */
const MAX_USER_AGENT_BYTES = 512;

/** Unicode control characters (Cc): what Rust `char::is_control` matches. */
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/;

/**
 * Trim like Rust `str::trim()`: the Unicode White_Space set. JS `trim()`
 * differs on exactly two points — it also strips U+FEFF, and it keeps
 * U+0085 — so trimming with it would restore a UA the backend stores
 * with its prefix, or reject one the backend would accept trimmed.
 * A plain scan, not a regex: the anchored alternatives of a trim
 * regex overlap, and the engine re-scans the tail from every start
 * position (super-linear on a long stored value).
 */
const RUST_WHITESPACE = new Set([
    '\t',
    '\n',
    '\v',
    '\f',
    '\r',
    ' ',
    '',
    ' ',
    ' ',
    ' ',
    ' ',
    ' ',
    ' ',
    ' ',
    ' ',
    ' ',
    ' ',
    ' ',
    ' ',
    ' ',
    ' ',
    ' ',
    ' ',
    ' ',
    '　',
]);

/** @param {string} value */
function trimLikeRust(value) {
    let start = 0;
    let end = value.length;
    while (start < end && RUST_WHITESPACE.has(value[start])) start += 1;
    while (end > start && RUST_WHITESPACE.has(value[end - 1])) end -= 1;
    return value.slice(start, end);
}

/**
 * @param {unknown} backendUA
 * @returns {{ enabled: string, type: string|null, custom: string|null }|null}
 */
export function uaTripleFromBackendUA(backendUA) {
    if (backendUA === null) {
        return { enabled: 'false', type: null, custom: null };
    }
    if (typeof backendUA !== 'string') return null;
    const trimmed = trimLikeRust(backendUA);
    if (!trimmed) {
        return { enabled: 'false', type: null, custom: null };
    }
    if (
        new TextEncoder().encode(trimmed).length > MAX_USER_AGENT_BYTES ||
        CONTROL_CHARS.test(trimmed)
    ) {
        return null;
    }
    const isPreset = /^(clash-verge|mihomo-party|Flclash)\//.test(trimmed);
    return {
        enabled: 'true',
        type: isPreset ? trimmed : 'custom',
        custom: isPreset ? null : trimmed,
    };
}
