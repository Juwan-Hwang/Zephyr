#!/usr/bin/env node
// @ts-check
/**
 * Zephyr i18n Completeness Checker
 *
 * Evaluates the `translations` object from i18n.js using the exact same
 * JavaScript semantics as the runtime — no regex approximation. This
 * guarantees that if the checker passes, the runtime i18n system will
 * behave identically.
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
 *   - data-i18n / data-i18n-placeholder attributes used in HTML/JS but
 *     missing from en translations
 *
 * Exit codes:
 *   0  — always (warnings only; incomplete locales fall back to English)
 *   1  — when --strict is passed AND issues are found
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
// Translations object evaluator
// ---------------------------------------------------------------------------

/**
 * Extract and evaluate the `translations` object from i18n.js source.
 *
 * By evaluating the actual object literal — using the same JavaScript string
 * parsing semantics as the runtime — we guarantee that what the checker sees
 * is exactly what the runtime sees. No regex approximation, no false positives
 * from mixed quotes, key names matching value prefixes, or any other edge case
 * that a regex-based parser would miss.
 *
 * The object literal is pure data (string literals + nested objects), so it
 * is safe to evaluate with `new Function`.
 *
 * @param {string} content - Full source text of i18n.js
 * @returns {Record<string, Record<string, unknown>>} The evaluated translations object
 */
function loadTranslations(content) {
    const startMatch = /export\s+const\s+translations\s*=\s*\{/g.exec(content);
    if (!startMatch) {
        throw new Error('Could not find `export const translations = {` in i18n.js');
    }

    // Track brace depth to find the matching `}`, being aware of string
    // literals so that braces inside strings don't affect depth tracking.
    const openBracePos = startMatch.index + startMatch[0].length - 1; // position of `{`
    let depth = 0;
    let inString = false;
    let stringChar = '';

    for (let i = openBracePos; i < content.length; i++) {
        const ch = content[i];

        if (inString) {
            if (ch === '\\') { i++; continue; }
            if (ch === stringChar) inString = false;
            continue;
        }

        if (ch === '"' || ch === "'" || ch === '`') {
            inString = true;
            stringChar = ch;
            continue;
        }

        if (ch === '{') depth++;
        if (ch === '}') {
            depth--;
            if (depth === 0) {
                const objectLiteral = content.substring(openBracePos, i + 1);
                // eslint-disable-next-line no-new-func
                return new Function('return ' + objectLiteral)();
            }
        }
    }

    throw new Error('Could not find end of translations object (unbalanced braces)');
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
// Main
// ---------------------------------------------------------------------------

function main() {
    const content = readFileSync(I18N_PATH, 'utf-8');
    const translations = loadTranslations(content);

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

        for (const key of enKeys) {
            if (!Object.prototype.hasOwnProperty.call(localeObj, key)) {
                // Key absent → runtime falls back to English
                missing.push(key);
            } else {
                // Key present → check if the value is an empty string.
                // At runtime, t() checks `typeof value === 'string'`.
                // An empty string IS a string, so t() returns "" —
                // the UI shows blank, with NO English fallback.
                const val = localeObj[key];
                if (typeof val === 'string' && val === '') {
                    empty.push(key);
                }
            }
        }

        const localeKeyCount = Object.keys(localeObj).length;
        const localeIssues = missing.length + empty.length;
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
