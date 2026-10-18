// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import {
    parseRuleLine, buildRuleLine, looksLikeFullRule, normalizeFullRule, loadPolicyNames, ruleTypeLabel, dropdownHtml,
} from './rule-form.js';

describe('rule-form helpers', () => {
    it('parses and rebuilds rule lines, keeping trailing options', () => {
        expect(parseRuleLine('DOMAIN-SUFFIX, openai.com ,OpenAI')).toEqual({ type: 'DOMAIN-SUFFIX', value: 'openai.com', policy: 'OpenAI', extra: [] });
        expect(parseRuleLine('MATCH,Proxy')).toEqual({ type: 'MATCH', value: '', policy: 'Proxy', extra: [] });
        const ip = parseRuleLine('IP-CIDR,10.0.0.0/8,DIRECT,no-resolve');
        expect(ip.extra).toEqual(['no-resolve']);
        expect(buildRuleLine(ip.type, ip.value, ip.policy, ip.extra)).toBe('IP-CIDR,10.0.0.0/8,DIRECT,no-resolve');
        expect(buildRuleLine('MATCH', 'ignored', 'Proxy')).toBe('MATCH,Proxy');
        expect(buildRuleLine('DOMAIN', ' a.com ', 'REJECT')).toBe('DOMAIN,a.com,REJECT');
    });

    it('recognises a pasted whole rule or JSON object', () => {
        expect(looksLikeFullRule('DOMAIN-SUFFIX,example.com,Proxy')).toBe(true);
        expect(looksLikeFullRule('MATCH,DIRECT')).toBe(true);
        expect(looksLikeFullRule('domain-suffix,example.com,Proxy')).toBe(true);
        expect(normalizeFullRule('domain-suffix,example.com,Proxy')).toBe('DOMAIN-SUFFIX,example.com,Proxy');
        expect(looksLikeFullRule('{"type":"DOMAIN"}')).toBe(true);
        expect(looksLikeFullRule('example.com')).toBe(false);
        expect(looksLikeFullRule('a,b')).toBe(false);
    });

    it('lists groups in config order, then DIRECT / REJECT / PASS, without GLOBAL or duplicates', async () => {
        const names = await loadPolicyNames(async () => ({ orderedGroupNames: ['🔰 手动选择', 'GLOBAL', 'DIRECT', 'OpenAI', 'OpenAI'] }));
        expect(names).toEqual(['🔰 手动选择', 'OpenAI', 'DIRECT', 'REJECT', 'PASS']);
        expect(await loadPolicyNames(async () => { throw new Error('core down'); })).toEqual(['DIRECT', 'REJECT', 'PASS']);
    });

    it('labels types from translations with fallbacks', () => {
        expect(ruleTypeLabel('DOMAIN-SUFFIX', { ruleTypeDomainSuffix: '域名后缀' })).toBe('域名后缀');
        expect(ruleTypeLabel('DOMAIN-SUFFIX', {})).toBe('Domain suffix');
        expect(ruleTypeLabel('AND', {})).toBe('AND');
    });

    it('renders an escaped dropdown with the selected option', () => {
        const html = dropdownHtml('x', [{ value: 'a', label: 'A' }, { value: '<b>', label: '<b>' }], '<b>');
        const host = document.createElement('div');
        // eslint-disable-next-line no-unsanitized/property -- test fixture: markup from dropdownHtml(), values escaped
        host.innerHTML = html; // nosemgrep: js-innerhtml-assignment
        expect(host.querySelector('#x-label')?.textContent).toBe('<b>');
        expect(/** @type {HTMLSelectElement} */ (host.querySelector('#x-select')).value).toBe('<b>');
        expect(host.querySelector('b')).toBeNull();
    });
    it('keeps a logical rule condition in one field', () => {
        const parsed = parseRuleLine('AND,((DOMAIN,a),(NETWORK,UDP)),REJECT');
        expect(parsed).toMatchObject({ type: 'AND', value: '((DOMAIN,a),(NETWORK,UDP))', policy: 'REJECT' });
        expect(buildRuleLine(parsed.type, parsed.value, 'DIRECT', parsed.extra)).toBe('AND,((DOMAIN,a),(NETWORK,UDP)),DIRECT');
    });
});
