// @ts-check

/** @param {string} content */
function bindingDocument(content) {
    if (typeof jsyaml === 'undefined') throw new Error('The YAML parser is unavailable.');
    const doc = jsyaml.load(content) ?? {};
    if (typeof doc !== 'object' || Array.isArray(doc)) throw new Error('Invalid rule document.');
    const when = doc.__when__;
    if (when != null && (typeof when !== 'object' || Array.isArray(when))) throw new Error('Invalid __when__ condition.');
    const value = when?.profile;
    const profiles = value == null ? null : (Array.isArray(value) ? value : [value]);
    if (profiles?.some((/** @type {unknown} */ name) => typeof name !== 'string')) throw new Error('Invalid profile binding.');
    return { doc, when: when ?? {}, profiles: /** @type {string[] | null} */ (profiles) };
}

/** @param {string} content @param {string} profile */
export function readRuleBinding(content, profile) {
    const { when, profiles } = bindingDocument(content);
    return when.enabled !== false && (profiles === null || profiles.some((name) => name.toLowerCase() === profile.toLowerCase()));
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
    if (readRuleBinding(content, profile) === enabled) return content;
    const next = { ...when };
    const matches = (/** @type {string} */ name) => name.toLowerCase() === profile.toLowerCase();
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
    const newline = content.includes('\r\n') ? '\r\n' : '\n';
    const block = jsyaml.dump({ __when__: next }, { lineWidth: -1 }).replace(/\n/g, newline);
    let candidate;
    if (Object.hasOwn(doc, '__when__')) {
        const lines = content.split(newline);
        const start = lines.findIndex((line) => /^__when__[ \t]*:/.test(line));
        if (start < 0) throw new Error('Edit this profile binding in the YAML editor.');
        let end = start + 1;
        let scan = end;
        while (scan < lines.length) {
            if (!lines[scan].trim() || /^[ \t]*#/.test(lines[scan])) { scan++; continue; }
            if (!/^[ \t]/.test(lines[scan])) break;
            end = ++scan;
        }
        const comments = lines.slice(start + 1, end).filter((line) => /^[ \t]*#/.test(line));
        candidate = [...lines.slice(0, start), ...comments, block.trimEnd(), ...lines.slice(end)].join(newline);
    } else {
        const lines = content.split(newline);
        const first = lines.findIndex((line) => !/^(?:\s*(?:#.*)?|%.*)$/.test(line));
        const hasMarker = first >= 0 && /^---(?:[ \t]*(?:#.*)?)$/.test(lines[first]);
        // A document marker/directive preamble must precede the new mapping.
        // Other unsupported roots still fail the final parse before saving.
        candidate = hasMarker
            ? [...lines.slice(0, first + 1), block.trimEnd(), ...lines.slice(first + 1)].join(newline)
            : block + content;
    }
    if (readRuleBinding(candidate, profile) !== enabled) throw new Error('The requested profile binding could not be saved.');
    return candidate;
}
