// Tests for the js-yaml-free fallback paths in yaml-utils.js.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRulesFromYaml, rebuildYamlWithRules, wrapRulesAsPrismYaml } from './yaml-utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Load the vendored js-yaml bundle (the same file index.html loads) without
 * installing it on globalThis, so tests can validate fallback output.
 * @returns {{ load(input: string): any, dump(obj: any, opts?: any): string }}
 */
function loadVendoredJsYaml() {
    const src = readFileSync(path.resolve(__dirname, '../../js-yaml.min.js'), 'utf8');
    const mod = { exports: {} };
    // eslint-disable-next-line no-new-func
    new Function('exports', 'module', src)(mod.exports, mod);
    return /** @type {any} */ (mod.exports);
}

const realYaml = loadVendoredJsYaml();

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('yaml-utils without js-yaml', () => {
    it('jsyaml is not defined in the test environment', () => {
        expect(typeof (/** @type {any} */ (globalThis).jsyaml)).toBe('undefined');
    });

    describe('parseRulesFromYaml line-based fallback', () => {
        it('strips "- " list markers and surrounding quotes', () => {
            const content = [
                'rules:',
                '  $append:',
                "    - 'DOMAIN-SUFFIX,example.com,DIRECT'",
                '    - "DOMAIN,foo.com,Proxy"',
                '    - IP-CIDR,10.0.0.0/8,DIRECT',
                "    - 'DOMAIN-KEYWORD,it''s,REJECT'",
                '# comment, with comma',
                '',
            ].join('\n');
            expect(parseRulesFromYaml(content)).toEqual([
                'DOMAIN-SUFFIX,example.com,DIRECT',
                'DOMAIN,foo.com,Proxy',
                'IP-CIDR,10.0.0.0/8,DIRECT',
                "DOMAIN-KEYWORD,it's,REJECT",
            ]);
        });

        it('decodes YAML-only double-quoted escapes', () => {
            const content = 'rules:\n  - "DOMAIN,\\x41.com,\\u00e9\\e"\n  - "bad,\\q"\n';
            // Invalid escapes are left as written rather than guessed at.
            expect(parseRulesFromYaml(content)).toEqual(['DOMAIN,A.com,\u00e9\x1b', '"bad,\\q"']);
            expect(parseRulesFromYaml(content)[0]).toBe(realYaml.load(content.split('\n  - "bad')[0]).rules[0]);
        });

        it('drops trailing comments but keeps # inside rules', () => {
            const content = [
                'rules:',
                '  - DOMAIN,a.com,DIRECT # office',
                "  - 'DOMAIN,b.com,Proxy'   # quoted",
                '  - "DOMAIN,c.com,REJECT" #x',
                '  - DOMAIN-KEYWORD,a#b,DIRECT',
                "  - 'DOMAIN,it''s # not a comment,DIRECT'",
            ].join('\n');
            expect(parseRulesFromYaml(content)).toEqual([
                'DOMAIN,a.com,DIRECT',
                'DOMAIN,b.com,Proxy',
                'DOMAIN,c.com,REJECT',
                'DOMAIN-KEYWORD,a#b,DIRECT',
                "DOMAIN,it's # not a comment,DIRECT",
            ]);
            expect(parseRulesFromYaml(content)).toEqual(realYaml.load(content).rules);
        });

        it('keeps plain rule lines unchanged', () => {
            expect(parseRulesFromYaml('DOMAIN,a.com,DIRECT\nMATCH,Proxy\n')).toEqual([
                'DOMAIN,a.com,DIRECT',
                'MATCH,Proxy',
            ]);
        });

        it('drops bare list markers and lines without a comma', () => {
            expect(parseRulesFromYaml('-\n- \n- just-text\n- GEOIP,CN,DIRECT')).toEqual(['GEOIP,CN,DIRECT']);
        });

        it('matches the structured parser on a simple document', () => {
            const content = "rules:\n  $append:\n    - 'DOMAIN,a.com,DIRECT'\n    - 'MATCH,Proxy'\n";
            const fallback = parseRulesFromYaml(content);
            vi.stubGlobal('jsyaml', realYaml);
            expect(parseRulesFromYaml(content)).toEqual(fallback);
        });
    });

    describe('rebuildYamlWithRules fallback', () => {
        it('escapes single quotes so the output is valid YAML', () => {
            const rules = ["DOMAIN-KEYWORD,it's,REJECT", 'DOMAIN,a.com,DIRECT'];
            const out = rebuildYamlWithRules('', rules);
            expect(out).toContain("    - 'DOMAIN-KEYWORD,it''s,REJECT'");
            expect(realYaml.load(out)).toEqual({ rules: { $append: rules } });
        });

        it('keeps the previous output shape for ordinary rules', () => {
            expect(rebuildYamlWithRules('', ['DOMAIN,a.com,DIRECT'])).toBe(
                "rules:\n  $append:\n    - 'DOMAIN,a.com,DIRECT'\n",
            );
        });

        it('emits an empty list rather than null for no rules', () => {
            expect(realYaml.load(rebuildYamlWithRules('', []))).toEqual({ rules: { $append: [] } });
        });

        it('escapes characters YAML cannot hold literally (DEL, C1, lone surrogates)', () => {
            const rules = ['DOMAIN,a\u007f.com,DIRECT', 'DOMAIN,b\u0085\u0090.com,DIRECT', 'DOMAIN,\ud800x,DIRECT', 'DOMAIN,😀.com,"q"\\'];
            const out = rebuildYamlWithRules('', rules);
            expect(realYaml.load(out)).toEqual({ rules: { $append: rules } });
            expect(parseRulesFromYaml(out)).toEqual(rules);
        });

        it('round-trips values with control characters', () => {
            const rules = ['DOMAIN,a.com,DIRECT\tx'];
            expect(realYaml.load(rebuildYamlWithRules('', rules))).toEqual({ rules: { $append: rules } });
        });
    });

    describe('wrapRulesAsPrismYaml fallback', () => {
        it('does not throw when js-yaml is unavailable', () => {
            const raw = "DOMAIN,a.com,DIRECT\n# comment\nDOMAIN-KEYWORD,it's,REJECT\n";
            let out = '';
            expect(() => {
                out = wrapRulesAsPrismYaml(raw, 'rules:\n  $prepend: []\n');
            }).not.toThrow();
            expect(realYaml.load(out)).toEqual({
                rules: { $prepend: ['DOMAIN,a.com,DIRECT', "DOMAIN-KEYWORD,it's,REJECT"] },
            });
        });

        it('keeps metadata, comments and the $prepend operator of the original', () => {
            const original = [
                '# header comment',
                '__when__:',
                '  os: windows',
                'rules:',
                '  $prepend:',
                "    - 'DOMAIN,old.com,DIRECT'",
                '',
                'name: demo',
                '',
            ].join('\n');
            const out = wrapRulesAsPrismYaml('DOMAIN,new.com,Proxy', original);
            expect(out.startsWith('# header comment\n')).toBe(true);
            expect(realYaml.load(out)).toEqual({
                __when__: { os: 'windows' },
                rules: { $prepend: ['DOMAIN,new.com,Proxy'] },
                name: 'demo',
            });
            expect(realYaml.load(rebuildYamlWithRules(original, ['DOMAIN,x.com,DIRECT']))).toEqual({
                __when__: { os: 'windows' },
                rules: { $prepend: ['DOMAIN,x.com,DIRECT'] },
                name: 'demo',
            });
        });

        it('reads the operator from the block keys, not comments or rule text', () => {
            const appendWithNoise = [
                'rules:',
                '  # $prepend: was used before',
                '  $append:',
                "    - 'DOMAIN,x.com,DIRECT' # $prepend: no",
                '',
            ].join('\n');
            expect(realYaml.load(wrapRulesAsPrismYaml('DOMAIN,a.com,DIRECT', appendWithNoise))).toEqual({
                rules: { $append: ['DOMAIN,a.com,DIRECT'] },
            });
            expect(realYaml.load(wrapRulesAsPrismYaml('DOMAIN,a.com,DIRECT', 'rules: { $prepend: [] }\n'))).toEqual({
                rules: { $prepend: ['DOMAIN,a.com,DIRECT'] },
            });
            expect(realYaml.load(wrapRulesAsPrismYaml('DOMAIN,a.com,DIRECT', "rules:\n  '$prepend':\n    - 'X,y,DIRECT'\n"))).toEqual({
                rules: { $prepend: ['DOMAIN,a.com,DIRECT'] },
            });
        });

        it('adds a rules block when the original mapping has none', () => {
            const out = wrapRulesAsPrismYaml('DOMAIN,a.com,DIRECT', '__when__:\n  os: linux\n');
            expect(realYaml.load(out)).toEqual({
                __when__: { os: 'linux' },
                rules: { $append: ['DOMAIN,a.com,DIRECT'] },
            });
        });

        it('falls back to a minimal document for non-block originals', () => {
            const out = wrapRulesAsPrismYaml('DOMAIN,a.com,DIRECT', '{rules: {$prepend: []}}');
            expect(realYaml.load(out)).toEqual({ rules: { $append: ['DOMAIN,a.com,DIRECT'] } });
        });

        it('treats unindented sequence items as part of the previous key', () => {
            const original = "meta:\n- foo: bar\nrules:\n  $prepend:\n    - old\nname: demo\n";
            const out = wrapRulesAsPrismYaml('DOMAIN,a.com,DIRECT', original);
            expect(realYaml.load(out)).toEqual({
                meta: [{ foo: 'bar' }],
                rules: { $prepend: ['DOMAIN,a.com,DIRECT'] },
                name: 'demo',
            });
        });

        it('keeps metadata in a document framed by --- and ... markers', () => {
            const original = "---\n__when__:\n  os: macos\nrules:\n  $prepend:\n    - old\nname: demo\n...\n";
            const out = wrapRulesAsPrismYaml('DOMAIN,new.com,Proxy', original);
            expect(out.startsWith('---\n')).toBe(true);
            expect(out.trimEnd().endsWith('...')).toBe(true);
            expect(realYaml.load(out)).toEqual({
                __when__: { os: 'macos' },
                rules: { $prepend: ['DOMAIN,new.com,Proxy'] },
                name: 'demo',
            });
            const noRules = wrapRulesAsPrismYaml('DOMAIN,a.com,DIRECT', '---\nname: demo\n...\n');
            expect(realYaml.load(noRules)).toEqual({ name: 'demo', rules: { $append: ['DOMAIN,a.com,DIRECT'] } });
        });

        it('falls back to a minimal document for multi-document originals', () => {
            const out = wrapRulesAsPrismYaml('DOMAIN,a.com,DIRECT', 'name: a\n---\nname: b\n');
            expect(realYaml.load(out)).toEqual({ rules: { $append: ['DOMAIN,a.com,DIRECT'] } });
        });

        it('falls back to a minimal document when rules appears twice', () => {
            const original = 'rules:\n  $append:\n    - old1\nname: demo\nrules:\n  $append:\n    - old2\n';
            const out = wrapRulesAsPrismYaml('DOMAIN,a.com,DIRECT', original);
            expect(parseRulesFromYaml(out)).toEqual(['DOMAIN,a.com,DIRECT']);
            expect(realYaml.load(out)).toEqual({ rules: { $append: ['DOMAIN,a.com,DIRECT'] } });
        });

        it('falls back to a minimal document when kept entries alias an anchor in rules', () => {
            const original = 'name: demo\nrules: &shared\n  $append:\n    - old1\nbackup: *shared\n';
            const out = wrapRulesAsPrismYaml('DOMAIN,a.com,DIRECT', original);
            expect(realYaml.load(out)).toEqual({ rules: { $append: ['DOMAIN,a.com,DIRECT'] } });
        });

        it('keeps metadata when an anchor in rules is not referenced elsewhere', () => {
            const original = 'name: demo\nrules: &shared\n  $append:\n    - old1\n';
            const out = wrapRulesAsPrismYaml('DOMAIN,a.com,DIRECT', original);
            expect(realYaml.load(out)).toEqual({ name: 'demo', rules: { $append: ['DOMAIN,a.com,DIRECT'] } });
        });

        it('falls back to a minimal document when kept metadata is malformed', () => {
            for (const original of [
                'name: [unterminated\nrules:\n  $append:\n    - old\n',
                'name: [unterminated\n',
                "name: 'open\nrules:\n  $prepend:\n    - old\n",
                'meta: {a: 1]\n',
            ]) {
                const out = wrapRulesAsPrismYaml("DOMAIN,it's.com,DIRECT", original);
                expect(realYaml.load(out), original).toEqual({ rules: { $append: ["DOMAIN,it's.com,DIRECT"] } });
                const rebuilt = rebuildYamlWithRules(original, ['DOMAIN,a.com,DIRECT']);
                expect(realYaml.load(rebuilt), original).toEqual({ rules: { $append: ['DOMAIN,a.com,DIRECT'] } });
            }
        });

        it('keeps plain scalars with brackets and non-ASCII keys in metadata', () => {
            const original = 'name: foo[bar\nnote: x]y{z\n描述: 规则\nrules:\n  $prepend:\n    - old\n';
            const expected = { name: 'foo[bar', note: 'x]y{z', 描述: '规则', rules: { $prepend: ['DOMAIN,a.com,DIRECT'] } };
            expect(realYaml.load(wrapRulesAsPrismYaml('DOMAIN,a.com,DIRECT', original))).toEqual(expected);
            expect(realYaml.load(rebuildYamlWithRules(original, ['DOMAIN,a.com,DIRECT']))).toEqual(expected);
        });

        it('keeps well-formed flow values, quotes and comments in metadata', () => {
            const original = "name: it's fine # note [\ntags: [a, 'b]', \"c\\\"}\"]\nurl: http://x/#frag\nrules:\n  $prepend:\n    - old\n";
            const out = wrapRulesAsPrismYaml('DOMAIN,a.com,DIRECT', original);
            expect(realYaml.load(out)).toEqual({
                name: "it's fine",
                tags: ['a', 'b]', 'c"}'],
                url: 'http://x/#frag',
                rules: { $prepend: ['DOMAIN,a.com,DIRECT'] },
            });
        });

        it('handles empty input', () => {
            expect(realYaml.load(wrapRulesAsPrismYaml('', ''))).toEqual({ rules: { $append: [] } });
        });
    });
});

describe('yaml-utils with js-yaml', () => {
    it('wrapRulesAsPrismYaml ignores a top-level array original', () => {
        vi.stubGlobal('jsyaml', realYaml);
        const out = wrapRulesAsPrismYaml('DOMAIN,a.com,DIRECT', '- foo\n- bar\n');
        expect(realYaml.load(out)).toEqual({ rules: { $append: ['DOMAIN,a.com,DIRECT'] } });
    });

    it('wrapRulesAsPrismYaml still preserves metadata and the DSL operator', () => {
        vi.stubGlobal('jsyaml', realYaml);
        const original = "__when__:\n  core: mihomo\nrules:\n  $prepend:\n    - 'MATCH,DIRECT'\n";
        const out = wrapRulesAsPrismYaml('DOMAIN,a.com,DIRECT', original);
        expect(realYaml.load(out)).toEqual({
            __when__: { core: 'mihomo' },
            rules: { $prepend: ['DOMAIN,a.com,DIRECT'] },
        });
    });

    it('wrapRulesAsPrismYaml without an original uses js-yaml output', () => {
        vi.stubGlobal('jsyaml', realYaml);
        const out = wrapRulesAsPrismYaml('DOMAIN,a.com,DIRECT', '');
        expect(out).toBe(realYaml.dump({ rules: { $append: ['DOMAIN,a.com,DIRECT'] } }, { lineWidth: -1, quotingType: "'", forceQuotes: false }));
    });

    it('rebuildYamlWithRules with js-yaml is unchanged for objects', () => {
        vi.stubGlobal('jsyaml', realYaml);
        const out = rebuildYamlWithRules("name: x\nrules:\n  - 'MATCH,DIRECT'\n", ['DOMAIN,a.com,DIRECT']);
        expect(realYaml.load(out)).toEqual({ name: 'x', rules: { $append: ['DOMAIN,a.com,DIRECT'] } });
    });

    it('rebuildYamlWithRules never writes back a line js-yaml rejected', () => {
        vi.stubGlobal('jsyaml', realYaml);
        const out = rebuildYamlWithRules('name: [unterminated\nrules:\n  - old\n', ['DOMAIN,a.com,DIRECT']);
        expect(realYaml.load(out)).toEqual({ rules: { $append: ['DOMAIN,a.com,DIRECT'] } });
    });

    it('rebuildYamlWithRules keeps metadata when only the rules block was malformed', () => {
        vi.stubGlobal('jsyaml', realYaml);
        const out = rebuildYamlWithRules("name: demo\nrules:\n  $prepend:\n    - 'bad\n", ['DOMAIN,a.com,DIRECT']);
        expect(realYaml.load(out)).toEqual({ name: 'demo', rules: { $prepend: ['DOMAIN,a.com,DIRECT'] } });
    });
});
