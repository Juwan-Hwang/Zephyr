// @ts-check
/**
 * Focus rings are for keyboard users only. Text fields match :focus-visible even when
 * clicked, so CSS alone can't tell a mouse user from a keyboard user; this marks the
 * document with `kb-nav` while the user is moving focus with the keyboard and clears
 * it on any pointer press. styles.css shows field focus rings only under `html.kb-nav`.
 * @module ui/input-modality
 */

const NAV_KEYS = new Set(['Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'F6', 'Escape']);

/**
 * Enter / Space on a control (not while typing in a field) is keyboard use too:
 * it may open a dialog that focuses a field, which must then show its ring.
 * @param {KeyboardEvent} e
 */
function isActivationKey(e) {
    if (e.key !== 'Enter' && e.key !== ' ') return false;
    const el = /** @type {HTMLElement|null} */ (e.target instanceof HTMLElement ? e.target : null);
    if (!el) return false;
    return !el.isContentEditable && !el.matches('input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=button]):not([type=submit]), textarea, select');
}

/** @param {Document} [doc] */
export function initInputModality(doc = document) {
    const root = doc.documentElement;
    doc.addEventListener('keydown', (e) => {
        if ((NAV_KEYS.has(e.key) || isActivationKey(e)) && !e.metaKey && !e.ctrlKey && !e.altKey) root.classList.add('kb-nav');
    }, true);
    doc.addEventListener('pointerdown', () => root.classList.remove('kb-nav'), true);
}
