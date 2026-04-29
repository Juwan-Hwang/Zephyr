// @ts-check
/**
 * Client Updater module.
 *
 * Provides UI for checking and installing Zephyr client updates.
 * Reuses the existing core-download-status event for progress reporting.
 */

import { invoke, listen } from '../api.js';
import { showNotification, showUpdateNotesModal } from './notifications.js';
import { translations } from '../i18n.js';
import { COMMANDS } from '@zephyr/shared';
import { apiLogger } from '../utils/logger.js';

/** P3: Guard flag to prevent concurrent update checks. */
let _updateCheckInProgress = false;

/**
 * Check for Zephyr client updates and show update dialog if available.
 */
export async function checkForClientUpdate() {
    // P3: Prevent concurrent update checks
    if (_updateCheckInProgress) return;
    _updateCheckInProgress = true;

    const lang = localStorage.getItem('lang') || 'en';
    /** @type {Record<string, string>} */
    const t = /** @type {any} */ (translations)[lang] || /** @type {any} */ (translations).en;

    showNotification(t.clientChecking || 'Checking for updates...');

    try {
        /** @type {{ version: string, download_url: string, release_notes: string }} */
        const info = await invoke(COMMANDS.GET_LATEST_CLIENT_VERSION);

        // Compare with current version (from Cargo.toml, injected at build time)
        const currentVersion = await invoke(COMMANDS.GET_APP_VERSION);

        if (info.version === currentVersion) {
            showNotification(t.notifNoUpdate || 'Already up to date', 'success');
            return;
        }

        // Show update dialog with release notes
        const confirmed = await showUpdateDialog(info.version, info.release_notes, t);
        if (!confirmed) return;

        // Listen for download progress
        const unlisten = await listen('core-download-status', (/** @type {{ payload: { status_text: string, progress: number } }} */ event) => {
            const { status_text, progress } = event.payload;
            apiLogger.info(`[ClientUpdater] ${status_text} (${progress}%)`);
        });

        try {
            await invoke(COMMANDS.UPDATE_CLIENT);
            showNotification(
                `${t.clientUpdateSuccess || 'Update downloaded successfully'} (${info.version})`,
                'success'
            );
        } finally {
            unlisten();
        }
    } catch (err) {
        const message = err?.toString?.() || 'Unknown error';
        showNotification(`${t.clientUpdateFailed || 'Update check failed'}: ${message}`, 'error');
    } finally {
        _updateCheckInProgress = false;
    }
}

/**
 * Show an update confirmation dialog with version info and release notes.
 *
 * @param {string} version - New version string
 * @param {string} releaseNotes - Release notes markdown/text
 * @param {Record<string, string>} t - Translation map
 * @returns {Promise<boolean>}
 */
async function showUpdateDialog(version, releaseNotes, t) {
    const title = `${t.clientUpdateAvailable || 'Update Available'}: v${version}`;
    return showUpdateNotesModal(title, releaseNotes);
}


