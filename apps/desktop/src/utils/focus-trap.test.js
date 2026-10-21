// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { createFocusTrap, getInputModality, focusRespectingModality } from './focus-trap.js';

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r(undefined)));

function dialog() {
    document.body.innerHTML = '<button id="opener">open</button><div id="dlg"><button id="first">A</button><input id="field" type="text"><button id="last">B</button></div>';
    return /** @type {HTMLElement} */ (document.getElementById('dlg'));
}

describe('focus trap modality', () => {
    beforeEach(() => { document.body.innerHTML = ''; });

    it('mouse-opened dialog focuses its first button quietly', async () => {
        const dlg = dialog();
        document.getElementById('opener')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        expect(getInputModality()).toBe('pointer');
        const trap = createFocusTrap(dlg);
        trap.activate();
        await nextFrame();
        const first = document.getElementById('first');
        expect(document.activeElement).toBe(first);
        expect(first?.classList.contains('focus-quiet')).toBe(true);

        // A key press brings the ring back.
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
        expect(first?.classList.contains('focus-quiet')).toBe(false);
        expect(getInputModality()).toBe('keyboard');
        trap.destroy();
    });

    it('keyboard-opened dialog keeps the focus ring', async () => {
        const dlg = dialog();
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        const trap = createFocusTrap(dlg);
        trap.activate();
        await nextFrame();
        expect(document.getElementById('first')?.classList.contains('focus-quiet')).toBe(false);
        trap.destroy();
    });

    it('tab with focus outside the dialog pulls focus back inside', async () => {
        const dlg = dialog();
        const trap = createFocusTrap(dlg);
        trap.activate();
        await nextFrame();
        // Simulate focus escaping to the opener (e.g. after a click on
        // non-focusable dialog content dropped focus back to <body>).
        document.getElementById('opener')?.focus();
        expect(document.activeElement?.id).toBe('opener');
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
        expect(document.activeElement?.id).toBe('first');
        document.getElementById('opener')?.focus();
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
        expect(document.activeElement?.id).toBe('last');
        trap.destroy();
    });

    it('a nested trap owns tab handling while it is on top', async () => {
        document.body.innerHTML = '<div id="outer"><button id="outer-first">O1</button><button id="outer-last">O2</button></div><div id="inner"><button id="inner-first">I1</button><button id="inner-last">I2</button></div>';
        const outer = createFocusTrap(/** @type {HTMLElement} */ (document.getElementById('outer')));
        const inner = createFocusTrap(/** @type {HTMLElement} */ (document.getElementById('inner')));
        outer.activate();
        inner.activate();
        await nextFrame();
        // Focus the inner dialog's last control: Tab must wrap inside the
        // inner dialog, not be pulled back into the outer panel.
        document.getElementById('inner-last')?.focus();
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
        expect(document.activeElement?.id).toBe('inner-first');
        inner.destroy();
        outer.destroy();
    });

    it('a trap on a container hidden after activation stops answering keys', () => {
        const dlg = dialog();
        let escapes = 0;
        const trap = createFocusTrap(dlg, { onEscape: () => { escapes++; } });
        trap.activate();
        dlg.classList.add('hidden');
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        expect(escapes).toBe(0);
        trap.destroy();
    });

    it('deactivating before the initial-focus frame keeps focus out of the dialog', async () => {
        const dlg = dialog();
        const opener = /** @type {HTMLElement} */ (document.getElementById('opener'));
        opener.focus();
        const trap = createFocusTrap(dlg);
        trap.activate();
        trap.deactivate();
        await nextFrame();
        await nextFrame();
        expect(document.activeElement).toBe(opener);
        trap.destroy();
    });

    it('text fields are never quieted', () => {
        dialog();
        document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        const field = /** @type {HTMLElement} */ (document.getElementById('field'));
        focusRespectingModality(field);
        expect(document.activeElement).toBe(field);
        expect(field.classList.contains('focus-quiet')).toBe(false);
    });
});

describe('focus trap restore', () => {
    beforeEach(() => { document.body.innerHTML = ''; });

    it('falls back to the dialog underneath when the element it came from was replaced', async () => {
        document.body.innerHTML = '<div id="under" role="dialog" aria-modal="true"><div id="foot"><button id="old" class="btn-ghost">Close</button></div></div>'
            + '<div id="top"><button id="ok">OK</button></div>';
        document.getElementById('old')?.focus();
        const trap = createFocusTrap(/** @type {HTMLElement} */ (document.getElementById('top')));
        trap.activate();
        await nextFrame();
        // The dialog underneath re-renders its footer while the top one is open.
        const foot = /** @type {HTMLElement} */ (document.getElementById('foot'));
        foot.innerHTML = '<button id="done" class="btn-primary">Done</button>';
        trap.deactivate();
        expect(document.activeElement?.id).toBe('done');
    });

    it('skips a hidden primary button in the dialog underneath', async () => {
        document.body.innerHTML = '<div id="under" role="dialog" aria-modal="true"><div id="foot"><button id="old">Close</button></div></div>'
            + '<div id="top"><button id="ok">OK</button></div>';
        document.getElementById('old')?.focus();
        const trap = createFocusTrap(/** @type {HTMLElement} */ (document.getElementById('top')));
        trap.activate();
        await nextFrame();
        const foot = /** @type {HTMLElement} */ (document.getElementById('foot'));
        foot.innerHTML = '<button id="hid" class="btn-primary hidden">Install</button><button id="back">Back</button>';
        trap.deactivate();
        expect(document.activeElement?.id).toBe('back');
    });

    it('skips a primary button inside a disabled fieldset in the dialog underneath', async () => {
        document.body.innerHTML = '<div id="under" role="dialog" aria-modal="true"><div id="foot"><button id="old">Close</button></div></div>'
            + '<div id="top"><button id="ok">OK</button></div>';
        document.getElementById('old')?.focus();
        const trap = createFocusTrap(/** @type {HTMLElement} */ (document.getElementById('top')));
        trap.activate();
        await nextFrame();
        const foot = /** @type {HTMLElement} */ (document.getElementById('foot'));
        foot.innerHTML = '<fieldset disabled><button id="off" class="btn-primary">Install</button></fieldset><button id="back">Back</button>';
        trap.deactivate();
        expect(document.activeElement?.id).toBe('back');
    });

    it('skips a primary button hidden with an inline display:none', async () => {
        document.body.innerHTML = '<div id="under" role="dialog" aria-modal="true"><div id="foot"><button id="old">Close</button></div></div>'
            + '<div id="top"><button id="ok">OK</button></div>';
        document.getElementById('old')?.focus();
        const trap = createFocusTrap(/** @type {HTMLElement} */ (document.getElementById('top')));
        trap.activate();
        await nextFrame();
        const foot = /** @type {HTMLElement} */ (document.getElementById('foot'));
        foot.innerHTML = '<span style="display:none"><button id="hid" class="btn-primary">Save</button></span><button id="back">Back</button>';
        trap.deactivate();
        expect(document.activeElement?.id).toBe('back');
    });

    it('skips a dialog underneath that is hidden with an inline display:none', async () => {
        document.body.innerHTML = '<div id="under" role="dialog" aria-modal="true"><div id="foot"><button id="old">Close</button></div></div>'
            + '<div role="dialog" aria-modal="true" style="display:none"><button class="btn-primary">Stale</button></div>'
            + '<div id="top"><button id="ok">OK</button></div>';
        document.getElementById('old')?.focus();
        const trap = createFocusTrap(/** @type {HTMLElement} */ (document.getElementById('top')));
        trap.activate();
        await nextFrame();
        const foot = /** @type {HTMLElement} */ (document.getElementById('foot'));
        foot.innerHTML = '<button id="done" class="btn-primary">Done</button>';
        trap.deactivate();
        expect(document.activeElement?.id).toBe('done');
    });

    it('falls back when the element it came from is still there but hidden', async () => {
        document.body.innerHTML = '<div id="under" role="dialog" aria-modal="true"><button id="old">Install</button><button id="done" class="btn-primary">Done</button></div>'
            + '<div id="top"><button id="ok">OK</button></div>';
        document.getElementById('old')?.focus();
        const trap = createFocusTrap(/** @type {HTMLElement} */ (document.getElementById('top')));
        trap.activate();
        await nextFrame();
        document.getElementById('old')?.classList.add('hidden');
        trap.deactivate();
        expect(document.activeElement?.id).toBe('done');
    });

    it('falls back when the element it came from is now disabled', async () => {
        document.body.innerHTML = '<div id="under" role="dialog" aria-modal="true"><button id="old">Install</button><button id="done" class="btn-primary">Done</button></div>'
            + '<div id="top"><button id="ok">OK</button></div>';
        document.getElementById('old')?.focus();
        const trap = createFocusTrap(/** @type {HTMLElement} */ (document.getElementById('top')));
        trap.activate();
        await nextFrame();
        /** @type {HTMLButtonElement} */ (document.getElementById('old')).disabled = true;
        trap.deactivate();
        expect(document.activeElement?.id).toBe('done');
    });

    it('returns focus to an element that overrides a hidden ancestor with visibility:visible', async () => {
        document.body.innerHTML = '<div role="dialog" aria-modal="true"><div style="visibility:hidden"><button id="old" style="visibility:visible">Close</button></div><button class="btn-primary">Done</button></div><div id="top"><button>OK</button></div>';
        document.getElementById('old')?.focus();
        const trap = createFocusTrap(/** @type {HTMLElement} */ (document.getElementById('top')));
        trap.activate();
        await nextFrame();
        trap.deactivate();
        expect(document.activeElement?.id).toBe('old');
    });

    it('still returns focus to the original element when it is there', async () => {
        document.body.innerHTML = '<div role="dialog" aria-modal="true"><button id="old">Close</button><button class="btn-primary">Done</button></div><div id="top"><button>OK</button></div>';
        document.getElementById('old')?.focus();
        const trap = createFocusTrap(/** @type {HTMLElement} */ (document.getElementById('top')));
        trap.activate();
        await nextFrame();
        trap.deactivate();
        expect(document.activeElement?.id).toBe('old');
    });
});
