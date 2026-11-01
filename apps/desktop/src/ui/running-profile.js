// @ts-check
/**
 * The profile the core runs, read uncached.
 *
 * @module ui/running-profile
 */
import { invoke } from '../api.js';
import { COMMANDS } from '@zephyr/shared';
import { activeProfile } from './active-profile.js';

/**
 * The running profile, read uncached (a cached name can lag just after a
 * profile change); '' when unknown or while the minimal config runs.
 * @returns {Promise<string>}
 */
export async function readRunningProfile() {
    try {
        return activeProfile(await invoke(COMMANDS.GET_SETTINGS), 'config.yaml');
    } catch {
        return '';
    }
}
