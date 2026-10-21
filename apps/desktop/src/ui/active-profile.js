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
    unsaved = typeof running === 'string' && running ? running : null;
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

Bus.on(Events.CORE_RESTARTED, (/** @type {any} */ payload) => {
    if (payload && 'activeConfig' in payload) noteRunningProfile(payload.activeConfig);
});
