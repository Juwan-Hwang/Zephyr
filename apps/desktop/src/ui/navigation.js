// @ts-check
/**
 * Navigation logic - page switching and sidebar initialization.
 * Extracted from ui.js lines ~81-86, ~594-630.
 *
 * @module ui/navigation
 */

import { setup3DEffect } from './3d-effect.js';

/**
 * Switch the visible page by pageId.
 * Direct hidden toggle — no opacity transition to prevent flicker.
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
 */
export function initNavigation(callbacks = {}) {
    const navItems = document.querySelectorAll('[data-nav]');

    // Apply 3D effect to sidebar icons
    setup3DEffect(navItems);

    /** @type {string|null} Track the current page for leave callbacks */
    let currentPage = null;

    navItems.forEach(item => {
        item.addEventListener('click', () => {
            const targetPage = item.getAttribute('data-nav');

            // Fire leave callback for the previous page
            if (currentPage === 'logs' && targetPage !== 'logs' && callbacks.onLeaveLogs) {
                callbacks.onLeaveLogs();
            }
            if (currentPage === 'proxies' && targetPage !== 'proxies' && callbacks.onLeaveProxies) {
                callbacks.onLeaveProxies();
            }

            // Update nav item active styling
            navItems.forEach(i => {
                i.classList.remove('bg-white/10', 'text-white', 'shadow-lg', 'ring-1', 'ring-white/20');
                i.classList.add('text-zinc-500');
                i.removeAttribute('aria-current');
            });
            item.classList.add('bg-white/10', 'text-white', 'shadow-lg', 'ring-1', 'ring-white/20');
            item.classList.remove('text-zinc-500');
            item.setAttribute('aria-current', 'page');

            // Switch page
            if (targetPage) switchPage(targetPage);
            currentPage = targetPage;

            // Trigger page-specific callbacks
            if (targetPage === 'proxies' && callbacks.onProxies) {
                callbacks.onProxies();
            } else if (targetPage === 'advanced' && callbacks.onAdvanced) {
                callbacks.onAdvanced();
            } else if (targetPage === 'home' && callbacks.onHome) {
                callbacks.onHome();
            } else if (targetPage === 'rule-library' && callbacks.onRuleLibrary) {
                callbacks.onRuleLibrary();
            } else if (targetPage === 'connections' && callbacks.onConnections) {
                callbacks.onConnections();
            } else if (targetPage === 'logs' && callbacks.onLogs) {
                callbacks.onLogs();
            }
        });
    });
}
