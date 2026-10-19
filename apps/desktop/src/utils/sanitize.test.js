import { describe, it, expect } from 'vitest';
import { escapeHtml, escapeAttr, sanitizeHtml } from './sanitize.js';

describe('escapeHtml', () => {
    it('escapes < and >', () => {
        expect(escapeHtml('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
    });
    it('escapes &', () => expect(escapeHtml('a & b')).toBe('a &amp; b'));
    it('escapes double quotes', () => expect(escapeHtml('"hello"')).toBe('&quot;hello&quot;'));
    it('escapes single quotes', () => expect(escapeHtml("it's")).toBe('it&#39;s'));
    it('escapes all five significant characters', () => {
        expect(escapeHtml('<div class="test">&"content\'</div>'))
            .toBe('&lt;div class=&quot;test&quot;&gt;&amp;&quot;content&#39;&lt;/div&gt;');
    });
    it('does not double-unescape existing entities', () => {
        expect(escapeHtml('&amp;&lt;')).toBe('&amp;amp;&amp;lt;');
    });
    it('handles empty string', () => expect(escapeHtml('')).toBe(''));
    it('handles string without special chars', () => expect(escapeHtml('hello world')).toBe('hello world'));
    it('returns empty string for non-string input', () => {
        expect(escapeHtml(/** @type {any} */ (null))).toBe('');
        expect(escapeHtml(/** @type {any} */ (undefined))).toBe('');
        expect(escapeHtml(/** @type {any} */ (42))).toBe('');
    });
    it('does not Unicode-normalize the input (full-width and compatibility characters are preserved)', () => {
        expect(escapeHtml('香港０１｜ＩＰＬＣ')).toBe('香港０１｜ＩＰＬＣ');
        expect(escapeHtml('ﬁ ① ㎏')).toBe('ﬁ ① ㎏');
        // Full-width angle brackets are not HTML-significant and stay as-is.
        expect(escapeHtml('＜b＞')).toBe('＜b＞');
    });
    it('cannot break out of a double-quoted attribute', () => {
        const payload = '" style="position:fixed;inset:0" x="';
        const host = document.createElement('div');
        // eslint-disable-next-line no-unsanitized/property -- test: verifies escaping
        host.innerHTML = `<button data-id="${escapeHtml(payload)}">x</button>`;
        const btn = /** @type {HTMLElement} */ (host.firstElementChild);
        expect(btn.getAttribute('style')).toBeNull();
        expect(btn.dataset.id).toBe(payload);
    });
    it('cannot break out of a single-quoted attribute', () => {
        const payload = "' onclick='alert(1)";
        const host = document.createElement('div');
        // eslint-disable-next-line no-unsanitized/property -- test: verifies escaping
        host.innerHTML = `<button title='${escapeHtml(payload)}'>x</button>`;
        const btn = /** @type {HTMLElement} */ (host.firstElementChild);
        expect(btn.getAttribute('onclick')).toBeNull();
        expect(btn.title).toBe(payload);
    });
});

describe('escapeAttr', () => {
    it('is equivalent to escapeHtml', () => {
        const input = '<a href="x">it\'s & more</a>';
        expect(escapeAttr(input)).toBe(escapeHtml(input));
    });
    it('returns empty string for non-string input', () => {
        expect(escapeAttr(/** @type {any} */ (null))).toBe('');
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
    it('forces rel="noopener noreferrer" on anchors with target="_blank"', () => {
        const sanitized = sanitizeHtml('<a href="https://example.com" target="_blank">link</a>');
        expect(sanitized).toContain('rel="noopener noreferrer"');
        expect(sanitized).toContain('target="_blank"');
    });
    it('overwrites existing rel with noopener noreferrer when target is present', () => {
        const sanitized = sanitizeHtml('<a href="https://example.com" target="_blank" rel="opener">link</a>');
        expect(sanitized).toContain('rel="noopener noreferrer"');
        // The old rel="opener" should be replaced — verify no standalone rel="opener" remains
        expect(sanitized).not.toMatch(/rel="opener"/);
    });
    it('does not add rel when anchor has no target attribute', () => {
        const sanitized = sanitizeHtml('<a href="https://example.com">link</a>');
        expect(sanitized).not.toContain('rel=');
    });

    /* eslint-disable no-script-url */
    it('strips javascript: URIs from xlink:href on SVG <use>', () => {
        const sanitized = sanitizeHtml('<svg><use xlink:href="javascript:alert(1)"></use></svg>');
        expect(sanitized).not.toContain('javascript:');
        expect(sanitized).not.toContain('xlink:href');
    });
    /* eslint-enable no-script-url */
    it('keeps fragment references in xlink:href on SVG <use>', () => {
        const sanitized = sanitizeHtml('<svg><use xlink:href="#icon-check"></use></svg>');
        expect(sanitized).toContain('xlink:href="#icon-check"');
    });

    it.each([
        ['tab entity', 'java&#9;script:alert(1)'],
        ['newline entity', 'java&#10;script:alert(1)'],
        ['CR entity', 'java&#13;script:alert(1)'],
        ['leading control char', '&#1;javascript:alert(1)'],
        ['vbscript', 'vbscript:msgbox(1)'],
    ])('strips obfuscated script URIs (%s) from a[href] and use[xlink:href]', (_name, uri) => {
        const a = sanitizeHtml(`<a href="${uri}">x</a>`);
        expect(a).not.toContain('href=');
        const use = sanitizeHtml(`<svg><use xlink:href="${uri}"></use></svg>`);
        expect(use).not.toContain('xlink:href');
    });

    it('still allows ordinary links', () => {
        expect(sanitizeHtml('<a href="https://example.com/a?b=1">x</a>')).toContain('href="https://example.com/a?b=1"');
        expect(sanitizeHtml('<a href="#section">x</a>')).toContain('href="#section"');
    });
});
