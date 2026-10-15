import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initTablistKeys, syncTablist } from './tablist-keys.js';

/** @type {() => void} */
let cleanup = () => {};

function mount() {
    document.body.innerHTML = `
        <div role="tablist" id="list">
            <button role="tab" id="a" aria-selected="true">A</button>
            <button role="tab" id="b" aria-selected="false">B</button>
            <button role="tab" id="c" aria-selected="false">C</button>
        </div>`;
    document.querySelectorAll('[role="tab"]').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('[role="tab"]').forEach(t => t.setAttribute('aria-selected', String(t === tab)));
        });
    });
}

/** @param {string} id */
const el = (id) => /** @type {HTMLElement} */ (document.getElementById(id));
/** @param {string} id @param {string} key */
const press = (id, key) => el(id).dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));

describe('tablist keyboard', () => {
    beforeEach(() => { mount(); cleanup = initTablistKeys(); });
    afterEach(() => { cleanup(); document.body.innerHTML = ''; });

    it('keeps only the selected tab in the Tab order', () => {
        expect(el('a').getAttribute('tabindex')).toBe('0');
        expect(el('b').getAttribute('tabindex')).toBe('-1');
        expect(el('c').getAttribute('tabindex')).toBe('-1');
    });

    it('arrow keys move to and select the next tab, wrapping around', async () => {
        el('a').focus();
        press('a', 'ArrowRight');
        expect(el('b').getAttribute('aria-selected')).toBe('true');
        expect(document.activeElement).toBe(el('b'));
        press('b', 'ArrowLeft');
        press('a', 'ArrowLeft');
        expect(el('c').getAttribute('aria-selected')).toBe('true');
        await Promise.resolve();
        expect(el('c').getAttribute('tabindex')).toBe('0');
        expect(el('a').getAttribute('tabindex')).toBe('-1');
    });

    it('Home and End jump to the first and last tab', () => {
        press('a', 'End');
        expect(el('c').getAttribute('aria-selected')).toBe('true');
        press('c', 'Home');
        expect(el('a').getAttribute('aria-selected')).toBe('true');
    });

    it('syncTablist ignores lists without tabs', () => {
        const empty = document.createElement('div');
        empty.setAttribute('role', 'tablist');
        expect(() => syncTablist(empty)).not.toThrow();
        expect(() => syncTablist(null)).not.toThrow();
    });
});
