// @ts-check
/**
 * Status Ring — compact circular progress indicator.
 *
 * Replaces an update button during in-progress operations.
 * States: idle → progress(percent) / indeterminate(spin) → success / error
 * After a terminal state, auto-reverts to the original button.
 *
 * Design: solid stroke on terminal states (no gradient) to avoid the
 * "AI gradient" look.  Gradient is reserved for in-progress states only.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

// Ring geometry (40 × 40 viewBox)
const RADIUS = 16;
const CIRC = 2 * Math.PI * RADIUS; // ≈ 100.53

// Terminal-state colors (solid, no gradient — refined, not garish)
const COLOR_SUCCESS = '#3ecf8e';
const COLOR_ERROR = '#ec6b5e';

// Unique gradient ID counter
let _gradSeq = 0;

/**
 * Create a compact status ring that replaces a button element.
 *
 * @param {HTMLElement} buttonEl — The button to visually replace.
 * @param {{ revertDelay?: number }} [opts]
 * @returns {{
 *   show: () => void,
 *   hide: () => void,
 *   setProgress: (percent: number) => void,
 *   setIndeterminate: () => void,
 *   setSuccess: () => void,
 *   setError: () => void,
 *   destroy: () => void,
 * }}
 */
export function createStatusRing(buttonEl, opts = {}) {
    // Defensive: return a no-op stub if the button is missing or detached
    // from the DOM.  This prevents TypeError crashes in callers that pass
    // a possibly-null element reference.
    const parent = buttonEl?.parentNode;
    if (!parent) {
        const noop = () => {};
        return { show: noop, hide: noop, setProgress: noop, setIndeterminate: noop, setSuccess: noop, setError: noop, destroy: noop };
    }
    const revertDelay = opts.revertDelay ?? 3000;
    const gradId = `sr-grad-${++_gradSeq}`;

    // ── Build DOM ──────────────────────────────────────────────────────
    const zone = document.createElement('div');
    zone.className = 'sr-zone';
    zone.style.display = 'none';

    const wrap = document.createElement('div');
    wrap.className = 'sr-wrap';

    // SVG (rotated -90° so progress starts from the top)
    const svg = /** @type {SVGSVGElement} */ (
        document.createElementNS(SVG_NS, 'svg')
    );
    svg.setAttribute('class', 'sr-svg');
    svg.setAttribute('width', '40');
    svg.setAttribute('height', '40');
    svg.setAttribute('viewBox', '0 0 40 40');
    svg.style.transform = 'rotate(-90deg)';

    // Gradient definition
    const defs = document.createElementNS(SVG_NS, 'defs');
    const grad = document.createElementNS(SVG_NS, 'linearGradient');
    grad.setAttribute('id', gradId);
    grad.setAttribute('x1', '0');
    grad.setAttribute('y1', '0');
    grad.setAttribute('x2', '1');
    grad.setAttribute('y2', '1');
    const stop1 = document.createElementNS(SVG_NS, 'stop');
    stop1.setAttribute('offset', '0');
    stop1.setAttribute('stop-color', 'var(--accent-primary)');
    stop1.setAttribute('stop-opacity', '0.4');
    const stop2 = document.createElementNS(SVG_NS, 'stop');
    stop2.setAttribute('offset', '1');
    stop2.setAttribute('stop-color', 'var(--accent-primary)');
    grad.appendChild(stop1);
    grad.appendChild(stop2);
    defs.appendChild(grad);
    svg.appendChild(defs);

    // Track
    const track = document.createElementNS(SVG_NS, 'circle');
    track.setAttribute('cx', '20');
    track.setAttribute('cy', '20');
    track.setAttribute('r', String(RADIUS));
    track.setAttribute('fill', 'none');
    track.setAttribute('stroke', 'var(--zephyr-bg-muted)');
    track.setAttribute('stroke-width', '2.5');
    svg.appendChild(track);

    // Rotating group (for indeterminate spin)
    const turn = document.createElementNS(SVG_NS, 'g');
    turn.setAttribute('class', 'sr-turn');

    // Progress arc
    const fill = document.createElementNS(SVG_NS, 'circle');
    fill.setAttribute('class', 'sr-fill');
    fill.setAttribute('cx', '20');
    fill.setAttribute('cy', '20');
    fill.setAttribute('r', String(RADIUS));
    fill.setAttribute('fill', 'none');
    fill.setAttribute('stroke', `url(#${gradId})`);
    fill.setAttribute('stroke-width', '3');
    fill.setAttribute('stroke-linecap', 'round');
    fill.setAttribute('stroke-dasharray', CIRC.toFixed(2));
    fill.setAttribute('stroke-dashoffset', CIRC.toFixed(2));
    turn.appendChild(fill);
    svg.appendChild(turn);

    wrap.appendChild(svg);

    // Center overlay (text or icon)
    const center = document.createElement('div');
    center.className = 'sr-center';
    center.textContent = '—';
    wrap.appendChild(center);

    zone.appendChild(wrap);

    // Insert after the button in the DOM
    parent.insertBefore(zone, buttonEl.nextSibling);

    // ── Internal helpers ───────────────────────────────────────────────
    /** @type {ReturnType<typeof setTimeout> | null} */
    let revertTimer = null;

    function clearRevert() {
        if (revertTimer) {
            clearTimeout(revertTimer);
            revertTimer = null;
        }
    }

    function resetStroke() {
        fill.style.stroke = '';
        fill.setAttribute('stroke', `url(#${gradId})`);
    }

    /**
     * @param {number} fraction
     */
    function setOffset(fraction) {
        fill.setAttribute(
            'stroke-dashoffset',
            (CIRC * (1 - Math.max(0, Math.min(1, fraction)))).toFixed(2),
        );
    }

    /**
     * Render an SVG icon inside the center overlay with a draw animation.
     * @param {'check' | 'cross'} kind
     * @param {string} color
     */
    function showIcon(kind, color) {
        center.innerHTML = '';
        center.style.color = color;

        const iconSvg = document.createElementNS(SVG_NS, 'svg');
        iconSvg.setAttribute('class', 'sr-icon');
        iconSvg.setAttribute('viewBox', '0 0 24 24');
        iconSvg.setAttribute('width', '16');
        iconSvg.setAttribute('height', '16');

        if (kind === 'check') {
            const p = document.createElementNS(SVG_NS, 'path');
            p.setAttribute('d', 'M5 13 L10 18 L19 7');
            p.setAttribute('fill', 'none');
            p.setAttribute('stroke', 'currentColor');
            p.setAttribute('stroke-width', '2.5');
            p.setAttribute('stroke-linecap', 'round');
            p.setAttribute('stroke-linejoin', 'round');
            p.style.strokeDasharray = '30';
            p.style.strokeDashoffset = '30';
            p.style.animation = 'sr-draw 0.45s cubic-bezier(0.65,0,0.35,1) forwards';
            iconSvg.appendChild(p);
        } else {
            const l1 = document.createElementNS(SVG_NS, 'line');
            l1.setAttribute('x1', '7');
            l1.setAttribute('y1', '7');
            l1.setAttribute('x2', '17');
            l1.setAttribute('y2', '17');
            l1.setAttribute('stroke', 'currentColor');
            l1.setAttribute('stroke-width', '2.5');
            l1.setAttribute('stroke-linecap', 'round');
            l1.style.strokeDasharray = '15';
            l1.style.strokeDashoffset = '15';
            l1.style.animation = 'sr-draw 0.22s cubic-bezier(0.65,0,0.35,1) forwards';

            const l2 = document.createElementNS(SVG_NS, 'line');
            l2.setAttribute('x1', '17');
            l2.setAttribute('y1', '7');
            l2.setAttribute('x2', '7');
            l2.setAttribute('y2', '17');
            l2.setAttribute('stroke', 'currentColor');
            l2.setAttribute('stroke-width', '2.5');
            l2.setAttribute('stroke-linecap', 'round');
            l2.style.strokeDasharray = '15';
            l2.style.strokeDashoffset = '15';
            l2.style.animation = 'sr-draw 0.22s cubic-bezier(0.65,0,0.35,1) 0.14s forwards';

            iconSvg.appendChild(l1);
            iconSvg.appendChild(l2);
        }

        center.appendChild(iconSvg);
    }

    /**
     * @param {string} text
     */
    function showText(text) {
        center.innerHTML = '';
        center.style.color = '';
        const span = document.createElement('span');
        span.className = 'sr-pct';
        span.textContent = text;
        center.appendChild(span);
    }

    // ── Public API ─────────────────────────────────────────────────────

    function show() {
        buttonEl.style.display = 'none';
        zone.style.display = 'flex';
    }

    function hide() {
        clearRevert();
        zone.style.display = 'none';
        buttonEl.style.display = '';
        // Reset to idle state
        fill.classList.remove('sr-dashing');
        turn.classList.remove('sr-spinning');
        resetStroke();
        setOffset(0);
        showText('—');
    }

    /**
     * @param {number} percent
     */
    function setProgress(percent) {
        clearRevert();
        fill.classList.remove('sr-dashing');
        turn.classList.remove('sr-spinning');
        resetStroke();
        setOffset(percent / 100);
        showText(`${Math.round(percent)}%`);
    }

    function setIndeterminate() {
        clearRevert();
        resetStroke();
        fill.classList.add('sr-dashing');
        turn.classList.add('sr-spinning');
        center.innerHTML = '';
        center.style.color = '';
    }

    function setSuccess() {
        clearRevert();
        fill.classList.remove('sr-dashing');
        turn.classList.remove('sr-spinning');
        // Solid color — NO gradient on terminal states
        fill.removeAttribute('stroke');
        fill.style.stroke = COLOR_SUCCESS;
        setOffset(1);
        showIcon('check', COLOR_SUCCESS);
        revertTimer = setTimeout(hide, revertDelay);
    }

    function setError() {
        clearRevert();
        fill.classList.remove('sr-dashing');
        turn.classList.remove('sr-spinning');
        fill.removeAttribute('stroke');
        fill.style.stroke = COLOR_ERROR;
        setOffset(1);
        showIcon('cross', COLOR_ERROR);
        revertTimer = setTimeout(hide, revertDelay);
    }

    function destroy() {
        clearRevert();
        hide();
        zone.remove();
    }

    return { show, hide, setProgress, setIndeterminate, setSuccess, setError, destroy };
}
