// @ts-check
/**
 * Window control initialization (close button, icon fallbacks).
 * Extracted from ui.js.
 *
 * @module ui/window-controls
 */

import { getCurrentWindow, invoke, listen } from '../api.js';
import { registerCleanup } from '../utils/cleanup-registry.js';

/**
 * Initialize window control event listeners.
 * - Close button: closes the application window
 * - Core loading icon: falls back to dark-icon.png on error
 * - App title icon: falls back to app-icon.png on error
 */
export function initWindowControls() {
    const closeBtn = document.getElementById('close-btn');
    if (closeBtn) {
        closeBtn.addEventListener('click', () => {
            getCurrentWindow().close();
        });
    }

    const coreLoadingIcon = document.getElementById('core-loading-icon');
    if (coreLoadingIcon) {
        /** @type {HTMLImageElement} */ (coreLoadingIcon).addEventListener('error', function() {
            /** @type {HTMLImageElement} */ (this).src = 'dark-icon.png';
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
    const syncMaximized = async () => {
        const revision = ++syncRevision;
        try {
            const isMaximized = await invoke('plugin:window|is_maximized', { label: getCurrentWindow().label });
            if (revision !== syncRevision) return; // stale response
            document.documentElement.classList.toggle('is-maximized', !!isMaximized);
        } catch { /* non-Tauri environment */ }
    };
    // Listen for Tauri resize events (fires on maximize/unmaximize/restore and
    // repeatedly during a drag-resize, so coalesce bursts into one check).
    /** @type {number|null} */
    let disposed = false;
    let syncTimer = null;
    const scheduleSync = () => {
        if (disposed) return;
        if (syncTimer !== null) clearTimeout(syncTimer);
        syncTimer = setTimeout(() => { syncTimer = null; syncMaximized(); }, 120);
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
        syncMaximized();
        registerCleanup(() => { Promise.resolve(unlisten()).catch(() => {}); });
    }).catch(() => {
        // Non-Tauri environment or listener failed — still try initial sync.
        syncMaximized();
    });
}
