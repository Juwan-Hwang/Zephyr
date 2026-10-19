// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { initCustomDropdown } from './dropdown.js';

function mount() {
    document.body.innerHTML = `
        <div id="wrap">
            <select id="sel"><option value="a">A</option><option value="b">B</option><option value="c">C</option></select>
            <button id="trig" type="button"><span id="lbl"></span></button>
            <div id="menu" class="hidden">
                <button type="button" data-value="a">A</button>
                <button type="button" data-value="b" disabled>B</button>
                <button type="button" data-value="c">C</button>
            </div>
        </div>`;
    /** @type {string[]} */
    const changes = [];
    const dd = initCustomDropdown({
        wrapId: 'wrap', triggerId: 'trig', menuId: 'menu', labelId: 'lbl', selectId: 'sel',
        onChange: (/** @type {string} */ v) => changes.push(v),
    });
    return { dd, changes };
}

const key = (/** @type {Element|null} */ el, /** @type {string} */ k) =>
    el?.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));

describe('custom dropdown keyboard', () => {
    beforeEach(() => { document.body.innerHTML = ''; });

    it('arrow keys open the menu and move between enabled options, Enter selects and refocuses the trigger', () => {
        const { dd, changes } = mount();
        const trig = document.getElementById('trig');
        const menu = document.getElementById('menu');
        trig?.focus();
        key(trig, 'ArrowDown');
        expect(menu?.classList.contains('hidden')).toBe(false);
        expect(document.activeElement?.getAttribute('data-value')).toBe('a');
        key(document.activeElement, 'ArrowDown');
        expect(document.activeElement?.getAttribute('data-value')).toBe('c');
        /** @type {HTMLElement} */ (document.activeElement).click();
        expect(changes).toEqual(['c']);
        expect(menu?.classList.contains('hidden')).toBe(true);
        expect(document.activeElement).toBe(trig);
        dd?.dispose();
    });

    it('Tab and Escape close the menu and return focus to the trigger', () => {
        const { dd } = mount();
        const trig = document.getElementById('trig');
        const menu = document.getElementById('menu');
        trig?.focus();
        key(trig, 'ArrowUp');
        key(document.activeElement, 'Tab');
        expect(menu?.classList.contains('hidden')).toBe(true);
        expect(document.activeElement).toBe(trig);
        key(trig, 'ArrowDown');
        key(document.activeElement, 'Escape');
        expect(menu?.classList.contains('hidden')).toBe(true);
        expect(document.activeElement).toBe(trig);
        dd?.dispose();
    });
});
