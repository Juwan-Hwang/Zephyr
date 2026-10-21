// @ts-check
/**
 * Deep Link handler module.
 *
 * Listens for `deep-link` events from the Rust backend (clash:// protocol)
 * and routes them to the appropriate UI actions.
 */

import { listen, invoke, getCurrentWindow } from '../api.js';
import { showNotification, showConfirmModal } from './notifications.js';
import { translations } from '../i18n.js';
import { COMMANDS } from '@zephyr/shared';
import { apiLogger } from '../utils/logger.js';
import { appStore } from './state.js';
import { switchToConfig } from './lifecycle.js';
import { invalidateConfigsCache } from './cache.js';
import { subDownloadSlot } from './settings/sub-download-gate.js';

/** Same threshold Settings uses before telling the user the lock is still held. */
const BUSY_WARN_AFTER_MS = 15000;

/**
 * The first subscription arrived through a link: start using it, the same as
 * adding it in Settings does, or Home keeps showing the empty state. Waits for
 * any running subscription/network operation to release its lock first.
 * @param {string} configName
 */
async function activateIfFirst(configName) {
    const waitStart = Date.now();
    let warned = false;
    while (appStore.get('isNetworkUpdating')) {
        if (!warned && Date.now() - waitStart >= BUSY_WARN_AFTER_MS) {
            warned = true;
            const lang = localStorage.getItem('lang') || 'en';
            /** @type {Record<string, string>} */
            const t = /** @type {any} */ (translations)[lang] || /** @type {any} */ (translations).en;
            showNotification(t.consoleSubUpdateBusy || 'Update in progress, please wait', 'warning');
        }
        await new Promise((r) => setTimeout(r, 200));
    }
    if (!appStore.get('noSubscription')) return;
    appStore.set('isNetworkUpdating', true);
    try {
        /** @type {any} */
        const settings = await invoke(COMMANDS.GET_SETTINGS);
        await switchToConfig(configName, settings?.custom_args || []);
    } finally {
        appStore.set('isNetworkUpdating', false);
    }
}

/**
 * @typedef {Object} DeepLinkPayload
 * @property {string} action
 * @property {string} url
 * @property {string} name
 */

/**
 * Initialize deep link event listener.
 * Should be called once during app startup.
 * @returns {Promise<() => Promise<void>>} Unlisten function
 */
export async function initDeepLink() {
    // The backend keeps every link until the page takes it; the event only
    // says that one is waiting. Links that arrived before this listener (a
    // launch with a link, or one forwarded while the page was loading or
    // reloading) are taken right after it is registered.
    const unlisten = await listen('deep-link', () => { void takePendingDeepLinks(); });
    void takePendingDeepLinks();
    return unlisten;
}

/** @type {Promise<void>} */
let draining = Promise.resolve();

/**
 * Take the waiting links and handle them one at a time, oldest first. Runs
 * are chained so a link that arrives while an earlier prompt is open waits
 * behind it.
 * @returns {Promise<void>}
 */
function takePendingDeepLinks() {
    draining = draining.then(handlePendingDeepLinks);
    return draining;
}

/** At most this many links are handled per run (the backend holds 8). */
const MAX_LINKS_PER_RUN = 16;

/**
 * The backend hands out one link per call and keeps the rest, so links
 * behind an open prompt survive the page closing or reloading; a link
 * that fails is logged and the next one is still handled.
 */
async function handlePendingDeepLinks() {
    let revealed = false;
    for (let i = 0; i < MAX_LINKS_PER_RUN; i++) {
        /** @type {DeepLinkPayload | undefined} */
        let payload;
        try {
            const pending = await invoke(COMMANDS.TAKE_PENDING_DEEP_LINKS);
            payload = Array.isArray(pending) ? pending[0] : undefined;
        } catch (err) {
            apiLogger.warn('[DeepLink] Could not read waiting links', err);
            return;
        }
        if (!payload) return;
        // A silent start leaves the window hidden: show it, or the import
        // prompt waits where nobody sees it.
        if (!revealed) {
            revealed = true;
            await revealWindow();
        }
        try {
            await handleDeepLink(payload);
        } catch (err) {
            apiLogger.warn('[DeepLink] Could not handle a waiting link', err);
        }
    }
}

async function revealWindow() {
    try {
        const win = getCurrentWindow();
        await win.show();
        await win.setFocus();
    } catch (err) {
        apiLogger.warn('[DeepLink] Could not show the window for a held link', err);
    }
}

/** @param {DeepLinkPayload} payload */
async function handleDeepLink({ action, url, name }) {
    if (action === 'install-config') {
        await handleInstallConfig(url, name);
    } else {
        apiLogger.warn(`[DeepLink] Unknown action: ${action}`);
    }
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
        await subDownloadSlot();
        /** @type {{ name?: string } | null} */
        const saved = await invoke(COMMANDS.DOWNLOAD_SUB, { url, name: displayName });
        invalidateConfigsCache();
        showNotification(t.notifSubSuccess || 'Subscription added successfully', 'success');
        if (saved?.name && appStore.get('noSubscription')) {
            // Saved either way, so a failed switch is a warning, not a failed import.
            void activateIfFirst(saved.name).catch((switchErr) => {
                apiLogger.warn('[DeepLink] Activating the first subscription failed:', switchErr);
                showNotification(String(switchErr instanceof Error ? switchErr.message : switchErr), 'warning');
            });
        }
    } catch (err) {
        const message = err?.toString?.() || 'Unknown error';
        showNotification(`${t.notifSubFailed || 'Failed to download subscription'}: ${message}`, 'error');
    }
}
