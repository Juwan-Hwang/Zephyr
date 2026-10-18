// @ts-check
/**
 * Roving tabindex — keyboard navigation for list-like containers.
 *
 * ArrowDown/ArrowUp move focus between items.
 * Home/End jump to first/last item.
 * Typeahead: typing characters jumps to the next matching item (500ms timeout).
 * MutationObserver resyncs when navigable items are added or removed anywhere
 * in the container (mutations inside an item that do not add or remove items
 * are ignored).
 *
 * Usage:
 *   const roving = createRovingTabindex(container, {
 *       itemSelector: '[role="option"]',
 *       onActivate: (item) => item.click(),
 *   });
 *   // ... later:
 *   roving.destroy();
 *
 * @module utils/roving-tabindex
 */

/**
 * @typedef {Object} RovingHandle
 * @property {() => void} destroy  Remove all listeners and observers.
 * @property {number} currentIndex  Read current focused index.
 */

/**
 * @typedef {Object} RovingOptions
 * @property {string} [itemSelector]  CSS selector for navigable items (default: '[role="option"]').
 * @property {(item: HTMLElement) => void} [onActivate] Called when Enter/Space is pressed on an item.
 * @property {boolean} [vertical=true]  If true, use ArrowUp/ArrowDown; else ArrowLeft/ArrowRight.
 * @property {Function} [getTextContent] Custom function to extract searchable text from an item.
 * @property {() => number} [getColumns] Grid mode: number of columns per row. ArrowLeft/Right move
 *   one item, ArrowUp/Down move one row.
 */

const TYPEAHEAD_TIMEOUT = 500;

/**
 * Check whether an element is disabled (native or ARIA).
 * Non-native elements (div[role="button"], .dropdown-item, etc.) do not
 * automatically block click events, so callers must guard activation.
 *
 * @param {HTMLElement} el
 * @returns {boolean}
 */
function isDisabled(el) {
    return el.matches(':disabled, [disabled], [aria-disabled="true"]');
}

/**
 * True when a key event comes from an interactive control nested inside an
 * option rather than from the option itself.
 * @param {EventTarget|null} target
 */
function isNestedControl(target) {
    if (!(target instanceof HTMLElement)) return false;
    if (target.getAttribute('role') === 'option') return false;
    return !!target.closest('button, a[href], input, select, textarea') && !!target.closest('[role="option"]');
}

/**
 * Create a roving tabindex controller.
 *
 * @param {HTMLElement} container
 * @param {RovingOptions} [options]
 * @returns {RovingHandle}
 */
export function createRovingTabindex(container, options = {}) {
    const {
        itemSelector = '[role="option"]',
        onActivate,
        vertical = true,
        getTextContent,
        getColumns,
    } = options;

    let currentIndex = -1;
    let typeaheadBuffer = '';
    let typeaheadTimer = /** @type {number|null} */ (null);
    /** @type {MutationObserver|null} */
    let observer = null;
    /**
     * Items seen at the last sync. Removed nodes are detached by the time the
     * observer runs, so a selector that depends on an ancestor no longer
     * matches them; membership in this list still identifies them.
     * @type {HTMLElement[]}
     */
    let knownItems = [];

    /**
     * @returns {HTMLElement[]}
     */
    function getItems() {
        return Array.from(container.querySelectorAll(itemSelector));
    }

    /**
     * @param {HTMLElement} item
     * @returns {string}
     */
    function getItemText(item) {
        if (getTextContent) return getTextContent(item);
        return (item.getAttribute('aria-label') || item.textContent || '').trim();
    }

    /**
     * @param {number} index
     */
    function focusItem(index) {
        const items = getItems();
        if (items.length === 0) return;

        const clampedIndex = Math.max(0, Math.min(index, items.length - 1));
        currentIndex = clampedIndex;

        for (let i = 0; i < items.length; i++) {
            items[i].setAttribute('tabindex', i === currentIndex ? '0' : '-1');
        }

        items[currentIndex].focus();
    }

    /**
     * @param {string} char
     */
    function handleTypeahead(char) {
        typeaheadBuffer += char.toLowerCase();

        if (typeaheadTimer !== null) clearTimeout(typeaheadTimer);
        typeaheadTimer = setTimeout(() => {
            typeaheadBuffer = '';
            typeaheadTimer = null;
        }, TYPEAHEAD_TIMEOUT);

        const items = getItems();
        if (items.length === 0) return;

        for (let i = 1; i <= items.length; i++) {
            const idx = (currentIndex + i) % items.length;
            const text = getItemText(items[idx]).toLowerCase();
            if (text.startsWith(typeaheadBuffer)) {
                focusItem(idx);
                return;
            }
        }
    }

    /** @param {KeyboardEvent} e */
    function onKeyDown(e) {
        const items = getItems();
        if (items.length === 0) return;

        if (getColumns && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
            e.preventDefault();
            const cols = Math.max(1, getColumns());
            const rtl = getComputedStyle(container).direction === 'rtl';
            const step = { ArrowLeft: rtl ? 1 : -1, ArrowRight: rtl ? -1 : 1, ArrowUp: -cols, ArrowDown: cols }[e.key] || 0;
            const from = Math.max(0, currentIndex);
            focusItem(Math.max(0, Math.min(items.length - 1, from + step)));
            return;
        }

        const prevKey = vertical ? 'ArrowUp' : 'ArrowLeft';
        const nextKey = vertical ? 'ArrowDown' : 'ArrowRight';

        switch (e.key) {
            case nextKey:
                e.preventDefault();
                focusItem(currentIndex < items.length - 1 ? currentIndex + 1 : 0);
                break;

            case prevKey:
                e.preventDefault();
                focusItem(currentIndex > 0 ? currentIndex - 1 : items.length - 1);
                break;

            case 'Home':
                e.preventDefault();
                focusItem(0);
                break;

            case 'End':
                e.preventDefault();
                focusItem(items.length - 1);
                break;

            case 'Enter':
            case ' ':
                // A button inside an option (e.g. a card's re-test) handles its own keys.
                if (isNestedControl(e.target)) break;
                if (currentIndex >= 0 && currentIndex < items.length) {
                    const item = items[currentIndex];
                    e.preventDefault();
                    if (!isDisabled(item)) {
                        onActivate?.(item);
                    }
                }
                break;

            default:
                if (isNestedControl(e.target)) break;
                if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
                    handleTypeahead(e.key);
                }
                break;
        }
    }

    /** @param {MouseEvent} e */
    function onClick(e) {
        const target = e.target instanceof HTMLElement
            ? e.target.closest(itemSelector)
            : null;
        if (!(target instanceof HTMLElement)) return;
        // Update roving tabindex state even for disabled items to keep
        // keyboard navigation in sync (onActivate is guarded separately)
        const items = getItems();
        const idx = items.indexOf(target);
        if (idx !== -1) {
            currentIndex = idx;
            for (let i = 0; i < items.length; i++) {
                items[i].setAttribute('tabindex', i === idx ? '0' : '-1');
            }
        }
    }

    /**
     * Whether a mutation added or removed a navigable item. Item content
     * (latency badges, scores) changes on every poll; resyncing every
     * tabindex for those is wasted work, so only list changes count.
     * @param {MutationRecord[]} records
     */
    function itemsChanged(records) {
        let touchedElement = false;
        for (const record of records) {
            for (const list of [record.addedNodes, record.removedNodes]) {
                for (const node of list) {
                    if (!(node instanceof Element)) continue;
                    touchedElement = true;
                    if (node.matches(itemSelector) || node.querySelector(itemSelector)) return true;
                }
            }
        }
        if (!touchedElement) return false;
        // Compare against a fresh query: a container-relative selector
        // (`:scope > …`) or an ancestor-dependent one cannot be matched against
        // the added/removed node alone, so a node-local check can miss both
        // additions and removals.
        const current = getItems();
        return current.length !== knownItems.length
            || current.some((item, i) => item !== knownItems[i])
            || currentIndex >= current.length;
    }

    function setupObserver() {
        observer = new MutationObserver((records) => {
            if (!itemsChanged(records)) return;
            const items = getItems();
            knownItems = items;
            if (currentIndex >= items.length) {
                currentIndex = items.length > 0 ? items.length - 1 : -1;
            }
            if (currentIndex >= 0) {
                for (let i = 0; i < items.length; i++) {
                    items[i].setAttribute('tabindex', i === currentIndex ? '0' : '-1');
                }
            }
        });
        // Watch the subtree so items nested under wrappers are tracked too;
        // the callback ignores mutations that do not add or remove an item.
        observer.observe(container, { childList: true, subtree: true });
    }

    // Initialize
    const initialItems = getItems();
    for (let i = 0; i < initialItems.length; i++) {
        initialItems[i].setAttribute('tabindex', i === 0 ? '0' : '-1');
    }
    if (initialItems.length > 0) currentIndex = 0;
    knownItems = initialItems;

    /** Keep the index in step when focus lands on an item some other way (Tab, script). */
    function onFocusIn(/** @type {FocusEvent} */ e) {
        const target = e.target instanceof HTMLElement ? e.target.closest(itemSelector) : null;
        if (!(target instanceof HTMLElement)) return;
        const idx = getItems().indexOf(target);
        if (idx !== -1) currentIndex = idx;
    }

    container.addEventListener('keydown', onKeyDown);
    container.addEventListener('click', onClick);
    container.addEventListener('focusin', onFocusIn);
    setupObserver();

    function destroy() {
        container.removeEventListener('keydown', onKeyDown);
        container.removeEventListener('click', onClick);
        container.removeEventListener('focusin', onFocusIn);
        observer?.disconnect();
        observer = null;
        if (typeaheadTimer !== null) {
            clearTimeout(typeaheadTimer);
            typeaheadTimer = null;
        }
        typeaheadBuffer = '';
        currentIndex = -1;
    }

    return Object.freeze({
        get currentIndex() { return currentIndex; },
        destroy,
    });
}
