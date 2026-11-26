import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as jsyamlModule from '../../js-yaml.min.js';
import { parseRulesFromYaml, rebuildYamlWithRules, wrapRulesAsPrismYaml } from './yaml-utils.js';

/** @type {any} */
const yaml = jsyamlModule;

describe('with js-yaml available', () => {
    beforeEach(() => vi.stubGlobal('jsyaml', yaml));
    afterEach(() => vi.unstubAllGlobals());

    describe('parseRulesFromYaml', () => {
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

        it('stringifies non-string entries', () => {
            expect(parseRulesFromYaml('rules:\n  - 123\n')).toEqual(['123']);
        });

        it('falls back to line parsing for raw rule text', () => {
            const src = '# comment\nDOMAIN,a.com,DIRECT\n\n  DOMAIN-SUFFIX,b.com,Proxy  \nnot-a-rule\n';
            expect(parseRulesFromYaml(src)).toEqual(['DOMAIN,a.com,DIRECT', 'DOMAIN-SUFFIX,b.com,Proxy']);
        });

        it('falls back to line parsing for invalid YAML', () => {
            const src = 'rules: [unclosed\nDOMAIN,a.com,DIRECT\n';
            expect(parseRulesFromYaml(src)).toEqual(['DOMAIN,a.com,DIRECT']);
        });
    });

    describe('rebuildYamlWithRules', () => {
        it('preserves metadata and the $prepend operator', () => {
            const original = "__when__:\n  core: mihomo\nrules:\n  $prepend:\n    - 'DOMAIN,old.com,DIRECT'\n";
            const out = yaml.load(rebuildYamlWithRules(original, ['DOMAIN,new.com,Proxy']));
            expect(out).toEqual({
                __when__: { core: 'mihomo' },
                rules: { $prepend: ['DOMAIN,new.com,Proxy'] },
            });
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
        expect(parseRulesFromYaml('# c\nDOMAIN,a.com,DIRECT\nMATCH,Proxy\n')).toEqual(['DOMAIN,a.com,DIRECT', 'MATCH,Proxy']);
    });

    it('rebuildYamlWithRules emits a minimal valid $append document', () => {
        const out = rebuildYamlWithRules('anything', ['DOMAIN,a.com,DIRECT', 'MATCH,Proxy']);
        expect(yaml.load(out)).toEqual({ rules: { $append: ['DOMAIN,a.com,DIRECT', 'MATCH,Proxy'] } });
    });
});
