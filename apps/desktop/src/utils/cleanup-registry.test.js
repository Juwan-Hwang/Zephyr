import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registerCleanup, runCleanup, _resetCleanupStateForTests } from './cleanup-registry.js';

beforeEach(() => {
    _resetCleanupStateForTests();
});

describe('registerCleanup', () => {
    it('returns unregister function', () => {
        const fn = vi.fn();
        const unsub = registerCleanup(fn);
        expect(typeof unsub).toBe('function');
        unsub();
    });

    it('unsub prevents execution', async () => {
        const fn = vi.fn();
        const unsub = registerCleanup(fn);
        unsub();
        await runCleanup();
        expect(fn).not.toHaveBeenCalled();
    });

    it('deduplicates same function reference', async () => {
        const fn = vi.fn();
        registerCleanup(fn);
        registerCleanup(fn);
        await runCleanup();
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it('invokes immediately if cleanup already ran', async () => {
        // Simulate post-cleanup registration (e.g. late listen() resolve)
        await runCleanup();
        const fn = vi.fn();
        registerCleanup(fn);
        expect(fn).toHaveBeenCalled();
    });

    it('swallows sync throw in late registration', async () => {
        await runCleanup();
        const fn = vi.fn(() => { throw new Error('boom'); });
        expect(() => registerCleanup(fn)).not.toThrow();
        expect(fn).toHaveBeenCalled();
    });

    it('swallows async rejection in late registration', async () => {
        await runCleanup();
        const fn = vi.fn(() => Promise.reject(new Error('async boom')));
        registerCleanup(fn);
        expect(fn).toHaveBeenCalled();
        // Allow microtask to settle — rejection should be swallowed, not unhandled.
        await new Promise(resolve => setTimeout(resolve, 0));
    });
});

describe('runCleanup', () => {
    it('runs with no registered functions', async () => {
        await expect(runCleanup()).resolves.toBeUndefined();
    });

    it('runs all registered functions', async () => {
        const fn1 = vi.fn();
        const fn2 = vi.fn();
        registerCleanup(fn1);
        registerCleanup(fn2);
        await runCleanup();
        expect(fn1).toHaveBeenCalled();
        expect(fn2).toHaveBeenCalled();
    });

    it('single error does not block others', async () => {
        const errFn = vi.fn(() => { throw new Error('boom'); });
        const okFn = vi.fn();
        registerCleanup(errFn);
        registerCleanup(okFn);
        await expect(runCleanup()).resolves.toBeUndefined();
        expect(okFn).toHaveBeenCalled();
    });

    it('handles async cleanup functions', async () => {
        const asyncFn = vi.fn(() => Promise.resolve());
        registerCleanup(asyncFn);
        await runCleanup();
        expect(asyncFn).toHaveBeenCalled();
    });

    it('is idempotent — second call is a no-op', async () => {
        const fn = vi.fn();
        registerCleanup(fn);
        await runCleanup();
        await runCleanup();
        expect(fn).toHaveBeenCalledTimes(1);
    });
});
