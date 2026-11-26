// @ts-check
import { escapeHtml, sanitizeHtml } from './sanitize.js';
import { getDirection } from '../i18n.js';
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
/** Explicit anchors for synthetic menu events (a More button need not have focus). */
/** @type {WeakMap<MouseEvent, HTMLElement>} */
const menuAnchors = new WeakMap();

/** @param {MouseEvent} event @param {HTMLElement} trigger */
export function markContextMenuAnchor(event, trigger) {
    menuAnchors.set(event, trigger);
}

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
    menu.className = `${ROOT_CLASS} fixed z-[9999] min-w-[180px] max-w-[320px] max-h-[60vh] overflow-hidden shadow-xl border border-[var(--zephyr-border-default)] rounded-lg glass-card`;
    // In RTL, insetInlineStart maps to physical right, so mirror clientX
    // to keep the menu anchored at the cursor position.
    const isRTL = getDirection() === 'rtl';
    const inlineStartX = (isRTL ? window.innerWidth - e.clientX : e.clientX) / uiScale;
    menu.style.insetInlineStart = `${inlineStartX}px`;
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
 * @param {HTMLElement | null} [keyboardAnchor] focus return point for a keyboard-opened menu
 */
export function attachContextMenuCloseHandlers(menu, keyboardAnchor = null) {
    // Viewport overflow correction
    requestAnimationFrame(() => {
        const uiScale = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ui-scale')) || 1;
        const rect = menu.getBoundingClientRect();
        const isRTL = getDirection() === 'rtl';
        if (isRTL ? rect.left < 0 : rect.right > window.innerWidth) {
            menu.style.insetInlineStart = 'auto';
            menu.style.insetInlineEnd = `${8 / uiScale}px`;
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
        const focused = document.activeElement;
        const restore = !!keyboardAnchor && (!focused || focused === document.body || menu.contains(focused));
        removeContextMenu();
        if (restore && keyboardAnchor?.isConnected) keyboardAnchor.focus({ preventScroll: true });
    };

    /** @param {MouseEvent} ev */
    const onClick = (ev) => close(ev);
    /** @param {MouseEvent} ev */
    const onContext = (ev) => close(ev);
    /** @param {KeyboardEvent} ev */
    const onKey = (ev) => {
        if (ev.key !== 'Escape') return;
        ev.preventDefault();
        ev.stopPropagation();
        close();
        if (keyboardAnchor?.isConnected) keyboardAnchor.focus({ preventScroll: true });
    };

    document.addEventListener('click', onClick);
    document.addEventListener('contextmenu', onContext);
    document.addEventListener('keydown', onKey, true);

    // Auto-cleanup listeners when menu is removed from DOM
    const observer = new MutationObserver(() => {
        if (!document.body.contains(menu)) {
            document.removeEventListener('click', onClick);
            document.removeEventListener('contextmenu', onContext);
            document.removeEventListener('keydown', onKey, true);
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
    // Native right clicks use button 2; keyboard context-menu events use button 0.
    const touch = 'pointerType' in e && e.pointerType === 'touch';
    const keyboardAnchor = menuAnchors.get(e) || (e.button === 0 && !e.ctrlKey && !touch && document.activeElement instanceof HTMLElement
        ? document.activeElement : null);
    const { menu, scroll } = createContextMenuContainer(e);
    const restoreKeyboardFocus = () => {
        if (keyboardAnchor?.isConnected) keyboardAnchor.focus({ preventScroll: true });
    };
    if (keyboardAnchor) {
        const scale = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ui-scale')) || 1;
        const rect = keyboardAnchor.getBoundingClientRect();
        const start = getDirection() === 'rtl' ? window.innerWidth - rect.right : rect.left;
        menu.style.insetInlineStart = `${start / scale}px`;
        menu.style.top = `${rect.bottom / scale}px`;
    }

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
            // With an action it is a button, so the keyboard can reach and press it.
            const wrapper = document.createElement(item.action ? 'button' : 'div');
            if (wrapper instanceof HTMLButtonElement) wrapper.type = 'button';
            wrapper.className = item.className || '';
            wrapper.innerHTML = sanitizeHtml(item.html); // nosemgrep: js-innerhtml-assignment — dynamic content escaped
            if (item.action) {
                wrapper.addEventListener('click', (ev) => {
                    ev.stopPropagation();
                    removeContextMenu();
                    restoreKeyboardFocus();
                    item.action?.();
                });
            }
            scroll.appendChild(wrapper);
            return;
        }

        // Standard button item
        const btn = document.createElement('button');
        btn.className = 'w-full flex items-center gap-2 px-3 py-2 text-sm text-[var(--text-secondary)] hover:bg-[var(--zephyr-bg-muted)] hover:text-[var(--text-primary)] transition-colors text-start';
        const iconHtml = item.icon ? '<span class="w-4 shrink-0">' + sanitizeHtml(item.icon) + '</span>' : '';
        // eslint-disable-next-line no-unsanitized/property -- label escaped, icon sanitized
        btn.innerHTML = iconHtml + '<span>' + escapeHtml(item.label || '') + '</span>'; // nosemgrep: js-innerhtml-assignment — verified safe, see eslint-disable above
        btn.addEventListener('click', (ev) => {
            ev.stopPropagation();
            removeContextMenu();
            restoreKeyboardFocus();
            item.action?.();
        });
        scroll.appendChild(btn);
    });

    document.body.appendChild(menu);
    attachContextMenuCloseHandlers(menu, keyboardAnchor);
    if (keyboardAnchor) menu.querySelector('button')?.focus({ preventScroll: true });
}
