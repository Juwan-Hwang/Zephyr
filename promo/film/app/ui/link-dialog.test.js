import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../api.js', () => ({ invoke: vi.fn().mockResolvedValue({}) }));
vi.mock('./notifications.js', () => ({ showNotification: vi.fn() }));

import { showLinkDialog } from './link-dialog.js';

/** @param {HTMLInputElement} el @param {string} v */
function type(el, v) {
    el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('showLinkDialog', () => {
    beforeEach(() => { vi.useFakeTimers(); document.body.replaceChildren(); });
    afterEach(() => { vi.useRealTimers(); });

    it('shows a link error in place and keeps the confirm button off', () => {
        showLinkDialog({ title: 'Add', withName: true });
        const url = /** @type {HTMLInputElement} */ (document.getElementById('link-dialog-url'));
        const btn = /** @type {HTMLButtonElement} */ (document.getElementById('link-dialog-confirm'));
        const err = /** @type {HTMLElement} */ (document.getElementById('link-dialog-url-error'));
        expect(btn.disabled).toBe(true);
        type(url, 'not a link');
        expect(err.textContent).toBe('');
        vi.advanceTimersByTime(400);
        expect(err.textContent).not.toBe('');
        expect(url.getAttribute('aria-invalid')).toBe('true');
        type(url, 'ftp://example.com/x');
        vi.advanceTimersByTime(400);
        expect(err.textContent).toMatch(/http/i);
        type(url, 'https://sub.example.com/a');
        expect(err.textContent).toBe('');
        expect(url.hasAttribute('aria-invalid')).toBe(false);
        expect(btn.disabled).toBe(false);
    });

    it('resolves with the link and the optional name', async () => {
        const p = showLinkDialog({ title: 'Add', withName: true, suggestName: () => 'auto' });
        const url = /** @type {HTMLInputElement} */ (document.getElementById('link-dialog-url'));
        const name = /** @type {HTMLInputElement} */ (document.getElementById('link-dialog-name'));
        type(url, '  https://sub.example.com/a  ');
        expect(name.placeholder).toBe('auto');
        name.value = ' My sub ';
        document.getElementById('link-dialog-confirm')?.click();
        await expect(p).resolves.toEqual({ url: 'https://sub.example.com/a', name: 'My sub' });
    });

    it('Enter with a bad link does not submit; Cancel resolves null', async () => {
        const p = showLinkDialog({ title: 'Import' });
        expect(document.getElementById('link-dialog-name')).toBeNull();
        const url = /** @type {HTMLInputElement} */ (document.getElementById('link-dialog-url'));
        type(url, 'hello');
        url.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        expect(document.getElementById('link-dialog-url-error')?.textContent).not.toBe('');
        document.getElementById('link-dialog-cancel')?.click();
        await expect(p).resolves.toBeNull();
    });
});
