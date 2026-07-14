// @ts-check
/**
 * Roving tabindex — keyboard navigation for list-like containers.
 *
 * ArrowDown/ArrowUp move focus between items.
 * Home/End jump to first/last item.
 * Typeahead: typing characters jumps to the next matching item (500ms timeout).
 * MutationObserver automatically adapts to dynamic DOM changes.
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
    } = options;

    let currentIndex = -1;
    let typeaheadBuffer = '';
    let typeaheadTimer = /** @type {number|null} */ (null);
    /** @type {MutationObserver|null} */
    let observer = null;

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
                if (currentIndex >= 0 && currentIndex < items.length) {
                    const item = items[currentIndex];
                    if (!isDisabled(item)) {
                        e.preventDefault();
                        onActivate?.(item);
                    }
                }
                break;

            default:
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
        if (!(target instanceof HTMLElement) || isDisabled(target)) return;
        const items = getItems();
        const idx = items.indexOf(target);
        if (idx !== -1) {
            currentIndex = idx;
            for (let i = 0; i < items.length; i++) {
                items[i].setAttribute('tabindex', i === idx ? '0' : '-1');
            }
        }
    }

    function setupObserver() {
        observer = new MutationObserver(() => {
            const items = getItems();
            if (currentIndex >= items.length) {
                currentIndex = items.length > 0 ? items.length - 1 : -1;
            }
            if (currentIndex >= 0) {
                for (let i = 0; i < items.length; i++) {
                    items[i].setAttribute('tabindex', i === currentIndex ? '0' : '-1');
                }
            }
        });
        observer.observe(container, { childList: true, subtree: true });
    }

    // Initialize
    const initialItems = getItems();
    for (let i = 0; i < initialItems.length; i++) {
        initialItems[i].setAttribute('tabindex', i === 0 ? '0' : '-1');
    }
    if (initialItems.length > 0) currentIndex = 0;

    container.addEventListener('keydown', onKeyDown);
    container.addEventListener('click', onClick);
    setupObserver();

    function destroy() {
        container.removeEventListener('keydown', onKeyDown);
        container.removeEventListener('click', onClick);
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
