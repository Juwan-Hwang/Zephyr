import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    createClientVersionFetcher,
    computeBackoffDelay,
    isValidClientVersions,
    DEFAULT_BASE_DELAY_MS,
    DEFAULT_MAX_DELAY_MS,
    DEFAULT_MAX_ATTEMPTS,
} from './client-version-fetch.js';

const VALID = { verge: 'clash-verge/v2.0.0', mihomo_party: 'mihomo-party/v1.5.0', flclash: 'Flclash/v0.8.0' };

/** Flush pending microtasks (promise callbacks) without advancing timers. */
async function flush() {
    for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe('isValidClientVersions', () => {
    it('accepts a complete reply', () => {
        expect(isValidClientVersions(VALID)).toBe(true);
    });

    it('rejects empty, null and incomplete replies', () => {
        expect(isValidClientVersions(null)).toBe(false);
        expect(isValidClientVersions(undefined)).toBe(false);
        expect(isValidClientVersions({})).toBe(false);
        expect(isValidClientVersions({ ...VALID, flclash: '' })).toBe(false);
        expect(isValidClientVersions({ verge: 'x', mihomo_party: 'y' })).toBe(false);
    });
});

describe('computeBackoffDelay', () => {
    it('doubles from the base delay and caps at the max', () => {
        expect(computeBackoffDelay(1)).toBe(DEFAULT_BASE_DELAY_MS);
        expect(computeBackoffDelay(2)).toBe(DEFAULT_BASE_DELAY_MS * 2);
        expect(computeBackoffDelay(3)).toBe(DEFAULT_BASE_DELAY_MS * 4);
        expect(computeBackoffDelay(50)).toBe(DEFAULT_MAX_DELAY_MS);
        expect(computeBackoffDelay(1000)).toBe(DEFAULT_MAX_DELAY_MS);
    });
});

describe('createClientVersionFetcher', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    /**
     * Mirrors the settings.js wiring: onSettled re-requests, which is exactly
     * the re-entry path that used to form a tight loop.
     */
    function setup(fetchImpl, opts = {}) {
        const fetch = vi.fn(fetchImpl);
        const onSuccess = vi.fn();
        const onFailure = vi.fn();
        /** @type {any} */
        let fetcher;
        const onSettled = vi.fn(() => fetcher.request());
        fetcher = createClientVersionFetcher({
            fetch,
            onSuccess,
            onFailure,
            onSettled,
            isValid: isValidClientVersions,
            ...opts,
        });
        return { fetcher, fetch, onSuccess, onFailure, onSettled };
    }

    it('does not tight-loop when the backend rejects immediately', async () => {
        const { fetcher, fetch, onFailure } = setup(() => Promise.reject(new Error('offline')));

        fetcher.request();
        await flush();

        // Re-entry from onSettled must not fire another request right away.
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(onFailure).toHaveBeenCalledTimes(1);
        expect(fetcher.state.retryScheduled).toBe(true);

        // Hammering request() during backoff is a no-op.
        for (let i = 0; i < 100; i++) fetcher.request();
        await flush();
        expect(fetch).toHaveBeenCalledTimes(1);

        // Just before the first backoff window, still nothing.
        await vi.advanceTimersByTimeAsync(DEFAULT_BASE_DELAY_MS - 1);
        expect(fetch).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(fetch).toHaveBeenCalledTimes(2);
    });

    it('treats an empty reply as a failure and backs off', async () => {
        const { fetcher, fetch, onSuccess } = setup(() => Promise.resolve(null));

        fetcher.request();
        await flush();
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(onSuccess).not.toHaveBeenCalled();
        expect(fetcher.state.failures).toBe(1);
        expect(fetcher.state.retryScheduled).toBe(true);
    });

    it('grows the delay exponentially between attempts', async () => {
        const { fetcher, fetch, onFailure } = setup(() => Promise.reject(new Error('rate limited')));

        fetcher.request();
        await flush();
        expect(fetch).toHaveBeenCalledTimes(1);

        const expected = [2000, 4000, 8000, 16000, 32000];
        for (let i = 0; i < expected.length; i++) {
            await vi.advanceTimersByTimeAsync(expected[i] - 1);
            expect(fetch).toHaveBeenCalledTimes(i + 1);
            await vi.advanceTimersByTimeAsync(1);
            expect(fetch).toHaveBeenCalledTimes(i + 2);
        }
        expect(onFailure.mock.calls.slice(0, 5).map((c) => c[1].nextDelayMs)).toEqual(expected);
    });

    it('stops automatic retries after maxAttempts', async () => {
        const { fetcher, fetch, onFailure } = setup(() => Promise.reject(new Error('down')));

        fetcher.request();
        // Far more time than the whole capped schedule needs.
        await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);

        expect(fetch).toHaveBeenCalledTimes(DEFAULT_MAX_ATTEMPTS);
        expect(onFailure.mock.calls.at(-1)[1].nextDelayMs).toBeNull();
        expect(fetcher.state.retryScheduled).toBe(false);
        expect(vi.getTimerCount()).toBe(0);

        fetcher.request();
        await flush();
        expect(fetch).toHaveBeenCalledTimes(DEFAULT_MAX_ATTEMPTS);
    });

    it('caps the backoff delay', async () => {
        const { fetcher, onFailure } = setup(() => Promise.reject(new Error('down')), {
            maxAttempts: 20,
            maxDelayMs: 10_000,
        });

        fetcher.request();
        await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
        const delays = onFailure.mock.calls.map((c) => c[1].nextDelayMs).filter((d) => d !== null);
        expect(Math.max(...delays)).toBe(10_000);
    });

    it('retryNow resets the budget after exhaustion (user action)', async () => {
        const { fetcher, fetch } = setup(() => Promise.reject(new Error('down')), { maxAttempts: 2 });

        fetcher.request();
        await vi.advanceTimersByTimeAsync(60_000);
        expect(fetch).toHaveBeenCalledTimes(2);

        fetcher.retryNow();
        await flush();
        expect(fetch).toHaveBeenCalledTimes(3);
        expect(fetcher.state.failures).toBe(1);
        expect(fetcher.state.retryScheduled).toBe(true);
    });

    it('never runs two requests concurrently', async () => {
        /** @type {(v: unknown) => void} */
        let resolve = () => {};
        const { fetcher, fetch, onSuccess } = setup(() => new Promise((r) => { resolve = r; }));

        fetcher.request();
        fetcher.request();
        fetcher.retryNow();
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(fetcher.state.inFlight).toBe(true);

        resolve(VALID);
        await flush();
        expect(onSuccess).toHaveBeenCalledWith(VALID);
        expect(fetcher.state.done).toBe(true);

        fetcher.request();
        fetcher.retryNow();
        await vi.advanceTimersByTimeAsync(DEFAULT_MAX_DELAY_MS);
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('succeeds on a later attempt and stops retrying', async () => {
        let calls = 0;
        const { fetcher, fetch, onSuccess } = setup(() => {
            calls += 1;
            return calls < 3 ? Promise.reject(new Error('flaky')) : Promise.resolve(VALID);
        });

        fetcher.request();
        await vi.advanceTimersByTimeAsync(2000 + 4000);
        expect(fetch).toHaveBeenCalledTimes(3);
        expect(onSuccess).toHaveBeenCalledTimes(1);
        expect(fetcher.state.retryScheduled).toBe(false);

        await vi.advanceTimersByTimeAsync(DEFAULT_MAX_DELAY_MS * 2);
        expect(fetch).toHaveBeenCalledTimes(3);
    });

    it('pause stops scheduled and in-flight failures from retrying', async () => {
        /** @type {(e: unknown) => void} */
        let reject = () => {};
        const fetch = vi.fn(() => new Promise((_, r) => { reject = r; }));
        const fetcher = createClientVersionFetcher({ fetch, onSuccess: vi.fn(), isValid: isValidClientVersions });

        // A failure schedules a retry; pausing cancels it.
        fetcher.request();
        reject(new Error('down'));
        await flush();
        expect(fetcher.state.retryScheduled).toBe(true);
        fetcher.pause();
        expect(fetcher.state.retryScheduled).toBe(false);
        await vi.advanceTimersByTimeAsync(DEFAULT_MAX_DELAY_MS);
        expect(fetch).toHaveBeenCalledTimes(1);

        // A lookup that fails after pausing schedules nothing either.
        fetcher.retryNow();
        expect(fetch).toHaveBeenCalledTimes(2);
        fetcher.pause();
        reject(new Error('down'));
        await flush();
        await vi.advanceTimersByTimeAsync(DEFAULT_MAX_DELAY_MS);
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(vi.getTimerCount()).toBe(0);

        // Re-enabling resumes with a fresh lookup.
        fetcher.retryNow();
        expect(fetch).toHaveBeenCalledTimes(3);
        expect(fetcher.state.paused).toBe(false);
    });

    it('remembers a retryNow that arrives while the last attempt is in flight', async () => {
        /** @type {(e: unknown) => void} */
        let reject = () => {};
        const fetch = vi.fn(() => new Promise((_, r) => { reject = r; }));
        const fetcher = createClientVersionFetcher({ fetch, onSuccess: vi.fn(), isValid: isValidClientVersions, maxAttempts: 1 });

        fetcher.request();
        fetcher.retryNow(); // user re-enables during the final attempt
        reject(new Error('down'));
        await flush();
        await vi.advanceTimersByTimeAsync(0);
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(fetcher.state.inFlight).toBe(true);
    });

    it('drops a pending retryNow when the in-flight attempt succeeds', async () => {
        /** @type {(v: unknown) => void} */
        let resolve = () => {};
        const fetch = vi.fn(() => new Promise((r) => { resolve = r; }));
        const fetcher = createClientVersionFetcher({ fetch, onSuccess: vi.fn(), isValid: isValidClientVersions });

        fetcher.request();
        fetcher.retryNow();
        resolve(VALID);
        await flush();
        await vi.advanceTimersByTimeAsync(DEFAULT_MAX_DELAY_MS);
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(fetcher.state.done).toBe(true);
    });

    it('dispose cancels a pending retry', async () => {
        const { fetcher, fetch } = setup(() => Promise.reject(new Error('down')));

        fetcher.request();
        await flush();
        fetcher.dispose();
        await vi.advanceTimersByTimeAsync(DEFAULT_MAX_DELAY_MS);
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
    });
});
