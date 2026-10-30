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

    it('trims like Rust str::trim, not like JS trim', () => {
        // U+FEFF is not Rust whitespace: the backend keeps the prefix, so
        // the converter must keep it too instead of silently dropping it.
        expect(uaTripleFromBackendUA('\uFEFFMyAgent/1.0')).toEqual({
            enabled: 'true',
            type: 'custom',
            custom: '\uFEFFMyAgent/1.0',
        });
        // U+0085 is Rust whitespace: the backend trims it before storing
        // or validating, so the converter trims it before mapping.
        expect(uaTripleFromBackendUA('\u0085MyAgent/1.0\u0085')).toEqual({
            enabled: 'true',
            type: 'custom',
            custom: 'MyAgent/1.0',
        });
    });

    it('maps an explicit null or empty backend value to the disabled triple', () => {
        // The backend holds nothing, and its effective UA is the default:
        // restoring "disabled" keeps storage, controls and backend in
        // agreement instead of leaving the rejected draft enabled.
        expect(uaTripleFromBackendUA(null)).toEqual({
            enabled: 'false',
            type: null,
            custom: null,
        });
        expect(uaTripleFromBackendUA('')).toEqual({
            enabled: 'false',
            type: null,
            custom: null,
        });
        expect(uaTripleFromBackendUA('   ')).toEqual({
            enabled: 'false',
            type: null,
            custom: null,
        });
    });

    it('returns null when the read produced no answer', () => {
        expect(uaTripleFromBackendUA(undefined)).toBeNull();
        expect(uaTripleFromBackendUA(42)).toBeNull();
    });

    it('returns null for a stored value the backend itself would reject', () => {
        // Over 512 bytes (counted in bytes, like the backend): an upgraded
        // install can retain one, and it must not become the rollback
        // snapshot — downloads already fall back to the default for it.
        expect(uaTripleFromBackendUA('a'.repeat(513))).toBeNull();
        // Multi-byte characters count as more than one byte.
        expect(uaTripleFromBackendUA('é'.repeat(257))).toBeNull();
        // Exactly 512 bytes is still accepted.
        expect(uaTripleFromBackendUA('a'.repeat(512))).toEqual({
            enabled: 'true',
            type: 'custom',
            custom: 'a'.repeat(512),
        });
        expect(uaTripleFromBackendUA('é'.repeat(256))).toEqual({
            enabled: 'true',
            type: 'custom',
            custom: 'é'.repeat(256),
        });
        // Control characters are rejected by the backend too (inside the
        // string — leading/trailing ones are trimmed away first, as the
        // backend does).
        expect(uaTripleFromBackendUA('MyAgent/1.0\nBeta')).toBeNull();
        expect(uaTripleFromBackendUA('MyAgent\u007f/1.0')).toBeNull();
        // C1 controls count too: an ASCII-only check would pass these
        // and let a backend-invalid value become the rollback snapshot.
        expect(uaTripleFromBackendUA('MyAgent\u0085/1.0')).toBeNull();
        expect(uaTripleFromBackendUA('MyAgent\u009f/1.0')).toBeNull();
    });
});
