// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';

const close = vi.fn(async () => {});
const sendNotification = vi.fn(async () => true);
vi.mock('../api.js', () => ({
    getCurrentWindow: () => ({ close, label: 'main' }),
    invoke: vi.fn(async (/** @type {string} */ cmd) => (cmd === 'get_settings' ? { close_to_tray: true } : false)),
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
