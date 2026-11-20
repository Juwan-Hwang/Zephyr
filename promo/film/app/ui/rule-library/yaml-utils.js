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
    let lines = yamlContent.replace(/\r\n?/g, '\n').split('\n');
    // With a top-level `rules:` key, only its nested lines are rules, so
    // metadata such as `os: [windows, linux]` is never read as one.
    const rulesIdx = lines.findIndex((l) => /^(?:rules|'rules'|"rules")\s*:(?:\s|$)/.test(l));
    if (rulesIdx >= 0) {
        let end = rulesIdx + 1;
        // Stop at the next top-level `key:` entry or document marker; unindented
        // "- " items and bare rule lines stay in the block.
        const endsBlock = (/** @type {string} */ l) => /^(?:---|\.\.\.)(?:\s|$)/.test(l)
            || /^(?:[\p{L}\p{N}_$.-]+|'[^']*'|"[^"]*")\s*:(?:\s|$)/u.test(l);
        while (end < lines.length && !endsBlock(lines[end])) end++;
        // Flow form: `rules: [...]` or `rules: { $append: [...] }`, possibly
        // continued on the nested lines.
        const value = lines[rulesIdx].replace(/^[^:]*:\s*/, '').replace(/^&\S+\s*/, '');
        if (/^[[{]/.test(value)) {
            const flow = parseFlowRules([value, ...lines.slice(rulesIdx + 1, end)].join('\n'));
            if (flow) return flow;
        }
        lines = lines.slice(rulesIdx + 1, end);
        // Block DSL key with a flow value: `rules:\n  $append: [...]`.
        const opIdx = lines.findIndex((l) => !/^\s*(?:#.*)?$/.test(l));
        if (opIdx >= 0 && /^\s+(['"]?)\$(?:append|prepend)\1\s*:\s*\[/.test(lines[opIdx])) {
            const flow = parseFlowRules(lines.slice(opIdx).join('\n').replace(/^[^:]*:\s*/, ''));
            if (flow) return flow;
        }
    }
    return lines
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#'))
        .map((line) => unquoteYamlScalar(stripYamlComment(line.replace(/^-\s+/, '').trim())))
        .filter((line) => line && line.includes(','));
}

/**
 * Read the items of the first flow sequence in `text` (the `[...]` of
 * `rules: [...]` or `rules: { $append: [...] }`). Commas inside quoted
 * scalars are kept; plain items split on commas, as in YAML. Items without a
 * comma cannot be rules and are dropped, matching the line-based parser.
 * @param {string} text
 * @returns {string[] | null} items, or null if the sequence is not closed
 */
function parseFlowRules(text) {
    if (/^\{\s*\}/.test(text)) return [];
    const open = text.indexOf('[');
    if (open < 0) return null;
    /** @type {string[]} */
    const items = [];
    let item = '';
    let depth = 0;
    /** @type {string | null} */
    let quote = null;
    for (let i = open; i < text.length; i++) {
        const ch = text[i];
        if (quote) {
            item += ch;
            if (quote === '"' && ch === '\\') { item += text[++i] ?? ''; continue; }
            if (ch === quote) {
                if (quote === "'" && text[i + 1] === "'") { item += text[++i]; continue; }
                quote = null;
            }
            continue;
        }
        if (ch === '#' && (i === 0 || /\s/.test(text[i - 1]))) {
            const nl = text.indexOf('\n', i);
            if (nl < 0) return null;
            i = nl - 1;
            continue;
        }
        if (ch === '[' || ch === '{') {
            depth++;
            if (depth === 1) continue;
        } else if (ch === ']' || ch === '}') {
            depth--;
            if (depth === 0) {
                items.push(item);
                return items
                    .map((it) => unquoteYamlScalar(it.trim()))
                    .filter((it) => it && it.includes(','));
            }
        } else if (ch === ',' && depth === 1) {
            items.push(item);
            item = '';
            continue;
        } else if ((ch === "'" || ch === '"') && item.trim() === '') {
            quote = ch;
        }
        item += ch;
    }
    return null;
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
 * Conservative lexical check used when js-yaml is unavailable: every quoted
 * scalar must be closed on its own line and every flow collection (`[...]`, `{...}`) balanced.
 * Brackets inside a plain scalar (`foo[bar`) are text, not flow syntax.
 * A quote only opens a scalar at the start of a value (after whitespace,
 * `:`, `-`, `,`, `[` or `{`), so apostrophes inside plain text are ignored.
 * Anything it cannot vouch for (including block scalars containing brackets)
 * is rejected, so callers fall back to a minimal, known-valid document.
 * @param {string} text
 * @returns {boolean}
 */
function looksBalanced(text) {
    /** @type {string[]} */
    const stack = [];
    /** @type {string | null} */
    let quote = null;
    let prev = '\n';
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (quote) {
            // Multi-line quoted scalars are valid YAML but cannot be told
            // apart from an unclosed quote lexically; reject them too.
            if (ch === '\n') return false;
            if (quote === '"' && ch === '\\') { i++; prev = ''; continue; }
            if (ch === quote) {
                if (quote === "'" && text[i + 1] === "'") { i++; continue; }
                quote = null;
            }
            prev = ch;
            continue;
        }
        if (ch === '#' && /\s/.test(prev)) {
            const nl = text.indexOf('\n', i);
            if (nl < 0) break;
            i = nl - 1;
            prev = ' ';
            continue;
        }
        if ((ch === "'" || ch === '"') && /[\s:,\-[{]/.test(prev)) {
            quote = ch;
        } else if ((ch === '[' || ch === '{') && (stack.length > 0 || /[\s:\-]/.test(prev))) {
            // Outside a flow collection a bracket only opens one at the start
            // of a value; `name: foo[bar` is a plain scalar.
            stack.push(ch === '[' ? ']' : '}');
        } else if ((ch === ']' || ch === '}') && stack.length > 0) {
            if (stack.pop() !== ch) return false;
        }
        prev = ch;
    }
    return quote === null && stack.length === 0;
}

/**
 * Build a Prism DSL document by hand (no js-yaml).
 *
 * When `originalContent` is a block-style mapping (optionally framed by
 * `---` / `...` document markers), every top-level entry
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
    // A bare `---` / `...` line is a document marker, not a mapping entry.
    const isMarker = (/** @type {string} */ l) => /^(?:---|\.\.\.)\s*(?:#.*)?$/.test(l);
    // An unindented `- item` continues the previous key's sequence value.
    const isTopLevelLine = (/** @type {string} */ l) => !isMarker(l) && /^(?!-(?:\s|$))[^\s#]/.test(l);
    const isRulesKey = (/** @type {string} */ l) => /^(?:rules|'rules'|"rules")\s*:(?:\s|$)/.test(l);
    const topLevel = lines.filter(isTopLevelLine);
    const firstIdx = lines.findIndex(isTopLevelLine);
    const lastIdx = lines.length - 1 - [...lines].reverse().findIndex(isTopLevelLine);
    // Only a single document is spliced: at most one `---` before its first
    // entry and one `...` after its last.
    const markersOk = lines.every((l, i) => !isMarker(l)
        || (l.startsWith('---') ? i < firstIdx : i > lastIdx))
        && lines.filter((l) => /^---/.test(l) && isMarker(l)).length <= 1
        && lines.filter((l) => /^\.\.\./.test(l) && isMarker(l)).length <= 1;
    // Only splice into a block mapping whose top-level lines are `key:` entries
    // with a single `rules` key.
    const blockMapping = firstIdx >= 0 && markersOk
        && topLevel.every((l) => /^(?:[\p{L}\p{N}_$.-]+|'[^']*'|"[^"]*")\s*:(?:\s|$)/u.test(l))
        && topLevel.filter(isRulesKey).length <= 1;
    const minimal = () => buildRulesBlockLines(rules, '$append').join('\n') + '\n';
    if (!blockMapping) return minimal();

    // When js-yaml is loaded we only get here because it rejected the
    // original; keep the splice only if the result parses, so a malformed
    // line outside `rules` is never written back.
    const validated = (/** @type {string} */ text) => {
        if (typeof jsyaml === 'undefined') return looksBalanced(text) ? text : minimal();
        try {
            const doc = jsyaml.load(text);
            return doc && typeof doc === 'object' && !Array.isArray(doc) ? text : minimal();
        } catch {
            return minimal();
        }
    };

    const start = lines.findIndex(isRulesKey);
    if (start < 0) {
        // Append after the last entry's block, before a closing `...`.
        const close = lines.findIndex((l) => /^\.\.\./.test(l) && isMarker(l));
        const body = close < 0 ? lines : lines.slice(0, close);
        const tail = close < 0 ? [] : lines.slice(close);
        const kept = body.join('\n').replace(/\n*$/, '');
        const out = [kept, ...buildRulesBlockLines(rules, '$append'), ...tail].join('\n');
        return validated(out.replace(/\n*$/, '\n'));
    }
    let end = start + 1;
    while (end < lines.length && !isTopLevelLine(lines[end]) && !isMarker(lines[end])) end++;
    // Leave trailing blank/comment lines that belong to the next entry alone.
    while (end - 1 > start && /^\s*(?:#.*)?$/.test(lines[end - 1]) && !/^\s+\S/.test(lines[end - 1])) end--;
    const block = lines.slice(start, end);
    // An anchor defined inside the replaced block would leave any alias to it
    // in the kept entries dangling; fall back to the minimal document then.
    // With js-yaml loaded, validated() already rejects a dangling alias, so
    // this text heuristic only runs without a parser.
    if (typeof jsyaml === 'undefined') {
        const anchors = [...block.join('\n').matchAll(/&([^\s,[\]{}]+)/g)].map((m) => m[1]);
        const keptText = [...lines.slice(0, start), ...lines.slice(end)].join('\n');
        if (anchors.some((a) => keptText.split('*' + a).length > 1)) return minimal();
    }
    const op = detectRulesOperator(block);
    const out = [...lines.slice(0, start), ...buildRulesBlockLines(rules, op), ...lines.slice(end)];
    return validated(out.join('\n').replace(/\n*$/, '\n'));
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

    // Fallback: with no original, prefer js-yaml for a minimal document.
    // Otherwise splice by hand, keeping metadata and the DSL operator;
    // buildFallbackPrismYaml validates the result with js-yaml when loaded.
    if (typeof jsyaml !== 'undefined' && !originalYaml) {
        try {
            return jsyaml.dump({ rules: { $append: rules } }, { lineWidth: -1, quotingType: "'", forceQuotes: false });
        } catch {
            // Fall through to the hand-written fallback
        }
    }
    return buildFallbackPrismYaml(rules, typeof originalYaml === 'string' ? originalYaml : '');
}
