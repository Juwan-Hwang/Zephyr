import { describe, it, expect, vi, beforeEach } from 'vitest';

const settings = { last_config: 'a.yaml', config_order: ['a.yaml', 'b.yaml', 'c.yaml'], custom_args: [] };
const configs = [{ name: 'a.yaml' }, { name: 'b.yaml' }, { name: 'c.yaml' }];

vi.mock('../../api.js', () => ({
    invoke: vi.fn(async (cmd, args) => {
        if (cmd === 'save_settings') { Object.assign(settings, args.settings); return null; }
        if (String(cmd).includes('settings')) return { ...settings };
        if (String(cmd).includes('list_configs')) return configs;
        return null;
    }),
    restartCore: vi.fn(),
    abortLatencyTests: vi.fn(),
}));
/** @type {Promise<void> | null} A slot the test holds back. */
let slotGate = null;
vi.mock('./sub-download-gate.js', async (importOriginal) => ({ ...(await importOriginal()), subDownloadSlot: async () => { if (slotGate) await slotGate; } }));
vi.mock('../lifecycle.js', () => ({ switchToConfig: vi.fn(), postRestartRecovery: vi.fn() }));
vi.mock('../tray.js', () => ({ updateTrayMenu: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../cache.js', () => ({
    getSettingsCached: vi.fn(async () => ({ ...settings })),
    getConfigsCached: vi.fn(async () => configs),
    invalidateSettingsCache: vi.fn(),
    invalidateConfigsCache: vi.fn(),
}));

import { COMMANDS } from '@zephyr/shared';
import { invoke } from '../../api.js';
import { initSubscriptionSettings, createDownloadGate, _subUpdateStateForTests } from './subscriptions.js';

const names = (/** @type {HTMLElement} */ list) => [...list.querySelectorAll('[data-config-name]')].map(c => /** @type {HTMLElement} */ (c).dataset.configName);

describe('subscription card reorder', () => {
    beforeEach(() => { document.body.replaceChildren(); settings.config_order = ['a.yaml', 'b.yaml', 'c.yaml']; });

    it('cards are focusable, have a drag handle, and Alt+↓ / Alt+↑ move and save', async () => {
        const list = document.createElement('div');
        list.id = 'configs-list';
        document.body.appendChild(list);
        const ctl = initSubscriptionSettings({ subAddBtn: null, updateAllSubBtn: null, configsList: list });
        await ctl.renderConfigs(true);
        expect(names(list)).toEqual(['a.yaml', 'b.yaml', 'c.yaml']);

        const a = /** @type {HTMLElement} */ (list.querySelector('[data-config-name="a.yaml"]'));
        expect(a.tabIndex).toBe(0);
        expect(a.querySelector('.sub-drag-handle')).not.toBeNull();

        a.focus();
        a.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true }));
        await vi.waitFor(() => expect(settings.config_order).toEqual(['b.yaml', 'a.yaml', 'c.yaml']));
        expect(names(list)).toEqual(['b.yaml', 'a.yaml', 'c.yaml']);
        expect(document.activeElement).toBe(a);
        expect(vi.mocked(invoke)).toHaveBeenCalledWith(COMMANDS.SAVE_SETTINGS, expect.anything());

        a.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, bubbles: true }));
        await vi.waitFor(() => expect(settings.config_order).toEqual(['a.yaml', 'b.yaml', 'c.yaml']));

        // Already first: nothing moves.
        a.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, bubbles: true }));
        expect(names(list)).toEqual(['a.yaml', 'b.yaml', 'c.yaml']);
        ctl.destroy();
    });
});

describe('subscription download gate', () => {
    it('spaces downloads past the backend limit and lets the first go at once', async () => {
        let now = 1_000_000;
        // The wall clock jumping ahead must not open a slot early.
        const spy = vi.spyOn(Date, 'now').mockImplementation(() => now + 3_600_000);
        /** @type {number[]} */
        const waits = [];
        const gate = createDownloadGate(5000, async (ms) => { waits.push(ms); now += ms; }, () => now);
        await gate();
        expect(waits).toEqual([]);
        now += 1000;
        // Two follow-ups queued together: each waits for its own slot.
        await Promise.all([gate(), gate()]);
        expect(waits).toEqual([4000, 5000]);
        now += 6000;
        await gate();
        expect(waits).toEqual([4000, 5000]);
        spy.mockRestore();
    });
});

describe('subscription update guards', () => {
    it('refuses a second update after a redraw, runs a queued link once, and clears busy', async () => {
        const subs = [{ name: 'b.yaml', url_display: 'https://x/sub' }];
        const saved = configs.splice(0, configs.length, ...subs);
        /** @type {Array<{ resolve: (v: any) => void, reject: (e: any) => void }>} */
        const pending = [];
        /** @type {any[]} */
        const downloads = [];
        vi.mocked(invoke).mockImplementation(async (/** @type {string} */ cmd, /** @type {any} */ args) => {
            if (cmd === COMMANDS.DOWNLOAD_SUB) {
                downloads.push(args);
                return new Promise((resolve, reject) => { pending.push({ resolve, reject }); });
            }
            if (String(cmd).includes('list_configs')) return subs;
            if (String(cmd).includes('settings')) return { ...settings };
            return null;
        });
        const list = document.createElement('div');
        list.id = 'configs-list';
        document.body.appendChild(list);
        const ctl = initSubscriptionSettings({ subAddBtn: null, updateAllSubBtn: null, configsList: list });
        const updateBtn = () => /** @type {HTMLButtonElement} */ ([...list.querySelectorAll('[data-config-name="b.yaml"] .sub-action-btn')]
            .find((b) => b.querySelector('svg') && b.innerHTML.includes('animate-spin') === false && /update/i.test(b.getAttribute('aria-label') || '')) || list.querySelector('[data-config-name="b.yaml"] .sub-action-btn[aria-busy]'));
        await ctl.renderConfigs(true);
        updateBtn().click();
        await vi.waitFor(() => expect(downloads).toHaveLength(1));
        // A new link saved meanwhile waits for this download.
        _subUpdateStateForTests.followUp.set('b.yaml', 'UA/2');
        await ctl.renderConfigs(true);
        updateBtn().click();
        await new Promise((r) => setTimeout(r, 0));
        expect(downloads).toHaveLength(1);
        // The first download fails: the queued link is fetched once, still busy.
        pending[0].reject(new Error('timeout'));
        await vi.waitFor(() => expect(downloads).toHaveLength(2));
        expect(downloads[1]).toMatchObject({ name: 'b.yaml', userAgent: 'UA/2' });
        expect(_subUpdateStateForTests.updating.has('b.yaml')).toBe(true);
        pending[1].resolve({ name: 'b.yaml' });
        await vi.waitFor(() => expect(_subUpdateStateForTests.updating.has('b.yaml')).toBe(false));
        expect(_subUpdateStateForTests.followUp.size).toBe(0);
        expect(downloads).toHaveLength(2);
        configs.splice(0, configs.length, ...saved);
        ctl.destroy();
    });

    it('lets a download still waiting for its slot take a link saved meanwhile, without a second download', async () => {
        const subs = [{ name: 'b.yaml', url_display: 'https://x/sub' }];
        const saved = configs.splice(0, configs.length, ...subs);
        /** @type {any[]} */
        const downloads = [];
        vi.mocked(invoke).mockImplementation(async (/** @type {string} */ cmd, /** @type {any} */ args) => {
            if (cmd === COMMANDS.DOWNLOAD_SUB) { downloads.push(args); return { name: 'b.yaml' }; }
            if (String(cmd).includes('list_configs')) return subs;
            if (String(cmd).includes('settings')) return { ...settings };
            return null;
        });
        /** @type {() => void} */
        let openSlot = () => {};
        slotGate = new Promise((r) => { openSlot = r; });
        const list = document.createElement('div');
        list.id = 'configs-list';
        document.body.appendChild(list);
        const ctl = initSubscriptionSettings({ subAddBtn: null, updateAllSubBtn: null, configsList: list });
        await ctl.renderConfigs(true);
        const btn = /** @type {HTMLButtonElement} */ ([...list.querySelectorAll('[data-config-name="b.yaml"] .sub-action-btn')]
            .find((b) => /update/i.test(b.getAttribute('aria-label') || '')));
        btn.click();
        await new Promise((r) => setTimeout(r, 0));
        expect(_subUpdateStateForTests.updating.has('b.yaml')).toBe(true);
        // The edit panel saved a new link while the download waited for its slot.
        _subUpdateStateForTests.followUp.set('b.yaml', 'UA/3');
        openSlot();
        slotGate = null;
        await vi.waitFor(() => expect(_subUpdateStateForTests.updating.has('b.yaml')).toBe(false));
        expect(downloads).toHaveLength(1);
        expect(downloads[0]).toMatchObject({ name: 'b.yaml', userAgent: 'UA/3' });
        expect(_subUpdateStateForTests.followUp.size).toBe(0);
        configs.splice(0, configs.length, ...saved);
        ctl.destroy();
    });

    it('sends a user agent saved while the download waited for its slot', async () => {
        const subs = [{ name: 'b.yaml', url_display: 'https://x/sub', user_agent: 'UA/old' }];
        const saved = configs.splice(0, configs.length, ...subs);
        /** @type {any[]} */
        const downloads = [];
        vi.mocked(invoke).mockImplementation(async (/** @type {string} */ cmd, /** @type {any} */ args) => {
            if (cmd === COMMANDS.DOWNLOAD_SUB) { downloads.push(args); return { name: 'b.yaml' }; }
            if (String(cmd).includes('list_configs')) return subs;
            if (String(cmd).includes('settings')) return { ...settings };
            return null;
        });
        /** @type {() => void} */
        let openSlot = () => {};
        slotGate = new Promise((r) => { openSlot = r; });
        const list = document.createElement('div');
        list.id = 'configs-list';
        document.body.appendChild(list);
        const ctl = initSubscriptionSettings({ subAddBtn: null, updateAllSubBtn: null, configsList: list });
        await ctl.renderConfigs(true);
        const btn = /** @type {HTMLButtonElement} */ ([...list.querySelectorAll('[data-config-name="b.yaml"] .sub-action-btn')]
            .find((b) => /update/i.test(b.getAttribute('aria-label') || '')));
        btn.click();
        await new Promise((r) => setTimeout(r, 0));
        expect(_subUpdateStateForTests.waitingUa.get('b.yaml')).toBe('UA/old');
        // The edit panel saved only a new user agent meanwhile.
        _subUpdateStateForTests.waitingUa.set('b.yaml', 'UA/new');
        openSlot();
        slotGate = null;
        await vi.waitFor(() => expect(_subUpdateStateForTests.updating.has('b.yaml')).toBe(false));
        expect(downloads).toHaveLength(1);
        expect(downloads[0]).toMatchObject({ name: 'b.yaml', userAgent: 'UA/new' });
        expect(_subUpdateStateForTests.waitingUa.size).toBe(0);
        configs.splice(0, configs.length, ...saved);
        ctl.destroy();
    });
});
