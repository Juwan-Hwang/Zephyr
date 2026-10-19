// @ts-check
import { describe, it, expect } from 'vitest';
import { norm } from './settings-nav.js';

describe('settings search text', () => {
    it('matches a Turkish dotted capital I with a typed i', () => {
        expect(norm('Abonelik Sahte İstemcisi').includes(norm('istemci'))).toBe(true);
    });

    it('lowercases and collapses whitespace', () => {
        expect(norm('  Proxy\n  Port ')).toBe('proxy port');
    });
});
