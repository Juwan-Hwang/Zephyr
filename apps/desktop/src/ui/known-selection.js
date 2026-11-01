// @ts-check
/**
 * The last node choice known for each profile's group, kept so a profile
 * switch can still save it when the core is too busy to answer in time.
 *
 * Every selection the app makes or restores is saved through
 * `saveProxySelection`, which records it here first; a successful restore
 * and an automatic failover switch record theirs too.
 *
 * Choices are kept per profile, so a late save for one profile (a node click
 * whose save lands after a switch) cannot replace the choice known for
 * another. The map is transient (never persisted) and bounded.
 *
 * @module ui/known-selection
 */

import { appStore } from './state.js';

/** At most this many profiles keep a known choice; the oldest record goes first. */
export const MAX_KNOWN_PROFILES = 16;

/**
 * @typedef {Object} KnownSelection
 * @property {string} profile - profile file name the choice belongs to
 * @property {string|null} group - group the node was picked in
 * @property {string} node - the picked node
 */

/** Bumped by every record, so a caller can tell whether one landed meanwhile. */
let revision = 0;
/**
 * The revision of each profile's latest record, so a record for one profile
 * does not count as a newer choice for another.
 * @type {Map<string, number>}
 */
const recordedAt = new Map();
/** recordedAt keeps this many profiles; the oldest records go first. */
const MAX_RECORDED_PROFILES = 64;
/** The newest revision dropped from recordedAt (0 when none was). */
let droppedUpTo = 0;

/**
 * Note that `profile` was recorded at the current revision, dropping the
 * oldest entries past the bound (a profile cleared or evicted long ago).
 * @param {string} profile
 */
function markRecorded(profile) {
    recordedAt.delete(profile); // re-inserted last: the map stays oldest first
    recordedAt.set(profile, revision);
    for (const [name, at] of recordedAt) {
        if (recordedAt.size <= MAX_RECORDED_PROFILES) break;
        recordedAt.delete(name);
        droppedUpTo = Math.max(droppedUpTo, at);
    }
}

/** @returns {KnownSelection[]} oldest first */
function knownList() {
    const list = appStore.get('knownSelections');
    return Array.isArray(list) ? list : [];
}

/**
 * Record the node chosen in a profile's group. A record without a node clears
 * that profile's entry: its selection is unknown. A record without a profile
 * has nowhere to go and is ignored.
 * @param {string} profile
 * @param {{ group?: string|null, node?: string|null }} selection
 */
export function noteKnownSelection(profile, { group, node } = {}) {
    if (!profile) return;
    // Re-added at the end: the most recent record is the last one dropped.
    const next = knownList().filter((known) => known.profile !== profile);
    if (node) next.push({ profile, group: group || null, node });
    revision += 1;
    markRecorded(profile);
    appStore.set('knownSelections', next.slice(-MAX_KNOWN_PROFILES));
}

/**
 * A number that changes whenever a choice is recorded. A caller that records
 * after an await (failover) compares it with the value it read before, so a
 * choice the user made meanwhile is not replaced by an older one.
 * @returns {number}
 */
export function knownSelectionRevision() {
    return revision;
}

/**
 * Whether a choice was recorded for `profile` after `knownSelectionRevision()`
 * returned `since`. Records for other profiles do not count: they are no
 * newer choice for this one. Only the latest records are kept per profile
 * name (bounded), so an evicted one that may be newer still counts.
 * @param {number} since
 * @param {string} profile
 * @returns {boolean}
 */
export function knownSelectionChangedSince(since, profile) {
    const at = recordedAt.get(profile);
    // A dropped entry may have been newer than `since`: count it as changed,
    // so an older choice never replaces it.
    if (at === undefined) return droppedUpTo > since;
    return at > since;
}

/**
 * The last known choice for `profile`, if it was made in `group` (any group
 * when `group` is not given). A choice recorded without a group does not
 * match a requested group: it may belong to another one.
 * @param {string} profile
 * @param {string|null} [group]
 * @returns {KnownSelection|null}
 */
export function knownSelection(profile, group = null) {
    if (!profile) return null;
    const known = knownList().find((entry) => entry.profile === profile);
    if (!known) return null;
    if (group && known.group !== group) return null;
    return { ...known };
}

/**
 * Move a profile's known choice to the name it was renamed to. Whatever was
 * known under the new name belonged to a file that no longer has it.
 * @param {string} oldName
 * @param {string} newName
 */
export function renameKnownSelection(oldName, newName) {
    if (!oldName || !newName || oldName === newName) return;
    const list = knownList();
    const at = recordedAt.get(oldName);
    if (at !== undefined) {
        recordedAt.delete(oldName);
        recordedAt.delete(newName);
        recordedAt.set(newName, at);
    }
    if (!list.some((known) => known.profile === oldName)) return;
    appStore.set('knownSelections', list
        .filter((known) => known.profile !== newName)
        .map((known) => (known.profile === oldName ? { ...known, profile: newName } : known)));
}

/** Whether any choice is known (for any profile). */
export function hasKnownSelections() {
    return knownList().length > 0;
}
