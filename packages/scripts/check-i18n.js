#!/usr/bin/env node
// @ts-check
/**
 * Zephyr i18n Completeness Checker
 *
 * Extracts translation keys from apps/desktop/src/i18n.js using a
 * brace-depth-aware parser (no AST dependency, no DOM dependency).
 *
 * Reports:
 *   - Missing keys per locale (present in `en` but absent in target)
 *   - Empty-string keys per locale (present but will fallback to English)
 *   - data-i18n / data-i18n-placeholder attributes used in HTML/JS but
 *     missing from en translations
 *
 * Exit codes:
 *   0  — always (warnings only; ja/ko are known skeleton translations)
 *   1  — when --strict is passed AND issues are found
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
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
// Brace-depth-aware block extractor
// ---------------------------------------------------------------------------

/**
 * Given the full source text and a language identifier, locate the
 * `lang: { ... }` block and return its inner content as a string.
 *
 * Handles nested braces inside string literals correctly.
 */
function extractBlock(content, lang) {
    // Validate lang to prevent ReDoS — only allow word chars and hyphens
    if (!/^[\w-]+$/.test(lang)) return null;
    // Use [ \t] instead of \s to avoid super-linear backtracking (SonarCloud)
    const blockStart = /(?:^|\n)[ \t]*([\w-]+)[ \t]*:[ \t]*\{/g;
    let match;
    while ((match = blockStart.exec(content)) !== null) {
        if (match[1] === lang) break;
    }
    if (!match || match[1] !== lang) return null;

    let depth = 0;
    let inString = false;
    let stringChar = '';
    const start = match.index + match[0].length;

    for (let i = start; i < content.length; i++) {
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
            if (depth === 0) return content.substring(start, i);
            depth--;
        }
    }

    return null;
}

/**
 * Extract all top-level keys from a block string.
 * Matches lines like `  someKey: "value"` or `someKey: 'value'`.
 */
function extractKeys(block) {
    const keys = new Set();
    const keyRegex = /^\s*(\w+)\s*:/gm;
    let m;
    while ((m = keyRegex.exec(block)) !== null) {
        keys.add(m[1]);
    }
    return keys;
}

/**
 * Extract keys whose values are empty strings: `key: ""` or `key: ''`.
 */
function extractEmptyKeys(block) {
    const empty = new Set();
    const emptyRegex = /^\s*(\w+)\s*:\s*["']\s*["']/gm;
    let m;
    while ((m = emptyRegex.exec(block)) !== null) {
        empty.add(m[1]);
    }
    return empty;
}

// ---------------------------------------------------------------------------
// data-i18n attribute extractor
// ---------------------------------------------------------------------------

/**
 * Recursively walk SRC_DIR and extract all unique keys from
 * data-i18n="key" and data-i18n-placeholder="key" attributes
 * in .html and .js files.
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

    const enBlock = extractBlock(content, 'en');
    if (!enBlock) {
        console.error(`[check-i18n] ERROR: Could not locate "en" block in ${I18N_PATH}`);
        process.exit(1);
    }

    const enKeys = extractKeys(enBlock);
    const targetLocales = ['zh', 'ja', 'ko'];

    let totalIssues = 0;

    console.log('========================================');
    console.log('  Zephyr i18n Completeness Report');
    console.log(`  Base locale "en": ${enKeys.size} keys`);
    console.log('========================================\n');

    for (const locale of targetLocales) {
        const block = extractBlock(content, locale);
        if (!block) {
            console.error(`[check-i18n] ERROR: Could not locate "${locale}" block in ${I18N_PATH}`);
            totalIssues += enKeys.size;
            continue;
        }

        const localeKeys = extractKeys(block);
        const emptyKeys = extractEmptyKeys(block);

        const missing = [...enKeys].filter(k => !localeKeys.has(k));
        const empty = [...emptyKeys];

        const localeIssues = missing.length + empty.length;
        totalIssues += localeIssues;

        if (localeIssues === 0) {
            console.log(`[${locale}] OK — ${localeKeys.size}/${enKeys.size} keys, 0 issues`);
        } else {
            console.log(`[${locale}] ${localeIssues} issue(s) — ${localeKeys.size}/${enKeys.size} keys present`);

            if (missing.length > 0) {
                console.log(`  Missing keys (${missing.length}):`);
                for (const key of missing) {
                    console.log(`    - ${key}`);
                }
            }

            if (empty.length > 0) {
                console.log(`  Empty-string keys (${empty.length}, fallback to English):`);
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
        console.log('\nNOTE: ja/ko are skeleton translations — missing keys are expected.');
        console.log('      Re-run with --strict to make this check fail (exit 1).\n');

        if (strict) {
            process.exit(1);
        }
    }
}

main();
