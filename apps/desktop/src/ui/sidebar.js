/**
 * Sidebar expand / collapse.
 *
 * The sidebar shows the original icons with a short label beside each one.
 * It can be collapsed back to icons only, without any toggle button taking
 * up room in the sidebar:
 *  - drag the sidebar's inline-end edge (double-click the edge toggles);
 *  - keyboard: ⌃⌘S on macOS (the standard "Show/Hide Sidebar" chord),
 *    Ctrl+B on Windows and Linux;
 *  - right-click the sidebar for a one-item menu;
 *  - windows narrower than {@link NARROW_PX} collapse automatically. Expanding
 *    there lays the sidebar over the content instead of pushing it.
 *
 * The user's choice is remembered in localStorage.
 */

import { translations, currentLang } from '../i18n.js';
import { showContextMenu } from '../utils/context-menu.js';
import { escapeHtml } from '../utils/sanitize.js';

export const STORAGE_KEY = 'zephyr.sidebar';
/** Below this window width the sidebar starts collapsed. */
export const NARROW_PX = 860;
/** Default collapsed and expanded widths; styles.css owns the real values
 * (--sidebar-w-collapsed / --sidebar-w-expanded, wider outside CJK). */
export const COLLAPSED_W = 80;
export const EXPANDED_W = 160;

/** @returns {boolean} */
export function isMacPlatform() {
    const nav = /** @type {any} */ (globalThis.navigator);
    const p = (nav?.userAgentData?.platform || nav?.platform || '').toLowerCase();
    return p.includes('mac');
}

/**
 * Whether a keydown is the sidebar toggle chord.
 * @param {KeyboardEvent} e
 * @param {boolean} mac
 * @returns {boolean}
 */
export function isToggleShortcut(e, mac) {
    if (e.repeat || e.altKey || e.shiftKey) return false;
    const key = (e.key || '').toLowerCase();
    if (mac) return e.ctrlKey && e.metaKey && (key === 's' || e.code === 'KeyS');
    return e.ctrlKey && !e.metaKey && (key === 'b' || e.code === 'KeyB');
}

/**
 * Whether a drag ending at `width` should leave the sidebar expanded.
 * Snaps to whichever state is nearer.
 * @param {number} width
 * @param {number} [min]
 * @param {number} [max]
 * @returns {boolean}
 */
export function snapExpanded(width, min = COLLAPSED_W, max = EXPANDED_W) {
    return width >= (min + max) / 2;
}

/**
 * @param {string} name
 * @param {number} fallback
 * @returns {number}
 */
function cssPx(name, fallback) {
    const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name));
    return Number.isFinite(v) && v > 0 ? v : fallback;
}

/** @returns {'expanded' | 'collapsed' | null} */
function readSaved() {
    try {
        const v = localStorage.getItem(STORAGE_KEY);
        return v === 'expanded' || v === 'collapsed' ? v : null;
    } catch {
        return null;
    }
}

/** @param {'expanded' | 'collapsed'} v */
function save(v) {
    try { localStorage.setItem(STORAGE_KEY, v); } catch { /* storage unavailable */ }
}

/** @returns {Record<string, string>} */
function strings() {
    return /** @type {any} */ (translations)[currentLang] || translations.en;
}

/**
 * Wire up the sidebar. Returns a cleanup function.
 * @returns {() => void}
 */
export function initSidebar() {
    const nav = document.getElementById('sidebar-nav');
    if (!nav) return () => {};
    const root = document.documentElement;
    const mac = isMacPlatform();
    const shortcutLabel = mac ? '⌃⌘S' : 'Ctrl+B';

    const isNarrow = () => window.innerWidth < NARROW_PX;
    /** True while expanded in a narrow window, where it overlays the content. */
    let overlayOpen = false;

    /**
     * @param {boolean} expanded
     * @param {{ instant?: boolean, persist?: boolean }} [opts]
     */
    const apply = (expanded, opts = {}) => {
        if (opts.instant) {
            root.classList.add('sidebar-instant');
            requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove('sidebar-instant')));
        }
        const narrow = isNarrow();
        overlayOpen = expanded && narrow;
        root.classList.toggle('sidebar-expanded', expanded);
        root.classList.toggle('sidebar-overlay', overlayOpen);
        nav.dataset.expanded = expanded ? 'true' : 'false';
        // Only a choice made in a wide window is remembered: auto-collapse
        // and the temporary overlay must not overwrite it.
        if (opts.persist && !narrow) save(expanded ? 'expanded' : 'collapsed');
    };

    const isExpanded = () => root.classList.contains('sidebar-expanded');
    const toggle = () => apply(!isExpanded(), { persist: true });
    const preferred = () => (readSaved() ?? 'expanded') === 'expanded';

    apply(!isNarrow() && preferred(), { instant: true });

    // --- Edge handle ---------------------------------------------------
    const edge = document.createElement('div');
    edge.className = 'sidebar-edge';
    edge.setAttribute('aria-hidden', 'true');
    nav.appendChild(edge);

    /** @type {{ startX: number, startW: number, rtl: boolean, moved: boolean, min: number, max: number } | null} */
    let drag = null;

    /** @param {PointerEvent} e */
    const onDown = (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        const rtl = getComputedStyle(nav).direction === 'rtl';
        drag = {
            startX: e.clientX,
            startW: nav.getBoundingClientRect().width,
            rtl,
            moved: false,
            min: cssPx('--sidebar-w-collapsed', COLLAPSED_W),
            max: cssPx('--sidebar-w-expanded', EXPANDED_W),
        };
        edge.setPointerCapture?.(e.pointerId);
        root.classList.add('sidebar-dragging');
    };
    /** @param {PointerEvent} e */
    const onMove = (e) => {
        if (!drag) return;
        const dx = (e.clientX - drag.startX) * (drag.rtl ? -1 : 1);
        if (Math.abs(dx) > 3) drag.moved = true;
        if (!drag.moved) return;
        const w = Math.max(drag.min, Math.min(drag.max, drag.startW + dx));
        nav.style.setProperty('--sidebar-drag-w', `${w}px`);
        root.classList.toggle('sidebar-expanded', snapExpanded(w, drag.min, drag.max));
    };
    /** @param {PointerEvent} e */
    const onUp = (e) => {
        if (!drag) return;
        const { moved, min, max } = drag;
        const w = parseFloat(nav.style.getPropertyValue('--sidebar-drag-w')) || drag.startW;
        drag = null;
        edge.releasePointerCapture?.(e.pointerId);
        root.classList.remove('sidebar-dragging');
        nav.style.removeProperty('--sidebar-drag-w');
        if (moved) apply(snapExpanded(w, min, max), { persist: true });
    };
    const onDbl = () => toggle();
    edge.addEventListener('pointerdown', onDown);
    edge.addEventListener('pointermove', onMove);
    edge.addEventListener('pointerup', onUp);
    edge.addEventListener('pointercancel', onUp);
    edge.addEventListener('dblclick', onDbl);

    // --- Keyboard shortcut -----------------------------------------------
    /** @param {KeyboardEvent} e */
    const onKey = (e) => {
        if (isToggleShortcut(e, mac)) {
            e.preventDefault();
            toggle();
        } else if (e.key === 'Escape' && overlayOpen) {
            apply(false);
        }
    };
    document.addEventListener('keydown', onKey);

    // --- Context menu ----------------------------------------------------
    /** @param {MouseEvent} e */
    const onContext = (e) => {
        e.preventDefault();
        e.stopPropagation();
        const t = strings();
        const label = isExpanded() ? t.sidebarCollapse : t.sidebarExpand;
        showContextMenu(e, [{
            className: 'sidebar-menu-item w-full flex items-center gap-2 px-3 py-2 text-sm text-[var(--text-secondary)] hover:bg-[var(--zephyr-bg-muted)] hover:text-[var(--text-primary)] cursor-pointer',
            html: `<span>${escapeHtml(label || '')}</span><span class="sidebar-menu-kbd">${escapeHtml(shortcutLabel)}</span>`,
            action: toggle,
        }]);
    };
    nav.addEventListener('contextmenu', onContext);

    // --- Overlay: picking a page or clicking outside closes it -------------
    /** @param {MouseEvent} e */
    const onDocClick = (e) => {
        if (!overlayOpen) return;
        const target = /** @type {Node | null} */ (e.target);
        if (target && nav.contains(target) && !(target instanceof Element && target.closest('.nav-btn'))) return;
        apply(false);
    };
    document.addEventListener('click', onDocClick);

    // --- Window resize: auto-collapse below NARROW_PX ----------------------
    let wasNarrow = isNarrow();
    const onResize = () => {
        const narrow = isNarrow();
        if (narrow === wasNarrow) return;
        wasNarrow = narrow;
        apply(narrow ? false : preferred(), { instant: true });
    };
    window.addEventListener('resize', onResize);

    return () => {
        edge.remove();
        document.removeEventListener('keydown', onKey);
        document.removeEventListener('click', onDocClick);
        nav.removeEventListener('contextmenu', onContext);
        window.removeEventListener('resize', onResize);
    };
}
