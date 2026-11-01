// @ts-check
/**
 * The last node choice known for a profile's group, kept so a profile switch
 * can still save it when the core is too busy to answer in time.
 *
 * Every selection the app makes or restores is saved through
 * `saveProxySelection`, which records it here first; a live read of the
 * groups records what the core reports.
 *
 * @module ui/known-selection
 */

import { appStore } from './state.js';

/**
 * @typedef {Object} KnownSelection
 * @property {string} profile - profile file name the choice belongs to
 * @property {string|null} group - group the node was picked in
 * @property {string} node - the picked node
 */

/**
 * Record the node chosen in a profile's group. A record without a profile or
 * node clears the cache: the selection is unknown.
 * @param {string} profile
 * @param {{ group?: string|null, node?: string|null }} selection
 */
export function noteKnownSelection(profile, { group, node } = {}) {
    if (!profile || !node) {
        appStore.set('lastKnownSelection', null);
        return;
    }
    appStore.set('lastKnownSelection', { profile, group: group || null, node });
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
    /** @type {KnownSelection|null} */
    const known = appStore.get('lastKnownSelection');
    if (!known || !profile || known.profile !== profile) return null;
    if (group && known.group !== group) return null;
    return known;
}

/** Forget the cached choice (another profile is about to run). */
export function clearKnownSelection() {
    appStore.set('lastKnownSelection', null);
}
