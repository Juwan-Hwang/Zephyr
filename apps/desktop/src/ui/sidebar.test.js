import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initSidebar, isToggleShortcut, snapExpanded, STORAGE_KEY, NARROW_PX, COLLAPSED_W, EXPANDED_W } from './sidebar.js';

/** @param {Partial<KeyboardEventInit>} init */
const key = (init) => new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });

describe('isToggleShortcut', () => {
    it('uses Control+Command+S on macOS', () => {
        expect(isToggleShortcut(key({ key: 's', ctrlKey: true, metaKey: true }), true)).toBe(true);
        expect(isToggleShortcut(key({ key: 's', metaKey: true }), true)).toBe(false);
        expect(isToggleShortcut(key({ key: 'b', ctrlKey: true }), true)).toBe(false);
    });
    it('uses Ctrl+B elsewhere', () => {
        expect(isToggleShortcut(key({ key: 'b', ctrlKey: true }), false)).toBe(true);
        expect(isToggleShortcut(key({ key: 'B', ctrlKey: true }), false)).toBe(true);
        expect(isToggleShortcut(key({ key: 'b', ctrlKey: true, shiftKey: true }), false)).toBe(false);
        expect(isToggleShortcut(key({ key: 'b', ctrlKey: true, repeat: true }), false)).toBe(false);
    });
});

describe('snapExpanded', () => {
    it('snaps to the nearer width', () => {
        expect(snapExpanded(COLLAPSED_W)).toBe(false);
        expect(snapExpanded(COLLAPSED_W + 30)).toBe(false);
        expect(snapExpanded(EXPANDED_W - 30)).toBe(true);
        expect(snapExpanded(EXPANDED_W)).toBe(true);
    });
});

describe('initSidebar', () => {
    /** @type {() => void} */
    let cleanup = () => {};
    const root = document.documentElement;
    const setWidth = (/** @type {number} */ w) => {
        Object.defineProperty(window, 'innerWidth', { configurable: true, value: w });
    };

    beforeEach(() => {
        localStorage.clear();
        root.className = '';
        root.removeAttribute('style');
        document.body.innerHTML = '<nav id="sidebar-nav"><button class="nav-btn"><span class="nav-label">Home</span></button></nav>';
        setWidth(1200);
    });
    afterEach(() => {
        cleanup();
        document.body.innerHTML = '';
    });

    it('starts expanded in a wide window and adds an edge handle', () => {
        cleanup = initSidebar();
        expect(root.classList.contains('sidebar-expanded')).toBe(true);
        expect(document.querySelector('#sidebar-nav .sidebar-edge')).not.toBeNull();
    });

    it('restores a saved collapsed state', () => {
        localStorage.setItem(STORAGE_KEY, 'collapsed');
        cleanup = initSidebar();
        expect(root.classList.contains('sidebar-expanded')).toBe(false);
    });

    it('toggles and remembers the choice with the shortcut', () => {
        cleanup = initSidebar();
        const ev = key({ key: 'b', ctrlKey: true });
        document.dispatchEvent(ev);
        expect(ev.defaultPrevented).toBe(true);
        expect(root.classList.contains('sidebar-expanded')).toBe(false);
        expect(localStorage.getItem(STORAGE_KEY)).toBe('collapsed');
        document.dispatchEvent(key({ key: 'b', ctrlKey: true }));
        expect(root.classList.contains('sidebar-expanded')).toBe(true);
        expect(localStorage.getItem(STORAGE_KEY)).toBe('expanded');
    });

    it('collapses below the narrow width and comes back after', () => {
        cleanup = initSidebar();
        setWidth(NARROW_PX - 1);
        window.dispatchEvent(new Event('resize'));
        expect(root.classList.contains('sidebar-expanded')).toBe(false);
        expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
        setWidth(NARROW_PX + 100);
        window.dispatchEvent(new Event('resize'));
        expect(root.classList.contains('sidebar-expanded')).toBe(true);
    });

    it('overlays the content when expanded in a narrow window, without saving', () => {
        setWidth(NARROW_PX - 100);
        cleanup = initSidebar();
        expect(root.classList.contains('sidebar-expanded')).toBe(false);
        document.dispatchEvent(key({ key: 'b', ctrlKey: true }));
        expect(root.classList.contains('sidebar-overlay')).toBe(true);
        expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
        document.dispatchEvent(key({ key: 'Escape' }));
        expect(root.classList.contains('sidebar-expanded')).toBe(false);
        expect(root.classList.contains('sidebar-overlay')).toBe(false);
    });

    it('leaves the shortcut to text fields and open dialogs', () => {
        document.body.insertAdjacentHTML('beforeend', '<textarea id="ta"></textarea><div id="dlg" role="dialog" aria-modal="true" class="hidden"></div>');
        cleanup = initSidebar();
        const ta = /** @type {HTMLElement} */ (document.getElementById('ta'));
        const inField = key({ key: 'b', ctrlKey: true });
        ta.dispatchEvent(inField);
        expect(inField.defaultPrevented).toBe(false);
        expect(root.classList.contains('sidebar-expanded')).toBe(true);
        // A dialog panel left inside a hidden backdrop does not count.
        document.body.insertAdjacentHTML('beforeend', '<div class="hidden"><div role="dialog" aria-modal="true"></div></div>');
        document.dispatchEvent(key({ key: 'b', ctrlKey: true }));
        expect(root.classList.contains('sidebar-expanded')).toBe(false);
        document.dispatchEvent(key({ key: 'b', ctrlKey: true }));
        expect(root.classList.contains('sidebar-expanded')).toBe(true);
        document.getElementById('dlg')?.classList.remove('hidden');
        document.dispatchEvent(key({ key: 'b', ctrlKey: true }));
        expect(root.classList.contains('sidebar-expanded')).toBe(true);
    });

    it('uses layout width under UI scaling', async () => {
        root.style.setProperty('--ui-scale', '1.5');
        setWidth(1200); // 800 CSS px of layout
        cleanup = initSidebar();
        expect(root.classList.contains('sidebar-expanded')).toBe(false);
        root.style.setProperty('--ui-scale', '1'); // 1200 CSS px: wide again
        await Promise.resolve();
        expect(root.classList.contains('sidebar-expanded')).toBe(true);
    });

    it('pins the width before overlaying a narrow-window drag', () => {
        setWidth(NARROW_PX - 100);
        cleanup = initSidebar();
        const nav = /** @type {HTMLElement} */ (document.getElementById('sidebar-nav'));
        const edge = /** @type {HTMLElement} */ (document.querySelector('.sidebar-edge'));
        edge.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 80 }));
        expect(root.classList.contains('sidebar-overlay')).toBe(true);
        expect(nav.style.getPropertyValue('--sidebar-drag-w')).not.toBe('');
        edge.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 80 }));
        expect(root.classList.contains('sidebar-overlay')).toBe(false);
        expect(nav.style.getPropertyValue('--sidebar-drag-w')).toBe('');
    });

    it('toggles on a double-click of the edge', () => {
        cleanup = initSidebar();
        document.querySelector('.sidebar-edge')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        expect(root.classList.contains('sidebar-expanded')).toBe(false);
    });

    it('opens a one-item menu on right-click', () => {
        cleanup = initSidebar();
        const nav = /** @type {HTMLElement} */ (document.getElementById('sidebar-nav'));
        nav.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
        const item = document.querySelector('.sidebar-menu-item');
        expect(item).not.toBeNull();
        /** @type {HTMLElement} */ (item).click();
        expect(root.classList.contains('sidebar-expanded')).toBe(false);
    });
});
