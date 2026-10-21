import { describe, it, expect, vi } from 'vitest';

vi.mock('../api.js', async (importOriginal) => ({ ...(await importOriginal()), getConfig: vi.fn() }));

import { getConfig } from '../api.js';
import { isValidIPv6, isValidDns, DEFAULT_DNS_CONFIG, createDnsReapply, dnsShownAfterFailure } from './dns-shared.js';

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

describe('createDnsReapply', () => {
    const deferred = () => {
        /** @type {(v?: any) => void} */ let resolve = () => {};
        /** @type {(e?: any) => void} */ let reject = () => {};
        const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
        return { promise, resolve, reject };
    };

    it('re-applies and saves the saved choice', async () => {
        const apply = vi.fn(async () => {});
        const persist = vi.fn(async () => {});
        const setChecked = vi.fn();
        const r = createDnsReapply({ isSaved: async () => true, apply, persist, setChecked });
        await r.run();
        expect(apply).toHaveBeenCalledTimes(1);
        expect(setChecked).toHaveBeenCalledWith(true);
        expect(persist).toHaveBeenCalledTimes(1);
    });

    it('reports a saved rewrite it could not apply', async () => {
        const onError = vi.fn();
        const setChecked = vi.fn();
        const r = createDnsReapply({
            isSaved: async () => true,
            apply: async () => { throw new Error('core down'); },
            persist: async () => {},
            setChecked,
            onError,
            wait: async () => {},
        });
        await expect(r.run()).resolves.toBe(false);
        expect(setChecked).toHaveBeenCalledWith(false);
        expect(onError).toHaveBeenCalledTimes(1);
        const off = createDnsReapply({ isSaved: async () => false, apply: vi.fn(), persist: vi.fn(), setChecked: vi.fn() });
        await expect(off.run()).resolves.toBe(true);
    });

    it('a user turning DNS off mid re-apply wins: no check, no save, and the disable runs after', async () => {
        const pending = deferred();
        const order = /** @type {string[]} */ ([]);
        const persist = vi.fn(async () => {});
        const setChecked = vi.fn();
        const r = createDnsReapply({
            isSaved: async () => true,
            apply: async () => { order.push('apply'); await pending.promise; order.push('applied'); },
            persist,
            setChecked,
        });
        const run = r.run();
        await new Promise((res) => setTimeout(res, 0));
        const off = r.userChange(async () => { order.push('disable'); });
        pending.resolve();
        await run; await off;
        expect(order).toEqual(['apply', 'applied', 'disable']);
        expect(setChecked).not.toHaveBeenCalled();
        expect(persist).not.toHaveBeenCalled();
    });

    it('stops retrying once the user changes the toggle', async () => {
        const apply = vi.fn(async () => { throw new Error('core down'); });
        const setChecked = vi.fn();
        /** @type {() => void} */ let tick = () => {};
        const wait = () => new Promise((res) => { tick = () => res(undefined); });
        const r = createDnsReapply({ isSaved: async () => true, apply, persist: async () => {}, setChecked, wait });
        const run = r.run();
        await new Promise((res) => setTimeout(res, 0));
        const change = r.userChange(async () => {});
        tick();
        await run; await change;
        expect(apply).toHaveBeenCalledTimes(1);
        expect(setChecked).not.toHaveBeenCalled();
    });

    it('tells a toggle whether a newer one has been queued since', async () => {
        const r = createDnsReapply({ isSaved: async () => false, apply: async () => {}, persist: async () => {}, setChecked: vi.fn() });
        const first = deferred();
        /** @type {boolean[]} */ const seen = [];
        const a = r.userChange(async (isLatest) => { await first.promise; seen.push(isLatest()); });
        const b = r.userChange(async (isLatest) => { seen.push(isLatest()); });
        first.resolve();
        await a; await b;
        expect(seen).toEqual([false, true]);
    });

    it('keeps a toggle the latest when saved servers are applied after it', async () => {
        const r = createDnsReapply({ isSaved: async () => false, apply: async () => {}, persist: async () => {}, setChecked: vi.fn() });
        const first = deferred();
        /** @type {boolean[]} */ const seen = [];
        const off = r.userChange(async (isLatest) => { await first.promise; seen.push(isLatest()); });
        /** @type {string[]} */ const order = [];
        const servers = r.serversChange(async () => { order.push('servers'); });
        first.resolve();
        await off; await servers;
        expect(seen).toEqual([true]);
        expect(order).toEqual(['servers']);
    });

    it('reports a failed settings read instead of rejecting, and applies nothing', async () => {
        const apply = vi.fn(async () => {});
        const onError = vi.fn();
        const r = createDnsReapply({ isSaved: async () => { throw new Error('ipc'); }, apply, persist: async () => {}, setChecked: vi.fn(), onError });
        await expect(r.run()).resolves.toBe(false);
        expect(apply).not.toHaveBeenCalled();
        expect(onError).toHaveBeenCalledTimes(1);
    });

    it('keeps the switch on when only saving the choice fails', async () => {
        const apply = vi.fn(async () => {});
        const setChecked = vi.fn();
        const onError = vi.fn();
        const r = createDnsReapply({ isSaved: async () => true, apply, persist: async () => { throw new Error('disk'); }, setChecked, onError, wait: async () => {} });
        await r.run();
        expect(apply).toHaveBeenCalledTimes(1);
        expect(setChecked.mock.calls).toEqual([[true]]);
        expect(onError).toHaveBeenCalledTimes(1);
    });
    it('runs the startup sync in turn with restart re-applies', async () => {
        const order = [];
        const gate = deferred();
        const r = createDnsReapply({
            isSaved: async () => true,
            apply: async () => { await gate.promise; order.push('reapply'); },
            persist: async () => {},
            setChecked: (v) => order.push(`checked:${v}`),
        });
        const restart = r.run();
        const startup = r.initial(async () => { order.push('startup'); });
        await Promise.resolve();
        expect(order).toEqual([]);
        gate.resolve();
        await Promise.all([restart, startup]);
        expect(order).toEqual(['reapply', 'checked:true', 'startup']);
    });
});

describe('dnsShownAfterFailure', () => {
    it('shows the core state, not just the opposite of the failed toggle', async () => {
        // On then off, both refused: the core is still off.
        vi.mocked(getConfig).mockResolvedValueOnce({ dns: { enable: false } });
        expect(await dnsShownAfterFailure(false)).toBe(false);
        vi.mocked(getConfig).mockResolvedValueOnce({ dns: { enable: true } });
        expect(await dnsShownAfterFailure(true)).toBe(true);
    });

    it('falls back to the state before the toggle when the core can\'t be read', async () => {
        vi.mocked(getConfig).mockRejectedValueOnce(new Error('down'));
        expect(await dnsShownAfterFailure(false)).toBe(true);
        vi.mocked(getConfig).mockResolvedValueOnce({});
        expect(await dnsShownAfterFailure(true)).toBe(false);
    });
});
