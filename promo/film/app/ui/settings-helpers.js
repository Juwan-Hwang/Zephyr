// @ts-check
/**
 * Settings.json persistence helpers.
 *
 * Provides a unified API for reading/writing individual fields
 * to the backend settings.json via GET_SETTINGS / PATCH_SETTINGS.
 * Fields stored here are "user preferences" that override YAML defaults;
 * `null` means "use the YAML default value".
 *
 * Writes use the backend PATCH_SETTINGS command for atomic partial updates,
 * eliminating Read-Modify-Write race conditions. A serial queue ensures
 * ordering and catches errors to prevent chain breakage.
 *
 * @module ui/settings-helpers
 */

import { invoke } from '../api.js';
import { COMMANDS } from '@zephyr/shared';
import { invalidateSettingsCache } from './cache.js';
import { settingsLogger } from '../utils/logger.js';

/** Serial queue to ensure ordered writes. Catches errors to prevent chain breakage. */
let saveQueue = Promise.resolve();

/**
 * Save a single field to settings.json (atomic backend patch).
 *
 * @param {string} key   - Field name in the Settings struct (e.g. "theme_mode", "tun_enabled").
 * @param {*}      value - The value to store. Pass `null` to clear (fall back to YAML default).
 * @returns {Promise<void>}
 */
export function saveSetting(key, value) {
    saveQueue = saveQueue
        .then(async () => {
            await invoke(COMMANDS.PATCH_SETTINGS, { patch: { [key]: value } });
            invalidateSettingsCache();
        })
        .catch((e) => {
            settingsLogger.warn(`Failed to save ${key}:`, e);
        });
    return saveQueue;
}

/**
 * Like saveSetting(), but the returned promise rejects when the write fails, for
 * callers that must report or undo it.
 * @param {string} key
 * @param {any} value
 * @returns {Promise<void>}
 */
export function saveSettingChecked(key, value) {
    const run = saveQueue.then(async () => {
        await invoke(COMMANDS.PATCH_SETTINGS, { patch: { [key]: value } });
        invalidateSettingsCache();
    });
    saveQueue = run.catch((e) => {
        settingsLogger.warn(`Failed to save ${key}:`, e);
    });
    return run;
}

/**
 * Save multiple fields to settings.json in a single atomic patch.
 *
 * @param {Record<string, *>} patch - Key-value pairs to merge into settings.
 * @returns {Promise<void>}
 */
export function saveSettings(patch) {
    saveQueue = saveQueue
        .then(async () => {
            await invoke(COMMANDS.PATCH_SETTINGS, { patch });
            invalidateSettingsCache();
        })
        .catch((e) => {
            settingsLogger.warn('Failed to save settings:', e);
        });
    return saveQueue;
}

/**
 * Read a single field from settings.json.
 *
 * @template T
 * @param {string} key          - Field name in the Settings struct.
 * @param {T}      fallback     - Value returned when the field is `null` / `undefined`.
 * @returns {Promise<T>} The stored value, or `fallback` if absent.
 */
export async function getSetting(key, fallback) {
    const settings = await invoke(COMMANDS.GET_SETTINGS);
    const value = settings[key];
    return (value === null || value === undefined) ? fallback : value;
}
