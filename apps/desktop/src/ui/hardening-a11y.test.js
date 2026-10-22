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

    it('preset theme color swatches carry translatable aria-labels', () => {
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
});

describe('icon-only close and back buttons', () => {
    it('index.html buttons carry translatable aria-labels', () => {
        const doc = parseIndex();
        for (const [id, key] of [['fullscreen-editor-close-btn', 'close'], ['btn-back-settings', 'backToSettings']]) {
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
