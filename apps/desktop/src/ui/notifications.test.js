import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../utils/frontend-log.js', () => ({ forwardToBackend: vi.fn() }));

const { showNotification } = await import('./notifications.js');
const { setLanguage } = await import('../i18n.js');

describe('showNotification capacity', () => {
    beforeEach(() => {
        document.body.innerHTML = '<div id="notif-container"></div>';
    });

    afterEach(() => setLanguage('en'));

    const types = () => [...document.getElementById('notif-container').children].map((el) => /** @type {HTMLElement} */ (el).dataset.type);

    it('drops a routine toast instead of evicting an error when full of errors', () => {
        for (let i = 0; i < 5; i++) showNotification(`e${i}`, 'error');
        showNotification('saved', 'success');
        expect(types()).toEqual(['error', 'error', 'error', 'error', 'error']);
    });

    it('evicts the least important toast for a more important one', () => {
        for (let i = 0; i < 5; i++) showNotification(`s${i}`, 'success');
        showNotification('broken', 'error');
        const list = types();
        expect(list).toHaveLength(5);
        expect(list[0]).toBe('error');
    });

    it('adds aria-label and title attributes to sticky notification close button', () => {
        showNotification('Sticky error message', 'error');
        const closeBtn = document.querySelector('.toast-close');
        expect(closeBtn).not.toBeNull();
        expect(closeBtn?.getAttribute('aria-label')).toBe('Dismiss');
        expect(closeBtn?.getAttribute('title')).toBe('Dismiss');
        expect(closeBtn?.dataset.i18nTitle).toBe('dismiss');
        expect(closeBtn?.dataset.i18nAriaLabel).toBe('dismiss');
        // The existing button must follow language switches, not just carry
        // the initial English values.
        setLanguage('zh');
        expect(closeBtn?.getAttribute('aria-label')).toBe('关闭');
        expect(closeBtn?.getAttribute('title')).toBe('关闭');
    });
});
