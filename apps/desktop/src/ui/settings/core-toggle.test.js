import { describe, it, expect, vi } from 'vitest';
import { applyCoreToggle } from './core-toggle.js';

/** Deps with a controllable core save per call. */
function deps(saveCore, persist = vi.fn(async () => {})) {
    return { saveCore, persist, notify: vi.fn(), texts: () => ({}) };
}

describe('core settings switch', () => {
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
});
