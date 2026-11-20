import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../utils/frontend-log.js', () => ({ forwardToBackend: vi.fn() }));

const { showNotification } = await import('./notifications.js');

describe('showNotification capacity', () => {
    beforeEach(() => {
        document.body.innerHTML = '<div id="notif-container"></div>';
    });

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
});
