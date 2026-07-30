// @ts-check
/**
 * Window control initialization (close button, icon fallbacks).
 * Extracted from ui.js.
 *
 * @module ui/window-controls
 */

import { getCurrentWindow, invoke, listen } from '../api.js';

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
    const syncMaximized = async () => {
        try {
            const isMaximized = await invoke('plugin:window|is_maximized', { label: getCurrentWindow().label });
            document.documentElement.classList.toggle('is-maximized', !!isMaximized);
        } catch { /* non-Tauri environment */ }
    };
    syncMaximized();
    // Listen for Tauri resize events (fires on maximize/unmaximize/restore)
    listen('tauri://resize', () => syncMaximized()).catch(() => {});
}
