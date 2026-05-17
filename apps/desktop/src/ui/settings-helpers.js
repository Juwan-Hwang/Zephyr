// @ts-check
/**
 * Settings.json persistence helpers.
 *
 * Provides a unified API for reading/writing individual fields
 * to the backend settings.json via GET_SETTINGS / SAVE_SETTINGS.
 * Fields stored here are "user preferences" that override YAML defaults;
 * `null` means "use the YAML default value".
 *
 * All writes are serialized through a queue to prevent race conditions
 * from concurrent Read-Modify-Write cycles.
 *
 * @module ui/settings-helpers
 */

import { invoke } from '../api.js';
import { COMMANDS } from '@zephyr/shared';
import { invalidateSettingsCache } from './cache.js';

/** Serial queue to prevent concurrent RMW race conditions. */
let saveQueue = Promise.resolve();

/**
 * Save a single field to settings.json.
 *
 * @param {string} key   - Field name in the Settings struct (e.g. "mode", "tun_enabled").
 * @param {*}      value - The value to store. Pass `null` to clear (fall back to YAML default).
 * @returns {Promise<void>}
 */
export function saveSetting(key, value) {
    saveQueue = saveQueue.then(async () => {
        const settings = await invoke(COMMANDS.GET_SETTINGS);
        settings[key] = value;
        await invoke(COMMANDS.SAVE_SETTINGS, { settings });
        invalidateSettingsCache();
    });
    return saveQueue;
}

/**
 * Save multiple fields to settings.json in a single round-trip.
 *
 * @param {Record<string, *>} patch - Key-value pairs to merge into settings.
 * @returns {Promise<void>}
 */
export function saveSettings(patch) {
    saveQueue = saveQueue.then(async () => {
        const settings = await invoke(COMMANDS.GET_SETTINGS);
        Object.assign(settings, patch);
        await invoke(COMMANDS.SAVE_SETTINGS, { settings });
        invalidateSettingsCache();
    });
    return saveQueue;
}

/**
 * Read a single field from settings.json.
 *
 * @template T
 * @param {string} key          - Field name in the Settings struct.
 * @param {T}      [fallback]   - Value returned when the field is `null` / `undefined`.
 * @returns {Promise<T>} The stored value, or `fallback` if absent.
 */
export async function getSetting(key, fallback) {
    const settings = await invoke(COMMANDS.GET_SETTINGS);
    const value = settings[key];
    return (value === null || value === undefined) ? fallback : value;
}
