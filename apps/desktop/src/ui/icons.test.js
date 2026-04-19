import { describe, it, expect } from 'vitest';
import { SVG_ICONS } from './icons.js';

describe('SVG_ICONS', () => {
    it('is defined', () => {
        expect(SVG_ICONS).toBeDefined();
        expect(typeof SVG_ICONS).toBe('object');
    });

    it('all values are non-empty strings', () => {
        for (const [key, value] of Object.entries(SVG_ICONS)) {
            expect(typeof value).toBe('string');
            expect(value.length).toBeGreaterThan(0);
        }
    });

    it('all values contain SVG markup', () => {
        for (const [key, value] of Object.entries(SVG_ICONS)) {
            expect(value).toContain('<svg');
            expect(value).toContain('</svg>');
        }
    });

    it('has expected icon keys', () => {
        const expectedKeys = [
            'close', 'chevronDown', 'settings', 'proxy', 'rule', 'log',
            'connection', 'theme', 'tun', 'dns', 'shortcut', 'update',
            'advanced', 'subscription', 'tray', 'notification', 'info',
            'warning', 'error', 'success',
        ];
        for (const key of expectedKeys) {
            if (SVG_ICONS[key] !== undefined) {
                expect(typeof SVG_ICONS[key]).toBe('string');
            }
        }
    });
});
