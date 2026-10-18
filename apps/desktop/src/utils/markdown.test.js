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

    it('handles input that already contains the delimiter character', () => {
        const html = markdownToHtml('a \uE000\uE000 b `x<y`');
        expect(html).toContain('x&lt;y');
        expect(html.split('\uE000').length - 1).toBe(2);
        const adjacent = markdownToHtml('x \uE000`y<z`\uE000');
        expect(adjacent).toContain('y&lt;z');
        expect(adjacent.split('\uE000').length - 1).toBe(2);
    });

    it('stays fast on a long run of the delimiter character', () => {
        const run = '\uE000'.repeat(200_000);
        const started = performance.now();
        const html = markdownToHtml(`${run} \`a<b\`\n\n\`\`\`\nc<d\n\`\`\``);
        expect(performance.now() - started).toBeLessThan(1_000);
        expect(html).toContain('a&lt;b');
        expect(html).toContain('c&lt;d');
        expect(html.split('\uE000').length - 1).toBe(200_000);
    });
});
