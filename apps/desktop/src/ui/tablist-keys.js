/**
 * Keyboard behaviour for every `[role="tablist"]` (segmented tabs) and every
 * custom `[role="radiogroup"]` (segmented radios, choice cards) in the app.
 *
 * Both follow the standard pattern: only the selected item is a Tab stop, and
 * Left/Right (mirrored in RTL), Home and End move to another item and select it
 * by clicking it, so each page's own click handler stays the single place that
 * changes the value. Radio groups also take Up/Down, as the radio pattern does;
 * choice cards wrap onto several rows.
 */

const TAB = '[role="tab"]';
const RADIO = '[role="radio"]';
const GROUPS = '[role="tablist"], [role="radiogroup"]';

/** @param {Element} list */
function isRadioGroup(list) {
    return list.getAttribute('role') === 'radiogroup';
}

/** @param {Element} list @returns {HTMLElement[]} */
function tabsOf(list) {
    const sel = isRadioGroup(list) ? RADIO : TAB;
    return /** @type {HTMLElement[]} */ ([...list.querySelectorAll(sel)])
        .filter(t => t.closest(GROUPS) === list && !t.hasAttribute('disabled'));
}

/** @param {HTMLElement} t */
function isSelected(t) {
    return t.getAttribute('aria-selected') === 'true' || t.getAttribute('aria-checked') === 'true';
}

/**
 * Only the selected tab (or the first one) stays in the Tab order.
 * @param {Element | null} list
 */
export function syncTablist(list) {
    if (!list) return;
    const tabs = tabsOf(list);
    if (!tabs.length) return;
    const selected = tabs.find(isSelected) || tabs[0];
    tabs.forEach(t => {
        const want = t === selected ? '0' : '-1';
        if (t.getAttribute('tabindex') !== want) t.setAttribute('tabindex', want);
    });
}

/** Tab stops follow the current selection, including tablists rendered later or updated asynchronously. */
function syncAll() {
    document.querySelectorAll(GROUPS).forEach(syncTablist);
}

/** @param {KeyboardEvent} e */
function onKeyDown(e) {
    // Runs before the browser moves focus, so Tab always lands on the selected tab.
    if (e.key === 'Tab') { syncAll(); return; }
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const tab = /** @type {HTMLElement | null} */ (/** @type {Element} */ (e.target)?.closest?.(`${TAB}, ${RADIO}`));
    const list = tab?.closest(GROUPS);
    if (!tab || !list) return;
    const radio = isRadioGroup(list);
    const tabs = tabsOf(list);
    const i = tabs.indexOf(tab);
    if (i < 0) return;
    const rtl = getComputedStyle(list).direction === 'rtl';
    let next = -1;
    switch (e.key) {
        case 'ArrowRight': next = rtl ? i - 1 : i + 1; break;
        case 'ArrowLeft': next = rtl ? i + 1 : i - 1; break;
        case 'ArrowDown': if (!radio) return; next = i + 1; break;
        case 'ArrowUp': if (!radio) return; next = i - 1; break;
        case 'Home': next = 0; break;
        case 'End': next = tabs.length - 1; break;
        default: return;
    }
    e.preventDefault();
    const target = tabs[(next + tabs.length) % tabs.length];
    if (target === tab) return;
    target.focus();
    if (!isSelected(target)) target.click();
    queueMicrotask(() => syncTablist(list));
}

/** @param {Event} e */
function onSync(e) {
    const list = /** @type {Element} */ (e.target)?.closest?.(GROUPS);
    // Let the page's own click handler update aria-selected first.
    if (list) setTimeout(() => syncTablist(list), 0);
}

/**
 * Install the delegated listeners once. Returns a cleanup function.
 * @returns {() => void}
 */
export function initTablistKeys() {
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('click', onSync, true);
    document.addEventListener('focusin', onSync);
    syncAll();
    return () => {
        document.removeEventListener('keydown', onKeyDown, true);
        document.removeEventListener('click', onSync, true);
        document.removeEventListener('focusin', onSync);
    };
}
