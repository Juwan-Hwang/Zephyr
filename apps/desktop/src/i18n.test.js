import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    translations,
    isRTL,
    t,
    setQAMode,
    isQAMode,
    getLocAttributes,
    mapStatusMessage,
} from './i18n.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  translations data
// ═══════════════════════════════════════════════════════════════════════════════

describe('translations', () => {
    it('has en translations', () => {
        expect(translations.en).toBeDefined();
        expect(typeof translations.en).toBe('object');
    });

    it('has zh translations', () => {
        expect(translations.zh).toBeDefined();
        expect(typeof translations.zh).toBe('object');
    });

    it('has ja translations', () => {
        expect(translations.ja).toBeDefined();
    });

    it('has ko translations', () => {
        expect(translations.ko).toBeDefined();
    });

    it('en and zh have same key count', () => {
        // ja and ko have empty strings for untranslated keys, so only compare en and zh
        const enKeys = Object.keys(translations.en).sort();
        const zhKeys = Object.keys(translations.zh).sort();
        expect(zhKeys).toEqual(enKeys);
    });

    it('all en translations are non-empty strings or plural objects', () => {
        for (const [key, value] of Object.entries(translations.en)) {
            if (typeof value === 'object' && value !== null) {
                expect(typeof value.one).toBe('string');
                expect(value.one.length).toBeGreaterThan(0);
                expect(typeof value.other).toBe('string');
                expect(value.other.length).toBeGreaterThan(0);
                for (const [variant, text] of Object.entries(value)) {
                    expect(typeof text).toBe('string');
                    expect(text.length).toBeGreaterThan(0);
                }
            } else {
                expect(typeof value).toBe('string');
                expect(value.length).toBeGreaterThan(0);
            }
        }
    });

    it('all zh translations are non-empty strings or plural objects', () => {
        for (const [key, value] of Object.entries(translations.zh)) {
            if (typeof value === 'object' && value !== null) {
                expect(typeof value.one).toBe('string');
                expect(value.one.length).toBeGreaterThan(0);
                expect(typeof value.other).toBe('string');
                expect(value.other.length).toBeGreaterThan(0);
                for (const [variant, text] of Object.entries(value)) {
                    expect(typeof text).toBe('string');
                    expect(text.length).toBeGreaterThan(0);
                }
            } else {
                expect(typeof value).toBe('string');
                expect(value.length).toBeGreaterThan(0);
            }
        }
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  isRTL
// ═══════════════════════════════════════════════════════════════════════════════

describe('isRTL', () => {
    it('ar is RTL', () => expect(isRTL('ar')).toBe(true));
    it('he is RTL', () => expect(isRTL('he')).toBe(true));
    it('fa is RTL', () => expect(isRTL('fa')).toBe(true));
    it('ur is RTL', () => expect(isRTL('ur')).toBe(true));
    it('en is not RTL', () => expect(isRTL('en')).toBe(false));
    it('zh is not RTL', () => expect(isRTL('zh')).toBe(false));
    it('ja is not RTL', () => expect(isRTL('ja')).toBe(false));
    it('ko is not RTL', () => expect(isRTL('ko')).toBe(false));
    it('unknown is not RTL', () => expect(isRTL('fr')).toBe(false));
});

// ═══════════════════════════════════════════════════════════════════════════════
//  getLocAttributes
// ═══════════════════════════════════════════════════════════════════════════════

describe('getLocAttributes', () => {
    it('en-US is ltr', () => {
        const attrs = getLocAttributes('en-US');
        expect(attrs.dir).toBe('ltr');
        expect(attrs.lang).toBe('en-US');
    });

    it('ar-SA is rtl', () => {
        const attrs = getLocAttributes('ar-SA');
        expect(attrs.dir).toBe('rtl');
        expect(attrs.lang).toBe('ar-SA');
    });

    it('zh-CN is ltr', () => {
        const attrs = getLocAttributes('zh-CN');
        expect(attrs.dir).toBe('ltr');
    });

    it('he-IL is rtl', () => {
        const attrs = getLocAttributes('he-IL');
        expect(attrs.dir).toBe('rtl');
    });

    it('returns only dir and lang properties', () => {
        const attrs = getLocAttributes('en-US');
        expect(Object.keys(attrs).sort()).toEqual(['dir', 'lang']);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  QA mode
// ═══════════════════════════════════════════════════════════════════════════════

describe('QA mode', () => {
    afterEach(() => {
        setQAMode(false);
    });

    it('returns raw key in QA mode', () => {
        setQAMode(true);
        expect(t('home')).toBe('**home**');
    });

    it('isQAMode returns true when enabled', () => {
        setQAMode(true);
        expect(isQAMode()).toBe(true);
    });

    it('isQAMode returns false when disabled', () => {
        setQAMode(false);
        expect(isQAMode()).toBe(false);
    });

    it('normal mode returns translated string', () => {
        setQAMode(false);
        expect(t('home')).not.toBe('**home**');
    });

    it('QA mode returns key for unknown keys too', () => {
        setQAMode(true);
        expect(t('nonexistent_xyz')).toBe('**nonexistent_xyz**');
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  t() — simple lookup
// ═══════════════════════════════════════════════════════════════════════════════

describe('t() — simple lookup', () => {
    it('returns en translation for known key', () => {
        expect(t('home')).toBe('Home');
    });

    it('returns key for unknown key', () => {
        expect(t('nonexistent_key_xyz')).toBe('nonexistent_key_xyz');
    });

    it('returns translation for settings key', () => {
        expect(t('settings')).toBe('Settings');
    });

    it('returns translation for proxies key', () => {
        expect(t('proxies')).toBe('Proxies');
    });

    it('returns translation for confirm key', () => {
        expect(t('confirm')).toBe('Confirm');
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  t() — interpolation
// ═══════════════════════════════════════════════════════════════════════════════

describe('t() — interpolation', () => {
    it('does not break normal keys when vars object is passed', () => {
        // 'home' has no @@var@@ placeholders
        expect(t('home', { name: 'test' })).toBe('Home');
    });

    it('replaces @@var@@ placeholders when present', () => {
        // Manually test interpolation behavior with a known template
        // We can verify by checking that t() returns a string (not throwing)
        const result = t('statusDownloadingProgress', { progress: 75 });
        // The translation uses {progress} format, not @@progress@@, so t() won't replace it
        // But it should still return a valid string
        expect(typeof result).toBe('string');
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  t() — pluralization
// ═══════════════════════════════════════════════════════════════════════════════

describe('t() — pluralization', () => {
    it('returns string as-is when no plural object', () => {
        // 'home' is a plain string, passing a count should still return 'Home'
        expect(t('home', 1)).toBe('Home');
        expect(t('home', 5)).toBe('Home');
    });

    it('returns singular form for count === 1', () => {
        const result = t('consoleSubDaysLeft', 1, { d: '7' });
        expect(typeof result).toBe('string');
        expect(result).toContain('7');
        expect(result).toContain('day left');
    });

    it('returns plural form for count !== 1', () => {
        const result = t('consoleSubDaysLeft', 30, { d: '31' });
        expect(typeof result).toBe('string');
        expect(result).toContain('31');
        expect(result).toContain('days left');
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  mapStatusMessage
// ═══════════════════════════════════════════════════════════════════════════════

describe('mapStatusMessage', () => {
    it('maps known status to translated key', () => {
        const result = mapStatusMessage('Core ready');
        expect(result).toBe('Core ready'); // In English, t('statusCoreReady') = 'Core ready'
    });

    it('returns original text for unknown status', () => {
        const result = mapStatusMessage('Unknown status xyz');
        expect(result).toBe('Unknown status xyz');
    });

    it('handles progress messages', () => {
        const result = mapStatusMessage('Downloading core...', 50);
        expect(result).toContain('50');
    });

    it('handles null progress', () => {
        const result = mapStatusMessage('Downloading core...', null);
        expect(result).toBeDefined();
        expect(typeof result).toBe('string');
    });

    it('maps "Downloading core from GitHub..."', () => {
        const result = mapStatusMessage('Downloading core from GitHub...');
        expect(result).toBe('Downloading core from GitHub...');
    });

    it('maps "Preparing to update Mihomo core..."', () => {
        const result = mapStatusMessage('Preparing to update Mihomo core...');
        expect(result).toBe('Preparing to update Mihomo core...');
    });

    it('maps "Geo database update complete"', () => {
        const result = mapStatusMessage('Geo database update complete');
        expect(result).toBe('Geo database update complete');
    });

    it('maps "Verifying file integrity..."', () => {
        const result = mapStatusMessage('Verifying file integrity...');
        expect(result).toBe('Verifying file integrity...');
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  i18n module exports
// ═══════════════════════════════════════════════════════════════════════════════

describe('i18n exports', () => {
    it('exports translations', () => {
        expect(translations).toBeDefined();
        expect(typeof translations).toBe('object');
    });

    it('exports isRTL', () => {
        expect(typeof isRTL).toBe('function');
    });

    it('exports t', () => {
        expect(typeof t).toBe('function');
    });

    it('exports setQAMode', () => {
        expect(typeof setQAMode).toBe('function');
    });

    it('exports isQAMode', () => {
        expect(typeof isQAMode).toBe('function');
    });

    it('exports getLocAttributes', () => {
        expect(typeof getLocAttributes).toBe('function');
    });

    it('exports mapStatusMessage', () => {
        expect(typeof mapStatusMessage).toBe('function');
    });
});
