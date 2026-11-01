// @ts-check
/**
 * How to report the result of `update_config` (a patch written to the run
 * config, the active profile and hot-reloaded into the core).
 *
 * @module ui/config-update
 */

/**
 * @typedef {Object} ConfigUpdateResult
 * @property {boolean} files_saved        - run config and (when one is active) the profile were written
 * @property {boolean} [run_config_saved] - the run config was written
 * @property {boolean} [profile_saved]    - the active profile took the patch (true when none needed it)
 * @property {string}  [profile_error]    - why the profile did not take the patch
 * @property {boolean} hot_reload_success - the core reloaded the run config
 * @property {string}  message            - human-readable status
 */

/**
 * Classify an `update_config` result.
 *
 * - `applied`: every file was saved and the core reloaded it.
 * - `restart`: every file was saved; the core applies it after a restart.
 * - `partial`: the run config was saved but the active profile was not, so
 *   the change is lost the next time that profile is loaded.
 *
 * @param {Partial<ConfigUpdateResult>|null|undefined} result
 * @returns {'applied'|'restart'|'partial'}
 */
export function configUpdateOutcome(result) {
    if (result?.files_saved === false || result?.profile_saved === false) return 'partial';
    if (result?.hot_reload_success) return 'applied';
    return 'restart';
}

/**
 * Send a patch through `update_config`, then refresh the page's copy of the
 * core config. A failed refresh does not make the save a failure: the core
 * and the files already took the patch.
 * @param {Record<string, any>} patch
 * @param {{
 *   update: (patch: Record<string, any>) => Promise<any>,
 *   sync: () => Promise<unknown>,
 *   onSyncError?: (err: unknown) => void,
 * }} deps
 * @returns {Promise<any>} the `update_config` result; rejects only when the update fails
 */
export async function updateConfigThenSync(patch, { update, sync, onSyncError }) {
    const result = await update(patch);
    try {
        await sync();
    } catch (err) {
        onSyncError?.(err);
    }
    return result;
}
