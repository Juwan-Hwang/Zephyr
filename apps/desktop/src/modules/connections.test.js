// @ts-check
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../api.js', () => ({
    getConnections: vi.fn(),
    closeConnection: vi.fn().mockResolvedValue(undefined),
    closeAllConnections: vi.fn().mockResolvedValue(undefined),
    isCoreReachable: vi.fn(() => true),
}));
vi.mock('../ui/notifications.js', () => ({ showNotification: vi.fn() }));
vi.mock('../i18n.js', () => ({
    translations: { en: {} },
    currentLang: 'en',
    applyTranslations: vi.fn(),
}));
vi.mock('../utils/logger.js', () => ({
    connectionsLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { getConnections } from '../api.js';

const mockedGetConnections = /** @type {import('vitest').Mock} */ (/** @type {unknown} */ (getConnections));

// The module keeps page state (and a one-time header binding) at module
// level, so each test loads a fresh copy against a fresh DOM.
/** @type {typeof import('./connections.js')} */
let mod;
const initConnectionsPage = () => mod.initConnectionsPage();
const destroyConnectionsPage = () => mod.destroyConnectionsPage();

/**
 * @param {string} id
 * @param {string} host
 * @param {number} download
 * @param {number} [upload]
 */
function conn(id, host, download, upload = 0) {
    return {
        id,
        metadata: { host, destinationIP: '1.1.1.1', destinationPort: '443', process: 'curl' },
        rule: 'Match',
        chains: ['DIRECT'],
        download,
        upload,
    };
}

/** Resolve pending promises. */
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

function list() {
    return /** @type {HTMLElement} */ (document.getElementById('connections-list'));
}
function rows() {
    return /** @type {HTMLElement[]} */ (Array.from(list().querySelectorAll('.conn-row')));
}
/** @param {HTMLElement} row */
function hostOf(row) {
    return row.querySelector('span')?.textContent;
}
/** @param {HTMLElement} row */
function dlTotalOf(row) {
    return row.querySelector('.conn-rate--down + .conn-sub')?.textContent;
}

async function refresh() {
    /** @type {HTMLElement} */ (document.getElementById('refresh-conns-btn')).click();
    await flush();
}

describe('connections page list rendering', () => {
    beforeEach(async () => {
        vi.resetModules();
        mod = await import('./connections.js');
        vi.useFakeTimers();
        document.body.innerHTML = '<div data-page="connections"></div>';
        mockedGetConnections.mockReset();
    });
    afterEach(() => {
        destroyConnectionsPage();
        vi.useRealTimers();
    });

    it('reuses row nodes across polls and patches only the traffic cells', async () => {
        mockedGetConnections.mockResolvedValue({ connections: [conn('1', 'a.example', 100), conn('2', 'b.example', 100)] });
        initConnectionsPage();
        await flush();
        const first = rows();
        expect(first.map(hostOf)).toEqual(['a.example', 'b.example']);
        expect(first.map(dlTotalOf)).toEqual(['0 B', '0 B']);

        vi.setSystemTime(Date.now() + 2000);
        mockedGetConnections.mockResolvedValue({ connections: [conn('1', 'a.example', 1100), conn('2', 'b.example', 100)] });
        await refresh();

        const second = rows();
        expect(second[0]).toBe(first[0]);
        expect(second[1]).toBe(first[1]);
        expect(dlTotalOf(second[0])).toBe('1.00 KB');
        expect(dlTotalOf(second[1])).toBe('0 B');
    });

    it('adds and removes rows as connections come and go', async () => {
        mockedGetConnections.mockResolvedValue({ connections: [conn('1', 'a.example', 0), conn('2', 'b.example', 0)] });
        initConnectionsPage();
        await flush();
        const [rowA] = rows();

        mockedGetConnections.mockResolvedValue({ connections: [conn('1', 'a.example', 0), conn('3', 'c.example', 0)] });
        await refresh();

        const now = rows();
        expect(now.map(hostOf)).toEqual(['a.example', 'c.example']);
        expect(now[0]).toBe(rowA);
    });

    it('produces the same markup as a fresh render', async () => {
        mockedGetConnections.mockResolvedValue({ connections: [conn('1', 'a.example', 0)] });
        initConnectionsPage();
        await flush();
        vi.setSystemTime(Date.now() + 2000);
        mockedGetConnections.mockResolvedValue({ connections: [conn('1', 'a.example', 5000)] });
        await refresh();
        const patched = rows()[0].outerHTML;

        // Fresh render of the same state: clear the list so the row is rebuilt.
        list().replaceChildren();
        await refresh();
        expect(rows()[0].outerHTML).toBe(patched);
    });

    it('shows the empty state and recovers from it', async () => {
        mockedGetConnections.mockResolvedValue({ connections: [] });
        initConnectionsPage();
        await flush();
        expect(rows()).toHaveLength(0);
        expect(list().querySelector('#connections-empty')).not.toBeNull();

        mockedGetConnections.mockResolvedValue({ connections: [conn('1', 'a.example', 0)] });
        await refresh();
        expect(rows()).toHaveLength(1);
        expect(list().querySelector('#connections-empty')).toBeNull();
    });

    it('opens the detail panel through the delegated click listener', async () => {
        mockedGetConnections.mockResolvedValue({ connections: [conn('1', 'a.example', 0)] });
        initConnectionsPage();
        await flush();
        // Re-render a few times: the click must still open the panel exactly once.
        await refresh();
        await refresh();

        // Count how many times a detail panel is inserted: a leaked per-row
        // or per-refresh listener would open (and insert) it more than once.
        const mo = new MutationObserver(() => {});
        mo.observe(document.body, { childList: true, subtree: true });

        const cell = /** @type {HTMLElement} */ (rows()[0].querySelector('span'));
        cell.click();
        const opened = mo.takeRecords()
            .flatMap((r) => Array.from(r.addedNodes))
            .filter((n) => n instanceof Element && n.id === 'conn-detail-panel')
            .length;
        mo.disconnect();
        expect(opened).toBe(1);
        const panel = document.getElementById('conn-detail-panel');
        expect(panel).not.toBeNull();
        expect(panel?.querySelector('h3')?.textContent).toBe('a.example');
        expect(document.querySelectorAll('#conn-detail-panel')).toHaveLength(1);
    });

    it('opens the detail panel from the keyboard through the delegated listener', async () => {
        mockedGetConnections.mockResolvedValue({ connections: [conn('1', 'a.example', 0)] });
        initConnectionsPage();
        await flush();
        await refresh();
        const row = rows()[0];
        expect(row.getAttribute('role')).toBe('button');
        expect(row.tabIndex).toBe(0);
        const ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
        row.dispatchEvent(ev);
        expect(ev.defaultPrevented).toBe(true);
        expect(document.querySelectorAll('#conn-detail-panel')).toHaveLength(1);
    });

    it('patches idle dimming in place when traffic starts', async () => {
        mockedGetConnections.mockResolvedValue({ connections: [conn('1', 'a.example', 100)] });
        initConnectionsPage();
        await flush();
        const [row] = rows();
        expect(row.classList.contains('conn-row--idle')).toBe(true);

        vi.setSystemTime(Date.now() + 2000);
        mockedGetConnections.mockResolvedValue({ connections: [conn('1', 'a.example', 5000)] });
        await refresh();
        expect(rows()[0]).toBe(row);
        expect(row.classList.contains('conn-row--idle')).toBe(false);
        expect(row.querySelector('.conn-rate--down')?.textContent).toBeTruthy();
    });

    it('keeps sorted order and moves rows when the order changes', async () => {
        mockedGetConnections.mockResolvedValue({ connections: [conn('1', 'a.example', 0), conn('2', 'b.example', 0)] });
        initConnectionsPage();
        await flush();
        expect(rows().map(hostOf)).toEqual(['a.example', 'b.example']);
        const byHost = new Map(rows().map((r) => [hostOf(r), r]));

        // Sort by host (first click = descending).
        const hostHeader = /** @type {HTMLElement} */ (document.querySelector('#conn-table-header [data-sort="host"]'));
        hostHeader.click();
        expect(rows().map(hostOf)).toEqual(['b.example', 'a.example']);
        hostHeader.click(); // ascending
        expect(rows().map(hostOf)).toEqual(['a.example', 'b.example']);
        for (const r of rows()) expect(r).toBe(byHost.get(hostOf(r)));
    });
});
