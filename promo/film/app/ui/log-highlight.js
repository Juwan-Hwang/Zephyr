// @ts-check
/**
 * Pure HTML rendering for a single core log line: level-tag colouring plus
 * search-match highlighting.
 *
 * Both are computed on the RAW text and every segment is escaped on its own,
 * so a query can never land inside an HTML entity (`&amp;`, `&lt;`, …) and
 * queries containing `<`, `>`, `&` or `"` highlight what the user sees.
 *
 * @module ui/log-highlight
 */

import { escapeHtml } from '../utils/sanitize.js';

/** Level tags coloured inline (supports both `[INFO]` and `level=info`). */
const LEVEL_TAG_RE = /\[(?:DEBUG|INFO|WARNING|WARN|ERROR|FATAL)\]|level=(?:debug|info|warning|warn|error|fatal)\b/gi;
const LEVEL_WORD_RE = /DEBUG|INFO|WARN|WARNING|ERROR|FATAL/i;

export const SEARCH_MARK_OPEN = '<mark class="bg-accent/30 text-accent rounded px-0.5">';
const SEARCH_MARK_CLOSE = '</mark>';

/**
 * Find search matches in raw text, using the same case rule as the log filter
 * (`line.toLowerCase().includes(query.toLowerCase())`).
 * @param {string} text
 * @param {string} query
 * @returns {Array<[number, number]>} non-overlapping [start, end) ranges
 */
export function findSearchRanges(text, query) {
    /** @type {Array<[number, number]>} */
    const ranges = [];
    if (!query) return ranges;
    const lowerText = text.toLowerCase();
    const lowerQuery = query.toLowerCase();
    if (lowerText.length === text.length && lowerQuery.length === query.length) {
        let from = 0;
        for (;;) {
            const idx = lowerText.indexOf(lowerQuery, from);
            if (idx < 0) break;
            ranges.push([idx, idx + query.length]);
            from = idx + query.length;
        }
        return ranges;
    }
    // Lower-casing changed the length (e.g. `İ` → `i̇`). Work out which raw
    // character produced each lowered unit, run the same substring search on
    // the filter's own whole-string lower-casing (so context-dependent rules
    // such as Greek final sigma match exactly what the filter accepted), then
    // map the hits back onto the raw text. Only lines whose length changes
    // reach this path, and the map is one typed array per such line.
    let loweredLength = 0;
    for (let i = 0; i < text.length;) {
        const ch = String.fromCodePoint(/** @type {number} */ (text.codePointAt(i)));
        loweredLength += ch.toLowerCase().length;
        i += ch.length;
    }
    /** lowered index → raw index */
    const toRaw = new Uint32Array(loweredLength + 1);
    let lowered = '';
    for (let i = 0, j = 0; i < text.length;) {
        const ch = String.fromCodePoint(/** @type {number} */ (text.codePointAt(i)));
        const low = ch.toLowerCase();
        for (let k = 0; k < low.length; k++) toRaw[j++] = i;
        if (loweredLength !== lowerText.length) lowered += low;
        i += ch.length;
    }
    toRaw[loweredLength] = text.length;
    // Context-dependent mappings keep the length per character, so the
    // whole-string result lines up with the map; keep the per-character
    // string only for the (theoretical) case where it does not.
    if (loweredLength === lowerText.length) lowered = lowerText;
    let from = 0;
    for (;;) {
        const idx = lowered.indexOf(lowerQuery, from);
        if (idx < 0) break;
        const end = idx + lowerQuery.length;
        const rawStart = toRaw[idx];
        // End after the whole raw character that produced the last lowered unit.
        let k = end - 1;
        while (toRaw[k + 1] === toRaw[end - 1]) k++;
        const rawEnd = toRaw[k + 1];
        if (rawEnd > rawStart && (ranges.length === 0 || rawStart >= ranges[ranges.length - 1][1])) {
            ranges.push([rawStart, rawEnd]);
        }
        from = end;
    }
    return ranges;
}

/**
 * Render one log line to HTML.
 * @param {string} line - raw log line
 * @param {string} query - current search query ('' for none)
 * @param {Readonly<Record<string, string>>} levelColors - level → colour
 * @param {string} fallbackColor - colour when a level key is missing
 * @returns {string} HTML-safe string
 */
export function renderLogLineHtml(line, query, levelColors, fallbackColor) {
    if (typeof line !== 'string' || line.length === 0) return '';

    /** @type {Array<{ start: number, end: number, color: string }>} */
    const levels = [];
    LEVEL_TAG_RE.lastIndex = 0;
    let m;
    while ((m = LEVEL_TAG_RE.exec(line)) !== null) {
        const w = m[0].match(LEVEL_WORD_RE);
        if (!w) continue;
        const word = w[0].toUpperCase();
        // WARNING shares WARN's colour; FATAL is shown as an error.
        const key = word === 'WARNING' ? 'warn' : (word === 'FATAL' ? (levelColors.fatal ? 'fatal' : 'error') : word.toLowerCase());
        levels.push({ start: m.index, end: m.index + m[0].length, color: levelColors[key] || fallbackColor });
    }

    const marks = findSearchRanges(line, query);
    if (levels.length === 0 && marks.length === 0) return escapeHtml(line);

    // Split the raw text at every level/mark boundary.
    const cuts = new Set([0, line.length]);
    for (const l of levels) { cuts.add(l.start); cuts.add(l.end); }
    for (const [s, e] of marks) { cuts.add(s); cuts.add(e); }
    const points = [...cuts].sort((a, b) => a - b);

    let html = '';
    /** @type {{ start: number, end: number, color: string } | null} */
    let openLevel = null;
    let markOpen = false;
    let li = 0;
    let mi = 0;
    for (let p = 0; p < points.length - 1; p++) {
        const a = points[p];
        const b = points[p + 1];
        while (li < levels.length && levels[li].end <= a) li++;
        while (mi < marks.length && marks[mi][1] <= a) mi++;
        const level = li < levels.length && levels[li].start <= a ? levels[li] : null;
        const marked = mi < marks.length && marks[mi][0] <= a;

        if (level !== openLevel) {
            if (markOpen) { html += SEARCH_MARK_CLOSE; markOpen = false; }
            if (openLevel) html += '</span>';
            if (level) html += `<span style="color:${escapeHtml(level.color)};font-weight:600">`;
            openLevel = level;
        }
        if (marked && !markOpen) { html += SEARCH_MARK_OPEN; markOpen = true; }
        if (!marked && markOpen) { html += SEARCH_MARK_CLOSE; markOpen = false; }
        html += escapeHtml(line.slice(a, b));
    }
    if (markOpen) html += SEARCH_MARK_CLOSE;
    if (openLevel) html += '</span>';
    return html;
}

// ── Structured core log lines ─────────────────────────────────────────────

/** mihomo logfmt line: time="…" level=info msg="…" (msg may contain escaped quotes). */
const CORE_LINE_RE = /^time="([^"]*)"\s+level=(\w+)\s+msg="((?:[^"\\]|\\.)*)"\s*$/;

/**
 * Split a mihomo core log line into its parts.
 * @param {string} line
 * @returns {{ time: string, level: 'debug'|'info'|'warn'|'error'|'fatal', msg: string } | null}
 *   null when the line is not in the logfmt shape (callers fall back to raw rendering)
 */
export function parseCoreLogLine(line) {
    if (typeof line !== 'string') return null;
    const m = CORE_LINE_RE.exec(line);
    if (!m) return null;
    const raw = m[2].toLowerCase();
    const level = raw === 'warning' ? 'warn' : raw;
    if (!['debug', 'info', 'warn', 'error', 'fatal'].includes(level)) return null;
    const msg = m[3].replace(/\\(["\\])/g, '$1');
    return { time: m[1], level: /** @type {'debug'|'info'|'warn'|'error'|'fatal'} */ (level), msg };
}

/** @type {Intl.DateTimeFormat | null} */
let _timeFmt = null;

/**
 * Format an RFC 3339 timestamp as local HH:mm:ss; returns the input when it cannot be parsed.
 * @param {string} iso
 * @returns {string}
 */
export function formatLogTime(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    if (!_timeFmt) {
        _timeFmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
    }
    return _timeFmt.format(d);
}

/**
 * Escape `text` and wrap the search matches in <mark>.
 * @param {string} text
 * @param {string} query
 * @returns {string}
 */
export function highlightText(text, query) {
    const marks = findSearchRanges(text, query);
    if (marks.length === 0) return escapeHtml(text);
    let html = '';
    let pos = 0;
    for (const [s, e] of marks) {
        html += escapeHtml(text.slice(pos, s)) + SEARCH_MARK_OPEN + escapeHtml(text.slice(s, e)) + SEARCH_MARK_CLOSE;
        pos = e;
    }
    return html + escapeHtml(text.slice(pos));
}

/**
 * Render a parsed core log line as time / level badge / message (same structure as app logs).
 * @param {{ time: string, level: string, msg: string }} parsed
 * @param {string} query
 * @returns {string} HTML-safe string
 */
export function renderStructuredLogHtml(parsed, query) {
    const local = formatLogTime(parsed.time);
    return `<span class="log-time" title="${escapeHtml(parsed.time)}">${highlightText(local, query)}</span>`
        + `<span class="log-badge" data-level="${escapeHtml(parsed.level)}">${escapeHtml(parsed.level.toUpperCase())}</span>`
        + `<span class="log-msg">${highlightText(parsed.msg, query)}</span>`;
}
