import { describe, it, expect } from 'vitest';
import { renderLogLineHtml, findSearchRanges, SEARCH_MARK_OPEN } from './log-highlight.js';

const COLORS = Object.freeze({ debug: '#d', info: '#i', warn: '#w', error: '#e' });
const FALLBACK = '#f';
const mark = (/** @type {string} */ s) => `${SEARCH_MARK_OPEN}${s}</mark>`;
const lvl = (/** @type {string} */ c, /** @type {string} */ s) => `<span style="color:${c};font-weight:600">${s}</span>`;

/** Visible text after the HTML is parsed, as the user would see it. */
function visibleText(/** @type {string} */ html) {
    return new DOMParser().parseFromString(html, 'text/html').body.textContent;
}

describe('findSearchRanges', () => {
    it('maps length-expanding lower-case matches back to the raw text', () => {
        // 'İ'.toLowerCase() is 'i' + U+0307, so the filter accepts both queries.
        expect(findSearchRanges('xİy', 'i\u0307')).toEqual([[1, 2]]);
        expect(findSearchRanges('xİy', 'i')).toEqual([[1, 2]]);
        expect(findSearchRanges('İ-İ', 'İ')).toEqual([[0, 1], [2, 3]]);
    });

    it('follows whole-string lower-casing (final sigma) on expanding lines', () => {
        // The filter lower-cases the whole line, so 'ΟΣ' becomes 'ος' (final
        // sigma); the İ forces the length-changing path.
        const line = 'ΟΣ İ';
        expect(line.toLowerCase().includes('ος')).toBe(true);
        expect(findSearchRanges(line, 'ος')).toEqual([[0, 2]]);
        expect(findSearchRanges(line, 'ος i')).toEqual([[0, 4]]);
    });

    it('is case-insensitive like the filter', () => {
        expect(findSearchRanges('Foo foo FOO', 'foo')).toEqual([[0, 3], [4, 7], [8, 11]]);
    });
    it('returns nothing for an empty query', () => {
        expect(findSearchRanges('abc', '')).toEqual([]);
    });
    it('does not overlap matches', () => {
        expect(findSearchRanges('aaaa', 'aa')).toEqual([[0, 2], [2, 4]]);
    });
});

describe('renderLogLineHtml', () => {
    it('escapes a plain line without search', () => {
        expect(renderLogLineHtml('a < b & c', '', COLORS, FALLBACK)).toBe('a &lt; b &amp; c');
    });

    it('returns empty string for an empty line', () => {
        expect(renderLogLineHtml('', 'x', COLORS, FALLBACK)).toBe('');
    });

    it.each(['amp', 'lt', 'gt'])('searching "%s" never splits an HTML entity', (q) => {
        const line = 'a & b < c > d';
        const html = renderLogLineHtml(line, q, COLORS, FALLBACK);
        expect(html).not.toContain('<mark');
        expect(visibleText(html)).toBe(line);
    });

    it('searching "quot" only marks literal text', () => {
        const line = 'say "hi" quota';
        const html = renderLogLineHtml(line, 'quot', COLORS, FALLBACK);
        // Quotes are escaped as entities, so a search over escaped HTML would
        // have marked the "quot" inside `&quot;`; raw-text matching must not.
        expect(html).toBe(`say &quot;hi&quot; ${mark('quot')}a`);
        expect(visibleText(html)).toBe(line);
    });

    it('highlights queries containing special characters', () => {
        const html = renderLogLineHtml('tag <b>bold</b>', '<b', COLORS, FALLBACK);
        expect(html).toBe(`tag ${mark('&lt;b')}&gt;bold&lt;/b&gt;`);
    });

    it('highlights ampersand queries', () => {
        expect(renderLogLineHtml('a&b', '&', COLORS, FALLBACK)).toBe(`a${mark('&amp;')}b`);
    });

    it('keeps the original casing inside the mark', () => {
        expect(renderLogLineHtml('Hello World', 'world', COLORS, FALLBACK)).toBe(`Hello ${mark('World')}`);
    });

    it('colours bracket and level= tags exactly as before', () => {
        expect(renderLogLineHtml('[ERROR] boom', '', COLORS, FALLBACK)).toBe(`${lvl('#e', '[ERROR]')} boom`);
        expect(renderLogLineHtml('time=1 level=warning msg', '', COLORS, FALLBACK))
            .toBe(`time=1 ${lvl('#w', 'level=warn')}ing msg`); // same alternation order as before
    });

    it('uses the fallback colour for unknown level keys', () => {
        expect(renderLogLineHtml('[DEBUG] x', '', { info: '#i' }, FALLBACK)).toBe(`${lvl('#f', '[DEBUG]')} x`);
    });

    it('escapes level colours before putting them in the style attribute', () => {
        const html = renderLogLineHtml('[INFO] x', '', { info: 'red" onclick="x' }, FALLBACK);
        expect(html).not.toContain('" onclick="');
        const span = new DOMParser().parseFromString(html, 'text/html').body.querySelector('span');
        expect(span?.getAttributeNames()).toEqual(['style']);
    });

    it('keeps level colouring when the search hits inside the tag', () => {
        const html = renderLogLineHtml('[INFO] started', 'inf', COLORS, FALLBACK);
        expect(html).toBe(`${lvl('#i', `[${mark('INF')}O]`)} started`);
    });

    it('nests correctly when a match crosses a level tag boundary', () => {
        const html = renderLogLineHtml('[INFO] started', 'o] st', COLORS, FALLBACK);
        expect(html).toBe(`${lvl('#i', `[INF${mark('O]')}`)}${mark(' st')}arted`);
        expect(visibleText(html)).toBe('[INFO] started');
    });

    it('does not let level tags inside search text break escaping', () => {
        const line = 'level=info msg="<x> & y"';
        const html = renderLogLineHtml(line, 'x', COLORS, FALLBACK);
        expect(visibleText(html)).toBe(line);
        expect(html).toContain(`&lt;${mark('x')}&gt;`);
    });
});
