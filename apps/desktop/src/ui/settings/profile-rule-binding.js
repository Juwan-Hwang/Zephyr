// @ts-check

/** Preserve date-like strings as the compiler does, while retaining merge keys. */
function bindingSchema() {
    return jsyaml.DEFAULT_SCHEMA.extend({ implicit: [new jsyaml.Type('tag:yaml.org,2002:timestamp', {
        kind: 'scalar', resolve: jsyaml.types.timestamp.resolve, construct: (/** @type {string} */ value) => value,
    })] });
}

/** @param {string} content */
function bindingDocument(content) {
    if (typeof jsyaml === 'undefined') throw new Error('The YAML parser is unavailable.');
    const doc = jsyaml.load(content, { schema: bindingSchema() }) ?? {};
    if (typeof doc !== 'object' || Array.isArray(doc)) throw new Error('Invalid rule document.');
    const when = doc.__when__;
    if (when != null && (typeof when !== 'object' || Array.isArray(when))) throw new Error('Invalid __when__ condition.');
    const value = when?.profile;
    const profiles = value == null ? null : (Array.isArray(value) ? value : [value]);
    if (profiles?.some((/** @type {unknown} */ name) => typeof name !== 'string')) throw new Error('Invalid profile binding.');
    return { doc, when: when ?? {}, profiles: /** @type {string[] | null} */ (profiles) };
}

/** @param {string} name */
function isProfilePattern(name) {
    const pattern = name.trim();
    return pattern.includes('*') || pattern.includes('?')
        || (pattern.length > 2 && pattern.startsWith('/') && pattern.endsWith('/'));
}

/** @param {string} content */
export function hasPatternRuleBinding(content) {
    return bindingDocument(content).profiles?.some(isProfilePattern) ?? false;
}

/** Null means a compiler pattern cannot be represented by this checkbox.
 * @param {string} content @param {string} profile @returns {boolean | null}
 */
export function readRuleBinding(content, profile) {
    const { when, profiles } = bindingDocument(content);
    if (when.enabled === false) return false;
    if (profiles?.some(isProfilePattern)) return null;
    return profiles === null || profiles.includes(profile);
}

/** @param {string} content */
export function hasGlobalRuleBinding(content) {
    const { when, profiles } = bindingDocument(content);
    return when.enabled !== false && profiles === null;
}

/** @param {Record<string, unknown>} doc */
function withoutCondition(doc) {
    const rest = { ...doc };
    delete rest.__when__;
    return jsyaml.dump(rest, { sortKeys: true, lineWidth: -1 });
}

/** @typedef {{text: string, raw: string, start: number, end: number}} SourceLine */

/** @param {string} source @param {SourceLine[]} lines @param {string} block @param {number} indent */
function replaceConditionSource(source, lines, block, indent) {
    const start = lines.findIndex((line) => line.text.length - line.text.trimStart().length === indent
        && /^(?:__when__|'__when__'|"__when__")[ \t]*:/.test(line.text.trimStart()));
    if (start < 0) throw new Error('Edit this profile binding in the YAML editor.');
    let end = start + 1;
    let scan = end;
    while (scan < lines.length) {
        const text = lines[scan].text;
        if (!text.trim() || /^[ \t]*#/.test(text)) { scan++; continue; }
        if (text.length - text.trimStart().length <= indent) break;
        end = ++scan;
    }
    const comments = lines.slice(start + 1, end).filter((line) => /^[ \t]*#/.test(line.text)).map((line) => line.raw).join('');
    const offset = end < lines.length ? lines[end].start : source.length;
    return source.slice(0, lines[start].start) + comments + block + source.slice(offset);
}

/** Preserve source outside the changed condition and its root indentation.
 * @param {string} content @param {Record<string, unknown>} next @param {boolean} hasCondition
 */
function spliceBindingSource(content, next, hasCondition) {
    const newline = content.includes('\r\n') ? '\r\n' : '\n';
    const bom = content.startsWith('\uFEFF') ? '\uFEFF' : '';
    const source = content.slice(bom.length);
    const lines = [...source.matchAll(/[^\r\n]*(?:\r\n|\r|\n|$)/g)].filter((match) => match[0].length)
        .map((match) => ({ text: match[0].replace(/[\r\n]+$/, ''), raw: match[0], start: match.index ?? 0, end: (match.index ?? 0) + match[0].length }));
    const preamble = /^(?:\s*(?:#.*)?|%.*|---(?:[ \t]*(?:#.*)?)|\.\.\.(?:[ \t]*(?:#.*)?))$/;
    const rootLine = lines.find((line) => !preamble.test(line.text));
    const indent = rootLine ? rootLine.text.length - rootLine.text.trimStart().length : 0;
    const prefix = ' '.repeat(indent);
    const block = jsyaml.dump({ __when__: next }, { lineWidth: -1 }).split('\n')
        .map((line) => line ? prefix + line : line).join(newline);
    if (hasCondition) return bom + replaceConditionSource(source, lines, block, indent);
    const first = lines.findIndex((line) => !/^(?:\s*(?:#.*)?|%.*)$/.test(line.text));
    const hasMarker = first >= 0 && /^---(?:[ \t]*(?:#.*)?)$/.test(lines[first].text);
    // A document marker/directive preamble must precede the new mapping.
    const candidate = hasMarker
        ? source.slice(0, lines[first].end) + (/[\r\n]$/.test(lines[first].raw) ? '' : newline) + block + source.slice(lines[first].end)
        : block + source;
    return bom + candidate;
}

/**
 * Rewrite only the top-level condition; the rule text and other settings keep
 * their comments and layout. Unrepresentable roots fail before any file write.
 * @param {string} content
 * @param {string} profile
 * @param {boolean} enabled
 * @param {string[] | null} allProfiles null means profile enumeration failed
 */
export function setRuleBinding(content, profile, enabled, allProfiles) {
    const { doc, when, profiles } = bindingDocument(content);
    if (profiles?.some(isProfilePattern)) throw new Error('PROFILE_BINDING_PATTERN: Edit profile patterns in the rule file’s YAML editor.');
    if (readRuleBinding(content, profile) === enabled) return content;
    const next = { ...when };
    const matches = (/** @type {string} */ name) => name === profile;
    if (enabled) {
        delete next.enabled;
        next.profile = when.enabled === false ? [profile]
            : (profiles?.some(matches) ? [...profiles] : [...(profiles ?? []), profile]);
    } else {
        const available = profiles ?? allProfiles;
        if (available === null) throw new Error('Could not list profiles. Reopen the subscription menu and retry.');
        const remaining = available.filter((name) => !matches(name));
        if (remaining.length) next.profile = remaining;
        else { delete next.profile; next.enabled = false; }
    }
    const hasCondition = Object.prototype.hasOwnProperty.call(doc, '__when__'); // NOSONAR — supported older WebViews lack Object.hasOwn
    const candidate = spliceBindingSource(content, next, hasCondition);
    if (readRuleBinding(candidate, profile) !== enabled) throw new Error('The requested profile binding could not be saved.');
    if (withoutCondition(bindingDocument(candidate).doc) !== withoutCondition(doc)) throw new Error('The profile binding would change other rule content. Edit it in the YAML editor.');
    const unchangedConditions = (/** @type {Record<string, unknown>} */ condition) => {
        const rest = { ...condition };
        delete rest.profile;
        delete rest.enabled;
        return jsyaml.dump(rest, { sortKeys: true, lineWidth: -1 });
    };
    if (unchangedConditions(bindingDocument(candidate).when) !== unchangedConditions(when)) throw new Error('The profile binding would change other conditions. Edit it in the YAML editor.');
    return candidate;
}
