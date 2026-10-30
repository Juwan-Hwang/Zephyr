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
    '\u0085',
    '\u00A0',
    '\u1680',
    '\u2000',
    '\u2001',
    '\u2002',
    '\u2003',
    '\u2004',
    '\u2005',
    '\u2006',
    '\u2007',
    '\u2008',
    '\u2009',
    '\u200A',
    '\u2028',
    '\u2029',
    '\u202F',
    '\u205F',
    '\u3000',
]);

/**
 * Track user edits to the fake-client triple as a monotonic generation.
 * A backup import captures the generation when its queue task starts and
 * only restores the imported triple when nothing was edited in between:
 * an edit that lands while the import is in flight is newer than the
 * import, and restoring over it would silently drop it from storage and
 * from the backend (the queued edit sync reads storage after the
 * restore). A generation, not a value snapshot, is what makes this
 * sound: an edit that is typed and then typed back to the same value
 * still counts as a newer edit, while a snapshot comparison would be
 * fooled into restoring over it.
 * @returns {{ noteEdit: () => void, capture: () => number, unchangedSince: (captured: number) => boolean }}
 */
export function createUaEditTracker() {
    let generation = 0;
    return {
        /** Record one user edit to the triple. */
        noteEdit() {
            generation += 1;
        },
        /** Capture the current generation. */
        capture() {
            return generation;
        },
        /** Whether no edit has landed since `captured`. */
        unchangedSince(captured) {
            return captured === generation;
        },
    };
}

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
        // A byte count is never smaller than the UTF-16 length, so a
        // string already longer than the limit in code units cannot
        // fit: skip the full UTF-8 encoding pass for it.
        trimmed.length > MAX_USER_AGENT_BYTES ||
        new TextEncoder().encode(trimmed).length > MAX_USER_AGENT_BYTES ||
        CONTROL_CHARS.test(trimmed)
    ) {
        return null;
    }
    // A preset is a family prefix plus a version-like suffix: a custom
    // string that merely starts with a preset name
    // (`clash-verge/not-a-version`) is not a selectable preset — the
    // version refresh would otherwise replace it with the fetched
    // preset. `Shadowrocket/3.0.0` is the one fixed selectable value
    // outside the versioned families: it round-trips as a preset, but
    // any other `Shadowrocket/...` value stays custom.
    const isPreset =
        /^(clash-verge|mihomo-party|Flclash)\/\d+(\.\d+){0,2}([-+][0-9A-Za-z.-]+)?$/.test(trimmed) ||
        trimmed === 'Shadowrocket/3.0.0';
    return {
        enabled: 'true',
        type: isPreset ? trimmed : 'custom',
        custom: isPreset ? null : trimmed,
    };
}
