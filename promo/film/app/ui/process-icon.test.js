// @ts-check
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mInvoke = vi.fn();
vi.mock('../api.js', () => ({ invoke: (/** @type {any[]} */ ...a) => mInvoke(...a) }));

const { createProcessIcon, loadProcessIcon, peekProcessIcon, _resetProcessIconsForTest } = await import('./process-icon.js');

const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
    vi.restoreAllMocks();
});

beforeEach(() => {
    _resetProcessIconsForTest();
    mInvoke.mockReset();
    document.body.replaceChildren();
});

describe('process icons', () => {
    it('asks the backend once per path', async () => {
        mInvoke.mockResolvedValue(PNG);
        await Promise.all([loadProcessIcon('/usr/bin/a'), loadProcessIcon('/usr/bin/a')]);
        await loadProcessIcon('/usr/bin/a');
        expect(mInvoke).toHaveBeenCalledTimes(1);
    });

    it('treats anything but an image data URL as no icon', async () => {
        mInvoke.mockResolvedValue('https://example.com/x.png');
        expect(await loadProcessIcon('/usr/bin/b')).toBeNull();
        mInvoke.mockRejectedValue(new Error('boom'));
        expect(await loadProcessIcon('/usr/bin/c')).toBeNull();
    });

    it('shows the placeholder, then swaps in the real icon for every waiting slot', async () => {
        mInvoke.mockResolvedValue(PNG);
        const first = createProcessIcon('/usr/bin/d');
        const second = createProcessIcon('/usr/bin/d');
        document.body.append(first, second);
        expect(first.classList.contains('is-placeholder')).toBe(true);
        expect(first.querySelector('img')).toBeNull();
        await flush();
        await flush();
        for (const slot of [first, second]) {
            expect(slot.classList.contains('is-placeholder')).toBe(false);
            expect(slot.querySelector('img')?.getAttribute('src')).toBe(PNG);
        }
    });

    it('keeps the placeholder when there is no path or no icon', async () => {
        mInvoke.mockResolvedValue(null);
        const none = createProcessIcon('');
        const missing = createProcessIcon('/usr/bin/e');
        document.body.append(none, missing);
        await flush();
        expect(mInvoke).toHaveBeenCalledTimes(1);
        expect(none.classList.contains('is-placeholder')).toBe(true);
        expect(missing.classList.contains('is-placeholder')).toBe(true);
        expect(missing.textContent).not.toMatch(/\w/);
    });

    it('retries a failed call instead of remembering it', async () => {
        mInvoke.mockRejectedValueOnce(new Error('ipc down')).mockResolvedValueOnce(PNG);
        expect(await loadProcessIcon('/usr/bin/f')).toBeNull();
        expect(peekProcessIcon('/usr/bin/f')).toBeUndefined();
        expect(await loadProcessIcon('/usr/bin/f')).toBe(PNG);
        expect(mInvoke).toHaveBeenCalledTimes(2);
    });

    it('asks again about a path without an icon after a while', async () => {
        const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
        mInvoke.mockResolvedValueOnce(null).mockResolvedValueOnce(PNG);
        expect(await loadProcessIcon('/usr/bin/g')).toBeNull();
        expect(peekProcessIcon('/usr/bin/g')).toBeNull();
        now.mockReturnValue(1_000_000 + 5 * 60 * 1000);
        expect(peekProcessIcon('/usr/bin/g')).toBeUndefined();
        expect(await loadProcessIcon('/usr/bin/g')).toBe(PNG);
        // A found icon does not expire.
        now.mockReturnValue(1_000_000 + 60 * 60 * 1000);
        expect(peekProcessIcon('/usr/bin/g')).toBe(PNG);
    });

    it('remembers an icon the webview cannot decode as none', async () => {
        mInvoke.mockResolvedValue(PNG);
        await loadProcessIcon('/usr/bin/h');
        const slot = createProcessIcon('/usr/bin/h');
        document.body.append(slot);
        slot.querySelector('img')?.dispatchEvent(new Event('error'));
        expect(slot.classList.contains('is-placeholder')).toBe(true);
        expect(peekProcessIcon('/usr/bin/h')).toBeNull();
        // The next poll's row goes straight to the placeholder.
        expect(createProcessIcon('/usr/bin/h').querySelector('img')).toBeNull();
    });

    it('asks the backend to read an undecodable icon again once the miss expires', async () => {
        const now = vi.spyOn(Date, 'now').mockReturnValue(2_000_000);
        mInvoke.mockResolvedValue(PNG);
        await loadProcessIcon('/usr/bin/k');
        expect(mInvoke).toHaveBeenLastCalledWith('get_process_icon', { path: '/usr/bin/k' });
        const slot = createProcessIcon('/usr/bin/k');
        document.body.append(slot);
        slot.querySelector('img')?.dispatchEvent(new Event('error'));
        now.mockReturnValue(2_000_000 + 5 * 60 * 1000);
        await loadProcessIcon('/usr/bin/k');
        expect(mInvoke).toHaveBeenLastCalledWith('get_process_icon', { path: '/usr/bin/k', fresh: true });
    });
});
