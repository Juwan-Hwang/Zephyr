import { describe, it, expect } from 'vitest';
import { fitHeader } from './header-fit.js';

/**
 * jsdom has no layout, so the header reports the widths we give it: `need`
 * is how wide the content is at each compact step.
 * @param {number} width
 * @param {number[]} need
 */
function makeHeader(width, need) {
    const header = /** @type {HTMLElement & { _width: number }} */ (document.createElement('header'));
    header._width = width;
    header.innerHTML = '<h2>Title</h2><button class="btn-ghost"><svg></svg><span>Refresh</span></button>';
    Object.defineProperty(header, 'clientWidth', { get: () => header._width });
    Object.defineProperty(header, 'scrollWidth', {
        get: () => need[header.classList.contains('is-compact-2') ? 2 : header.classList.contains('is-compact') ? 1 : 0],
    });
    return header;
}

describe('page header fit', () => {
    it('keeps the full header when it fits', () => {
        const h = makeHeader(500, [480, 400, 300]);
        expect(fitHeader(h)).toBe(0);
        expect(h.className).toBe('');
        expect(h.querySelector('button')?.hasAttribute('title')).toBe(false);
    });

    it('turns buttons icon-only first, and gives them a tooltip', () => {
        const h = makeHeader(500, [620, 480, 300]);
        expect(fitHeader(h)).toBe(1);
        expect(h.classList.contains('is-compact')).toBe(true);
        expect(h.classList.contains('is-compact-2')).toBe(false);
        expect(h.querySelector('button')?.getAttribute('title')).toBe('Refresh');
    });

    it('hides secondary read-outs only when icon-only is not enough', () => {
        const h = makeHeader(500, [700, 560, 450]);
        expect(fitHeader(h)).toBe(2);
        expect(h.classList.contains('is-compact-2')).toBe(true);
    });

    it('steps back up and drops its own tooltip once there is room again', () => {
        const h = makeHeader(500, [620, 480, 300]);
        fitHeader(h);
        h._width = 800;
        expect(fitHeader(h)).toBe(0);
        expect(h.classList.contains('is-compact')).toBe(false);
        expect(h.querySelector('button')?.hasAttribute('title')).toBe(false);
    });

    it('leaves a title the button already had', () => {
        const h = makeHeader(500, [620, 480, 300]);
        h.querySelector('button')?.setAttribute('title', 'Auto scroll');
        fitHeader(h);
        expect(h.querySelector('button')?.getAttribute('title')).toBe('Auto scroll');
    });

    it('skips hidden pages', () => {
        const h = makeHeader(0, [620, 480, 300]);
        expect(fitHeader(h)).toBe(0);
        expect(h.className).toBe('');
    });
});
