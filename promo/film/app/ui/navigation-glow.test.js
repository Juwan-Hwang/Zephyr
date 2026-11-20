// @ts-check
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./3d-effect.js', () => ({ setup3DEffect: vi.fn() }));

import { switchPage, initNavigation } from './navigation.js';

const GLOWS = ['home', 'console', 'proxies', 'logs'];

beforeEach(() => {
    // eslint-disable-next-line no-unsanitized/property -- static test fixture
    document.body.innerHTML = `
        ${GLOWS.map((g, i) => `<div id="glow-${g}" class="${i === 0 ? '' : 'hidden'}"></div>`).join('')}
        <nav id="sidebar-nav"><button class="nav-btn is-active" data-nav="home"></button><button class="nav-btn" data-nav="proxies"></button></nav>
        <div data-page="home"></div><div data-page="console" class="hidden"></div><div data-page="proxies" class="hidden"></div>`;
});

/** @returns {string[]} */
const activeGlows = () => [...document.querySelectorAll('[id^="glow-"].is-active')].map(g => g.id);

describe('page background glows', () => {
    it('only the current page glow is active when console mode switched before init', () => {
        // main.js switches home → console before initNavigation() runs.
        switchPage('console');
        initNavigation();
        expect(activeGlows()).toEqual(['glow-console']);
        for (const g of document.querySelectorAll('[id^="glow-"]')) {
            expect(g.classList.contains('page-glow')).toBe(true);
        }
    });

    it('fresh markup: the visible glow becomes the active one', () => {
        initNavigation();
        expect(activeGlows()).toEqual(['glow-home']);
        switchPage('proxies');
        expect(activeGlows()).toEqual(['glow-proxies']);
    });
});
