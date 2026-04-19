// @ts-check
/**
 * Focus trap — confines Tab / Shift+Tab focus within a container.
 *
 * Usage:
 *   const trap = createFocusTrap(container, { onEscape: () => closeModal() });
 *   trap.activate();
 *   // ... later:
 *   trap.destroy();
 *
 * @module utils/focus-trap
 */

/** Selector for all focusable elements inside a container. */
const FOCUSABLE =
    'a[href], button:not([disabled]), input:not([disabled]), ' +
    'select:not([disabled]), textarea:not([disabled]), ' +
    '[tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

/**
 * @typedef {Object} FocusTrapHandle
 * @property {() => void} activate  Start trapping focus.
 * @property {() => void} deactivate Stop trapping and restore previous focus.
 * @property {() => void} destroy    Deactivate + remove all listeners.
 */

/**
 * Create a focus trap on the given container.
 *
 * @param {HTMLElement} container
 * @param {Object} [options]
 * @param {() => void} [options.onEscape] Called when Escape is pressed.
 * @param {HTMLElement} [options.initialFocus] Element to focus on activate (default: first focusable).
 * @returns {FocusTrapHandle}
 */
export function createFocusTrap(container, options = {}) {
    let active = false;
    let previousFocus = /** @type {HTMLElement|null} */ (document.activeElement);

    /** @param {KeyboardEvent} e */
    function onKeyDown(e) {
        if (!active) return;

        if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            options.onEscape?.();
            return;
        }

        if (e.key !== 'Tab') return;

        const focusable = getFocusableElements();
        if (focusable.length === 0) {
            e.preventDefault();
            return;
        }

        const first = focusable[0];
        const last = focusable[focusable.length - 1];

        if (e.shiftKey) {
            if (document.activeElement === first) {
                e.preventDefault();
                last.focus();
            }
        } else {
            if (document.activeElement === last) {
                e.preventDefault();
                first.focus();
            }
        }
    }

    /**
     * @returns {HTMLElement[]}
     */
    function getFocusableElements() {
        const elements = /** @type {HTMLElement[]} */ (Array.from(container.querySelectorAll(FOCUSABLE)));
        return elements.filter((el) => {
            if (el.offsetParent === null && el.style.position !== 'fixed') return false;
            if (el.getAttribute('tabindex') === '-1') return false;
            return true;
        });
    }

    function activate() {
        if (active) return;
        active = true;
        previousFocus = /** @type {HTMLElement|null} */ (document.activeElement);
        document.addEventListener('keydown', onKeyDown, true);

        const target = options.initialFocus || getFocusableElements()[0];
        if (target instanceof HTMLElement) {
            requestAnimationFrame(() => target.focus());
        }
    }

    function deactivate() {
        if (!active) return;
        active = false;
        document.removeEventListener('keydown', onKeyDown, true);

        if (previousFocus && previousFocus.isConnected) {
            previousFocus.focus();
        }
        previousFocus = null;
    }

    function destroy() {
        deactivate();
    }

    return { activate, deactivate, destroy };
}
