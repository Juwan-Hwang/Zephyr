// @ts-check
/**
 * Keyed list reconciliation for polled tables.
 *
 * Rebuilding a whole list with `innerHTML` on every poll re-parses the markup,
 * throws away every row node and forces a full style/layout pass even when
 * only a few numbers changed. `reconcileKeyedList()` keeps one element per
 * key instead:
 *
 *   - a row whose key and structural signature are unchanged is kept and only
 *     patched through `update()` (e.g. speed/total text);
 *   - a row whose signature changed is rebuilt through `create()`;
 *   - rows are inserted, removed or moved only when the list itself changed,
 *     and a reorder moves as few rows as possible.
 *
 * The resulting children are exactly the elements for `items`, in order.
 * Any other child of the container (an empty-state placeholder, whitespace
 * text nodes from an earlier innerHTML render, …) is removed.
 *
 * Duplicate keys are allowed: the n-th occurrence of a key is tracked as its
 * own row, so the output always has one element per item.
 *
 * @module utils/keyed-list
 */

/**
 * @template T
 * @typedef {Object} KeyedListOptions
 * @property {(item: T) => string} getKey  Stable identity of an item.
 * @property {(item: T) => string} getSignature  Everything about the row that
 *   `update()` does not patch. A changed signature rebuilds the row.
 * @property {(item: T) => Element} create  Build a fresh row element.
 * @property {(el: Element, item: T) => void} [update]  Patch a reused row.
 */

/** @typedef {{ el: Element, sig: string }} KeyedEntry */

/**
 * Rows per container: each key maps to its occurrences in order, so the n-th
 * row with a duplicate key is tracked without building a composite string
 * key that could collide with another item's real key.
 * @type {WeakMap<Element, Map<string, KeyedEntry[]>>}
 */
const _lists = new WeakMap();

/**
 * Reconcile `container`'s children against `items`.
 *
 * @template T
 * @param {Element} container
 * @param {readonly T[]} items
 * @param {KeyedListOptions<T>} options
 */
export function reconcileKeyedList(container, items, options) {
    const { getKey, getSignature, create, update } = options;
    const prev = _lists.get(container);
    /** @type {Map<string, KeyedEntry[]>} */
    const next = new Map();
    /** @type {Element[]} */
    const ordered = [];

    for (const item of items) {
        const key = getKey(item);
        let occurrences = next.get(key);
        if (!occurrences) {
            occurrences = [];
            next.set(key, occurrences);
        }
        const sig = getSignature(item);

        let entry = prev?.get(key)?.[occurrences.length];
        if (entry && entry.el.parentNode === container && entry.sig === sig) {
            update?.(entry.el, item);
        } else {
            entry = { el: create(item), sig };
        }
        occurrences.push(entry);
        ordered.push(entry.el);
    }

    // Drop stale rows and anything we do not manage.
    const keep = new Set(ordered);
    for (const child of Array.from(container.childNodes)) {
        if (!keep.has(/** @type {Element} */ (child))) child.remove();
    }

    // Place rows in order. Rows on the longest run that is already in the
    // right relative order stay put; only the others are moved, so one row
    // jumping from the top to the bottom costs one DOM move, not N - 1.
    /** @type {Map<Node, number>} */
    const position = new Map();
    container.childNodes.forEach((child, i) => position.set(child, i));
    const stable = longestIncreasingRun(ordered.map((el) => position.get(el) ?? -1));
    /** @type {Node | null} */
    let anchor = null;
    for (let i = ordered.length - 1; i >= 0; i--) {
        const el = ordered[i];
        if (!stable.has(i)) container.insertBefore(el, anchor);
        anchor = el;
    }

    _lists.set(container, next);
}

/**
 * Indexes of one longest strictly increasing subsequence of `values`,
 * ignoring negative entries (rows that are not in the container yet).
 * O(n log n).
 * @param {readonly number[]} values
 * @returns {Set<number>}
 */
function longestIncreasingRun(values) {
    /** @type {number[]} index into `values` of the smallest tail per length */
    const tails = [];
    /** @type {number[]} */
    const prevIndex = new Array(values.length).fill(-1);
    for (let i = 0; i < values.length; i++) {
        const v = values[i];
        if (v < 0) continue;
        let lo = 0;
        let hi = tails.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (values[tails[mid]] < v) lo = mid + 1;
            else hi = mid;
        }
        if (lo > 0) prevIndex[i] = tails[lo - 1];
        tails[lo] = i;
    }
    /** @type {Set<number>} */
    const result = new Set();
    let k = tails.length > 0 ? tails[tails.length - 1] : -1;
    while (k >= 0) {
        result.add(k);
        k = prevIndex[k];
    }
    return result;
}

/**
 * Forget the rows tracked for `container` (e.g. after it was cleared by
 * other code). Safe to call when nothing is tracked.
 * @param {Element} container
 */
export function resetKeyedList(container) {
    _lists.delete(container);
}
