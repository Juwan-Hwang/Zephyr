/**
 * Page headers that run out of room step down instead of spilling over.
 *
 * Long translations (Russian, Spanish…) at the 720px minimum window used to
 * push header buttons past the page edge. When a header's content is wider
 * than the header, it is marked `.is-compact` (button labels become visually
 * hidden, so the buttons turn icon-only but keep their accessible name and get
 * a tooltip); if that still is not enough, `.is-compact-2` also hides the
 * secondary read-outs (line count, rule stats). Each step is undone as soon as
 * the full header fits again.
 */

const STEPS = ['is-compact', 'is-compact-2'];
const LABEL_SELECTOR = ':is(.btn-ghost, .btn-accent, .btn-danger, .btn-primary) > span';

/** @param {HTMLElement} header */
function overflows(header) {
    return header.scrollWidth > header.clientWidth + 1;
}

/**
 * Give icon-only buttons a tooltip from their (hidden) label.
 * @param {HTMLElement} header
 * @param {boolean} compact
 */
function syncTitles(header, compact) {
    header.querySelectorAll(LABEL_SELECTOR).forEach(span => {
        const btn = /** @type {HTMLElement} */ (span.parentElement);
        if (!btn.querySelector(':scope > svg')) return; // text-only buttons keep their label
        if (compact) {
            // Refresh our own tooltip too, so a language switch updates it.
            if (!btn.hasAttribute('title') || btn.dataset.fitTitle) {
                btn.setAttribute('title', (span.textContent || '').trim());
                btn.dataset.fitTitle = '1';
            }
        } else if (btn.dataset.fitTitle) {
            btn.removeAttribute('title');
            delete btn.dataset.fitTitle;
        }
    });
}

/**
 * Pick the least compact step at which the header fits.
 * @param {HTMLElement} header
 * @returns {number} how many steps were applied (0 = full header)
 */
export function fitHeader(header) {
    if (!header || header.clientWidth === 0) return 0; // hidden page: refit when it is shown
    header.classList.remove(...STEPS);
    let applied = 0;
    while (applied < STEPS.length && overflows(header)) {
        header.classList.add(STEPS[applied]);
        applied++;
    }
    syncTitles(header, applied > 0);
    return applied;
}

/**
 * Watch every page header (including ones injected later by page modules).
 * @returns {() => void} cleanup
 */
export function initHeaderFit() {
    if (typeof ResizeObserver === 'undefined' || typeof MutationObserver === 'undefined') return () => {};
    /** @type {Set<HTMLElement>} */
    const seen = new Set();
    /** @type {Set<HTMLElement>} */
    const pending = new Set();
    let frame = 0;
    const schedule = (/** @type {HTMLElement} */ h) => {
        pending.add(h);
        if (!frame) {
            frame = requestAnimationFrame(() => {
                frame = 0;
                const list = [...pending];
                pending.clear();
                list.forEach(fitHeader);
            });
        }
    };
    const resize = new ResizeObserver(entries => entries.forEach(e => schedule(/** @type {HTMLElement} */ (e.target))));
    // Text changes (language switch, live counters) and controls being shown or
    // hidden inside the header can change the width needed.
    const text = new MutationObserver(records => {
        records.forEach(r => {
            const h = /** @type {Element} */ (r.target.nodeType === 1 ? r.target : r.target.parentElement)?.closest('header');
            // fitHeader() toggles the header's own class: ignore that to avoid a loop.
            if (!h || (r.type === 'attributes' && r.target === h)) return;
            schedule(/** @type {HTMLElement} */ (h));
        });
    });
    const TEXT_OPTS = { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['class', 'hidden'] };
    const attach = () => {
        // Pages that re-render replace their header: stop watching detached ones.
        const stale = [...seen].filter(h => !h.isConnected);
        if (stale.length) {
            stale.forEach(h => { seen.delete(h); resize.unobserve(h); pending.delete(h); });
            text.disconnect();
            seen.forEach(h => text.observe(h, TEXT_OPTS));
        }
        document.querySelectorAll('[data-page] > header').forEach(el => {
            const h = /** @type {HTMLElement} */ (el);
            if (seen.has(h)) return;
            seen.add(h);
            resize.observe(h);
            text.observe(h, TEXT_OPTS);
            schedule(h);
        });
    };
    const pages = new MutationObserver(attach);
    document.querySelectorAll('[data-page]').forEach(p => pages.observe(p, { childList: true }));
    attach();
    return () => {
        if (frame) cancelAnimationFrame(frame);
        resize.disconnect();
        text.disconnect();
        pages.disconnect();
        seen.clear();
    };
}
