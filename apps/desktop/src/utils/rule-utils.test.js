import { describe, it, expect } from 'vitest';
import { getPolicyColor } from './rule-utils.js';

describe('getPolicyColor', () => {
    it('colours DIRECT green', () => expect(getPolicyColor('DIRECT')).toBe('text-green-400'));
    it('colours REJECT red', () => expect(getPolicyColor('REJECT')).toBe('text-rose-500'));
    it('is case-insensitive', () => {
        expect(getPolicyColor('direct')).toBe('text-green-400');
        expect(getPolicyColor('Reject')).toBe('text-rose-500');
    });
    it('uses the accent colour for proxy groups and other policies', () => {
        expect(getPolicyColor('Proxy')).toBe('text-accent');
        expect(getPolicyColor('🚀 节点选择')).toBe('text-accent');
    });
    it('handles empty or missing policies', () => {
        expect(getPolicyColor('')).toBe('text-accent');
        expect(getPolicyColor(/** @type {any} */ (undefined))).toBe('text-accent');
    });
});
