// @ts-check
/**
 * Deep Link handler module.
 *
 * Listens for `deep-link` events from the Rust backend (clash:// protocol)
 * and routes them to the appropriate UI actions.
 */

import { listen, invoke } from '../api.js';
import { showNotification, showConfirmModal } from './notifications.js';
import { translations } from '../i18n.js';
import { COMMANDS } from '@zephyr/shared';
import { apiLogger } from '../utils/logger.js';

/**
 * Initialize deep link event listener.
 * Should be called once during app startup.
 * @returns {Promise<() => void>} Unlisten function
 */
export async function initDeepLink() {
    return listen('deep-link', async (/** @type {{ payload: { action: string, url: string, name: string } }} */ event) => {
        const { action, url, name } = event.payload;

        if (action === 'install-config') {
            await handleInstallConfig(url, name);
        } else {
            apiLogger.warn(`[DeepLink] Unknown action: ${action}`);
        }
    });
}

/**
 * Handle an install-config deep link action.
 * Shows a confirmation dialog, then downloads the subscription.
 *
 * @param {string} url - The subscription URL
 * @param {string} name - The subscription name
 */
async function handleInstallConfig(url, name) {
    const lang = localStorage.getItem('lang') || 'en';
    /** @type {Record<string, string>} */
    const t = /** @type {any} */ (translations)[lang] || /** @type {any} */ (translations).en;

    const displayName = name || 'Subscription';
    const confirmed = await showConfirmModal(
        t.deepLinkTitle || 'Import from Deep Link',
        `${t.deepLinkConfirm || 'Import configuration from'}: ${displayName}\n${url}`
    );

    if (!confirmed) return;

    showNotification(t.notifDownloadingSub || 'Downloading subscription...');

    try {
        await invoke(COMMANDS.DOWNLOAD_SUB, { url, name: displayName });
        showNotification(t.notifSubSuccess || 'Subscription added successfully', 'success');
    } catch (err) {
        const message = err?.toString?.() || 'Unknown error';
        showNotification(`${t.notifSubFailed || 'Failed to download subscription'}: ${message}`, 'error');
    }
}
