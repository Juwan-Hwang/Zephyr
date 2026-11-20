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

    it('ignores caret keys typed in a text field but not Tab', () => {
        initInputModality(document);
        const root = document.documentElement;
        root.classList.remove('kb-nav');
        const input = document.createElement('input');
        document.body.appendChild(input);
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
        expect(root.classList.contains('kb-nav')).toBe(false);
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
        expect(root.classList.contains('kb-nav')).toBe(true);
        input.remove();
    });

    it('treats arrow keys on a clicked select as keyboard navigation', () => {
        initInputModality(document);
        const root = document.documentElement;
        const select = document.createElement('select');
        document.body.appendChild(select);
        select.dispatchEvent(new Event('pointerdown', { bubbles: true }));
        expect(root.classList.contains('kb-nav')).toBe(false);
        select.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
        expect(root.classList.contains('kb-nav')).toBe(true);
        select.remove();
    });
});
