// @ts-check
/**
 * YAML parsing and manipulation utilities for rule files.
 *
 * Pure functions for parsing, rebuilding, and wrapping YAML rule content.
 * Used by rule-library.js for editing and importing rule files.
 *
 * @module ui/rule-library/yaml-utils
 */

/**
 * Parse rules from YAML content.
 * Handles both raw rule strings and structured YAML.
 * @param {string} yamlContent
 * @returns {string[]}
 */
export function parseRulesFromYaml(yamlContent) {
    // Try structured YAML parse first
    if (typeof jsyaml !== 'undefined') {
        try {
            const parsed = jsyaml.load(yamlContent);
            if (parsed && Array.isArray(parsed.rules)) {
                return parsed.rules.map(String);
            }
            // Handle Prism DSL: rules: { $append: [...] } or { $prepend: [...] }
            if (parsed && parsed.rules && typeof parsed.rules === 'object' && !Array.isArray(parsed.rules)) {
                const dslRules = parsed.rules.$append || parsed.rules.$prepend;
                if (Array.isArray(dslRules)) {
                    return dslRules.map(String);
                }
            }
        } catch {
            // Fall through to line-based parsing
        }
    }

    // Line-based: each non-empty line that looks like a rule.
    // Strip YAML list markers ("- ") and surrounding quotes so the result
    // matches what the structured parser would return.
    return yamlContent
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#'))
        .map((line) => unquoteYamlScalar(stripYamlComment(line.replace(/^-\s+/, '').trim())))
        .filter((line) => line && line.includes(','));
}

/**
 * Drop a trailing YAML comment from a single-line scalar.
 * For quoted scalars everything after the closing quote is dropped; for plain
 * scalars a `#` preceded by whitespace starts a comment (YAML 1.2 rule), so
 * `DOMAIN,a#b,DIRECT` keeps its `#`.
 * @param {string} value
 * @returns {string}
 */
function stripYamlComment(value) {
    const q = value[0];
    if (q === "'" || q === '"') {
        for (let i = 1; i < value.length; i++) {
            const ch = value[i];
            if (q === '"' && ch === '\\') { i++; continue; }
            if (ch === q) {
                if (q === "'" && value[i + 1] === "'") { i++; continue; }
                const rest = value.slice(i + 1).trim();
                return rest === '' || rest.startsWith('#') ? value.slice(0, i + 1) : value;
            }
        }
        return value;
    }
    const m = /\s#/.exec(value);
    return m ? value.slice(0, m.index).trimEnd() : value;
}

/** Single-character escapes of YAML double-quoted scalars. */
const YAML_SIMPLE_ESCAPES = /** @type {Record<string, string>} */ ({
    '0': '\0', a: '\x07', b: '\b', t: '\t', '\t': '\t', n: '\n', v: '\v', f: '\f', r: '\r',
    e: '\x1b', ' ': ' ', '"': '"', '/': '/', '\\': '\\', N: '\x85', _: '\xa0',
    L: '\u2028', P: '\u2029',
});

/** Hex digits that follow `\x`, `\u` and `\U`. */
const YAML_HEX_ESCAPE_LENGTHS = /** @type {Record<string, number>} */ ({ x: 2, u: 4, U: 8 });

/**
 * Decode the body of a single-line YAML double-quoted scalar.
 * @param {string} body - text between the quotes
 * @returns {string | null} decoded text, or null if an escape is invalid
 */
function decodeYamlDoubleQuoted(body) {
    let out = '';
    for (let i = 0; i < body.length; i++) {
        const ch = body[i];
        if (ch === '"') return null;
        if (ch !== '\\') { out += ch; continue; }
        const esc = body[++i];
        if (esc === undefined) return null;
        if (esc in YAML_SIMPLE_ESCAPES) { out += YAML_SIMPLE_ESCAPES[esc]; continue; }
        const len = YAML_HEX_ESCAPE_LENGTHS[esc];
        if (!len) return null;
        const hex = body.slice(i + 1, i + 1 + len);
        if (hex.length !== len || !/^[0-9a-fA-F]+$/.test(hex)) return null;
        const cp = parseInt(hex, 16);
        if (cp > 0x10ffff) return null;
        out += String.fromCodePoint(cp);
        i += len;
    }
    return out;
}

/**
 * Remove matching surrounding quotes from a single-line YAML scalar.
 * Single-quoted scalars unescape '' to '; double-quoted scalars are decoded
 * with the full YAML escape set (`\x41`, `\u00e9`, `\e`, `\N`, ...).
 * Anything that is not a well-formed quoted scalar is returned unchanged.
 * @param {string} value
 * @returns {string}
 */
function unquoteYamlScalar(value) {
    if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
        return value.slice(1, -1).replace(/''/g, "'");
    }
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
        const decoded = decodeYamlDoubleQuoted(value.slice(1, -1));
        return decoded ?? value;
    }
    return value;
}

/**
 * Characters YAML cannot hold literally in a scalar (outside the YAML 1.2
 * printable set: C0/C1 controls except TAB/LF/CR/NEL, DEL, lone surrogates,
 * U+FFFE/U+FFFF), plus LF/CR, which a single-line scalar cannot hold.
 */
const YAML_NEEDS_ESCAPE_RE = /[\u0000-\u0008\u000a-\u001f\u007f-\u0084\u0086-\u009f\ufffe\uffff]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/**
 * Quote a rule as a YAML scalar without depending on js-yaml.
 * Uses single quotes (doubling embedded ') unless the value contains a
 * character that must be escaped; those use a double-quoted scalar with
 * `\xNN` / `\uNNNN` escapes, which every YAML parser reads back exactly.
 * @param {string} value
 * @returns {string}
 */
function quoteYamlScalar(value) {
    if (!YAML_NEEDS_ESCAPE_RE.test(value)) {
        return `'${value.replace(/'/g, "''")}'`;
    }
    let out = '"';
    for (let i = 0; i < value.length; i++) {
        const ch = value[i];
        const code = ch.charCodeAt(0);
        if (ch === '"' || ch === '\\') {
            out += `\\${ch}`;
        } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length
            && value.charCodeAt(i + 1) >= 0xdc00 && value.charCodeAt(i + 1) <= 0xdfff) {
            out += ch + value[++i];
        } else if (YAML_NEEDS_ESCAPE_RE.test(ch)) {
            out += code <= 0xff ? `\\x${code.toString(16).padStart(2, '0')}` : `\\u${code.toString(16).padStart(4, '0')}`;
        } else {
            out += ch;
        }
    }
    return `${out}"`;
}

/**
 * Render a `rules:` block (`rules: { <op>: [...] }`) by hand.
 * @param {unknown[]} rules
 * @param {'$append' | '$prepend'} op
 * @returns {string[]} lines
 */
function buildRulesBlockLines(rules, op) {
    if (rules.length === 0) return ['rules:', `  ${op}: []`];
    const lines = ['rules:', `  ${op}:`];
    for (const rule of rules) {
        lines.push(`    - ${quoteYamlScalar(String(rule))}`);
    }
    return lines;
}

/**
 * Find the DSL operator of an original `rules:` block from its own keys only,
 * so a comment or rule value that mentions `$prepend:` cannot flip it.
 * @param {string[]} block - the `rules:` line and the lines nested under it
 * @returns {'$append' | '$prepend'}
 */
function detectRulesOperator(block) {
    const OP_KEY = /^(['"]?)(\$prepend|\$append)\1\s*:/;
    // Flow form on the same line: `rules: { $prepend: [...] }`.
    const inline = block[0].replace(/^[^:]*:/, '').trim();
    if (inline.startsWith('{')) {
        const m = inline.slice(1).trim().match(OP_KEY);
        return m && m[2] === '$prepend' ? '$prepend' : '$append';
    }
    // Block form: only keys at the first nested indentation level count.
    /** @type {number | null} */
    let indent = null;
    for (const line of block.slice(1)) {
        if (/^\s*(?:#.*)?$/.test(line)) continue;
        const lineIndent = line.length - line.trimStart().length;
        if (indent === null) indent = lineIndent;
        if (lineIndent !== indent) continue;
        const m = line.trimStart().match(OP_KEY);
        if (m) return m[2] === '$prepend' ? '$prepend' : '$append';
    }
    return '$append';
}

/**
 * Build a Prism DSL document by hand (no js-yaml).
 *
 * When `originalContent` is a block-style mapping, every top-level entry
 * other than `rules` (e.g. `__when__`, comments) is kept verbatim and the
 * original DSL operator (`$prepend` / `$append`) is reused; only the `rules`
 * block is replaced. Otherwise a minimal `rules: { $append: [...] }`
 * document is produced.
 * @param {unknown[]} rules
 * @param {string} [originalContent]
 * @returns {string}
 */
function buildFallbackPrismYaml(rules, originalContent = '') {
    const lines = originalContent.replace(/\r\n?/g, '\n').split('\n');
    const isTopLevelLine = (/** @type {string} */ l) => /^[^\s#]/.test(l);
    const firstContent = lines.find(isTopLevelLine);
    // Only splice into a block mapping whose top-level lines are `key:` entries.
    const blockMapping = firstContent !== undefined
        && lines.filter(isTopLevelLine).every((l) => /^(?:[\w$.-]+|'[^']*'|"[^"]*")\s*:(?:\s|$)/.test(l));
    if (!blockMapping) {
        return buildRulesBlockLines(rules, '$append').join('\n') + '\n';
    }

    const start = lines.findIndex((l) => /^(?:rules|'rules'|"rules")\s*:(?:\s|$)/.test(l));
    if (start < 0) {
        const kept = lines.join('\n').replace(/\n*$/, '');
        return `${kept}\n${buildRulesBlockLines(rules, '$append').join('\n')}\n`;
    }
    let end = start + 1;
    while (end < lines.length && !isTopLevelLine(lines[end])) end++;
    // Leave trailing blank/comment lines that belong to the next entry alone.
    while (end - 1 > start && /^\s*(?:#.*)?$/.test(lines[end - 1]) && !/^\s+\S/.test(lines[end - 1])) end--;
    const op = detectRulesOperator(lines.slice(start, end));
    const out = [...lines.slice(0, start), ...buildRulesBlockLines(rules, op), ...lines.slice(end)];
    return out.join('\n').replace(/\n*$/, '\n');
}

/**
 * Rebuild YAML content with new rules, preserving metadata from original.
 * @param {string} originalContent
 * @param {string[]} rules
 * @returns {string}
 */
export function rebuildYamlWithRules(originalContent, rules) {
    // Try to parse original as YAML to preserve metadata
    if (typeof jsyaml !== 'undefined') {
        try {
            const parsed = jsyaml.load(originalContent);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                // Preserve all keys except 'rules', then rebuild rules
                const newObj = { ...parsed };
                const oldRules = parsed.rules;
                delete newObj.rules;

                // Preserve the original DSL operator ($prepend/$append) if present
                if (oldRules && typeof oldRules === 'object' && !Array.isArray(oldRules)) {
                    const op = oldRules.$prepend !== undefined ? '$prepend' : '$append';
                    newObj.rules = { [op]: rules };
                } else {
                    // Plain array or no rules -- default to $append
                    newObj.rules = { $append: rules };
                }
                return jsyaml.dump(newObj, { lineWidth: -1, quotingType: "'", forceQuotes: false });
            }
        } catch {
            // Fall through to raw rebuild
        }
    }

    // Fallback: rebuild by hand, keeping metadata and the DSL operator
    return buildFallbackPrismYaml(rules, typeof originalContent === 'string' ? originalContent : '');
}

/**
 * Wrap raw rule text into a valid prism YAML structure, preserving metadata from original.
 * @param {string} rawRulesText - Plain rule text (one rule per line)
 * @param {string} originalYaml - Original .prism.yaml content
 * @returns {string} Valid prism YAML string
 */
export function wrapRulesAsPrismYaml(rawRulesText, originalYaml) {
    const rules = rawRulesText
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'));

    // Try to preserve original structure (__when__, DSL operator, etc.)
    if (typeof jsyaml !== 'undefined' && originalYaml) {
        try {
            const parsed = jsyaml.load(originalYaml);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                // Preserve metadata, keep original DSL operator if present
                const oldRules = parsed.rules;
                let newRules;
                if (oldRules && typeof oldRules === 'object' && !Array.isArray(oldRules)) {
                    const op = oldRules.$prepend !== undefined ? '$prepend' : '$append';
                    newRules = { [op]: rules };
                } else {
                    newRules = { $append: rules };
                }
                const result = { ...parsed, rules: newRules };
                return jsyaml.dump(result, { lineWidth: -1, quotingType: "'", forceQuotes: false });
            }
        } catch {
            // Fall through
        }
    }

    // Fallback: create minimal prism YAML with $append.
    // Prefer js-yaml when it is loaded; otherwise build it by hand.
    if (typeof jsyaml !== 'undefined') {
        try {
            return jsyaml.dump({ rules: { $append: rules } }, { lineWidth: -1, quotingType: "'", forceQuotes: false });
        } catch {
            // Fall through to the hand-written fallback
        }
    }
    return buildFallbackPrismYaml(rules, typeof originalYaml === 'string' ? originalYaml : '');
}
