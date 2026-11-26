import { describe, it, expect, vi, beforeEach } from 'vitest';

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock('../api.js', () => ({ invoke: invokeMock }));
vi.mock('./prism.js', () => ({ apply: vi.fn(async () => {}), listRules: vi.fn(async () => []) }));

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
    });

    it('refuses to add to a turned-off "My rules"', async () => {
        invokeMock.mockImplementation(async (cmd) => (cmd === 'rule_list' ? [{ filename: 'My Rules.prism.yaml', enabled: false }] : null));
        await expect(cr.addToMyRules('DOMAIN,a.com,DIRECT')).rejects.toThrow();
        expect(invokeMock.mock.calls.some((c) => c[0] === 'rule_read' || c[0] === 'rule_update')).toBe(false);
    });

    it('moves an appended "My rules" into a prepend block', async () => {
        invokeMock.mockImplementation(async (cmd) => {
            if (cmd === 'rule_list') return [{ filename: 'My Rules.prism.yaml', enabled: true }];
            if (cmd === 'rule_read') return 'name: mine\nrules:\n  $append:\n    - DOMAIN,b.com,Proxy\n';
            return null;
        });
        await cr.addToMyRules('DOMAIN,a.com,DIRECT');
        const text = invokeMock.mock.calls.find((c) => c[0] === 'rule_update')?.[1].content || '';
        expect(text).toContain('$prepend');
        expect(text).not.toContain('$append');
        expect(text).toContain('name: mine');
        expect(text.indexOf('a.com')).toBeLessThan(text.indexOf('b.com'));
    });

    it('creates "My rules" with the rule prepended when it is missing', async () => {
        invokeMock.mockImplementation(async (cmd) => (cmd === 'rule_list' ? [] : null));
        await cr.addToMyRules('DOMAIN,a.com,DIRECT');
        const create = invokeMock.mock.calls.find((c) => c[0] === 'rule_create');
        expect(create?.[1].content).toBe('rules:\n  $prepend:\n    - "DOMAIN,a.com,DIRECT"\n');
        expect(prism.apply).toHaveBeenCalled();
    });

    it('puts a new rule first in an existing "My rules"', async () => {
        invokeMock.mockImplementation(async (cmd) => {
            if (cmd === 'rule_list') return [{ filename: 'My Rules.prism.yaml' }];
            if (cmd === 'rule_read') return 'rules:\n  $prepend:\n    - DOMAIN,b.com,Proxy\n';
            return null;
        });
        await cr.addToMyRules('DOMAIN,a.com,DIRECT');
        const update = invokeMock.mock.calls.find((c) => c[0] === 'rule_update');
        const text = update?.[1].content || '';
        expect(text.indexOf('a.com')).toBeLessThan(text.indexOf('b.com'));
        expect(text).toContain('$prepend');
    });

    it('replaces one line of a library file', async () => {
        invokeMock.mockImplementation(async (cmd) => (cmd === 'rule_read' ? 'rules:\n  $append:\n    - DOMAIN,a.com,DIRECT\n    - DOMAIN,b.com,Proxy\n' : null));
        await cr.replaceInFile('x.prism.yaml', 'DOMAIN,b.com,Proxy', 'DOMAIN,b.com,DIRECT');
        const text = invokeMock.mock.calls.find((c) => c[0] === 'rule_update')?.[1].content || '';
        expect(text).toContain('DOMAIN,b.com,DIRECT');
        expect(text).not.toContain('DOMAIN,b.com,Proxy');
        await expect(cr.replaceInFile('x.prism.yaml', 'DOMAIN,zzz,Proxy', 'x')).rejects.toThrow();
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
