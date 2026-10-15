/**
 * Keyboard behaviour for every `[role="tablist"]` in the app (segmented tabs).
 *
 * Tabs follow the standard tablist pattern: only the selected tab is a Tab
 * stop, and Left/Right (mirrored in RTL), Home and End move to another tab and
 * select it by clicking it, so each page's own click handler stays the single
 * place that switches the content.
 */

const TAB = '[role="tab"]';

/** @param {Element} list @returns {HTMLElement[]} */
function tabsOf(list) {
    return /** @type {HTMLElement[]} */ ([...list.querySelectorAll(TAB)])
        .filter(t => t.closest('[role="tablist"]') === list && !t.hasAttribute('disabled'));
}

/**
 * Only the selected tab (or the first one) stays in the Tab order.
 * @param {Element | null} list
 */
export function syncTablist(list) {
    if (!list) return;
    const tabs = tabsOf(list);
    if (!tabs.length) return;
    const selected = tabs.find(t => t.getAttribute('aria-selected') === 'true') || tabs[0];
    tabs.forEach(t => {
        const want = t === selected ? '0' : '-1';
        if (t.getAttribute('tabindex') !== want) t.setAttribute('tabindex', want);
    });
}

/** @param {KeyboardEvent} e */
function onKeyDown(e) {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const tab = /** @type {HTMLElement | null} */ (/** @type {Element} */ (e.target)?.closest?.(TAB));
    const list = tab?.closest('[role="tablist"]');
    if (!tab || !list) return;
    const tabs = tabsOf(list);
    const i = tabs.indexOf(tab);
    if (i < 0) return;
    const rtl = getComputedStyle(list).direction === 'rtl';
    let next = -1;
    switch (e.key) {
        case 'ArrowRight': next = rtl ? i - 1 : i + 1; break;
        case 'ArrowLeft': next = rtl ? i + 1 : i - 1; break;
        case 'Home': next = 0; break;
        case 'End': next = tabs.length - 1; break;
        default: return;
    }
    e.preventDefault();
    const target = tabs[(next + tabs.length) % tabs.length];
    if (target === tab) return;
    target.focus();
    if (target.getAttribute('aria-selected') !== 'true') target.click();
    queueMicrotask(() => syncTablist(list));
}

/** @param {Event} e */
function onSync(e) {
    const list = /** @type {Element} */ (e.target)?.closest?.('[role="tablist"]');
    // Let the page's own click handler update aria-selected first.
    if (list) setTimeout(() => syncTablist(list), 0);
}

/**
 * Install the delegated listeners once. Returns a cleanup function.
 * @returns {() => void}
 */
export function initTablistKeys() {
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('click', onSync, true);
    document.addEventListener('focusin', onSync);
    document.querySelectorAll('[role="tablist"]').forEach(syncTablist);
    return () => {
        document.removeEventListener('keydown', onKeyDown);
        document.removeEventListener('click', onSync, true);
        document.removeEventListener('focusin', onSync);
    };
}
