import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { pasteToElement, normalizePastedText, renderPasteButtonHtml } from './clipboard.js';

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

    it('respects trim=false and preserves leading/trailing whitespace for textarea', async () => {
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

    it('appends to existing textarea content on a new line when no selection is active', async () => {
        const mockTextarea = document.createElement('textarea');
        document.body.appendChild(mockTextarea);
        mockTextarea.value = 'https://doh.pub/dns-query';

        Object.defineProperty(navigator, 'clipboard', {
            value: {
                readText: vi.fn().mockResolvedValue('https://dns.alidns.com/dns-query'),
            },
            configurable: true,
            writable: true,
        });

        const result = await pasteToElement(mockTextarea);
        expect(result).toBe(true);
        expect(mockTextarea.value).toBe('https://doh.pub/dns-query\nhttps://dns.alidns.com/dns-query');
        document.body.removeChild(mockTextarea);
    });

    it('preserves exact existing whitespace and avoids double newlines when trim=false on textarea', async () => {
        const mockTextarea = document.createElement('textarea');
        document.body.appendChild(mockTextarea);
        mockTextarea.value = 'custom args line 1\n  ';

        Object.defineProperty(navigator, 'clipboard', {
            value: {
                readText: vi.fn().mockResolvedValue('  custom args line 2  '),
            },
            configurable: true,
            writable: true,
        });

        const result = await pasteToElement(mockTextarea, false);
        expect(result).toBe(true);
        expect(mockTextarea.value).toBe('custom args line 1\n  \n  custom args line 2  ');
        document.body.removeChild(mockTextarea);
    });

    it('does not insert duplicate newline if textarea already ends with newline', async () => {
        const mockTextarea = document.createElement('textarea');
        document.body.appendChild(mockTextarea);
        mockTextarea.value = 'https://doh.pub/dns-query\n';

        Object.defineProperty(navigator, 'clipboard', {
            value: {
                readText: vi.fn().mockResolvedValue('https://dns.alidns.com/dns-query'),
            },
            configurable: true,
            writable: true,
        });

        const result = await pasteToElement(mockTextarea);
        expect(result).toBe(true);
        expect(mockTextarea.value).toBe('https://doh.pub/dns-query\nhttps://dns.alidns.com/dns-query');
        document.body.removeChild(mockTextarea);
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

    it('replaces selected range when clicking paste button even if button receives focus', async () => {
        const wrapper = document.createElement('div');
        const input = document.createElement('input');
        input.value = 'https://example.com/prefix/old_token/suffix';
        const button = document.createElement('button');

        if (!input.setRangeText) {
            input.setRangeText = function(replacement, start, end) {
                this.value = this.value.slice(0, start) + replacement + this.value.slice(end);
            };
        }

        wrapper.appendChild(input);
        wrapper.appendChild(button);
        document.body.appendChild(wrapper);

        // User selected "old_token" (indices 27..36)
        input.selectionStart = 27;
        input.selectionEnd = 36;

        // Clicking button moves focus to button
        button.focus();
        expect(document.activeElement).toBe(button);

        button.addEventListener('click', async (e) => {
            e.preventDefault();
            await pasteToElement(input);
        });

        Object.defineProperty(navigator, 'clipboard', {
            value: {
                readText: vi.fn().mockResolvedValue('new_token'),
            },
            configurable: true,
            writable: true,
        });

        button.click();
        await new Promise(resolve => setTimeout(resolve, 10));

        expect(input.value).toBe('https://example.com/prefix/new_token/suffix');
        expect(document.activeElement).toBe(input);

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

    describe('multiline normalization for single-line inputs', () => {
        it('extracts and trims first non-empty line when pasting multiline text into single-line <input>', async () => {
            const mockInput = document.createElement('input');

            Object.defineProperty(navigator, 'clipboard', {
                value: {
                    readText: vi.fn().mockResolvedValue('line1\nline2\nline3'),
                },
                configurable: true,
                writable: true,
            });

            const result = await pasteToElement(mockInput);
            expect(result).toBe(true);
            expect(mockInput.value).toBe('line1');
        });

        it('skips empty leading lines when pasting multiline text into single-line <input>', async () => {
            const mockInput = document.createElement('input');

            Object.defineProperty(navigator, 'clipboard', {
                value: {
                    readText: vi.fn().mockResolvedValue('   \r\n  https://my-sub.com/clash   \r\nline2'),
                },
                configurable: true,
                writable: true,
            });

            const result = await pasteToElement(mockInput);
            expect(result).toBe(true);
            expect(mockInput.value).toBe('https://my-sub.com/clash');
        });

        it('normalizes pasted text with normalizePastedText utility across LF, CRLF, and CR linebreaks', () => {
            const inputEl = document.createElement('input');
            const textareaEl = document.createElement('textarea');

            expect(normalizePastedText(inputEl, 'foo\nbar\nbaz')).toBe('foo');
            expect(normalizePastedText(inputEl, '\n  hello world  \nfoo')).toBe('hello world');
            expect(normalizePastedText(inputEl, '   \r  cr-line1  \rcr-line2')).toBe('cr-line1');
            expect(normalizePastedText(inputEl, '  single line  ', false)).toBe('  single line  ');
            expect(normalizePastedText(textareaEl, 'foo\nbar\nbaz')).toBe('foo\nbar\nbaz');
            expect(normalizePastedText(textareaEl, '  foo\r\nbar  ')).toBe('foo\r\nbar');
        });

        it('handles CR-only clipboard line endings when pasting into single-line <input>', async () => {
            const mockInput = document.createElement('input');

            Object.defineProperty(navigator, 'clipboard', {
                value: {
                    readText: vi.fn().mockResolvedValue('   \r  https://cr-only.com/sub   \rline2'),
                },
                configurable: true,
                writable: true,
            });

            const result = await pasteToElement(mockInput);
            expect(result).toBe(true);
            expect(mockInput.value).toBe('https://cr-only.com/sub');
        });

        it('does not mutate input value or dispatch events when clipboard is empty or whitespace only', async () => {
            const mockInput = document.createElement('input');
            mockInput.value = 'original-url';
            let eventFired = false;
            mockInput.addEventListener('input', () => { eventFired = true; });

            Object.defineProperty(navigator, 'clipboard', {
                value: {
                    readText: vi.fn().mockResolvedValue('   \n  \t  '),
                },
                configurable: true,
                writable: true,
            });

            const result = await pasteToElement(mockInput);
            expect(result).toBe(false);
            expect(mockInput.value).toBe('original-url');
            expect(eventFired).toBe(false);
        });

        it('does not append newline or mutate textarea when clipboard is empty string', async () => {
            const mockTextarea = document.createElement('textarea');
            mockTextarea.value = 'existing-line';
            let eventFired = false;
            mockTextarea.addEventListener('input', () => { eventFired = true; });

            Object.defineProperty(navigator, 'clipboard', {
                value: {
                    readText: vi.fn().mockResolvedValue(''),
                },
                configurable: true,
                writable: true,
            });

            const result = await pasteToElement(mockTextarea);
            expect(result).toBe(false);
            expect(mockTextarea.value).toBe('existing-line');
            expect(eventFired).toBe(false);
        });

        it('preserves existing textarea whitespace when appending pasted text', async () => {
            const mockTextarea = document.createElement('textarea');
            mockTextarea.value = 'first line   \n  second line  ';

            Object.defineProperty(navigator, 'clipboard', {
                value: {
                    readText: vi.fn().mockResolvedValue('third line'),
                },
                configurable: true,
                writable: true,
            });

            const result = await pasteToElement(mockTextarea);
            expect(result).toBe(true);
            expect(mockTextarea.value).toBe('first line   \n  second line  \nthird line');
        });
    });

    describe('renderPasteButtonHtml', () => {
        it('renders input paste button with btn-input-paste class and i18n attributes', () => {
            const html = renderPasteButtonHtml('my-btn', 'Paste');
            expect(html).toContain('id="my-btn"');
            expect(html).toContain('class="btn-input-paste"');
            expect(html).toContain('title="Paste"');
            expect(html).toContain('aria-label="Paste"');
            expect(html).toContain('data-i18n-title="paste"');
            expect(html).toContain('data-i18n-aria-label="paste"');
            expect(html).toContain('<svg');
        });

        it('renders textarea paste button with btn-textarea-paste class', () => {
            const html = renderPasteButtonHtml('textarea-btn', 'Paste', true);
            expect(html).toContain('id="textarea-btn"');
            expect(html).toContain('class="btn-textarea-paste"');
        });
    });
});
