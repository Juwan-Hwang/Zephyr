import { describe, it, expect, vi, beforeEach, beforeAll, afterAll, afterEach } from 'vitest';
import * as yamlModule from '../js-yaml.min.js';
import { Bus, Events, currentRulesVersion } from './events.js';
import { t } from '../i18n.js';

const invokeMock = vi.hoisted(() => vi.fn());
const notifyMock = vi.hoisted(() => vi.fn());
const getConnectionsMock = vi.hoisted(() => vi.fn(async () => ({ connections: [{ id: 'test-connection' }] })));
vi.mock('../api.js', () => ({ invoke: invokeMock, coreReplacements: vi.fn(() => 0), getConnections: getConnectionsMock }));
vi.mock('./prism.js', () => ({ apply: vi.fn(async () => {}), rebuild: vi.fn(async () => {}), rebuildWithOverrides: vi.fn(async () => {}), listRules: vi.fn(async () => []), listRuleSnapshot: vi.fn(async () => ({ groups: [], rules: [] })) }));
vi.mock('./proxy-groups.js', () => ({ fetchProxyGroups: vi.fn(async () => ({ orderedGroupNames: ['Proxy'] })) }));
vi.mock('./notifications.js', async () => ({
    ...await vi.importActual('./notifications.js'),
    showNotification: notifyMock,
}));

const cr = await import('./conn-rule.js');
const prism = await import('./prism.js');
const { fetchProxyGroups } = await import('./proxy-groups.js');

const conn = (rule, payload, chains = ['HK 01', 'Proxy'], meta = {}) => ({
    id: 'test-connection', rule, rulePayload: payload, chains,
    start: new Date(Math.max(Date.now(), currentRulesVersion().changedAt + 1)).toISOString(),
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

    it.each([{ kind: 'set', rule: 'RuleSet' }, { kind: 'match', rule: 'Match' }])('does not attribute a $kind rule to a subscription', ({ kind, rule }) => {
        const card = cr.ruleCardHtml(conn(rule, 'example'), { kind });
        expect(card).not.toContain('conn-rule-src');
        expect(card).toContain('conn-rule-note');
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
        const override = sourceInLibrary(conn('DomainSuffix', 'example.com'), locked);
        expect(override).toEqual({ kind: 'override', file: 'mine.prism.yaml', label: 'mine', raw: 'DOMAIN-SUFFIX,example.com,Proxy' });
        const overrideCard = cr.ruleCardHtml(conn('DomainSuffix', 'example.com'), override);
        expect(overrideCard).not.toContain('data-conn-rule="edit"');
        expect(overrideCard).toContain('data-conn-rule="add"');
        expect(cr.findRuleSource(conn('DomainSuffix', 'example.com'), locked)).toEqual({ kind: 'unknown' });
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
        expect(cr.addOptions(conn('Match', '', [], { host: 'example.de', destinationIP: '', process: '' }))[0]).toEqual({ type: 'DOMAIN', value: 'example.de' });
        expect(cr.addOptions(conn('Match', '', [], { host: 'www.alice.me.uk', destinationIP: '', process: '' }))).toEqual([{ type: 'DOMAIN', value: 'www.alice.me.uk' }]);
        expect(cr.addOptions(conn('Match', '', [], { host: 'me.uk', destinationIP: '', process: '' }))).toEqual([{ type: 'DOMAIN', value: 'me.uk' }]);
        // Registrar second levels and dynamic DNS: each name has its own owner.
        expect(cr.addOptions(conn('Match', '', [], { host: 'shop.alice.uk.com', destinationIP: '', process: '' }))[0].value).toBe('alice.uk.com');
        expect(cr.addOptions(conn('Match', '', [], { host: 'alice.duckdns.org', destinationIP: '', process: '' }))[0]).toEqual({ type: 'DOMAIN-SUFFIX', value: 'alice.duckdns.org' });
        expect(cr.addOptions(conn('Match', '', [], { host: 'alice.is-a.dev', destinationIP: '', process: '' }))[0]).toEqual({ type: 'DOMAIN-SUFFIX', value: 'alice.is-a.dev' });
        // US locality domains: where the site starts is unknown, so only the exact host.
        expect(cr.addOptions(conn('Match', '', [], { host: 'www.district.k12.ca.us', destinationIP: '', process: '' }))).toEqual([{ type: 'DOMAIN', value: 'www.district.k12.ca.us' }]);
        // An unlisted country-code boundary stays exact too; guessing a site
        // suffix here would undermine the conservative rule used for me.uk.
        expect(cr.addOptions(conn('Match', '', [], { host: 'www.example.us', destinationIP: '', process: '' }))).toEqual([{ type: 'DOMAIN', value: 'www.example.us' }]);
        expect(cr.addOptions(conn('Match', '', [], { host: 'abc.lambda-url.us-east-1.on.aws', destinationIP: '', process: '' }))).toEqual([{ type: 'DOMAIN', value: 'abc.lambda-url.us-east-1.on.aws' }]);
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

    it.each(['add', 'edit'])('leaves malformed YAML untouched with a parser installed: %s', async (operation) => {
        invokeMock.mockImplementation(async (command) => {
            if (command === 'rule_list') return [{ filename: 'My Rules.prism.yaml', enabled: true }];
            if (command === 'rule_read') return 'rules:\n  $prepend: ["DOMAIN,broken.com,DIRECT"\n';
            return null;
        });
        const pending = operation === 'add' ? cr.addToMyRules('DOMAIN,new.com,DIRECT')
            : cr.replaceInFile('My Rules.prism.yaml', 'DOMAIN,broken.com,DIRECT', 'DOMAIN,broken.com,Proxy');
        await expect(pending).rejects.toThrow();
        expect(invokeMock.mock.calls.some(([command]) => command === 'rule_update' || command === 'rule_create')).toBe(false);
    });

    it('adds the first rule to a comments-only file without dropping its notes', () => {
        const content = '# my notes\n\n';
        const result = cr.prependRule(content, 'DOMAIN,new.com,DIRECT');
        expect(result.startsWith(content)).toBe(true);
        expect((/** @type {any} */ (globalThis)).jsyaml.load(result).rules.$prepend).toEqual(['DOMAIN,new.com,DIRECT']);
    });

    it.each([false, true])('warns when a confirmed rebuild removes the added rule (existing=%s)', async (existing) => {
        invokeMock.mockImplementation(async (command) => command === 'rule_list'
            ? (existing ? [{ filename: 'My Rules.prism.yaml', enabled: true }] : []) : command === 'rule_read' ? 'rules: {$prepend: []}\n' : null);
        vi.mocked(prism.rebuildWithOverrides).mockResolvedValueOnce({ hot_reload_success: true });
        vi.mocked(prism.listRuleSnapshot).mockImplementationOnce(async (filename) => {
            const write = invokeMock.mock.calls.find(([command]) => command === (existing ? 'rule_update' : 'rule_create'))[1];
            return {
                annotationsConfirmed: true, sourceFile: filename, sourceContent: write.content,
                groups: [{ group_id: filename, enabled: true, rules: [] }],
                rules: ['MATCH,DIRECT'], activeRules: [{ type: 'Match', payload: '', proxy: 'DIRECT' }],
            };
        });
        await expect(cr.addToMyRules('DOMAIN,new.com,DIRECT')).resolves.toMatchObject({ notApplied: expect.stringContaining('Could not confirm') });
    });

    it.each(['failed', 'missing', 'present'])('reports rule activation from the final snapshot: %s', async (outcome) => {
        invokeMock.mockImplementation(async (command) => command === 'rule_list' ? [] : null);
        const accepted = { hot_reload_success: true };
        vi.mocked(prism.rebuildWithOverrides).mockResolvedValueOnce(accepted);
        if (outcome === 'failed') vi.mocked(prism.listRuleSnapshot).mockRejectedValueOnce(new Error('Controller unavailable'));
        else vi.mocked(prism.listRuleSnapshot).mockResolvedValueOnce(outcome === 'missing' ? {} : {
            activeRules: [{ type: 'Domain', payload: 'new.com', proxy: 'DIRECT' }],
            rules: ['DOMAIN,new.com,DIRECT'], annotationsConfirmed: true,
            sourceFile: cr.myRulesFileName(t('connRuleMyRules')),
            sourceContent: 'rules:\n  $prepend:\n    - "DOMAIN,new.com,DIRECT"\n',
            groups: [{ group_id: cr.myRulesFileName(t('connRuleMyRules')), rules: [{ raw: 'DOMAIN,new.com,DIRECT', index: 0 }] }],
        });
        const result = await cr.addToMyRules('DOMAIN,new.com,DIRECT');
        expect(result).toEqual(outcome === 'present' ? accepted : { ...accepted, notApplied: t('connRuleActivationUnconfirmed') });
        expect(invokeMock.mock.calls.filter(([command]) => command === 'rule_create')).toHaveLength(1);
        expect(prism.rebuildWithOverrides).toHaveBeenCalledOnce();
    });

    it.each(['add', 'edit'])('does not confirm a saved %s from an unrelated identical runtime row', async (operation) => {
        const file = cr.myRulesFileName(t('connRuleMyRules'));
        const original = 'rules: {$prepend: ["DOMAIN,old.com,DIRECT"]}\n';
        invokeMock.mockImplementation(async (command) => command === 'rule_list' ? [] : command === 'rule_read' ? original : null);
        vi.mocked(prism.rebuildWithOverrides).mockResolvedValueOnce({ hot_reload_success: true });
        vi.mocked(prism.listRuleSnapshot).mockImplementationOnce(async () => {
            const write = invokeMock.mock.calls.find(([command]) => command === (operation === 'add' ? 'rule_create' : 'rule_update'))[1];
            return {
                sourceFile: file, sourceContent: write.content, annotationsConfirmed: true,
                groups: [{ group_id: 'another.prism.yaml', rules: [{ raw: 'DOMAIN,new.com,DIRECT', index: 1 }] }],
                rules: ['DOMAIN,new.com,REJECT', 'DOMAIN,new.com,DIRECT'],
                activeRules: [{ type: 'Domain', payload: 'new.com', proxy: 'REJECT' }, { type: 'Domain', payload: 'new.com', proxy: 'DIRECT' }],
            };
        });
        const result = operation === 'add' ? await cr.addToMyRules('DOMAIN,new.com,DIRECT')
            : await cr.replaceInFile(file, 'DOMAIN,old.com,DIRECT', 'DOMAIN,new.com,DIRECT');
        expect(result).toMatchObject({ hot_reload_success: true, notApplied: t('connRuleActivationUnconfirmed') });
        expect(invokeMock.mock.calls.filter(([command]) => command === 'rule_create' || command === 'rule_update')).toHaveLength(1);
    });

    it.each([false, true])('confirms a prepended duplicate only when its complete source group is retained (removed=%s)', async (removed) => {
        const file = 'My Rules.prism.yaml';
        const raw = 'DOMAIN,new.com,DIRECT';
        const other = 'DOMAIN,other.com,DIRECT';
        const original = `rules:\n  $prepend:\n    - ${other}\n    - ${raw}\n`;
        invokeMock.mockImplementation(async (command) => command === 'rule_list' ? [{ filename: file, enabled: true }]
            : command === 'rule_read' ? original : null);
        vi.mocked(prism.rebuildWithOverrides).mockResolvedValueOnce({ hot_reload_success: true });
        vi.mocked(prism.listRuleSnapshot).mockImplementationOnce(async () => {
            const content = invokeMock.mock.calls.find(([command]) => command === 'rule_update')[1].content;
            const rules = removed ? [other, raw] : [raw, other, raw];
            return {
                sourceFile: file, sourceContent: content, annotationsConfirmed: true,
                groups: [{ group_id: file, rules: rules.map((text, index) => ({ raw: text, index })) }],
                rules, activeRules: rules.map((text) => ({ type: 'Domain', payload: text.split(',')[1], proxy: 'DIRECT' })),
            };
        });
        const result = await cr.addToMyRules(raw);
        expect(Boolean(result.notApplied)).toBe(removed);
    });

    it.each([false, true])('confirms an edited duplicate only with its source position retained (removed=%s)', async (removed) => {
        const file = 'mine.prism.yaml';
        const oldRule = 'DOMAIN,a.example,DIRECT';
        const newRule = 'DOMAIN,b.example,DIRECT';
        const original = `rules:\n  $append:\n    - ${oldRule}\n    - ${newRule}\n`;
        invokeMock.mockImplementation(async (command) => command === 'rule_read' ? original : null);
        vi.mocked(prism.rebuildWithOverrides).mockResolvedValueOnce({ hot_reload_success: true });
        vi.mocked(prism.listRuleSnapshot).mockImplementationOnce(async () => {
            const content = invokeMock.mock.calls.find(([command]) => command === 'rule_update')[1].content;
            const rules = removed ? [newRule] : [newRule, newRule];
            return {
                annotationsConfirmed: true, sourceFile: file, sourceContent: content,
                groups: [{ group_id: file, rules: rules.map((raw, index) => ({ raw, index })) }],
                rules, activeRules: rules.map(() => ({ type: 'Domain', payload: 'b.example', proxy: 'DIRECT' })),
            };
        });
        const result = await cr.replaceInFile(file, oldRule, newRule, () => {}, original);
        expect(Boolean(result.notApplied)).toBe(removed);
    });

    it.each(['DOMAIN,old.example,Proxy', false, 42])('does not overwrite a non-list prepend operand: %j', async (operand) => {
        const content = (/** @type {any} */ (globalThis)).jsyaml.dump({ rules: { $prepend: operand } });
        invokeMock.mockImplementation(async (command) => command === 'rule_list' ? [{ filename: 'My Rules.prism.yaml', enabled: true }]
            : command === 'rule_read' ? content : null);
        await expect(cr.addToMyRules('DOMAIN,new.com,DIRECT')).rejects.toThrow();
        expect(invokeMock.mock.calls.some(([command]) => command === 'rule_update')).toBe(false);
    });

    it.each(['false', '42', 'invalid', '2025-01-01', '!!binary SGVsbG8='])('does not replace an unsupported rules value: %s', async (value) => {
        const content = `rules: ${value}\n`;
        invokeMock.mockImplementation(async (command) => command === 'rule_list' ? [{ filename: 'My Rules.prism.yaml', enabled: true }]
            : command === 'rule_read' ? content : null);
        await expect(cr.addToMyRules('DOMAIN,new.com,DIRECT')).rejects.toThrow();
        expect(invokeMock.mock.calls.some(([command]) => command === 'rule_update')).toBe(false);
    });

    it.each(['', 'rules: null\n', 'rules: []\n'])('initializes a missing or empty rules collection: %j', (content) => {
        expect(cr.prependRule(content, 'DOMAIN,new.com,DIRECT')).toContain('DOMAIN,new.com,DIRECT');
    });

    it.each([{}, { $prepend: null }, { $prepend: [] }])('accepts an empty prepend operand: %j', (rules) => {
        const parser = (/** @type {any} */ (globalThis)).jsyaml;
        const changed = cr.prependRule(parser.dump({ rules }), 'DOMAIN,new.com,DIRECT');
        expect(parser.load(changed).rules.$prepend).toEqual(['DOMAIN,new.com,DIRECT']);
    });

    it('adds another DSL rule without the modern Object.hasOwn API', () => {
        const unavailable = vi.spyOn(Object, 'hasOwn').mockImplementation(() => { throw new Error('Object.hasOwn unavailable'); });
        let result;
        try { result = cr.prependRule('rules: {$prepend: ["DOMAIN,old.com,Proxy"]}\n', 'DOMAIN,new.com,DIRECT'); }
        finally { unavailable.mockRestore(); }
        expect((/** @type {any} */ (globalThis)).jsyaml.load(result).rules.$prepend).toEqual(['DOMAIN,new.com,DIRECT', 'DOMAIN,old.com,Proxy']);
    });

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

    it('keeps a conditional file reload failure instead of replacing it with a visibility warning', async () => {
        const failed = { hot_reload_success: false };
        invokeMock.mockImplementation(async (command) => {
            if (command === 'rule_list') return [{ filename: 'My Rules.prism.yaml' }];
            if (command === 'rule_read') return '__when__: {profile: another}\nrules: {$prepend: []}\n';
            return null;
        });
        vi.mocked(prism.rebuildWithOverrides).mockResolvedValueOnce(failed);
        vi.mocked(prism.listRuleSnapshot).mockClear();
        await expect(cr.addToMyRules('DOMAIN,a.com,DIRECT')).resolves.toEqual(failed);
        expect(prism.listRuleSnapshot).not.toHaveBeenCalled();
    });

    it('preserves structured rules when prepending to a DSL or plain list', () => {
        const yaml = /** @type {any} */ (globalThis).jsyaml;
        const structured = { type: 'DOMAIN', payload: 'old.com', proxy: 'Proxy' };
        for (const original of [{ $prepend: [structured], $append: ['MATCH,Proxy'] }, [structured]]) {
            const out = yaml.load(cr.prependRule(yaml.dump({ rules: original }), 'DOMAIN,new.com,DIRECT'));
            const result = Array.isArray(original) ? out.rules : out.rules.$prepend;
            expect(result[0]).toBe('DOMAIN,new.com,DIRECT');
            const rest = result.slice(1);
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
        expect(yaml.load(cr.prependRule(yaml.dump({ rules: [a, b, a] }), a)).rules).toEqual([a, a, b, a]);
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
        expect(prepended).toContain('  # keep\r\n  - DOMAIN,a.com,DIRECT # original\r\n');
        expect(yamlModule.load(prepended).rules).toEqual(['DOMAIN,b.com,Proxy', 'DOMAIN,a.com,DIRECT']);
    });

    it('prepends to a large block without passing all its lines as function arguments', () => {
        const comments = Array(70_000).fill('  # retained note').join('\n');
        const content = `rules:\n${comments}\n  - MATCH,DIRECT # fallback\n`;
        const result = cr.prependRule(content, 'DOMAIN,new.com,DIRECT');
        expect(result).toContain('  - DOMAIN,new.com,DIRECT\n');
        expect(result).toContain('  - MATCH,DIRECT # fallback\n');
        expect(result.match(/# retained note/g)).toHaveLength(70_000);
    });

    it.each([
        'rules: [] # empty\n',
        'rules: # empty\n',
        'rules:\n  $append:\n    - MATCH,Proxy # fallback\n',
    ])('keeps comments when creating the first prepend list in %s', (rules) => {
        const original = `# header\n${rules}metadata: retained # footer\n`;
        const next = cr.prependRule(original, 'DOMAIN,new.com,DIRECT');
        expect(next).toContain('# header\n');
        expect(next).toContain('metadata: retained # footer\n');
        expect(next).toContain(rules.includes('$append') ? 'MATCH,Proxy # fallback\n' : 'rules: # empty\n');
        const parsedRules = (/** @type {any} */ (globalThis)).jsyaml.load(next).rules;
        expect(rules.startsWith('rules: []') ? parsedRules : parsedRules.$prepend).toEqual(['DOMAIN,new.com,DIRECT']);
    });

    it('adds inside an override list without mixing incompatible operators', () => {
        const yaml = /** @type {any} */ (globalThis).jsyaml;
        const content = '# header\nrules:\n  $override:\n    - MATCH,Proxy # fallback\n';
        const next = cr.prependRule(content, 'DOMAIN,a.com,DIRECT');
        expect(yaml.load(next).rules).toEqual({ $override: ['DOMAIN,a.com,DIRECT', 'MATCH,Proxy'] });
        expect(next).toBe('# header\nrules:\n  $override:\n    - DOMAIN,a.com,DIRECT\n    - MATCH,Proxy # fallback\n');
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

    it('refuses to write after the selected core or rule attribution is invalidated', async () => {
        const content = 'rules:\n  $prepend:\n    - DOMAIN,a.com,Proxy\n';
        invokeMock.mockImplementation(async (command) => command === 'rule_read' ? content : null);
        const canWrite = vi.fn(async () => false);
        await expect(cr.replaceInFile('mine.prism.yaml', 'DOMAIN,a.com,Proxy', 'DOMAIN,a.com,DIRECT', () => {}, content, canWrite)).rejects.toThrow();
        expect(canWrite).toHaveBeenCalledOnce();
        expect(invokeMock.mock.calls.some(([command]) => command === 'rule_update')).toBe(false);
    });

    it('uses one parsed fallback for many equal noneditable operator entries', () => {
        const yaml = /** @type {any} */ (globalThis).jsyaml;
        const raw = 'DOMAIN,a.com,Proxy';
        const content = yaml.dump({ rules: { $remove: Array(40).fill(raw), $prepend: [raw] } });
        const result = yaml.load(cr.replaceRule(content, raw, 'DOMAIN,a.com,DIRECT'));
        expect(result.rules.$remove).toEqual(Array(40).fill(raw));
        expect(result.rules.$prepend).toEqual(['DOMAIN,a.com,DIRECT']);
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
        expect(out).toEqual({ hot_reload_success: false, hot_reload_error: 'busy' });
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

    it.each(['Proxy', '{{proxy}}'])('confirms a preserved template against the resolved policy when compiled rows use %s', async (compiledPolicy) => {
        const file = 'x.prism.yaml';
        const original = 'rules:\n  $append:\n    - DOMAIN,b.com,{{proxy}}\n';
        invokeMock.mockImplementation(async (command) => command === 'rule_read' ? original : null);
        vi.mocked(prism.rebuildWithOverrides).mockResolvedValueOnce({ hot_reload_success: true });
        vi.mocked(prism.listRuleSnapshot).mockImplementationOnce(async () => {
            const content = invokeMock.mock.calls.find(([command]) => command === 'rule_update')[1].content;
            const raw = `DOMAIN,c.com,${compiledPolicy}`;
            return {
                annotationsConfirmed: true, sourceFile: file, sourceContent: content,
                groups: [{ group_id: file, enabled: true, rules: [{ raw, index: 0 }] }],
                rules: [raw], activeRules: [{ type: 'Domain', payload: 'c.com', proxy: 'Proxy' }],
            };
        });
        await expect(cr.replaceInFile(file, 'DOMAIN,b.com,Proxy', 'DOMAIN,c.com,Proxy')).resolves.toEqual({ hot_reload_success: true });
    });

    it('edits the rule list, not a $filter or $remove entry with the same text', async () => {
        invokeMock.mockImplementation(async (cmd) => (cmd === 'rule_read' ? 'rules:\n  $remove:\n    - DOMAIN,b.com,Proxy\n  $prepend:\n    - DOMAIN,b.com,Proxy\n' : null));
        await cr.replaceInFile('x.prism.yaml', 'DOMAIN,b.com,Proxy', 'DOMAIN,b.com,DIRECT');
        const doc = /** @type {any} */ (globalThis).jsyaml.load(invokeMock.mock.calls.find((c) => c[0] === 'rule_update')?.[1].content);
        expect(doc.rules).toEqual({ $remove: ['DOMAIN,b.com,Proxy'], $prepend: ['DOMAIN,b.com,DIRECT'] });
    });
});

describe('conn-rule matching', () => {
    beforeEach(() => vi.stubGlobal('jsyaml', yamlModule));
    afterEach(() => vi.unstubAllGlobals());
    it('matches a library rule whose policy is a template', () => {
        const src = sourceInLibrary(conn('Domain', 'b.com'), [{ group_id: 'f', rules: ['DOMAIN,b.com,{{proxy}}'] }]);
        expect(src.kind).toBe('mine');
    });

    it('never suggests every site on a shared host', () => {
        expect(cr.addOptions(conn('Match', '', [], { host: 'alice.github.io', destinationIP: '', process: '' }))[0]).toEqual({ type: 'DOMAIN-SUFFIX', value: 'alice.github.io' });
        expect(cr.addOptions(conn('Match', '', [], { host: 'x.alice.github.io', destinationIP: '', process: '' }))[0].value).toBe('alice.github.io');
        expect(cr.addOptions(conn('Match', '', [], { host: 'docs.readthedocs.io', destinationIP: '', process: '' }))[0].value).toBe('docs.readthedocs.io');
        expect(cr.addOptions(conn('Match', '', [], { host: 'x.project.readthedocs-hosted.com', destinationIP: '', process: '' }))[0].value).toBe('project.readthedocs-hosted.com');
        expect(cr.addOptions(conn('Match', '', [], { host: 'alice.wixsite.com', destinationIP: '', process: '' }))[0].value).toBe('alice.wixsite.com');
    });

    it('offers only the host itself for a shared suffix or an IP literal', () => {
        const opts = (/** @type {string} */ host) => cr.addOptions(conn('Match', '', [], { host, destinationIP: '', process: '' }));
        expect(opts('github.io')).toEqual([{ type: 'DOMAIN', value: 'github.io' }]);
        expect(opts('co.uk')).toEqual([{ type: 'DOMAIN', value: 'co.uk' }]);
        expect(opts('bucket.s3.amazonaws.com')).toEqual([{ type: 'DOMAIN', value: 'bucket.s3.amazonaws.com' }]);
        expect(opts('service-123.us-central1.run.app')).toEqual([{ type: 'DOMAIN', value: 'service-123.us-central1.run.app' }]);
        expect(opts('team.notion.site')).toEqual([{ type: 'DOMAIN', value: 'team.notion.site' }]);
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

    it.each([
        ['AND', '((DOMAIN,example.com),(DST-PORT,443))', '((Domain,example.com) && (DstPort,443))'],
        ['OR', '((DOMAIN,example.com),(GEOIP,LAN))', '((Domain,example.com) || (GEOIP,lan))'],
        ['NOT', '((DOMAIN,example.com))', '(!(Domain,example.com))'],
        ['AND', '((OR,((DOMAIN,a.com),(DOMAIN,b.com))),(DST-PORT,443))', '((OR,((Domain,a.com) || (Domain,b.com))) && (DstPort,443))'],
    ])('compares %s rule payloads using the core logical representation', (type, saved, payload) => {
        expect(cr.runningRulesAgree([`${type},${saved},Proxy`], [{ type, payload, proxy: 'Proxy' }])).toBe(true);
        expect(cr.runningRulesAgree([`${type},${saved},Proxy`], [{ type, payload: payload.replace('443', '80').replace('example.com', 'other.com').replace('a.com', 'different.com'), proxy: 'Proxy' }])).toBe(false);
    });

    it('keeps a domain rule editable alongside a semantically matching logical rule', async () => {
        const raw = 'DOMAIN,example.com,Proxy';
        const logical = 'AND,((DOMAIN,other.com),(DST-PORT,443)),DIRECT';
        const snapshot = {
            annotationsConfirmed: true, rulesRevision: 1,
            groups: [{ group_id: 'mine.prism.yaml', rules: [{ raw, index: 1 }] }],
            rules: [logical, raw],
            activeRules: [{ type: 'AND', payload: '((Domain,other.com) && (DstPort,443))', proxy: 'DIRECT' }, { type: 'Domain', payload: 'example.com', proxy: 'Proxy' }],
            sourceFile: 'mine.prism.yaml', sourceContent: `rules:\n  $append:\n    - ${raw}\n`,
        };
        vi.mocked(prism.listRuleSnapshot).mockReset().mockResolvedValue(snapshot);
        const slot = document.createElement('div');
        document.body.appendChild(slot);
        try {
            await cr.mountRuleCard(slot, conn('Domain', 'example.com'));
            expect(slot.querySelector('[data-conn-rule="edit"]')).not.toBeNull();
        } finally { slot.remove(); }
    });

    it('allows policy resolution only for templates in the live rule snapshot', () => {
        const live = [{ type: 'Domain', payload: 'example.com', proxy: 'Proxy' }];
        expect(cr.runningRulesAgree(['DOMAIN,example.com,{{proxy}}'], live)).toBe(true);
        expect(cr.runningRulesAgree(['DOMAIN,example.com,Other'], live)).toBe(false);
        expect(cr.runningRulesAgree(['DOMAIN,other.com,{{proxy}}'], live)).toBe(false);
        expect(cr.runningRulesAgree(['DOMAIN,example.com,{{proxy}}'], [{ ...live[0], proxy: '' }])).toBe(false);
    });

    it('accepts lowercase live GEOIP values without weakening regex or process-path checks', () => {
        expect(cr.runningRulesAgree(['GEOIP,LAN,DIRECT', 'DOMAIN,example.com,Proxy'], [
            { type: 'GEOIP', payload: 'lan', proxy: 'DIRECT' },
            { type: 'Domain', payload: 'example.com', proxy: 'Proxy' },
        ])).toBe(true);
        expect(cr.runningRulesAgree(['DOMAIN-REGEX,\\d+,Proxy'], [{ type: 'DomainRegex', payload: '\\D+', proxy: 'Proxy' }])).toBe(false);
        expect(cr.runningRulesAgree(['PROCESS-PATH,/Apps/Browser,Proxy'], [{ type: 'ProcessPath', payload: '/apps/browser', proxy: 'Proxy' }])).toBe(false);
    });

    it('does not attribute an ambiguous no-resolve CIDR tuple', () => {
        const raw = 'IP-CIDR,1.2.3.0/24,Proxy';
        const groups = [{ group_id: 'mine.prism.yaml', rules: [{ raw, index: 0 }] }];
        const connection = conn('IPCIDR', '1.2.3.0/24', ['Proxy'], { host: 'example.com', destinationIP: '' });
        expect(cr.findRuleSource(connection, groups, [raw, `${raw},no-resolve`])).toEqual({ kind: 'unknown' });
        expect(cr.findRuleSource(connection, groups, [raw, 'IP-CIDR,1.2.3.1/24,Proxy,no-resolve'])).toEqual({ kind: 'unknown' });
    });

    it('normalizes saved IPv6 CIDR rules to the core IPCIDR type', () => {
        const raw = 'IP-CIDR6,2001:db8::/32,Proxy';
        const groups = [{ group_id: 'mine.prism.yaml', rules: [{ raw, index: 0 }] }];
        expect(cr.runningRulesAgree([raw], [{ type: 'IPCIDR', payload: '2001:db8::/32', proxy: 'Proxy' }])).toBe(true);
        expect(cr.findRuleSource(conn('IPCIDR', '2001:db8::/32'), groups, [raw])).toMatchObject({ kind: 'mine' });
    });

    it.each([
        ['10.1.2.3/8', '10.0.0.0/8'],
        ['192.0.2.1/0', '0.0.0.0/0'],
        ['2001:0db8:0000:0000:0000:0000:0000:0001/32', '2001:db8::/32'],
        ['::ffff:192.0.2.1/120', '::ffff:c000:200/120'],
        ['2001:db8::1/0', '::/0'],
    ])('compares CIDR network values while preserving attribution: %s', (saved, canonical) => {
        const type = saved.includes(':') ? 'IP-CIDR6' : 'IP-CIDR';
        const raw = `${type},${saved},Proxy`;
        const groups = [{ group_id: 'mine.prism.yaml', rules: [{ raw, index: 0 }] }];
        expect(cr.runningRulesAgree([raw], [{ type: 'IPCIDR', payload: canonical, proxy: 'Proxy' }])).toBe(true);
        expect(cr.findRuleSource(conn('IPCIDR', canonical), groups, [raw])).toMatchObject({ kind: 'mine' });
    });

    it.each([
        ['10.1.2.3/8', '11.0.0.0/8'],
        ['10.1.2.3/8', '10.0.0.0/9'],
        ['999.1.2.3/8', '231.0.0.0/8'],
        ['2001:db8::/32', '2001:db9::/32'],
        ['2001:db8::/129', '2001:db8::/128'],
        ['2001:db8:::1/32', '2001:db8::/32'],
    ])('rejects changed or invalid CIDR networks: %s', (saved, live) => {
        expect(cr.runningRulesAgree([`IP-CIDR,${saved},Proxy`], [{ type: 'IPCIDR', payload: live, proxy: 'Proxy' }])).toBe(false);
    });

    it('keeps a domain rule editable beside a canonicalized CIDR without relaxing live order', async () => {
        const raw = 'DOMAIN,example.com,Proxy';
        const cidr = 'IP-CIDR,10.0.0.1/8,DIRECT';
        const snapshot = {
            annotationsConfirmed: true,
            groups: [{ group_id: 'mine.prism.yaml', rules: [{ raw, index: 1 }] }],
            rules: [cidr, raw],
            activeRules: [{ type: 'IPCIDR', payload: '10.0.0.0/8', proxy: 'DIRECT' }, { type: 'Domain', payload: 'example.com', proxy: 'Proxy' }],
            sourceFile: 'mine.prism.yaml', sourceContent: 'rules:\n  $append:\n    - DOMAIN,example.com,Proxy\n', rulesRevision: 1,
        };
        vi.mocked(prism.listRuleSnapshot).mockReset().mockResolvedValue(snapshot);
        const slot = document.createElement('div');
        document.body.appendChild(slot);
        try {
            await cr.mountRuleCard(slot, conn('Domain', 'example.com'));
            expect(slot.querySelector('[data-conn-rule="edit"]')).not.toBeNull();
            expect(cr.runningRulesAgree(snapshot.rules, [...snapshot.activeRules].reverse())).toBe(false);
        } finally { slot.remove(); }
    });

    it.each([
        { first: undefined, second: true, revision: 1, editable: false },
        { first: false, second: true, revision: 1, editable: false },
        { first: true, second: undefined, revision: 1, editable: false },
        { first: true, second: false, revision: 1, editable: false },
        { first: true, second: true, revision: 2, editable: false },
        { first: true, second: true, revision: 1, editable: true },
    ])('requires confirmed attribution at one revision across both reads: %j', async ({ first, second, revision, editable }) => {
        const raw = 'DOMAIN,example.com,Proxy';
        const snapshot = {
            annotationsConfirmed: first, rulesRevision: 1,
            groups: [{ group_id: 'mine.prism.yaml', rules: [{ raw, index: 0 }] }],
            rules: [raw], activeRules: [{ type: 'Domain', payload: 'example.com', proxy: 'Proxy' }],
            sourceFile: 'mine.prism.yaml', sourceContent: 'rules:\n  $append:\n    - DOMAIN,example.com,Proxy\n',
        };
        vi.mocked(prism.listRuleSnapshot).mockReset().mockResolvedValueOnce(snapshot).mockResolvedValue({
            ...snapshot, annotationsConfirmed: second, rulesRevision: revision,
        });
        const slot = document.createElement('div');
        document.body.appendChild(slot);
        try {
            await cr.mountRuleCard(slot, conn('Domain', 'example.com'));
            expect(slot.querySelector('[data-conn-rule="edit"]') !== null).toBe(editable);
        } finally { slot.remove(); }
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

    it.each([-1_000, 0, 1_000])('attributes only connections created after the last reload (offset=%i ms)', async (offset) => {
        Bus.emit(Events.CONFIG_UPDATED, { reloaded: true });
        const connection = conn('Domain', 'example.com');
        connection.start = new Date(currentRulesVersion().changedAt + offset).toISOString();
        const raw = 'DOMAIN,example.com,Proxy';
        vi.mocked(prism.listRuleSnapshot).mockReset().mockResolvedValue({
            annotationsConfirmed: true,
            groups: [{ group_id: 'mine.prism.yaml', rules: [{ raw, index: 0 }] }],
            rules: [raw], activeRules: [{ type: 'Domain', payload: 'example.com', proxy: 'Proxy' }],
            sourceFile: 'mine.prism.yaml', sourceContent: 'rules:\n  $append:\n    - DOMAIN,example.com,Proxy\n', rulesRevision: 1,
        });
        const slot = document.createElement('div');
        document.body.appendChild(slot);
        try {
            await cr.mountRuleCard(slot, connection);
            expect(slot.querySelector('[data-conn-rule="add"]')).not.toBeNull();
            if (offset <= 0) {
                expect(prism.listRuleSnapshot).not.toHaveBeenCalled();
                expect(slot.querySelector('[data-conn-rule="edit"]')).toBeNull();
            } else {
                expect(slot.querySelector('[data-conn-rule="edit"]')).not.toBeNull();
            }
        } finally { slot.remove(); }
    });

    it.each(['reload', 'closed'])('explains a stale Edit action after %s and removes it', async (invalidation) => {
        const raw = 'DOMAIN,example.com,Proxy';
        vi.mocked(prism.listRuleSnapshot).mockReset().mockResolvedValue({
            annotationsConfirmed: true,
            groups: [{ group_id: 'mine.prism.yaml', rules: [{ raw, index: 0 }] }],
            rules: [raw], activeRules: [{ type: 'Domain', payload: 'example.com', proxy: 'Proxy' }],
            sourceFile: 'mine.prism.yaml', sourceContent: 'rules:\n  $append:\n    - DOMAIN,example.com,Proxy\n', rulesRevision: 1,
        });
        notifyMock.mockClear();
        const slot = document.createElement('div');
        document.body.appendChild(slot);
        const beforeDialog = vi.fn();
        let live = true;
        try {
            await cr.mountRuleCard(slot, conn('Domain', 'example.com'), beforeDialog, false, () => live);
            const edit = slot.querySelector('[data-conn-rule="edit"]');
            expect(edit).not.toBeNull();
            edit.focus();
            if (invalidation === 'reload') {
                Bus.emit(Events.CONFIG_UPDATED, { restoreRuntime: true });
                expect(slot.querySelector('[data-conn-rule="edit"]')).toBeNull();
            }
            else live = false;
            edit.click();
            expect(beforeDialog).not.toHaveBeenCalled();
            expect(slot.querySelector('[data-conn-rule="edit"]')).toBeNull();
            expect(document.activeElement).toBe(slot.querySelector('[data-conn-rule="add"]'));
            expect(notifyMock).toHaveBeenCalledWith(t('connRuleGone'), 'warning');
        } finally { slot.remove(); }
    });

    it.each([false, true])('publishes Edit only if the detail stays active during its rule read (closed=%s)', async (closed) => {
        const slot = document.createElement('div');
        document.body.appendChild(slot);
        const raw = 'DOMAIN,example.com,Proxy';
        const snapshot = {
            annotationsConfirmed: true,
            groups: [{ group_id: 'mine.prism.yaml', rules: [{ raw, index: 0 }] }],
            rules: [raw],
            activeRules: [{ type: 'Domain', payload: 'example.com', proxy: 'Proxy' }],
            rulesRevision: 1,
            sourceFile: 'mine.prism.yaml',
            sourceContent: 'rules:\n  $append:\n    - DOMAIN,example.com,Proxy\n',
        };
        let finish;
        vi.mocked(prism.listRuleSnapshot).mockReset().mockResolvedValue(snapshot)
            .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
        const pending = cr.mountRuleCard(slot, conn('Domain', 'example.com'));
        if (closed) slot.dataset.historical = 'true';
        finish(snapshot);
        await pending;
        expect(slot.querySelector('[data-conn-rule="edit"]') !== null).toBe(!closed);
        expect(slot.querySelector('[data-conn-rule="add"]')).not.toBeNull();
        slot.remove();
    });

    it('refuses Edit when a template and literal resolve to the same source text', async () => {
        const raw = 'DOMAIN,example.com,Proxy';
        const sourceContent = 'rules:\n  $prepend: ["DOMAIN,example.com,{{proxy}}"]\n  $append: ["DOMAIN,example.com,Proxy"]\n';
        vi.mocked(prism.listRuleSnapshot).mockReset().mockResolvedValue({
            annotationsConfirmed: true,
            rulesRevision: 1, groups: [{ group_id: 'mine.prism.yaml', rules: [{ raw, index: 0 }, { raw, index: 1 }] }],
            rules: [raw, raw], activeRules: [{ type: 'Domain', payload: 'example.com', proxy: 'Proxy' }, { type: 'Domain', payload: 'example.com', proxy: 'Proxy' }],
            sourceFile: 'mine.prism.yaml', sourceContent,
        });
        const slot = document.createElement('div');
        document.body.appendChild(slot);
        try {
            await cr.mountRuleCard(slot, conn('Domain', 'example.com'));
            expect(slot.querySelector('[data-conn-rule="edit"]')).toBeNull();
            expect(slot.querySelector('[data-conn-rule="add"]')).not.toBeNull();
            invokeMock.mockReset().mockResolvedValue(sourceContent);
            await expect(cr.replaceInFile('mine.prism.yaml', raw, 'DOMAIN,example.com,DIRECT', () => {}, sourceContent)).rejects.toThrow();
            expect(invokeMock.mock.calls.some(([command]) => command === 'rule_update')).toBe(false);
        } finally { slot.remove(); }
    });

    it('reports a saved rule whose apply failed as not running, not as an error to retry', async () => {
        invokeMock.mockImplementation(async (cmd) => (cmd === 'rule_list' ? [] : null));
        vi.mocked(prism.rebuildWithOverrides).mockRejectedValueOnce(new Error('core busy'));
        await expect(cr.addToMyRules('DOMAIN,a.com,DIRECT')).resolves.toEqual({ hot_reload_success: false, hot_reload_error: 'core busy' });
        expect(invokeMock.mock.calls.some((c) => c[0] === 'rule_create')).toBe(true);
    });

    it.each(['reported', 'thrown'])('shows why the saved connection rule is not applied: %s', async (failure) => {
        invokeMock.mockReset().mockImplementation(async (command) => command === 'rule_list' ? [] : null);
        notifyMock.mockClear();
        const message = 'Override failed: missing policy';
        if (failure === 'reported') vi.mocked(prism.rebuildWithOverrides).mockResolvedValueOnce({ hot_reload_success: false, hot_reload_error: message });
        else vi.mocked(prism.rebuildWithOverrides).mockRejectedValueOnce(new Error(message));
        document.body.innerHTML = `<div data-page="connections"></div><div id="modal-bg" class="hidden opacity-0"><div id="modal-container">
            <h3 id="modal-title"></h3><div id="modal-content-area"></div><button id="modal-cancel"></button><button id="modal-confirm"></button>
        </div></div>`;
        const slot = document.createElement('div');
        document.body.appendChild(slot);
        try {
            await cr.mountRuleCard(slot, conn('Domain', 'example.com'), () => {}, true);
            slot.querySelector('[data-conn-rule="add"]').click();
            await vi.waitFor(() => expect(document.querySelector('[data-act="ok"]')).not.toBeNull());
            document.querySelector('[data-act="ok"]').click();
            await vi.waitFor(() => expect(notifyMock).toHaveBeenCalledWith(`${t('ruleLibrarySavedApplyFailed')}: ${message}`, 'warning'));
            expect(invokeMock.mock.calls.some(([command]) => command === 'rule_create')).toBe(true);
            await new Promise((resolve) => setTimeout(resolve, 350));
        } finally { document.body.innerHTML = ''; }
    });

    it.each([
        { changed: false, invalidation: null },
        { changed: true, invalidation: null },
        { changed: false, invalidation: 'reload' },
        { changed: false, invalidation: 'closed' },
        { changed: false, invalidation: 'backend-reload' },
        { changed: false, invalidation: 'unconfirmed' },
        { changed: false, invalidation: 'controller-closed' },
        { changed: false, invalidation: 'controller-read-failed' },
    ])('submits Edit only against its live attributed version: %j', async ({ changed, invalidation }) => {
        vi.stubGlobal('jsyaml', yamlModule);
        invokeMock.mockReset();
        getConnectionsMock.mockReset().mockResolvedValue({ connections: [{ id: 'test-connection' }] });
        const raw = 'DOMAIN,example.com,Proxy';
        const file = 'mine.prism.yaml';
        const original = 'rules:\n  $append:\n    - DOMAIN,example.com,Proxy\n';
        const snapshot = {
            annotationsConfirmed: true,
            rulesRevision: 7,
            groups: [{ group_id: file, rules: [{ raw, index: 0 }] }],
            rules: [raw], activeRules: [{ type: 'Domain', payload: 'example.com', proxy: 'Proxy' }],
        };
        vi.mocked(prism.listRuleSnapshot).mockReset().mockResolvedValueOnce(snapshot).mockResolvedValueOnce({
            ...snapshot, sourceFile: file, sourceContent: original,
        }).mockResolvedValueOnce({
            ...snapshot, annotationsConfirmed: invalidation !== 'unconfirmed', sourceFile: file, sourceContent: original,
        });
        document.body.innerHTML = `<div data-page="connections"></div><div id="modal-bg" class="hidden opacity-0"><div id="modal-container">
            <h3 id="modal-title"></h3><div id="modal-content-area"></div><button id="modal-cancel"></button><button id="modal-confirm"></button>
        </div></div>`;
        const slot = document.createElement('div');
        document.body.appendChild(slot);
        let live = true;
        try {
            await cr.mountRuleCard(slot, conn('Domain', 'example.com'), () => {}, false, () => live);
            expect(prism.listRuleSnapshot).toHaveBeenLastCalledWith(file);
            invokeMock.mockImplementation(async (command, args) => {
                if (command === 'rule_read') return changed ? '# newer\n' + original : original;
                if (command === 'rule_update' && invalidation === 'backend-reload') {
                    expect(args.expectedRulesRevision).toBe(7);
                    throw new Error('RULE_FILE_CHANGED: The running rules changed.');
                }
                return null;
            });
            slot.querySelector('[data-conn-rule="edit"]').click();
            await vi.waitFor(() => expect(document.getElementById('conn-rule-value')).not.toBeNull());
            expect(invokeMock.mock.calls.some(([command]) => command === 'rule_read')).toBe(false);
            document.getElementById('conn-rule-value').value = 'new.example.com';
            if (invalidation === 'reload') Bus.emit(Events.CONFIG_UPDATED, { reloaded: true });
            if (invalidation === 'closed') live = false;
            if (invalidation === 'controller-closed') getConnectionsMock.mockResolvedValueOnce({ connections: [] });
            if (invalidation === 'controller-read-failed') getConnectionsMock.mockRejectedValueOnce(new Error('Core unavailable'));
            document.querySelector('[data-act="ok"]').click();
            expect(document.getElementById('conn-rule-value').disabled).toBe(true);
            expect(document.getElementById('conn-rule-epolicy-wrap').inert).toBe(true);
            if (changed || invalidation) {
                await vi.waitFor(() => expect(document.querySelector('.conn-rule-error').textContent).toContain(changed || invalidation === 'backend-reload' ? 'RULE_FILE_CHANGED:' : t('connRuleGone')));
                expect(document.getElementById('conn-rule-value').disabled).toBe(false);
                if (invalidation === 'backend-reload') expect(invokeMock).toHaveBeenCalledWith('rule_update', expect.objectContaining({ expectedRulesRevision: 7 }));
                else expect(invokeMock.mock.calls.some(([command]) => command === 'rule_update')).toBe(false);
                document.querySelector('[data-act="cancel"]').click();
            } else {
                await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledWith('rule_update', expect.objectContaining({
                    filename: file, expectedContent: original, expectedRulesRevision: 7,
                    content: expect.stringContaining('DOMAIN,new.example.com,Proxy'),
                })));
            }
            await new Promise((resolve) => setTimeout(resolve, 350));
        } finally {
            vi.unstubAllGlobals();
            document.body.innerHTML = '';
        }
    });

    it.each([false, true])('requires a current policy for a historical connection (disappeared=%s)', async (disappeared) => {
        invokeMock.mockReset().mockImplementation(async (command) => command === 'rule_list' ? [] : null);
        vi.mocked(fetchProxyGroups).mockResolvedValueOnce({ orderedGroupNames: ['Proxy'] })
            .mockResolvedValueOnce({ orderedGroupNames: disappeared ? [] : ['Proxy'] });
        document.body.innerHTML = `<div data-page="connections"></div><div id="modal-bg" class="hidden opacity-0"><div id="modal-container">
            <h3 id="modal-title"></h3><div id="modal-content-area"></div><button id="modal-cancel"></button><button id="modal-confirm"></button>
        </div></div>`;
        const slot = document.createElement('div');
        document.body.appendChild(slot);
        try {
            await cr.mountRuleCard(slot, conn('Domain', 'example.com', ['Old profile group']), () => {}, true);
            slot.querySelector('[data-conn-rule="add"]').click();
            await vi.waitFor(() => expect(document.getElementById('conn-rule-policy-select')).not.toBeNull());
            expect(document.getElementById('conn-rule-policy-select').value).toBe('Proxy');
            expect(document.getElementById('conn-rule-policy-select').textContent).not.toContain('Old profile group');
            const choices = [...document.querySelectorAll('.choice-card')];
            const initiallySelected = choices.find((choice) => choice.getAttribute('aria-checked') === 'true');
            expect(initiallySelected.querySelector('.choice-card-desc').textContent).toBe('api.example.com');
            expect(cr.addOptions(conn('Domain', 'example.com'))[Number(initiallySelected.dataset.i)].type).toBe('DOMAIN');
            choices[0].focus();
            choices[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
            expect(document.activeElement).toBe(choices.at(-1));
            expect(choices.at(-1).getAttribute('aria-checked')).toBe('true');
            choices.at(-1).dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
            expect(document.activeElement).toBe(choices[0]);
            choices[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
            expect(document.activeElement).toBe(choices[1]);
            expect(choices[0].tabIndex).toBe(-1);
            expect(choices[1].tabIndex).toBe(0);
            document.querySelector('[data-act="ok"]').click();
            if (disappeared) {
                await vi.waitFor(() => expect(document.querySelector('.conn-rule-error').textContent).toContain(t('connRuleGone')));
                expect(invokeMock.mock.calls.some(([command]) => command === 'rule_create')).toBe(false);
                document.querySelector('[data-act="cancel"]').click();
            } else {
                await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledWith('rule_create', expect.objectContaining({ content: expect.stringContaining('DOMAIN,api.example.com,Proxy') })));
            }
            await new Promise((resolve) => setTimeout(resolve, 350));
        } finally { document.body.innerHTML = ''; }
    });

    it.each(['add', 'edit'])('does not open a pending %s dialog in a later Connections visit', async (action) => {
        const raw = 'DOMAIN,example.com,Proxy';
        vi.mocked(prism.listRuleSnapshot).mockReset().mockResolvedValue({
            annotationsConfirmed: true, rulesRevision: 1,
            groups: [{ group_id: 'mine.prism.yaml', rules: [{ raw, index: 0 }] }],
            rules: [raw], activeRules: [{ type: 'Domain', payload: 'example.com', proxy: 'Proxy' }],
            sourceFile: 'mine.prism.yaml', sourceContent: `rules:\n  $append:\n    - ${raw}\n`,
        });
        document.body.innerHTML = `<div data-page="connections"></div><div id="modal-bg" class="hidden opacity-0"><div id="modal-container">
            <h3 id="modal-title"></h3><div id="modal-content-area"></div><button id="modal-cancel"></button><button id="modal-confirm"></button>
        </div></div>`;
        const slot = document.createElement('div');
        document.body.appendChild(slot);
        let finish;
        vi.mocked(fetchProxyGroups).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
        try {
            await cr.mountRuleCard(slot, conn('Domain', 'example.com'));
            slot.querySelector(`[data-conn-rule="${action}"]`).click();
            await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
            Bus.emit(Events.CONNECTIONS_PAGE_LEFT);
            finish({ orderedGroupNames: ['Proxy'] });
            await new Promise((resolve) => setTimeout(resolve, 0));
            expect(document.querySelector('.conn-rule-form')).toBeNull();
        } finally { finish?.({ orderedGroupNames: ['Proxy'] }); document.body.innerHTML = ''; }
    });

    it.each(['add', 'edit'])('does not write a queued %s after its dialog is cancelled', async (action) => {
        const { queueRuleWrite } = await import('./rule-library/write-queue.js');
        vi.stubGlobal('jsyaml', yamlModule);
        const original = 'rules:\n  $append:\n    - DOMAIN,example.com,Proxy\n';
        invokeMock.mockReset().mockImplementation(async (command) => command === 'rule_list' ? [] : command === 'rule_read' ? original : null);
        vi.mocked(prism.listRuleSnapshot).mockReset().mockResolvedValue({
            annotationsConfirmed: true,
            rulesRevision: 1, groups: [{ group_id: 'mine.prism.yaml', rules: [{ raw: 'DOMAIN,example.com,Proxy', index: 0 }] }],
            rules: ['DOMAIN,example.com,Proxy'], activeRules: [{ type: 'Domain', payload: 'example.com', proxy: 'Proxy' }],
            sourceFile: 'mine.prism.yaml', sourceContent: original,
        });
        document.body.innerHTML = `<div data-page="connections"></div><div id="modal-bg" class="hidden opacity-0"><div id="modal-container">
            <h3 id="modal-title"></h3><div id="modal-content-area"></div><button id="modal-cancel"></button><button id="modal-confirm"></button>
        </div></div>`;
        const slot = document.createElement('div');
        document.body.appendChild(slot);
        let release;
        const blocker = queueRuleWrite(() => new Promise((resolve) => { release = resolve; }));
        try {
            await cr.mountRuleCard(slot, conn('Domain', 'example.com'));
            slot.querySelector(`[data-conn-rule="${action}"]`).click();
            await vi.waitFor(() => expect(document.querySelector('[data-act="ok"]')).not.toBeNull());
            if (action === 'edit') document.getElementById('conn-rule-value').value = 'new.example.com';
            document.querySelector('[data-act="ok"]').click();
            document.querySelector('[data-act="cancel"]').click();
            release();
            await blocker;
            await queueRuleWrite(async () => {});
            expect(invokeMock.mock.calls.some(([command]) => command === 'rule_create' || command === 'rule_update')).toBe(false);
            await new Promise((resolve) => setTimeout(resolve, 350));
        } finally {
            release?.();
            vi.unstubAllGlobals();
            document.body.innerHTML = '';
        }
    });

    it('keeps the shared RTL radio selection instead of applying the local arrow a second time', async () => {
        const { initTablistKeys } = await import('./tablist-keys.js');
        document.body.innerHTML = `<div data-page="connections"></div><div id="modal-bg" class="hidden opacity-0"><div id="modal-container">
            <h3 id="modal-title"></h3><div id="modal-content-area"></div><button id="modal-cancel"></button><button id="modal-confirm"></button>
        </div></div>`;
        const slot = document.createElement('div');
        document.body.appendChild(slot);
        const cleanup = initTablistKeys();
        try {
            await cr.mountRuleCard(slot, conn('Domain', 'example.com'), () => {}, true);
            slot.querySelector('[data-conn-rule="add"]').click();
            await vi.waitFor(() => expect(document.querySelector('[role="radiogroup"]')).not.toBeNull());
            document.querySelector('[role="radiogroup"]').style.direction = 'rtl';
            const choices = [...document.querySelectorAll('.choice-card')];
            choices[0].focus();
            choices[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
            expect(document.activeElement).toBe(choices.at(-1));
            expect(choices.at(-1).getAttribute('aria-checked')).toBe('true');
            expect(choices[1].getAttribute('aria-checked')).toBe('false');
            document.querySelector('[data-act="cancel"]').click();
            await new Promise((resolve) => setTimeout(resolve, 350));
        } finally { cleanup(); document.body.innerHTML = ''; }
    });
});
