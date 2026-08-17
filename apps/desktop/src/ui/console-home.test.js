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
        it('returns false at exactly 1080px (1px short of expanded layout) via matchMedia', () => {
            const mockWin = /** @type {Window} */ ({
                matchMedia: vi.fn().mockImplementation((query) => ({
                    matches: query === '(max-width: 1080px)',
                })),
                innerWidth: 1080,
            });

            const result = isConsoleFullyExpanded(mockWin);
            expect(result).toBe(false);
            expect(mockWin.matchMedia).toHaveBeenCalledWith('(max-width: 1080px)');
        });

        it('returns true at exactly 1081px (fully expanded layout) via matchMedia', () => {
            const mockWin = /** @type {Window} */ ({
                matchMedia: vi.fn().mockImplementation(() => ({
                    matches: false,
                })),
                innerWidth: 1081,
            });

            const result = isConsoleFullyExpanded(mockWin);
            expect(result).toBe(true);
            expect(mockWin.matchMedia).toHaveBeenCalledWith('(max-width: 1080px)');
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
                innerWidth: 1080,
            });
            expect(isConsoleFullyExpanded(narrowWin)).toBe(false);

            const wideWin = /** @type {Window} */ ({
                innerWidth: 1081,
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
        it('pops up info notification when width is 1080px (not fully expanded)', () => {
            const notifSpy = vi.spyOn(notifModule, 'showNotification').mockImplementation(() => {});
            const mockWin = /** @type {Window} */ ({
                matchMedia: vi.fn().mockReturnValue({ matches: true }),
                innerWidth: 1080,
            });

            checkConsoleWidthNotification(mockWin);
            expect(notifSpy).toHaveBeenCalledTimes(1);
            expect(notifSpy).toHaveBeenCalledWith(t('consoleWidthTip'), 'info', null, { log: false });
        });

        it('does NOT pop up notification when width is 1081px (fully expanded)', () => {
            const notifSpy = vi.spyOn(notifModule, 'showNotification').mockImplementation(() => {});
            const mockWin = /** @type {Window} */ ({
                matchMedia: vi.fn().mockReturnValue({ matches: false }),
                innerWidth: 1081,
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

        it('verifies 1px precision boundary: triggers at 1080px, suppresses at 1081px', () => {
            const notifSpy = vi.spyOn(notifModule, 'showNotification').mockImplementation(() => {});

            // 1080px: exactly 1px not enough
            const win1080 = /** @type {Window} */ ({ innerWidth: 1080 });
            checkConsoleWidthNotification(win1080);
            expect(notifSpy).toHaveBeenCalledTimes(1);

            // 1081px: exactly 1px enough to expand
            const win1081 = /** @type {Window} */ ({ innerWidth: 1081 });
            checkConsoleWidthNotification(win1081);
            expect(notifSpy).toHaveBeenCalledTimes(1); // count unchanged
        });
    });
});
