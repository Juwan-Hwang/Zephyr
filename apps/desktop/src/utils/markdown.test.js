// @ts-check
import { describe, it, expect } from 'vitest';
import { markdownToHtml } from './markdown.js';

describe('markdownToHtml', () => {
    it('renders inline and fenced code', () => {
        const html = markdownToHtml('Use `a<b` here\n\n```\nx < y\n```');
        expect(html).toContain('a&lt;b');
        expect(html).toContain('x &lt; y');
    });

    it('keeps literal private-use characters in prose and code', () => {
        const html = markdownToHtml('note \uE000 one\n\n```\ncode \uE000\n```\n\n`in \uE000line`');
        expect(html.split('\uE000').length - 1).toBe(3);
        expect(html).toContain('<pre');
        expect(html).toContain('<code');
    });
});
