// @ts-check
import { describe, it, expect, vi } from 'vitest';
import { norm, initSettingsNav } from './settings-nav.js';

describe('settings search text', () => {
    it('matches a Turkish dotted capital I with a typed i', () => {
        expect(norm('Abonelik Sahte İstemcisi').includes(norm('istemci'))).toBe(true);
    });

    it('lowercases and collapses whitespace', () => {
        expect(norm('  Proxy\n  Port ')).toBe('proxy port');
    });
});

describe('settings section rail', () => {
    it('moves focus to the chosen section heading without scrolling again', () => {
        document.body.innerHTML = `
            <div data-page="settings"><h2>Settings</h2><div>
                <section><h3 class="settings-section-title">One</h3><button id="a">A</button></section>
                <section><h3 class="settings-section-title" tabindex="0">Two</h3><button id="b">B</button></section>
            </div></div>`;
        const page = /** @type {HTMLElement} */ (document.querySelector('[data-page="settings"]'));
        page.scrollTo = vi.fn();
        vi.stubGlobal('matchMedia', () => ({ matches: false }));
        initSettingsNav();
        const items = /** @type {HTMLButtonElement[]} */ (Array.from(document.querySelectorAll('.settings-rail-item')));
        const [h1, h2] = /** @type {HTMLElement[]} */ (Array.from(document.querySelectorAll('.settings-section-title')));
        const focus = vi.spyOn(h1, 'focus');
        items[0].click();
        expect(document.activeElement).toBe(h1);
        expect(h1.getAttribute('tabindex')).toBe('-1');
        expect(focus).toHaveBeenCalledWith({ preventScroll: true });
        items[1].click();
        expect(document.activeElement).toBe(h2);
        expect(h2.getAttribute('tabindex')).toBe('0');
        expect(page.scrollTo).toHaveBeenCalledTimes(2);
        vi.unstubAllGlobals();
    });
});
