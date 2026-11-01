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
 * Like saveSettings(), but the returned promise rejects when the write fails,
 * for callers that must report it (a change the core already runs that
 * settings.json, which overrides every profile at core start, did not take).
 * @param {Record<string, *>} patch
 * @returns {Promise<void>}
 */
export function saveSettingsChecked(patch) {
    const run = saveQueue.then(async () => {
        await invoke(COMMANDS.PATCH_SETTINGS, { patch });
        invalidateSettingsCache();
    });
    saveQueue = run.catch((e) => {
        settingsLogger.warn('Failed to save settings:', e);
    });
    return run;
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

/**
 * Why a port dialog save is refused, or null when it can go ahead: a port out
 * of range (0 disables it), no proxy port left (mixed and SOCKS both 0), or two
 * listeners on one port. Hidden Redir/TProxy fields are left out: they are
 * hidden where the core does not start those listeners, so a value kept in
 * the profile holds no port.
 * @param {number[]} shown the ports the save writes
 * @param {number} mixedVal
 * @param {number} socksVal
 * @returns {{ key: string, fallback: string } | null}
 */
export function portPatchError(shown, mixedVal, socksVal) {
    if (shown.some((val) => !Number.isInteger(val) || val < 0 || val > 65535)) {
        return { key: 'portRangeError', fallback: 'Port must be between 0 and 65535' };
    }
    if (mixedVal === 0 && socksVal === 0) {
        return { key: 'portAllDisabledError', fallback: 'At least one proxy port (Mixed or SOCKS5) must be enabled' };
    }
    const used = shown.filter((v) => v > 0);
    if (new Set(used).size !== used.length) {
        return { key: 'portDuplicateError', fallback: 'Each port can only be used once' };
    }
    return null;
}

/**
 * The state a core switch shows after the settings are loaded: the saved
 * preference when set; otherwise what the core config says, when it was
 * read; otherwise null (keep what it shows: the config's defaults may not
 * be what the core runs).
 * @param {unknown} saved the settings.json value (null/undefined: unset)
 * @param {boolean} configRead whether the core config was read
 * @param {() => boolean} fromConfig the value the config gives
 * @returns {boolean | null}
 */
export function loadedToggleState(saved, configRead, fromConfig) {
    if (saved != null) return !!saved;
    return configRead ? fromConfig() : null;
}
