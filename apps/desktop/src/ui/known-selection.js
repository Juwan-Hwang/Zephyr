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
    appStore.set('knownSelections', next.slice(-MAX_KNOWN_PROFILES));
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

/** Whether any choice is known (for any profile). */
export function hasKnownSelections() {
    return knownList().length > 0;
}
