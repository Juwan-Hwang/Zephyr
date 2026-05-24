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

/**
 * Escape HTML entities to prevent XSS.
 * Uses the browser's built-in textContent/innerHTML round-trip
 * for reliable, spec-compliant escaping.
 *
 * @param {string} str - Raw string to escape
 * @returns {string} HTML-safe string; empty string for non-string input
 */
export function escapeHtml(str) {
    if (typeof str !== 'string') return '';
    const normalized = str.normalize('NFKC');
    const div = document.createElement('div');
    div.textContent = normalized;
    return div.innerHTML;
}

/**
 * Escape a string for safe use inside HTML attribute values (double-quoted).
 * Extends {@link escapeHtml} by also escaping `"` and `'`.
 *
 * @param {string} str - Raw string to escape
 * @returns {string} Attribute-safe string
 */
export function escapeAttr(str) {
    if (typeof str !== 'string') return '';
    return escapeHtml(str)
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// ---------------------------------------------------------------------------
// Whitelist HTML Sanitizer
// ---------------------------------------------------------------------------

const IS_BROWSER = typeof document !== 'undefined';

/** @type {DOMParser|null} Shared singleton parser */
let _sharedParser = null;

function getParser() {
    if (!_sharedParser && IS_BROWSER) {
        _sharedParser = new DOMParser();
    }
    return _sharedParser;
}

/** Default allowed tags — conservative, security-first whitelist */
const DEFAULT_ALLOWED_TAGS = new Set([
    'strong', 'em', 'b', 'i', 'u', 'br', 'span', 'p', 'div',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'ul', 'ol', 'li', 'a', 'img', 'code', 'pre',
    'table', 'tr', 'td', 'th', 'hr', 'blockquote',
    // Form elements (needed for modal custom content)
    'input', 'label', 'button', 'textarea', 'select', 'option',
]);

/** Default per-tag attribute whitelist */
const DEFAULT_ALLOWED_ATTRS = {
    a:      new Set(['href', 'class', 'target', 'rel']),
    img:    new Set(['src', 'alt', 'width', 'height']),
    span:   new Set(['style', 'class']),
    div:    new Set(['class', 'id', 'style']),
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
    input:  new Set(['type', 'id', 'name', 'placeholder', 'value', 'class', 'disabled', 'readonly', 'checked', 'min', 'max', 'step']),
    label:  new Set(['for', 'class']),
    button: new Set(['type', 'id', 'class', 'disabled']),
    textarea: new Set(['id', 'name', 'placeholder', 'class', 'disabled', 'readonly', 'rows', 'cols']),
    select: new Set(['id', 'name', 'class', 'disabled', 'multiple']),
    option: new Set(['value', 'selected', 'disabled']),
};

/** Regex matching any on* event handler attribute */
const EVENT_HANDLER_RE = /^on/i;

/** Regex matching javascript: URIs (case-insensitive, whitespace tolerant) */
const JS_URI_RE = /^\s*javascript\s*:/i;

/** Regex matching data: URIs */
const DATA_URI_RE = /^\s*data\s*:/i;

/** NBSP entity pattern */
const NBSP_RE = /&nbsp;|&#160;|&#xA0;/gi;

/**
 * Check whether a URL is safe (not javascript: or disallowed data:).
 *
 * @param {string} url
 * @param {boolean} allowDataImages
 * @returns {boolean}
 */
function isSafeUrl(url, allowDataImages) {
    if (JS_URI_RE.test(url)) return false;
    if (DATA_URI_RE.test(url)) return allowDataImages;
    return true;
}

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

    const rawAttrs = /** @type {Record<string, Set<string>|string[]>} */ (options.allowedAttributes ?? DEFAULT_ALLOWED_ATTRS);
    /** @type {Record<string, Set<string>|string[]>} */
    const allowedAttributes = {};
    for (const tag of Object.keys(rawAttrs)) {
        allowedAttributes[tag] = rawAttrs[tag] instanceof Set
            ? rawAttrs[tag]
            : new Set(rawAttrs[tag]);
    }

    const keepChildren = options.keepChildrenWhenRemovingParent !== false;
    const removeNbsp   = !!options.removeNbsp;
    const allowDataImg = !!options.allowDataImages;

    // Parse with shared DOMParser
    const parser = getParser();
    if (!parser) return '';
    const doc = parser.parseFromString(normalized, 'text/html');

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
            if (keepChildren) {
                // Move children up before removing the node
                while (el.firstChild) {
                    el.parentNode?.insertBefore(el.firstChild, el);
                }
            }
            if (el.parentNode) el.parentNode.removeChild(el);
            return;
        }

        // Sanitize attributes
        const rawTagAttr = allowedAttributes[tag];
        const tagAttrWhitelist = rawTagAttr instanceof Set ? rawTagAttr : new Set(rawTagAttr);
        const attrsToRemove = [];

        for (const attr of Array.from(el.attributes)) {
            const name = attr.name.toLowerCase();

            // Strip ALL event handlers (onclick, onerror, onload, etc.)
            if (EVENT_HANDLER_RE.test(name)) {
                attrsToRemove.push(attr.name);
                continue;
            }

            // If attribute not in whitelist for this tag, remove it
            if (!tagAttrWhitelist.has(name)) {
                attrsToRemove.push(attr.name);
                continue;
            }

            // Validate URL attributes
            if (name === 'href' || name === 'src') {
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

        // Recurse into children (iterate in reverse since we may remove nodes)
        const children = Array.from(el.childNodes);
        for (const child of children) {
            sanitizeNode(child);
        }
    }

    // Sanitize all top-level nodes in body
    const bodyChildren = Array.from(doc.body.childNodes);
    for (const child of bodyChildren) {
        sanitizeNode(child);
    }

    return doc.body.innerHTML;
}

// ---------------------------------------------------------------------------
// Safe HTML Template Literal
// ---------------------------------------------------------------------------

/**
 * Safe HTML template literal tag.
 * Automatically escapes all ${} interpolations to prevent XSS.
 * Uses escapeAttr to ensure safety in both text and attribute contexts.
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
    const escape = (v) => {
        if (Array.isArray(v)) return v.map(escape).join('');
        return (v !== null && v !== undefined) ? escapeAttr(String(v)) : '';
    };
    const result = [strings[0]];
    for (let i = 0; i < values.length; i++) {
        result.push(escape(values[i]));
        result.push(strings[i + 1]);
    }
    return result.join('');
}

/**
 * Safe HTML template literal tag that also sanitizes the result.
 * Use this when the template may contain HTML tags that need to be preserved.
 * Note: Variables are NOT escaped before sanitization, allowing safe HTML tags
 * in variables to be preserved. Only use with trusted input.
 *
 * Usage:
 *   import { safeHtml } from './utils/sanitize.js';
 *   element.innerHTML = safeHtml`<div>${trustedHtml}</div>`;
 *
 * @param {TemplateStringsArray} strings - Template strings
 * @param {...any} values - Interpolated values (may contain safe HTML)
 * @returns {string} Sanitized HTML string
 */
export function safeHtml(strings, ...values) {
    const process = (v) => {
        if (Array.isArray(v)) return v.map(process).join('');
        return (v === null || v === undefined) ? '' : String(v);
    };
    const result = [strings[0]];
    for (let i = 0; i < values.length; i++) {
        result.push(process(values[i]));
        result.push(strings[i + 1]);
    }
    return sanitizeHtml(result.join(''));
}
