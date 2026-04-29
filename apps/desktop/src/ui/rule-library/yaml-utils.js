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

    // Line-based: each non-empty line that looks like a rule
    return yamlContent
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#') && line.includes(','));
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

    // Fallback: build minimal valid Prism DSL with $append
    const lines = ['rules:', '  $append:'];
    for (const rule of rules) {
        lines.push(`    - '${rule}'`);
    }
    return lines.join('\n') + '\n';
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
            if (parsed && typeof parsed === 'object') {
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

    // Fallback: create minimal prism YAML with $append
    const obj = { rules: { $append: rules } };
    return jsyaml.dump(obj, { lineWidth: -1, quotingType: "'", forceQuotes: false });
}
