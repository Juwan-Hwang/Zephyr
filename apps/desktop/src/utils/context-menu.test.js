import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { showContextMenu, removeContextMenu } from './context-menu.js';

vi.mock('../i18n.js', () => ({ getDirection: () => 'ltr' }));

describe('context menu focus', () => {
    beforeEach(() => { document.body.innerHTML = '<button id="anchor">Sidebar</button>'; });
    afterEach(() => removeContextMenu());

    it('focuses the first action on a keyboard open and returns on Escape', () => {
        const anchor = /** @type {HTMLElement} */ (document.getElementById('anchor'));
        anchor.focus();
        showContextMenu(new MouseEvent('contextmenu', { button: 0 }), [{ label: 'Expand', action: vi.fn() }]);
        expect(document.activeElement).toBe(document.querySelector('.ctx-menu-root button'));
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        expect(document.querySelector('.ctx-menu-root')).toBeNull();
        expect(document.activeElement).toBe(anchor);
    });

    it('preserves focus when a mouse opens the menu', () => {
        const anchor = /** @type {HTMLElement} */ (document.getElementById('anchor'));
        anchor.focus();
        showContextMenu(new MouseEvent('contextmenu', { button: 2, clientX: 100, clientY: 100 }), [{ label: 'Expand' }]);
        expect(document.activeElement).toBe(anchor);
    });
});
