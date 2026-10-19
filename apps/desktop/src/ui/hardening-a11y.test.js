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
