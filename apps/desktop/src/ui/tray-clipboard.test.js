// @ts-nocheck
// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import './tray-mocks.js';

const { copyToClipboard, noteExternalClipboardWrite, nextClipboardSeq, withClipboardTimeout } = await import('./tray.js');

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

    /**
     * Start a copy whose write hangs past the 5 s timeout, so the
     * textarea fallback runs: returns the mock pieces with the write
     * still pending, so the test can land it late.
     * @param {string} firstText
     * @returns {Promise<{ writeText: any, pending: Array<{ text: string, land: () => void }>, contents: () => string }>}
     */
    async function firstCopyTimesOut(firstText) {
        const { writeText, pending, contents } = deferredClipboard();
        mockPermissions('granted');
        const first = copyToClipboard(firstText);
        await vi.advanceTimersByTimeAsync(5000);
        await first;
        expect(execCommandSpy).toHaveBeenCalledWith('copy');
        expect(pending).toHaveLength(1);
        return { writeText, pending, contents };
    }

    /**
     * Start two copies where the first write hangs past the 5 s timeout
     * and the second succeeds, leaving the first write still pending so
     * the test can land it late.
     * @param {string} firstText
     * @param {string} secondText
     * @returns {Promise<{ writeText: any, pending: Array<{ text: string, land: () => void }>, contents: () => string }>}
     */
    async function twoCopiesFirstTimesOut(firstText, secondText) {
        const { writeText, pending, contents } = await firstCopyTimesOut(firstText);
        const second = copyToClipboard(secondText);
        await vi.advanceTimersByTimeAsync(0);
        expect(pending).toHaveLength(2);
        pending[1].land();
        await second;
        expect(contents()).toBe(secondText);
        return { writeText, pending, contents };
    }

    /**
     * A clipboard mock whose writes only land or fail when the test
     * says so, so a test controls exactly when each write settles.
     * Unlike `deferredClipboard`, pending writes can also be failed.
     * @returns {{ writeText: any, pending: Array<{ text: string, land: () => void, fail: () => void }>, contents: () => string }}
     */
    function deferredClipboardWithFail() {
        let clipboardContents = '';
        const pending = [];
        const writeText = mockClipboard((text) => new Promise((resolve, reject) => {
            pending.push({
                text,
                land: () => { clipboardContents = text; resolve(); },
                fail: () => reject(new Error('denied')),
            });
        }));
        return { writeText, pending, contents: () => clipboardContents };
    }

    /**
     * Set up a clipboard whose writes only land (or fail) when the test
     * says so, and land `firstText` as the first copy, so the test
     * starts with a known landing on record.
     * @param {string} firstText
     * @returns {Promise<{ writeText: any, pending: Array<{ text: string, land: () => void, fail: () => void }>, contents: () => string }>}
     */
    async function landFirstCopy(firstText) {
        const { writeText, pending, contents } = deferredClipboardWithFail();
        const first = copyToClipboard(firstText);
        await vi.advanceTimersByTimeAsync(0);
        pending[0].land();
        await expect(first).resolves.toBe(true);
        expect(contents()).toBe(firstText);
        return { writeText, pending, contents };
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

    it('attempts the write without consulting the permission state', async () => {
        // No permission preflight: the write itself decides — a denied
        // permission rejects at once, an undecided one may sit on the
        // prompt and land late (the repair covers it). Awaiting a
        // permission query first could only delay the write past the
        // click's transient activation.
        const query = mockPermissions('prompt');
        const writeText = mockClipboard(async () => {});
        await copyToClipboard('hello');
        expect(query).not.toHaveBeenCalled();
        expect(writeText).toHaveBeenCalledWith('hello');
        expect(execCommandSpy).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('does not wait on a permission query that never settles', async () => {
        // A hung Permissions API must not stall the copy: the write
        // starts at once, with no 2 s preflight wait.
        const query = vi.fn(() => new Promise(() => {}));
        Object.defineProperty(navigator, 'permissions', {
            value: { query },
            configurable: true,
            writable: true,
        });
        const writeText = mockClipboard(async () => {});
        const promise = copyToClipboard('hello');
        await vi.advanceTimersByTimeAsync(0);
        expect(query).not.toHaveBeenCalled();
        expect(writeText).toHaveBeenCalledWith('hello');
        await promise;
        expect(execCommandSpy).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('re-asserts the newest copy when a timed-out write lands late', async () => {
        // A granted write can still hang past the 5 s timeout (an OS
        // clipboard lock, for example): the fallback runs, the queue
        // advances, a newer copy succeeds — then the stale write lands
        // and would overwrite the newer text. The repair re-writes the
        // newest text so the clipboard ends up holding it.
        const { writeText, pending, contents } = await twoCopiesFirstTimesOut('old', 'new');

        // The stale write lands now: without the repair the clipboard
        // would hold 'old'.
        await landStaleWriteAndExpectNewRepair(writeText, pending, contents);
    });

    it('re-asserts the newest copy when a write lands while an external copy is pending', async () => {
        // A write that resolves before its timeout can still land stale
        // text: an external copy (fullscreen editor, console host) may
        // finish while the write is pending, and resolving then
        // overwrites it. The repair must fire even though the write
        // never timed out.
        const { writeText, pending, contents } = deferredClipboard();
        const promise = copyToClipboard('old');
        await vi.advanceTimersByTimeAsync(0);
        expect(pending).toHaveLength(1);
        noteExternalClipboardWrite('new', nextClipboardSeq());
        pending[0].land();
        await promise;
        expect(writeText).toHaveBeenCalledTimes(2);
        expect(writeText).toHaveBeenNthCalledWith(2, 'new');
        pending[1].land();
        expect(contents()).toBe('new');
        // Let the repair's timeout-clear run: it fires on the microtask after its write settles.
        await vi.advanceTimersByTimeAsync(0);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('repairs a late write to a fallback copy', async () => {
        // The permission flips to undecided between two copies: the
        // second copy still attempts the native write, which hangs
        // past the 5 s timeout like the first one — the textarea
        // fallback then runs and records the second text as the
        // newest, so a late landing of the first write is repaired
        // with it.
        const { writeText, pending, contents } = await firstCopyTimesOut('old');

        mockPermissions('prompt');
        const second = copyToClipboard('new');
        await vi.advanceTimersByTimeAsync(5000);
        await second;
        expect(execCommandSpy).toHaveBeenCalledTimes(2);
        expect(writeText).toHaveBeenCalledTimes(2);
        expect(pending).toHaveLength(2);

        await landStaleWriteAndExpectNewRepair(writeText, pending, contents);
    });

    it('does not re-assert a failed copy when an earlier write lands late', async () => {
        // A failed copy must not become the text a later repair
        // re-asserts: B's write and its fallback both fail, so the
        // newest text stays A. When A's timed-out write lands late it
        // lands the newest text itself — no repair is issued, and
        // certainly not one re-asserting the B the UI already
        // reported as failed.
        const { writeText: oldWriteText, pending, contents } = await firstCopyTimesOut('A');

        const newWriteText = mockClipboard(async () => { throw new Error('denied'); });
        execCommandSpy.mockReturnValue(false);
        await expect(copyToClipboard('B')).rejects.toThrow('Copy command was not enabled');

        pending[0].land();
        await Promise.resolve();
        await Promise.resolve();
        expect(oldWriteText).toHaveBeenCalledTimes(1);
        expect(newWriteText).toHaveBeenCalledTimes(1);
        expect(contents()).toBe('A');
        expect(vi.getTimerCount()).toBe(0);
    });

    it('repairs the clipboard when a stale external write lands after a newer tray copy', async () => {
        // A direct write requested before a tray copy but resolving
        // after it lands its older text on the clipboard: the note's
        // older sequence must not become the record — but the clipboard
        // must be repaired to the newer tray text, not left holding
        // the older one.
        const staleSeq = nextClipboardSeq();
        const { writeText, pending, contents } = await firstCopyTimesOut('A');

        // The stale external write lands on the clipboard.
        writeText('OLD');
        expect(pending).toHaveLength(2);
        pending[1].land();
        expect(contents()).toBe('OLD');

        noteExternalClipboardWrite('OLD', staleSeq);
        await Promise.resolve();
        await Promise.resolve();
        // The repair re-asserts the newer tray text.
        expect(writeText).toHaveBeenCalledTimes(3);
        expect(writeText).toHaveBeenNthCalledWith(3, 'A');
        expect(pending).toHaveLength(3);
        pending[2].land();
        expect(contents()).toBe('A');

        // A's timed-out write lands late: the record still says A, so
        // no further repair is issued.
        pending[0].land();
        await Promise.resolve();
        await Promise.resolve();
        expect(writeText).toHaveBeenCalledTimes(3);
        expect(contents()).toBe('A');
        expect(vi.getTimerCount()).toBe(0);
    });

    it('does not roll back the record for a newer copy of the same text', async () => {
        // A newer external copy of the same text must survive this
        // copy's failure: the copy reports superseded (its fallback is
        // skipped — the text already landed via the external write),
        // so the record is never touched, let alone rolled back.
        const { writeText: oldWriteText, pending } = await firstCopyTimesOut('OLD');

        const newWriteText = mockClipboard(async () => { throw new Error('denied'); });
        execCommandSpy.mockReturnValue(false);
        const execCallsBefore = execCommandSpy.mock.calls.length;
        const xPromise = copyToClipboard('X');
        const extSeq = nextClipboardSeq();
        noteExternalClipboardWrite('X', extSeq);
        await expect(xPromise).resolves.toBe(false);
        // The fallback never ran for X: the call count is unchanged
        // since the first copy's fallback above.
        expect(execCommandSpy.mock.calls.length).toBe(execCallsBefore);

        // The older write lands late: the record still says X, so the
        // repair re-asserts X instead of leaving OLD on the clipboard.
        pending[0].land();
        await Promise.resolve();
        await Promise.resolve();
        expect(oldWriteText).toHaveBeenCalledTimes(1);
        expect(newWriteText).toHaveBeenCalledTimes(2);
        expect(newWriteText).toHaveBeenNthCalledWith(2, 'X');
        // Let the repair's timeout-clear run: it fires on the microtask after its write settles.
        await vi.advanceTimersByTimeAsync(0);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('re-asserts the newest copy when a repair lands late', async () => {
        // A repair write can hang just like the original write (same OS
        // clipboard lock): if a newer copy lands in between, the repair
        // must re-assert the newest text when it finally lands, not
        // leave its own stale text on the clipboard.
        const { writeText, pending, contents } = await twoCopiesFirstTimesOut('a', 'b');

        // A's write lands late: the repair for 'b' is issued but hangs.
        pending[0].land();
        await Promise.resolve();
        await Promise.resolve();
        expect(writeText).toHaveBeenCalledTimes(3);
        expect(writeText).toHaveBeenNthCalledWith(3, 'b');
        expect(pending).toHaveLength(3);

        await landThirdCopyAndExpectRepair(writeText, pending, contents);
    });

    /**
     * Land 'b' over a still-pending 'a', then let 'a' land late, so a
     * repair for 'b' is issued. Returns the mock pieces with the repair
     * write (pending[2]) still unsettled, so the test can fail it or
     * let it hang.
     */
    async function triggerRepairForNewest() {
        const { writeText, pending, contents } = deferredClipboardWithFail();
        const first = copyToClipboard('a');
        await vi.advanceTimersByTimeAsync(0);
        const second = copyToClipboard('b');
        await vi.advanceTimersByTimeAsync(0);
        pending[1].land();
        await second;
        expect(contents()).toBe('b');

        // A's write lands late: the repair for 'b' is issued.
        pending[0].land();
        await Promise.resolve();
        await Promise.resolve();
        expect(writeText).toHaveBeenCalledTimes(3);
        expect(writeText).toHaveBeenNthCalledWith(3, 'b');
        expect(pending).toHaveLength(3);
        return { writeText, pending, contents, first };
    }

    /**
     * Land a stale write (pending[0]) and expect the repair it
     * triggers to re-assert 'new': the repair write is pending[2].
     */
    async function landStaleWriteAndExpectNewRepair(writeText, pending, contents) {
        pending[0].land();
        await Promise.resolve();
        await Promise.resolve();
        expect(writeText).toHaveBeenCalledTimes(3);
        expect(writeText).toHaveBeenNthCalledWith(3, 'new');
        pending[2].land();
        expect(contents()).toBe('new');
        // Let the repair's timeout-clear run: it fires on the microtask after its write settles.
        await vi.advanceTimersByTimeAsync(0);
        expect(vi.getTimerCount()).toBe(0);
    }

    /**
     * Land a third copy 'c' over the repair's target, then land the
     * repair write (pending[2]) and expect it to re-assert 'c'.
     */
    async function landThirdCopyAndExpectRepair(writeText, pending, contents) {
        const third = copyToClipboard('c');
        await vi.advanceTimersByTimeAsync(0);
        expect(pending).toHaveLength(4);
        pending[3].land();
        await third;
        expect(contents()).toBe('c');

        // The repair write finally lands: it must re-assert 'c'.
        pending[2].land();
        await Promise.resolve();
        await Promise.resolve();
        expect(writeText).toHaveBeenCalledTimes(5);
        expect(writeText).toHaveBeenNthCalledWith(5, 'c');
        pending[4].land();
        expect(contents()).toBe('c');
        // Let the repair's timeout-clear run: it fires on the microtask after its write settles.
        await vi.advanceTimersByTimeAsync(0);
        expect(vi.getTimerCount()).toBe(0);
    }

    it('falls back to the textarea path when a repair write rejects', async () => {
        // A repair write can be denied just like the original write:
        // if it rejects, the textarea fallback must run — swallowing
        // the rejection would leave the stale text on the clipboard
        // while the tracker claims the newest copy landed.
        const { pending, first } = await triggerRepairForNewest();

        const execCallsBefore = execCommandSpy.mock.calls.length;
        pending[2].fail();
        await Promise.resolve();
        await Promise.resolve();
        expect(execCommandSpy).toHaveBeenCalledTimes(execCallsBefore + 1);
        expect(execCommandSpy).toHaveBeenLastCalledWith('copy');
        expect(vi.getTimerCount()).toBe(0);
        await first;
    });

    it('falls back to the textarea path when a repair write hangs', async () => {
        // A repair write can hang just like the original write (same OS
        // clipboard lock): after 5 s the timeout must fire and the
        // textarea fallback must run, instead of leaving the stale
        // text on the clipboard indefinitely.
        const { pending, first } = await triggerRepairForNewest();
        expect(vi.getTimerCount()).toBe(1);

        const execCallsBefore = execCommandSpy.mock.calls.length;
        await vi.advanceTimersByTimeAsync(5000);
        expect(execCommandSpy).toHaveBeenCalledTimes(execCallsBefore + 1);
        expect(execCommandSpy).toHaveBeenLastCalledWith('copy');
        expect(vi.getTimerCount()).toBe(0);
        await first;
    });

    it('does not let a repair claim a newer pending copy of the same text', async () => {
        // X lands; a stale W write is still pending; Y reserves a
        // sequence; another X copy starts; the stale W write lands
        // late, which issues a repair for X. The repair must carry
        // the landed X's sequence, not the pending X copy's: Y lands,
        // then the repair lands, and the repair must re-assert Y —
        // and when the pending X copy fails, the record must fall
        // back to Y, not keep the failed X claim.
        const { writeText, pending, contents } = deferredClipboardWithFail();
        const stale = copyToClipboard('W');
        await vi.advanceTimersByTimeAsync(0);
        // X lands via an external write.
        writeText('X');
        pending[1].land();
        const xSeq = nextClipboardSeq();
        noteExternalClipboardWrite('X', xSeq);
        expect(contents()).toBe('X');

        // Y reserves a sequence; another X copy starts.
        const ySeq = nextClipboardSeq();
        const xPending = copyToClipboard('X');
        await vi.advanceTimersByTimeAsync(0);
        expect(pending).toHaveLength(3);

        // The stale W write lands late: the repair for X is issued.
        pending[0].land();
        await Promise.resolve();
        await Promise.resolve();
        expect(writeText).toHaveBeenCalledTimes(4);
        expect(writeText).toHaveBeenNthCalledWith(4, 'X');
        expect(pending).toHaveLength(4);

        // Y lands.
        writeText('Y');
        pending[4].land();
        noteExternalClipboardWrite('Y', ySeq);
        expect(contents()).toBe('Y');

        // The repair lands: it must re-assert Y, not claim X.
        pending[3].land();
        await Promise.resolve();
        await Promise.resolve();
        expect(writeText).toHaveBeenCalledTimes(6);
        expect(writeText).toHaveBeenNthCalledWith(6, 'Y');
        pending[5].land();
        expect(contents()).toBe('Y');

        // The pending X copy fails both paths: the record must fall
        // back to Y, and nothing re-asserts the failed X.
        execCommandSpy.mockReturnValue(false);
        const xRejection = expect(xPending).rejects.toThrow('Copy command was not enabled');
        pending[2].fail();
        await xRejection;
        expect(writeText).toHaveBeenCalledTimes(6);
        expect(contents()).toBe('Y');
        await expect(stale).resolves.toBe(false);
        // Let the repairs' timeout-clears run: they fire on the
        // microtask after their writes settle.
        await vi.advanceTimersByTimeAsync(0);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('re-asserts the newest copy when a repair write lands after its timeout', async () => {
        // A repair write hangs past its 5 s timeout, so the textarea
        // fallback lands its text; a newer copy lands after that.
        // When the hung repair write finally lands, it must not
        // leave its stale text on the clipboard — the repair
        // observes the late landing and re-asserts the newer text.
        const { writeText, pending, contents, first } = await triggerRepairForNewest();
        expect(vi.getTimerCount()).toBe(1);

        const execCallsBefore = execCommandSpy.mock.calls.length;
        await vi.advanceTimersByTimeAsync(5000);
        expect(execCommandSpy).toHaveBeenCalledTimes(execCallsBefore + 1);
        expect(execCommandSpy).toHaveBeenLastCalledWith('copy');
        expect(vi.getTimerCount()).toBe(0);
        await expect(first).resolves.toBe(false);

        // A newer copy lands.
        await landThirdCopyAndExpectRepair(writeText, pending, contents);
    });

    it('skips the fallback when the timeout fires after a newer copy landed, and reports superseded', async () => {
        // The first copy's native write hangs; a newer copy succeeds
        // while it is pending; then the first copy's timeout fires.
        // The textarea fallback is skipped — writing the older text
        // now would only overwrite the newer one and need a repair
        // that may itself fail. The first copy still reports
        // superseded, so its caller does not show "Copied" for text
        // that is no longer on the clipboard.
        const { writeText, pending, contents } = deferredClipboard();
        const first = copyToClipboard('old');
        await vi.advanceTimersByTimeAsync(0);
        expect(pending).toHaveLength(1);
        const second = copyToClipboard('new');
        await vi.advanceTimersByTimeAsync(0);
        expect(pending).toHaveLength(2);
        pending[1].land();
        await expect(second).resolves.toBe(true);
        expect(contents()).toBe('new');

        await vi.advanceTimersByTimeAsync(5000);
        await expect(first).resolves.toBe(false);
        expect(execCommandSpy).not.toHaveBeenCalled();
        expect(writeText).toHaveBeenCalledTimes(2);
        expect(contents()).toBe('new');
        expect(vi.getTimerCount()).toBe(0);
    });

    it('rolls a failed copy back to a newer external copy, not the pre-call snapshot', async () => {
        // An external copy is requested first, a tray copy second; the
        // external write lands while the tray copy is still pending,
        // then the tray copy fails both paths. The record must end up
        // pointing at the external text that actually landed — not at
        // whatever was newest before the tray copy started.
        const { writeText, pending, contents } = deferredClipboardWithFail();
        const staleSeq = nextClipboardSeq();
        const extSeq = nextClipboardSeq();
        const trayCopy = copyToClipboard('T');
        await vi.advanceTimersByTimeAsync(0);
        expect(pending).toHaveLength(1);

        // The external write lands on the clipboard while the tray
        // copy is still pending.
        writeText('E');
        expect(pending).toHaveLength(2);
        pending[1].land();
        expect(contents()).toBe('E');
        noteExternalClipboardWrite('E', extSeq);

        // The tray copy fails both paths.
        execCommandSpy.mockReturnValue(false);
        pending[0].fail();
        await expect(trayCopy).rejects.toThrow('Copy command was not enabled');

        // A still older external write lands now: the record must say
        // E, so the repair re-asserts E — not the pre-call snapshot.
        writeText('OLD');
        expect(pending).toHaveLength(3);
        pending[2].land();
        expect(contents()).toBe('OLD');
        noteExternalClipboardWrite('OLD', staleSeq);
        await Promise.resolve();
        await Promise.resolve();
        expect(writeText).toHaveBeenCalledTimes(4);
        expect(writeText).toHaveBeenNthCalledWith(4, 'E');
        pending[3].land();
        expect(contents()).toBe('E');
        // Let the repair's timeout-clear run: it fires on the microtask after its write settles.
        await vi.advanceTimersByTimeAsync(0);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('re-asserts the newest landed copy when an older external write lands over it', async () => {
        // A lands; a tray copy is requested after it; an external write
        // requested before A lands late, while the tray copy is still
        // pending. The clipboard must end up holding A (the newest
        // landing), not the older external text.
        const { writeText, pending, contents } = deferredClipboard();
        const oldSeq = nextClipboardSeq();
        const first = copyToClipboard('A');
        await vi.advanceTimersByTimeAsync(0);
        expect(pending).toHaveLength(1);
        pending[0].land();
        await expect(first).resolves.toBe(true);
        expect(contents()).toBe('A');

        const second = copyToClipboard('T');
        await vi.advanceTimersByTimeAsync(0);
        expect(pending).toHaveLength(2);

        // The older external write lands now, overwriting A.
        writeText('OLD');
        expect(pending).toHaveLength(3);
        pending[2].land();
        expect(contents()).toBe('OLD');
        noteExternalClipboardWrite('OLD', oldSeq);
        await Promise.resolve();
        await Promise.resolve();
        expect(writeText).toHaveBeenCalledTimes(4);
        expect(writeText).toHaveBeenNthCalledWith(4, 'A');
        pending[3].land();
        expect(contents()).toBe('A');

        // The repair for 'A' landed while the tray copy was still the
        // newest claim — but that claim has not landed itself, so the
        // repair must NOT chain to it: T's own write lands it instead.
        await Promise.resolve();
        await Promise.resolve();
        expect(writeText).toHaveBeenCalledTimes(4);
        pending[1].land();
        await expect(second).resolves.toBe(true);
        expect(contents()).toBe('T');
        expect(vi.getTimerCount()).toBe(0);
    });

    it('does not repair towards a copy that then fails', async () => {
        // A repair in flight must only re-assert a text that actually
        // landed: A lands, then T is requested but still pending when
        // A's timed-out write lands late. The repair for A must not
        // chain to T — T's write and fallback both fail afterwards, so
        // chaining would leave the clipboard holding a text the UI
        // already reported as failed.
        const { writeText, pending, contents } = deferredClipboardWithFail();
        const first = copyToClipboard('A');
        await vi.advanceTimersByTimeAsync(0);
        expect(pending).toHaveLength(1);
        // A times out and its fallback lands it (in the tracker; the
        // mock clipboard only changes when a writeText promise lands).
        await vi.advanceTimersByTimeAsync(5000);
        await expect(first).resolves.toBe(true);

        // T is requested but its write hangs; A's timed-out write lands
        // late while T is still pending.
        const second = copyToClipboard('T');
        await vi.advanceTimersByTimeAsync(0);
        expect(pending).toHaveLength(2);
        pending[0].land();
        expect(contents()).toBe('A');
        await Promise.resolve();
        await Promise.resolve();
        // No repair is issued: the newest landing is already A.
        expect(writeText).toHaveBeenCalledTimes(2);

        // T fails both paths: its write rejects and the fallback is not
        // enabled. The clipboard must still hold A, not the failed T.
        execCommandSpy.mockReturnValue(false);
        pending[1].fail();
        await expect(second).rejects.toThrow('Copy command was not enabled');
        expect(contents()).toBe('A');
        expect(writeText).toHaveBeenCalledTimes(2);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('reports whether a noted external write is still the newest', async () => {
        // A direct write that lands while it is still the newest reports
        // true, so its caller may show "Copied"; a stale one that was
        // repaired away reports false, so its caller stays silent; a
        // write of the text already on the clipboard reports true.
        const writeText = mockClipboard(async () => {});
        const newestSeq = nextClipboardSeq();
        expect(noteExternalClipboardWrite('N', newestSeq)).toBe(true);

        const staleSeq = nextClipboardSeq();
        await copyToClipboard('M');
        expect(noteExternalClipboardWrite('OLD', staleSeq)).toBe(false);
        // The stale note repaired the clipboard back to M.
        expect(writeText).toHaveBeenCalledTimes(2);
        expect(writeText).toHaveBeenNthCalledWith(2, 'M');

        expect(noteExternalClipboardWrite('M', staleSeq)).toBe(true);
        expect(writeText).toHaveBeenCalledTimes(2);
        // Let the repair's timeout-clear run: it fires on the microtask after its write settles.
        await vi.advanceTimersByTimeAsync(0);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('records a stale write as the newest landing while the newer claim is pending', async () => {
        // The newer claim has not landed yet, so a stale external write
        // that lands is the newest thing actually on the clipboard: it
        // is recorded as the landing (not repaired away) and reports true.
        const { writeText, pending, contents } = deferredClipboard();
        const directSeq = nextClipboardSeq();
        const pendingCopy = copyToClipboard('P');
        await vi.advanceTimersByTimeAsync(0);
        expect(pending).toHaveLength(1);
        expect(noteExternalClipboardWrite('D', directSeq)).toBe(true);
        expect(writeText).toHaveBeenCalledTimes(1);

        // The pending copy lands afterwards and becomes newest.
        pending[0].land();
        await expect(pendingCopy).resolves.toBe(true);
        expect(contents()).toBe('P');
        expect(vi.getTimerCount()).toBe(0);
    });

    it('bails out when passed an older click-time sequence', async () => {
        // The settings copy button passes the sequence it took at click
        // time: if a newer copy claimed the record while that click was
        // awaiting settings and config, this copy must not write at all —
        // the newer copy's text stays on the clipboard and this caller
        // stays silent.
        const writeText = mockClipboard(async () => {});
        const olderSeq = nextClipboardSeq();
        await copyToClipboard('N');
        expect(writeText).toHaveBeenCalledTimes(1);
        await expect(copyToClipboard('OLD', olderSeq)).resolves.toBe(false);
        expect(writeText).toHaveBeenCalledTimes(1);
        expect(writeText).not.toHaveBeenCalledWith('OLD');
        expect(vi.getTimerCount()).toBe(0);

        // A passed sequence that is still the newest writes normally.
        await expect(copyToClipboard('X', nextClipboardSeq())).resolves.toBe(true);
        expect(writeText).toHaveBeenCalledWith('X');
        expect(vi.getTimerCount()).toBe(0);
    });

    it('keeps a stale native write that is still the newest landing', async () => {
        // Z lands; A is requested, then X claims the record while A is
        // still pending. A's write lands late: it is newer than the last
        // recorded landing, so it is the newest text actually on the
        // clipboard — the repair must not revert to Z, and if X then
        // fails, the clipboard must still hold A.
        const { writeText, pending, contents } = await landFirstCopy('Z');

        const second = copyToClipboard('A');
        await vi.advanceTimersByTimeAsync(0);
        const third = copyToClipboard('X');
        await vi.advanceTimersByTimeAsync(0);
        expect(pending).toHaveLength(3);

        // A's write lands late: no repair is issued, the clipboard
        // holds A.
        pending[1].land();
        await Promise.resolve();
        await Promise.resolve();
        expect(writeText).toHaveBeenCalledTimes(3);
        expect(contents()).toBe('A');
        await expect(second).resolves.toBe(false);

        // X fails both paths: the clipboard must still hold A, the last
        // text that actually landed.
        execCommandSpy.mockReturnValue(false);
        pending[2].fail();
        await expect(third).rejects.toThrow('Copy command was not enabled');
        expect(contents()).toBe('A');
        expect(writeText).toHaveBeenCalledTimes(3);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('keeps a stale fallback write that is still the newest landing', async () => {
        // Z lands; A is requested and its native write rejects, then X
        // claims the record while A's fallback is pending. The fallback
        // lands A: it is newer than the last recorded landing, so no
        // repair reverts to Z.
        const writeText = mockClipboard((text) => {
            if (text === 'Z') return Promise.resolve();
            if (text === 'A') return Promise.reject(new Error('denied'));
            return new Promise(() => {});
        });
        const first = copyToClipboard('Z');
        await vi.advanceTimersByTimeAsync(0);
        await expect(first).resolves.toBe(true);

        const second = copyToClipboard('A');
        const third = copyToClipboard('X');
        await vi.advanceTimersByTimeAsync(0);
        // A's write rejected, so its fallback ran and returned superseded
        // without repairing back to Z.
        await expect(second).resolves.toBe(false);
        expect(writeText).toHaveBeenCalledTimes(3);

        // X's write still hangs: its timeout falls back and lands X.
        await vi.advanceTimersByTimeAsync(5000);
        await expect(third).resolves.toBe(true);
        expect(writeText).toHaveBeenCalledTimes(3);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('records a same-text external write as the newest landing', async () => {
        // Z lands; a tray copy of T is requested, and an older external
        // write of the same text lands while it is pending. The landing
        // must be recorded: if the tray copy then fails, the rollback
        // keeps T — the text actually on the clipboard — instead of Z.
        const staleSeq = nextClipboardSeq();
        const { writeText, pending, contents } = await landFirstCopy('Z');

        const extSeq = nextClipboardSeq();
        const second = copyToClipboard('T');
        await vi.advanceTimersByTimeAsync(0);
        expect(pending).toHaveLength(2);

        // The older external write of T lands on the clipboard.
        writeText('T');
        expect(pending).toHaveLength(3);
        pending[2].land();
        expect(contents()).toBe('T');
        expect(noteExternalClipboardWrite('T', extSeq)).toBe(true);

        // The tray copy fails both paths: the clipboard still holds T.
        execCommandSpy.mockReturnValue(false);
        pending[1].fail();
        await expect(second).rejects.toThrow('Copy command was not enabled');
        expect(contents()).toBe('T');

        // A still older write lands now: the repair re-asserts T, not Z.
        writeText('OLD');
        expect(pending).toHaveLength(4);
        pending[3].land();
        expect(contents()).toBe('OLD');
        noteExternalClipboardWrite('OLD', staleSeq);
        await Promise.resolve();
        await Promise.resolve();
        expect(writeText).toHaveBeenCalledTimes(5);
        expect(writeText).toHaveBeenNthCalledWith(5, 'T');
        pending[4].land();
        expect(contents()).toBe('T');
        // Let the repair's timeout-clear run: it fires on the microtask after its write settles.
        await vi.advanceTimersByTimeAsync(0);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('a stale repair does not claim a newer pending copy of the same text', async () => {
        // X lands; a stale write starts an X repair; Y lands; another X
        // copy starts but remains pending; then the old repair lands.
        // The repair must not claim the pending copy's sequence as its
        // own landing: when that copy then fails, the rollback must
        // restore Y, the newest successful copy — not keep X.
        const oldSeq = nextClipboardSeq();
        const { writeText, pending, contents } = await landFirstCopy('X');

        // A stale external write triggers a repair of X.
        expect(noteExternalClipboardWrite('OLD', oldSeq)).toBe(false);
        await vi.advanceTimersByTimeAsync(0);
        expect(pending).toHaveLength(2);

        const yCopy = copyToClipboard('Y');
        await vi.advanceTimersByTimeAsync(0);
        pending[2].land();
        await expect(yCopy).resolves.toBe(true);
        expect(contents()).toBe('Y');

        const xCopy = copyToClipboard('X');
        await vi.advanceTimersByTimeAsync(0);
        expect(pending).toHaveLength(4);

        // The old X repair lands now — after Y landed and while the
        // new X copy is pending.
        pending[1].land();
        await vi.advanceTimersByTimeAsync(0);
        // The repair re-asserts Y instead of claiming the pending
        // copy's sequence.
        expect(pending).toHaveLength(5);
        expect(writeText).toHaveBeenNthCalledWith(5, 'Y');
        pending[4].land();
        await vi.advanceTimersByTimeAsync(0);
        expect(contents()).toBe('Y');

        // The pending X copy fails both paths: the clipboard still
        // holds Y.
        execCommandSpy.mockReturnValue(false);
        pending[3].fail();
        await expect(xCopy).rejects.toThrow('Copy command was not enabled');
        expect(contents()).toBe('Y');
        expect(vi.getTimerCount()).toBe(0);
    });

    it('a late native write restores the claim its rollback dropped', async () => {
        // Z lands; an external B sequence is reserved; a newer A copy
        // times out and its fallback fails, so the rollback restores
        // Z's claim; when A's native write then lands late, the claim
        // must come back to A — otherwise B (older than A, but newer
        // than Z) would later be accepted as the newest landing and
        // replace A without repair.
        const { pending, contents } = await landFirstCopy('Z');
        const bSeq = nextClipboardSeq();
        execCommandSpy.mockReturnValue(false);
        const aCopy = copyToClipboard('A');
        // Attach the rejection handler before the timeout fires, so
        // the rejection is handled when it happens during the advance.
        const aRejection = expect(aCopy).rejects.toThrow('Copy command was not enabled');
        await vi.advanceTimersByTimeAsync(5000);
        await aRejection;
        expect(contents()).toBe('Z');

        // A's native write lands late, after the rollback.
        pending[1].land();
        await vi.advanceTimersByTimeAsync(0);
        expect(contents()).toBe('A');

        // B was reserved before A but lands after it: A is newer, so B
        // is stale and must be repaired away, not accepted.
        expect(noteExternalClipboardWrite('B', bSeq)).toBe(false);
        await vi.advanceTimersByTimeAsync(0);
        expect(pending).toHaveLength(3);
        pending[2].land();
        await vi.advanceTimersByTimeAsync(0);
        expect(contents()).toBe('A');
        expect(vi.getTimerCount()).toBe(0);
    });

    it('does not run the fallback over a newer landing', async () => {
        // An older copy's write is still pending when a newer copy
        // lands; when the older write then fails, the textarea
        // fallback must not copy the stale text over the newer
        // landing — the repair it would need may itself fail and
        // leave the stale text on the clipboard.
        const { pending, contents } = await landFirstCopy('Z');

        const stale = copyToClipboard('OLD');
        await vi.advanceTimersByTimeAsync(0);
        const newer = copyToClipboard('NEW');
        await vi.advanceTimersByTimeAsync(0);
        pending[2].land();
        await expect(newer).resolves.toBe(true);
        expect(contents()).toBe('NEW');

        pending[1].fail();
        await expect(stale).resolves.toBe(false);
        expect(execCommandSpy).not.toHaveBeenCalled();
        expect(contents()).toBe('NEW');
        expect(vi.getTimerCount()).toBe(0);
    });

    it('does not let a failed claim block an older reserved write', async () => {
        // Z lands. Two overlapping copies A and B both fail, A first:
        // B's rollback must not resurrect A's failed claim — the
        // record falls back to Z, so an older reserved copy C is
        // still attempted instead of being skipped.
        const { pending, contents } = await landFirstCopy('Z');
        const cSeq = nextClipboardSeq();
        execCommandSpy.mockReturnValue(false);

        const aCopy = copyToClipboard('A');
        await vi.advanceTimersByTimeAsync(0);
        const bCopy = copyToClipboard('B');
        await vi.advanceTimersByTimeAsync(0);
        pending[1].fail();
        await expect(aCopy).rejects.toThrow('Copy command was not enabled');
        pending[2].fail();
        await expect(bCopy).rejects.toThrow('Copy command was not enabled');

        const cCopy = copyToClipboard('C', cSeq);
        await vi.advanceTimersByTimeAsync(0);
        expect(pending).toHaveLength(4);
        pending[3].land();
        await expect(cCopy).resolves.toBe(true);
        expect(contents()).toBe('C');
        expect(vi.getTimerCount()).toBe(0);
    });

    describe('withClipboardTimeout', () => {
        it('lets a fast write through and clears its timer', async () => {
            await expect(withClipboardTimeout(Promise.resolve())).resolves.toBeUndefined();
            expect(vi.getTimerCount()).toBe(0);
        });

        it('rejects a hung write after 5 s', async () => {
            const raced = withClipboardTimeout(new Promise(() => {}));
            const settled = raced.then(
                () => 'resolved',
                (err) => err.message,
            );
            await vi.advanceTimersByTimeAsync(5000);
            await expect(settled).resolves.toBe('Clipboard write timed out');
            expect(vi.getTimerCount()).toBe(0);
        });

        it('passes a rejection that arrives before the timeout through', async () => {
            let rejectWrite;
            const write = new Promise((_, reject) => {
                rejectWrite = reject;
            });
            const raced = withClipboardTimeout(write);
            const settled = raced.then(
                () => 'resolved',
                (err) => err.message,
            );
            await vi.advanceTimersByTimeAsync(1000);
            rejectWrite(new Error('denied'));
            await expect(settled).resolves.toBe('denied');
            expect(vi.getTimerCount()).toBe(0);
        });
    });

});
