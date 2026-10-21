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

describe('settings search', () => {
    it('hides non-matching rows, sections and their rail marks, and restores them when cleared', () => {
        document.body.innerHTML = `
            <div data-page="settings"><h2>Settings</h2><div>
                <section><h3 class="settings-section-title">Network</h3><div class="glass-card">
                    <div id="r-port">Mixed port</div><div class="h-px"></div><div id="r-lan">Allow LAN</div>
                </div></section>
                <section><h3 class="settings-section-title">Appearance</h3><div class="glass-card">
                    <div id="r-theme">Accent colour</div>
                </div></section>
            </div></div>`;
        const page = /** @type {HTMLElement} */ (document.querySelector('[data-page="settings"]'));
        page.scrollTo = vi.fn();
        vi.stubGlobal('matchMedia', () => ({ matches: false }));
        initSettingsNav();
        const input = /** @type {HTMLInputElement} */ (document.getElementById('settings-search'));
        const [net, look] = /** @type {HTMLElement[]} */ (Array.from(document.querySelectorAll('section')));
        const rail = /** @type {HTMLElement[]} */ (Array.from(document.querySelectorAll('.settings-rail-item')));
        const miss = (/** @type {Element|null} */ el) => !!el?.classList.contains('search-miss');
        const type = (/** @type {string} */ v) => { input.value = v; input.dispatchEvent(new Event('input')); };

        type('port');
        expect(miss(document.getElementById('r-port'))).toBe(false);
        expect(miss(document.getElementById('r-lan'))).toBe(true);
        expect(miss(net)).toBe(false);
        expect(miss(look)).toBe(true);
        expect(miss(rail[0])).toBe(false);
        expect(miss(rail[1])).toBe(true);
        expect(page.classList.contains('is-searching')).toBe(true);
        expect(document.querySelector('.settings-search-empty')?.classList.contains('hidden')).toBe(true);

        type('');
        for (const el of [document.getElementById('r-port'), document.getElementById('r-lan'), document.getElementById('r-theme'), net, look, ...rail]) {
            expect(miss(el)).toBe(false);
        }
        expect(page.classList.contains('is-searching')).toBe(false);
        vi.unstubAllGlobals();
    });
});
