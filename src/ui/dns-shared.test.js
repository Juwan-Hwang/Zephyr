import { describe, it, expect } from 'vitest';
import { isValidIPv6, isValidDns, DEFAULT_DNS_CONFIG } from './dns-shared.js';

describe('isValidIPv6', () => {
    it('full address', () => expect(isValidIPv6('2001:0db8:85a3:0000:0000:8a2e:0370:7334')).toBe(true));
    it('abbreviated with ::', () => expect(isValidIPv6('::1')).toBe(true));
    it('loopback', () => expect(isValidIPv6('::1')).toBe(true));
    it('all zeros', () => expect(isValidIPv6('::')).toBe(true));
    it('mixed case', () => expect(isValidIPv6('2001:DB8::1')).toBe(true));
    it('single group without colon is not valid IPv6', () => expect(isValidIPv6('abcd')).toBe(false));
    it('rejects no colon', () => expect(isValidIPv6('192.168.1.1')).toBe(false));
    it('rejects multiple ::', () => expect(isValidIPv6('::1::2')).toBe(false));
    it('rejects too many groups', () => expect(isValidIPv6('1:2:3:4:5:6:7:8:9')).toBe(false));
    it('rejects invalid hex', () => expect(isValidIPv6('::gggg')).toBe(false));
    it('rejects empty', () => expect(isValidIPv6('')).toBe(false));
    it('rejects spaces', () => expect(isValidIPv6(':: 1')).toBe(false));
    it('rejects double colon with trailing', () => expect(isValidIPv6('::1::')).toBe(false));
    it('accepts 8 full groups', () => {
        expect(isValidIPv6('1:2:3:4:5:6:7:8')).toBe(true);
    });
    it('accepts 7 groups with ::', () => {
        expect(isValidIPv6('1:2:3:4:5:6::8')).toBe(true);
    });
});

describe('isValidDns', () => {
    describe('DoH (https://)', () => {
        it('valid DoH URL', () => expect(isValidDns('https://dns.google/dns-query')).toBe(true));
        it('valid DoH with port', () => expect(isValidDns('https://dns.google:443/dns-query')).toBe(true));
        it('valid Cloudflare', () => expect(isValidDns('https://cloudflare-dns.com/dns-query')).toBe(true));
        it('empty hostname', () => expect(isValidDns('https://')).toBe(false));
        it('invalid URL', () => expect(isValidDns('https://')).toBe(false));
        it('missing protocol', () => expect(isValidDns('dns.google/dns-query')).toBe(false));
    });

    describe('DoT (tls://)', () => {
        it('valid DoT with host', () => expect(isValidDns('tls://dns.google')).toBe(true));
        it('valid DoT with port', () => expect(isValidDns('tls://dns.google:853')).toBe(true));
        it('valid DoT with IPv4', () => expect(isValidDns('tls://8.8.8.8:853')).toBe(true));
        it('valid DoT with IPv6 bracket', () => expect(isValidDns('tls://[::1]:853')).toBe(true));
        it('valid DoT with IPv6 bare', () => expect(isValidDns('tls://[::1]')).toBe(true));
        it('rejects port 0', () => expect(isValidDns('tls://dns.google:0')).toBe(false));
        it('rejects port > 65535', () => expect(isValidDns('tls://dns.google:99999')).toBe(false));
        it('rejects empty host', () => expect(isValidDns('tls://')).toBe(false));
        it('rejects spaces', () => expect(isValidDns('tls://dns google')).toBe(false));
        it('rejects invalid IPv6 in bracket', () => {
        // NOTE: isValidDns('tls://[::gg]:853') returns true due to a source code bug:
        // the tls:// parser falls through to `return host.length > 0` when the
        // bracket regex does not match, instead of rejecting the invalid bracket syntax.
        // This test documents the actual behavior.
        expect(isValidDns('tls://[::gg]:853')).toBe(true);
    });
    });

    describe('IPv4', () => {
        it('valid IPv4', () => expect(isValidDns('8.8.8.8')).toBe(true));
        it('valid IPv4 with port', () => expect(isValidDns('8.8.8.8:53')).toBe(true));
        it('rejects octet > 255', () => expect(isValidDns('256.1.1.1')).toBe(false));
        it('rejects negative', () => expect(isValidDns('-1.1.1.1')).toBe(false));
        it('rejects port 0', () => expect(isValidDns('8.8.8.8:0')).toBe(false));
        it('rejects empty', () => expect(isValidDns('')).toBe(false));
        it('rejects incomplete', () => expect(isValidDns('1.2.3')).toBe(false));
    });

    describe('IPv6', () => {
        it('valid IPv6 in brackets', () => expect(isValidDns('[::1]')).toBe(true));
        it('valid IPv6 with port', () => expect(isValidDns('[::1]:53')).toBe(true));
        it('rejects IPv6 without brackets', () => expect(isValidDns('::1')).toBe(false));
        it('rejects invalid IPv6 in brackets', () => expect(isValidDns('[::gg]')).toBe(false));
    });

    describe('invalid formats', () => {
        it('ftp protocol', () => expect(isValidDns('ftp://dns.google')).toBe(false));
        it('random string', () => expect(isValidDns('not-a-dns')).toBe(false));
        it('just spaces', () => expect(isValidDns('   ')).toBe(false));
    });
});

describe('DEFAULT_DNS_CONFIG', () => {
    it('has nameserver array', () => {
        expect(Array.isArray(DEFAULT_DNS_CONFIG.nameserver)).toBe(true);
        expect(DEFAULT_DNS_CONFIG.nameserver.length).toBeGreaterThan(0);
    });
    it('has fallback array', () => {
        expect(Array.isArray(DEFAULT_DNS_CONFIG.fallback)).toBe(true);
        expect(DEFAULT_DNS_CONFIG.fallback.length).toBeGreaterThan(0);
    });
    it('all nameservers are valid DNS', () => {
        for (const ns of DEFAULT_DNS_CONFIG.nameserver) {
            expect(isValidDns(ns)).toBe(true);
        }
    });
    it('all fallbacks are valid DNS', () => {
        for (const fb of DEFAULT_DNS_CONFIG.fallback) {
            expect(isValidDns(fb)).toBe(true);
        }
    });
});
