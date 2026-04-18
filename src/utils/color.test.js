import { describe, it, expect } from 'vitest';
import { hexToRgb } from './color.js';

describe('hexToRgb', () => {
    it('parses #8b5cf6', () => expect(hexToRgb('#8b5cf6')).toEqual({ r: 139, g: 92, b: 246 }));
    it('parses without #', () => expect(hexToRgb('8b5cf6')).toEqual({ r: 139, g: 92, b: 246 }));
    it('parses #FFFFFF', () => expect(hexToRgb('#FFFFFF')).toEqual({ r: 255, g: 255, b: 255 }));
    it('parses #000000', () => expect(hexToRgb('#000000')).toEqual({ r: 0, g: 0, b: 0 }));
    it('returns null for invalid', () => expect(hexToRgb('invalid')).toBeNull());
    it('returns null for empty', () => expect(hexToRgb('')).toBeNull());
    it('returns null for #xyz', () => expect(hexToRgb('#xyz')).toBeNull());
    it('returns null for short hex', () => expect(hexToRgb('#fff')).toBeNull());
    it('returns null for too long', () => expect(hexToRgb('#ffffffff')).toBeNull());
    it('case insensitive', () => expect(hexToRgb('#AABBCC')).toEqual({ r: 170, g: 187, b: 204 }));
});
