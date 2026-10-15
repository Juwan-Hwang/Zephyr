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
});
