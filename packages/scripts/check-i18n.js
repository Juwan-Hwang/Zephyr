#!/usr/bin/env node
// @ts-check
/**
 * Zephyr i18n Completeness Checker
 *
 * Parses the `translations` object from i18n.js using a static recursive-
 * descent parser — no dynamic code execution (no eval, no new Function,
 * no vm.runInNewContext). This avoids SonarCloud security alerts while
 * preserving identical string-parsing semantics to the JavaScript runtime.
 *
 * Key design principle: the checker mirrors `resolveKey()` and `t()` from
 * i18n.js — using `hasOwnProperty` for key existence (same as resolveKey)
 * and `typeof value === 'string'` for value type (same as t()).
 *
 * Reports:
 *   - Missing keys per locale (present in `en` but absent in target —
 *     runtime falls back to English)
 *   - Empty-string keys per locale (present but blank — runtime shows "",
 *     does NOT fall back to English)
 *   - Type-mismatched keys per locale (en value is string but target is
 *     not — runtime returns the raw key name instead of a translation)
 *   - Stale keys per locale (present in target but absent from en — likely
 *     orphaned after an en key was renamed or removed)
 *   - Duplicate keys per locale (silently overwritten — a translation defect)
 *   - data-i18n / data-i18n-placeholder attributes used in HTML/JS but
 *     missing from en translations
 *
 * Exit codes:
 *   0  — always (warnings only; incomplete locales fall back to English)
 *   1  — when --strict is passed AND issues are found, or on fatal error
 */

import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const I18N_PATH = resolve(ROOT, 'apps/desktop/src/i18n.js');
const SRC_DIR = resolve(ROOT, 'apps/desktop/src');

// ---------------------------------------------------------------------------
// CLI flags
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const strict = args.includes('--strict');

// ---------------------------------------------------------------------------
// Static object literal parser (module-level class to keep cognitive
// complexity below SonarCloud's threshold — nested closures would
// attribute all branching to the enclosing function)
// ---------------------------------------------------------------------------

/**
 * Recursive-descent parser for JavaScript object literals — no `eval`,
 * `new Function`, or `vm.runInNewContext`.
 *
 * Supports the subset used in the translations object:
 * - Double- and single-quoted strings with standard escape sequences
 *   (\n \t \r \b \f \v \0 \\ \" \' \` \/ \uXXXX \u{...} \xXX)
 * - Nested object literals (for locale blocks and plural forms)
 * - Unquoted identifier keys (e.g. `en:`, `zh:`)
 * - Quoted string keys (e.g. `"key":`)
 * - Commas required between properties (with optional trailing
 *   comma before `}`), matching real JavaScript object-literal syntax
 */

/** Simple (single-character) escape sequences. */
const SIMPLE_ESCAPES = new Map([
    ['n', '\n'], ['t', '\t'], ['r', '\r'], ['b', '\b'],
    ['f', '\f'], ['v', '\v'], ['0', '\0'], ['\\', '\\'],
    ['"', '"'], ["'", "'"], ['`', '`'], ['/', '/'],
]);

const TRIVIA_CHARS = new Set([' ', '\t', '\n', '\r']);

class ObjectLiteralParser {
    /**
     * @param {string} content - Full source text
     * @param {number} startPos - Position of the opening `{`
     */
    constructor(content, startPos) {
        this.content = content;
        this.pos = startPos;
        /** @type {string[]} */
        this.duplicateKeys = [];
    }

    /** Skip a `//` or block comment. Returns true if one was skipped. */
    skipComment() {
        const { content } = this;
        if (content[this.pos] !== '/') return false;
        if (content[this.pos + 1] === '/') {
            this.pos += 2;
            while (this.pos < content.length && content[this.pos] !== '\n') this.pos++;
            return true;
        }
        if (content[this.pos + 1] === '*') {
            const end = content.indexOf('*/', this.pos + 2);
            this.pos = end === -1 ? content.length : end + 2;
            return true;
        }
        return false;
    }

    /** Advance over whitespace and comments. Commas are handled in parseObject(). */
    skipTrivia() {
        while (this.pos < this.content.length) {
            if (TRIVIA_CHARS.has(this.content[this.pos])) { this.pos++; continue; }
            if (!this.skipComment()) break;
        }
    }

    /** Decode a `\uXXXX` or `\u{...}` escape at the backslash `this.pos`. */
    parseUnicodeEscape() {
        const { content } = this;
        if (content[this.pos + 2] === '{') {
            const end = content.indexOf('}', this.pos + 3);
            if (end === -1) throw new Error(`Unterminated \\u{...} escape at position ${this.pos}`);
            const hex = content.substring(this.pos + 3, end);
            if (!/^[0-9a-fA-F]+$/.test(hex)) throw new Error(`Invalid \\u{...} escape at position ${this.pos}`);
            const code = Number.parseInt(hex, 16);
            if (code > 0x10FFFF) throw new Error(`Code point out of range in \\u{...} escape at position ${this.pos}`);
            this.pos = end + 1;
            return String.fromCodePoint(code);
        }
        const hex4 = content.substring(this.pos + 2, this.pos + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(hex4)) throw new Error(`Invalid \\u escape at position ${this.pos}`);
        this.pos += 6;
        return String.fromCodePoint(Number.parseInt(hex4, 16));
    }

    /** Decode a `\xXX` escape at the backslash `this.pos`. */
    parseHexEscape() {
        const hex2 = this.content.substring(this.pos + 2, this.pos + 4);
        if (!/^[0-9a-fA-F]{2}$/.test(hex2)) throw new Error(`Invalid \\x escape at position ${this.pos}`);
        this.pos += 4;
        return String.fromCodePoint(Number.parseInt(hex2, 16));
    }

    /** Decode the escape sequence starting at the backslash at `this.pos`. */
    parseEscape() {
        const next = this.content[this.pos + 1];
        if (next === undefined) throw new Error(`Unterminated escape sequence at position ${this.pos}`);
        const simple = SIMPLE_ESCAPES.get(next);
        if (simple !== undefined) { this.pos += 2; return simple; }
        if (next === 'u') return this.parseUnicodeEscape();
        if (next === 'x') return this.parseHexEscape();
        if (next === '\n' || next === '\r') {
            this.pos += 2;
            if (next === '\r' && this.content[this.pos] === '\n') this.pos++;
            return '';
        }
        this.pos += 2;
        return next;
    }

    /** Parse a string literal (double- or single-quoted). */
    parseString() {
        const { content } = this;
        const quote = content[this.pos];
        this.pos++;
        let result = '';
        while (this.pos < content.length) {
            const ch = content[this.pos];
            if (ch === '\\') result += this.parseEscape();
            else if (ch === quote) { this.pos++; return result; }
            else { result += ch; this.pos++; }
        }
        throw new Error('Unterminated string literal in translations object');
    }

    /** Parse a property key (identifier or string). */
    parseKey() {
        this.skipTrivia();
        const { content } = this;
        if (content[this.pos] === '"' || content[this.pos] === "'") return this.parseString();
        const start = this.pos;
        while (this.pos < content.length && /[\w$]/.test(content[this.pos])) this.pos++;
        if (this.pos === start) throw new Error(`Expected key at position ${this.pos}`);
        return content.substring(start, this.pos);
    }

    /** Parse a value: nested object or string literal. */
    parseValue(path = '') {
        this.skipTrivia();
        const ch = this.content[this.pos];
        if (ch === '{') return this.parseObject(path);
        if (ch === '"' || ch === "'") return this.parseString();
        throw new Error(`Unsupported value '${ch}' at position ${this.pos} — only quoted strings and object literals are supported (numbers, booleans, null, template literals, and concatenated strings are not allowed)`);
    }

    /** Parse an object literal: { key: value, ... } */
    parseObject(path = '') {
        this.pos++; // skip '{'
        /** @type {Record<string, unknown>} */
        const obj = Object.create(null);
        this.skipTrivia();
        while (this.content[this.pos] !== '}') {
            if (this.pos >= this.content.length) throw new Error('Unterminated object literal');
            const key = this.parseKey();
            this.skipTrivia();
            if (this.content[this.pos] !== ':') throw new Error(`Expected ':' at position ${this.pos}`);
            this.pos++;
            const qualified = path ? `${path}.${key}` : key;
            if (Object.hasOwn(obj, key)) this.duplicateKeys.push(qualified);
            obj[key] = this.parseValue(qualified);
            this.skipTrivia();
            // Require comma between properties; trailing comma allowed.
            if (this.content[this.pos] === ',') {
                this.pos++;
                this.skipTrivia();
            } else if (this.content[this.pos] !== '}') {
                throw new Error(`Expected ',' or '}' at position ${this.pos}`);
            }
        }
        this.pos++;
        return obj;
    }
}

/**
 * Find the `{` that opens the `translations` object, then parse it
 * statically into a JavaScript object.
 *
 * @param {string} content - Full source text of i18n.js
 * @returns {{translations: Record<string, Record<string, unknown>>, duplicates: string[]}}
 * @throws {Error} If the object cannot be found or parsed
 */
function loadTranslations(content) {
    const declMatch = /export\s+const\s+translations\s*=/.exec(content);
    if (!declMatch) throw new Error('Could not find `export const translations =` in i18n.js');

    const parser = new ObjectLiteralParser(content, declMatch.index + declMatch[0].length);
    // Skip whitespace and comments between `=` and `{`
    parser.skipTrivia();
    if (content[parser.pos] !== '{') {
        throw new Error(`Expected '{' after "export const translations =" at position ${parser.pos}`);
    }
    const result = parser.parseObject();
    if (!result || typeof result !== 'object') throw new Error('translations object parsed to a non-object value');
    return {
        translations: /** @type {Record<string, Record<string, unknown>>} */ (result),
        duplicates: parser.duplicateKeys,
    };
}

// ---------------------------------------------------------------------------
// data-i18n attribute extractor
// ---------------------------------------------------------------------------

/**
 * Recursively walk SRC_DIR and extract all unique keys from
 * data-i18n="key" and data-i18n-placeholder="key" attributes
 * in .html and .js files.
 *
 * @param {string} srcDir - Root directory to walk
 * @returns {Set<string>} Unique i18n keys referenced in HTML attributes
 */
function extractDataI18nKeys(srcDir) {
    const keys = new Set();
    const attrRegex = /data-i18n(?:-placeholder)?="(\w+)"/g;

    function walk(dir) {
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const full = join(dir, entry.name);
            if (entry.isDirectory()) {
                if (entry.name === 'node_modules' || entry.name === '.git') continue;
                walk(full);
            } else if (entry.isFile()) {
                const ext = extname(entry.name);
                if (ext !== '.html' && ext !== '.js') continue;
                try {
                    const content = readFileSync(full, 'utf-8');
                    let m;
                    while ((m = attrRegex.exec(content)) !== null) {
                        keys.add(m[1]);
                    }
                    attrRegex.lastIndex = 0;
                } catch { /* skip unreadable files */ }
            }
        }
    }

    walk(srcDir);
    return keys;
}

// ---------------------------------------------------------------------------
// Type-compatibility checker
// ---------------------------------------------------------------------------

/**
 * Check whether a target locale value's type is compatible with the English
 * value's type — matching the runtime `t()` function's dispatch.
 *
 * - en=string → target must be string. If target is an object, `t()`
 *   falls through to `typeof value === 'string' ? value : key` and returns
 *   the raw key name — a real type mismatch.
 * - en=object → target may be object (plural form) or string. When `t()`
 *   is called with a count and the resolved value is a string, the runtime
 *   interpolates it with `{count}` — no plural-category selection, but
 *   still a valid rendered string, not the raw key.
 *
 * @param {*} enValue - The English locale's value for this key
 * @param {*} targetValue - The target locale's value for this key
 * @returns {boolean} `true` if types are compatible, `false` on mismatch
 */
function isTypeCompatible(enValue, targetValue) {
    const targetIsString = typeof targetValue === 'string';
    const targetIsObject = typeof targetValue === 'object' && targetValue !== null;

    if (typeof enValue === 'string') return targetIsString;
    if (typeof enValue === 'object' && enValue !== null) return targetIsString || targetIsObject;
    return false;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
    let translations, duplicateKeys;
    try {
        const content = readFileSync(I18N_PATH, 'utf-8');
        ({ translations, duplicates: duplicateKeys } = loadTranslations(content));
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[check-i18n] ERROR: Failed to load translations from ${I18N_PATH}: ${msg}`);
        process.exit(1);
    }

    let totalIssues = 0;

    if (duplicateKeys.length > 0) {
        console.log('Duplicate keys detected in translations object:');
        for (const key of duplicateKeys) console.log(`  - ${key}`);
        console.log('');
        totalIssues += duplicateKeys.length;
    }

    // Use the exact same lookup that resolveKey() uses at runtime:
    //   translations.en  →  the base locale
    const enObj = translations.en;
    if (!enObj || typeof enObj !== 'object') {
        console.error(`[check-i18n] ERROR: "en" locale not found or invalid in ${I18N_PATH}`);
        process.exit(1);
    }

    // Object.keys() returns own enumerable properties — exactly what
    // resolveKey() iterates over via hasOwnProperty.
    const enKeys = new Set(Object.keys(enObj));

    // Discover all target locales dynamically: every key in translations
    // except 'en'. This never goes stale when new languages are added.
    const targetLocales = Object.keys(translations).filter(l => l !== 'en');

    if (targetLocales.length === 0) {
        console.error('[check-i18n] ERROR: No target locales found in translations object');
        process.exit(1);
    }

    console.log('========================================');
    console.log('  Zephyr i18n Completeness Report');
    console.log(`  Base locale "en": ${enKeys.size} keys`);
    console.log('========================================\n');

    for (const locale of targetLocales) {
        const localeObj = translations[locale];
        if (!localeObj || typeof localeObj !== 'object') {
            console.error(`[check-i18n] ERROR: Locale "${locale}" is defined but has no object value`);
            totalIssues += enKeys.size;
            continue;
        }

        // Mirror resolveKey(): check hasOwnProperty for each en key.
        // If the key exists in the target locale, resolveKey() returns
        // its value (even if it's ""). If not, resolveKey() falls back
        // to the en value.
        const missing = [];
        const empty = [];
        const typeMismatch = [];
        const extra = Object.keys(localeObj).filter(k => !enKeys.has(k));

        for (const key of enKeys) {
            if (!Object.hasOwn(localeObj, key)) {
                // Key absent → runtime falls back to English
                missing.push(key);
            } else {
                const val = localeObj[key];
                const enVal = enObj[key];

                if (!isTypeCompatible(enVal, val)) {
                    // Type mismatch: en is string but target is not.
                    // At runtime, t() returns the raw key name
                    // instead of a translation.
                    typeMismatch.push(key);
                } else if (typeof val === 'string' && val.trim() === '') {
                    // Empty or whitespace-only string — t() returns it,
                    // the UI shows blank, with NO English fallback.
                    empty.push(key);
                } else if (typeof enVal === 'object' && enVal !== null &&
                           typeof val === 'object' && val !== null) {
                    // Recursively check nested plural-object keys:
                    for (const sub of Object.keys(enVal)) {
                        if (!Object.hasOwn(val, sub)) {
                            missing.push(`${key}.${sub}`);
                        } else if (typeof val[sub] !== 'string') {
                            typeMismatch.push(`${key}.${sub}`);
                        } else if (val[sub].trim() === '') {
                            empty.push(`${key}.${sub}`);
                        }
                    }
                    // Detect stale nested sub-keys (in target but not in en)
                    for (const sub of Object.keys(val)) {
                        if (!Object.hasOwn(enVal, sub)) extra.push(`${key}.${sub}`);
                    }
                }
            }
        }

        const localeKeyCount = Object.keys(localeObj).filter(k => enKeys.has(k)).length;
        const localeIssues = missing.length + empty.length + typeMismatch.length + extra.length;
        totalIssues += localeIssues;

        if (localeIssues === 0) {
            console.log(`[${locale}] OK — ${localeKeyCount}/${enKeys.size} keys, 0 issues`);
        } else {
            console.log(`[${locale}] ${localeIssues} issue(s) — ${localeKeyCount}/${enKeys.size} keys present`);

            if (missing.length > 0) {
                // Distinguish top-level missing (falls back to English)
                // from nested plural sub-key missing (falls back to 'other'
                // form within the same locale).
                const topMissing = missing.filter(k => !k.includes('.'));
                const nestedMissing = missing.filter(k => k.includes('.'));
                if (topMissing.length > 0) {
                    console.log(`  Missing keys (${topMissing.length}, runtime falls back to English):`);
                    for (const key of topMissing) console.log(`    - ${key}`);
                }
                if (nestedMissing.length > 0) {
                    console.log(`  Missing nested keys (${nestedMissing.length}, runtime falls back to 'other' form in same locale):`);
                    for (const key of nestedMissing) console.log(`    - ${key}`);
                }
            }

            if (empty.length > 0) {
                console.log(`  Empty-string keys (${empty.length}, blank at runtime — no English fallback):`);
                for (const key of empty) {
                    console.log(`    - ${key}`);
                }
            }

            if (typeMismatch.length > 0) {
                console.log(`  Type-mismatched keys (${typeMismatch.length}, runtime returns raw key name):`);
                // Resolve dotted paths (e.g. "plurals.one") before type lookup
                const resolvePath = (root, path) =>
                    path.split('.').reduce((acc, part) =>
                        (acc && typeof acc === 'object' && Object.hasOwn(acc, part)) ? acc[part] : undefined, root);
                for (const key of typeMismatch) {
                    const enResolved = resolvePath(enObj, key);
                    const targetResolved = resolvePath(localeObj, key);
                    const enType = Array.isArray(enResolved) ? 'array' : typeof enResolved;
                    const targetType = Array.isArray(targetResolved) ? 'array' : typeof targetResolved;
                    console.log(`    - ${key} (en: ${enType}, ${locale}: ${targetType})`);
                }
            }

            if (extra.length > 0) {
                console.log(`  Stale keys (${extra.length}, present in ${locale} but not in en):`);
                for (const key of extra) {
                    console.log(`    - ${key}`);
                }
            }
        }

        console.log('');
    }

    // -----------------------------------------------------------------------
    // Check data-i18n / data-i18n-placeholder attribute coverage
    // -----------------------------------------------------------------------

    console.log('========================================');
    console.log('  data-i18n Attribute Coverage');
    console.log('========================================\n');

    const htmlI18nKeys = extractDataI18nKeys(SRC_DIR);
    const htmlMissing = [...htmlI18nKeys].filter(k => !enKeys.has(k));

    if (htmlMissing.length === 0) {
        console.log(`OK — all ${htmlI18nKeys.size} data-i18n keys found in en translations\n`);
    } else {
        console.log(`MISSING — ${htmlMissing.length} data-i18n attribute(s) not in en translations:`);
        for (const key of htmlMissing) {
            console.log(`  - ${key}`);
        }
        console.log('');
        totalIssues += htmlMissing.length;
    }

    console.log('----------------------------------------');
    console.log(`  Total issues: ${totalIssues}`);
    console.log('----------------------------------------');

    if (totalIssues > 0) {
        console.log('\nNOTE: Some locales may have incomplete translations.');
        console.log('      Missing keys fall back to English; empty strings show blank.');
        console.log('      Re-run with --strict to make this check fail (exit 1).\n');

        if (strict) {
            process.exit(1);
        }
    }
}

main();
