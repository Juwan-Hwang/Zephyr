import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as yaml from '../../js-yaml.min.js';
import { readRuleBinding, setRuleBinding } from './profile-rule-binding.js';

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
});
