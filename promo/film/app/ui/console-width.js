// @ts-check
/**
 * Breakpoint in pixels where the console dashboard transitions from single-column
 * to fully expanded multi-column layout. Must stay synchronized with the responsive
 * media query `@media (max-width: 1080px)` defined in `styles.css`.
 */
export const CONSOLE_EXPAND_BREAKPOINT = 1080;

import { showNotification } from './notifications.js';
import { t } from '../i18n.js';

/**
 * Checks whether the current window width is sufficient to fully expand the console dashboard layout.
 * Returns true if window width > 1080px (i.e. >= 1081px).
 *
 * @param {Window | null} [win]
 * @returns {boolean}
 */
export function isConsoleFullyExpanded(win) {
    let targetWin = win;
    if (targetWin === undefined && typeof window !== 'undefined') {
        targetWin = window;
    }
    if (!targetWin) return true;
    if (typeof targetWin.matchMedia === 'function') {
        return !targetWin.matchMedia(`(max-width: ${CONSOLE_EXPAND_BREAKPOINT}px)`).matches;
    }
    return typeof targetWin.innerWidth === 'number' ? targetWin.innerWidth > CONSOLE_EXPAND_BREAKPOINT : true;
}

/**
 * Checks window width when switching to the console page mode in Settings and shows
 * a notification if the viewport width is too narrow for the console dashboard to fully expand.
 *
 * @param {Window | null} [win]
 */
export function checkConsoleWidthNotification(win) {
    if (!isConsoleFullyExpanded(win)) {
        showNotification(t('consoleWidthTip'), 'info', null, { log: false });
    }
}
