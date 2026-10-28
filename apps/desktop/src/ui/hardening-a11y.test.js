// @ts-check
import { describe, it, expect, vi, afterEach } from 'vitest';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn().mockResolvedValue([]) }));

vi.mock('../api.js', () => ({
    invoke: invokeMock,
    closeAllConnections: vi.fn(),
    switchProxy: vi.fn(),
    getProxies: vi.fn(),
    SPECIAL_PROXY_NAMES: new Set(),
}));

import { updateModeUI } from './modes.js';
import { pluginExecuteHook } from './prism.js';
import { readSrc as read, parseIndex } from '../test/index-dom.js';

afterEach(() => {
    document.body.innerHTML = '';
    invokeMock.mockClear();
});

describe('home and settings page switches and theme swatches accessibility', () => {
    it('app toggles have valid aria-labelledby and aria-describedby references', () => {
        const doc = parseIndex();
        const switches = [
            { toggleId: 'sys-proxy-toggle', titleId: 'sys-proxy-title', descId: 'proxy-status-text' },
            { toggleId: 'tun-proxy-toggle', titleId: 'home-tun-title', descId: 'tun-status-text' },
            { toggleId: 'setting-failover', titleId: 'setting-failover-title', descId: 'setting-failover-desc' },
            { toggleId: 'smart-toggle', titleId: 'smart-toggle-title', descId: 'smart-toggle-desc' },
            { toggleId: 'smart-auto-test-toggle', titleId: 'smart-auto-test-title', descId: 'smart-auto-test-desc' },
            { toggleId: 'dns-rewrite-toggle', titleId: 'setting-dns-rewrite-title', descId: 'setting-dns-rewrite-desc' },
        ];
        for (const { toggleId, titleId, descId } of switches) {
            const toggle = doc.getElementById(toggleId);
            expect(toggle, toggleId).toBeTruthy();
            expect(toggle?.getAttribute('aria-labelledby')).toBe(titleId);
            expect(toggle?.getAttribute('aria-describedby')).toBe(descId);

            expect(doc.getElementById(titleId), titleId).toBeTruthy();
            expect(doc.getElementById(descId), descId).toBeTruthy();
        }

        const modalSwitches = [
            { file: 'ui/global-shortcut.js', toggleId: 'shortcut-enable-toggle', labelId: 'shortcut-enable-label' },
            { file: 'ui/settings.js', toggleId: 'log-app-toggle', labelId: 'log-app-label' },
            { file: 'ui/settings.js', toggleId: 'log-core-toggle', labelId: 'log-core-label' },
        ];
        for (const { file, toggleId, labelId } of modalSwitches) {
            const src = read(file);
            expect(src, file).toContain(`id="${labelId}"`);
            // The association must live on the toggle input itself: a bare
            // string search would stay green if the attribute moved to some
            // other element, so find the input tag by id and check its own
            // aria-labelledby.
            const inputTag = src
                .match(/<input[^>]*>/g)
                ?.find((tag) => tag.includes(`id="${toggleId}"`));
            expect(inputTag, `${file}:${toggleId}`).toBeTruthy();
            expect(inputTag, `${file}:${toggleId}`).toContain(
                `aria-labelledby="${labelId}"`,
            );
        }

        const portBtn = doc.getElementById('port-config-btn');
        expect(portBtn).toBeTruthy();
        expect(portBtn?.getAttribute('aria-labelledby')).toBe('setting-port-title current-port-display');
        expect(portBtn?.getAttribute('aria-describedby')).toBe('setting-port-desc');
        // The referenced IDs must resolve to real elements, otherwise the
        // association silently does nothing for screen readers.
        for (const id of (portBtn?.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean)) {
            expect(doc.getElementById(id), id).toBeTruthy();
        }
        for (const id of (portBtn?.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean)) {
            expect(doc.getElementById(id), id).toBeTruthy();
        }
    });

    it('DNS and Port configuration modal inputs have valid aria-describedby associations', () => {
        const doc = parseIndex();
        const modalFields = [
            { inputId: 'dns-nameservers-input', descId: 'dns-nameservers-hint' },
            { inputId: 'dns-fallbacks-input', descId: 'dns-fallbacks-hint' },
            { inputId: 'port-mixed-input', descId: 'port-mixed-hint' },
            { inputId: 'port-socks-input', descId: 'port-socks-hint' },
        ];
        for (const { inputId, descId } of modalFields) {
            const input = doc.getElementById(inputId);
            expect(input, inputId).toBeTruthy();
            expect(input?.getAttribute('aria-describedby')).toBe(descId);
            expect(doc.getElementById(descId), descId).toBeTruthy();
        }
    });

    it('settings segmented controls carry role="group" and translatable aria-labels', () => {
        const doc = parseIndex();
        const controls = [
            { id: 'setting-theme-mode-container', key: 'theme' },
            { id: 'setting-home-mode-container', key: 'homePageMode' },
        ];
        for (const { id, key } of controls) {
            const el = doc.getElementById(id);
            expect(el, id).toBeTruthy();
            expect(el?.getAttribute('role')).toBe('group');
            expect(el?.getAttribute('aria-label')).toBeTruthy();
            expect(el?.getAttribute('data-i18n-aria-label')).toBe(key);
        }
    });

    it('preset and custom theme color swatches carry translatable aria-labels and titles', () => {
        const doc = parseIndex();
        const swatches = [
            { theme: 'blue', key: 'themeColorBlue' },
            { theme: 'green', key: 'themeColorGreen' },
            { theme: 'orange', key: 'themeColorOrange' },
            { theme: 'pink', key: 'themeColorPink' },
        ];
        for (const { theme, key } of swatches) {
            const btn = doc.querySelector(`button.theme-swatch[data-theme="${theme}"]`);
            expect(btn, theme).toBeTruthy();
            expect(btn?.getAttribute('aria-label')).toBeTruthy();
            expect(btn?.getAttribute('data-i18n-aria-label')).toBe(key);
        }

        const customInput = doc.getElementById('custom-theme-color');
        expect(customInput).toBeTruthy();
        expect(customInput?.getAttribute('aria-label')).toBe('Custom');
        expect(customInput?.getAttribute('data-i18n-aria-label')).toBe('themeColorCustom');
        expect(customInput?.getAttribute('title')).toBe('Custom');
        expect(customInput?.getAttribute('data-i18n-title')).toBe('themeColorCustom');
    });

    it('app opacity range slider carries aria-valuetext and aria-label', () => {
        const doc = parseIndex();
        const slider = doc.getElementById('setting-opacity');
        expect(slider).toBeTruthy();
        expect(slider?.tagName).toBe('INPUT');
        expect(slider?.getAttribute('type')).toBe('range');
        expect(slider?.getAttribute('aria-label')).toBeTruthy();
        expect(slider?.getAttribute('data-i18n-aria-label')).toBe('appOpacity');
        expect(slider?.getAttribute('aria-valuetext')).toBe('100%');
    });

    it('opacity init clamps saved values to the slider range and announces them', async () => {
        const { initThemeSettings } = await import('./settings/theme.js');
        document.body.innerHTML =
            '<input type="range" id="setting-opacity" min="10" max="100" value="100">' +
            '<span id="opacity-val-text">100%</span>';
        const slider = /** @type {HTMLInputElement} */ (document.getElementById('setting-opacity'));
        const valText = document.getElementById('opacity-val-text');
        const api = initThemeSettings({
            savedTheme: null,
            savedThemeMode: null,
            savedOpacity: 5,
            appMainContainer: null,
            appTitleIcon: null,
            themeCircles: [],
            customColorInput: null,
            opacitySlider: slider,
            opacityValText: valText,
            themeModeContainer: null,
            themeModeButtons: [],
            save: () => {},
        });
        // A saved 5 is below the slider minimum: everything must agree on 10.
        expect(slider.value).toBe('10');
        expect(slider.getAttribute('aria-valuetext')).toBe('10%');
        expect(valText?.textContent).toBe('10%');
        // A fractional saved value snaps to the slider's whole steps.
        document.body.innerHTML =
            '<input type="range" id="setting-opacity" min="10" max="100" value="100">' +
            '<span id="opacity-val-text">100%</span>';
        const slider2 = /** @type {HTMLInputElement} */ (document.getElementById('setting-opacity'));
        const valText2 = document.getElementById('opacity-val-text');
        const api2 = initThemeSettings({
            savedTheme: null,
            savedThemeMode: null,
            savedOpacity: 55.5,
            appMainContainer: null,
            appTitleIcon: null,
            themeCircles: [],
            customColorInput: null,
            opacitySlider: slider2,
            opacityValText: valText2,
            themeModeContainer: null,
            themeModeButtons: [],
            save: () => {},
        });
        expect(slider2.value).toBe('56');
        expect(slider2.getAttribute('aria-valuetext')).toBe('56%');
        expect(valText2?.textContent).toBe('56%');
        api2.cancelPendingOpacity();
        // Dragging the slider updates the announcement.
        slider.value = '50';
        slider.dispatchEvent(new Event('input', { bubbles: true }));
        expect(slider.getAttribute('aria-valuetext')).toBe('50%');
        expect(valText?.textContent).toBe('50%');
        api.cancelPendingOpacity();
    });

    it('a pending opacity save can be cancelled (restore defaults)', async () => {
        const { initThemeSettings } = await import('./settings/theme.js');
        document.body.innerHTML =
            '<input type="range" id="setting-opacity" min="10" max="100" value="100">';
        const slider = /** @type {HTMLInputElement} */ (document.getElementById('setting-opacity'));
        const api = initThemeSettings({
            savedTheme: null,
            savedThemeMode: null,
            savedOpacity: 100,
            appMainContainer: null,
            appTitleIcon: null,
            themeCircles: [],
            customColorInput: null,
            opacitySlider: slider,
            opacityValText: null,
            themeModeContainer: null,
            themeModeButtons: [],
            save: () => {},
        });
        invokeMock.mockClear();
        slider.value = '30';
        slider.dispatchEvent(new Event('input', { bubbles: true }));
        api.cancelPendingOpacity();
        await new Promise((resolve) => setTimeout(resolve, 120));
        // The debounced save must not fire after cancellation.
        expect(invokeMock).not.toHaveBeenCalled();
    });

    it('an uncancelled opacity input schedules a save', async () => {
        const { initThemeSettings } = await import('./settings/theme.js');
        document.body.innerHTML =
            '<input type="range" id="setting-opacity" min="10" max="100" value="100">';
        const slider = /** @type {HTMLInputElement} */ (document.getElementById('setting-opacity'));
        initThemeSettings({
            savedTheme: null,
            savedThemeMode: null,
            savedOpacity: 100,
            appMainContainer: null,
            appTitleIcon: null,
            themeCircles: [],
            customColorInput: null,
            opacitySlider: slider,
            opacityValText: null,
            themeModeContainer: null,
            themeModeButtons: [],
            save: () => {},
        });
        invokeMock.mockClear();
        slider.value = '30';
        slider.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 120));
        // Without cancellation the debounced save must go through.
        expect(invokeMock).toHaveBeenCalledWith('patch_settings', { patch: { app_opacity: 30 } });
    });
});

describe('modal dialog accessibility', () => {
    it('modal overlays in index.html carry proper role, aria-modal, and valid aria-labelledby targets', () => {
        const doc = parseIndex();
        const modals = [
            'modal-bg',
            'plugin-panel',
            'dns-config-modal',
            'port-config-modal',
            'fullscreen-editor-overlay',
        ];

        for (const id of modals) {
            const el = doc.getElementById(id);
            expect(el, id).toBeTruthy();
            expect(el?.getAttribute('role'), id).toBe('dialog');
            expect(el?.getAttribute('aria-modal'), id).toBe('true');

            const titleId = el?.getAttribute('aria-labelledby');
            expect(titleId, `${id} aria-labelledby`).toBeTruthy();
            if (titleId) {
                expect(doc.getElementById(titleId), `${id} title element #${titleId}`).toBeTruthy();
            }
        }
    });
});

describe('menu triggers accessibility', () => {
    it('index.html dropdown triggers carry aria-haspopup="menu" and aria-expanded attributes', () => {
        const doc = parseIndex();
        const triggers = ['proxy-group-trigger', 'sort-btn', 'copy-env-format-btn', 'plugin-new-btn', 'plugin-more-btn'];
        for (const id of triggers) {
            const btn = doc.getElementById(id);
            expect(btn, id).toBeTruthy();
            expect(btn?.getAttribute('aria-haspopup')).toBe('menu');
            expect(btn?.getAttribute('aria-expanded')).toBe('false');
        }
    });

    it('proxy toolbar buttons carry translatable tooltips without overriding accessible names', () => {
        const doc = parseIndex();
        const buttons = [
            { id: 'proxy-group-trigger', titleKey: 'consoleNodePicker' },
            { id: 'sort-btn', titleKey: 'consoleSortHint' },
            { id: 'test-all-btn', titleKey: 'testLatency' },
        ];
        for (const { id, titleKey } of buttons) {
            const btn = doc.getElementById(id);
            expect(btn, id).toBeTruthy();
            expect(btn?.getAttribute('data-i18n-title')).toBe(titleKey);
            expect(btn?.getAttribute('title')).toBeTruthy();
            // The accessible name must keep coming from the button's visible
            // content (selected group / current sort mode); a static
            // aria-label would hide it from screen readers.
            expect(btn?.getAttribute('aria-label')).toBeNull();
        }
    });
});

describe('icon-only close and back buttons', () => {
    it('index.html buttons carry translatable aria-labels', () => {
        const doc = parseIndex();
        for (const [id, key] of [
            ['fullscreen-editor-close-btn', 'close'],
            ['btn-back-settings', 'backToSettings'],
            ['add-tunnel-btn', 'add'],
            ['open-plugins-btn', 'overrideTitle'],
            ['update-all-sub-btn', 'updateAll'],
        ]) {
            const btn = doc.getElementById(id);
            expect(btn, id).toBeTruthy();
            expect(btn?.getAttribute('aria-label'), id).toBeTruthy();
            expect(btn?.getAttribute('data-i18n-aria-label'), id).toBe(key);
        }
    });

    it('modal close buttons built in JS carry aria-labels', () => {
        const files = {
            'ui/global-shortcut.js': ['shortcut-modal-close'],
            'ui/settings.js': ['log-modal-close', 'log-export-modal-close', 'smart-modal-close'],
            'ui/settings/subscriptions.js': ['edit-modal-close'],
        };
        for (const [file, ids] of Object.entries(files)) {
            const src = read(file);
            for (const id of ids) {
                const tag = src.match(new RegExp(`<button[^>]*id="${id}"[^>]*>`))?.[0] ?? '';
                expect(tag, id).toContain('aria-label="${escapeHtml(t.close');
            }
        }
    });
});

describe('proxy mode selector', () => {
    const mount = () => {
        document.body.innerHTML = `
            <div data-page="home">
                <div id="mode-selector-container" role="group">
                    <div id="mode-slider"></div>
                    <button data-mode="rule" aria-pressed="true">Rule</button>
                    <button data-mode="global" aria-pressed="false">Global</button>
                    <button data-mode="direct" aria-pressed="false">Direct</button>
                </div>
            </div>
            <div class="conn-row" role="button" data-mode="active"></div>
            <div id="dz-mode-seg"><button data-mode="rule" class="active">Rule</button></div>`;
    };

    it('index.html exposes the selector as a labelled group with pressed state', () => {
        const doc = parseIndex();
        const group = doc.getElementById('mode-selector-container');
        expect(group?.getAttribute('role')).toBe('group');
        expect(group?.getAttribute('data-i18n-aria-label')).toBe('mode');
        expect(group?.querySelectorAll('button[aria-pressed]').length).toBe(3);
    });

    it('marks only the matching home button as pressed', () => {
        mount();
        updateModeUI('global');
        const pressed = [...document.querySelectorAll('#mode-selector-container button')].map((b) => b.getAttribute('aria-pressed'));
        expect(pressed).toEqual(['false', 'true', 'false']);
        expect(document.querySelector('[data-mode="global"]')?.classList.contains('text-[var(--text-primary)]')).toBe(true);
        expect(document.getElementById('mode-slider')?.style.transform).toContain('100%');
    });

    it('leaves other [data-mode] elements alone', () => {
        mount();
        updateModeUI('direct');
        const row = document.querySelector('.conn-row');
        expect(row?.hasAttribute('aria-pressed')).toBe(false);
        expect(row?.className).toBe('conn-row');
        const consoleBtn = document.querySelector('#dz-mode-seg button');
        expect(consoleBtn?.hasAttribute('aria-pressed')).toBe(false);
        expect(consoleBtn?.className).toBe('active');
    });

    it('ignores unknown modes', () => {
        mount();
        updateModeUI('bogus');
        expect(document.querySelector('[data-mode="rule"]')?.getAttribute('aria-pressed')).toBe('true');
    });
});

describe('pluginExecuteHook', () => {
    it('sends the arguments the backend command expects', async () => {
        await pluginExecuteHook('on_config_load', { a: 1 });
        expect(invokeMock).toHaveBeenCalledWith('plugin_execute_hook', { hookName: 'on_config_load', config: {}, hookData: { a: 1 } });
    });

    it('defaults hook data and config to empty objects', async () => {
        await pluginExecuteHook('on_config_load');
        expect(invokeMock).toHaveBeenCalledWith('plugin_execute_hook', { hookName: 'on_config_load', config: {}, hookData: {} });
    });
});

describe('kv store and plugin action buttons accessibility', () => {
    it('kv store action buttons carry title and aria-label attributes', () => {
        const src = read('ui/plugins-smart.js');
        expect(src).toContain('class="kv-delete-key-btn');
        expect(src).toMatch(/class="kv-delete-key-btn[^>]*title="Delete key"/);
        expect(src).toMatch(/class="kv-delete-key-btn[^>]*aria-label="\${escapeAttr\(`Delete key \${String\(e\.key \?\? ''\)\}`\)}"/);

        expect(src).toContain('class="kv-edit-btn');
        expect(src).toMatch(/class="kv-edit-btn[^>]*title="Edit value"/);
        expect(src).toMatch(/class="kv-edit-btn[^>]*aria-label="\${escapeAttr\(`Edit value for \${String\(e\.key \?\? ''\)\}`\)}"/);
    });

    it('plugin list action buttons carry title and aria-label attributes', () => {
        const src = read('ui/plugins-smart.js');
        expect(src).toMatch(/data-action="\${isLoaded \? 'unload' : 'load'}"[^>]*aria-label=/);
        expect(src).toMatch(/data-action="execute"[^>]*aria-label=/);
        expect(src).toMatch(/data-action="delete"[^>]*aria-label=/);
    });
});
