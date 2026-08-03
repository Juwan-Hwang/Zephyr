// @ts-check
/**
 * Navigation logic - page switching and sidebar initialization.
 * Extracted from ui.js lines ~81-86, ~594-630.
 *
 * @module ui/navigation
 */

import { setup3DEffect } from './3d-effect.js';
import { appStore } from './state.js';

/**
 * Switch the visible page by pageId.
 * Direct hidden toggle - no opacity transition to prevent flicker.
 * Also toggles the shared background glow layer.
 *
 * @param {string} pageId - The data-page attribute value of the target page
 */
export function switchPage(pageId) {
    const pages = document.querySelectorAll('[data-page]');
    pages.forEach(p => {
        if (p.getAttribute('data-page') === pageId) {
            p.classList.remove('hidden');
        } else {
            p.classList.add('hidden');
        }
    });

    // Toggle shared background glow for the active page
    document.querySelectorAll('[id^="glow-"]').forEach(g => {
        g.classList.toggle('hidden', g.id !== `glow-${pageId}`);
    });
}

/** Store leave-timeout IDs without polluting DOM element types. */
const leaveTimeouts = new WeakMap();

/** @type {((page: string) => void) | null} Reference set by initNavigation for programmatic use. */
let _navigateToRef = null;

/**
 * Programmatic navigation that fires leave/enter callbacks and updates
 * internal currentPage state, just like a sidebar click.
 * Must be called after initNavigation().
 *
 * @param {string} pageId - The target page (e.g. 'home', 'console', 'proxies')
 */
export function navigateTo(pageId) {
    if (_navigateToRef) {
        _navigateToRef(pageId);
    } else {
        // Fallback: just switch the page without callbacks
        switchPage(pageId);
    }
}

/**
 * Initialize sidebar navigation.
 * Sets up click handlers on [data-nav] items and applies 3D hover effects.
 * When a nav item is clicked, it updates active styling and switches pages.
 * Page-specific initialization callbacks are triggered on navigation.
 * Page-specific destroy callbacks are triggered when leaving a page.
 *
 * @param {Object} [callbacks] - Optional page-specific init/destroy callbacks
 * @param {Function} [callbacks.onProxies] - Called when navigating to proxies page
 * @param {Function} [callbacks.onAdvanced] - Called when navigating to advanced page
 * @param {Function} [callbacks.onHome] - Called when navigating to home page
 * @param {Function} [callbacks.onConnections] - Called when navigating to connections page
 * @param {Function} [callbacks.onRules] - Called when navigating to rules page
 * @param {Function} [callbacks.onRuleLibrary] - Called when navigating to rule-library page
 * @param {Function} [callbacks.onLogs] - Called when navigating to logs page
 * @param {Function} [callbacks.onLeaveLogs] - Called when navigating away from logs page
 * @param {Function} [callbacks.onLeaveProxies] - Called when navigating away from proxies page
 * @param {Function} [callbacks.onConsole] - Called when navigating to console page
 * @param {Function} [callbacks.onLeaveConsole] - Called when navigating away from console page
 */
export function initNavigation(callbacks = {}) {
    const navItems = document.querySelectorAll('[data-nav]');

    // Apply 3D effect to sidebar icons
    setup3DEffect(navItems);

    /** @type {string|null} Track the current page for leave callbacks */
    // Detect which page is initially visible (main.js may have already switched to console)
    let currentPage = null;
    const initialVisible = document.querySelector('[data-page]:not(.hidden)');
    if (initialVisible) {
        const initialPage = /** @type {HTMLElement} */ (initialVisible).dataset.page ?? null;
        // If console mode redirected home to console, treat it as 'console' not 'home'
        currentPage = (initialPage === 'home' && appStore.get('homePageMode') === 'console')
            ? 'console'
            : initialPage;
    }

    /**
     * Internal navigation function shared by click handler and navigateTo().
     * @param {string} targetPage
     */
    function navigateToInternal(targetPage) {
        // Fire leave callback for the previous page
        if (currentPage === 'logs' && targetPage !== 'logs' && callbacks.onLeaveLogs) {
            callbacks.onLeaveLogs();
        }
        if (currentPage === 'proxies' && targetPage !== 'proxies' && callbacks.onLeaveProxies) {
            callbacks.onLeaveProxies();
        }
        if (currentPage === 'console' && targetPage !== 'console' && callbacks.onLeaveConsole) {
            callbacks.onLeaveConsole();
        }

        // Update nav item active styling
        // When target is 'console', the sidebar item is 'home' (console reuses home slot)
        const navSelector = targetPage === 'console' ? '[data-nav="home"]' : `[data-nav="${targetPage}"]`;
        const targetNav = document.querySelector(navSelector);
        const oldActive = document.querySelector('.nav-btn.is-active');
        if (oldActive && oldActive !== targetNav) {
            oldActive.classList.add('is-leaving');
            oldActive.classList.remove('is-active');
            const prevTimer = leaveTimeouts.get(oldActive);
            if (prevTimer) clearTimeout(prevTimer);
            const timer = setTimeout(() => {
                oldActive.classList.remove('is-leaving');
                leaveTimeouts.delete(oldActive);
            }, 500);
            leaveTimeouts.set(oldActive, timer);
        }
        if (targetNav) {
            const itemTimer = leaveTimeouts.get(targetNav);
            if (itemTimer) {
                clearTimeout(itemTimer);
                leaveTimeouts.delete(targetNav);
            }
            navItems.forEach(i => {
                i.classList.remove('is-active', 'bg-[var(--zephyr-bg-muted)]', 'text-[var(--text-primary)]', 'shadow-lg', 'ring-1', 'ring-[var(--zephyr-border-strong)]');
                i.classList.add('text-[var(--text-muted)]');
                i.removeAttribute('aria-current');
            });
            targetNav.classList.add('is-active', 'bg-[var(--zephyr-bg-muted)]', 'text-[var(--text-primary)]', 'shadow-lg', 'ring-1', 'ring-[var(--zephyr-border-strong)]');
            targetNav.classList.remove('text-[var(--text-muted)]', 'is-leaving');
            targetNav.setAttribute('aria-current', 'page');
        }

        // Switch page
        switchPage(targetPage);
        currentPage = targetPage;

        // Trigger page-specific callbacks
        if (targetPage === 'proxies' && callbacks.onProxies) {
            callbacks.onProxies();
        } else if (targetPage === 'advanced' && callbacks.onAdvanced) {
            callbacks.onAdvanced();
        } else if (targetPage === 'home' && callbacks.onHome) {
            callbacks.onHome();
        } else if (targetPage === 'console' && callbacks.onConsole) {
            callbacks.onConsole();
        } else if (targetPage === 'rule-library' && callbacks.onRuleLibrary) {
            callbacks.onRuleLibrary();
        } else if (targetPage === 'connections' && callbacks.onConnections) {
            callbacks.onConnections();
        } else if (targetPage === 'logs' && callbacks.onLogs) {
            callbacks.onLogs();
        }
    }

    // Expose for programmatic navigation (e.g. HOME_PAGE_MODE_CHANGED handler)
    _navigateToRef = navigateToInternal;

    navItems.forEach(item => {
        item.addEventListener('click', () => {
            let targetPage = /** @type {HTMLElement} */ (item).dataset.nav ?? null;

            // Redirect 'home' to 'console' when console mode is enabled
            if (targetPage === 'home' && appStore.get('homePageMode') === 'console') {
                targetPage = 'console';
            }

            if (targetPage) navigateToInternal(targetPage);
        });
    });
}
