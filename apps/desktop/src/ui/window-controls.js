// @ts-check
/**
 * Window control initialization (close button, icon fallbacks).
 * Extracted from ui.js.
 *
 * @module ui/window-controls
 */

import { getCurrentWindow, invoke, listen } from '../api.js';
import { registerCleanup } from '../utils/cleanup-registry.js';
import { uiLogger } from '../utils/logger.js';
import { getSettingsCached } from './cache.js';
import { sendOSNotification } from './os-notification.js';
import { t } from '../i18n.js';

const TRAY_HINT_KEY = 'zephyr.trayHintShown';

/** Longest the close button waits for the tray hint before closing anyway. */
const TRAY_HINT_WAIT_MS = 800;

/** In-flight hint attempt, shared so repeated close clicks send it at most once. */
/** @type {Promise<void> | null} */
let _trayHintPending = null;

/**
 * The first time the close button only hides the window (close-to-tray), say once,
 * via a system notification, that Zephyr keeps running in the tray.
 * @returns {Promise<void>}
 */
function maybeShowTrayHint() {
    if (_trayHintPending !== null) return _trayHintPending;
    _trayHintPending = (async () => {
        try {
            if (localStorage.getItem(TRAY_HINT_KEY)) return;
            const settings = await getSettingsCached();
            if (!settings?.close_to_tray) return;
            // Only remember the hint once the OS took it, so a failed send retries next close.
            if (await sendOSNotification('Zephyr', t('trayStillRunning'))) localStorage.setItem(TRAY_HINT_KEY, '1');
        } catch { /* non-critical */ }
    })().finally(() => {
        _trayHintPending = null;
    });
    return _trayHintPending;
}

/**
 * Initialize window control event listeners.
 * - Close button: closes the application window
 * - Core loading icon: falls back to app-lockup-dark.svg on error
 * - App title lockup: falls back to app-lockup.svg on error
 */
export function initWindowControls() {
    const closeBtn = document.getElementById('close-btn');
    if (closeBtn) {
        closeBtn.addEventListener('click', () => {
            // Lightweight mode destroys the WebView on close: give the hint a
            // moment to be sent and remembered, but never hold the close up for long.
            const hint = Promise.race([maybeShowTrayHint(), new Promise((r) => setTimeout(r, TRAY_HINT_WAIT_MS))]);
            // close() can throw synchronously when IPC is missing; the
            // .then wrapper turns that into a rejection too.
            hint
                .then(() => getCurrentWindow().close())
                .catch((err) => uiLogger.warn('Failed to close window', err));
        });
    }

    const coreLoadingIcon = document.getElementById('core-loading-icon');
    if (coreLoadingIcon) {
        /** @type {HTMLImageElement} */ (coreLoadingIcon).addEventListener('error', function() {
            /** @type {HTMLImageElement} */ (this).src = 'app-lockup-dark.svg';
        }, { once: true });
    }

    const appTitleIcon = document.getElementById('app-title-icon');
    if (appTitleIcon) {
        /** @type {HTMLImageElement} */ (appTitleIcon).addEventListener('error', function() {
            /** @type {HTMLImageElement} */ (this).src = 'app-lockup.svg';
        }, { once: true });
    }

    // Sync the is-maximized class on <html> so CSS can disable the
    // overlay clip-path rounding when the window is maximized.
    // Tauri's window-state plugin restores maximized state on startup,
    // so we check immediately and listen for future changes.
    let syncRevision = 0;
    let disposed = false;
    const syncMaximized = async () => {
        const revision = ++syncRevision;
        try {
            const isMaximized = await invoke('plugin:window|is_maximized', { label: getCurrentWindow().label });
            if (revision !== syncRevision || disposed) return; // stale or disposed
            document.documentElement.classList.toggle('is-maximized', !!isMaximized);
        } catch { /* non-Tauri environment */ }
    };
    /** @type {number|null} */
    let syncTimer = null;
    const scheduleSync = () => {
        if (disposed) return;
        if (syncTimer !== null) clearTimeout(syncTimer);
        syncTimer = setTimeout(() => { syncTimer = null; void syncMaximized(); }, 120);
    };
    // Register cleanup immediately so teardown during async listen still works.
    registerCleanup(() => {
        disposed = true;
        if (syncTimer !== null) clearTimeout(syncTimer);
    });
    // Register the listener first, then query initial state — this avoids
    // a gap where a maximize/restore event is missed between syncMaximized()
    // and listen() resolving.
    listen('tauri://resize', scheduleSync).then((unlisten) => {
        if (disposed) { Promise.resolve(unlisten()).catch(() => {}); return; }
        void syncMaximized();
        registerCleanup(() => { Promise.resolve(unlisten()).catch(() => {}); });
    }).catch(() => {
        // Non-Tauri environment or listener failed — still try initial sync.
        void syncMaximized();
    });
}
