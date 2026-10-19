// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';

vi.mock('../api.js', () => ({ readCoreLog: vi.fn(async () => ({ lines: [], next_offset: 0 })) }));
vi.mock('../modules/backend-events.js', () => ({
    getExtLogEvents: () => [],
    subscribeToEvents: () => () => {},
    unsubscribeFromEvents: () => {},
}));

describe('logs page', () => {
    it('keeps tab, level and search when the page is left and re-entered', async () => {
        document.body.innerHTML = '<div data-page="logs"></div>';
        const { initLogsPage, destroyLogsPage } = await import('./logs.js');
        await initLogsPage();

        /** @type {HTMLElement} */ (document.querySelector('#log-panel-core .log-level-seg[data-level="warn"]')).click();
        const search = /** @type {HTMLInputElement} */ (document.getElementById('log-search'));
        search.value = 'dns';
        search.dispatchEvent(new Event('input'));
        await new Promise((r) => setTimeout(r, 200));
        /** @type {HTMLElement} */ (document.querySelector('#log-panel-ext .log-level-btn[data-level="error"]')).click();
        /** @type {HTMLElement} */ (document.getElementById('log-tab-ext')).click();

        destroyLogsPage();
        document.querySelector('[data-page="logs"]')?.replaceChildren();
        await initLogsPage();

        expect(document.querySelector('#log-panel-core .log-level-seg.active')?.getAttribute('data-level')).toBe('warn');
        expect(/** @type {HTMLInputElement} */ (document.getElementById('log-search')).value).toBe('dns');
        expect(document.querySelector('#log-panel-ext .log-level-btn.active')?.getAttribute('data-level')).toBe('error');
        expect(document.getElementById('log-tab-ext')?.getAttribute('aria-selected')).toBe('true');
        expect(document.getElementById('log-panel-core')?.classList.contains('hidden')).toBe(true);
        destroyLogsPage();
    });
});
