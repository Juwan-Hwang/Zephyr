// @ts-check
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { reconcileKeyedList, resetKeyedList } from './keyed-list.js';

/** @typedef {{ id: string, label: string, value: number }} Item */

/** @param {Partial<import('./keyed-list.js').KeyedListOptions<Item>>} [overrides] */
function makeOptions(overrides = {}) {
    return {
        getKey: (/** @type {Item} */ it) => it.id,
        getSignature: (/** @type {Item} */ it) => it.label,
        create: vi.fn((/** @type {Item} */ it) => {
            const el = document.createElement('div');
            el.className = 'row';
            el.dataset.id = it.id;
            el.dataset.label = it.label;
            const v = document.createElement('span');
            v.textContent = String(it.value);
            el.appendChild(v);
            return el;
        }),
        update: vi.fn((/** @type {Element} */ el, /** @type {Item} */ it) => {
            /** @type {HTMLElement} */ (el.firstElementChild).textContent = String(it.value);
        }),
        ...overrides,
    };
}

/** @param {Element} c */
const ids = (c) => Array.from(c.children).map((el) => /** @type {HTMLElement} */ (el).dataset.id);
/** @param {Element} c */
const values = (c) => Array.from(c.children).map((el) => el.textContent);

describe('reconcileKeyedList', () => {
    /** @type {HTMLDivElement} */
    let container;
    beforeEach(() => {
        container = document.createElement('div');
        document.body.replaceChildren(container);
    });

    it('renders items in order on first call', () => {
        const opts = makeOptions();
        reconcileKeyedList(container, [
            { id: 'a', label: 'A', value: 1 },
            { id: 'b', label: 'B', value: 2 },
        ], opts);
        expect(ids(container)).toEqual(['a', 'b']);
        expect(values(container)).toEqual(['1', '2']);
        expect(opts.create).toHaveBeenCalledTimes(2);
        expect(opts.update).not.toHaveBeenCalled();
    });

    it('keeps existing row nodes and only patches them', () => {
        const opts = makeOptions();
        reconcileKeyedList(container, [{ id: 'a', label: 'A', value: 1 }, { id: 'b', label: 'B', value: 2 }], opts);
        const [elA, elB] = Array.from(container.children);

        reconcileKeyedList(container, [{ id: 'a', label: 'A', value: 10 }, { id: 'b', label: 'B', value: 20 }], opts);
        expect(container.children[0]).toBe(elA);
        expect(container.children[1]).toBe(elB);
        expect(values(container)).toEqual(['10', '20']);
        expect(opts.create).toHaveBeenCalledTimes(2);
        expect(opts.update).toHaveBeenCalledTimes(2);
    });

    it('moves rows when the order changes without recreating them', () => {
        const opts = makeOptions();
        const items = ['a', 'b', 'c', 'd'].map((id, i) => ({ id, label: id, value: i }));
        reconcileKeyedList(container, items, opts);
        const byId = new Map(Array.from(container.children).map((el) => [/** @type {HTMLElement} */ (el).dataset.id, el]));

        const reordered = [items[3], items[1], items[0], items[2]];
        reconcileKeyedList(container, reordered, opts);
        expect(ids(container)).toEqual(['d', 'b', 'a', 'c']);
        for (const el of container.children) {
            expect(el).toBe(byId.get(/** @type {HTMLElement} */ (el).dataset.id));
        }
        expect(opts.create).toHaveBeenCalledTimes(4);
    });

    it('inserts new rows and removes rows that disappeared', () => {
        const opts = makeOptions();
        reconcileKeyedList(container, [{ id: 'a', label: 'A', value: 1 }, { id: 'b', label: 'B', value: 2 }], opts);
        const elA = container.children[0];

        reconcileKeyedList(container, [{ id: 'c', label: 'C', value: 3 }, { id: 'a', label: 'A', value: 1 }], opts);
        expect(ids(container)).toEqual(['c', 'a']);
        expect(container.children[1]).toBe(elA);
        expect(opts.create).toHaveBeenCalledTimes(3);
    });

    it('rebuilds a row whose signature changed', () => {
        const opts = makeOptions();
        reconcileKeyedList(container, [{ id: 'a', label: 'A', value: 1 }], opts);
        const before = container.children[0];

        reconcileKeyedList(container, [{ id: 'a', label: 'A2', value: 1 }], opts);
        expect(container.children[0]).not.toBe(before);
        expect(/** @type {HTMLElement} */ (container.children[0]).dataset.label).toBe('A2');
        expect(opts.update).not.toHaveBeenCalled();
    });

    it('renders one row per item when keys repeat', () => {
        const opts = makeOptions();
        reconcileKeyedList(container, [
            { id: 'x', label: 'X', value: 1 },
            { id: 'x', label: 'X', value: 2 },
        ], opts);
        expect(ids(container)).toEqual(['x', 'x']);
        expect(values(container)).toEqual(['1', '2']);
        const [first, second] = Array.from(container.children);

        reconcileKeyedList(container, [
            { id: 'x', label: 'X', value: 3 },
            { id: 'x', label: 'X', value: 4 },
        ], opts);
        expect(container.children[0]).toBe(first);
        expect(container.children[1]).toBe(second);
        expect(values(container)).toEqual(['3', '4']);
    });

    it('keeps duplicate keys apart from keys that look like an occurrence suffix', () => {
        const opts = makeOptions();
        const items = [
            { id: 'a', label: 'A', value: 1 },
            { id: 'a', label: 'A', value: 2 },
            { id: 'a\u00001', label: 'A', value: 3 },
        ];
        reconcileKeyedList(container, items, opts);
        const first = Array.from(container.children);
        reconcileKeyedList(container, items, opts);
        reconcileKeyedList(container, items, opts);
        expect(container.children).toHaveLength(3);
        expect(values(container)).toEqual(['1', '2', '3']);
        expect(new Set(Array.from(container.children)).size).toBe(3);
        expect(Array.from(container.children)).toEqual(first);
    });

    it('removes unmanaged children such as an empty-state placeholder or whitespace', () => {
        const opts = makeOptions();
        container.innerHTML = '\n  <p id="empty">nothing</p>\n';
        reconcileKeyedList(container, [{ id: 'a', label: 'A', value: 1 }], opts);
        expect(container.childNodes.length).toBe(1);
        expect(container.querySelector('#empty')).toBeNull();
    });

    it('empties the container for an empty list', () => {
        const opts = makeOptions();
        reconcileKeyedList(container, [{ id: 'a', label: 'A', value: 1 }], opts);
        reconcileKeyedList(container, [], opts);
        expect(container.childNodes.length).toBe(0);
    });

    it('recreates rows that were removed from the container by other code', () => {
        const opts = makeOptions();
        reconcileKeyedList(container, [{ id: 'a', label: 'A', value: 1 }], opts);
        const before = container.children[0];
        container.replaceChildren();

        reconcileKeyedList(container, [{ id: 'a', label: 'A', value: 1 }], opts);
        expect(container.children.length).toBe(1);
        expect(container.children[0]).not.toBe(before);
    });

    it('resetKeyedList forgets tracked rows', () => {
        const opts = makeOptions();
        reconcileKeyedList(container, [{ id: 'a', label: 'A', value: 1 }], opts);
        const before = container.children[0];
        resetKeyedList(container);
        reconcileKeyedList(container, [{ id: 'a', label: 'A', value: 1 }], opts);
        expect(container.children[0]).not.toBe(before);
        expect(container.children.length).toBe(1);
    });

    it('does not touch the DOM when nothing changed', () => {
        const opts = makeOptions({ update: vi.fn() });
        const items = [{ id: 'a', label: 'A', value: 1 }, { id: 'b', label: 'B', value: 2 }];
        reconcileKeyedList(container, items, opts);

        /** @type {MutationRecord[]} */
        const records = [];
        const mo = new MutationObserver((r) => records.push(...r));
        mo.observe(container, { childList: true, subtree: true, characterData: true });
        reconcileKeyedList(container, items, opts);
        records.push(...mo.takeRecords());
        mo.disconnect();
        expect(records).toEqual([]);
    });
});
