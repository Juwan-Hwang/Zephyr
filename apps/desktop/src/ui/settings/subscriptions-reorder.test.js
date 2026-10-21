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
import { initSubscriptionSettings, createDownloadGate } from './subscriptions.js';

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
        const spy = vi.spyOn(Date, 'now').mockImplementation(() => now);
        /** @type {number[]} */
        const waits = [];
        const gate = createDownloadGate(5000, async (ms) => { waits.push(ms); now += ms; });
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
