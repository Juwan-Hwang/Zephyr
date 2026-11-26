import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as jsyamlModule from '../../js-yaml.min.js';
import { parseRulesFromYaml, rebuildYamlWithRules, wrapRulesAsPrismYaml, mixedRuleOperators, hasStructuredRules, countRulesInYaml } from './yaml-utils.js';

/** @type {any} */
const yaml = jsyamlModule;

describe('with js-yaml available', () => {
    beforeEach(() => vi.stubGlobal('jsyaml', yaml));
    afterEach(() => vi.unstubAllGlobals());

    describe('parseRulesFromYaml', () => {
        it.each([
            ['scalar without a comma', [
                'rules:',
                '  - DOMAIN-SUFFIX,example.com,PROXY',
                '  - some yaml mapping without comma',
                '  - DOMAIN,github.com,PROXY',
            ].join('\n')],
            ['nested payload mapping', [
                'rules:',
                '  - DOMAIN-SUFFIX,example.com,PROXY',
                '  - payload:',
                '      - example.com',
                '      - test.com',
                '  - DOMAIN,github.com,PROXY',
            ].join('\n')],
        ])('matches backend top-level entry count for %s', (_description, source) => {
            // Counts describe the document's entries, not whether every value
            // passes rule compilation. Block and flow presentation must agree.
            expect(countRulesInYaml(source)).toBe(3);
            expect(countRulesInYaml(yaml.dump(yaml.load(source), { flowLevel: 0 }))).toBe(3);
        });

        it('does not count nested rule-like strings as separate YAML entries', () => {
            const source = "rules: [{payload: ['DOMAIN,nested.example,DIRECT', 'MATCH,DIRECT']}]";
            expect(countRulesInYaml(source)).toBe(1);
        });

        it.each([
            '- {type: DOMAIN, payload: a.com, proxy: DIRECT}',
            '- type: DOMAIN\n  payload: a.com\n  proxy: DIRECT',
            '["DOMAIN,a.com,DIRECT", "MATCH,Proxy"]',
        ])('does not count a root sequence as a Prism rules mapping: %s', (source) => {
            expect(countRulesInYaml(source)).toBe(0);
        });

        it('counts flow-style, block-style and structured rule entries equally', () => {
            const rules = { $prepend: ['DOMAIN,a.com,DIRECT'], $append: [{ type: 'DOMAIN', payload: 'b.com', proxy: 'Proxy' }] };
            expect(countRulesInYaml(yaml.dump({ rules }))).toBe(2);
            expect(countRulesInYaml('rules: {$prepend: ["DOMAIN,a.com,DIRECT"], $append: [{type: DOMAIN, payload: b.com, proxy: Proxy}]}')).toBe(2);
            expect(countRulesInYaml('rules: {$override: ["MATCH,DIRECT"]}')).toBe(1);
            expect(countRulesInYaml('dns: {enable: false, ipv6: false}')).toBe(0);
            expect(countRulesInYaml('DOMAIN,example.com,DIRECT')).toBe(1);
        });
        it('reads a plain rules array', () => {
            const src = 'rules:\n  - DOMAIN,example.com,DIRECT\n  - MATCH,Proxy\n';
            expect(parseRulesFromYaml(src)).toEqual(['DOMAIN,example.com,DIRECT', 'MATCH,Proxy']);
        });

        it('reads Prism $append rules', () => {
            const src = 'rules:\n  $append:\n    - DOMAIN-SUFFIX,a.com,Proxy\n';
            expect(parseRulesFromYaml(src)).toEqual(['DOMAIN-SUFFIX,a.com,Proxy']);
        });

        it('reads Prism $prepend rules', () => {
            const src = 'rules:\n  $prepend:\n    - IP-CIDR,10.0.0.0/8,DIRECT\n';
            expect(parseRulesFromYaml(src)).toEqual(['IP-CIDR,10.0.0.0/8,DIRECT']);
        });

        it('does not expose removal operands as inserted visual rules', () => {
            const content = 'rules:\n  $remove:\n    - DOMAIN,example.com,Proxy\n';
            expect(parseRulesFromYaml(content)).toEqual([]);
            expect(yaml.load(rebuildYamlWithRules(content, parseRulesFromYaml(content))).rules).toEqual({
                $remove: ['DOMAIN,example.com,Proxy'], $append: [],
            });
        });

        it('stringifies non-string entries', () => {
            expect(parseRulesFromYaml('rules:\n  - 123\n')).toEqual(['123']);
            expect(hasStructuredRules('rules:\n  - 123\n')).toBe(true);
            expect(hasStructuredRules('rules:\n  $prepend:\n    - {type: DOMAIN, payload: a.com, proxy: Proxy}\n')).toBe(true);
            expect(hasStructuredRules('rules:\n  $append:\n    - DOMAIN,a.com,Proxy\n')).toBe(false);
        });

        it('falls back to line parsing for raw rule text', () => {
            const src = '# comment\nDOMAIN,a.com,DIRECT\n\n  DOMAIN-SUFFIX,b.com,Proxy  \nnot-a-rule\n';
            expect(parseRulesFromYaml(src)).toEqual(['DOMAIN,a.com,DIRECT', 'DOMAIN-SUFFIX,b.com,Proxy']);
        });

        it('falls back to line parsing for invalid YAML', () => {
            const src = 'rules: [unclosed\nDOMAIN,a.com,DIRECT\n';
            expect(parseRulesFromYaml(src)).toEqual(['DOMAIN,a.com,DIRECT']);
            expect(hasStructuredRules(src)).toBe(true);
        });

        it('recognizes a YAML mapping before treating comma-delimited keys as raw rules', () => {
            expect(hasStructuredRules('DOMAIN,example.com,DIRECT: note')).toBe(true);
            expect(hasStructuredRules('DOMAIN,example.com,DIRECT')).toBe(false);
            expect(hasStructuredRules('DOMAIN,a.com,DIRECT\nPROCESS-NAME, a: b,Proxy')).toBe(false);
        });
    });

    describe('rebuildYamlWithRules', () => {
        it.each([
            { $prepend: ['DOMAIN,a.com,DIRECT'], $append: null },
            { $prepend: null, $append: ['DOMAIN,a.com,DIRECT'] },
        ])('preserves both mixed-list operators when one side is null: %j', (oldRules) => {
            const original = yaml.dump({ rules: oldRules });
            const changed = ['DOMAIN,b.com,DIRECT'];
            const expected = oldRules.$prepend === null
                ? { $prepend: [], $append: changed }
                : { $prepend: changed, $append: [] };
            expect(yaml.load(rebuildYamlWithRules(original, changed)).rules).toEqual(expected);
            expect(yaml.load(wrapRulesAsPrismYaml(changed.join('\n'), original)).rules).toEqual(expected);
        });

        it('preserves metadata and the $prepend operator', () => {
            const original = "__when__:\n  core: mihomo\nrules:\n  $prepend:\n    - 'DOMAIN,old.com,DIRECT'\n";
            const out = yaml.load(rebuildYamlWithRules(original, ['DOMAIN,new.com,Proxy']));
            expect(out).toEqual({
                __when__: { core: 'mihomo' },
                rules: { $prepend: ['DOMAIN,new.com,Proxy'] },
            });
        });

        it('keeps $filter / $remove / $transform beside the edited lists', () => {
            const original = "rules:\n  $filter: \"!x.includes('ads')\"\n  $remove: \"x.startsWith('MATCH')\"\n  $transform: \"x.replace('Proxy', 'Auto')\"\n  $append:\n    - DOMAIN,b.com,Proxy\n";
            const kept = { $filter: "!x.includes('ads')", $remove: "x.startsWith('MATCH')", $transform: "x.replace('Proxy', 'Auto')" };
            const out = yaml.load(rebuildYamlWithRules(original, ['DOMAIN,c.com,Proxy']));
            expect(out).toEqual({ rules: { ...kept, $append: ['DOMAIN,c.com,Proxy'] } });
            const wrapped = yaml.load(wrapRulesAsPrismYaml('DOMAIN,d.com,Proxy', original));
            expect(wrapped.rules).toEqual({ ...kept, $append: ['DOMAIN,d.com,Proxy'] });
        });

        it('preserves other operators and unknown rule metadata when replacing lists', () => {
            const kept = { $default: ['MATCH,DIRECT'], futureOperator: { enabled: true } };
            const original = yaml.dump({ rules: { ...kept, $prepend: ['DOMAIN,a.com,DIRECT'], $append: ['DOMAIN,b.com,Proxy'] } });
            const rules = ['DOMAIN,a2.com,DIRECT', 'DOMAIN,b.com,Proxy'];
            const expected = { ...kept, $prepend: [rules[0]], $append: [rules[1]] };
            expect(yaml.load(rebuildYamlWithRules(original, rules)).rules).toEqual(expected);
            expect(yaml.load(wrapRulesAsPrismYaml(rules.join('\n'), original)).rules).toEqual(expected);
        });

        it('keeps duplicate rows in their original lists while editing their neighbours', () => {
            const duplicate = 'DOMAIN,duplicate.com,DIRECT';
            const original = yaml.dump({ rules: {
                $prepend: [duplicate, 'DOMAIN,before.com,Proxy', duplicate],
                $append: [duplicate, 'DOMAIN,after.com,Proxy', duplicate],
            } });
            const rules = [duplicate, 'DOMAIN,changed-before.com,Proxy', duplicate, duplicate, 'DOMAIN,changed-after.com,Proxy', duplicate];
            expect(yaml.load(rebuildYamlWithRules(original, rules)).rules).toEqual({
                $prepend: rules.slice(0, 3), $append: rules.slice(3),
            });
        });

        it('retains the inferred operators across alternating old positions and inserted rows', () => {
            const before = ['DOMAIN,a.com,DIRECT', 'DOMAIN,b.com,DIRECT', 'DOMAIN,c.com,DIRECT'];
            const after = ['DOMAIN,d.com,Proxy', 'DOMAIN,e.com,Proxy', 'DOMAIN,f.com,Proxy'];
            const rules = [before[0], 'DOMAIN,new1.com,DIRECT', after[2], before[1], 'DOMAIN,new2.com,DIRECT', after[1], before[2], after[0]];
            const result = yaml.load(rebuildYamlWithRules(yaml.dump({ rules: { $prepend: before, $append: after } }), rules));
            expect(result.rules).toEqual({ $prepend: rules.slice(0, 7), $append: rules.slice(7) });
        });

        it('keeps a changed duplicate in its original list using editor row identity', () => {
            const a = 'DOMAIN,a.com,DIRECT';
            const b = 'DOMAIN,b.com,DIRECT';
            const original = yaml.dump({ rules: { $prepend: [a], $append: [a] } });
            const operators = mixedRuleOperators(original);
            expect(yaml.load(rebuildYamlWithRules(original, [b, a], operators)).rules).toEqual({ $prepend: [b], $append: [a] });
            const different = yaml.dump({ rules: { $prepend: [a], $append: [b] } });
            expect(yaml.load(rebuildYamlWithRules(different, [b, b], mixedRuleOperators(different))).rules).toEqual({ $prepend: [b], $append: [b] });
        });

        it('keeps a legacy null mixed list on the explicit operator path', () => {
            const content = 'rules:\n  $prepend:\n  $append: ["DOMAIN,a.com,DIRECT", "DOMAIN,b.com,Proxy"]\n';
            const operators = mixedRuleOperators(content);
            expect(operators).toEqual(['$append', '$append']);
            expect(yaml.load(rebuildYamlWithRules(content, ['DOMAIN,b.com,Proxy', 'DOMAIN,a.com,DIRECT'], operators)).rules).toEqual({
                $prepend: [], $append: ['DOMAIN,b.com,Proxy', 'DOMAIN,a.com,DIRECT'],
            });
        });

        it('retains list operators without the modern Object.hasOwn API', () => {
            const unavailable = vi.spyOn(Object, 'hasOwn').mockImplementation(() => { throw new Error('Object.hasOwn unavailable'); });
            let operators;
            let result;
            try {
                const original = 'rules: {$prepend: [], $append: ["MATCH,Proxy"]}\n';
                operators = mixedRuleOperators(original);
                result = rebuildYamlWithRules(original, ['MATCH,DIRECT'], operators);
            } finally { unavailable.mockRestore(); }
            expect(operators).toEqual(['$append']);
            expect(yaml.load(result).rules).toEqual({ $prepend: [], $append: ['MATCH,DIRECT'] });
        });

        it('keeps override rule files out of the list-operator editor', () => {
            const original = 'rules:\n  $override:\n    - MATCH,DIRECT\n';
            expect(hasStructuredRules(original)).toBe(true);
            expect(yaml.load(rebuildYamlWithRules(original, ['MATCH,Proxy'])).rules).toEqual({ $override: ['MATCH,Proxy'] });
        });

        it('does not restore a deleted prepend duplicate ahead of the profile rules', () => {
            const a = 'DOMAIN,a.com,DIRECT';
            const original = yaml.dump({ rules: { $prepend: [a], $append: [a] } });
            const operators = mixedRuleOperators(original);
            operators.splice(0, 1);
            expect(yaml.load(rebuildYamlWithRules(original, [a], operators)).rules).toEqual({ $prepend: [], $append: [a] });
        });

        it('keeps both lists of a file that has $prepend and $append', () => {
            const original = 'rules:\n  $prepend:\n    - DOMAIN,a.com,DIRECT\n  $append:\n    - DOMAIN,b.com,Proxy\n';
            expect(parseRulesFromYaml(original)).toEqual(['DOMAIN,a.com,DIRECT', 'DOMAIN,b.com,Proxy']);
            // Edited in the library: a.com changed, c.com added after b.com.
            const out = yaml.load(rebuildYamlWithRules(original, ['DOMAIN,a2.com,DIRECT', 'DOMAIN,b.com,Proxy', 'DOMAIN,c.com,Proxy']));
            expect(out).toEqual({ rules: { $prepend: ['DOMAIN,a2.com,DIRECT'], $append: ['DOMAIN,b.com,Proxy', 'DOMAIN,c.com,Proxy'] } });
        });

        it('keeps an edited first $append rule appended', () => {
            const original = 'rules:\n  $prepend:\n    - DOMAIN,a.com,DIRECT\n  $append:\n    - DOMAIN,b.com,Proxy\n';
            const out = yaml.load(rebuildYamlWithRules(original, ['DOMAIN,a.com,DIRECT', 'DOMAIN,b2.com,Proxy']));
            expect(out).toEqual({ rules: { $prepend: ['DOMAIN,a.com,DIRECT'], $append: ['DOMAIN,b2.com,Proxy'] } });
        });

        it('keeps an edited $append rule appended when the count changes', () => {
            const original = 'rules:\n  $prepend:\n    - DOMAIN,a.com,DIRECT\n  $append:\n    - DOMAIN,b.com,Proxy\n    - DOMAIN,c.com,Proxy\n';
            // b.com edited and c.com deleted in one save.
            let out = yaml.load(rebuildYamlWithRules(original, ['DOMAIN,a.com,DIRECT', 'DOMAIN,b2.com,Proxy']));
            expect(out).toEqual({ rules: { $prepend: ['DOMAIN,a.com,DIRECT'], $append: ['DOMAIN,b2.com,Proxy'] } });
            // b.com edited and d.com added after it.
            out = yaml.load(rebuildYamlWithRules(original, ['DOMAIN,a.com,DIRECT', 'DOMAIN,b2.com,Proxy', 'DOMAIN,d.com,Proxy', 'DOMAIN,c.com,Proxy']));
            expect(out).toEqual({ rules: { $prepend: ['DOMAIN,a.com,DIRECT'], $append: ['DOMAIN,b2.com,Proxy', 'DOMAIN,d.com,Proxy', 'DOMAIN,c.com,Proxy'] } });
            // A rule added right after a.com joins its list.
            out = yaml.load(rebuildYamlWithRules(original, ['DOMAIN,a.com,DIRECT', 'DOMAIN,x.com,DIRECT', 'DOMAIN,b.com,Proxy', 'DOMAIN,c.com,Proxy']));
            expect(out).toEqual({ rules: { $prepend: ['DOMAIN,a.com,DIRECT', 'DOMAIN,x.com,DIRECT'], $append: ['DOMAIN,b.com,Proxy', 'DOMAIN,c.com,Proxy'] } });
        });

        it('saves the shown order when a rule is moved across the list boundary', () => {
            const original = 'rules:\n  $prepend:\n    - DOMAIN,a.com,REJECT\n    - DOMAIN,x.com,DIRECT\n  $append:\n    - DOMAIN,b.com,DIRECT\n    - DOMAIN,c.com,Proxy\n';
            // b.com moved to the top: it now matches before a.com.
            const out = yaml.load(rebuildYamlWithRules(original, ['DOMAIN,b.com,DIRECT', 'DOMAIN,a.com,REJECT', 'DOMAIN,x.com,DIRECT', 'DOMAIN,c.com,Proxy']));
            expect(out).toEqual({ rules: { $prepend: ['DOMAIN,b.com,DIRECT', 'DOMAIN,a.com,REJECT', 'DOMAIN,x.com,DIRECT'], $append: ['DOMAIN,c.com,Proxy'] } });
        });

        it('keeps an untouched $prepend rule there when a rule moves above it (tie)', () => {
            const original = 'rules:\n  $prepend:\n    - DOMAIN,a.com,REJECT\n  $append:\n    - DOMAIN,b.com,DIRECT\n    - DOMAIN,c.com,Proxy\n';
            const out = yaml.load(rebuildYamlWithRules(original, ['DOMAIN,b.com,DIRECT', 'DOMAIN,a.com,REJECT', 'DOMAIN,c.com,Proxy']));
            expect(out).toEqual({ rules: { $prepend: ['DOMAIN,b.com,DIRECT', 'DOMAIN,a.com,REJECT'], $append: ['DOMAIN,c.com,Proxy'] } });
        });

        it('keeps $append when the original used it', () => {
            const original = 'rules:\n  $append:\n    - MATCH,DIRECT\n';
            const out = yaml.load(rebuildYamlWithRules(original, ['MATCH,Proxy']));
            expect(out).toEqual({ rules: { $append: ['MATCH,Proxy'] } });
        });

        it('converts a plain rules array to $append', () => {
            const original = 'name: test\nrules:\n  - MATCH,DIRECT\n';
            const out = yaml.load(rebuildYamlWithRules(original, ['MATCH,Proxy']));
            expect(out).toEqual({ name: 'test', rules: { $append: ['MATCH,Proxy'] } });
        });

        it('retains a plain sequence explicitly entered in full YAML across visual edits', () => {
            const source = 'name: test\nrules: ["MATCH,DIRECT"]\n';
            expect(yaml.load(rebuildYamlWithRules(source, ['MATCH,Proxy'], null, true))).toEqual({ name: 'test', rules: ['MATCH,Proxy'] });
        });

        it('emits a minimal $append document when the original has no structure', () => {
            const out = yaml.load(rebuildYamlWithRules('', ['DOMAIN,a.com,DIRECT']));
            expect(out).toEqual({ rules: { $append: ['DOMAIN,a.com,DIRECT'] } });
        });

        it('round-trips rules containing YAML-significant characters', () => {
            const rules = ["DOMAIN-KEYWORD,it's,DIRECT", 'DOMAIN,a.com #x,Proxy', 'PROCESS-NAME,a: b,DIRECT'];
            const rebuilt = rebuildYamlWithRules('name: x\nrules: []\n', rules);
            expect(parseRulesFromYaml(rebuilt)).toEqual(rules);
        });

        it('does not keep line-wrapping for long rules', () => {
            const long = `DOMAIN,${'a'.repeat(200)}.com,DIRECT`;
            const rebuilt = rebuildYamlWithRules('rules: []\n', [long]);
            expect(rebuilt.split('\n').some(l => l.includes(long))).toBe(true);
        });
    });

    describe('wrapRulesAsPrismYaml', () => {
        it('wraps raw text lines, skipping blanks and comments', () => {
            const out = yaml.load(wrapRulesAsPrismYaml('# header\nDOMAIN,a.com,DIRECT\n\n  MATCH,Proxy  \n', ''));
            expect(out).toEqual({ rules: { $append: ['DOMAIN,a.com,DIRECT', 'MATCH,Proxy'] } });
        });

        it('preserves metadata and the operator of the original file', () => {
            const original = '__when__:\n  os: windows\nrules:\n  $prepend:\n    - MATCH,DIRECT\n';
            const out = yaml.load(wrapRulesAsPrismYaml('DOMAIN,b.com,Proxy', original));
            expect(out).toEqual({ __when__: { os: 'windows' }, rules: { $prepend: ['DOMAIN,b.com,Proxy'] } });
        });

        it('falls back to a minimal document when the original is invalid YAML', () => {
            const out = yaml.load(wrapRulesAsPrismYaml('MATCH,DIRECT', 'rules: [unclosed'));
            expect(out).toEqual({ rules: { $append: ['MATCH,DIRECT'] } });
        });

        it('produces output that parseRulesFromYaml reads back', () => {
            const text = 'DOMAIN,a.com,DIRECT\nDOMAIN-SUFFIX,b.com,Proxy';
            expect(parseRulesFromYaml(wrapRulesAsPrismYaml(text, ''))).toEqual(text.split('\n'));
        });
    });
});

describe('without js-yaml', () => {
    // Make the absence explicit instead of relying on how the vendored bundle
    // behaves when imported.
    beforeEach(() => vi.stubGlobal('jsyaml', undefined));
    afterEach(() => vi.unstubAllGlobals());

    it('parseRulesFromYaml uses line-based parsing', () => {
        expect(typeof (/** @type {any} */ (globalThis)).jsyaml).toBe('undefined');
        expect(hasStructuredRules('rules: { $prepend: [{type: DOMAIN, payload: a.com}] }')).toBe(true);
        expect(parseRulesFromYaml('# c\nDOMAIN,a.com,DIRECT\nMATCH,Proxy\n')).toEqual(['DOMAIN,a.com,DIRECT', 'MATCH,Proxy']);
    });

    it('rebuildYamlWithRules emits a minimal valid $append document', () => {
        const out = rebuildYamlWithRules('anything', ['DOMAIN,a.com,DIRECT', 'MATCH,Proxy']);
        expect(yaml.load(out)).toEqual({ rules: { $append: ['DOMAIN,a.com,DIRECT', 'MATCH,Proxy'] } });
    });
});
