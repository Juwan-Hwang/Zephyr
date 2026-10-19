// @ts-check
/**
 * XSS prevention & whitelist HTML sanitization.
 * Extended with a full whitelist-based HTML sanitizer that provides
 * default security posture.
 *
 * @module sanitize
 */

// ---------------------------------------------------------------------------
// HTML entity escaping
// ---------------------------------------------------------------------------

/** Characters that are significant in HTML text and quoted attribute contexts. */
const HTML_ESCAPE_RE = /[&<>"']/g;

/** @type {Record<string, string>} */
const HTML_ESCAPE_MAP = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
};

/**
 * Escape HTML entities to prevent XSS.
 *
 * Escapes `&`, `<`, `>`, `"` and `'`, so the result is safe both as element
 * text and inside single- or double-quoted attribute values. Implemented as a
 * pure string replacement (no DOM allocation), so it is cheap on hot paths.
 *
 * The input is not Unicode-normalized: what is displayed is exactly the value
 * that was passed in (e.g. full-width characters in node or subscription
 * names are preserved). Normalization adds no safety here because only the
 * five ASCII characters above are significant to the HTML parser.
 *
 * @param {string} str - Raw string to escape
 * @returns {string} HTML-safe string; empty string for non-string input
 */
export function escapeHtml(str) {
    if (typeof str !== 'string') return '';
    return str.replace(HTML_ESCAPE_RE, (ch) => HTML_ESCAPE_MAP[ch]);
}

/**
 * Escape a string for safe use inside a QUOTED HTML attribute value
 * (`attr="..."` or `attr='...'`). Alias of {@link escapeHtml}, which already
 * escapes `"` and `'`; kept for call sites that want to state attribute
 * context explicitly.
 *
 * Not safe for unquoted attributes (`attr=${value}`): whitespace, `=` and
 * backticks are left as-is. Always quote the attribute.
 *
 * @param {string} str - Raw string to escape
 * @returns {string} Attribute-safe string
 */
export function escapeAttr(str) {
    return escapeHtml(str);
}

// ---------------------------------------------------------------------------
// Whitelist HTML Sanitizer
// ---------------------------------------------------------------------------

const IS_BROWSER = typeof document !== 'undefined';

/** Default allowed tags — conservative, security-first whitelist */
const DEFAULT_ALLOWED_TAGS = new Set([
    'strong', 'em', 'b', 'i', 'u', 'br', 'span', 'p', 'div',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'ul', 'ol', 'li', 'a', 'img', 'code', 'pre',
    'table', 'tr', 'td', 'th', 'hr', 'blockquote', 'del', 'ins',
    // Form elements (needed for modal custom content)
    'input', 'label', 'button', 'textarea', 'select', 'option',
    // SVG elements (used extensively for icons)
    'svg', 'path', 'circle', 'line', 'polyline', 'polygon',
    'rect', 'ellipse', 'g', 'use', 'defs', 'clippath',
    'text', 'tspan', 'stop', 'lineargradient', 'radialgradient',
]);

/** Default per-tag attribute whitelist */
const DEFAULT_ALLOWED_ATTRS = {
    a:      new Set(['href', 'class', 'target', 'rel', 'title']),
    img:    new Set(['src', 'alt', 'width', 'height']),
    span:   new Set(['style', 'class', 'title']),
    div:    new Set(['class', 'id', 'style', 'title']),
    p:      new Set(['class']),
    h1:     new Set(['class']),
    h2:     new Set(['class']),
    h3:     new Set(['class']),
    h4:     new Set(['class']),
    h5:     new Set(['class']),
    h6:     new Set(['class']),
    ul:     new Set(['class']),
    ol:     new Set(['class']),
    li:     new Set(['class']),
    code:   new Set(['class']),
    pre:    new Set(['class']),
    blockquote: new Set(['class']),
    hr:     new Set(['class']),
    table:  new Set(['class']),
    tr:     new Set(['class']),
    td:     new Set(['colspan', 'rowspan', 'class']),
    th:     new Set(['colspan', 'rowspan', 'class']),
    input:  new Set(['type', 'id', 'name', 'placeholder', 'value', 'class', 'disabled', 'readonly', 'checked', 'min', 'max', 'step', 'spellcheck', 'autocomplete', 'title']),
    label:  new Set(['for', 'class', 'title']),
    button: new Set(['type', 'id', 'class', 'disabled', 'title']),
    textarea: new Set(['id', 'name', 'placeholder', 'class', 'disabled', 'readonly', 'rows', 'cols', 'spellcheck', 'title']),
    select: new Set(['id', 'name', 'class', 'disabled', 'multiple', 'title']),
    option: new Set(['value', 'selected', 'disabled']),
    // SVG attributes
    svg:    new Set(['class', 'width', 'height', 'viewbox', 'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'xmlns', 'style']),
    path:   new Set(['d', 'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin']),
    circle: new Set(['cx', 'cy', 'r', 'fill', 'stroke', 'stroke-width']),
    line:   new Set(['x1', 'y1', 'x2', 'y2', 'stroke', 'stroke-width', 'stroke-linecap']),
    polyline: new Set(['points', 'fill', 'stroke', 'stroke-width', 'stroke-linejoin']),
    polygon: new Set(['points', 'fill', 'stroke', 'stroke-width', 'stroke-linejoin']),
    rect:   new Set(['x', 'y', 'width', 'height', 'rx', 'ry', 'fill', 'stroke', 'stroke-width']),
    ellipse: new Set(['cx', 'cy', 'rx', 'ry', 'fill', 'stroke', 'stroke-width']),
    g:      new Set(['class', 'id', 'fill', 'stroke', 'stroke-width', 'transform']),
    use:    new Set(['href', 'xlink:href', 'width', 'height']),
    defs:   new Set(['id']),
    clippath: new Set(['id']),
    text:   new Set(['x', 'y', 'fill', 'font-size', 'class']),
    tspan:  new Set(['x', 'y', 'fill', 'font-size', 'class']),
    stop:   new Set(['offset', 'stop-color', 'stop-opacity']),
    lineargradient: new Set(['id', 'x1', 'y1', 'x2', 'y2']),
    radialgradient: new Set(['id', 'cx', 'cy', 'r']),
};

/** Regex matching any on* event handler attribute */
const EVENT_HANDLER_RE = /^on/i;

/** Script-running schemes, matched against a normalized URL (see normalizeUrlScheme). */
const SCRIPT_SCHEME_RE = /^(?:javascript|vbscript):/;

/** data: scheme, matched against a normalized URL. */
const DATA_SCHEME_RE = /^data:/;

/** ASCII tab, LF and CR, which URL parsers drop from anywhere in a URL. */
const URL_TAB_NEWLINE_RE = /[\t\n\r]/g;

/** Leading/trailing C0 controls and spaces, which URL parsers trim. */
const URL_EDGE_CONTROLS_RE = /^[\u0000-\u0020]+|[\u0000-\u0020]+$/g;

/**
 * Reduce a URL to the form a browser parses its scheme from: edge C0
 * controls/spaces trimmed, tabs and newlines removed, lowercased. Without
 * this, `java&#9;script:` (decoded to a tab) would slip past a plain regex.
 * @param {string} url
 * @returns {string}
 */
function normalizeUrlScheme(url) {
    return url.replace(URL_EDGE_CONTROLS_RE, '').replace(URL_TAB_NEWLINE_RE, '').toLowerCase();
}

/** NBSP entity pattern (includes \u00A0 for browser-decoded entities) */
const NBSP_RE = /&nbsp;|&#160;|&#xA0;|\u00A0/gi;

/**
 * Tags whose content should always be fully discarded (not promoted)
 * when the tag itself is removed. These can contain executable or
 * dangerous content that must not leak into the document as text.
 */
const STRIP_CONTENT_TAGS = new Set(['script', 'style', 'iframe', 'noscript', 'object', 'embed', 'applet', 'template']);

/**
 * Check whether a URL is safe (no javascript:/vbscript:, data: only when allowed).
 *
 * @param {string} url
 * @param {boolean} allowDataImages
 * @returns {boolean}
 */
function isSafeUrl(url, allowDataImages) {
    const norm = normalizeUrlScheme(url);
    if (SCRIPT_SCHEME_RE.test(norm)) return false;
    if (DATA_SCHEME_RE.test(norm)) return allowDataImages;
    return true;
}

/**
 * Normalizes an attribute map to lowercase tag names and lowercase attribute sets.
 * @param {Record<string, Set<string>|string[]>} rawAttrs
 * @returns {Record<string, Set<string>>}
 */
function _normalizeAttrMap(rawAttrs) {
    /** @type {Record<string, Set<string>>} */
    const result = Object.create(null);
    for (const [tagKey, attrs] of Object.entries(rawAttrs)) {
        result[tagKey.toLowerCase()] = new Set(Array.from(attrs || []).map(a => a.toLowerCase()));
    }
    return result;
}

const NORMALIZED_DEFAULT_ALLOWED_ATTRS = Object.freeze(_normalizeAttrMap(DEFAULT_ALLOWED_ATTRS));

/**
 * Sanitize an HTML string using a strict whitelist approach.
 *
 * Only explicitly permitted tags and attributes survive. All event handlers,
 * javascript: URIs, and unapproved content are stripped.
 *
 * @param {string} input - Raw HTML string to sanitize
 * @param {Object}   [options]
 * @param {Set<string>|string[]} [options.allowedTags]          - Override default allowed tags
 * @param {Object<string, Set<string>|string[]>} [options.allowedAttributes] - Per-tag attribute whitelist
 * @param {boolean} [options.keepChildrenWhenRemovingParent=true] - Keep text of removed tags
 * @param {boolean} [options.removeNbsp=false]                    - Replace &nbsp; with regular space
 * @param {boolean} [options.allowDataImages=false]               - Permit data: URIs on img[src]
 * @returns {string} Sanitized HTML string
 */
export function sanitizeHtml(input, options = {}) {
    if (typeof input !== 'string' || !input) return '';
    const normalized = input.normalize('NFKC');

    if (!IS_BROWSER) {
        // SSR fallback: strip all tags, return plain text
        // Loop until stable to prevent reassembly attacks (e.g. <<script>> → <script>)
        let sanitized = normalized;
        let prev = '';
        while (sanitized !== prev) {
            prev = sanitized;
            sanitized = sanitized.replace(/<[^>]*>/g, '');
        }
        return sanitized;
    }

    // Resolve options
    const allowedTags = options.allowedTags instanceof Set
        ? options.allowedTags
        : new Set(options.allowedTags ?? DEFAULT_ALLOWED_TAGS);

    const allowedAttributes = options.allowedAttributes
        ? _normalizeAttrMap(options.allowedAttributes)
        : NORMALIZED_DEFAULT_ALLOWED_ATTRS;

    const keepChildren = options.keepChildrenWhenRemovingParent !== false;
    const removeNbsp   = !!options.removeNbsp;
    const allowDataImg = !!options.allowDataImages;

    // Parse with <template> element to preserve table fragments
    // (DOMParser.parseFromString with 'text/html' wraps content in <body>,
    //  causing the parser to discard orphan <tr>/<td>/<th>/<li> elements
    //  that lack their required parent context. <template>.content is a
    //  DocumentFragment that accepts any HTML without structural correction.)
    const template = document.createElement('template');
    // eslint-disable-next-line no-unsanitized/property -- sanitizer core: <template> is inert, no script execution
    template.innerHTML = normalized; // nosemgrep: js-innerhtml-assignment — verified safe, see eslint-disable above
    const fragment = template.content;

    // Recursive sanitizer — walks the tree depth-first
    /** @param {Node} node */
    function sanitizeNode(node) {
        // Text nodes are always safe
        if (node.nodeType === Node.TEXT_NODE) {
            if (removeNbsp && node.nodeValue) {
                node.nodeValue = node.nodeValue.replace(NBSP_RE, ' ');
            }
            return;
        }

        // Skip non-element nodes (comments, processing instructions, etc.)
        if (node.nodeType !== Node.ELEMENT_NODE) {
            if (node.parentNode) node.parentNode.removeChild(node);
            return;
        }

        const el = /** @type {Element} */ (node);
        const tag = el.tagName.toLowerCase();

        // If tag is not whitelisted, remove it (optionally keeping children)
        if (!allowedTags.has(tag)) {
            // Security-sensitive tags: always discard content entirely
            // (e.g., <script> source code must not leak as visible text)
            const stripContent = STRIP_CONTENT_TAGS.has(tag);
            if (keepChildren && !stripContent) {
                // Move children up before removing the node AND sanitize them.
                // The parent's child loop uses a static snapshot, so moved children
                // would otherwise be skipped — a security bypass vector.
                const parent = el.parentNode;
                if (parent) {
                    while (el.firstChild) {
                        const child = el.firstChild;
                        parent.insertBefore(child, el);
                        sanitizeNode(child);
                    }
                }
            }
            if (el.parentNode) el.parentNode.removeChild(el);
            return;
        }

        // Sanitize attributes
        const tagAttrWhitelist = allowedAttributes[tag];
        const attrsToRemove = [];

        for (const attr of Array.from(el.attributes)) {
            const name = attr.name.toLowerCase();

            // Strip ALL event handlers (onclick, onerror, onload, etc.)
            if (EVENT_HANDLER_RE.test(name)) {
                attrsToRemove.push(attr.name);
                continue;
            }

            // Allow data-* and aria-* attributes on all elements (safe: no code execution)
            if (name.startsWith('data-') || name.startsWith('aria-')) {
                continue;
            }

            // If attribute not in whitelist for this tag, remove it
            if (!tagAttrWhitelist?.has(name)) {
                attrsToRemove.push(attr.name);
                continue;
            }

            // Validate URL attributes (SVG <use> also takes the legacy xlink:href)
            if (name === 'href' || name === 'src' || name === 'xlink:href') {
                const val = (attr.value || '').trim();
                const allowData = (name === 'src' && tag === 'img' && allowDataImg);
                if (!isSafeUrl(val, allowData)) {
                    attrsToRemove.push(attr.name);
                    continue;
                }
            }

            // Validate style attribute — strip expressions and url()
            if (name === 'style') {
                const val = attr.value || '';
                if (/(?:expression|javascript|url\s*\()/i.test(val)) {
                    attrsToRemove.push(attr.name);
                    continue;
                }
            }
        }

        for (const attrName of attrsToRemove) {
            el.removeAttribute(attrName);
        }

        // Force safe rel on anchors with target to prevent reverse tabnabbing
        if (tag === 'a' && el.hasAttribute('target')) {
            el.setAttribute('rel', 'noopener noreferrer');
        }

        // Recurse into children (iterate in reverse since we may remove nodes)
        const children = Array.from(el.childNodes);
        for (const child of children) {
            sanitizeNode(child);
        }
    }

    // Sanitize all top-level nodes in fragment
    const fragmentChildren = Array.from(fragment.childNodes);
    for (const child of fragmentChildren) {
        sanitizeNode(child);
    }

    // Serialize: template.innerHTML getter reads from template.content,
    // which now contains the sanitized DOM tree.
    return template.innerHTML;
}

// ---------------------------------------------------------------------------
// Safe HTML Template Literal
// ---------------------------------------------------------------------------

/**
 * Escape a single value for safe interpolation inside an HTML template.
 * Arrays are flattened recursively; null/undefined produce empty strings.
 *
 * @param {any} v - Value to escape
 * @returns {string} HTML-safe string
 */
function _htmlEscape(v) {
    if (Array.isArray(v)) return v.map(_htmlEscape).join('');
    return (v !== null && v !== undefined) ? escapeAttr(String(v)) : '';
}

/**
 * Normalize a single value for safeHtml interpolation (no escaping —
 * the final result passes through sanitizeHtml whitelist filtering).
 * Arrays are flattened recursively; null/undefined produce empty strings.
 *
 * @param {any} v - Value to normalize
 * @returns {string} Raw string (will be sanitized later)
 */
function _htmlRaw(v) {
    if (Array.isArray(v)) return v.map(_htmlRaw).join('');
    return (v === null || v === undefined) ? '' : String(v);
}

/**
 * Safe HTML template literal tag.
 * Automatically escapes all ${} interpolations to prevent XSS.
 * Uses escapeAttr to ensure safety in both text and attribute contexts.
 * Arrays are flattened recursively without comma separators.
 *
 * ⚠ Limitations:
 *   - Not suitable for URL attributes (href, src) — escapeAttr does NOT
 *     block javascript:/data: URIs. Use safeHtml for attributes that
 *     accept URLs, or validate the URL before interpolation.
 *   - Does NOT support nesting — `html\`${html\`...\`}\`` will double-escape.
 *     For HTML composition, use safeHtml instead.
 *
 * Usage:
 *   import { html } from './utils/sanitize.js';
 *   element.innerHTML = html`<div>${userInput}</div>`;  // userInput is auto-escaped
 *
 * @param {TemplateStringsArray} strings - Template strings
 * @param {...any} values - Interpolated values
 * @returns {string} HTML-safe string with all values escaped
 */
export function html(strings, ...values) {
    const result = [strings[0]];
    for (let i = 0; i < values.length; i++) {
        result.push(_htmlEscape(values[i]));
        result.push(strings[i + 1]);
    }
    return result.join('');
}

/**
 * Safe HTML template literal tag that also sanitizes the result.
 * Use this when template variables contain HTML structure that needs to be
 * preserved (e.g., rich text with allowed tags). All interpolations pass
 * through the whitelist-based sanitizeHtml filter, which strips disallowed
 * tags, event handlers, and javascript: URIs.
 * Arrays are flattened recursively without comma separators.
 *
 * Usage:
 *   import { safeHtml } from './utils/sanitize.js';
 *   element.innerHTML = safeHtml`<div>${htmlContent}</div>`;
 *
 * @param {TemplateStringsArray} strings - Template strings
 * @param {...any} values - Interpolated values (may contain HTML)
 * @returns {string} Sanitized HTML string
 */
export function safeHtml(strings, ...values) {
    const result = [strings[0]];
    for (let i = 0; i < values.length; i++) {
        result.push(_htmlRaw(values[i]));
        result.push(strings[i + 1]);
    }
    return sanitizeHtml(result.join(''));
}
