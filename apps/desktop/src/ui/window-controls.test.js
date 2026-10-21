// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';

const close = vi.fn(async () => {});
const sendNotification = vi.fn(async () => true);
vi.mock('../api.js', () => ({
    getCurrentWindow: () => ({ close, label: 'main' }),
    invoke: vi.fn(async () => false),
    listen: vi.fn(async () => () => {}),
}));
vi.mock('./os-notification.js', () => ({ sendOSNotification: sendNotification }));
import { PAGE_IDLE_GRACE_MS } from './window-controls.js';

// Each test sets up its own page: a fresh store and window-controls module,
// so no store subscription from an earlier test reports for it.
beforeEach(() => { vi.resetModules(); });

describe('close button', () => {
    it('closes to the tray without a "still running" notification', async () => {
        document.body.innerHTML = '<button id="close-btn"></button>';
        localStorage.clear();
        const { initWindowControls } = await import('./window-controls.js');
        initWindowControls();
        /** @type {HTMLElement} */ (document.getElementById('close-btn')).click();
        await new Promise((r) => setTimeout(r, 0));
        expect(close).toHaveBeenCalledTimes(1);
        expect(sendNotification).not.toHaveBeenCalled();
    });
});

describe('page busy', () => {
    it('reports the network lock so a lightweight close keeps the page while it works', async () => {
        document.body.innerHTML = '';
        const api = await import('../api.js');
        const { appStore } = await import('./state.js');
        const { initWindowControls } = await import('./window-controls.js');
        const invoke = /** @type {import('vitest').Mock} */ (api.invoke);
        invoke.mockClear();
        initWindowControls();
        await new Promise((r) => setTimeout(r, 0));
        const busyCalls = () => invoke.mock.calls.filter((c) => c[0] === 'set_page_busy').map((c) => c[1]);
        // A fresh page starts idle.
        expect(busyCalls()).toEqual([{ busy: false }]);
        invoke.mockClear();
        appStore.set('isNetworkUpdating', true);
        await new Promise((r) => setTimeout(r, 0));
        expect(busyCalls().length).toBeGreaterThan(0);
        expect(busyCalls().every((a) => a.busy === true)).toBe(true);
        invoke.mockClear();
        vi.useFakeTimers();
        try {
            appStore.set('isNetworkUpdating', false);
            await vi.advanceTimersByTimeAsync(0);
            // Still marked busy through the hand-off to a queued waiter.
            expect(busyCalls()).toEqual([]);
            appStore.set('isNetworkUpdating', true);
            appStore.set('isNetworkUpdating', false);
            await vi.advanceTimersByTimeAsync(PAGE_IDLE_GRACE_MS - 1);
            expect(busyCalls().every((a) => a.busy === true)).toBe(true);
            await vi.advanceTimersByTimeAsync(1);
            expect(busyCalls().length).toBeGreaterThan(0);
            expect(busyCalls().at(-1)).toEqual({ busy: false });
        } finally {
            vi.useRealTimers();
        }
    });

    it('stays busy when a waiter takes the lock within the grace period', async () => {
        const api = await import('../api.js');
        const { appStore } = await import('./state.js');
        const { initWindowControls } = await import('./window-controls.js');
        const invoke = /** @type {import('vitest').Mock} */ (api.invoke);
        const busyCalls = () => invoke.mock.calls.filter((c) => c[0] === 'set_page_busy').map((c) => c[1]);
        initWindowControls();
        vi.useFakeTimers();
        try {
            appStore.set('isNetworkUpdating', true);
            await vi.advanceTimersByTimeAsync(0);
            invoke.mockClear();
            appStore.set('isNetworkUpdating', false);
            await vi.advanceTimersByTimeAsync(200);
            appStore.set('isNetworkUpdating', true);
            await vi.advanceTimersByTimeAsync(PAGE_IDLE_GRACE_MS * 2);
            expect(busyCalls().length).toBeGreaterThan(0);
            expect(busyCalls().some((a) => a.busy === false)).toBe(false);
            appStore.set('isNetworkUpdating', false);
            await vi.advanceTimersByTimeAsync(PAGE_IDLE_GRACE_MS);
        } finally {
            vi.useRealTimers();
        }
    });
});
