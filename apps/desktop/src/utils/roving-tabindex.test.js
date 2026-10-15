// @ts-check
import { describe, it, expect, afterEach } from 'vitest';
import { createRovingTabindex } from './roving-tabindex.js';

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
});
