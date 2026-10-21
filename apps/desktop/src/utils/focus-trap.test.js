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
