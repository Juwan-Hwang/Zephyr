import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as yaml from '../../js-yaml.min.js';

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
vi.mock('../lifecycle.js', () => ({
    switchToConfig: vi.fn(),
    postRestartRecovery: vi.fn(),
    withPageBusy: (fn) => fn(),
    restartedProfile: (r, requested) => (r && 'active_config' in r ? r.active_config ?? '' : requested),
    persistActiveConfig: vi.fn(async () => null),
}));
vi.mock('../tray.js', () => ({ updateTrayMenu: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../cache.js', () => ({
    getSettingsCached: vi.fn(async () => ({ ...settings })),
    getConfigsCached: vi.fn(async () => configs),
    invalidateSettingsCache: vi.fn(),
    invalidateConfigsCache: vi.fn(),
}));

import { COMMANDS } from '@zephyr/shared';
import { invoke, restartCore } from '../../api.js';
import { postRestartRecovery, persistActiveConfig } from '../lifecycle.js';
import { appStore } from '../state.js';
import { translations } from '../../i18n.js';
import { initSubscriptionSettings, createDownloadGate, _subUpdateStateForTests, keepFallbackProfile } from './subscriptions.js';

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

describe('subscription rule binding conflicts', () => {
    it.each([false, true])('keeps a menu only while its profile remains in the refreshed list (removed=%s)', async (removed) => {
        document.body.replaceChildren();
        let profiles = [...configs];
        vi.mocked(invoke).mockImplementation(async (command) => {
            if (command === COMMANDS.LIST_CONFIGS) return profiles;
            if (command === COMMANDS.RULE_LIST) return [];
            if (command === COMMANDS.RULE_GROUP_LIST) return { groups: [] };
            if (String(command).includes('settings')) return { ...settings };
            return null;
        });
        const list = document.createElement('div');
        document.body.appendChild(list);
        const ctl = initSubscriptionSettings({ subAddBtn: null, updateAllSubBtn: null, configsList: list });
        try {
            await ctl.renderConfigs(true);
            const origin = list.querySelector('[data-config-name="a.yaml"]');
            origin.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, button: 2 }));
            await vi.waitFor(() => expect(document.querySelector('.ctx-menu-root')).not.toBeNull());
            const menu = document.querySelector('.ctx-menu-root');
            if (removed) profiles = profiles.filter((profile) => profile.name !== 'a.yaml');
            await ctl.renderConfigs(true);
            expect(origin.isConnected).toBe(false);
            expect(menu.isConnected).toBe(!removed);
        } finally { ctl.destroy(); document.body.replaceChildren(); }
    });

    it.each(['close', 'destroy'])('releases a held Retry focus listener when the menu is %s', async (action) => {
        vi.stubGlobal('jsyaml', yaml);
        document.body.replaceChildren();
        let reads = 0;
        let finish;
        vi.mocked(invoke).mockImplementation(async (command) => {
            if (command === COMMANDS.LIST_CONFIGS) return configs;
            if (command === COMMANDS.RULE_LIST) return [{ filename: 'mine.prism.yaml', rule_count: 1 }];
            if (command === COMMANDS.RULE_GROUP_LIST) return { groups: [] };
            if (command === COMMANDS.RULE_READ) {
                if (++reads === 1) throw new Error('Read failed');
                return new Promise((resolve) => { finish = resolve; });
            }
            if (String(command).includes('settings')) return { ...settings };
            return null;
        });
        const list = document.createElement('div');
        document.body.appendChild(list);
        const ctl = initSubscriptionSettings({ subAddBtn: null, updateAllSubBtn: null, configsList: list });
        const added = vi.spyOn(document, 'addEventListener');
        const removed = vi.spyOn(document, 'removeEventListener');
        try {
            await ctl.renderConfigs(true);
            list.querySelector('[data-config-name="a.yaml"]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, button: 2 }));
            await vi.waitFor(() => expect(document.querySelector('button[aria-label*="mine.prism"]')?.classList.contains('hidden')).toBe(false));
            const retry = document.querySelector('button[aria-label*="mine.prism"]');
            retry.focus();
            added.mockClear();
            retry.click();
            const focusListener = added.mock.calls.find(([event]) => event === 'focusin')?.[1];
            expect(focusListener).toBeTypeOf('function');
            if (action === 'destroy') ctl.destroy();
            else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            await vi.waitFor(() => expect(removed).toHaveBeenCalledWith('focusin', focusListener));
        } finally { finish?.('rules: []\n'); ctl.destroy(); added.mockRestore(); removed.mockRestore(); vi.unstubAllGlobals(); document.body.replaceChildren(); }
    });

    it.each([false, true])('destroy closes only its mounted subscription menu (replaced=%s)', async (replaced) => {
        document.body.replaceChildren();
        vi.mocked(invoke).mockImplementation(async (command) => {
            if (command === COMMANDS.LIST_CONFIGS) return configs;
            if (command === COMMANDS.RULE_LIST) return [];
            if (command === COMMANDS.RULE_GROUP_LIST) return { groups: [] };
            if (String(command).includes('settings')) return { ...settings };
            return null;
        });
        const firstList = document.createElement('div');
        const secondList = document.createElement('div');
        document.body.append(firstList, secondList);
        const first = initSubscriptionSettings({ subAddBtn: null, updateAllSubBtn: null, configsList: firstList });
        const second = initSubscriptionSettings({ subAddBtn: null, updateAllSubBtn: null, configsList: secondList });
        try {
            await first.renderConfigs(true);
            firstList.querySelector('[data-config-name="a.yaml"]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, button: 2 }));
            await vi.waitFor(() => expect(document.querySelector('.ctx-menu-root')).not.toBeNull());
            const originalMenu = document.querySelector('.ctx-menu-root');
            if (replaced) {
                await second.renderConfigs(true);
                secondList.querySelector('[data-config-name="b.yaml"]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, button: 2 }));
                await vi.waitFor(() => expect(document.querySelector('.ctx-menu-root')).not.toBeNull());
                expect(document.querySelector('.ctx-menu-root')).not.toBe(originalMenu);
            }
            first.destroy();
            expect(originalMenu.isConnected).toBe(false);
            expect(document.querySelector('.ctx-menu-root') !== null).toBe(replaced);
        } finally { first.destroy(); second.destroy(); document.body.replaceChildren(); }
    });

    it.each(['Escape', 'superseded', 'destroy'])('disposes pending request listeners immediately when %s', async (cancel) => {
        document.body.replaceChildren();
        vi.mocked(invoke).mockImplementation(async (command) => {
            if (command === COMMANDS.LIST_CONFIGS) return configs;
            if (command === COMMANDS.RULE_LIST) return new Promise(() => {});
            if (command === COMMANDS.RULE_GROUP_LIST) return { groups: [] };
            if (String(command).includes('settings')) return { ...settings };
            return null;
        });
        const list = document.createElement('div');
        document.body.appendChild(list);
        const ctl = initSubscriptionSettings({ subAddBtn: null, updateAllSubBtn: null, configsList: list });
        const added = vi.spyOn(document, 'addEventListener');
        const removed = vi.spyOn(document, 'removeEventListener');
        try {
            await ctl.renderConfigs(true);
            added.mockClear();
            list.querySelector('[data-config-name="a.yaml"]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, button: 2 }));
            const pending = added.mock.calls.filter(([type]) => type === 'click' || type === 'keydown');
            if (cancel === 'Escape') document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            else if (cancel === 'destroy') ctl.destroy();
            else list.querySelector('[data-config-name="b.yaml"]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, button: 2 }));
            expect(pending).toHaveLength(2);
            pending.forEach(([type, listener]) => expect(removed).toHaveBeenCalledWith(type, listener, true));
        } finally { ctl.destroy(); added.mockRestore(); removed.mockRestore(); document.body.replaceChildren(); }
    });

    it.each(['click', 'Escape'])('cancels a pending context menu on %s', async (cancel) => {
        document.body.replaceChildren();
        let finish;
        vi.mocked(invoke).mockImplementation(async (command) => {
            if (command === COMMANDS.LIST_CONFIGS) return configs;
            if (command === COMMANDS.RULE_LIST) return new Promise((resolve) => { finish = resolve; });
            if (command === COMMANDS.RULE_GROUP_LIST) return { groups: [] };
            if (String(command).includes('settings')) return { ...settings };
            return null;
        });
        const list = document.createElement('div');
        const action = document.createElement('button');
        action.addEventListener('click', (event) => event.stopPropagation());
        document.body.append(list, action);
        const ctl = initSubscriptionSettings({ subAddBtn: null, updateAllSubBtn: null, configsList: list });
        try {
            await ctl.renderConfigs(true);
            const card = list.querySelector('[data-config-name="a.yaml"]');
            card.focus();
            card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, button: 0 }));
            if (cancel === 'click') action.click();
            else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            finish([]);
            await new Promise((resolve) => setTimeout(resolve, 0));
            expect(document.querySelector('.ctx-menu-root')).toBeNull();
            if (cancel === 'Escape') expect(document.activeElement).toBe(card);
        } finally { ctl.destroy(); document.body.replaceChildren(); }
    });

    it.each(['open', 'closed', 'origin-removed'])('shows a late binding read failure only while its menu is current (%s)', async (state) => {
        document.body.innerHTML = '<div id="notif-container"></div>';
        let fail;
        vi.mocked(invoke).mockImplementation(async (command) => {
            if (command === COMMANDS.LIST_CONFIGS) return configs;
            if (command === COMMANDS.RULE_LIST) return [{ filename: 'mine.prism.yaml', rule_count: 1 }];
            if (command === COMMANDS.RULE_GROUP_LIST) return { groups: [] };
            if (command === COMMANDS.RULE_READ) return new Promise((_resolve, reject) => { fail = reject; });
            if (String(command).includes('settings')) return { ...settings };
            return null;
        });
        const list = document.createElement('div');
        document.body.appendChild(list);
        const ctl = initSubscriptionSettings({ subAddBtn: null, updateAllSubBtn: null, configsList: list });
        try {
            await ctl.renderConfigs(true);
            list.querySelector('[data-config-name="a.yaml"]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, button: 2 }));
            await vi.waitFor(() => expect(document.querySelector('input[data-filename="mine.prism.yaml"]')).not.toBeNull());
            const retry = document.querySelector('input[data-filename="mine.prism.yaml"]').closest('div').querySelector('button');
            if (state === 'closed') document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            if (state === 'origin-removed') list.querySelector('[data-config-name="a.yaml"]').remove();
            fail(new Error('Binding read failed'));
            await new Promise((resolve) => setTimeout(resolve, 0));
            expect(document.getElementById('notif-container').textContent.includes('Binding read failed')).toBe(state !== 'closed');
            expect(retry.classList.contains('hidden')).toBe(state === 'closed');
        } finally { ctl.destroy(); document.body.replaceChildren(); }
    });

    it.each(['success', 'failure', 'moved'])('keeps focus owned by a binding Retry after %s', async (outcome) => {
        vi.stubGlobal('jsyaml', yaml);
        document.body.replaceChildren();
        let reads = 0;
        let complete;
        let fail;
        vi.mocked(invoke).mockImplementation(async (command) => {
            if (command === COMMANDS.LIST_CONFIGS) return configs;
            if (command === COMMANDS.RULE_LIST) return [{ filename: 'mine.prism.yaml', rule_count: 1 }];
            if (command === COMMANDS.RULE_GROUP_LIST) return { groups: [] };
            if (command === COMMANDS.RULE_READ) {
                if (++reads === 1) throw new Error('Initial read failed');
                return new Promise((resolve, reject) => { complete = resolve; fail = reject; });
            }
            if (String(command).includes('settings')) return { ...settings };
            return null;
        });
        const list = document.createElement('div');
        const other = document.createElement('button');
        document.body.append(list, other);
        const ctl = initSubscriptionSettings({ subAddBtn: null, updateAllSubBtn: null, configsList: list });
        try {
            await ctl.renderConfigs(true);
            list.querySelector('[data-config-name="a.yaml"]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, button: 2 }));
            await vi.waitFor(() => expect(document.querySelector('button[aria-label*="mine.prism"]')?.classList.contains('hidden')).toBe(false));
            const retry = document.querySelector('button[aria-label*="mine.prism"]');
            const checkbox = document.querySelector('input[data-filename="mine.prism.yaml"]');
            retry.focus();
            retry.click();
            if (outcome === 'moved') other.focus();
            if (outcome === 'failure') fail(new Error('Retry failed'));
            else complete('rules: []\n');
            await vi.waitFor(() => expect(retry.disabled).toBe(false));
            expect(document.activeElement).toBe(outcome === 'moved' ? other : outcome === 'failure' ? retry : checkbox);
        } finally { complete?.('rules: []\n'); ctl.destroy(); vi.unstubAllGlobals(); document.body.replaceChildren(); }
    });

    it.each([false, true])('ignores stale menu requests and removed origin cards (removed=%s)', async (removed) => {
        vi.stubGlobal('jsyaml', yaml);
        document.body.replaceChildren();
        const replies = [];
        vi.mocked(invoke).mockImplementation(async (command) => {
            if (command === COMMANDS.LIST_CONFIGS) return configs;
            if (command === COMMANDS.RULE_LIST) return new Promise((resolve) => { replies.push(resolve); });
            if (command === COMMANDS.RULE_GROUP_LIST) return { groups: [] };
            if (command === COMMANDS.RULE_READ) return 'rules: []\n';
            if (String(command).includes('settings')) return { ...settings };
            return null;
        });
        const list = document.createElement('div');
        document.body.appendChild(list);
        const ctl = initSubscriptionSettings({ subAddBtn: null, updateAllSubBtn: null, configsList: list });
        try {
            await ctl.renderConfigs(true);
            list.querySelector('[data-config-name="a.yaml"]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, button: 2 }));
            list.querySelector('[data-config-name="b.yaml"]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, button: 2 }));
            expect(replies).toHaveLength(2);
            if (removed) list.querySelector('[data-config-name="b.yaml"]').remove();
            replies[1]([{ filename: 'newest.prism.yaml', rule_count: 1 }]);
            if (!removed) await vi.waitFor(() => expect(document.querySelector('input[data-filename="newest.prism.yaml"]')).not.toBeNull());
            replies[0]([{ filename: 'stale.prism.yaml', rule_count: 1 }]);
            await new Promise((resolve) => setTimeout(resolve, 0));
            expect(document.querySelectorAll('.ctx-menu-root')).toHaveLength(removed ? 0 : 1);
            expect(document.querySelector('input[data-filename="stale.prism.yaml"]')).toBeNull();
            if (!removed) expect(document.querySelector('input[data-filename="newest.prism.yaml"]')).not.toBeNull();
        } finally { ctl.destroy(); vi.unstubAllGlobals(); document.body.replaceChildren(); }
    });

    it.each(['en', 'zh'])('shows localized pattern-binding guidance in %s', async (language) => {
        const priorLanguage = appStore.get('currentLang');
        appStore.set('currentLang', language);
        vi.stubGlobal('jsyaml', yaml);
        document.body.replaceChildren();
        let writes = 0;
        let reads = 0;
        vi.mocked(invoke).mockImplementation(async (command) => {
            if (command === COMMANDS.RULE_LIST) return [{ filename: 'mine.prism.yaml', rule_count: 1 }];
            if (command === COMMANDS.RULE_GROUP_LIST) return { groups: [] };
            if (command === COMMANDS.LIST_CONFIGS) return configs;
            if (command === COMMANDS.RULE_READ) { reads++; return '__when__: { profile: ["a*"] }\nrules: []\n'; }
            if (command === COMMANDS.RULE_UPDATE) { writes++; return null; }
            if (String(command).includes('settings')) return { ...settings };
            return null;
        });
        const list = document.createElement('div');
        document.body.appendChild(list);
        const ctl = initSubscriptionSettings({ subAddBtn: null, updateAllSubBtn: null, configsList: list });
        try {
            await ctl.renderConfigs(true);
            list.querySelector('[data-config-name="a.yaml"]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, button: 2 }));
            await vi.waitFor(() => expect(document.querySelector('input[data-filename="mine.prism.yaml"]')?.indeterminate).toBe(true));
            const checkbox = document.querySelector('input[data-filename="mine.prism.yaml"]');
            expect(checkbox.disabled).toBe(true);
            expect(checkbox.title).toBe(translations[language].ruleBindingPatternHint);
            expect(checkbox.closest('label').parentElement.querySelector('span[title]').title).toBe(checkbox.title);
            expect(checkbox.closest('label').parentElement.textContent).toContain('YAML');
            expect(document.querySelector('button[aria-label*="mine.prism"]').classList.contains('hidden')).toBe(true);
            const readsAtLoad = reads;
            checkbox.dispatchEvent(new Event('change'));
            expect(reads).toBe(readsAtLoad);
            expect(writes).toBe(0);
        } finally { ctl.destroy(); appStore.set('currentLang', priorLanguage); vi.unstubAllGlobals(); document.body.replaceChildren(); }
    });

    it.each([{ readFails: false, freshBound: true }, { readFails: false, freshBound: false }, { readFails: true, freshBound: true }])('reloads a conflicting binding before enabling its checkbox: %j', async ({ readFails, freshBound }) => {
        vi.stubGlobal('jsyaml', yaml);
        document.body.replaceChildren();
        let reads = 0;
        vi.mocked(invoke).mockImplementation(async (command) => {
            if (command === COMMANDS.RULE_LIST) return [{ filename: 'mine.prism.yaml', rule_count: 1 }];
            if (command === COMMANDS.RULE_GROUP_LIST) return { groups: [] };
            if (command === COMMANDS.LIST_CONFIGS) return configs;
            if (command === COMMANDS.RULE_READ) {
                reads++;
                if (reads >= 3 && readFails) throw new Error('read failed');
                return reads >= 3 ? `# changed by another editor\n__when__: { profile: [${freshBound ? 'a, b' : 'b'}] }\nrules: []\n` : '__when__: { profile: [a] }\nrules: []\n';
            }
            if (command === COMMANDS.RULE_UPDATE) throw new Error('RULE_FILE_CHANGED: Reopen and retry.');
            if (String(command).includes('settings')) return { ...settings };
            return null;
        });
        const list = document.createElement('div');
        document.body.appendChild(list);
        const ctl = initSubscriptionSettings({ subAddBtn: null, updateAllSubBtn: null, configsList: list });
        try {
            await ctl.renderConfigs(true);
            list.querySelector('[data-config-name="a.yaml"]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
            await vi.waitFor(() => expect(document.querySelector('input[data-filename="mine.prism.yaml"]')?.disabled).toBe(false));
            const checkbox = document.querySelector('input[data-filename="mine.prism.yaml"]');
            expect(checkbox.checked).toBe(true);
            checkbox.checked = false;
            checkbox.dispatchEvent(new Event('change'));
            await vi.waitFor(() => expect(reads).toBe(3));
            if (readFails) {
                await vi.waitFor(() => expect(document.querySelector('button[aria-label*="mine.prism"]')?.classList.contains('hidden')).toBe(false));
                expect(checkbox.disabled).toBe(true);
            } else {
                await vi.waitFor(() => expect(checkbox.disabled).toBe(false));
                expect(checkbox.checked).toBe(freshBound);
            }
        } finally {
            ctl.destroy();
            vi.unstubAllGlobals();
            document.body.replaceChildren();
        }
    });

    it.each([false, true])('uses the fresh binding and only writes a real change (alreadySaved=%s)', async (alreadySaved) => {
        vi.stubGlobal('jsyaml', yaml);
        document.body.replaceChildren();
        let reads = 0;
        let writes = 0;
        let rebuilds = 0;
        let writeArgs;
        const latest = `__when__: {profile: [${alreadySaved ? 'b' : 'a, b'}]}\nrules: []\n`;
        vi.mocked(invoke).mockImplementation(async (command, args) => {
            if (command === COMMANDS.RULE_LIST) return [{ filename: 'mine.prism.yaml', rule_count: 1 }];
            if (command === COMMANDS.RULE_GROUP_LIST) return { groups: [] };
            if (command === COMMANDS.LIST_CONFIGS) return configs;
            if (command === COMMANDS.RULE_READ) return ++reads === 1 ? '__when__: {profile: [a]}\nrules: []\n' : latest;
            if (command === COMMANDS.RULE_UPDATE) { writes++; writeArgs = args; throw new Error('Disk is full'); }
            if (command === COMMANDS.PRISM.REBUILD) { rebuilds++; return null; }
            if (String(command).includes('settings')) return { ...settings };
            return null;
        });
        const list = document.createElement('div');
        document.body.appendChild(list);
        const ctl = initSubscriptionSettings({ subAddBtn: null, updateAllSubBtn: null, configsList: list });
        try {
            await ctl.renderConfigs(true);
            list.querySelector('[data-config-name="a.yaml"]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, button: 2 }));
            await vi.waitFor(() => expect(document.querySelector('input[data-filename="mine.prism.yaml"]')?.disabled).toBe(false));
            const checkbox = document.querySelector('input[data-filename="mine.prism.yaml"]');
            checkbox.checked = false;
            checkbox.dispatchEvent(new Event('change'));
            await vi.waitFor(() => expect(reads).toBe(2));
            await vi.waitFor(() => expect(checkbox.disabled).toBe(false));
            expect(writes).toBe(alreadySaved ? 0 : 1);
            if (!alreadySaved) {
                expect(writeArgs.expectedContent).toBe(latest);
                expect(yaml.load(writeArgs.content).__when__.profile).toEqual(['b']);
            }
            expect(rebuilds).toBe(0);
            expect(checkbox.checked).toBe(!alreadySaved);
        } finally { ctl.destroy(); vi.unstubAllGlobals(); document.body.replaceChildren(); }
    });

    it('enumerates current profiles only when a global rule is unchecked', async () => {
        vi.stubGlobal('jsyaml', yaml);
        document.body.replaceChildren();
        let profiles = [{ name: 'a.yaml' }, { name: 'b.yaml' }];
        let saved;
        vi.mocked(invoke).mockImplementation(async (command, args) => {
            if (command === COMMANDS.RULE_LIST) return [{ filename: 'mine.prism.yaml', rule_count: 1 }];
            if (command === COMMANDS.RULE_GROUP_LIST) return { groups: [] };
            if (command === COMMANDS.LIST_CONFIGS) return profiles;
            if (command === COMMANDS.RULE_READ) return 'rules: []\n';
            if (command === COMMANDS.RULE_UPDATE) { saved = args.content; return null; }
            if (String(command).includes('settings')) return { ...settings };
            return null;
        });
        const list = document.createElement('div');
        document.body.appendChild(list);
        const ctl = initSubscriptionSettings({ subAddBtn: null, updateAllSubBtn: null, configsList: list });
        try {
            await ctl.renderConfigs(true);
            list.querySelector('[data-config-name="a.yaml"]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, button: 2 }));
            await vi.waitFor(() => expect(document.querySelector('input[data-filename="mine.prism.yaml"]')?.disabled).toBe(false));
            profiles = [...profiles, { name: 'c.yaml' }];
            const checkbox = document.querySelector('input[data-filename="mine.prism.yaml"]');
            checkbox.checked = false;
            checkbox.dispatchEvent(new Event('change'));
            await vi.waitFor(() => expect(saved).toBeTypeOf('string'));
            expect(yaml.load(saved).__when__.profile).toEqual(['b', 'c']);
            await vi.waitFor(() => expect(checkbox.disabled).toBe(false));
        } finally { ctl.destroy(); vi.unstubAllGlobals(); document.body.replaceChildren(); }
    });

    it('restores keyboard focus to a subscription card replaced during the open menu', async () => {
        document.body.replaceChildren();
        vi.mocked(invoke).mockImplementation(async (command) => {
            if (command === COMMANDS.LIST_CONFIGS) return configs;
            if (command === COMMANDS.RULE_LIST) return [];
            if (command === COMMANDS.RULE_GROUP_LIST) return { groups: [] };
            if (String(command).includes('settings')) return { ...settings };
            return null;
        });
        const list = document.createElement('div');
        document.body.appendChild(list);
        const ctl = initSubscriptionSettings({ subAddBtn: null, updateAllSubBtn: null, configsList: list });
        try {
            await ctl.renderConfigs(true);
            const card = list.querySelector('[data-config-name="a.yaml"]');
            card.focus();
            card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, button: 0 }));
            await vi.waitFor(() => expect(document.querySelector('.ctx-menu-root button')).not.toBeNull());
            await ctl.renderConfigs(true);
            const replacement = list.querySelector('[data-config-name="a.yaml"]');
            expect(replacement).not.toBe(card);
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
            expect(document.activeElement).toBe(replacement);
        } finally { ctl.destroy(); document.body.replaceChildren(); }
    });

    it('keeps the saved binding and reports DNS restoration separately after a confirmed reload', async () => {
        vi.stubGlobal('jsyaml', yaml);
        document.body.innerHTML = '<div id="notif-container"></div>';
        vi.mocked(invoke).mockImplementation(async (command) => {
            if (command === COMMANDS.LIST_CONFIGS) return configs;
            if (command === COMMANDS.RULE_LIST) return [{ filename: 'mine.prism.yaml', rule_count: 1 }];
            if (command === COMMANDS.RULE_GROUP_LIST) return { groups: [] };
            if (command === COMMANDS.RULE_READ) return '__when__: {profile: [a, b]}\nrules: []\n';
            if (command === COMMANDS.PRISM.REBUILD) return { hot_reload_success: false, core_reload_confirmed: true, runtime_restore_success: false };
            if (String(command).includes('settings')) return { ...settings };
            return null;
        });
        const list = document.createElement('div');
        document.body.appendChild(list);
        const ctl = initSubscriptionSettings({ subAddBtn: null, updateAllSubBtn: null, configsList: list });
        try {
            await ctl.renderConfigs(true);
            list.querySelector('[data-config-name="a.yaml"]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, button: 2 }));
            await vi.waitFor(() => expect(document.querySelector('input[data-filename="mine.prism.yaml"]')?.disabled).toBe(false));
            const checkbox = document.querySelector('input[data-filename="mine.prism.yaml"]');
            checkbox.checked = false;
            checkbox.dispatchEvent(new Event('change'));
            await vi.waitFor(() => expect(document.getElementById('notif-container').textContent).toContain('DNS'));
            expect(checkbox.checked).toBe(false);
            expect(document.getElementById('notif-container').textContent).toContain(translations[appStore.get('currentLang')].rulesLoadedDnsRestoreFailed);
        } finally { ctl.destroy(); vi.unstubAllGlobals(); document.body.replaceChildren(); }
    });

    it('focuses keyboard-opened rule menu actions and returns focus on Escape', async () => {
        const { initTablistKeys } = await import('../tablist-keys.js');
        const cleanupKeys = initTablistKeys();
        document.body.replaceChildren();
        vi.mocked(invoke).mockImplementation(async (command) => {
            if (command === COMMANDS.LIST_CONFIGS) return configs;
            if (command === COMMANDS.RULE_LIST) return [];
            if (command === COMMANDS.RULE_GROUP_LIST) return { groups: [] };
            if (String(command).includes('settings')) return { ...settings };
            return null;
        });
        const list = document.createElement('div');
        document.body.appendChild(list);
        const ctl = initSubscriptionSettings({ subAddBtn: null, updateAllSubBtn: null, configsList: list });
        try {
            await ctl.renderConfigs(true);
            const card = list.querySelector('[data-config-name="a.yaml"]');
            card.focus();
            card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, button: 0 }));
            await vi.waitFor(() => expect(document.querySelector('.ctx-menu-root button')).not.toBeNull());
            expect(document.activeElement).toBe(document.querySelector('.ctx-menu-root button'));
            expect(document.querySelectorAll('.ctx-menu-root button')).toHaveLength(2);
            document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
            expect(document.querySelector('.ctx-menu-root')).toBeNull();
            expect(document.activeElement).toBe(card);
            card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, button: 0 }));
            await vi.waitFor(() => expect(document.querySelector('.ctx-menu-root button')).not.toBeNull());
            document.querySelector('.ctx-menu-root button').click();
            await vi.waitFor(() => expect(document.getElementById('edit-auto-update')).not.toBeNull());
            const interval = document.getElementById('edit-auto-update');
            const choices = interval.querySelectorAll('.choice-card');
            expect(choices[0].tabIndex).toBe(0);
            expect(choices[1].tabIndex).toBe(-1);
            choices[0].focus();
            choices[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
            expect(interval.dataset.value).toBe('43200');
            expect(document.activeElement).toBe(choices[1]);
            expect(choices[1].getAttribute('aria-checked')).toBe('true');
            document.getElementById('edit-modal-close').click();
            await new Promise((resolve) => setTimeout(resolve, 350));
        } finally { cleanupKeys(); ctl.destroy(); document.body.replaceChildren(); }
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

    it('restarts the core for the updated current profile only once the network lock is free, and holds it meanwhile', async () => {
        const subs = [{ name: 'a.yaml', url_display: 'https://x/sub' }];
        const saved = configs.splice(0, configs.length, ...subs);
        let downloaded = false;
        vi.mocked(invoke).mockImplementation(async (/** @type {string} */ cmd) => {
            if (cmd === COMMANDS.DOWNLOAD_SUB) { downloaded = true; return null; }
            if (String(cmd).includes('list_configs')) return subs;
            if (String(cmd).includes('settings')) return { ...settings };
            return null;
        });
        /** @type {boolean[]} */
        const lockDuringRestart = [];
        vi.mocked(restartCore).mockReset().mockImplementation(async () => { lockDuringRestart.push(appStore.get('isNetworkUpdating')); return /** @type {any} */ ({}); });
        const list = document.createElement('div');
        list.id = 'configs-list';
        document.body.appendChild(list);
        const ctl = initSubscriptionSettings({ subAddBtn: null, updateAllSubBtn: null, configsList: list });
        await ctl.renderConfigs(true);
        // A core update holds the lock while this download finishes.
        appStore.set('isNetworkUpdating', true);
        const btn = /** @type {HTMLButtonElement} */ ([...list.querySelectorAll('[data-config-name="a.yaml"] .sub-action-btn')]
            .find((b) => /update/i.test(b.getAttribute('aria-label') || '')));
        btn.click();
        await vi.waitFor(() => expect(downloaded).toBe(true));
        await new Promise((r) => setTimeout(r, 300));
        expect(restartCore).not.toHaveBeenCalled();
        appStore.set('isNetworkUpdating', false);
        await vi.waitFor(() => expect(restartCore).toHaveBeenCalledTimes(1), { timeout: 2000 });
        expect(lockDuringRestart).toEqual([true]);
        await vi.waitFor(() => expect(appStore.get('isNetworkUpdating')).toBe(false));
        configs.splice(0, configs.length, ...saved);
        ctl.destroy();
    });

    it('skips the restart when a switch to another profile finished while it waited for the lock', async () => {
        const subs = [{ name: 'a.yaml', url_display: 'https://x/sub' }];
        const saved = configs.splice(0, configs.length, ...subs);
        let downloaded = false;
        let lastConfig = 'a.yaml';
        vi.mocked(invoke).mockImplementation(async (/** @type {string} */ cmd) => {
            if (cmd === COMMANDS.DOWNLOAD_SUB) { downloaded = true; return null; }
            if (String(cmd).includes('list_configs')) return subs;
            if (String(cmd).includes('settings')) return { ...settings, last_config: lastConfig };
            return null;
        });
        vi.mocked(restartCore).mockReset().mockResolvedValue(/** @type {any} */ ({}));
        const list = document.createElement('div');
        list.id = 'configs-list';
        document.body.appendChild(list);
        const ctl = initSubscriptionSettings({ subAddBtn: null, updateAllSubBtn: null, configsList: list });
        await ctl.renderConfigs(true);
        appStore.set('isNetworkUpdating', true);
        const btn = /** @type {HTMLButtonElement} */ ([...list.querySelectorAll('[data-config-name="a.yaml"] .sub-action-btn')]
            .find((b) => /update/i.test(b.getAttribute('aria-label') || '')));
        btn.click();
        await vi.waitFor(() => expect(downloaded).toBe(true));
        await new Promise((r) => setTimeout(r, 300));
        // The switch holding the lock moves to b.yaml, then lets go.
        lastConfig = 'b.yaml';
        appStore.set('isNetworkUpdating', false);
        await new Promise((r) => setTimeout(r, 500));
        expect(restartCore).not.toHaveBeenCalled();
        await vi.waitFor(() => expect(appStore.get('isNetworkUpdating')).toBe(false));
        configs.splice(0, configs.length, ...saved);
        ctl.destroy();
    });

    it('restarts the updated profile when a switch to it finished while it waited for the lock', async () => {
        const subs = [{ name: 'a.yaml', url_display: 'https://x/sub' }, { name: 'b.yaml', url_display: 'https://x/b' }];
        const saved = configs.splice(0, configs.length, ...subs);
        let downloaded = false;
        let lastConfig = 'a.yaml';
        vi.mocked(invoke).mockImplementation(async (/** @type {string} */ cmd) => {
            if (cmd === COMMANDS.DOWNLOAD_SUB) { downloaded = true; return null; }
            if (String(cmd).includes('list_configs')) return subs;
            if (String(cmd).includes('settings')) return { ...settings, last_config: lastConfig };
            return null;
        });
        vi.mocked(restartCore).mockReset().mockResolvedValue(/** @type {any} */ ({}));
        const list = document.createElement('div');
        list.id = 'configs-list';
        document.body.appendChild(list);
        const ctl = initSubscriptionSettings({ subAddBtn: null, updateAllSubBtn: null, configsList: list });
        await ctl.renderConfigs(true);
        // A switch from a.yaml to b.yaml holds the lock; settings still name a.yaml.
        appStore.set('isNetworkUpdating', true);
        const btn = /** @type {HTMLButtonElement} */ ([...list.querySelectorAll('[data-config-name="b.yaml"] .sub-action-btn')]
            .find((b) => /update/i.test(b.getAttribute('aria-label') || '')));
        btn.click();
        await vi.waitFor(() => expect(downloaded).toBe(true));
        await new Promise((r) => setTimeout(r, 300));
        expect(restartCore).not.toHaveBeenCalled();
        lastConfig = 'b.yaml';
        appStore.set('isNetworkUpdating', false);
        await vi.waitFor(() => expect(restartCore).toHaveBeenCalledTimes(1), { timeout: 2000 });
        expect(vi.mocked(restartCore).mock.calls[0][0]).toBe('b.yaml');
        await vi.waitFor(() => expect(appStore.get('isNetworkUpdating')).toBe(false));
        configs.splice(0, configs.length, ...saved);
        ctl.destroy();
    });

    it('after updating all, restarts an updated profile a switch finished loading while it waited for the lock', async () => {
        const subs = [{ name: 'a.yaml', url_display: 'https://x/sub' }, { name: 'b.yaml', url_display: 'https://x/b' }];
        const saved = configs.splice(0, configs.length, ...subs);
        let batched = false;
        let lastConfig = 'a.yaml';
        vi.mocked(invoke).mockImplementation(async (/** @type {string} */ cmd) => {
            if (cmd === COMMANDS.DOWNLOAD_SUB_BATCH) { batched = true; return [{ name: 'a.yaml', success: false, error: 'x' }, { name: 'b.yaml', success: true }]; }
            if (String(cmd).includes('list_configs')) return subs;
            if (String(cmd).includes('settings')) return { ...settings, last_config: lastConfig };
            return null;
        });
        vi.mocked(restartCore).mockReset().mockResolvedValue(/** @type {any} */ ({}));
        const list = document.createElement('div');
        list.id = 'configs-list';
        const allBtn = document.createElement('button');
        allBtn.innerHTML = '<svg></svg>';
        document.body.append(list, allBtn);
        const ctl = initSubscriptionSettings({ subAddBtn: null, updateAllSubBtn: allBtn, configsList: list });
        await ctl.renderConfigs(true);
        // A switch from a.yaml to b.yaml holds the lock; settings still name a.yaml.
        appStore.set('isNetworkUpdating', true);
        allBtn.click();
        await vi.waitFor(() => expect(batched).toBe(true));
        await new Promise((r) => setTimeout(r, 300));
        expect(restartCore).not.toHaveBeenCalled();
        lastConfig = 'b.yaml';
        appStore.set('isNetworkUpdating', false);
        await vi.waitFor(() => expect(restartCore).toHaveBeenCalledTimes(1), { timeout: 2000 });
        expect(vi.mocked(restartCore).mock.calls[0][0]).toBe('b.yaml');
        await vi.waitFor(() => expect(appStore.get('isNetworkUpdating')).toBe(false));
        configs.splice(0, configs.length, ...saved);
        ctl.destroy();
    });

    it('runs recovery for the profile the restart actually loaded', async () => {
        const subs = [{ name: 'a.yaml', url_display: 'https://x/sub' }];
        const saved = configs.splice(0, configs.length, ...subs);
        vi.mocked(invoke).mockImplementation(async (/** @type {string} */ cmd) => {
            if (cmd === COMMANDS.DOWNLOAD_SUB) return null;
            if (String(cmd).includes('list_configs')) return subs;
            if (String(cmd).includes('settings')) return { ...settings, last_config: 'a.yaml' };
            return null;
        });
        // The fresh file fails to load: the core falls back to the minimal config.
        vi.mocked(restartCore).mockReset().mockResolvedValue(/** @type {any} */ ({ active_config: null }));
        vi.mocked(postRestartRecovery).mockReset().mockResolvedValue(/** @type {any} */ ({ failed: 0 }));
        const list = document.createElement('div');
        list.id = 'configs-list';
        document.body.appendChild(list);
        const ctl = initSubscriptionSettings({ subAddBtn: null, updateAllSubBtn: null, configsList: list });
        await ctl.renderConfigs(true);
        const btn = /** @type {HTMLButtonElement} */ ([...list.querySelectorAll('[data-config-name="a.yaml"] .sub-action-btn')]
            .find((b) => /update/i.test(b.getAttribute('aria-label') || '')));
        btn.click();
        await vi.waitFor(() => expect(postRestartRecovery).toHaveBeenCalledWith(''));
        await vi.waitFor(() => expect(appStore.get('isNetworkUpdating')).toBe(false));
        expect(appStore.get('noSubscription')).toBe(true);
        appStore.set('noSubscription', false);
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

describe('restart after a subscription update', () => {
    it('saves the profile the core fell back to, and nothing otherwise', async () => {
        vi.mocked(persistActiveConfig).mockClear();
        await keepFallbackProfile({ active_config: 'b.yaml' }, 'a.yaml');
        expect(persistActiveConfig).toHaveBeenCalledWith('b.yaml');

        vi.mocked(persistActiveConfig).mockClear();
        await keepFallbackProfile({ active_config: 'a' }, 'a.yaml');
        await keepFallbackProfile({ active_config: null }, 'a.yaml');
        await keepFallbackProfile({}, 'a.yaml');
        expect(persistActiveConfig).not.toHaveBeenCalled();
    });

    it('treats a.yml and a.yaml, or A.yaml and a.yaml, as two profiles', async () => {
        vi.mocked(persistActiveConfig).mockClear();
        expect(await keepFallbackProfile({ active_config: 'a.yml' }, 'a.yaml')).toBe(true);
        expect(persistActiveConfig).toHaveBeenCalledWith('a.yml');

        // The core reports the name it was given; Linux keeps both cases.
        vi.mocked(persistActiveConfig).mockClear();
        expect(await keepFallbackProfile({ active_config: 'A.yaml' }, 'a.yaml')).toBe(true);
        expect(persistActiveConfig).toHaveBeenCalledWith('A.yaml');

        // Without an extension the case still has to match.
        vi.mocked(persistActiveConfig).mockClear();
        expect(await keepFallbackProfile({ active_config: 'A.yaml' }, 'a')).toBe(true);
        expect(persistActiveConfig).toHaveBeenCalledWith('A.yaml');

        vi.mocked(persistActiveConfig).mockClear();
        expect(await keepFallbackProfile({ active_config: 'a.yaml' }, 'a.yaml')).toBe(false);
        expect(await keepFallbackProfile({ active_config: 'a.yaml' }, 'a')).toBe(false);
        expect(persistActiveConfig).not.toHaveBeenCalled();
    });

    it('marks the minimal config as no subscription and keeps the saved profile', async () => {
        vi.mocked(persistActiveConfig).mockClear();
        appStore.set('noSubscription', false);
        await keepFallbackProfile({ active_config: null }, 'a.yaml');
        expect(appStore.get('noSubscription')).toBe(true);
        expect(persistActiveConfig).not.toHaveBeenCalled();
        appStore.set('noSubscription', false);
    });

    it('does not warn of a broken profile when there was none to load', async () => {
        // The returned flag says whether the user was warned. config.yaml is
        // not in the list: the core had nothing to load, rejected nothing.
        vi.mocked(invoke).mockImplementation(async (/** @type {string} */ cmd) => (cmd === COMMANDS.LIST_CONFIGS ? [{ name: 'a.yaml' }] : null));
        appStore.set('noSubscription', false);
        expect(await keepFallbackProfile({ active_config: null }, 'config.yaml')).toBe(false);
        expect(appStore.get('noSubscription')).toBe(true);

        appStore.set('noSubscription', false);
        expect(await keepFallbackProfile({ active_config: null }, 'a.yaml')).toBe(true);
        appStore.set('noSubscription', false);
    });
});
