import { describe, it, expect } from 'vitest';
import { escapeHtml, sanitizeHtml } from './sanitize.js';

describe('escapeHtml', () => {
    it('escapes < and >', () => {
        expect(escapeHtml('<script>alert("xss")</script>')).toBe('&lt;script&gt;alert("xss")&lt;/script&gt;');
    });
    it('escapes &', () => expect(escapeHtml('a & b')).toBe('a &amp; b'));
    it('does not escape double quotes (textContent/innerHTML round-trip)', () => {
        // The browser's innerHTML does not escape double quotes in text nodes,
        // because they are not special in text content context.
        expect(escapeHtml('"hello"')).toBe('"hello"');
    });
    it('does not escape single quotes (textContent/innerHTML round-trip)', () => {
        // Same as double quotes — single quotes are safe in text nodes.
        expect(escapeHtml("it's")).toBe("it's");
    });
    it('handles empty string', () => expect(escapeHtml('')).toBe(''));
    it('handles string without special chars', () => expect(escapeHtml('hello world')).toBe('hello world'));
    it('escapes <, >, & (quotes are NOT escaped by textContent/innerHTML round-trip)', () => {
        expect(escapeHtml('<div class="test">&"content\'</div>'))
            .toBe('&lt;div class="test"&gt;&amp;"content\'&lt;/div&gt;');
    });
});

describe('sanitizeHtml', () => {
    it('allows safe tags', () => {
        expect(sanitizeHtml('<b>bold</b>')).toBe('<b>bold</b>');
        expect(sanitizeHtml('<i>italic</i>')).toBe('<i>italic</i>');
        expect(sanitizeHtml('<code>code</code>')).toBe('<code>code</code>');
    });
    it('removes script tags', () => {
        expect(sanitizeHtml('<script>alert("xss")</script>')).not.toContain('script');
    });
    it('removes event handlers', () => {
        expect(sanitizeHtml('<div onclick="alert(1)">click</div>')).not.toContain('onclick');
    });
    it('handles empty string', () => expect(sanitizeHtml('')).toBe(''));
    it('handles plain text', () => expect(sanitizeHtml('hello world')).toBe('hello world'));
    it('preserves svg viewBox and button title attributes', () => {
        const svgHtml = '<button type="button" title="Paste" data-i18n-title="paste"><svg viewBox="0 0 24 24" fill="none"><path d="M16 4h2"></path></svg></button>';
        const sanitized = sanitizeHtml(svgHtml);
        expect(sanitized).toContain('title="Paste"');
        expect(sanitized).toContain('data-i18n-title="paste"');
        expect(sanitized).toContain('viewBox="0 0 24 24"');
    });
    it('safely strips attributes from allowed tags without configured attribute whitelist', () => {
        const input = '<em class="highlight" id="test-em" onclick="alert(1)">emphasized</em> and <strong style="color:red">strong</strong>';
        const sanitized = sanitizeHtml(input);
        expect(sanitized).toBe('<em>emphasized</em> and <strong>strong</strong>');
    });
    it('normalizes caller-supplied allowedAttributes keys to lowercase', () => {
        const sanitized = sanitizeHtml('<SPAN TITLE="hi" class="x">t</SPAN>', {
            allowedTags: ['span'],
            allowedAttributes: { SPAN: ['TITLE'] },
        });
        expect(sanitized).toContain('title="hi"');
        expect(sanitized).not.toContain('class');
    });
});
