// @ts-check
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createCssVarCache } from './css-var-cache.js';

describe('createCssVarCache', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        document.documentElement.removeAttribute('class');
        document.documentElement.removeAttribute('style');
    });

    it('reads a variable once and serves it from the cache afterwards', () => {
        document.documentElement.style.setProperty('--probe', ' red ');
        const spy = vi.spyOn(window, 'getComputedStyle');
        const cache = createCssVarCache();
        expect(cache.get('--probe')).toBe('red');
        expect(cache.get('--probe')).toBe('red');
        expect(spy).toHaveBeenCalledTimes(1);
    });

    it('re-reads after invalidate()', () => {
        const spy = vi.spyOn(window, 'getComputedStyle');
        const cache = createCssVarCache();
        cache.get('--probe');
        cache.invalidate();
        cache.get('--probe');
        expect(spy).toHaveBeenCalledTimes(2);
    });

    it('re-reads when the root class changes (e.g. dark mode toggled)', () => {
        const style = document.createElement('style');
        style.textContent = ':root { --probe: red; } :root.dark { --probe: blue; }';
        document.head.appendChild(style);
        try {
            const spy = vi.spyOn(window, 'getComputedStyle');
            const cache = createCssVarCache();
            expect(cache.get('--probe')).toBe('red');
            document.documentElement.classList.add('dark');
            expect(cache.get('--probe')).toBe('blue');
            expect(spy).toHaveBeenCalledTimes(2);
        } finally {
            style.remove();
        }
    });

    it('re-reads when the root inline style changes (e.g. accent color set)', () => {
        const cache = createCssVarCache();
        document.documentElement.style.setProperty('--probe', 'red');
        expect(cache.get('--probe')).toBe('red');
        document.documentElement.style.setProperty('--probe', 'blue');
        expect(cache.get('--probe')).toBe('blue');
    });

    it('re-reads when getRoot() returns a different element with the same attributes', () => {
        const a = document.createElement('div');
        const b = document.createElement('div');
        a.style.setProperty('--probe', 'red');
        b.style.setProperty('--probe', 'red');
        document.body.append(a, b);
        try {
            let root = a;
            const spy = vi.spyOn(window, 'getComputedStyle');
            const cache = createCssVarCache(() => root);
            cache.get('--probe');
            root = b;
            cache.get('--probe');
            expect(spy).toHaveBeenCalledTimes(2);
            expect(spy.mock.calls[1][0]).toBe(b);
        } finally {
            a.remove();
            b.remove();
        }
    });
});
