import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { pasteToElement } from './clipboard.js';

describe('clipboard utils - pasteToElement', () => {
    let originalClipboard;

    beforeEach(() => {
        originalClipboard = navigator.clipboard;
    });

    afterEach(() => {
        Object.defineProperty(navigator, 'clipboard', {
            value: originalClipboard,
            configurable: true,
            writable: true,
        });
    });

    it('returns false if targetInput is null or undefined', async () => {
        const result = await pasteToElement(null);
        expect(result).toBe(false);
    });

    it('pastes text, trims whitespace by default, focuses, and dispatches events', async () => {
        const mockInput = document.createElement('input');
        let inputFired = false;
        let changeFired = false;
        mockInput.addEventListener('input', () => { inputFired = true; });
        mockInput.addEventListener('change', () => { changeFired = true; });

        Object.defineProperty(navigator, 'clipboard', {
            value: {
                readText: vi.fn().mockResolvedValue('  https://example.com/sub   '),
            },
            configurable: true,
            writable: true,
        });

        const result = await pasteToElement(mockInput);
        expect(result).toBe(true);
        expect(mockInput.value).toBe('https://example.com/sub');
        expect(inputFired).toBe(true);
        expect(changeFired).toBe(true);
    });

    it('respects trim=false when requested', async () => {
        const mockTextarea = document.createElement('textarea');

        Object.defineProperty(navigator, 'clipboard', {
            value: {
                readText: vi.fn().mockResolvedValue('  custom text  '),
            },
            configurable: true,
            writable: true,
        });

        const result = await pasteToElement(mockTextarea, false);
        expect(result).toBe(true);
        expect(mockTextarea.value).toBe('  custom text  ');
    });

    it('inserts at cursor position / replaces selection when input has existing text', async () => {
        const mockInput = document.createElement('input');
        mockInput.value = 'hello world';
        mockInput.selectionStart = 5;
        mockInput.selectionEnd = 5;

        // happy-dom / jsdom setRangeText mock if not natively present on mock element
        if (!mockInput.setRangeText) {
            mockInput.setRangeText = function(replacement, start, end) {
                this.value = this.value.slice(0, start) + replacement + this.value.slice(end);
            };
        }

        Object.defineProperty(navigator, 'clipboard', {
            value: {
                readText: vi.fn().mockResolvedValue(' beautiful'),
            },
            configurable: true,
            writable: true,
        });

        const result = await pasteToElement(mockInput, false);
        expect(result).toBe(true);
        expect(mockInput.value).toBe('hello beautiful world');
    });

    it('handles clipboard read errors gracefully returning false', async () => {
        const mockInput = document.createElement('input');

        Object.defineProperty(navigator, 'clipboard', {
            value: {
                readText: vi.fn().mockRejectedValue(new Error('Permission denied')),
            },
            configurable: true,
            writable: true,
        });

        const result = await pasteToElement(mockInput);
        expect(result).toBe(false);
    });
});
