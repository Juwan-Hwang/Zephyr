// @ts-check
/**
 * Window control initialization (close button, icon fallbacks).
 * Extracted from ui.js.
 *
 * @module ui/window-controls
 */

import { getCurrentWindow, invoke, listen } from '../api.js';
import { COMMANDS } from '@zephyr/shared';
import { appStore } from './state.js';
import { registerCleanup } from '../utils/cleanup-registry.js';
import { uiLogger } from '../utils/logger.js';

/** How long the page stays marked busy after the network lock is released. */
export const PAGE_IDLE_GRACE_MS = 600;

/**
 * Initialize window control event listeners.
 * - Close button: closes the application window
 * - Core loading icon: falls back to app-icon.png on error
 * - App title lockup: falls back to app-icon.png on error
 */
export function initWindowControls() {
    const closeBtn = document.getElementById('close-btn');
    if (closeBtn) {
        closeBtn.addEventListener('click', () => {
            // close() can throw synchronously when IPC is missing; the
            // Promise wrapper turns that into a rejection too.
            Promise.resolve()
                .then(() => getCurrentWindow().close())
                .catch((err) => uiLogger.warn('Failed to close window', err));
        });
    }

    // While the page holds the network lock (a subscription switch, a TUN
    // toggle, recovery after a restart), a lightweight-mode close must only
    // hide it: destroying the page would drop the rest of that work.
    // A fresh page starts idle, which also clears a mark a destroyed one left.
    const sendBusy = (/** @type {boolean} */ busy) => {
        Promise.resolve()
            .then(() => invoke(COMMANDS.SET_PAGE_BUSY, { busy }))
            .catch(() => { /* older backend or non-Tauri: lightweight close as before */ });
    };
    // Going idle is reported a little late: work queued behind the lock
    // (acquireNetworkLock polls every 200 ms) takes it on its next poll, and
    // a close in that gap would drop it.
    /** @type {ReturnType<typeof setTimeout> | null} */
    let idleTimer = null;
    const reportBusy = (/** @type {boolean} */ busy) => {
        if (idleTimer !== null) {
            clearTimeout(idleTimer);
            idleTimer = null;
        }
        if (busy) {
            sendBusy(true);
            return;
        }
        idleTimer = setTimeout(() => {
            idleTimer = null;
            if (!appStore.get('isNetworkUpdating')) sendBusy(false);
        }, PAGE_IDLE_GRACE_MS);
    };
    sendBusy(!!appStore.get('isNetworkUpdating'));
    registerCleanup(/** @type {() => void} */ (appStore.subscribe('isNetworkUpdating', (/** @type {unknown} */ v) => reportBusy(!!v))));
    registerCleanup(() => { if (idleTimer !== null) clearTimeout(idleTimer); });

    const coreLoadingIcon = document.getElementById('core-loading-icon');
    if (coreLoadingIcon) {
        /** @type {HTMLImageElement} */ (coreLoadingIcon).addEventListener('error', function() {
            /** @type {HTMLImageElement} */ (this).src = 'app-icon.png';
        }, { once: true });
    }

    const appTitleIcon = document.getElementById('app-title-icon');
    if (appTitleIcon) {
        /** @type {HTMLImageElement} */ (appTitleIcon).addEventListener('error', function() {
            /** @type {HTMLImageElement} */ (this).src = 'app-icon.png';
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
