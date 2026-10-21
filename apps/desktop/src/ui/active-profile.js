// @ts-check
/**
 * The profile the core runs, when it is not the stored `last_config`
 * (saving it as the active one failed, or a restart fell back to another
 * profile): every place that saves a node or group choice for "the current
 * profile" asks here first.
 */
import { Bus, Events } from './events.js';

/** @type {string|null} */
let unsaved = null;
/** The core runs the built-in minimal config: no profile to save choices under. */
let minimal = false;

/**
 * Record the outcome of saving `name` as the active profile.
 * @param {string} name
 * @param {boolean} saved
 */
export function noteActiveProfile(name, saved) {
    unsaved = saved ? null : name;
}

/**
 * A core restart reported the profile it now runs (`active_config`; null
 * for the built-in minimal config). Restarts that are not a switch (TUN,
 * Geo data, a subscription update, custom arguments) start the stored
 * profile, or another one when that fails to load, so the report replaces
 * any earlier record.
 * @param {unknown} running
 */
export function noteRunningProfile(running) {
    minimal = running === null;
    unsaved = typeof running === 'string' && running ? running : null;
}

/**
 * A profile was renamed: a record of it follows the new name.
 * @param {string} oldName
 * @param {string} newName
 */
export function noteProfileRenamed(oldName, newName) {
    if (unsaved && unsaved === oldName && newName) unsaved = newName;
}

/**
 * The profile the core runs. While it runs the minimal config this is the
 * fallback: the stored `last_config` is the profile that failed to load,
 * and choices made on the minimal config do not belong to it.
 * @param {{ last_config?: string|null }|null|undefined} settings the stored settings
 * @param {string} [fallback] when neither is known
 * @returns {string}
 */
export function activeProfile(settings, fallback = '') {
    if (minimal) return fallback;
    return unsaved || settings?.last_config || fallback;
}

/**
 * The profile lists mark as current, and that is restarted when it is
 * updated: the running one, as for activeProfile, except that while the
 * minimal config runs it is the stored profile (the one that failed to
 * load), so updating or picking it tries it again.
 * @param {{ last_config?: string|null }|null|undefined} settings the stored settings
 * @param {string} [fallback] when neither is known
 * @returns {string}
 */
export function currentProfile(settings, fallback = '') {
    return unsaved || settings?.last_config || fallback;
}

Bus.on(Events.CORE_RESTARTED, (/** @type {any} */ payload) => {
    if (payload && 'activeConfig' in payload) noteRunningProfile(payload.activeConfig);
});
