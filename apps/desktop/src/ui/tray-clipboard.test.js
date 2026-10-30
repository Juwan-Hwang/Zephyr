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
});
