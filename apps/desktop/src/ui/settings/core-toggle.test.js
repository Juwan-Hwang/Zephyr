import { describe, it, expect, vi } from 'vitest';
import { applyCoreToggle, noteCoreToggleApplied, noteCoreTogglePersisted, coreToggleApplied, pauseCoreToggles, coreToggleMark, coreToggleChangedSince, coreToggleShownBeforeHeld, coreToggleClickedDuringReset } from './core-toggle.js';
import { noteCoreReplaced } from '../../api.js';

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
        // A read that started during that save may still hold the value
        // from before it, also once the save has finished.
        expect(coreToggleChangedSince(toggle, during)).toBe(true);
    });

    it('a value read before Restore Defaults is not put on the switch it reset', async () => {
        const toggle = { checked: true };
        const mark = coreToggleMark(toggle);
        const release = await pauseCoreToggles();
        toggle.checked = false;
        expect(coreToggleChangedSince(toggle, mark)).toBe(true);
        release();
        expect(coreToggleChangedSince(toggle, mark)).toBe(true);
        expect(coreToggleChangedSince(toggle, coreToggleMark(toggle))).toBe(false);
    });

    it('overlapping resets: clicks stay held until the last one is released', async () => {
        const toggle = { checked: true };
        const d = deps(vi.fn(async () => true));
        const releaseFirst = await pauseCoreToggles();
        const releaseSecond = await pauseCoreToggles();
        releaseSecond();
        toggle.checked = false;
        const run = applyCoreToggle(toggle, 'ipv6', d);
        await Promise.resolve();
        await Promise.resolve();
        expect(d.saveCore).not.toHaveBeenCalled();
        releaseFirst();
        expect(await run).toBe(true);
        expect(d.saveCore).toHaveBeenCalledWith({ ipv6: false });
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
        // saveCore reports its own failure: no second error toast.
        expect(d.notify).not.toHaveBeenCalled();
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

    it('a click on the default a reset shows, failing after the core kept its value, shows the core\'s value', async () => {
        // IPv6 runs on; the reset shows off and the core refuses it; the
        // user clicks on and off again during the reset, and that save fails.
        const toggle = { checked: true };
        const d = deps(vi.fn(async () => false));
        const release = await pauseCoreToggles();
        noteCoreToggleApplied(toggle, toggle.checked);
        toggle.checked = false;
        toggle.checked = true;
        const on = applyCoreToggle(toggle, 'ipv6', d);
        toggle.checked = false;
        const off = applyCoreToggle(toggle, 'ipv6', d);
        release();
        expect(await on).toBe(false);
        expect(await off).toBe(false);
        expect(toggle.checked).toBe(true);
    });

    it('a click held before the reset records the core\'s values still reads what the core runs', async () => {
        // IPv6 runs on; the user turns it off while the reset is still
        // reading settings: that click is held and never reached the core.
        const toggle = { checked: true };
        const d = deps(vi.fn(async () => true));
        const release = await pauseCoreToggles();
        toggle.checked = false;
        const run = applyCoreToggle(toggle, 'ipv6', d);
        expect(coreToggleShownBeforeHeld(toggle)).toBe(true);
        // The reset leaves the switch showing the user's choice.
        expect(coreToggleClickedDuringReset(toggle)).toBe(true);
        release();
        await run;
        expect(coreToggleClickedDuringReset(toggle)).toBe(false);
        // The next reset starts from what the switch shows again.
        const again = await pauseCoreToggles();
        expect(coreToggleShownBeforeHeld(toggle)).toBe(false);
        again();
    });

    it('the value a reset records is the one the core accepted, not what the switch showed', async () => {
        // The core accepted IPv6 off, while the switch still shows on (a
        // save that failed showed it); the user clicks it off during a reset.
        const toggle = { checked: true };
        noteCoreToggleApplied(toggle, false);
        const d = deps(vi.fn(async () => true));
        const release = await pauseCoreToggles();
        toggle.checked = false;
        const held = applyCoreToggle(toggle, 'ipv6', d);
        expect(coreToggleShownBeforeHeld(toggle)).toBe(false);
        release();
        await held;
    });
    it('a failed click goes back to the value read from the core, not to the saved preference the switch showed', async () => {
        // The page read IPv6 off from the core but shows the saved
        // preference on; the user turns it off and the save fails.
        const toggle = { checked: true };
        noteCoreToggleApplied(toggle, false);
        toggle.checked = false;
        const d = deps(vi.fn(async () => false));
        expect(await applyCoreToggle(toggle, 'ipv6', d)).toBe(false);
        expect(toggle.checked).toBe(false);
    });

    it('after a reset that needs a restart, a failed click goes back to the value the core still runs', async () => {
        // IPv6 runs on; Restore Defaults shows off, but the core keeps on
        // until it restarts. The user turns it on and off, the last save fails.
        const toggle = { checked: true };
        const release = await pauseCoreToggles();
        noteCoreToggleApplied(toggle, true);
        toggle.checked = false;
        release();
        toggle.checked = true;
        const d = deps(vi.fn(async () => 'restart'));
        expect(await applyCoreToggle(toggle, 'ipv6', d)).toBe('restart');
        toggle.checked = false;
        d.saveCore = vi.fn(async () => false);
        expect(await applyCoreToggle(toggle, 'ipv6', d)).toBe(false);
        expect(toggle.checked).toBe(true);
    });

    it('once the core was replaced, a click takes what the switch shows as what the core runs', async () => {
        // A save needed a restart; the core restarted since with the value
        // the switch shows (settings.json).
        const toggle = { checked: false };
        noteCoreToggleApplied(toggle, false);
        toggle.checked = true;
        const d = deps(vi.fn(async () => 'restart'));
        expect(await applyCoreToggle(toggle, 'ipv6', d)).toBe('restart');
        noteCoreReplaced();
        // The next click comes on a later turn, once the save is done.
        await new Promise((resolve) => { setTimeout(resolve, 0); });
        toggle.checked = false;
        d.saveCore = vi.fn(async () => false);
        expect(await applyCoreToggle(toggle, 'ipv6', d)).toBe(false);
        expect(toggle.checked).toBe(true);
    });
    it('once the core was replaced, a failed save does not go back to the old core\'s value', async () => {
        // The core ran IPv6 on; a save turning it off needs a restart, and
        // the core restarted with off (settings.json).
        const toggle = { checked: true };
        noteCoreToggleApplied(toggle, true);
        toggle.checked = false;
        const d = deps(vi.fn(async () => 'restart'));
        expect(await applyCoreToggle(toggle, 'ipv6', d)).toBe('restart');
        noteCoreReplaced();
        expect(coreToggleShownBeforeHeld(toggle)).toBe(false);
        expect(coreToggleApplied(toggle)).toBeUndefined();
    });

    it('queued clicks with a core restart between them: a failed last save shows the value last saved', async () => {
        // Off (saved), clicked on (saved), then off and on again queued; the
        // core restarts after the second save and both queued saves fail.
        const toggle = { checked: false };
        /** @type {Array<(v: any) => void>} */
        const answers = [];
        const d = deps(vi.fn(() => new Promise((resolve) => { answers.push(resolve); })));
        toggle.checked = true;
        const first = applyCoreToggle(toggle, 'ipv6', d);
        await vi.waitFor(() => expect(answers.length).toBe(1));
        answers[0](true);
        await first;
        toggle.checked = false;
        const second = applyCoreToggle(toggle, 'ipv6', d);
        toggle.checked = true;
        const third = applyCoreToggle(toggle, 'ipv6', d);
        await vi.waitFor(() => expect(answers.length).toBe(2));
        noteCoreReplaced();
        answers[1](false);
        await second;
        await vi.waitFor(() => expect(answers.length).toBe(3));
        answers[2](false);
        await third;
        // The new core started from settings.json, which holds on.
        expect(toggle.checked).toBe(true);
    });
    it('a core started while the value was saved gets it as well, and only then is it recorded for that core', async () => {
        const toggle = { checked: false };
        noteCoreToggleApplied(toggle, false);
        /** @type {Array<(v: any) => void>} */
        const answers = [];
        const d = deps(vi.fn(() => new Promise((resolve) => { answers.push(resolve); })));
        toggle.checked = true;
        const pending = applyCoreToggle(toggle, 'ipv6', d);
        await vi.waitFor(() => expect(answers.length).toBe(1));
        // The old core took it, but a restart replaced it meanwhile.
        noteCoreReplaced();
        answers[0](true);
        await vi.waitFor(() => expect(answers.length).toBe(2));
        // Not recorded for the new core before it took the value.
        expect(coreToggleApplied(toggle)).toBeUndefined();
        expect(d.saveCore).toHaveBeenLastCalledWith({ ipv6: true });
        answers[1](true);
        expect(await pending).toBe(true);
        expect(coreToggleApplied(toggle)).toBe(true);
    });

    it('a core started meanwhile that needs a restart for the value: neither applied nor recorded for it', async () => {
        const toggle = { checked: false };
        /** @type {Array<(v: any) => void>} */
        const answers = [];
        const d = deps(vi.fn(() => new Promise((resolve) => { answers.push(resolve); })));
        toggle.checked = true;
        const pending = applyCoreToggle(toggle, 'ipv6', d);
        await vi.waitFor(() => expect(answers.length).toBe(1));
        noteCoreReplaced();
        answers[0](true);
        await vi.waitFor(() => expect(answers.length).toBe(2));
        answers[1]('restart');
        expect(await pending).toBe('restart');
        expect(d.notify).not.toHaveBeenCalledWith(expect.anything(), 'success');
        expect(coreToggleApplied(toggle)).toBeUndefined();
    });

    it('a failed write to settings.json after a core restart shows what the new core read from it', async () => {
        const toggle = { checked: false };
        // Saved off earlier.
        const d0 = deps(vi.fn(async () => true));
        toggle.checked = true;
        await applyCoreToggle(toggle, 'ipv6', d0);
        toggle.checked = false;
        await applyCoreToggle(toggle, 'ipv6', d0);
        // Now on: the core takes it, a restart starts meanwhile, and the
        // write to settings.json fails, so the new core runs off.
        toggle.checked = true;
        const d = deps(vi.fn(async () => { noteCoreReplaced(); return true; }), vi.fn(async () => { throw new Error('disk'); }));
        expect(await applyCoreToggle(toggle, 'ipv6', d)).toBe('unsaved');
        expect(toggle.checked).toBe(false);
    });

    it('a core started between the writes gets the value even when a newer click is queued', async () => {
        const toggle = { checked: false };
        /** @type {Array<(v: any) => void>} */
        const answers = [];
        const d = deps(vi.fn(() => new Promise((resolve) => { answers.push(resolve); })));
        toggle.checked = true;
        const first = applyCoreToggle(toggle, 'ipv6', d);
        toggle.checked = false;
        const second = applyCoreToggle(toggle, 'ipv6', d);
        await vi.waitFor(() => expect(answers.length).toBe(1));
        noteCoreReplaced();
        answers[0](true);
        // Sent again to the new core before the queued click's save.
        await vi.waitFor(() => expect(answers.length).toBe(2));
        expect(d.saveCore).toHaveBeenNthCalledWith(2, { ipv6: true });
        answers[1](true);
        await first;
        await vi.waitFor(() => expect(answers.length).toBe(3));
        answers[2](false);
        await second;
        // The queued save failed: the switch shows what the new core runs.
        expect(toggle.checked).toBe(true);
    });

    it('after Restore Defaults clears the preference, a failed save on a new core shows what the profile holds', async () => {
        const toggle = { checked: false };
        const d0 = deps(vi.fn(async () => true));
        toggle.checked = true;
        await applyCoreToggle(toggle, 'ipv6', d0);
        // The reset wrote the default (off) to the profile and cleared the preference.
        noteCoreTogglePersisted(toggle, false);
        noteCoreReplaced();
        toggle.checked = true;
        await applyCoreToggle(toggle, 'ipv6', deps(vi.fn(async () => false)));
        expect(toggle.checked).toBe(false);
    });

    it('a core started after a save settings.json did not take runs the saved value, not the switch', async () => {
        const toggle = { checked: false };
        // On: the core takes it, settings.json does not (it still holds off).
        toggle.checked = true;
        await applyCoreToggle(toggle, 'ipv6', deps(vi.fn(async () => true), vi.fn(async () => { throw new Error('disk'); })));
        expect(toggle.checked).toBe(true);
        // A restart: the new core reads off from settings.json.
        noteCoreReplaced();
        // Off, and that save fails: the switch shows what the new core runs.
        toggle.checked = false;
        await applyCoreToggle(toggle, 'ipv6', deps(vi.fn(async () => false)));
        expect(toggle.checked).toBe(false);
    });
});
