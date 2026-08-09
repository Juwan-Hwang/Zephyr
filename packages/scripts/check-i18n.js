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
// Static object literal parser
// ---------------------------------------------------------------------------

/**
 * Parse a JavaScript object literal into a runtime object — without
 * `eval`, `new Function`, or `vm.runInNewContext`.
 *
 * Supports the subset used in the translations object:
 * - Double- and single-quoted strings with standard escape sequences
 *   (\n \t \r \b \f \v \0 \\ \" \' \` \/ \uXXXX \u{...} \xXX)
 * - Nested object literals (for locale blocks and plural forms)
 * - Unquoted identifier keys (e.g. `en:`, `zh:`)
 * - Quoted string keys (e.g. `"key":`)
 * - Trailing commas (commas are consumed as trivia, so they are
 *   optional between properties — this is lenient but acceptable
 *   for a dev-only checker reading version-controlled source)
 *
 * String-parsing semantics are identical to the JS engine, so the checker
 * sees exactly what the runtime sees — no regex approximation.
 */

/**
 * Find the `{` that opens the `translations` object, then parse it
 * statically into a JavaScript object.
 *
 * @param {string} content - Full source text of i18n.js
 * @returns {Record<string, Record<string, unknown>>} The parsed translations object
 * @throws {Error} If the object cannot be found or parsed
 */
function loadTranslations(content) {
    // Locate `export const translations = {`
    const declMatch = /export\s+const\s+translations\s*=\s*\{/g.exec(content);
    if (!declMatch) {
        throw new Error('Could not find `export const translations = {` in i18n.js');
    }

    let pos = declMatch.index + declMatch[0].length - 1; // position of `{`

    // ---- Recursive descent parser ----------------------------------------

    const TRIVIA_CHARS = new Set([' ', '\t', '\n', '\r', ',']);

    /** Skip a `//` or block comment at `pos`. Returns true if one was skipped. */
    function skipComment() {
        if (content[pos] !== '/') return false;
        if (content[pos + 1] === '/') {
            pos += 2;
            while (pos < content.length && content[pos] !== '\n') pos++;
            return true;
        }
        if (content[pos + 1] === '*') {
            const end = content.indexOf('*/', pos + 2);
            pos = end === -1 ? content.length : end + 2;
            return true;
        }
        return false;
    }

    /** Advance over whitespace, commas, and comments. */
    function skipTrivia() {
        while (pos < content.length) {
            if (TRIVIA_CHARS.has(content[pos])) {
                pos++;
                continue;
            }
            if (!skipComment()) break;
        }
    }

    /** Simple (single-character) escape sequences. */
    const SIMPLE_ESCAPES = new Map([
        ['n', '\n'], ['t', '\t'], ['r', '\r'], ['b', '\b'],
        ['f', '\f'], ['v', '\v'], ['0', '\0'], ['\\', '\\'],
        ['"', '"'], ["'", "'"], ['`', '`'], ['/', '/'],
    ]);

    /** Decode a `\uXXXX` or `\u{...}` escape at the backslash `pos`. */
    function parseUnicodeEscape() {
        if (content[pos + 2] === '{') {
            const end = content.indexOf('}', pos + 3);
            if (end === -1) throw new Error(`Unterminated \\u{...} escape at position ${pos}`);
            const hex = content.substring(pos + 3, end);
            if (!/^[0-9a-fA-F]+$/.test(hex)) throw new Error(`Invalid \\u{...} escape at position ${pos}`);
            const code = Number.parseInt(hex, 16);
            if (code > 0x10FFFF) throw new Error(`Code point out of range in \\u{...} escape at position ${pos}`);
            pos = end + 1;
            return String.fromCodePoint(code);
        }
        const hex4 = content.substring(pos + 2, pos + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(hex4)) throw new Error(`Invalid \\u escape at position ${pos}`);
        pos += 6;
        return String.fromCodePoint(Number.parseInt(hex4, 16));
    }

    /** Decode a `\xXX` escape at the backslash `pos`. */
    function parseHexEscape() {
        const hex2 = content.substring(pos + 2, pos + 4);
        if (!/^[0-9a-fA-F]{2}$/.test(hex2)) throw new Error(`Invalid \\x escape at position ${pos}`);
        pos += 4;
        return String.fromCodePoint(Number.parseInt(hex2, 16));
    }

    /** Decode the escape sequence starting at the backslash at `pos`. */
    function parseEscape() {
        const next = content[pos + 1];
        const simple = SIMPLE_ESCAPES.get(next);
        if (simple !== undefined) { pos += 2; return simple; }
        if (next === 'u') return parseUnicodeEscape();
        if (next === 'x') return parseHexEscape();
        if (next === '\n' || next === '\r') {
            // Line continuation: consume backslash + line terminator
            pos += 2;
            if (next === '\r' && content[pos] === '\n') pos++; // CRLF
            return '';
        }
        // Unknown escape: keep the character after backslash (JS behavior)
        pos += 2;
        return next;
    }

    /** Parse a string literal (double- or single-quoted). */
    function parseString() {
        const quote = content[pos];
        pos++; // opening quote
        let result = '';
        while (pos < content.length) {
            const ch = content[pos];
            if (ch === '\\') {
                result += parseEscape();
            } else if (ch === quote) {
                pos++; // closing quote
                return result;
            } else {
                result += ch;
                pos++;
            }
        }
        throw new Error('Unterminated string literal in translations object');
    }

    /** Parse a property key (identifier or string). */
    function parseKey() {
        skipTrivia();
        if (content[pos] === '"' || content[pos] === "'") {
            return parseString();
        }
        const start = pos;
        while (pos < content.length && /[\w$-]/.test(content[pos])) pos++;
        if (pos === start) throw new Error(`Expected key at position ${pos}`);
        return content.substring(start, pos);
    }

    /** Parse a value: nested object or string literal. */
    function parseValue() {
        skipTrivia();
        const ch = content[pos];
        if (ch === '{') return parseObject();
        if (ch === '"' || ch === "'") return parseString();
        throw new Error(`Unsupported value '${ch}' at position ${pos} — only quoted strings and object literals are supported (numbers, booleans, null, template literals, and concatenated strings are not allowed)`);
    }

    /** Parse an object literal: { key: value, ... } */
    function parseObject() {
        pos++; // skip '{'
        // Use null prototype so a `__proto__` key is stored as an own
        // property, not on the prototype chain — visible to Object.keys().
        /** @type {Record<string, unknown>} */
        const obj = Object.create(null);
        skipTrivia();
        while (content[pos] !== '}') {
            if (pos >= content.length) throw new Error('Unterminated object literal');
            const key = parseKey();
            skipTrivia();
            if (content[pos] !== ':') throw new Error(`Expected ':' at position ${pos}`);
            pos++; // skip ':'
            obj[key] = parseValue();
            skipTrivia();
        }
        pos++; // skip '}'
        return obj;
    }

    const result = parseObject();
    if (!result || typeof result !== 'object') {
        throw new Error('translations object parsed to a non-object value');
    }
    return /** @type {Record<string, Record<string, unknown>>} */ (result);
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
    let translations;
    try {
        const content = readFileSync(I18N_PATH, 'utf-8');
        translations = loadTranslations(content);
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[check-i18n] ERROR: Failed to load translations from ${I18N_PATH}: ${msg}`);
        process.exit(1);
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

    let totalIssues = 0;

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
                } else if (val === '') {
                    // Empty string IS a string, so t() returns "" —
                    // the UI shows blank, with NO English fallback.
                    empty.push(key);
                }
            }
        }

        const localeKeyCount = Object.keys(localeObj).length;
        const localeIssues = missing.length + empty.length + typeMismatch.length + extra.length;
        totalIssues += localeIssues;

        if (localeIssues === 0) {
            console.log(`[${locale}] OK — ${localeKeyCount}/${enKeys.size} keys, 0 issues`);
        } else {
            console.log(`[${locale}] ${localeIssues} issue(s) — ${localeKeyCount}/${enKeys.size} keys present`);

            if (missing.length > 0) {
                console.log(`  Missing keys (${missing.length}, runtime falls back to English):`);
                for (const key of missing) {
                    console.log(`    - ${key}`);
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
                for (const key of typeMismatch) {
                    const enType = Array.isArray(enObj[key]) ? 'array' : typeof enObj[key];
                    const targetType = Array.isArray(localeObj[key]) ? 'array' : typeof localeObj[key];
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
