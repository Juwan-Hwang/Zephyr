// @ts-check
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';

vi.mock('../api.js', () => ({
    invoke: vi.fn().mockImplementation((cmd) => {
        if (cmd === 'list_configs') return Promise.resolve([]);
        return Promise.resolve({});
    }),
    getConnections: vi.fn().mockResolvedValue({ connections: [] }),
    getProxies: vi.fn().mockResolvedValue({ proxies: {} }),
    testProxy: vi.fn().mockResolvedValue({ delay: 100 }),
    switchProxy: vi.fn().mockResolvedValue(true),
    getConfig: vi.fn().mockResolvedValue({ mode: 'rule' }),
    closeAllConnections: vi.fn().mockResolvedValue(true),
}));

vi.mock('../modules/backend-events.js', () => ({
    subscribeToEvents: vi.fn().mockResolvedValue(() => {}),
    getExtLogEvents: vi.fn().mockReturnValue([]),
}));

vi.mock('./sysproxy.js', () => ({
    setSysProxyEnabled: vi.fn().mockResolvedValue(true),
    refreshSysProxyStatus: vi.fn().mockResolvedValue(false),
}));

vi.mock('./cache.js', () => ({
    invalidateProxiesCache: vi.fn(),
    invalidateSettingsCache: vi.fn(),
    invalidateConfigsCache: vi.fn(),
    getSettingsCached: vi.fn().mockResolvedValue({}),
    getConfigsCached: vi.fn().mockResolvedValue({ configs: [] }),
}));

vi.mock('./run-config-cache.js', () => ({
    getRunConfigCached: vi.fn().mockResolvedValue({}),
    invalidateRunConfigCache: vi.fn(),
}));

vi.mock('./notifications.js', () => ({
    showNotification: vi.fn(),
}));

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    CONSOLE_EXPAND_BREAKPOINT,
    isConsoleFullyExpanded,
    checkConsoleWidthNotification
} from './console-width.js';
import { activateConsole, deactivateConsole } from './console-home.js';
import { showNotification } from './notifications.js';
import { t } from '../i18n.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('Console Dashboard Width Threshold and Notification', () => {
    const EXPAND_QUERY = `(max-width: ${CONSOLE_EXPAND_BREAKPOINT}px)`;
    const NARROW_WIDTH = CONSOLE_EXPAND_BREAKPOINT;
    const EXPANDED_WIDTH = CONSOLE_EXPAND_BREAKPOINT + 1;
    const mmDesc = typeof window !== 'undefined' ? Object.getOwnPropertyDescriptor(window, 'matchMedia') : undefined;

    beforeEach(() => {
        vi.clearAllMocks();
    });

    afterEach(() => {
        try {
            deactivateConsole();
        } catch {
            // ignore
        }
        vi.clearAllMocks();
        if (typeof window !== 'undefined') {
            if (mmDesc) {
                Object.defineProperty(window, 'matchMedia', mmDesc);
            } else {
                delete window.matchMedia;
            }
        }
    });

    it('defines CONSOLE_EXPAND_BREAKPOINT exactly at 1080px', () => {
        expect(CONSOLE_EXPAND_BREAKPOINT).toBe(1080);
    });

    it('matches the @media (max-width: ...px) responsive breakpoint in styles.css', () => {
        const cssPath = path.resolve(__dirname, '../styles.css');
        const cssContent = fs.readFileSync(cssPath, 'utf8');
        expect(cssContent).toMatch(new RegExp(String.raw`@media\s*\(\s*max-width:\s*${CONSOLE_EXPAND_BREAKPOINT}px\s*\)`));
    });

    describe('isConsoleFullyExpanded()', () => {
        it('returns false at exactly CONSOLE_EXPAND_BREAKPOINT (1px short of expanded layout) via matchMedia', () => {
            const mockWin = /** @type {Window} */ ({
                matchMedia: vi.fn().mockImplementation((query) => ({
                    matches: query === EXPAND_QUERY,
                })),
                innerWidth: NARROW_WIDTH,
            });

            const result = isConsoleFullyExpanded(mockWin);
            expect(result).toBe(false);
            expect(mockWin.matchMedia).toHaveBeenCalledWith(EXPAND_QUERY);
        });

        it('returns true at CONSOLE_EXPAND_BREAKPOINT + 1 (fully expanded layout) via matchMedia', () => {
            const mockWin = /** @type {Window} */ ({
                matchMedia: vi.fn().mockImplementation(() => ({
                    matches: false,
                })),
                innerWidth: EXPANDED_WIDTH,
            });

            const result = isConsoleFullyExpanded(mockWin);
            expect(result).toBe(true);
        });

        it('falls back to innerWidth when matchMedia is not a function', () => {
            const mockWin = /** @type {Window} */ ({
                innerWidth: 1200,
            });
            expect(isConsoleFullyExpanded(mockWin)).toBe(true);
        });

        it('falls back to innerWidth at exactly CONSOLE_EXPAND_BREAKPOINT returning false (1px not enough)', () => {
            const mockWin = /** @type {Window} */ ({
                innerWidth: NARROW_WIDTH,
            });
            expect(isConsoleFullyExpanded(mockWin)).toBe(false);
        });

        it('falls back to innerWidth at CONSOLE_EXPAND_BREAKPOINT + 1 returning true (1px enough)', () => {
            const mockWin = /** @type {Window} */ ({
                innerWidth: EXPANDED_WIDTH,
            });
            expect(isConsoleFullyExpanded(mockWin)).toBe(true);
        });

        it('returns false for default window width (860px)', () => {
            const defaultWin = /** @type {Window} */ ({
                innerWidth: 860,
            });
            expect(isConsoleFullyExpanded(defaultWin)).toBe(false);
        });

        it('returns true if window object is null or unavailable', () => {
            expect(isConsoleFullyExpanded(null)).toBe(true);
        });
    });

    describe('checkConsoleWidthNotification()', () => {
        it('pops up info notification when width is CONSOLE_EXPAND_BREAKPOINT (not fully expanded)', () => {
            const mockWin = /** @type {Window} */ ({
                matchMedia: vi.fn().mockReturnValue({ matches: true }),
                innerWidth: NARROW_WIDTH,
            });

            checkConsoleWidthNotification(mockWin);
            expect(showNotification).toHaveBeenCalledTimes(1);
            expect(showNotification).toHaveBeenCalledWith(t('consoleWidthTip'), 'info', null, { log: false });
        });

        it('does NOT pop up notification when width is CONSOLE_EXPAND_BREAKPOINT + 1 (fully expanded)', () => {
            const mockWin = /** @type {Window} */ ({
                matchMedia: vi.fn().mockReturnValue({ matches: false }),
                innerWidth: EXPANDED_WIDTH,
            });

            checkConsoleWidthNotification(mockWin);
            expect(showNotification).not.toHaveBeenCalled();
        });

        it('pops up notification at default 860px window width without logging spam', () => {
            const mockWin = /** @type {Window} */ ({
                innerWidth: 860,
            });

            checkConsoleWidthNotification(mockWin);
            expect(showNotification).toHaveBeenCalledTimes(1);
            expect(showNotification).toHaveBeenCalledWith(t('consoleWidthTip'), 'info', null, { log: false });
        });

        it('verifies 1px precision boundary: triggers at breakpoint, suppresses at breakpoint + 1', () => {
            // CONSOLE_EXPAND_BREAKPOINT (1080px): exactly 1px not enough
            const winNarrow = /** @type {Window} */ ({ innerWidth: NARROW_WIDTH });
            checkConsoleWidthNotification(winNarrow);
            expect(showNotification).toHaveBeenCalledTimes(1);

            // CONSOLE_EXPAND_BREAKPOINT + 1 (1081px): exactly 1px enough to expand
            const winExpanded = /** @type {Window} */ ({ innerWidth: EXPANDED_WIDTH });
            checkConsoleWidthNotification(winExpanded);
            expect(showNotification).toHaveBeenCalledTimes(1); // count unchanged
        });
    });

    describe('activateConsole() does NOT trigger notification on general navigation', () => {
        beforeAll(() => {
            document.body.innerHTML = '<div data-page="console"></div><div data-page="home"></div>';
        });

        it('does not trigger width notification when user merely visits/activates the console page', () => {
            window.matchMedia = vi.fn().mockImplementation((query) => ({
                matches: query === EXPAND_QUERY,
            }));

            try {
                activateConsole();
                expect(showNotification).not.toHaveBeenCalled();
            } finally {
                deactivateConsole();
            }
        });
    });

    describe('Settings home_page_mode switch behavior', () => {
        let appStore;
        let Bus;
        let Events;
        let invoke;
        let originalInnerWidth;
        let originalMatchMedia;

        beforeAll(async () => {
            const stateMod = await import('./state.js');
            const eventsMod = await import('./events.js');
            const apiMod = await import('../api.js');
            appStore = stateMod.appStore;
            Bus = eventsMod.Bus;
            Events = eventsMod.Events;
            invoke = apiMod.invoke;
            originalInnerWidth = window.innerWidth;
            originalMatchMedia = window.matchMedia;
        });

        afterEach(() => {
            window.innerWidth = originalInnerWidth;
            window.matchMedia = originalMatchMedia;
            document.body.innerHTML = '';
        });

        /**
         * Simulates the exact Settings Home Mode UI and click handler from settings.js.
         * @param {'minimal' | 'console'} [initialMode='minimal']
         */
        function setupSettingsHomeModeDOM(initialMode = 'minimal') {
            document.body.innerHTML = `
                <div id="setting-home-mode-slider"></div>
                <button type="button" data-home-mode="minimal" id="home-mode-minimal"></button>
                <button type="button" data-home-mode="console" id="home-mode-console"></button>
            `;

            appStore.set('homePageMode', initialMode);
            const homeModeSlider = document.getElementById('setting-home-mode-slider');
            const homeModeButtons = document.querySelectorAll('[data-home-mode]');

            const setHomeModeUI = (mode) => {
                const isConsole = mode === 'console';
                if (homeModeSlider) homeModeSlider.style.transform = isConsole ? 'translateX(calc(var(--rtl-sign, 1) * 100%))' : '';
                homeModeButtons.forEach((btn) => {
                    const btnMode = /** @type {HTMLElement} */ (btn).dataset.homeMode;
                    const isSelected = btnMode === mode;
                    btn.setAttribute('aria-pressed', String(isSelected));
                });
            };
            setHomeModeUI(initialMode);

            let homeModeBusy = false;
            homeModeButtons.forEach((btn) => {
                btn.addEventListener('click', async () => {
                    const mode = /** @type {HTMLElement} */ (btn).dataset.homeMode;
                    if (!mode || homeModeBusy) return;
                    const previous = appStore.get('homePageMode') || 'minimal';
                    if (mode === previous) return;
                    homeModeBusy = true;
                    setHomeModeUI(mode);
                    appStore.set('homePageMode', mode);
                    try {
                        await invoke('patch_settings', { patch: { home_page_mode: mode } });
                        Bus.emit(Events.HOME_PAGE_MODE_CHANGED, { mode, previous });
                        if (mode === 'console') {
                            checkConsoleWidthNotification();
                        }
                    } catch {
                        setHomeModeUI(previous);
                        appStore.set('homePageMode', previous);
                    } finally {
                        homeModeBusy = false;
                    }
                });
            });
        }

        it('triggers width notification when clicking console mode in a narrow window', async () => {
            window.innerWidth = NARROW_WIDTH;
            window.matchMedia = vi.fn().mockImplementation((query) => ({
                matches: query === EXPAND_QUERY,
            }));

            setupSettingsHomeModeDOM('minimal');
            const consoleBtn = /** @type {HTMLButtonElement} */ (document.getElementById('home-mode-console'));
            consoleBtn.click();
            await new Promise((r) => setTimeout(r, 0));

            expect(invoke).toHaveBeenCalledWith('patch_settings', { patch: { home_page_mode: 'console' } });
            expect(appStore.get('homePageMode')).toBe('console');
            expect(showNotification).toHaveBeenCalledTimes(1);
            expect(showNotification).toHaveBeenCalledWith(t('consoleWidthTip'), 'info', null, { log: false });
        });

        it('does NOT trigger width notification when clicking console mode in a wide window', async () => {
            window.innerWidth = EXPANDED_WIDTH;
            window.matchMedia = vi.fn().mockImplementation(() => ({
                matches: false,
            }));

            setupSettingsHomeModeDOM('minimal');
            const consoleBtn = /** @type {HTMLButtonElement} */ (document.getElementById('home-mode-console'));
            consoleBtn.click();
            await new Promise((r) => setTimeout(r, 0));

            expect(invoke).toHaveBeenCalledWith('patch_settings', { patch: { home_page_mode: 'console' } });
            expect(appStore.get('homePageMode')).toBe('console');
            expect(showNotification).not.toHaveBeenCalled();
        });

        it('does NOT trigger width notification when clicking minimal mode', async () => {
            window.innerWidth = NARROW_WIDTH;
            window.matchMedia = vi.fn().mockImplementation((query) => ({
                matches: query === EXPAND_QUERY,
            }));

            setupSettingsHomeModeDOM('console');
            const minimalBtn = /** @type {HTMLButtonElement} */ (document.getElementById('home-mode-minimal'));
            minimalBtn.click();
            await new Promise((r) => setTimeout(r, 0));

            expect(invoke).toHaveBeenCalledWith('patch_settings', { patch: { home_page_mode: 'minimal' } });
            expect(appStore.get('homePageMode')).toBe('minimal');
            expect(showNotification).not.toHaveBeenCalled();
        });
    });
});
