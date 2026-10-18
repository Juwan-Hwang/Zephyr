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

// ── Input modality ─────────────────────────────────────────────────────────
// A dialog opened with the mouse should not greet the user with a heavy focus
// ring on its first button; one opened from the keyboard should. Track which
// input the user used last and focus quietly after a pointer interaction.

/** @type {'pointer'|'keyboard'} */
let lastModality = 'keyboard';
const QUIET_CLASS = 'focus-quiet';

if (typeof document !== 'undefined') {
    const toPointer = () => { lastModality = 'pointer'; };
    document.addEventListener('pointerdown', toPointer, true);
    document.addEventListener('mousedown', toPointer, true);
    document.addEventListener('keydown', (e) => {
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        lastModality = 'keyboard';
        // The user switched to the keyboard: show the ring again wherever focus is.
        document.querySelectorAll(`.${QUIET_CLASS}`).forEach((el) => el.classList.remove(QUIET_CLASS));
    }, true);
}

/** @returns {'pointer'|'keyboard'} Last input modality the user used. */
export function getInputModality() {
    return lastModality;
}

/**
 * Text fields always show where the caret is; every other control is focused
 * without the ring after a pointer interaction.
 * @param {HTMLElement} el
 */
function isTextEntry(el) {
    if (el instanceof HTMLTextAreaElement || el.isContentEditable) return true;
    if (!(el instanceof HTMLInputElement)) return false;
    return !['button', 'checkbox', 'radio', 'submit', 'reset', 'range', 'color', 'file', 'image'].includes(el.type);
}

/**
 * Focus an element; after a pointer interaction, non-text controls get no
 * focus ring (`:focus-visible` still applies as soon as a key is pressed).
 * @param {HTMLElement} el
 */
export function focusRespectingModality(el) {
    const quiet = lastModality === 'pointer' && !isTextEntry(el);
    if (quiet) el.classList.add(QUIET_CLASS);
    try {
        // focusVisible is honoured by Chromium / Firefox; the class covers the rest.
        el.focus(/** @type {FocusOptions} */ ({ focusVisible: !quiet }));
    } catch {
        el.focus();
    }
    if (!quiet) return;
    // Only an element that actually took focus will blur and drop the class.
    if (document.activeElement === el) el.addEventListener('blur', () => el.classList.remove(QUIET_CLASS), { once: true });
    else el.classList.remove(QUIET_CLASS);
}

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
        } else if (document.activeElement === last) {
            e.preventDefault();
            first.focus();
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
            requestAnimationFrame(() => focusRespectingModality(target));
        }
    }

    function deactivate() {
        if (!active) return;
        active = false;
        document.removeEventListener('keydown', onKeyDown, true);

        if (previousFocus && previousFocus.isConnected) {
            focusRespectingModality(previousFocus);
        }
        previousFocus = null;
    }

    function destroy() {
        deactivate();
    }

    return { activate, deactivate, destroy };
}
