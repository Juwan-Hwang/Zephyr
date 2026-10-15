// @ts-check
/**
 * Sidebar navigation tooltips.
 *
 * The sidebar is icon-only. Native `title` tooltips are slow, unstyled and
 * never appear on keyboard focus, so this module renders one small glass
 * label next to the hovered / keyboard-focused nav button instead.
 *
 * - The label text is read from the button's localized `.sr-only` span (or
 *   its `aria-label`) at show time, so it always follows the active language.
 * - The label is `aria-hidden`: the button already exposes the same name via
 *   `aria-label`, so screen readers would otherwise announce it twice.
 * - It is a single `position: fixed` element on `<body>`, so it is never
 *   clipped by the sidebar or covered by the main content area.
 * - Shows on pointer hover (after a short intent delay) and immediately on
 *   `:focus-visible`; hides on leave, blur, click, Escape, scroll and resize.
 * - Motion is CSS-only and disabled under `prefers-reduced-motion`.
 *
 * @module ui/nav-tooltip
 */

/** Delay (ms) before a hover tooltip appears, to avoid flicker while sweeping. */
export const NAV_TOOLTIP_HOVER_DELAY = 280;

/** Gap (px) between the nav button edge and the tooltip. */
const GAP = 10;

const TOOLTIP_ID = 'nav-tooltip';

/**
 * Resolve the visible label for a nav button.
 * @param {HTMLElement} btn
 * @returns {string}
 */
export function getNavLabel(btn) {
    const sr = btn.querySelector('.sr-only');
    const fromSr = sr?.textContent?.trim();
    if (fromSr) return fromSr;
    return (btn.getAttribute('aria-label') || '').trim();
}

/**
 * Whether the document is laid out right-to-left.
 * @returns {boolean}
 */
function isRtl() {
    return document.documentElement.getAttribute('dir') === 'rtl';
}

/**
 * Attach hover / focus tooltips to every `.nav-btn` inside the sidebar.
 *
 * @param {HTMLElement | null} [nav] - The sidebar element (defaults to `#sidebar-nav`).
 * @returns {() => void} Cleanup function that removes listeners and the tooltip node.
 */
export function initNavTooltips(nav = document.getElementById('sidebar-nav')) {
    if (!nav) return () => {};

    document.getElementById(TOOLTIP_ID)?.remove();
    const tip = document.createElement('div');
    tip.id = TOOLTIP_ID;
    tip.className = 'nav-tooltip';
    tip.setAttribute('aria-hidden', 'true');
    document.body.appendChild(tip);

    /** @type {HTMLElement | null} */
    let current = null;
    /** @type {ReturnType<typeof setTimeout> | null} */
    let showTimer = null;
    /** @type {HTMLElement | null} */
    let pending = null;

    const clearShowTimer = () => {
        if (showTimer !== null) {
            clearTimeout(showTimer);
            showTimer = null;
        }
        pending = null;
    };

    /** @param {HTMLElement} btn */
    const position = (btn) => {
        const rect = btn.getBoundingClientRect();
        const rtl = isRtl();
        tip.dataset.side = rtl ? 'start' : 'end';
        tip.style.top = `${Math.round(rect.top + (rect.height / 2))}px`;
        tip.style.left = `${Math.round(rtl ? rect.left - GAP : rect.right + GAP)}px`;
    };

    /** @param {HTMLElement} btn */
    const show = (btn) => {
        clearShowTimer();
        const label = getNavLabel(btn);
        if (!label) return;
        tip.textContent = label;
        position(btn);
        current = btn;
        tip.classList.add('is-visible');
    };

    const hide = () => {
        clearShowTimer();
        current = null;
        tip.classList.remove('is-visible');
    };

    /**
     * @param {EventTarget | null} target
     * @returns {HTMLElement | null}
     */
    const navBtnFrom = (target) => {
        if (!(target instanceof Element)) return null;
        const btn = target.closest('.nav-btn');
        return btn instanceof HTMLElement && nav.contains(btn) ? btn : null;
    };

    /** Button under the pointer, tracked apart from keyboard focus. */
    /** @type {HTMLElement | null} */
    let hovered = null;

    /**
     * `:focus-visible` throws on older WebKit (macOS 10.13 webview); treat
     * that as "not keyboard focus" instead of breaking the handler.
     * @param {Element} el
     */
    const isFocusVisible = (el) => {
        try { return el.matches(':focus-visible'); } catch (_) { return false; }
    };

    /** The sidebar button that currently has keyboard (visible) focus, if any. */
    const focusedNavBtn = () => {
        const btn = navBtnFrom(document.activeElement);
        return btn && isFocusVisible(btn) ? btn : null;
    };

    /** @param {PointerEvent} e */
    const onPointerOver = (e) => {
        const btn = navBtnFrom(e.target);
        if (btn) hovered = btn;
        if (!btn || btn === current || btn === pending) return;
        // Moving between buttons while a label is already up: follow at once.
        if (tip.classList.contains('is-visible')) {
            show(btn);
            return;
        }
        clearShowTimer();
        pending = btn;
        showTimer = setTimeout(() => show(btn), NAV_TOOLTIP_HOVER_DELAY);
    };

    /** @param {PointerEvent} e */
    const onPointerOut = (e) => {
        const from = navBtnFrom(e.target);
        if (!from) return;
        const to = navBtnFrom(e.relatedTarget);
        if (to === from || to) return; // pointerover handles the next button
        hovered = null;
        // Hand the label back to the keyboard-focused button, if there is one.
        const focused = focusedNavBtn();
        if (focused) {
            if (focused !== current) show(focused);
            return;
        }
        hide();
    };

    /** @param {FocusEvent} e */
    const onFocusIn = (e) => {
        const btn = navBtnFrom(e.target);
        if (!btn) return;
        if (isFocusVisible(btn)) show(btn);
    };

    /** @param {FocusEvent} e */
    const onFocusOut = (e) => {
        if (navBtnFrom(e.relatedTarget)) return;
        // Focus left the sidebar, but the pointer may still rest on a button.
        if (hovered && hovered.isConnected) {
            if (hovered !== current) show(hovered);
            return;
        }
        hide();
    };

    const onPointerDown = () => hide();

    /** @param {KeyboardEvent} e */
    const onKeyDown = (e) => {
        if (e.key === 'Escape' && tip.classList.contains('is-visible')) hide();
    };

    const onViewportChange = () => {
        if (current) hide();
    };

    nav.addEventListener('pointerover', onPointerOver);
    nav.addEventListener('pointerout', onPointerOut);
    nav.addEventListener('focusin', onFocusIn);
    nav.addEventListener('focusout', onFocusOut);
    nav.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', onViewportChange);
    window.addEventListener('blur', onViewportChange);

    return () => {
        hide();
        nav.removeEventListener('pointerover', onPointerOver);
        nav.removeEventListener('pointerout', onPointerOut);
        nav.removeEventListener('focusin', onFocusIn);
        nav.removeEventListener('focusout', onFocusOut);
        nav.removeEventListener('pointerdown', onPointerDown);
        document.removeEventListener('keydown', onKeyDown);
        window.removeEventListener('resize', onViewportChange);
        window.removeEventListener('blur', onViewportChange);
        tip.remove();
    };
}
