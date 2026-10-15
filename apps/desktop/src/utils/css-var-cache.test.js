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
        const spy = vi.spyOn(window, 'getComputedStyle');
        const cache = createCssVarCache();
        cache.get('--probe');
        document.documentElement.classList.add('dark');
        cache.get('--probe');
        expect(spy).toHaveBeenCalledTimes(2);
    });

    it('re-reads when the root inline style changes (e.g. accent color set)', () => {
        const cache = createCssVarCache();
        document.documentElement.style.setProperty('--probe', 'red');
        expect(cache.get('--probe')).toBe('red');
        document.documentElement.style.setProperty('--probe', 'blue');
        expect(cache.get('--probe')).toBe('blue');
    });
});
