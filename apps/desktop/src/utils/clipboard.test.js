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

    it('replaces entire value for pre-filled unfocused input without corrupting or prepending text', async () => {
        const mockInput = document.createElement('input');
        document.body.appendChild(mockInput);
        mockInput.value = 'https://old-sub.com/yaml';
        // In browsers, an unfocused input has selectionStart=0, selectionEnd=0
        mockInput.selectionStart = 0;
        mockInput.selectionEnd = 0;

        Object.defineProperty(navigator, 'clipboard', {
            value: {
                readText: vi.fn().mockResolvedValue('https://new-sub.com/yaml'),
            },
            configurable: true,
            writable: true,
        });

        const result = await pasteToElement(mockInput);
        expect(result).toBe(true);
        expect(mockInput.value).toBe('https://new-sub.com/yaml');
        document.body.removeChild(mockInput);
    });

    it('replaces active selection when input is focused with selected text range', async () => {
        const mockInput = document.createElement('input');
        document.body.appendChild(mockInput);
        mockInput.value = 'hello WORLD test';
        mockInput.focus();
        mockInput.selectionStart = 6;
        mockInput.selectionEnd = 11;

        if (!mockInput.setRangeText) {
            mockInput.setRangeText = function(replacement, start, end) {
                this.value = this.value.slice(0, start) + replacement + this.value.slice(end);
            };
        }

        Object.defineProperty(navigator, 'clipboard', {
            value: {
                readText: vi.fn().mockResolvedValue('FRIENDS'),
            },
            configurable: true,
            writable: true,
        });

        const result = await pasteToElement(mockInput);
        expect(result).toBe(true);
        expect(mockInput.value).toBe('hello FRIENDS test');
        document.body.removeChild(mockInput);
    });

    it('handles button click wiring and updates associated input', async () => {
        const wrapper = document.createElement('div');
        const input = document.createElement('input');
        input.id = 'test-input';
        const button = document.createElement('button');
        button.id = 'test-paste-btn';

        wrapper.appendChild(input);
        wrapper.appendChild(button);
        document.body.appendChild(wrapper);

        let inputDispatched = false;
        let changeDispatched = false;
        input.addEventListener('input', () => { inputDispatched = true; });
        input.addEventListener('change', () => { changeDispatched = true; });

        button.addEventListener('click', async (e) => {
            e.preventDefault();
            await pasteToElement(input);
        });

        Object.defineProperty(navigator, 'clipboard', {
            value: {
                readText: vi.fn().mockResolvedValue('  https://test.com/api  '),
            },
            configurable: true,
            writable: true,
        });

        button.click();
        await new Promise(resolve => setTimeout(resolve, 10));

        expect(input.value).toBe('https://test.com/api');
        expect(inputDispatched).toBe(true);
        expect(changeDispatched).toBe(true);

        document.body.removeChild(wrapper);
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
