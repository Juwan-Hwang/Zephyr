import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { throttle } from './throttle.js';

describe('throttle', () => {
    beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); });
    afterEach(() => { vi.useRealTimers(); });

    it('calls immediately on first invocation', () => {
        const fn = vi.fn();
        const throttled = throttle(fn, 100);
        throttled();
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it('does not call again within limit', () => {
        const fn = vi.fn();
        const throttled = throttle(fn, 100);
        throttled();
        throttled();
        throttled();
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it('calls again after limit', () => {
        const fn = vi.fn();
        const throttled = throttle(fn, 100);
        throttled();
        vi.advanceTimersByTime(100);
        throttled();
        vi.runAllTimers();
        expect(fn).toHaveBeenCalledTimes(2);
    });

    it('delays excess calls until limit expires', () => {
        const fn = vi.fn();
        const throttled = throttle(fn, 100);
        throttled('first');
        throttled('second');
        vi.runAllTimers();
        expect(fn).toHaveBeenLastCalledWith('second');
        expect(fn).toHaveBeenCalledTimes(2);
    });

    it('passes correct this context', () => {
        const fn = vi.fn();
        const obj = { throttled: throttle(fn, 100) };
        obj.throttled();
        expect(fn).toHaveBeenCalledWith();
    });
});
