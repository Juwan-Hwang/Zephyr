import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { selectSegment } from './seg-control.js';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(resolve(SRC, 'index.html'), 'utf8');
const css = readFileSync(resolve(SRC, 'styles.css'), 'utf8');

describe('selectSegment', () => {
    beforeEach(() => {
        document.body.innerHTML = `<div class="seg-control" id="c">
            <div class="seg-thumb"></div>
            <button class="seg-btn"></button><button class="seg-btn"></button><button class="seg-btn"></button>
        </div>`;
    });

    it('moves the thumb and presses exactly one button', () => {
        const c = document.getElementById('c');
        selectSegment(c, 2);
        const pressed = [...c.querySelectorAll('.seg-btn')].map((b) => b.getAttribute('aria-pressed'));
        expect(pressed).toEqual(['false', 'false', 'true']);
        expect(c.querySelector('.seg-thumb').style.transform).toContain('200%');
        selectSegment(c, 0);
        expect(c.querySelector('.seg-thumb').style.transform).toBe('');
    });

    it('hides the thumb for an unknown value', () => {
        const c = document.getElementById('c');
        selectSegment(c, -1);
        expect(c.querySelector('.seg-thumb').classList.contains('is-hidden')).toBe(true);
        expect(c.querySelectorAll('[aria-pressed="true"]').length).toBe(0);
    });
});

describe('settings segmented controls share one implementation', () => {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const ids = ['setting-theme-mode-container', 'setting-ui-scale-container', 'setting-home-mode-container'];

    it.each(ids)('%s is a .seg-control with a .seg-thumb and .seg-btn buttons', (id) => {
        const el = doc.getElementById(id);
        expect(el).not.toBeNull();
        expect(el.classList.contains('seg-control')).toBe(true);
        expect(el.querySelectorAll(':scope > .seg-thumb').length).toBe(1);
        const btns = el.querySelectorAll(':scope > button');
        expect(btns.length).toBeGreaterThan(1);
        btns.forEach((b) => expect(b.classList.contains('seg-btn')).toBe(true));
        expect(el.getAttribute('style')).toContain(`--seg-count: ${btns.length}`);
    });

    it('no control paints its own selected state or radius', () => {
        expect(css).not.toMatch(/\.seg-item\b/);
        for (const id of ids) {
            const el = doc.getElementById(id);
            el.querySelectorAll('*').forEach((n) => expect(n.className).not.toMatch(/rounded-|bg-\[|shadow-/));
        }
    });
});
