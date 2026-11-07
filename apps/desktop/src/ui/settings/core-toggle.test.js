import { describe, it, expect, vi } from 'vitest';
import { applyCoreToggle, noteCoreToggleApplied, pauseCoreToggles, coreToggleMark, coreToggleChangedSince } from './core-toggle.js';

/** Deps with a controllable core save per call. */
function deps(saveCore, persist = vi.fn(async () => {})) {
    return { saveCore, persist, notify: vi.fn(), texts: () => ({}) };
}

describe('core settings switch', () => {
    it('tells a value read before a click (or during its save) from the one it shows', async () => {
        const toggle = { checked: false };
        const mark = coreToggleMark(toggle);
        expect(coreToggleChangedSince(toggle, mark)).toBe(false);
        /** @type {(v: boolean) => void} */
        let finish = () => {};
        toggle.checked = true;
        const d = deps(vi.fn(() => new Promise((resolve) => { finish = resolve; })));
        const saving = applyCoreToggle(toggle, 'ipv6', d);
        // Clicked after the mark: the read is older.
        expect(coreToggleChangedSince(toggle, mark)).toBe(true);
        // A mark taken while its save runs: still older than what it shows.
        const during = coreToggleMark(toggle);
        expect(coreToggleChangedSince(toggle, during)).toBe(true);
        await vi.waitFor(() => expect(d.saveCore).toHaveBeenCalled());
        finish(true);
        await saving;
        await vi.waitFor(() => expect(coreToggleChangedSince(toggle, coreToggleMark(toggle))).toBe(false));
    });

    it('applied: keeps the value in settings.json and says so', async () => {
        const toggle = { checked: true };
        const d = deps(vi.fn(async () => true));
        expect(await applyCoreToggle(toggle, 'ipv6', d)).toBe(true);
        expect(d.saveCore).toHaveBeenCalledWith({ ipv6: true });
        expect(d.persist).toHaveBeenCalledWith(true);
        expect(d.notify).toHaveBeenCalledWith('Applied', 'success');
    });

    it('a failed write to settings.json is not reported as applied', async () => {
        const toggle = { checked: true };
        const d = deps(vi.fn(async () => true), vi.fn(async () => { throw new Error('disk full'); }));
        expect(await applyCoreToggle(toggle, 'allow-lan', d)).toBe('unsaved');
        expect(d.notify).toHaveBeenCalledWith('Failed to save', 'warning');
        expect(d.notify).not.toHaveBeenCalledWith('Applied', 'success');
        // The core runs it: the switch keeps showing it.
        expect(toggle.checked).toBe(true);
    });

    it('a failed core save undoes its change', async () => {
        const toggle = { checked: true };
        const d = deps(vi.fn(async () => false));
        expect(await applyCoreToggle(toggle, 'ipv6', d)).toBe(false);
        expect(toggle.checked).toBe(false);
        expect(d.persist).not.toHaveBeenCalled();
        expect(d.notify).toHaveBeenCalledWith('Failed to save', 'error');
    });

    it('an older failed save does not flip a newer click; saves run in click order', async () => {
        const toggle = { checked: true };
        /** @type {Array<(v: any) => void>} */
        const pending = [];
        const saveCore = vi.fn(() => new Promise((resolve) => { pending.push(resolve); }));
        const d = deps(saveCore);
        const first = applyCoreToggle(toggle, 'unified-delay', d);
        toggle.checked = false;
        const second = applyCoreToggle(toggle, 'unified-delay', d);
        await vi.waitFor(() => expect(pending).toHaveLength(1));
        // Only the first is in flight; it fails after the second click.
        pending[0](false);
        expect(await first).toBe(false);
        expect(toggle.checked).toBe(false);
        await vi.waitFor(() => expect(pending).toHaveLength(2));
        pending[1](true);
        expect(await second).toBe(true);
        expect(saveCore.mock.calls.map(([patch]) => patch)).toEqual([
            { 'unified-delay': true }, { 'unified-delay': false },
        ]);
        expect(d.persist).toHaveBeenLastCalledWith(false);
        expect(toggle.checked).toBe(false);
    });

    it('on, off, on again: a failed first save does not turn off the last click', async () => {
        const toggle = { checked: true };
        /** @type {Array<(v: any) => void>} */
        const pending = [];
        const saveCore = vi.fn(() => new Promise((resolve) => { pending.push(resolve); }));
        const d = deps(saveCore);
        const first = applyCoreToggle(toggle, 'ipv6', d);
        toggle.checked = false;
        const second = applyCoreToggle(toggle, 'ipv6', d);
        toggle.checked = true;
        const third = applyCoreToggle(toggle, 'ipv6', d);
        await vi.waitFor(() => expect(pending).toHaveLength(1));
        pending[0](false);
        expect(await first).toBe(false);
        // The last click wants it on: the first one's failure leaves it on.
        expect(toggle.checked).toBe(true);
        await vi.waitFor(() => expect(pending).toHaveLength(2));
        pending[1](true);
        await second;
        await vi.waitFor(() => expect(pending).toHaveLength(3));
        pending[2](true);
        expect(await third).toBe(true);
        expect(d.persist).toHaveBeenLastCalledWith(true);
        expect(toggle.checked).toBe(true);
    });

    it('a failed last save goes back to the value the core last took', async () => {
        const toggle = { checked: true };
        const results = [true, false, false];
        const d = deps(vi.fn(async () => results.shift()));
        // off -> on (taken), on -> off (fails), off -> on (fails, last click).
        const first = applyCoreToggle(toggle, 'ipv6', d);
        toggle.checked = false;
        const second = applyCoreToggle(toggle, 'ipv6', d);
        toggle.checked = true;
        const third = applyCoreToggle(toggle, 'ipv6', d);
        expect(await first).toBe(true);
        expect(await second).toBe(false);
        expect(await third).toBe(false);
        // The core runs "on" from the first click: the switch shows it.
        expect(toggle.checked).toBe(true);
    });

    it('settles only once every switch save has finished', async () => {
        const ipv6 = { checked: true };
        const lan = { checked: true };
        /** @type {Array<() => void>} */
        const persists = [];
        const d = deps(vi.fn(async () => true));
        d.persist = vi.fn(() => new Promise((resolve) => { persists.push(() => resolve(undefined)); }));
        void applyCoreToggle(ipv6, 'ipv6', d);
        void applyCoreToggle(lan, 'allow-lan', d);
        let settled = false;
        /** @type {() => void} */
        let release = () => {};
        const waiting = pauseCoreToggles().then((r) => { release = r; settled = true; });
        await vi.waitFor(() => expect(persists).toHaveLength(2));
        persists[0]();
        await Promise.resolve();
        await Promise.resolve();
        expect(settled).toBe(false);
        persists[1]();
        await waiting;
        expect(settled).toBe(true);
        release();
        // Nothing pending: settles at once.
        (await pauseCoreToggles())();
    });

    it('holds a click made during a reset until it ends, then saves what the switch shows', async () => {
        const toggle = { checked: true };
        const d = deps(vi.fn(async () => true));
        const release = await pauseCoreToggles();
        toggle.checked = false;
        const run = applyCoreToggle(toggle, 'ipv6', d);
        await Promise.resolve();
        await Promise.resolve();
        expect(d.saveCore).not.toHaveBeenCalled();
        // The reset sets the switch after the click.
        toggle.checked = true;
        release();
        expect(await run).toBe(true);
        expect(d.saveCore).toHaveBeenCalledWith({ ipv6: true });
        expect(d.persist).toHaveBeenCalledWith(true);
        // Released: a click saves at once again.
        toggle.checked = false;
        expect(await applyCoreToggle(toggle, 'ipv6', d)).toBe(true);
        expect(d.saveCore).toHaveBeenLastCalledWith({ ipv6: false });
    });
    it('a click held during a reset that fails goes back to the value the reset applied', async () => {
        // IPv6 was on; the user turns it off during the reset, the reset
        // turns it off too, and the held save fails.
        const toggle = { checked: true };
        const d = deps(vi.fn(async () => false));
        const release = await pauseCoreToggles();
        toggle.checked = false;
        const run = applyCoreToggle(toggle, 'ipv6', d);
        // The core took the reset's ipv6: false.
        noteCoreToggleApplied(toggle, false);
        release();
        expect(await run).toBe(false);
        expect(d.saveCore).toHaveBeenCalledWith({ ipv6: false });
        // The core runs IPv6 off: the switch shows that, not the old on.
        expect(toggle.checked).toBe(false);
    });
});
