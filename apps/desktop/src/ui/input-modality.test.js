import { describe, it, expect } from 'vitest';
import { initInputModality } from './input-modality.js';

describe('input modality', () => {
    it('marks keyboard navigation and clears it on pointer press', () => {
        initInputModality(document);
        const root = document.documentElement;
        expect(root.classList.contains('kb-nav')).toBe(false);
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
        expect(root.classList.contains('kb-nav')).toBe(false);
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }));
        expect(root.classList.contains('kb-nav')).toBe(true);
        document.dispatchEvent(new Event('pointerdown'));
        expect(root.classList.contains('kb-nav')).toBe(false);
    });
});
