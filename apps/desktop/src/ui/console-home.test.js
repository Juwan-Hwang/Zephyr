// @ts-check
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    CONSOLE_EXPAND_BREAKPOINT,
    isConsoleFullyExpanded,
    checkConsoleWidthNotification
} from './console-home.js';
import * as notifModule from './notifications.js';
import { t } from '../i18n.js';

describe('Console Dashboard Width Threshold and Notification', () => {
    const EXPAND_QUERY = `(max-width: ${CONSOLE_EXPAND_BREAKPOINT}px)`;
    const NARROW_WIDTH = CONSOLE_EXPAND_BREAKPOINT;
    const EXPANDED_WIDTH = CONSOLE_EXPAND_BREAKPOINT + 1;

    beforeEach(() => {
        vi.restoreAllMocks();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('defines CONSOLE_EXPAND_BREAKPOINT exactly at 1080px', () => {
        expect(CONSOLE_EXPAND_BREAKPOINT).toBe(1080);
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
            expect(mockWin.matchMedia).toHaveBeenCalledWith(EXPAND_QUERY);
        });

        it('returns false at 860px (default window width)', () => {
            const mockWin = /** @type {Window} */ ({
                matchMedia: vi.fn().mockImplementation(() => ({
                    matches: true,
                })),
                innerWidth: 860,
            });

            expect(isConsoleFullyExpanded(mockWin)).toBe(false);
        });

        it('falls back to innerWidth when matchMedia is unavailable', () => {
            const narrowWin = /** @type {Window} */ ({
                innerWidth: NARROW_WIDTH,
            });
            expect(isConsoleFullyExpanded(narrowWin)).toBe(false);

            const wideWin = /** @type {Window} */ ({
                innerWidth: EXPANDED_WIDTH,
            });
            expect(isConsoleFullyExpanded(wideWin)).toBe(true);

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
            const notifSpy = vi.spyOn(notifModule, 'showNotification').mockImplementation(() => {});
            const mockWin = /** @type {Window} */ ({
                matchMedia: vi.fn().mockReturnValue({ matches: true }),
                innerWidth: NARROW_WIDTH,
            });

            checkConsoleWidthNotification(mockWin);
            expect(notifSpy).toHaveBeenCalledTimes(1);
            expect(notifSpy).toHaveBeenCalledWith(t('consoleWidthTip'), 'info', null, { log: false });
        });

        it('does NOT pop up notification when width is CONSOLE_EXPAND_BREAKPOINT + 1 (fully expanded)', () => {
            const notifSpy = vi.spyOn(notifModule, 'showNotification').mockImplementation(() => {});
            const mockWin = /** @type {Window} */ ({
                matchMedia: vi.fn().mockReturnValue({ matches: false }),
                innerWidth: EXPANDED_WIDTH,
            });

            checkConsoleWidthNotification(mockWin);
            expect(notifSpy).not.toHaveBeenCalled();
        });

        it('pops up notification at default 860px window width without logging spam', () => {
            const notifSpy = vi.spyOn(notifModule, 'showNotification').mockImplementation(() => {});
            const mockWin = /** @type {Window} */ ({
                innerWidth: 860,
            });

            checkConsoleWidthNotification(mockWin);
            expect(notifSpy).toHaveBeenCalledTimes(1);
            expect(notifSpy).toHaveBeenCalledWith(t('consoleWidthTip'), 'info', null, { log: false });
        });

        it('verifies 1px precision boundary: triggers at breakpoint, suppresses at breakpoint + 1', () => {
            const notifSpy = vi.spyOn(notifModule, 'showNotification').mockImplementation(() => {});

            // CONSOLE_EXPAND_BREAKPOINT (1080px): exactly 1px not enough
            const winNarrow = /** @type {Window} */ ({ innerWidth: NARROW_WIDTH });
            checkConsoleWidthNotification(winNarrow);
            expect(notifSpy).toHaveBeenCalledTimes(1);

            // CONSOLE_EXPAND_BREAKPOINT + 1 (1081px): exactly 1px enough to expand
            const winExpanded = /** @type {Window} */ ({ innerWidth: EXPANDED_WIDTH });
            checkConsoleWidthNotification(winExpanded);
            expect(notifSpy).toHaveBeenCalledTimes(1); // count unchanged
        });
    });
});
