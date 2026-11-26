import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock('../api.js', () => ({ invoke: invokeMock, coreReplacements: vi.fn(() => 0) }));
vi.mock('./prism.js', () => ({ apply: vi.fn(async () => {}), rebuild: vi.fn(async () => {}), rebuildWithOverrides: vi.fn(async () => {}), listRules: vi.fn(async () => []), listRuleSnapshot: vi.fn(async () => ({ groups: [], rules: [] })) }));

const cr = await import('./conn-rule.js');
const prism = await import('./prism.js');

const conn = (rule, payload, chains = ['HK 01', 'Proxy'], meta = {}) => ({
    rule, rulePayload: payload, chains,
    metadata: { host: 'api.example.com', destinationIP: '1.2.3.4', process: 'Chrome', ...meta },
});

// These fixtures contain only library rules; supply their matching runtime
// positions explicitly, as the snapshot command does in the application.
function sourceInLibrary(connection, groups) {
    const running = [];
    let next = 0;
    const indexed = groups.map((group) => ({ ...group, rules: group.rules.map((rule) => {
        const entry = typeof rule === 'string' ? { raw: rule } : rule;
        const index = entry.index ?? next;
        next = index + 1;
        if (group.enabled !== false) running[index] = entry.raw;
        return { ...entry, index };
    }) }));
    return cr.findRuleSource(connection, indexed, running);
}

describe('conn-rule helpers', () => {
    beforeEach(() => { invokeMock.mockReset(); vi.mocked(prism.apply).mockClear(); });

    it('maps mihomo rule names to config keywords', () => {
        expect(cr.ruleKeyword('DomainSuffix')).toBe('DOMAIN-SUFFIX');
        expect(cr.ruleKeyword('IPCIDR')).toBe('IP-CIDR');
        expect(cr.ruleKeyword('RuleSet')).toBe('RULE-SET');
        expect(cr.ruleKeyword('Match')).toBe('MATCH');
        expect(cr.ruleKeyword('')).toBe('MATCH');
        expect(cr.ruleKeyword('SomethingNew')).toBe('SOMETHING-NEW');
    });

    it('reads the policy group from the end of the chain', () => {
        expect(cr.rulePolicy(conn('Match', ''))).toBe('Proxy');
        expect(cr.rulePolicy({})).toBe('');
    });

    it('finds a library rule as editable, and everything else as add-only', () => {
        const groups = [
            { group_id: 'ads.prism.yaml', label: 'ads', immutable: false, rules: [{ raw: 'DOMAIN,ad.com,REJECT' }] },
            { group_id: 'mine.prism.yaml', label: 'mine', immutable: false, rules: [{ raw: 'DOMAIN-SUFFIX,example.com,Proxy' }] },
        ];
        expect(sourceInLibrary(conn('DomainSuffix', 'example.com'), groups)).toEqual({ kind: 'mine', file: 'mine.prism.yaml', label: 'mine', raw: 'DOMAIN-SUFFIX,example.com,Proxy' });
        expect(cr.findRuleSource(conn('DomainSuffix', 'example.com', ['HK', 'Other']), groups)).toEqual({ kind: 'sub' });
        expect(cr.findRuleSource(conn('DomainSuffix', 'other.com'), groups)).toEqual({ kind: 'sub' });
        expect(cr.findRuleSource(conn('RuleSet', 'google'), groups)).toEqual({ kind: 'set' });
        expect(cr.findRuleSource(conn('Match', ''), groups)).toEqual({ kind: 'match' });
        const locked = [{ ...groups[1], immutable: true }];
        expect(cr.findRuleSource(conn('DomainSuffix', 'example.com'), locked)).toEqual({ kind: 'sub' });
        // Two files with the rule: the one placed first in the running rules matched.
        const both = [
            { group_id: 'late.prism.yaml', label: 'late', immutable: false, rules: [{ raw: 'DOMAIN-SUFFIX,example.com,Proxy', index: 40 }] },
            { group_id: 'early.prism.yaml', label: 'early', immutable: false, rules: [{ raw: 'DOMAIN-SUFFIX,example.com,Proxy', index: 2 }] },
        ];
        expect(sourceInLibrary(conn('DomainSuffix', 'example.com'), both)).toMatchObject({ kind: 'mine', file: 'early.prism.yaml' });
    });

    it('offers domain, address and process matches', () => {
        expect(cr.addOptions(conn('Match', ''))).toEqual([
            { type: 'DOMAIN-SUFFIX', value: 'example.com' },
            { type: 'DOMAIN', value: 'api.example.com' },
            { type: 'DOMAIN-KEYWORD', value: 'example' },
            { type: 'IP-CIDR', value: '1.2.3.4/32' },
            { type: 'PROCESS-NAME', value: 'Chrome' },
        ]);
        expect(cr.addOptions(conn('Match', '', [], { host: '', destinationIP: '2001:db8::1', process: '' }))).toEqual([{ type: 'IP-CIDR6', value: '2001:db8::1/128' }]);
    });

    it('finds "My rules" whatever language made it', () => {
        expect(cr.findMyRulesFile([{ filename: 'a.prism.yaml' }, { filename: '我的规则.prism.yaml' }])).toEqual({ filename: '我的规则.prism.yaml', enabled: true });
        expect(cr.findMyRulesFile([{ filename: 'My Rules.prism.yaml', enabled: false }])).toEqual({ filename: 'My Rules.prism.yaml', enabled: false });
        expect(cr.findMyRulesFile([])).toBeNull();
    });

    it('saves a name the backend would strip under the English one', () => {
        expect(cr.myRulesFileName('我的规则')).toBe('我的规则.prism.yaml');
        expect(cr.myRulesFileName('Mis reglas')).toBe('Mis reglas.prism.yaml');
        expect(cr.myRulesFileName('Мои правила')).toBe('My Rules.prism.yaml');
        expect(cr.myRulesFileName('Quy tắc của tôi')).toBe('My Rules.prism.yaml');
    });

    it('never suggests a whole country domain', () => {
        const opts = cr.addOptions(conn('Match', '', [], { host: 'shop.example.co.uk', destinationIP: '', process: '' }));
        expect(opts[0]).toEqual({ type: 'DOMAIN-SUFFIX', value: 'example.co.uk' });
        expect(opts).toContainEqual({ type: 'DOMAIN-KEYWORD', value: 'example' });
        expect(cr.addOptions(conn('Match', '', [], { host: 'www.site.com.cn', destinationIP: '', process: '' }))[0].value).toBe('site.com.cn');
        expect(cr.addOptions(conn('Match', '', [], { host: 'example.de', destinationIP: '', process: '' }))[0].value).toBe('example.de');
        expect(cr.addOptions(conn('Match', '', [], { host: 'www.alice.me.uk', destinationIP: '', process: '' }))).toEqual([{ type: 'DOMAIN', value: 'www.alice.me.uk' }]);
        expect(cr.addOptions(conn('Match', '', [], { host: 'me.uk', destinationIP: '', process: '' }))).toEqual([{ type: 'DOMAIN', value: 'me.uk' }]);
        // Registrar second levels and dynamic DNS: each name has its own owner.
        expect(cr.addOptions(conn('Match', '', [], { host: 'shop.alice.uk.com', destinationIP: '', process: '' }))[0].value).toBe('alice.uk.com');
        expect(cr.addOptions(conn('Match', '', [], { host: 'alice.duckdns.org', destinationIP: '', process: '' }))[0]).toEqual({ type: 'DOMAIN-SUFFIX', value: 'alice.duckdns.org' });
        // US locality domains: where the site starts is unknown, so only the exact host.
        expect(cr.addOptions(conn('Match', '', [], { host: 'www.district.k12.ca.us', destinationIP: '', process: '' }))).toEqual([{ type: 'DOMAIN', value: 'www.district.k12.ca.us' }]);
        expect(cr.addOptions(conn('Match', '', [], { host: 'www.example.us', destinationIP: '', process: '' }))[0]).toEqual({ type: 'DOMAIN-SUFFIX', value: 'example.us' });
    });

    it('refuses to add to a turned-off "My rules"', async () => {
        invokeMock.mockImplementation(async (cmd) => (cmd === 'rule_list' ? [{ filename: 'My Rules.prism.yaml', enabled: false }] : null));
        await expect(cr.addToMyRules('DOMAIN,a.com,DIRECT')).rejects.toThrow();
        expect(invokeMock.mock.calls.some((c) => c[0] === 'rule_read' || c[0] === 'rule_update')).toBe(false);
    });

    it('leaves a "My rules" file it cannot parse untouched', async () => {
        invokeMock.mockImplementation(async (cmd) => {
            if (cmd === 'rule_list') return [{ filename: 'My Rules.prism.yaml', enabled: true }];
            if (cmd === 'rule_read') return 'name: mine\nrules:\n  $append:\n    - DOMAIN,b.com,Proxy\n';
            return null;
        });
        // No YAML parser in this suite: the file cannot be read safely.
        await expect(cr.addToMyRules('DOMAIN,a.com,DIRECT')).rejects.toThrow();
        expect(invokeMock.mock.calls.some((c) => c[0] === 'rule_update')).toBe(false);
    });

    it('creates "My rules" with the rule prepended when it is missing', async () => {
        invokeMock.mockImplementation(async (cmd) => (cmd === 'rule_list' ? [] : null));
        await cr.addToMyRules('DOMAIN,a.com,DIRECT');
        const create = invokeMock.mock.calls.find((c) => c[0] === 'rule_create');
        expect(create?.[1].content).toBe('rules:\n  $prepend:\n    - "DOMAIN,a.com,DIRECT"\n');
        expect(prism.rebuildWithOverrides).toHaveBeenCalled();
    });

    it('leaves a library file it cannot parse untouched when editing', async () => {
        invokeMock.mockImplementation(async (cmd) => (cmd === 'rule_read' ? 'name: x\nrules:\n  $append:\n    - DOMAIN,a.com,DIRECT\n    - DOMAIN,b.com,Proxy\n' : null));
        // No YAML parser in this suite: the file cannot be read safely.
        await expect(cr.replaceInFile('x.prism.yaml', 'DOMAIN,b.com,Proxy', 'DOMAIN,b.com,DIRECT')).rejects.toThrow();
        expect(invokeMock.mock.calls.some((c) => c[0] === 'rule_update')).toBe(false);
    });

    it('offers no Add for a connection with nothing to match', () => {
        const html = cr.ruleCardHtml(conn('Match', '', ['DIRECT'], { host: '', destinationIP: '', process: '' }), { kind: 'match' });
        expect(html).not.toContain('data-conn-rule="add"');
    });

    it('card offers Edit only for a library rule', () => {
        const mine = cr.ruleCardHtml(conn('DomainSuffix', 'example.com'), { kind: 'mine', file: 'f', label: 'mine', raw: 'DOMAIN-SUFFIX,example.com,Proxy' });
        expect(mine).toContain('data-conn-rule="edit"');
        const set = cr.ruleCardHtml(conn('RuleSet', 'google'), { kind: 'set' });
        expect(set).not.toContain('data-conn-rule="edit"');
        expect(set).toContain('data-conn-rule="add"');
        expect(cr.ruleCardHtml(conn('Match', ''), { kind: 'match' })).not.toContain('<code');
    });

    it('refuses policy names that cannot fit in a string rule column', () => {
        expect(() => cr.buildConnectionRule('DOMAIN', 'a.com', 'Proxy,Other')).toThrow();
        expect(() => cr.buildConnectionRule('DOMAIN', 'a.com', 'Proxy\nOther')).toThrow();
        expect(cr.buildConnectionRule('DOMAIN', 'a.com', 'Proxy')).toBe('DOMAIN,a.com,Proxy');
    });
});

describe('conn-rule file edits with the YAML parser the app loads', () => {
    beforeAll(async () => {
        const { readFileSync } = await import('node:fs');
        const { dirname, resolve } = await import('node:path');
        const { fileURLToPath } = await import('node:url');
        const code = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../js-yaml.min.js'), 'utf8');
        // UMD bundle: with no module system it sets globalThis.jsyaml.
        new Function(code).call(globalThis); // eslint-disable-line no-new-func
    });
    afterAll(() => { delete (/** @type {any} */ (globalThis)).jsyaml; });
    beforeEach(() => { invokeMock.mockReset(); vi.mocked(prism.apply).mockClear(); vi.mocked(prism.rebuild).mockClear(); vi.mocked(prism.rebuildWithOverrides).mockClear(); });

    it('adds to $prepend and keeps the $append list and other keys', async () => {
        invokeMock.mockImplementation(async (cmd) => {
            if (cmd === 'rule_list') return [{ filename: 'My Rules.prism.yaml' }];
            if (cmd === 'rule_read') return 'name: mine\nproxies:\n  $prepend: []\nrules:\n  $prepend:\n    - DOMAIN,p.com,Proxy\n  $append:\n    - DOMAIN,b.com,Proxy\n';
            return null;
        });
        await cr.addToMyRules('DOMAIN,a.com,DIRECT');
        const doc = /** @type {any} */ (globalThis).jsyaml.load(invokeMock.mock.calls.find((c) => c[0] === 'rule_update')?.[1].content);
        expect(doc.rules.$prepend).toEqual(['DOMAIN,a.com,DIRECT', 'DOMAIN,p.com,Proxy']);
        expect(doc.rules.$append).toEqual(['DOMAIN,b.com,Proxy']);
        expect(doc.name).toBe('mine');
        expect(doc.proxies).toEqual({ $prepend: [] });
    });

    it('preserves structured rules when prepending to a DSL or plain list', () => {
        const yaml = /** @type {any} */ (globalThis).jsyaml;
        const structured = { type: 'DOMAIN', payload: 'old.com', proxy: 'Proxy' };
        for (const original of [{ $prepend: [structured], $append: ['MATCH,Proxy'] }, [structured]]) {
            const out = yaml.load(cr.prependRule(yaml.dump({ rules: original }), 'DOMAIN,new.com,DIRECT'));
            expect(out.rules.$prepend[0]).toBe('DOMAIN,new.com,DIRECT');
            const rest = Array.isArray(original) ? out.rules.$append : out.rules.$prepend.slice(1);
            expect(rest).toEqual([structured]);
        }
    });

    it('keeps existing duplicate rules and edits only one aliased list', () => {
        const yaml = /** @type {any} */ (globalThis).jsyaml;
        const a = 'DOMAIN,a.com,DIRECT';
        const b = 'DOMAIN,b.com,Proxy';
        const original = yaml.dump({ rules: { $prepend: [b, a, b, a] } });
        expect(yaml.load(cr.prependRule(original, a)).rules.$prepend).toEqual([a, b, a, b, a]);
        const first = yaml.dump({ rules: { $prepend: [a, b, a] } });
        expect(cr.prependRule(first, a)).toBe(first);
        expect(yaml.load(cr.prependRule(yaml.dump({ rules: [a, b, a] }), a)).rules.$append).toEqual([a, b, a]);
        const aliased = 'rules:\n  $prepend: &shared\n    - DOMAIN,a.com,DIRECT\n  $append: *shared\n';
        expect(yaml.load(cr.replaceRule(aliased, a, b)).rules).toEqual({ $prepend: [b], $append: [a] });
    });

    it('preserves CRLF comments and empty prepend lists during targeted edits', () => {
        const content = '# note\r\nrules:\r\n  $prepend: [] # first\r\n  $append:\r\n    - DOMAIN,a.com,DIRECT # tail\r\n';
        const added = cr.prependRule(content, 'DOMAIN,b.com,Proxy');
        expect(added).toContain('# note\r\n');
        expect(added).toContain('$prepend: # first\r\n    - DOMAIN,b.com,Proxy\r\n');
        expect(added).toContain('DIRECT # tail\r\n');
        const edited = cr.replaceRule(added, 'DOMAIN,a.com,DIRECT', 'DOMAIN,a.com,Proxy');
        expect(edited).toContain('DOMAIN,a.com,Proxy # tail\r\n');
        expect(edited).toContain('# note\r\n');
        const plain = '# rules\r\nrules: # ordered\r\n  # keep\r\n  - DOMAIN,a.com,DIRECT # original\r\n';
        const prepended = cr.prependRule(plain, 'DOMAIN,b.com,Proxy');
        expect(prepended).toContain('# rules\r\n');
        expect(prepended).toContain('rules: # ordered\r\n');
        expect(prepended).toContain('    # keep\r\n    - DOMAIN,a.com,DIRECT # original\r\n');
    });

    it('adds inside an override list without mixing incompatible operators', () => {
        const yaml = /** @type {any} */ (globalThis).jsyaml;
        const content = 'rules:\n  $override:\n    - MATCH,Proxy\n';
        expect(yaml.load(cr.prependRule(content, 'DOMAIN,a.com,DIRECT')).rules).toEqual({ $override: ['DOMAIN,a.com,DIRECT', 'MATCH,Proxy'] });
    });

    it('a $prepend outside rules does not stop the rule going first', async () => {
        invokeMock.mockImplementation(async (cmd) => {
            if (cmd === 'rule_list') return [{ filename: 'My Rules.prism.yaml' }];
            if (cmd === 'rule_read') return 'proxies:\n  $prepend: []\nrules:\n  $append:\n    - DOMAIN,b.com,Proxy\n';
            return null;
        });
        await cr.addToMyRules('DOMAIN,a.com,DIRECT');
        const doc = /** @type {any} */ (globalThis).jsyaml.load(invokeMock.mock.calls.find((c) => c[0] === 'rule_update')?.[1].content);
        expect(doc.rules.$prepend).toEqual(['DOMAIN,a.com,DIRECT']);
        expect(doc.rules.$append).toEqual(['DOMAIN,b.com,Proxy']);
    });

    it('replaces a line in whichever list holds it, and rebuilds', async () => {
        invokeMock.mockImplementation(async (cmd) => (cmd === 'rule_read' ? 'rules:\n  $prepend:\n    - DOMAIN,p.com,Proxy\n  $append:\n    - DOMAIN,b.com,Proxy\n' : null));
        await cr.replaceInFile('x.prism.yaml', 'DOMAIN,p.com,Proxy', 'DOMAIN,p.com,DIRECT');
        const doc = /** @type {any} */ (globalThis).jsyaml.load(invokeMock.mock.calls.find((c) => c[0] === 'rule_update')?.[1].content);
        expect(doc.rules).toEqual({ $prepend: ['DOMAIN,p.com,DIRECT'], $append: ['DOMAIN,b.com,Proxy'] });
        expect(prism.rebuildWithOverrides).toHaveBeenCalled();
    });

    it('does not let a newly prepended duplicate replace the row selected by an open editor', async () => {
        const opened = 'rules:\n  $append:\n    - DOMAIN,a.com,Proxy\n';
        const changed = 'rules:\n  $prepend:\n    - DOMAIN,a.com,Proxy\n  $append:\n    - DOMAIN,a.com,Proxy\n';
        invokeMock.mockImplementation(async (command) => command === 'rule_read' ? changed : null);
        await expect(cr.replaceInFile('mine.prism.yaml', 'DOMAIN,a.com,Proxy', 'DOMAIN,a.com,DIRECT', () => {}, opened)).rejects.toThrow('RULE_FILE_CHANGED:');
        expect(invokeMock.mock.calls.some(([command]) => command === 'rule_update')).toBe(false);
        expect(prism.rebuildWithOverrides).not.toHaveBeenCalled();
    });

    it('prefers an exact line in any list over a template in an earlier one', async () => {
        invokeMock.mockImplementation(async (cmd) => (cmd === 'rule_read' ? 'rules:\n  $append:\n    - DOMAIN,b.com,{{proxy}}\n  $prepend:\n    - DOMAIN,b.com,Proxy\n' : null));
        await cr.replaceInFile('x.prism.yaml', 'DOMAIN,b.com,Proxy', 'DOMAIN,b.com,DIRECT');
        const doc = /** @type {any} */ (globalThis).jsyaml.load(invokeMock.mock.calls.find((c) => c[0] === 'rule_update')?.[1].content);
        expect(doc.rules).toEqual({ $append: ['DOMAIN,b.com,{{proxy}}'], $prepend: ['DOMAIN,b.com,DIRECT'] });
    });

    it('reports a failed rebuild as not running instead of applying over the old line', async () => {
        invokeMock.mockImplementation(async (cmd) => (cmd === 'rule_read' ? 'rules:\n  - DOMAIN,b.com,Proxy\n' : null));
        vi.mocked(prism.rebuildWithOverrides).mockRejectedValueOnce(new Error('busy'));
        const out = await cr.replaceInFile('x.prism.yaml', 'DOMAIN,b.com,Proxy', 'DOMAIN,b.com,DIRECT');
        expect(out).toEqual({ hot_reload_success: false });
        expect(prism.apply).not.toHaveBeenCalled();
    });

    it('keeps the file\'s comments when adding or editing a rule', async () => {
        let file = '# my notes\nrules:\n  $prepend:\n    # work\n    - DOMAIN,p.com,Proxy  # keep\n  $append:\n    - DOMAIN,b.com,Proxy\n';
        invokeMock.mockImplementation(async (cmd, args) => {
            if (cmd === 'rule_list') return [{ filename: 'My Rules.prism.yaml' }];
            if (cmd === 'rule_read') return file;
            if (cmd === 'rule_update') file = args.content;
            return null;
        });
        await cr.addToMyRules('DOMAIN,a.com,DIRECT');
        expect(file).toBe('# my notes\nrules:\n  $prepend:\n    # work\n    - DOMAIN,a.com,DIRECT\n    - DOMAIN,p.com,Proxy  # keep\n  $append:\n    - DOMAIN,b.com,Proxy\n');
        await cr.replaceInFile('My Rules.prism.yaml', 'DOMAIN,p.com,Proxy', 'DOMAIN,p.com,DIRECT');
        expect(file).toBe('# my notes\nrules:\n  $prepend:\n    # work\n    - DOMAIN,a.com,DIRECT\n    - DOMAIN,p.com,DIRECT  # keep\n  $append:\n    - DOMAIN,b.com,Proxy\n');
    });

    it('finds a templated rule from its resolved line', async () => {
        invokeMock.mockImplementation(async (cmd) => (cmd === 'rule_read' ? 'rules:\n  $append:\n    - DOMAIN,b.com,{{proxy}}\n' : null));
        await cr.replaceInFile('x.prism.yaml', 'DOMAIN,b.com,Proxy', 'DOMAIN,b.com,DIRECT');
        const doc = /** @type {any} */ (globalThis).jsyaml.load(invokeMock.mock.calls.find((c) => c[0] === 'rule_update')?.[1].content);
        expect(doc.rules.$append).toEqual(['DOMAIN,b.com,DIRECT']);
    });

    it('keeps a template policy when only the match value changes', async () => {
        invokeMock.mockImplementation(async (cmd) => (cmd === 'rule_read' ? 'rules:\n  $append:\n    - DOMAIN,b.com,{{proxy}}\n' : null));
        await cr.replaceInFile('x.prism.yaml', 'DOMAIN,b.com,Proxy', 'DOMAIN,c.com,Proxy');
        const doc = /** @type {any} */ (globalThis).jsyaml.load(invokeMock.mock.calls.find((c) => c[0] === 'rule_update')?.[1].content);
        expect(doc.rules.$append).toEqual(['DOMAIN,c.com,{{proxy}}']);
    });

    it('edits the rule list, not a $filter or $remove entry with the same text', async () => {
        invokeMock.mockImplementation(async (cmd) => (cmd === 'rule_read' ? 'rules:\n  $remove:\n    - DOMAIN,b.com,Proxy\n  $prepend:\n    - DOMAIN,b.com,Proxy\n' : null));
        await cr.replaceInFile('x.prism.yaml', 'DOMAIN,b.com,Proxy', 'DOMAIN,b.com,DIRECT');
        const doc = /** @type {any} */ (globalThis).jsyaml.load(invokeMock.mock.calls.find((c) => c[0] === 'rule_update')?.[1].content);
        expect(doc.rules).toEqual({ $remove: ['DOMAIN,b.com,Proxy'], $prepend: ['DOMAIN,b.com,DIRECT'] });
    });
});

describe('conn-rule matching', () => {
    it('matches a library rule whose policy is a template', () => {
        const src = sourceInLibrary(conn('Domain', 'b.com'), [{ group_id: 'f', rules: ['DOMAIN,b.com,{{proxy}}'] }]);
        expect(src.kind).toBe('mine');
    });

    it('never suggests every site on a shared host', () => {
        expect(cr.addOptions(conn('Match', '', [], { host: 'alice.github.io', destinationIP: '', process: '' }))[0]).toEqual({ type: 'DOMAIN-SUFFIX', value: 'alice.github.io' });
        expect(cr.addOptions(conn('Match', '', [], { host: 'x.alice.github.io', destinationIP: '', process: '' }))[0].value).toBe('alice.github.io');
    });

    it('offers only the host itself for a shared suffix or an IP literal', () => {
        const opts = (/** @type {string} */ host) => cr.addOptions(conn('Match', '', [], { host, destinationIP: '', process: '' }));
        expect(opts('github.io')).toEqual([{ type: 'DOMAIN', value: 'github.io' }]);
        expect(opts('co.uk')).toEqual([{ type: 'DOMAIN', value: 'co.uk' }]);
        expect(opts('bucket.s3.amazonaws.com')).toEqual([{ type: 'DOMAIN', value: 'bucket.s3.amazonaws.com' }]);
        expect(opts('2001:db8::1')).toEqual([]);
    });

    it('skips a disabled file and prefers the rule with the same case', () => {
        const groups = [
            { group_id: 'off.prism.yaml', enabled: false, rules: [{ raw: 'PROCESS-PATH,/opt/Foo,Proxy' }] },
            { group_id: 'a.prism.yaml', rules: [{ raw: 'PROCESS-PATH,/opt/foo,Proxy' }, { raw: 'PROCESS-PATH,/opt/Foo,Proxy' }] },
        ];
        const src = sourceInLibrary(conn('ProcessPath', '/opt/Foo', ['Proxy']), groups);
        expect(src).toMatchObject({ kind: 'mine', file: 'a.prism.yaml', raw: 'PROCESS-PATH,/opt/Foo,Proxy' });
    });

    it('never takes a process path in another case for the rule that matched', () => {
        const groups = [{ group_id: 'a.prism.yaml', rules: [{ raw: 'PROCESS-PATH,/opt/foo,Proxy' }] }];
        expect(cr.findRuleSource(conn('ProcessPath', '/opt/Foo', ['Proxy']), groups)).toEqual({ kind: 'sub' });
        // A domain comes back in lower case: still found.
        const mine = [{ group_id: 'a.prism.yaml', rules: [{ raw: 'DOMAIN,Example.com,Proxy' }] }];
        expect(sourceInLibrary(conn('Domain', 'example.com', ['Proxy']), mine)).toMatchObject({ kind: 'mine' });
    });

    it('takes the first domain rule in order whatever its case', () => {
        const groups = [
            { group_id: 'a.prism.yaml', rules: [{ raw: 'DOMAIN,Example.com,Proxy' }] },
            { group_id: 'b.prism.yaml', rules: [{ raw: 'DOMAIN,example.com,Proxy' }] },
        ];
        expect(sourceInLibrary(conn('Domain', 'example.com', ['Proxy']), groups)).toMatchObject({ kind: 'mine', file: 'a.prism.yaml', raw: 'DOMAIN,Example.com,Proxy' });
    });

    it('does not fold regex escapes when finding the editable source', () => {
        const groups = [{ group_id: 'regex.prism.yaml', rules: [
            { raw: 'DOMAIN-REGEX,foo\\d+,Proxy', index: 0 },
            { raw: 'DOMAIN-REGEX,foo\\D+,Proxy', index: 1 },
        ] }];
        expect(sourceInLibrary(conn('DomainRegex', 'foo\\D+'), groups)).toMatchObject({
            kind: 'mine', raw: 'DOMAIN-REGEX,foo\\D+,Proxy',
        });
    });

    it('does not offer to edit a library duplicate after the subscription match', () => {
        const raw = 'DOMAIN,example.com,Proxy';
        const groups = [{ group_id: 'mine.prism.yaml', rules: [{ raw, index: 1 }] }];
        expect(cr.findRuleSource(conn('Domain', 'example.com'), groups, [raw, raw])).toEqual({ kind: 'sub' });
        expect(cr.findRuleSource(conn('Domain', 'example.com'), groups, [raw, 'DOMAIN,other.com,Proxy'])).toEqual({ kind: 'unknown' });
        expect(cr.findRuleSource(conn('Domain', 'example.com'), groups)).toEqual({ kind: 'unknown' });
    });

    it('requires every annotation and the full live rule order to agree', () => {
        const raw = 'DOMAIN,example.com,Proxy';
        const groups = [{ group_id: 'mine.prism.yaml', rules: [{ raw, index: 0 }, { raw: 'DOMAIN,old.com,Proxy', index: 1 }] }];
        expect(cr.findRuleSource(conn('Domain', 'example.com'), groups, [raw, 'DOMAIN,new.com,Proxy'])).toEqual({ kind: 'unknown' });
        const saved = [raw, 'MATCH,DIRECT'];
        const live = [{ type: 'Domain', payload: 'example.com', proxy: 'Proxy' }, { type: 'Match', payload: '', proxy: 'DIRECT' }];
        expect(cr.runningRulesAgree(saved, live)).toBe(true);
        expect(cr.runningRulesAgree(saved, [...live].reverse())).toBe(false);
        expect(cr.runningRulesAgree(saved, [{ ...live[0], proxy: 'DIRECT' }, live[1]])).toBe(false);
    });

    it('does not attribute an ambiguous no-resolve CIDR tuple', () => {
        const raw = 'IP-CIDR,1.2.3.0/24,Proxy,no-resolve';
        const groups = [{ group_id: 'mine.prism.yaml', rules: [{ raw, index: 0 }] }];
        const connection = conn('IPCIDR', '1.2.3.0/24', ['Proxy'], { host: 'example.com', destinationIP: '' });
        expect(cr.findRuleSource(connection, groups, [raw, 'IP-CIDR,1.2.3.0/24,Proxy'])).toEqual({ kind: 'unknown' });
    });

    it('normalizes saved IPv6 CIDR rules to the core IPCIDR type', () => {
        const raw = 'IP-CIDR6,2001:db8::/32,Proxy';
        const groups = [{ group_id: 'mine.prism.yaml', rules: [{ raw, index: 0 }] }];
        expect(cr.runningRulesAgree([raw], [{ type: 'IPCIDR', payload: '2001:db8::/32', proxy: 'Proxy' }])).toBe(true);
        expect(cr.findRuleSource(conn('IPCIDR', '2001:db8::/32'), groups, [raw])).toMatchObject({ kind: 'mine' });
    });

    it('leaves archived connections add-only without reading current attribution', async () => {
        const slot = document.createElement('div');
        document.body.appendChild(slot);
        vi.mocked(prism.listRuleSnapshot).mockClear();
        await cr.mountRuleCard(slot, conn('Domain', 'example.com'), () => {}, true);
        expect(prism.listRuleSnapshot).not.toHaveBeenCalled();
        expect(slot.querySelector('[data-conn-rule="edit"]')).toBeNull();
        expect(slot.querySelector('[data-conn-rule="add"]')).not.toBeNull();
        slot.remove();
    });

    it('does not publish Edit when an active detail closes during its rule read', async () => {
        const slot = document.createElement('div');
        document.body.appendChild(slot);
        let finish;
        vi.mocked(prism.listRuleSnapshot).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
        const pending = cr.mountRuleCard(slot, conn('Domain', 'example.com'));
        slot.dataset.historical = 'true';
        finish({
            groups: [{ group_id: 'mine.prism.yaml', rules: [{ raw: 'DOMAIN,example.com,Proxy', index: 0 }] }],
            rules: ['DOMAIN,example.com,Proxy'],
            activeRules: [{ type: 'Domain', payload: 'example.com', proxy: 'Proxy' }],
        });
        await pending;
        expect(slot.querySelector('[data-conn-rule="edit"]')).toBeNull();
        expect(slot.querySelector('[data-conn-rule="add"]')).not.toBeNull();
        slot.remove();
    });

    it('reports a saved rule whose apply failed as not running, not as an error to retry', async () => {
        invokeMock.mockImplementation(async (cmd) => (cmd === 'rule_list' ? [] : null));
        vi.mocked(prism.rebuildWithOverrides).mockRejectedValueOnce(new Error('core busy'));
        await expect(cr.addToMyRules('DOMAIN,a.com,DIRECT')).resolves.toEqual({ hot_reload_success: false });
        expect(invokeMock.mock.calls.some((c) => c[0] === 'rule_create')).toBe(true);
    });
});
