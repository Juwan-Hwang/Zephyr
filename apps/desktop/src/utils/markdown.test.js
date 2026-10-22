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

    it('picks a free delimiter in one pass when many private-use characters occur', () => {
        let pua = '';
        for (let c = 0xE000; c < 0xF8FF; c++) pua += String.fromCharCode(c);
        const started = performance.now();
        const html = markdownToHtml(`${'x'.repeat(500_000)}${pua} \`a<b\``);
        expect(performance.now() - started).toBeLessThan(1_000);
        expect(html).toContain('a&lt;b');
        expect(html).toContain('\uF8FE');
    });

    it('keeps every character as plain text when all private-use characters occur', () => {
        let pua = '';
        for (let c = 0xE000; c <= 0xF8FF; c++) pua += String.fromCharCode(c);
        const html = markdownToHtml(`${pua} \`a<b\``);
        expect(html).toContain('a&lt;b');
        expect(html).toContain('\uE000');
        expect(html).toContain('\uF8FF');
    });

    it('wraps lines that start with inline markup but not block elements', () => {
        const html = markdownToHtml('**New** features\n\n[Docs](https://example.com) updated\n\n## Title\n\n- item');
        expect(html).toMatch(/<p[^>]*><strong[^>]*>New<\/strong> features<\/p>/);
        expect(html).toMatch(/<p[^>]*><a [^>]*>Docs<\/a> updated<\/p>/);
        expect(html).not.toMatch(/<p[^>]*><h3/);
        expect(html).not.toMatch(/<p[^>]*><(?:ul|li)/);
    });
});

describe('markdownToHtml link targets', () => {
    it('keeps emphasis delimiters inside a link URL', () => {
        const html = markdownToHtml('See [notes](https://example.com/a*b*c) and **bold**');
        expect(html).toContain('href="https://example.com/a*b*c"');
        expect(html).toContain('<strong');
    });

    it('keeps double asterisks and tildes in a URL', () => {
        const html = markdownToHtml('[x](https://e.com/**y**~~z~~)');
        expect(html).toContain('href="https://e.com/**y**~~z~~"');
        expect(html).not.toContain('<del');
    });

    it('leaves a stray ]( that is no link as written', () => {
        const html = markdownToHtml('odd](text) here');
        expect(html).toContain('odd](text) here');
    });

    it('still applies emphasis after a stray ]( with no [ before it', () => {
        const html = markdownToHtml('odd](see *this*) here');
        expect(html).toContain('<em>this</em>');
    });

    it('restores inline code inside an unused target', () => {
        const html = markdownToHtml('[](`text`) here');
        expect(html).toContain('<code');
        expect(html).toContain('>text</code>');
        expect(html).not.toContain('INLINECODE');
        expect(html).not.toContain('HREF_');
    });

    it('keeps a fenced code block that sits inside a (…) as a block', () => {
        const html = markdownToHtml('[see](\n```\nsecret code\n```\n)');
        expect(html).toContain('<pre');
        expect(html).toContain('secret code');
        expect(html).not.toContain('<a ');
        expect(html).not.toContain('CODEBLOCK');
    });

    it('keeps backticks in a link URL as part of the address', () => {
        const html = markdownToHtml('[x](https://e.com/`a<b`)');
        expect(html).toContain('href="https://e.com/`a<b`"');
        expect(html).not.toContain('<code');
        expect(html).not.toContain('INLINECODE');
    });

    it('still shows image alt text only', () => {
        const html = markdownToHtml('![logo](https://e.com/*a*.png)');
        expect(html).toContain('[logo]');
        expect(html).not.toContain('<img');
    });
});
