import { describe, it, expect } from 'vitest';
import { parseSubInfo, formatSubUsage } from './sub-info.js';

const GB = 1073741824;
const days = (/** @type {number} */ d) => `${d} days left`;

describe('subscription usage', () => {
    it('parses the userinfo fields', () => {
        expect(parseSubInfo('upload=1; download=2; total=3; expire=4')).toEqual({ upload: 1, download: 2, total: 3, expire: 4 });
        expect(parseSubInfo('')).toEqual({ upload: 0, download: 0, total: 0, expire: 0 });
    });

    it('takes no figure from a malformed field', () => {
        expect(parseSubInfo('upload=1junk; download=2.5; total=1.5e3; expire=123junk')).toEqual({ upload: 0, download: 2, total: 1500, expire: 0 });
        expect(parseSubInfo('upload=1e308; download=1e308; total=1000')).toEqual({ upload: 0, download: 0, total: 1000, expire: 0 });
    });

    it('formats used / total and days left', () => {
        const now = 1_700_000_000_000;
        const info = `upload=${Math.round(1.8 * GB)}; download=${60 * GB}; total=${200 * GB}; expire=${now / 1000 + 23 * 86400}`;
        expect(formatSubUsage(info, days, now)).toBe('61.8 GB / 200 GB · 23 days left');
        // Hours left still count as a day.
        expect(formatSubUsage(`total=${GB}; expire=${now / 1000 + 3600}`, days, now)).toMatch(/· 1 days left$/);
    });

    it('leaves out days left when there is no expiry or it has passed', () => {
        const now = 1_700_000_000_000;
        expect(formatSubUsage(`download=${GB}; total=${100 * GB}`, days, now)).toBe('1 GB / 100 GB');
        // A small quota reads in MB, so full and unused are told apart.
        expect(formatSubUsage(`download=${50 * 1048576}; total=${50 * 1048576}`, days, now)).toBe('50 MB / 50 MB');
        expect(formatSubUsage(`total=${50 * 1048576}`, days, now)).toBe('0 GB / 50 MB');
        expect(formatSubUsage(`download=${975 * 1048576}; total=${1000 * 1048576}`, days, now)).toBe('975 MB / 1000 MB');
        expect(formatSubUsage(`download=${GB}; total=${100 * GB}; expire=${now / 1000 - 10}`, days, now)).toBe('1 GB / 100 GB');
    });

    it('is null without a total', () => {
        expect(formatSubUsage(undefined, days)).toBeNull();
        expect(formatSubUsage('upload=5; download=6', days)).toBeNull();
    });
});
