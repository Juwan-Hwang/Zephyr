// @ts-check
/**
 * High-performance reactive DOM bindings.
 * No MutationObserver — uses store.subscribe() directly.
 * Each binding adds ~100 bytes (one closure).
 *
 * @module bind
 */

/**
 * @typedef {Object} StoreLike
 * @property {(key?: string) => *} get
 * @property {(key: string, callback: Function) => Function} subscribe
 */

/**
 * Bind a DOM element property to a store key.
 * Returns an unsubscribe function for cleanup.
 *
 * @param {StoreLike} store - Any store with get/subscribe (appStore, trayStore, etc.)
 * @param {HTMLElement & Record<string, any>} element
 * @param {string} storeKey - Key in store to watch
 * @param {'checked'|'textContent'|'disabled'|'className'|'hidden'|'innerHTML'} property
 * @param {((value: any) => any)} [transform] - Optional value transform
 * @returns {Function} Unsubscribe function
 */
export function bind(store, element, storeKey, property, transform) {
    const update = () => {
        const raw = store.get(storeKey);
        const value = transform ? transform(raw) : raw;
        switch (property) {
            case 'checked':     element.checked = value; break;
            case 'textContent': element.textContent = value; break;
            case 'disabled':    element.disabled = value; break;
            case 'className':   element.className = value; break;
            case 'hidden':      element.hidden = value; break;
            // eslint-disable-next-line no-unsanitized/property -- caller-validated: store values are app-internal
            case 'innerHTML':   element.innerHTML = value; break;
            default:            element.setAttribute(property, value); break;
        }
    };

    // Initial sync
    update();

    // Subscribe to changes
    return store.subscribe(storeKey, update);
}

/**
 * Bind multiple elements at once. Useful for init functions.
 *
 * @param {StoreLike} store
 * @param {Array<{element: HTMLElement & Record<string, any>, storeKey: string, property: 'checked'|'textContent'|'disabled'|'className'|'hidden'|'innerHTML', transform?: ((value: any) => any)}>} bindings
 * @returns {Function} Combined unsubscribe function
 */
export function bindAll(store, bindings) {
    const unsubs = bindings.map(({ element, storeKey, property, transform }) =>
        bind(store, element, storeKey, property, transform)
    );
    return () => unsubs.forEach(unsub => unsub());
}
