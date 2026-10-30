import { describe, it, expect } from 'vitest';
import { uaTripleFromBackendUA } from './ua-triple.js';

describe('uaTripleFromBackendUA', () => {
    it('maps each known preset back to itself', () => {
        expect(uaTripleFromBackendUA('clash-verge/2.3.0')).toEqual({
            enabled: 'true',
            type: 'clash-verge/2.3.0',
            custom: null,
        });
        expect(uaTripleFromBackendUA('mihomo-party/1.5.0')).toEqual({
            enabled: 'true',
            type: 'mihomo-party/1.5.0',
            custom: null,
        });
        expect(uaTripleFromBackendUA('Flclash/0.8.0')).toEqual({
            enabled: 'true',
            type: 'Flclash/0.8.0',
            custom: null,
        });
    });

    it('maps any other string to a custom triple carrying the same text', () => {
        expect(uaTripleFromBackendUA('MyCustomAgent/1.0 (Linux)')).toEqual({
            enabled: 'true',
            type: 'custom',
            custom: 'MyCustomAgent/1.0 (Linux)',
        });
        // A bare preset name without a version is not a selectable preset:
        // it still round-trips as custom text, so downloads keep sending it.
        expect(uaTripleFromBackendUA('clash-verge')).toEqual({
            enabled: 'true',
            type: 'custom',
            custom: 'clash-verge',
        });
    });

    it('trims surrounding whitespace before mapping', () => {
        expect(uaTripleFromBackendUA('  clash-verge/2.3.0  ')).toEqual({
            enabled: 'true',
            type: 'clash-verge/2.3.0',
            custom: null,
        });
    });

    it('returns null when the backend holds nothing usable', () => {
        expect(uaTripleFromBackendUA(null)).toBeNull();
        expect(uaTripleFromBackendUA(undefined)).toBeNull();
        expect(uaTripleFromBackendUA('')).toBeNull();
        expect(uaTripleFromBackendUA('   ')).toBeNull();
        expect(uaTripleFromBackendUA(42)).toBeNull();
    });
});
