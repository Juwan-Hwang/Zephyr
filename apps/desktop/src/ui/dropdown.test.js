// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { initCustomDropdown } from './dropdown.js';
import { createFocusTrap } from '../utils/focus-trap.js';

function mount() {
    document.body.innerHTML = `
        <div id="wrap">
            <select id="sel"><option value="a">A</option><option value="b">B</option><option value="c">C</option></select>
            <input id="before" type="text">
            <button id="trig" type="button"><span id="lbl"></span></button>
            <input id="after" type="text">
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

    it('Tab closes the menu and moves on from the trigger, like a native select', () => {
        const { dd } = mount();
        const trig = document.getElementById('trig');
        const menu = document.getElementById('menu');
        trig?.focus();
        key(trig, 'ArrowUp');
        key(document.activeElement, 'Tab');
        expect(menu?.classList.contains('hidden')).toBe(true);
        expect(document.activeElement?.id).toBe('after');
        trig?.focus();
        key(trig, 'ArrowDown');
        document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
        expect(menu?.classList.contains('hidden')).toBe(true);
        expect(document.activeElement?.id).toBe('before');
        dd?.dispose();
    });

    it('Escape closes the menu and returns focus to the trigger', () => {
        const { dd } = mount();
        const trig = document.getElementById('trig');
        const menu = document.getElementById('menu');
        trig?.focus();
        key(trig, 'ArrowDown');
        key(document.activeElement, 'Escape');
        expect(menu?.classList.contains('hidden')).toBe(true);
        expect(document.activeElement).toBe(trig);
        dd?.dispose();
    });

    it('Escape inside a dialog closes the menu, not the dialog', () => {
        const { dd } = mount();
        const trig = document.getElementById('trig');
        const menu = document.getElementById('menu');
        const wrap = /** @type {HTMLElement} */ (document.getElementById('wrap'));
        let dialogClosed = false;
        const trap = createFocusTrap(wrap, { onEscape: () => { dialogClosed = true; } });
        trap.activate();
        trig?.focus();
        key(trig, 'ArrowDown');
        expect(menu?.parentElement).toBe(document.body);
        key(document.activeElement, 'Escape');
        expect(menu?.classList.contains('hidden')).toBe(true);
        expect(document.activeElement).toBe(trig);
        expect(dialogClosed).toBe(false);
        // With the menu closed, Escape goes to the dialog again.
        key(trig, 'Escape');
        expect(dialogClosed).toBe(true);
        trap.deactivate();
        dd?.dispose();
    });
});
