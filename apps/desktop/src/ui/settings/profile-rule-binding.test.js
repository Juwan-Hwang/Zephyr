import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as yaml from '../../js-yaml.min.js';
import { readRuleBinding, setRuleBinding, hasPatternRuleBinding } from './profile-rule-binding.js';

describe('subscription rule bindings', () => {
    beforeEach(() => vi.stubGlobal('jsyaml', yaml));
    afterEach(() => vi.unstubAllGlobals());

    it.each([
        '__when__: { profile: [Home], os: windows }',
        '__when__:\n  os: windows\n  profile:\n    - Home',
        '__when__:\n  profile: Home\n  os: windows',
    ])('updates the parsed condition and preserves the rule text: %s', (condition) => {
        const rules = '# keep rules\nrules:\n  $prepend: ["DOMAIN,a.com,DIRECT"] # note\n';
        const content = condition + '\n' + rules;
        expect(readRuleBinding(content, 'Home')).toBe(true);
        expect(readRuleBinding(content, 'Work')).toBe(false);
        const enabled = setRuleBinding(content, 'Work', true, ['Home', 'Work']);
        expect(yaml.load(enabled).__when__).toEqual({ os: 'windows', profile: ['Home', 'Work'] });
        expect(enabled).toContain(rules);
        const disabled = setRuleBinding(enabled, 'Home', false, ['Home', 'Work']);
        expect(readRuleBinding(disabled, 'Home')).toBe(false);
        expect(readRuleBinding(disabled, 'Work')).toBe(true);
        expect(yaml.load(disabled).__when__.os).toBe('windows');
    });

    it('quotes profile names and touches only the top-level condition', () => {
        const content = 'other:\n  profile: Untouched\n__when__: {profile: [Home]}\nrules: []\n';
        const changed = setRuleBinding(content, 'Work, #1', true, ['Home', 'Work, #1']);
        expect(yaml.load(changed)).toEqual({ other: { profile: 'Untouched' }, __when__: { profile: ['Home', 'Work, #1'] }, rules: [] });
    });

    it.each([2, 4])('replaces only the condition at an indented root (%i spaces)', (spaces) => {
        const indent = ' '.repeat(spaces);
        const prefix = `${indent}other:\n${indent}  __when__: untouched\n`;
        const suffix = `${indent}rules:\n${indent}  - MATCH,DIRECT # keep\n`;
        const content = `${prefix}${indent}__when__:\n${indent}  profile: [Home]\n${suffix}`;
        const changed = setRuleBinding(content, 'Work', true, ['Home', 'Work']);
        expect(yaml.load(changed).__when__.profile).toEqual(['Home', 'Work']);
        expect(changed.startsWith(prefix)).toBe(true);
        expect(changed.endsWith(suffix)).toBe(true);
    });

    it('inserts a condition at the existing root indentation after a document marker', () => {
        const content = '---\n  rules: []\n';
        const changed = setRuleBinding(content, 'Home', false, ['Home', 'Work']);
        expect(changed.startsWith('---\n  __when__:\n')).toBe(true);
        expect(changed.endsWith('  rules: []\n')).toBe(true);
        expect(yaml.load(changed)).toEqual({ __when__: { profile: ['Work'] }, rules: [] });
    });

    it('removes global applicability for one profile and can re-enable a disabled condition', () => {
        const original = '__when__: { os: windows }\nrules: []\n';
        expect(readRuleBinding(original, 'Home')).toBe(true);
        const excluded = setRuleBinding(original, 'Home', false, ['Home', 'Work']);
        expect(readRuleBinding(excluded, 'Home')).toBe(false);
        expect(readRuleBinding(excluded, 'Work')).toBe(true);
        const disabled = setRuleBinding(excluded, 'Work', false, ['Home', 'Work']);
        expect(yaml.load(disabled).__when__.enabled).toBe(false);
        expect(readRuleBinding(setRuleBinding(disabled, 'Home', true, ['Home', 'Work']), 'Home')).toBe(true);
    });

    it('rejects an unsupported root before a caller can save an unchanged binding', () => {
        expect(() => setRuleBinding('{__when__: {profile: [Home]}, rules: []}', 'Work', true, ['Home', 'Work'])).toThrow('YAML editor');
        expect(() => setRuleBinding('__when__: {profile: [true]}\nrules: []', 'Work', true, ['Work'])).toThrow('Invalid profile');
    });

    it('requires enumeration only when excluding one profile from a global rule', () => {
        expect(() => setRuleBinding('rules: []\n', 'Work', false, null)).toThrow('Could not list profiles');
        const explicit = '__when__: {profile: [Home, Work]}\nrules: []\n';
        expect(readRuleBinding(setRuleBinding(explicit, 'Work', false, null), 'Home')).toBe(true);
    });

    it('re-enables only the selected profile from a disabled condition', () => {
        const original = '__when__: {enabled: false, profile: [Home, Work]}\nrules: []\n';
        const changed = setRuleBinding(original, 'Work', true, ['Home', 'Work']);
        expect(readRuleBinding(changed, 'Work')).toBe(true);
        expect(readRuleBinding(changed, 'Home')).toBe(false);
    });

    it('reads across unindented condition comments and keeps surrounding notes', () => {
        const original = '# before\n__when__:\n# condition note\n  profile: [Home]\n# rules note\nrules: []\n';
        const changed = setRuleBinding(original, 'Work', true, ['Home', 'Work']);
        expect(yaml.load(changed).__when__.profile).toEqual(['Home', 'Work']);
        expect(changed).toContain('# before\n');
        expect(changed).toContain('# condition note\n');
        expect(changed).toContain('# rules note\nrules: []\n');
    });

    it.each(['---\n', '# document\n--- # rules\n', '%YAML 1.2\n---\n'])('adds a binding after its document preamble: %s', (prefix) => {
        const original = prefix + 'rules: []\n';
        const changed = setRuleBinding(original, 'Home', false, ['Home', 'Work']);
        expect(changed.startsWith(prefix)).toBe(true);
        expect(yaml.load(changed)).toEqual({ __when__: { profile: ['Work'] }, rules: [] });
    });

    it.each(['__when__', '"__when__"', "'__when__'"])('keeps rules and mixed line endings around %s', (key) => {
        const rules = 'rules:\r\n  - MATCH,DIRECT\r\nother: value\n';
        const original = `# leading\r\n${key}: { profile: [Home] }\n${rules}`;
        const changed = setRuleBinding(original, 'Work', true, ['Home', 'Work']);
        expect(changed.startsWith('# leading\r\n')).toBe(true);
        expect(changed.endsWith(rules)).toBe(true);
        expect(yaml.load(changed)).toEqual({ __when__: { profile: ['Home', 'Work'] }, rules: ['MATCH,DIRECT'], other: 'value' });
    });

    it('keeps the BOM at the beginning when adding a condition', () => {
        const original = '\uFEFFrules:\n  - MATCH,DIRECT\n';
        const changed = setRuleBinding(original, 'Home', false, ['Home', 'Work']);
        expect(changed.startsWith('\uFEFF')).toBe(true);
        expect(changed.indexOf('\uFEFF', 1)).toBe(-1);
        expect(yaml.load(changed)).toEqual({ __when__: { profile: ['Work'] }, rules: ['MATCH,DIRECT'] });
    });

    it.each(['---', '--- # empty', '---\n', '---\r\n'])('adds a binding after an empty document marker: %j', (original) => {
        const changed = setRuleBinding(original, 'Home', false, ['Home', 'Work']);
        const newline = original.includes('\r\n') ? '\r\n' : '\n';
        expect(changed.startsWith(original.replace(/[\r\n]+$/, '') + newline + '__when__:')).toBe(true);
        expect(yaml.load(changed)).toEqual({ __when__: { profile: ['Work'] } });
    });

    it('distinguishes plain profile names by case', () => {
        const original = '__when__: { profile: [Home] }\nrules: []\n';
        expect(readRuleBinding(original, 'home')).toBe(false);
        const changed = setRuleBinding(original, 'home', true, ['Home', 'home']);
        expect(yaml.load(changed).__when__.profile).toEqual(['Home', 'home']);
        expect(readRuleBinding(setRuleBinding(changed, 'home', false, ['Home', 'home']), 'Home')).toBe(true);
    });

    it('updates a binding without the modern Object.hasOwn API', () => {
        const unavailable = vi.spyOn(Object, 'hasOwn').mockImplementation(() => { throw new Error('Object.hasOwn unavailable'); });
        let result;
        try { result = setRuleBinding('__when__: {profile: [Home]}\nrules: []\n', 'Work', true, ['Home', 'Work']); }
        finally { unavailable.mockRestore(); }
        expect(yaml.load(result).__when__.profile).toEqual(['Home', 'Work']);
    });

    it.each(['Home*', 'Home?', '/^Home[A-Z]+$/'])('leaves compiler pattern %s for the YAML editor', (pattern) => {
        const content = yaml.dump({ __when__: { profile: [pattern] }, rules: [] });
        expect(hasPatternRuleBinding(content)).toBe(true);
        expect(readRuleBinding(content, 'HomeOffice')).toBeNull();
        expect(() => setRuleBinding(content, 'HomeOffice', false, ['HomeOffice', 'Work'])).toThrow('PROFILE_BINDING_PATTERN:');
        const disabled = yaml.dump({ __when__: { enabled: false, profile: [pattern] }, rules: [] });
        expect(readRuleBinding(disabled, 'HomeOffice')).toBe(false);
        expect(() => setRuleBinding(disabled, 'HomeOffice', true, ['HomeOffice'])).toThrow('PROFILE_BINDING_PATTERN:');
    });
});
