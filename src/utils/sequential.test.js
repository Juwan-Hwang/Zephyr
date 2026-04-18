import { describe, it, expect, vi } from 'vitest';
import { createSequential } from './sequential.js';

describe('createSequential', () => {
    it('single run returns result', async () => {
        const seq = createSequential();
        const result = await seq.run('key', () => Promise.resolve(42));
        expect(result).toBe(42);
    });

    it('stale result is discarded', async () => {
        const seq = createSequential();
        const p1 = seq.run('key', () => new Promise(r => setTimeout(() => r('old'), 50)));
        const p2 = seq.run('key', () => Promise.resolve('new'));
        const [r1, r2] = await Promise.allSettled([p1, p2]);
        expect(r2.status).toBe('fulfilled');
        expect(r2.value).toBe('new');
    });

    it('different keys do not interfere', async () => {
        const seq = createSequential();
        const [a, b] = await Promise.all([
            seq.run('a', () => Promise.resolve(1)),
            seq.run('b', () => Promise.resolve(2)),
        ]);
        expect(a).toBe(1);
        expect(b).toBe(2);
    });

    it('real errors propagate', async () => {
        const seq = createSequential();
        await expect(seq.run('key', () => Promise.reject(new Error('real')))).rejects.toThrow('real');
    });

    it('destroy clears state', async () => {
        const seq = createSequential();
        seq.destroy();
        const result = await seq.run('key', () => Promise.resolve('after-destroy'));
        expect(result).toBe('after-destroy');
    });
});
