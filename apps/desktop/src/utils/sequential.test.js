import { describe, it, expect, vi } from 'vitest';
import { createSequential, createSerialQueue } from './sequential.js';

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
        expect(r2.status === 'fulfilled' ? r2.value : undefined).toBe('new');
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

describe('createSerialQueue', () => {
    it('runs tasks in call order, each after the previous one settles', async () => {
        const q = createSerialQueue();
        /** @type {string[]} */
        const log = [];
        /** @type {(v?: unknown) => void} */
        let releaseFirst = () => {};
        const first = q.run(async () => {
            log.push('start 1');
            await new Promise((r) => { releaseFirst = r; });
            log.push('end 1');
            return 1;
        });
        const second = q.run(async () => { log.push('start 2'); return 2; });
        await Promise.resolve();
        await Promise.resolve();
        expect(log).toEqual(['start 1']);
        releaseFirst();
        await expect(first).resolves.toBe(1);
        await expect(second).resolves.toBe(2);
        expect(log).toEqual(['start 1', 'end 1', 'start 2']);
    });

    it('a failed task rejects on its own and does not block later ones', async () => {
        const q = createSerialQueue();
        const applied = /** @type {number[]} */ ([]);
        const failing = q.run(async () => { throw new Error('save failed'); });
        const next = q.run(async () => { applied.push(1.25); });
        await expect(failing).rejects.toThrow('save failed');
        await expect(next).resolves.toBeUndefined();
        expect(applied).toEqual([1.25]);
    });
});
