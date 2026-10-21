// @ts-check
/**
 * The profile the core runs when saving it as the active one failed: the
 * stored `last_config` still names the previous one, so every place that
 * saves a node or group choice for "the current profile" asks here first.
 */

/** @type {string|null} */
let unsaved = null;

/**
 * Record the outcome of saving `name` as the active profile.
 * @param {string} name
 * @param {boolean} saved
 */
export function noteActiveProfile(name, saved) {
    unsaved = saved ? null : name;
}

/**
 * The profile the core runs.
 * @param {{ last_config?: string|null }|null|undefined} settings the stored settings
 * @param {string} [fallback] when neither is known
 * @returns {string}
 */
export function activeProfile(settings, fallback = '') {
    return unsaved || settings?.last_config || fallback;
}
