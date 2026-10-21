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
    getLatencyTestSignal: vi.fn(() => new AbortController().signal),
    resetLatencyTestController: vi.fn(),
    switchProxy: vi.fn().mockResolvedValue(true),
    switchProxyResult: vi.fn().mockResolvedValue({ ok: true, reason: null }),
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
import { activateConsole, deactivateConsole, measureLatency, scheduleLatencyRetry, latencyFromHistory, latencyToShow } from './console-home.js';
import { testProxy, getLatencyTestSignal, resetLatencyTestController } from '../api.js';
import { appStore } from './state.js';
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
        let invoke;
        let switchHomePageMode;
        let originalInnerWidth;
        let originalMatchMedia;

        beforeAll(async () => {
            const stateMod = await import('./state.js');
            const apiMod = await import('../api.js');
            const settingsMod = await import('./settings.js');
            appStore = stateMod.appStore;
            invoke = apiMod.invoke;
            switchHomePageMode = settingsMod.switchHomePageMode;
            originalInnerWidth = window.innerWidth;
            originalMatchMedia = window.matchMedia;
        });

        afterEach(() => {
            window.innerWidth = originalInnerWidth;
            window.matchMedia = originalMatchMedia;
            document.body.innerHTML = '';
        });

        it('triggers width notification when switching to console mode in a narrow window via production helper', async () => {
            window.innerWidth = NARROW_WIDTH;
            window.matchMedia = vi.fn().mockImplementation((query) => ({
                matches: query === EXPAND_QUERY,
            }));

            appStore.set('homePageMode', 'minimal');
            const setHomeModeUIMock = vi.fn();
            await switchHomePageMode('console', setHomeModeUIMock);

            expect(setHomeModeUIMock).toHaveBeenCalledWith('console');
            expect(invoke).toHaveBeenCalledWith('patch_settings', { patch: { home_page_mode: 'console' } });
            expect(appStore.get('homePageMode')).toBe('console');
            expect(showNotification).toHaveBeenCalledTimes(1);
            expect(showNotification).toHaveBeenCalledWith(t('consoleWidthTip'), 'info', null, { log: false });
        });

        it('does NOT trigger width notification when switching to console mode in a wide window', async () => {
            window.innerWidth = EXPANDED_WIDTH;
            window.matchMedia = vi.fn().mockImplementation(() => ({
                matches: false,
            }));

            appStore.set('homePageMode', 'minimal');
            const setHomeModeUIMock = vi.fn();
            await switchHomePageMode('console', setHomeModeUIMock);

            expect(setHomeModeUIMock).toHaveBeenCalledWith('console');
            expect(invoke).toHaveBeenCalledWith('patch_settings', { patch: { home_page_mode: 'console' } });
            expect(appStore.get('homePageMode')).toBe('console');
            expect(showNotification).not.toHaveBeenCalled();
        });

        it('does NOT trigger width notification when switching to minimal mode', async () => {
            window.innerWidth = NARROW_WIDTH;
            window.matchMedia = vi.fn().mockImplementation((query) => ({
                matches: query === EXPAND_QUERY,
            }));

            appStore.set('homePageMode', 'console');
            const setHomeModeUIMock = vi.fn();
            await switchHomePageMode('minimal', setHomeModeUIMock);

            expect(setHomeModeUIMock).toHaveBeenCalledWith('minimal');
            expect(invoke).toHaveBeenCalledWith('patch_settings', { patch: { home_page_mode: 'minimal' } });
            expect(appStore.get('homePageMode')).toBe('minimal');
            expect(showNotification).not.toHaveBeenCalled();
        });

        it('restores previous mode and does not trigger width notification when persistence fails', async () => {
            window.innerWidth = NARROW_WIDTH;
            window.matchMedia = vi.fn().mockImplementation((query) => ({
                matches: query === EXPAND_QUERY,
            }));

            appStore.set('homePageMode', 'minimal');
            const setHomeModeUIMock = vi.fn();
            invoke.mockRejectedValueOnce(new Error('Persistence failure'));

            await expect(switchHomePageMode('console', setHomeModeUIMock)).rejects.toThrow('Persistence failure');

            expect(setHomeModeUIMock).toHaveBeenNthCalledWith(1, 'console');
            expect(setHomeModeUIMock).toHaveBeenNthCalledWith(2, 'minimal');
            expect(appStore.get('homePageMode')).toBe('minimal');
            expect(showNotification).toHaveBeenCalledWith('Persistence failure', 'error');
            expect(showNotification).not.toHaveBeenCalledWith(t('consoleWidthTip'), 'info', null, { log: false });
        });

        it('prevents concurrent mode switches — second call is a no-op while first is in flight', async () => {
            appStore.set('homePageMode', 'minimal');
            const setHomeModeUIMock = vi.fn();

            // Mock invoke to return a controllable promise so we can interleave calls
            let resolveInvoke;
            invoke.mockReturnValueOnce(new Promise((resolve) => { resolveInvoke = resolve; }));

            // Start first switch — don't await yet
            const p1 = switchHomePageMode('console', setHomeModeUIMock);

            // Attempt second switch while first is still in flight
            const p2 = switchHomePageMode('console', setHomeModeUIMock);

            // Resolve the first invocation
            resolveInvoke({ ok: true });
            await Promise.all([p1, p2]);

            // setHomeModeUI should have been called only once (for the first switch)
            expect(setHomeModeUIMock).toHaveBeenCalledTimes(1);
            expect(setHomeModeUIMock).toHaveBeenCalledWith('console');
            // invoke should have been called only once
            expect(invoke).toHaveBeenCalledTimes(1);
        });
    });

    describe('latencyFromHistory()', () => {
        it('shows the core history unless a test from here is newer', () => {
            const history = [{ time: '2026-10-21T05:00:00.000Z', delay: 120 }, { time: '2026-10-21T05:01:00.000Z', delay: 0 }];
            const at = Date.parse('2026-10-21T05:01:00.000Z');
            expect(latencyFromHistory([], undefined)).toBeNull();
            expect(latencyFromHistory(history, undefined)).toEqual({ delay: -1, at });
            const newer = { delay: 85, at: at + 1000 };
            expect(latencyFromHistory(history, newer)).toBe(newer);
            expect(latencyFromHistory(history, { delay: 85, at: at - 1000 })).toEqual({ delay: -1, at });
            // Entries without a readable time keep the history first.
            expect(latencyFromHistory([{ delay: 90 }], newer)?.delay).toBe(90);
        });
    });

    describe('latencyToShow()', () => {
        it('measures again once our own failed test is old, even with older history', () => {
            const history = [{ time: new Date(1_000).toISOString(), delay: 120 }];
            const failed = { delay: -1, at: 10_000 };
            // Recent failure: shown as a timeout, no new test yet.
            expect(latencyToShow(history, failed, 20_000)).toBe(failed);
            expect(latencyToShow([], failed, 20_000)).toBe(failed);
            // 30 s later: measure again instead of showing it forever.
            expect(latencyToShow(history, failed, 41_000)).toBeNull();
            expect(latencyToShow([], failed, 41_000)).toBeNull();
            // A good result from here is kept; never tested means measure now.
            const ok = { delay: 80, at: 10_000 };
            expect(latencyToShow(history, ok, 999_000)).toBe(ok);
            expect(latencyToShow([], undefined)).toBeNull();
            // Newer core history wins over an old failure from here.
            expect(latencyToShow([{ time: new Date(50_000).toISOString(), delay: 95 }], failed, 60_000)?.delay).toBe(95);
        });

        it('also retries a failure recorded in the core history once it is old', () => {
            const history = [{ time: new Date(10_000).toISOString(), delay: 0 }];
            // The saved value is rebuilt from history on each read, never the same object.
            const seen = latencyFromHistory(history, undefined) ?? undefined;
            expect(latencyToShow(history, seen, 20_000)?.delay).toBe(-1);
            expect(latencyToShow(history, seen, 41_000)).toBeNull();
        });
    });

    describe('measureLatency()', () => {
        it('tells a stopped test apart from a failed one', async () => {
            const stop = new AbortController();
            vi.mocked(getLatencyTestSignal).mockReturnValue(stop.signal);
            vi.mocked(testProxy).mockImplementationOnce(async () => {
                stop.abort();
                return -1;
            });
            expect(await measureLatency('HK')).toEqual({ delay: -1, cancelled: true });

            // A controller stopped before the test is replaced first, so a later
            // stop is still told apart and a plain failure stays a failure.
            const fresh = new AbortController();
            vi.mocked(resetLatencyTestController).mockImplementationOnce(() => {
                vi.mocked(getLatencyTestSignal).mockReturnValue(fresh.signal);
            });
            vi.mocked(testProxy).mockResolvedValueOnce(-1);
            expect(await measureLatency('HK')).toEqual({ delay: -1, cancelled: false });
            expect(resetLatencyTestController).toHaveBeenCalledTimes(1);
            vi.mocked(testProxy).mockImplementationOnce(async () => {
                fresh.abort();
                return -1;
            });
            expect(await measureLatency('HK')).toEqual({ delay: -1, cancelled: true });
        });

        it('leaves a stopped full test winding down alone', async () => {
            const stop = new AbortController();
            stop.abort();
            vi.mocked(getLatencyTestSignal).mockReturnValue(stop.signal);
            vi.mocked(resetLatencyTestController).mockClear();
            appStore.set('isTestingLatency', true);
            vi.mocked(testProxy).mockClear();
            expect(await measureLatency('HK')).toEqual({ delay: -1, cancelled: true });
            expect(resetLatencyTestController).not.toHaveBeenCalled();
            expect(testProxy).not.toHaveBeenCalled();
            appStore.set('isTestingLatency', false);
        });

        it('retries a cancelled probe only after a stopped full test has finished', async () => {
            const stop = new AbortController();
            stop.abort();
            vi.mocked(getLatencyTestSignal).mockReturnValue(stop.signal);
            appStore.set('isTestingLatency', true);
            const run = vi.fn();
            scheduleLatencyRetry(run);
            await new Promise((r) => setTimeout(r, 300));
            expect(run).not.toHaveBeenCalled();
            appStore.set('isTestingLatency', false);
            await new Promise((r) => setTimeout(r, 0));
            expect(run).toHaveBeenCalledTimes(1);
        });

        it('never retries in the same tick, and can be cancelled', async () => {
            vi.mocked(getLatencyTestSignal).mockReturnValue(new AbortController().signal);
            const run = vi.fn();
            scheduleLatencyRetry(run);
            await Promise.resolve();
            expect(run).not.toHaveBeenCalled();
            await new Promise((r) => setTimeout(r, 300));
            expect(run).toHaveBeenCalledTimes(1);
            const cancelled = vi.fn();
            scheduleLatencyRetry(cancelled)();
            await new Promise((r) => setTimeout(r, 300));
            expect(cancelled).not.toHaveBeenCalled();
        });

        it('keeps a usable delay even if a stop lands right after it', async () => {
            const stop = new AbortController();
            vi.mocked(getLatencyTestSignal).mockReturnValue(stop.signal);
            vi.mocked(testProxy).mockImplementationOnce(async () => {
                stop.abort();
                return 87;
            });
            expect(await measureLatency('JP')).toEqual({ delay: 87, cancelled: false });
            vi.mocked(getLatencyTestSignal).mockReturnValue(new AbortController().signal);
            vi.mocked(testProxy).mockResolvedValueOnce(999999);
            expect(await measureLatency('JP')).toEqual({ delay: -1, cancelled: false });
        });
    });
});
