// @ts-check
/**
 * Segmented controls (`.seg-control`): one sliding thumb (`.seg-thumb`) behind
 * a row of `.seg-btn` buttons. Theme, UI scale and home-page mode all use this,
 * so they share one look (styles.css) and one selection path (here).
 *
 * @module ui/seg-control
 */

/**
 * Move the thumb to `index` and mark that button pressed. An index outside the
 * buttons hides the thumb and leaves nothing pressed.
 * @param {Element | null} container - The `.seg-control` element.
 * @param {number} index - Zero-based button index.
 */
export function selectSegment(container, index) {
    if (!container) return;
    const buttons = Array.from(container.querySelectorAll('.seg-btn'));
    const valid = Number.isInteger(index) && index >= 0 && index < buttons.length;
    buttons.forEach((btn, i) => btn.setAttribute('aria-pressed', String(valid && i === index)));
    const thumb = /** @type {HTMLElement | null} */ (container.querySelector('.seg-thumb'));
    if (!thumb) return;
    thumb.classList.toggle('is-hidden', !valid);
    if (valid) thumb.style.transform = index === 0 ? '' : `translateX(calc(var(--rtl-sign, 1) * ${index * 100}%))`;
}
