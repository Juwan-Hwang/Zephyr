import { describe, it, expect } from 'vitest';
import { normalizeVersion, parseSemVer, isRemoteNewer } from './version-utils.js';

describe('normalizeVersion', () => {
    it('strips a leading v or V and surrounding whitespace', () => {
        expect(normalizeVersion('v1.2.3')).toBe('1.2.3');
        expect(normalizeVersion('V1.2.3')).toBe('1.2.3');
        expect(normalizeVersion('  v2.0.0\n')).toBe('2.0.0');
    });

    it('leaves plain versions untouched', () => {
        expect(normalizeVersion('1.2.3-beta.1')).toBe('1.2.3-beta.1');
    });

    it('only strips one prefix character', () => {
        expect(normalizeVersion('vv1.0.0')).toBe('v1.0.0');
    });

    it('returns an empty string for null/undefined', () => {
        expect(normalizeVersion(/** @type {any} */ (null))).toBe('');
        expect(normalizeVersion(/** @type {any} */ (undefined))).toBe('');
    });
});

describe('parseSemVer', () => {
    it('parses main segments', () => {
        expect(parseSemVer('1.2.3')).toEqual({ main: [1, 2, 3], prerelease: [] });
    });

    it('parses prerelease identifiers', () => {
        expect(parseSemVer('1.0.0-alpha.1')).toEqual({ main: [1, 0, 0], prerelease: ['alpha', '1'] });
    });

    it('keeps hyphens inside prerelease identifiers', () => {
        expect(parseSemVer('1.0.0-rc-1.2')).toEqual({ main: [1, 0, 0], prerelease: ['rc-1', '2'] });
    });

    it('strips build metadata', () => {
        expect(parseSemVer('1.0.0+20130313144700')).toEqual({ main: [1, 0, 0], prerelease: [] });
        expect(parseSemVer('1.0.0-beta+exp.sha.5114f85')).toEqual({ main: [1, 0, 0], prerelease: ['beta'] });
    });

    it('treats non-numeric main segments as 0', () => {
        expect(parseSemVer('1.x.3').main).toEqual([1, 0, 3]);
    });
});

describe('isRemoteNewer', () => {
    it('compares major, minor and patch numerically', () => {
        expect(isRemoteNewer('2.0.0', '1.9.9')).toBe(true);
        expect(isRemoteNewer('1.10.0', '1.9.0')).toBe(true);
        expect(isRemoteNewer('1.2.10', '1.2.9')).toBe(true);
        expect(isRemoteNewer('1.2.9', '1.2.10')).toBe(false);
    });

    it('returns false for equal versions', () => {
        expect(isRemoteNewer('1.2.3', '1.2.3')).toBe(false);
        expect(isRemoteNewer('1.2.3-beta.1', '1.2.3-beta.1')).toBe(false);
    });

    it('treats missing segments as zero', () => {
        expect(isRemoteNewer('1.2', '1.2.0')).toBe(false);
        expect(isRemoteNewer('1.2.1', '1.2')).toBe(true);
    });

    it('ranks a release above its prereleases', () => {
        expect(isRemoteNewer('1.0.0', '1.0.0-rc.1')).toBe(true);
        expect(isRemoteNewer('1.0.0-rc.1', '1.0.0')).toBe(false);
    });

    it('ranks a prerelease of a higher version above an older release', () => {
        expect(isRemoteNewer('1.1.0-alpha', '1.0.0')).toBe(true);
    });

    it('follows the SemVer 2.0.0 precedence example chain', () => {
        const chain = [
            '1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta',
            '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0',
        ];
        for (let i = 1; i < chain.length; i++) {
            expect(isRemoteNewer(chain[i], chain[i - 1]), `${chain[i]} > ${chain[i - 1]}`).toBe(true);
            expect(isRemoteNewer(chain[i - 1], chain[i]), `${chain[i - 1]} < ${chain[i]}`).toBe(false);
        }
    });

    it('compares numeric prerelease identifiers numerically', () => {
        expect(isRemoteNewer('1.0.0-beta.11', '1.0.0-beta.2')).toBe(true);
    });

    it('ignores build metadata when comparing', () => {
        expect(isRemoteNewer('1.0.0+build.2', '1.0.0+build.1')).toBe(false);
    });

    it('works on normalized tag names', () => {
        expect(isRemoteNewer(normalizeVersion('v1.3.0'), normalizeVersion('1.2.9'))).toBe(true);
    });
});
