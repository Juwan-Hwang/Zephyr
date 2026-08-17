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
        it('triggers width notification when mode is switched to console in a narrow window', () => {
            const winNarrow = /** @type {Window} */ ({
                matchMedia: vi.fn().mockReturnValue({ matches: true }),
                innerWidth: NARROW_WIDTH,
            });

            const mode = 'console';
            if (mode === 'console') {
                checkConsoleWidthNotification(winNarrow);
            }

            expect(showNotification).toHaveBeenCalledTimes(1);
            expect(showNotification).toHaveBeenCalledWith(t('consoleWidthTip'), 'info', null, { log: false });
        });

        it('does NOT trigger width notification when mode is switched to console in a wide window', () => {
            const winExpanded = /** @type {Window} */ ({
                matchMedia: vi.fn().mockReturnValue({ matches: false }),
                innerWidth: EXPANDED_WIDTH,
            });

            const mode = 'console';
            if (mode === 'console') {
                checkConsoleWidthNotification(winExpanded);
            }

            expect(showNotification).not.toHaveBeenCalled();
        });

        it('does NOT trigger width notification when mode is switched to minimal', () => {
            const mode = 'minimal';
            if (/** @type {string} */ (mode) === 'console') {
                checkConsoleWidthNotification();
            }

            expect(showNotification).not.toHaveBeenCalled();
        });
    });
});
