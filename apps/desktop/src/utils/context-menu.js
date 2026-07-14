// @ts-check
import { escapeHtml, sanitizeHtml } from './sanitize.js';
/**
 * Shared context menu utility.
 *
 * Provides a unified API for showing floating context menus at the
 * mouse cursor position. Supports plain-text items, custom HTML items,
 * separators, and viewport overflow correction.
 *
 * @module utils/context-menu
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** CSS class used to identify context menu root elements for cleanup. */
const ROOT_CLASS = 'ctx-menu-root';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Remove all open context menus from the DOM.
 */
export function removeContextMenu() {
    document.querySelectorAll(`.${ROOT_CLASS}`).forEach((el) => el.remove());
}

/**
 * Create a context menu container element positioned at the mouse event.
 * The caller is responsible for populating the container and calling
 * {@link attachContextMenuCloseHandlers} when ready.
 *
 * @param {MouseEvent} e - The right-click event
 * @returns {{ menu: HTMLElement, scroll: HTMLElement }} The menu container and inner scroll element (not yet in the DOM)
 */
export function createContextMenuContainer(e) {
    e.preventDefault();
    removeContextMenu();

    // body has transform: scale(var(--ui-scale)), which makes fixed positioning
    // relative to the body instead of the viewport. clientX/clientY are visual
    // (scaled) coordinates — divide by ui-scale to get body-space coordinates.
    const uiScale = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ui-scale')) || 1;

    const menu = document.createElement('div');
    menu.className = `${ROOT_CLASS} fixed z-[9999] min-w-[180px] max-w-[320px] max-h-[60vh] overflow-hidden shadow-xl border border-[var(--zephyr-border-default)] rounded-[var(--zephyr-radius-surface)] glass-card`;
    menu.style.left = `${e.clientX / uiScale}px`;
    menu.style.top = `${e.clientY / uiScale}px`;

    // Inner scroll wrapper so scrollbar is clipped by outer border-radius
    const scroll = document.createElement('div');
    scroll.className = 'menu-scroll max-h-[60vh] py-1';
    menu.appendChild(scroll);

    return { menu, scroll };
}

/**
 * Attach viewport overflow correction and close handlers to a menu container.
 * Call this after populating the container and appending it to the DOM.
 *
 * @param {HTMLElement} menu - The menu container element
 */
export function attachContextMenuCloseHandlers(menu) {
    // Viewport overflow correction
    requestAnimationFrame(() => {
        const uiScale = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ui-scale')) || 1;
        const rect = menu.getBoundingClientRect();
        if (rect.right > window.innerWidth) {
            menu.style.left = `${(window.innerWidth - rect.width - 8) / uiScale}px`;
        }
        if (rect.bottom > window.innerHeight) {
            menu.style.top = `${(window.innerHeight - rect.height - 8) / uiScale}px`;
        }
    });

    // Close handlers — use non-once listeners that auto-cleanup when menu is removed
    /** @param {MouseEvent} [ev] */
    const close = (ev) => {
        // Don't close if the click originated inside the menu
        // (e.g. checkbox toggle, which handles its own close via stopPropagation)
        if (ev && menu.contains(/** @type {Node} */(ev.target))) return;
        removeContextMenu();
    };

    /** @param {MouseEvent} ev */
    const onClick = (ev) => close(ev);
    /** @param {MouseEvent} ev */
    const onContext = (ev) => close(ev);
    /** @param {KeyboardEvent} ev */
    const onKey = (ev) => { if (ev.key === 'Escape') close(); };

    document.addEventListener('click', onClick);
    document.addEventListener('contextmenu', onContext);
    document.addEventListener('keydown', onKey);

    // Auto-cleanup listeners when menu is removed from DOM
    const observer = new MutationObserver(() => {
        if (!document.body.contains(menu)) {
            document.removeEventListener('click', onClick);
            document.removeEventListener('contextmenu', onContext);
            document.removeEventListener('keydown', onKey);
            observer.disconnect();
        }
    });
    observer.observe(document.body, { childList: true });
}

/**
 * Show a floating context menu at the mouse position.
 *
 * @param {MouseEvent} e - The right-click event
 * @param {Array<{label?: string, html?: string, icon?: string, action?: () => void, separator?: boolean, className?: string}>} items
 */
export function showContextMenu(e, items) {
    const { menu, scroll } = createContextMenuContainer(e);

    items.forEach((item) => {
        // Separator
        if (item.separator) {
            const sep = document.createElement('div');
            sep.className = 'my-1 border-t border-[var(--zephyr-border-default)]';
            scroll.appendChild(sep);
            return;
        }

        // SECURITY: sanitize HTML to prevent XSS while preserving allowed tags
        // Custom HTML item (for complex widgets like checkboxes)
        if (item.html) {
            const wrapper = document.createElement('div');
            wrapper.className = item.className || '';
            wrapper.innerHTML = sanitizeHtml(item.html);
            if (item.action) {
                wrapper.addEventListener('click', (ev) => {
                    ev.stopPropagation();
                    removeContextMenu();
                    item.action?.();
                });
            }
            scroll.appendChild(wrapper);
            return;
        }

        // Standard button item
        const btn = document.createElement('button');
        btn.className = 'w-full flex items-center gap-2 px-3 py-2 text-sm text-[var(--text-secondary)] hover:bg-[var(--zephyr-bg-muted)] hover:text-[var(--text-primary)] transition-colors text-left';
        const iconHtml = item.icon ? '<span class="w-4 shrink-0">' + sanitizeHtml(item.icon) + '</span>' : '';
        // eslint-disable-next-line no-unsanitized/property -- label escaped, icon sanitized
        btn.innerHTML = iconHtml + '<span>' + escapeHtml(item.label || '') + '</span>';
        btn.addEventListener('click', (ev) => {
            ev.stopPropagation();
            removeContextMenu();
            item.action?.();
        });
        scroll.appendChild(btn);
    });

    document.body.appendChild(menu);
    attachContextMenuCloseHandlers(menu);
}
