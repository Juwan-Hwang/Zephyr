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

    it('re-syncs Tab stops before Tab for lists rendered or re-selected later', () => {
        const late = document.createElement('div');
        late.setAttribute('role', 'tablist');
        late.innerHTML = '<button role="tab" id="x" aria-selected="false">X</button><button role="tab" id="y" aria-selected="true">Y</button>';
        document.body.appendChild(late);
        el('a').setAttribute('aria-selected', 'false');
        el('c').setAttribute('aria-selected', 'true');
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
        expect(el('x').getAttribute('tabindex')).toBe('-1');
        expect(el('y').getAttribute('tabindex')).toBe('0');
        expect(el('a').getAttribute('tabindex')).toBe('-1');
        expect(el('c').getAttribute('tabindex')).toBe('0');
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

describe('radiogroup keyboard (segmented radios, choice cards)', () => {
    beforeEach(() => {
        document.body.innerHTML = `
            <div role="radiogroup" id="g">
                <button role="radio" id="r1" aria-checked="false">1</button>
                <button role="radio" id="r2" aria-checked="true">2</button>
                <button role="radio" id="r3" aria-checked="false">3</button>
                <button role="radio" id="r4" aria-checked="false">4</button>
            </div>`;
        document.querySelectorAll('[role="radio"]').forEach(r => {
            r.addEventListener('click', () => {
                document.querySelectorAll('[role="radio"]').forEach(x => x.setAttribute('aria-checked', String(x === r)));
            });
        });
        cleanup = initTablistKeys();
    });
    afterEach(() => { cleanup(); document.body.innerHTML = ''; });

    it('keeps only the checked radio in the Tab order', () => {
        expect(el('r2').getAttribute('tabindex')).toBe('0');
        expect(el('r1').getAttribute('tabindex')).toBe('-1');
    });

    it('all four arrows, Home and End move and check', () => {
        el('r2').focus();
        press('r2', 'ArrowRight');
        expect(el('r3').getAttribute('aria-checked')).toBe('true');
        press('r3', 'ArrowDown');
        expect(el('r4').getAttribute('aria-checked')).toBe('true');
        press('r4', 'ArrowDown');
        expect(el('r1').getAttribute('aria-checked')).toBe('true');
        press('r1', 'ArrowUp');
        expect(el('r4').getAttribute('aria-checked')).toBe('true');
        press('r4', 'ArrowLeft');
        expect(el('r3').getAttribute('aria-checked')).toBe('true');
        expect(document.activeElement).toBe(el('r3'));
        press('r3', 'Home');
        expect(el('r1').getAttribute('aria-checked')).toBe('true');
        expect(document.activeElement).toBe(el('r1'));
        press('r1', 'End');
        expect(el('r4').getAttribute('aria-checked')).toBe('true');
    });

    it('Up/Down still do nothing in a tablist', () => {
        document.body.innerHTML = '<div role="tablist"><button role="tab" id="t1" aria-selected="true">A</button><button role="tab" id="t2" aria-selected="false">B</button></div>';
        el('t1').addEventListener('click', () => {});
        el('t2').addEventListener('click', () => el('t2').setAttribute('aria-selected', 'true'));
        press('t1', 'ArrowDown');
        expect(el('t2').getAttribute('aria-selected')).toBe('false');
    });
});
