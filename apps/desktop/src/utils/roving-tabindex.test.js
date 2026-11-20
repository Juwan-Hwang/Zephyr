// @ts-check
import { describe, it, expect, afterEach } from 'vitest';
import { createRovingTabindex, setItemTabStop } from './roving-tabindex.js';

/** Let MutationObserver callbacks run. */
const flush = () => new Promise((r) => setTimeout(r, 0));

/** @param {number} n */
function makeList(n) {
    const list = document.createElement('div');
    for (let i = 0; i < n; i++) {
        const item = document.createElement('div');
        item.setAttribute('role', 'option');
        item.textContent = `item ${i}`;
        const badge = document.createElement('span');
        badge.className = 'badge';
        item.appendChild(badge);
        list.appendChild(item);
    }
    document.body.replaceChildren(list);
    return list;
}

/** @param {HTMLElement} list */
const tabindexes = (list) => Array.from(list.querySelectorAll('[role="option"]')).map((el) => el.getAttribute('tabindex'));

/** @param {HTMLElement} el @param {string} key */
const press = (el, key) => el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));

describe('createRovingTabindex', () => {
    /** @type {{ destroy: () => void } | null} */
    let roving = null;
    afterEach(() => { roving?.destroy(); roving = null; });

    it('leaves arrow keys to a text field inside an option', () => {
        const list = makeList(3);
        roving = createRovingTabindex(list, { getColumns: () => 1 });
        const input = document.createElement('input');
        list.querySelectorAll('[role="option"]')[0].appendChild(input);
        const ev = new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true });
        input.dispatchEvent(ev);
        expect(ev.defaultPrevented).toBe(false);
        expect(tabindexes(list)).toEqual(['0', '-1', '-1']);
        // A button inside an option still moves through the grid.
        const btn = document.createElement('button');
        list.querySelectorAll('[role="option"]')[0].appendChild(btn);
        press(btn, 'ArrowDown');
        expect(tabindexes(list)).toEqual(['-1', '0', '-1']);
    });

    it('initialises the first item as the tab stop and navigates with arrows', () => {
        const list = makeList(3);
        roving = createRovingTabindex(list);
        expect(tabindexes(list)).toEqual(['0', '-1', '-1']);
        press(list, 'ArrowDown');
        expect(tabindexes(list)).toEqual(['-1', '0', '-1']);
        press(list, 'End');
        expect(tabindexes(list)).toEqual(['-1', '-1', '0']);
        press(list, 'ArrowDown');
        expect(tabindexes(list)).toEqual(['0', '-1', '-1']);
    });

    it('re-syncs tabindex when items are added as direct children', async () => {
        const list = makeList(2);
        roving = createRovingTabindex(list);
        press(list, 'ArrowDown');
        const extra = document.createElement('div');
        extra.setAttribute('role', 'option');
        list.appendChild(extra);
        await flush();
        expect(tabindexes(list)).toEqual(['-1', '0', '-1']);
    });

    it('re-syncs tabindex for items added under a container-scoped selector', async () => {
        const list = makeList(2);
        roving = createRovingTabindex(list, { itemSelector: ':scope > [role="option"]' });
        press(list, 'ArrowDown');
        const extra = document.createElement('div');
        extra.setAttribute('role', 'option');
        list.appendChild(extra);
        await flush();
        expect(tabindexes(list)).toEqual(['-1', '0', '-1']);
    });

    it('clamps the current index when items are removed', async () => {
        const list = makeList(3);
        roving = createRovingTabindex(list);
        press(list, 'End');
        list.replaceChildren(...Array.from(list.children).slice(0, 1));
        await flush();
        expect(roving).not.toBeNull();
        expect(/** @type {any} */ (roving).currentIndex).toBe(0);
        expect(tabindexes(list)).toEqual(['0']);
    });

    it('ignores mutations inside an item', async () => {
        const list = makeList(3);
        roving = createRovingTabindex(list);
        press(list, 'ArrowDown');
        // Simulate something else changing a tabindex, then an inner update.
        const items = /** @type {HTMLElement[]} */ (Array.from(list.children));
        items[2].setAttribute('tabindex', 'sentinel');
        const badge = /** @type {HTMLElement} */ (items[0].querySelector('.badge'));
        badge.innerHTML = '<b>42 ms</b>';
        await flush();
        // The inner change did not trigger a tabindex rewrite.
        expect(items[2].getAttribute('tabindex')).toBe('sentinel');
    });

    it('re-syncs tabindex when nested items are added or removed', async () => {
        const list = document.createElement('div');
        const group = document.createElement('div');
        for (let i = 0; i < 2; i++) {
            const item = document.createElement('div');
            item.setAttribute('role', 'option');
            group.appendChild(item);
        }
        list.appendChild(group);
        document.body.replaceChildren(list);
        roving = createRovingTabindex(list);
        press(list, 'ArrowDown');

        const extra = document.createElement('div');
        extra.setAttribute('role', 'option');
        group.appendChild(extra);
        await flush();
        expect(tabindexes(list)).toEqual(['-1', '0', '-1']);

        press(list, 'End');
        group.lastElementChild?.remove();
        await flush();
        expect(/** @type {any} */ (roving).currentIndex).toBe(1);
        expect(tabindexes(list)).toEqual(['-1', '0']);
    });
    it('re-syncs when an item matched by an ancestor-dependent selector is removed', async () => {
        const list = document.createElement('div');
        const group = document.createElement('div');
        group.className = 'group';
        for (let i = 0; i < 2; i++) {
            const item = document.createElement('div');
            item.setAttribute('role', 'option');
            group.appendChild(item);
        }
        list.appendChild(group);
        document.body.replaceChildren(list);
        /** @type {HTMLElement[]} */
        const activated = [];
        roving = createRovingTabindex(list, {
            itemSelector: '.group > [role="option"]',
            onActivate: (item) => activated.push(item),
        });
        press(list, 'End');
        group.lastElementChild?.remove();
        await flush();
        const remaining = /** @type {HTMLElement} */ (group.firstElementChild);
        expect(/** @type {any} */ (roving).currentIndex).toBe(0);
        expect(remaining.getAttribute('tabindex')).toBe('0');
        press(list, 'Enter');
        expect(activated).toEqual([remaining]);
    });

    it('re-syncs when a selected item that was never tracked is removed', async () => {
        const list = document.createElement('div');
        const group = document.createElement('div');
        group.className = 'group';
        for (let i = 0; i < 2; i++) {
            const item = document.createElement('div');
            item.setAttribute('role', 'option');
            group.appendChild(item);
        }
        list.appendChild(group);
        document.body.replaceChildren(list);
        roving = createRovingTabindex(list, { itemSelector: '.group > [role="option"]' });
        // Added under a wrapper that does not match yet, so it is not tracked.
        const wrapper = document.createElement('div');
        const late = document.createElement('div');
        late.setAttribute('role', 'option');
        wrapper.appendChild(late);
        list.appendChild(wrapper);
        await flush();
        // The wrapper starts matching through an (unobserved) attribute change.
        wrapper.className = 'group';
        press(list, 'End');
        expect(late.getAttribute('tabindex')).toBe('0');
        late.remove();
        await flush();
        expect(/** @type {any} */ (roving).currentIndex).toBe(1);
        expect(/** @type {HTMLElement} */ (group.lastElementChild).getAttribute('tabindex')).toBe('0');
    });

    it('leaves arrow keys to a range slider inside an option', () => {
        const list = makeList(3);
        roving = createRovingTabindex(list, { getColumns: () => 1 });
        const range = document.createElement('input');
        range.type = 'range';
        list.querySelectorAll('[role="option"]')[0].appendChild(range);
        const ev = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true });
        range.dispatchEvent(ev);
        expect(ev.defaultPrevented).toBe(false);
        expect(tabindexes(list)).toEqual(['0', '-1', '-1']);
    });

    it('leaves arrow keys to a radio button inside an option', () => {
        const list = makeList(3);
        roving = createRovingTabindex(list, { getColumns: () => 1 });
        const radio = document.createElement('input');
        radio.type = 'radio';
        list.querySelectorAll('[role="option"]')[0].appendChild(radio);
        const ev = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true });
        radio.dispatchEvent(ev);
        expect(ev.defaultPrevented).toBe(false);
        expect(tabindexes(list)).toEqual(['0', '-1', '-1']);
    });

    it('follows inline CSS order in visual-order mode', () => {
        const list = makeList(3);
        const items = /** @type {HTMLElement[]} */ (Array.from(list.querySelectorAll('[role="option"]')));
        items[0].style.order = '2';
        items[1].style.order = '0';
        items[2].style.order = '1';
        roving = createRovingTabindex(list, { getColumns: () => 1, visualOrder: true });
        items[1].focus();
        press(items[1], 'ArrowDown');
        expect(document.activeElement).toBe(items[2]);
        press(items[2], 'ArrowDown');
        expect(document.activeElement).toBe(items[0]);
    });

    it('follows a stylesheet CSS order in visual-order mode', () => {
        const list = makeList(3);
        const style = document.createElement('style');
        style.textContent = '.first { order: -1; }';
        document.head.appendChild(style);
        try {
            const items = /** @type {HTMLElement[]} */ (Array.from(list.querySelectorAll('[role="option"]')));
            items[2].className = 'first';
            roving = createRovingTabindex(list, { getColumns: () => 1, visualOrder: true });
            items[2].focus();
            press(items[2], 'ArrowDown');
            expect(document.activeElement).toBe(items[0]);
        } finally {
            style.remove();
        }
    });

    it('keeps form controls in inactive options out of the Tab order', () => {
        const item = document.createElement('div');
        const input = document.createElement('input');
        const select = document.createElement('select');
        const area = document.createElement('textarea');
        item.append(input, select, area);
        setItemTabStop(item, false);
        expect([input, select, area].map((c) => c.getAttribute('tabindex'))).toEqual(['-1', '-1', '-1']);
        setItemTabStop(item, true);
        expect([input, select, area].map((c) => c.getAttribute('tabindex'))).toEqual(['0', '0', '0']);
    });

    it('adopts the tab stop a caller marks after rebuilding the list', async () => {
        const list = makeList(5);
        roving = createRovingTabindex(list);
        press(list, 'End');
        // Filter down to two items: the old index is clamped.
        list.replaceChildren(...Array.from(list.children).slice(0, 2));
        await flush();
        expect(tabindexes(list)).toEqual(['-1', '0']);
        // Rebuild all five with the selected one (index 3) marked: it gets the stop, not index 1.
        const fresh = makeList(5);
        list.replaceChildren(...Array.from(fresh.children));
        document.body.replaceChildren(list);
        setItemTabStop(/** @type {HTMLElement} */ (list.children[3]), true);
        await flush();
        expect(tabindexes(list)).toEqual(['-1', '-1', '-1', '0', '-1']);
        expect(/** @type {any} */ (roving).currentIndex).toBe(3);
    });

    it('gives a list that was empty a tab stop once items arrive', async () => {
        const list = makeList(0);
        roving = createRovingTabindex(list);
        const fresh = makeList(3);
        list.replaceChildren(...Array.from(fresh.children));
        document.body.replaceChildren(list);
        await flush();
        expect(tabindexes(list)).toEqual(['0', '-1', '-1']);
    });

    it('keeps the tab stop on the same item when an earlier item is removed', async () => {
        const list = makeList(3);
        roving = createRovingTabindex(list);
        press(list, 'End');
        list.children[0].remove();
        await flush();
        expect(tabindexes(list)).toEqual(['-1', '0']);
        expect(/** @type {any} */ (roving).currentIndex).toBe(1);
    });
});
