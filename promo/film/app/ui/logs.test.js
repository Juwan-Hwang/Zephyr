// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest';

/** @type {string[]} */
let coreLines = [];
/** @type {any[]} */
let extEvents = [];
vi.mock('../api.js', () => ({ readCoreLog: vi.fn(async (/** @type {number} */ offset) => (offset > 0 ? { lines: [], next_offset: offset } : { lines: coreLines, next_offset: coreLines.length ? 100 : 0 })) }));
vi.mock('../modules/backend-events.js', () => ({
    getExtLogEvents: () => extEvents,
    subscribeToEvents: () => () => {},
    unsubscribeFromEvents: () => {},
}));

describe('logs page', () => {
    // Fixtures are cleared even when a test fails part-way.
    afterEach(() => {
        coreLines = [];
        extEvents = [];
    });

    it('keeps tab, level and search when the page is left and re-entered', async () => {
        document.body.innerHTML = '<div data-page="logs"></div>';
        const { initLogsPage, destroyLogsPage } = await import('./logs.js');
        await initLogsPage();

        /** @type {HTMLElement} */ (document.querySelector('#log-panel-core .log-level-seg[data-level="warn"]')).click();
        const search = /** @type {HTMLInputElement} */ (document.getElementById('log-search'));
        search.value = 'dns';
        search.dispatchEvent(new Event('input'));
        await new Promise((r) => setTimeout(r, 200));
        /** @type {HTMLElement} */ (document.querySelector('#log-panel-ext .log-level-seg[data-level="error"]')).click();
        /** @type {HTMLElement} */ (document.getElementById('log-tab-ext')).click();

        destroyLogsPage();
        document.querySelector('[data-page="logs"]')?.replaceChildren();
        await initLogsPage();

        expect(document.querySelector('#log-panel-core .log-level-seg.active')?.getAttribute('data-level')).toBe('warn');
        expect(/** @type {HTMLInputElement} */ (document.getElementById('log-search')).value).toBe('dns');
        expect(document.querySelector('#log-panel-ext .log-level-seg.active')?.getAttribute('data-level')).toBe('error');
        expect(document.querySelector('#log-panel-ext .log-level-seg[data-level="error"]')?.getAttribute('aria-pressed')).toBe('true');
        expect(document.getElementById('log-tab-ext')?.getAttribute('aria-selected')).toBe('true');
        expect(document.getElementById('log-panel-core')?.classList.contains('hidden')).toBe(true);
        destroyLogsPage();
    });

    it('core and app logs share one filter bar (same level steps, same search)', async () => {
        document.body.innerHTML = '<div data-page="logs"></div>';
        const { initLogsPage, destroyLogsPage } = await import('./logs.js');
        await initLogsPage();
        const bar = (/** @type {string} */ panel) => document.querySelector(`${panel} .log-filter-bar`);
        const core = bar('#log-panel-core');
        const ext = bar('#log-panel-ext');
        expect(core).not.toBeNull();
        expect(ext).not.toBeNull();
        const steps = (/** @type {Element|null} */ el) => [...(el?.querySelectorAll('.seg-tab') || [])].map((b) => b.getAttribute('data-level') + ':' + b.getAttribute('data-i18n'));
        expect(steps(ext)).toEqual(steps(core));
        expect(steps(core)).toEqual(['all:logLevelAll', 'info:logLevelInfoUp', 'warn:logLevelWarnUp', 'error:logLevelErrorOnly']);
        expect(document.querySelectorAll('.log-level-btn').length).toBe(0);
        const shape = (/** @type {Element|null} */ el) => el?.outerHTML.replace(/id="[^"]*"/g, '').replace(/ active/g, '').replace(/aria-pressed="\w+"/g, '').replace(/>[^<]*\d[^<]*</g, '><');
        expect(shape(ext)).toBe(shape(core));
        destroyLogsPage();
    });

    it('both panels filter by level on their own, the error step including fatal', async () => {
        vi.resetModules();
        coreLines = ['level=info msg=a', 'level=warning msg=b', 'level=error msg=c', 'level=fatal msg=d'];
        const ts = '2026-10-21T00:00:00Z';
        extEvents = ['info', 'warn', 'error', 'fatal'].map((type, i) => ({ source: 'backend', type, message: `m${i}`, timestamp: ts }));
        document.body.innerHTML = '<div data-page="logs"></div>';
        const { initLogsPage, destroyLogsPage } = await import('./logs.js');
        await initLogsPage();
        const count = (/** @type {string} */ id) => document.getElementById(id)?.textContent?.trim();
        await vi.waitFor(() => expect(count('log-line-count')).toMatch(/^4\b/));
        const pick = (/** @type {string} */ panel, /** @type {string} */ level) =>
            /** @type {HTMLElement} */ (document.querySelector(`${panel} .log-level-seg[data-level="${level}"]`)).click();

        expect(count('log-line-count')).toMatch(/^4\b/);
        pick('#log-panel-core', 'error');
        expect(count('log-line-count')).toMatch(/\b2 \/ 4\b/);
        // The app panel keeps its own level.
        /** @type {HTMLElement} */ (document.getElementById('log-tab-ext')).click();
        expect(count('log-ext-line-count')).toMatch(/^4\b/);
        pick('#log-panel-ext', 'error');
        expect(count('log-ext-line-count')).toMatch(/\b2 \/ 4\b/);
        // The error step keeps fatal (m3), not just a count of two.
        expect(document.getElementById('log-ext-list')?.textContent).toContain('m3');
        expect(document.getElementById('log-ext-list')?.textContent).not.toContain('m1');
        pick('#log-panel-ext', 'warn');
        expect(count('log-ext-line-count')).toMatch(/\b3 \/ 4\b/);
        expect(count('log-line-count')).toMatch(/\b2 \/ 4\b/);
        destroyLogsPage();
    });
});
