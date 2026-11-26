import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock('../api.js', () => ({ invoke: invokeMock }));
vi.mock('./prism.js', () => ({ apply: vi.fn(async () => {}), rebuild: vi.fn(async () => {}), rebuildWithOverrides: vi.fn(async () => {}), listRules: vi.fn(async () => []) }));

const cr = await import('./conn-rule.js');
const prism = await import('./prism.js');

const conn = (rule, payload, chains = ['HK 01', 'Proxy'], meta = {}) => ({
    rule, rulePayload: payload, chains,
    metadata: { host: 'api.example.com', destinationIP: '1.2.3.4', process: 'Chrome', ...meta },
});

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
        expect(cr.findRuleSource(conn('DomainSuffix', 'example.com'), groups)).toEqual({ kind: 'mine', file: 'mine.prism.yaml', label: 'mine', raw: 'DOMAIN-SUFFIX,example.com,Proxy' });
        expect(cr.findRuleSource(conn('DomainSuffix', 'example.com', ['HK', 'Other']), groups)).toEqual({ kind: 'sub' });
        expect(cr.findRuleSource(conn('DomainSuffix', 'other.com'), groups)).toEqual({ kind: 'sub' });
        expect(cr.findRuleSource(conn('RuleSet', 'google'), groups)).toEqual({ kind: 'set' });
        expect(cr.findRuleSource(conn('Match', ''), groups)).toEqual({ kind: 'match' });
        const locked = [{ ...groups[1], immutable: true }];
        expect(cr.findRuleSource(conn('DomainSuffix', 'example.com'), locked)).toEqual({ kind: 'sub' });
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
        expect(prism.apply).toHaveBeenCalled();
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
        const src = cr.findRuleSource(conn('Domain', 'b.com'), [{ group_id: 'f', rules: ['DOMAIN,b.com,{{proxy}}'] }]);
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
        const src = cr.findRuleSource(conn('ProcessPath', '/opt/Foo', ['Proxy']), groups);
        expect(src).toMatchObject({ kind: 'mine', file: 'a.prism.yaml', raw: 'PROCESS-PATH,/opt/Foo,Proxy' });
    });

    it('never takes a process path in another case for the rule that matched', () => {
        const groups = [{ group_id: 'a.prism.yaml', rules: [{ raw: 'PROCESS-PATH,/opt/foo,Proxy' }] }];
        expect(cr.findRuleSource(conn('ProcessPath', '/opt/Foo', ['Proxy']), groups)).toEqual({ kind: 'sub' });
        // A domain comes back in lower case: still found.
        const mine = [{ group_id: 'a.prism.yaml', rules: [{ raw: 'DOMAIN,Example.com,Proxy' }] }];
        expect(cr.findRuleSource(conn('Domain', 'example.com', ['Proxy']), mine)).toMatchObject({ kind: 'mine' });
    });

    it('takes the first domain rule in order whatever its case', () => {
        const groups = [
            { group_id: 'a.prism.yaml', rules: [{ raw: 'DOMAIN,Example.com,Proxy' }] },
            { group_id: 'b.prism.yaml', rules: [{ raw: 'DOMAIN,example.com,Proxy' }] },
        ];
        expect(cr.findRuleSource(conn('Domain', 'example.com', ['Proxy']), groups)).toMatchObject({ kind: 'mine', file: 'a.prism.yaml', raw: 'DOMAIN,Example.com,Proxy' });
    });

    it('reports a saved rule whose apply failed as not running, not as an error to retry', async () => {
        invokeMock.mockImplementation(async (cmd) => (cmd === 'rule_list' ? [] : null));
        vi.mocked(prism.apply).mockRejectedValueOnce(new Error('core busy'));
        await expect(cr.addToMyRules('DOMAIN,a.com,DIRECT')).resolves.toEqual({ hot_reload_success: false });
        expect(invokeMock.mock.calls.some((c) => c[0] === 'rule_create')).toBe(true);
    });
});
