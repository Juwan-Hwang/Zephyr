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

    it('text fields are never quieted', () => {
        dialog();
        document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        const field = /** @type {HTMLElement} */ (document.getElementById('field'));
        focusRespectingModality(field);
        expect(document.activeElement).toBe(field);
        expect(field.classList.contains('focus-quiet')).toBe(false);
    });
});
