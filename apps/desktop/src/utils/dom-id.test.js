import { describe, it, expect } from 'vitest';
import { generateDomId } from './dom-id.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  generateDomId — cryptographic DOM ID generator
// ═══════════════════════════════════════════════════════════════════════════════

describe('generateDomId', () => {
    describe('output format', () => {
        it('should produce prefix-random-counter format', () => {
            const id = generateDomId('test');
            // Format: prefix-7char base36-base36 counter
            expect(id).toMatch(/^test-[0-9a-z]{7}-[0-9a-z]+$/);
        });

        it('should use default prefix "id" when none provided', () => {
            const id = generateDomId();
            expect(id).toMatch(/^id-[0-9a-z]{7}-[0-9a-z]+$/);
        });

        it('should preserve arbitrary prefixes', () => {
            expect(generateDomId('collapsible-content')).toMatch(/^collapsible-content-/);
            expect(generateDomId('rl-group-body')).toMatch(/^rl-group-body-/);
        });
    });

    describe('uniqueness', () => {
        it('should generate unique IDs across 1000 calls', () => {
            const ids = new Set();
            for (let i = 0; i < 1000; i++) {
                ids.add(generateDomId('uniq'));
            }
            expect(ids.size).toBe(1000);
        });

        it('should produce different IDs with different prefixes', () => {
            const a = generateDomId('a');
            const b = generateDomId('b');
            expect(a).not.toBe(b);
            expect(a.startsWith('a-')).toBe(true);
            expect(b.startsWith('b-')).toBe(true);
        });
    });

    describe('counter behavior', () => {
        it('should increment the counter component sequentially', () => {
            const id1 = generateDomId('seq');
            const id2 = generateDomId('seq');
            const seq1 = parseInt(id1.split('-').pop(), 36);
            const seq2 = parseInt(id2.split('-').pop(), 36);
            // Counter may have been incremented by previous tests, but
            // consecutive calls should differ by exactly 1.
            expect(seq2 - seq1).toBe(1);
        });
    });

    describe('randomness quality', () => {
        it('should produce varied random parts across calls', () => {
            const randomParts = new Set();
            for (let i = 0; i < 100; i++) {
                const id = generateDomId('rand');
                const parts = id.split('-');
                randomParts.add(parts[1]);
            }
            // With 32-bit crypto randomness, all 100 random parts should be unique.
            expect(randomParts.size).toBe(100);
        });

        it('should always produce 7-character random component', () => {
            for (let i = 0; i < 50; i++) {
                const id = generateDomId('len');
                const randomPart = id.split('-')[1];
                expect(randomPart).toHaveLength(7);
            }
        });
    });

    describe('DOM safety', () => {
        it('should only contain DOM-safe characters', () => {
            const id = generateDomId('safe');
            // DOM IDs allow alphanumerics, hyphens, underscores, colons.
            // Our format uses prefix-[0-9a-z]+-[0-9a-z]+
            expect(id).toMatch(/^[a-zA-Z0-9_-]+$/);
        });

        it('should not start with a digit (valid HTML4 ID)', () => {
            // While HTML5 allows IDs starting with digits, we use alphabetic
            // prefixes to maintain backward compatibility.
            const id = generateDomId('html4');
            expect(id[0]).toMatch(/[a-zA-Z]/);
        });
    });
});
