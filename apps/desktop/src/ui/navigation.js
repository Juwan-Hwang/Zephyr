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

/** @type {Record<string, string>} Map page id to callback name. */
const PAGE_CALLBACK_MAP = {
    'proxies': 'onProxies',
    'advanced': 'onAdvanced',
    'home': 'onHome',
    'console': 'onConsole',
    'rule-library': 'onRuleLibrary',
    'connections': 'onConnections',
    'logs': 'onLogs',
};

/** @type {Record<string, string>} Map page id to leave-callback name. */
const PAGE_LEAVE_MAP = {
    'logs': 'onLeaveLogs',
    'proxies': 'onLeaveProxies',
    'console': 'onLeaveConsole',
};

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
     * Update nav-item active/leaving styling for the target page.
     * @param {string} targetPage
     */
    function updateNavStyling(targetPage) {
        // When target is 'console', the sidebar item is 'home' (console reuses home slot)
        const navSelector = targetPage === 'console' ? '[data-nav="home"]' : `[data-nav="${targetPage}"]`;
        const targetNav = document.querySelector(navSelector);
        // Pages without a sidebar item (e.g. 'advanced') keep the current
        // active item highlighted instead of clearing the whole sidebar.
        if (!targetNav) return;
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

    /**
     * Fire leave callback for the previous page if leaving.
     * @param {string} targetPage
     */
    function fireLeaveCallback(targetPage) {
        const leaveKey = PAGE_LEAVE_MAP[currentPage ?? ''];
        if (leaveKey && targetPage !== currentPage) {
            const fn = /** @type {(() => void) | undefined} */ (/** @type {Record<string, unknown>} */ (callbacks)[leaveKey]);
            if (fn) fn();
        }
    }

    /**
     * Fire enter callback for the target page.
     * @param {string} targetPage
     */
    function fireEnterCallback(targetPage) {
        const enterKey = PAGE_CALLBACK_MAP[targetPage];
        if (enterKey) {
            const fn = /** @type {(() => void) | undefined} */ (/** @type {Record<string, unknown>} */ (callbacks)[enterKey]);
            if (fn) fn();
        }
    }

    /**
     * Internal navigation function shared by click handler and navigateTo().
     * @param {string} targetPage
     */
    function navigateToInternal(targetPage) {
        // Normalize 'home' to 'console' when console mode is enabled, so
        // programmatic navigation follows the same redirect rule as sidebar clicks.
        const normalizedPage = (targetPage === 'home' && appStore.get('homePageMode') === 'console')
            ? 'console'
            : targetPage;

        // Short-circuit: no-op when navigating to the already-current page
        if (normalizedPage === currentPage) return;

        // Guard: no-op if the target page element doesn't exist
        const pageEl = document.querySelector(`[data-page="${normalizedPage}"]`);
        if (!pageEl) return;

        fireLeaveCallback(normalizedPage);
        updateNavStyling(normalizedPage);
        switchPage(normalizedPage);
        currentPage = normalizedPage;
        fireEnterCallback(normalizedPage);
    }

    // Expose for programmatic navigation (e.g. HOME_PAGE_MODE_CHANGED handler)
    _navigateToRef = navigateToInternal;

    navItems.forEach(item => {
        item.addEventListener('click', () => {
            // navigateToInternal() applies the home → console redirect.
            const targetPage = /** @type {HTMLElement} */ (item).dataset.nav ?? null;
            if (targetPage) navigateToInternal(targetPage);
        });
    });
}
