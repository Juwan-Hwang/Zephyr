import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { debounce } from './debounce.js';

describe('debounce (trailing)', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('delays invocation', () => {
        const fn = vi.fn();
        const debounced = debounce(fn, 100);
        debounced();
        expect(fn).not.toHaveBeenCalled();
        vi.advanceTimersByTime(100);
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it('uses last call args', () => {
        const fn = vi.fn();
        const debounced = debounce(fn, 100);
        debounced('a');
        debounced('b');
        debounced('c');
        vi.advanceTimersByTime(100);
        expect(fn).toHaveBeenCalledWith('c');
    });

    it('cancel prevents invocation', () => {
        const fn = vi.fn();
        const debounced = debounce(fn, 100);
        debounced();
        debounced.cancel();
        vi.advanceTimersByTime(200);
        expect(fn).not.toHaveBeenCalled();
    });

    it('resets timer on each call', () => {
        const fn = vi.fn();
        const debounced = debounce(fn, 100);
        debounced();
        vi.advanceTimersByTime(50);
        debounced();
        vi.advanceTimersByTime(50);
        expect(fn).not.toHaveBeenCalled();
        vi.advanceTimersByTime(50);
        expect(fn).toHaveBeenCalledTimes(1);
    });
});

describe('debounce (leading)', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('calls immediately on first invocation', () => {
        const fn = vi.fn();
        const debounced = debounce(fn, 100, true);
        debounced();
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it('does not call again during cooldown', () => {
        const fn = vi.fn();
        const debounced = debounce(fn, 100, true);
        debounced();
        debounced();
        debounced();
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it('can trigger again after cooldown', () => {
        const fn = vi.fn();
        const debounced = debounce(fn, 100, true);
        debounced();
        vi.advanceTimersByTime(100);
        debounced();
        expect(fn).toHaveBeenCalledTimes(2);
    });
});
