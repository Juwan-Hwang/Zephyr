// @ts-nocheck
// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import './tray-mocks.js';

const { copyToClipboard } = await import('./tray.js');

describe('copyToClipboard', () => {
    let originalClipboard;
    let originalPermissions;
    let execCommandSpy;

    beforeEach(() => {
        vi.useFakeTimers();
        originalClipboard = navigator.clipboard;
        originalPermissions = navigator.permissions;
        // happy-dom has no execCommand; provide one so the fallback path
        // can be observed.
        document.execCommand = vi.fn().mockReturnValue(true);
        execCommandSpy = document.execCommand;
    });

    afterEach(() => {
        vi.useRealTimers();
        delete document.execCommand;
        Object.defineProperty(navigator, 'clipboard', {
            value: originalClipboard,
            configurable: true,
            writable: true,
        });
        Object.defineProperty(navigator, 'permissions', {
            value: originalPermissions,
            configurable: true,
            writable: true,
        });
    });

    function mockClipboard(writeTextImpl) {
        Object.defineProperty(navigator, 'clipboard', {
            value: { writeText: vi.fn(writeTextImpl) },
            configurable: true,
            writable: true,
        });
        return navigator.clipboard.writeText;
    }

    function mockPermissions(state) {
        Object.defineProperty(navigator, 'permissions', {
            value: { query: vi.fn(async () => ({ state })) },
            configurable: true,
            writable: true,
        });
        return navigator.permissions.query;
    }

    /**
     * A clipboard mock whose writes only land when `land()` is called,
     * so a test controls exactly when each write resolves.
     * @returns {{ writeText: any, pending: Array<{ text: string, land: () => void }>, contents: () => string }}
     */
    function deferredClipboard() {
        let clipboardContents = '';
        const pending = [];
        const writeText = mockClipboard((text) => new Promise((resolve) => {
            pending.push({ text, land: () => { clipboardContents = text; resolve(); } });
        }));
        return { writeText, pending, contents: () => clipboardContents };
    }

    it('uses writeText when it resolves', async () => {
        const writeText = mockClipboard(async () => {});
        await copyToClipboard('hello');
        expect(writeText).toHaveBeenCalledWith('hello');
        expect(execCommandSpy).not.toHaveBeenCalled();
        // The 5 s timeout is cleared once the write settles: if the
        // clear were dropped, the test would still pass here (teardown
        // discards pending timers), so assert it explicitly.
        expect(vi.getTimerCount()).toBe(0);
    });

    it('falls back to the textarea path when writeText rejects', async () => {
        mockClipboard(async () => { throw new Error('denied'); });
        await copyToClipboard('hello');
        expect(execCommandSpy).toHaveBeenCalledWith('copy');
        expect(vi.getTimerCount()).toBe(0);
    });

    it('falls back instead of hanging when writeText never settles', async () => {
        const writeText = mockClipboard(() => new Promise(() => {}));
        const promise = copyToClipboard('hello');
        await vi.advanceTimersByTimeAsync(5000);
        await promise;
        expect(writeText).toHaveBeenCalledWith('hello');
        expect(execCommandSpy).toHaveBeenCalledWith('copy');
    });

    it('rejects when the fallback copy command is not enabled', async () => {
        mockClipboard(async () => { throw new Error('denied'); });
        execCommandSpy.mockReturnValue(false);
        await expect(copyToClipboard('hello')).rejects.toThrow('Copy command was not enabled');
        expect(execCommandSpy).toHaveBeenCalledWith('copy');
    });

    it('does not start writeText while the permission is undecided', async () => {
        // A pending write cannot be cancelled: if it were started here
        // and landed after a newer copy, it would overwrite the newer
        // text. Skip it and go straight to the textarea fallback.
        const query = mockPermissions('prompt');
        const writeText = mockClipboard(async () => {});
        await copyToClipboard('hello');
        expect(query).toHaveBeenCalledWith({ name: 'clipboard-write' });
        expect(writeText).not.toHaveBeenCalled();
        expect(execCommandSpy).toHaveBeenCalledWith('copy');
        expect(vi.getTimerCount()).toBe(0);
    });

    it('uses writeText when the permission is granted', async () => {
        mockPermissions('granted');
        const writeText = mockClipboard(async () => {});
        await copyToClipboard('hello');
        expect(writeText).toHaveBeenCalledWith('hello');
        expect(execCommandSpy).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('uses writeText when the permission query rejects', async () => {
        // An unknown permission name (or no Permissions API) counts as
        // granted: the write attempt itself then decides.
        const query = vi.fn(async () => { throw new Error('unsupported'); });
        Object.defineProperty(navigator, 'permissions', {
            value: { query },
            configurable: true,
            writable: true,
        });
        const writeText = mockClipboard(async () => {});
        await copyToClipboard('hello');
        expect(query).toHaveBeenCalledWith({ name: 'clipboard-write' });
        expect(writeText).toHaveBeenCalledWith('hello');
        expect(execCommandSpy).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('re-asserts the newest copy when a timed-out write lands late', async () => {
        // A granted write can still hang past the 5 s timeout (an OS
        // clipboard lock, for example): the fallback runs, the queue
        // advances, a newer copy succeeds — then the stale write lands
        // and would overwrite the newer text. The repair re-writes the
        // newest text so the clipboard ends up holding it.
        const { writeText, pending, contents } = deferredClipboard();
        const first = copyToClipboard('old');
        await vi.advanceTimersByTimeAsync(5000);
        await first;
        expect(execCommandSpy).toHaveBeenCalledWith('copy');
        expect(pending).toHaveLength(1);

        const second = copyToClipboard('new');
        await vi.advanceTimersByTimeAsync(0);
        expect(pending).toHaveLength(2);
        pending[1].land();
        await second;
        expect(contents()).toBe('new');

        // The stale write lands now: without the repair the clipboard
        // would hold 'old'.
        pending[0].land();
        await Promise.resolve();
        await Promise.resolve();
        expect(writeText).toHaveBeenCalledTimes(3);
        expect(writeText).toHaveBeenNthCalledWith(3, 'new');
        pending[2].land();
        expect(contents()).toBe('new');
        expect(vi.getTimerCount()).toBe(0);
    });

    it('repairs a late write to a fallback copy', async () => {
        // The permission flips to undecided between two copies: the
        // second copy goes through the textarea fallback, which must
        // still count as the newest text — otherwise a late landing of
        // the first (timed-out) write is not repaired and the clipboard
        // keeps the older text while the UI reports the newer copy.
        const { writeText, pending, contents } = deferredClipboard();
        mockPermissions('granted');
        const first = copyToClipboard('old');
        await vi.advanceTimersByTimeAsync(5000);
        await first;
        expect(execCommandSpy).toHaveBeenCalledWith('copy');
        expect(pending).toHaveLength(1);

        mockPermissions('prompt');
        await copyToClipboard('new');
        expect(execCommandSpy).toHaveBeenCalledTimes(2);
        expect(writeText).toHaveBeenCalledTimes(1);

        pending[0].land();
        await Promise.resolve();
        await Promise.resolve();
        expect(writeText).toHaveBeenCalledTimes(2);
        expect(writeText).toHaveBeenNthCalledWith(2, 'new');
        pending[1].land();
        expect(contents()).toBe('new');
        expect(vi.getTimerCount()).toBe(0);
    });

    it('re-asserts the newest copy when a repair lands late', async () => {
        // A repair write can hang just like the original write (same OS
        // clipboard lock): if a newer copy lands in between, the repair
        // must re-assert the newest text when it finally lands, not
        // leave its own stale text on the clipboard.
        const { writeText, pending, contents } = deferredClipboard();
        mockPermissions('granted');
        const first = copyToClipboard('a');
        await vi.advanceTimersByTimeAsync(5000);
        await first;
        expect(pending).toHaveLength(1);

        const second = copyToClipboard('b');
        await vi.advanceTimersByTimeAsync(0);
        expect(pending).toHaveLength(2);
        pending[1].land();
        await second;
        expect(contents()).toBe('b');

        // A's write lands late: the repair for 'b' is issued but hangs.
        pending[0].land();
        await Promise.resolve();
        await Promise.resolve();
        expect(writeText).toHaveBeenCalledTimes(3);
        expect(writeText).toHaveBeenNthCalledWith(3, 'b');
        expect(pending).toHaveLength(3);

        const third = copyToClipboard('c');
        await vi.advanceTimersByTimeAsync(0);
        expect(pending).toHaveLength(4);
        pending[3].land();
        await third;
        expect(contents()).toBe('c');

        // The repair for 'b' finally lands: it must re-assert 'c'.
        pending[2].land();
        await Promise.resolve();
        await Promise.resolve();
        expect(writeText).toHaveBeenCalledTimes(5);
        expect(writeText).toHaveBeenNthCalledWith(5, 'c');
        pending[4].land();
        expect(contents()).toBe('c');
        expect(vi.getTimerCount()).toBe(0);
    });

    it('tries the write when the permission query never settles', async () => {
        // A hung Permissions API must not stall the copy — or the write
        // chain behind it: after 2 s the query counts as granted and
        // the write attempt itself decides.
        Object.defineProperty(navigator, 'permissions', {
            value: { query: vi.fn(() => new Promise(() => {})) },
            configurable: true,
            writable: true,
        });
        const writeText = mockClipboard(async () => {});
        const promise = copyToClipboard('hello');
        await vi.advanceTimersByTimeAsync(2000);
        await promise;
        expect(writeText).toHaveBeenCalledWith('hello');
        expect(execCommandSpy).not.toHaveBeenCalled();

        // A later copy proceeds the same way: the chain is not stalled.
        const second = copyToClipboard('again');
        await vi.advanceTimersByTimeAsync(2000);
        await second;
        expect(writeText).toHaveBeenCalledWith('again');
        expect(vi.getTimerCount()).toBe(0);
    });
});
