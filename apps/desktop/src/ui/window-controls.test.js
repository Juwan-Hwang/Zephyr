// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';

const close = vi.fn(async () => {});
const sendNotification = vi.fn(async () => true);
vi.mock('../api.js', () => ({
    getCurrentWindow: () => ({ close, label: 'main' }),
    invoke: vi.fn(async () => false),
    listen: vi.fn(async () => () => {}),
}));
vi.mock('./os-notification.js', () => ({ sendOSNotification: sendNotification }));

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
        // (The page set up in the test above reports too: every call agrees.)
        invoke.mockClear();
        appStore.set('isNetworkUpdating', true);
        await new Promise((r) => setTimeout(r, 0));
        expect(busyCalls().length).toBeGreaterThan(0);
        expect(busyCalls().every((a) => a.busy === true)).toBe(true);
        invoke.mockClear();
        appStore.set('isNetworkUpdating', false);
        await new Promise((r) => setTimeout(r, 0));
        expect(busyCalls().length).toBeGreaterThan(0);
        expect(busyCalls().every((a) => a.busy === false)).toBe(true);
    });
});
