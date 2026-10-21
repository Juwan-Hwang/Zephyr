import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const { saveSetting } = vi.hoisted(() => ({ saveSetting: vi.fn(() => Promise.resolve()) }));
vi.mock('./settings-helpers.js', () => ({ saveSetting, saveSettings: vi.fn(() => Promise.resolve()) }));

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = resolve(SRC, '../../..');

describe('default theme', () => {
    beforeEach(() => {
        vi.resetModules();
        saveSetting.mockClear();
        localStorage.clear();
        document.documentElement.className = '';
        document.documentElement.removeAttribute('style');
    });

    it('defaults to blue', async () => {
        const theme = await import('./theme.js');
        expect(theme.DEFAULT_THEME).toBe('blue');
        expect(theme.currentTheme).toBe('blue');
    });

    it('no longer offers a purple preset', async () => {
        const { VALID_THEMES } = await import('./theme.js');
        expect(VALID_THEMES.has('purple')).toBe(false);
        expect(VALID_THEMES.has('blue')).toBe(true);
    });

    it('normalizeTheme migrates purple, keeps hex, falls back to blue', async () => {
        const { normalizeTheme } = await import('./theme.js');
        expect(normalizeTheme('purple')).toBe('blue');
        expect(normalizeTheme('green')).toBe('green');
        expect(normalizeTheme('#8b5cf6')).toBe('#8b5cf6');
        expect(normalizeTheme('nonsense')).toBe('blue');
        expect(normalizeTheme(null)).toBe('blue');
        expect(normalizeTheme('')).toBe('blue');
    });

    it('normalizeTheme keeps #rgb / #rrggbb and drops malformed hex', async () => {
        const { normalizeTheme } = await import('./theme.js');
        expect(normalizeTheme('#ABC')).toBe('#ABC');
        expect(normalizeTheme(' #00ff7a ')).toBe('#00ff7a');
        expect(normalizeTheme('#')).toBe('blue');
        expect(normalizeTheme('#12345')).toBe('blue');
        expect(normalizeTheme('#zzzzzz')).toBe('blue');
        expect(normalizeTheme('#00ff7a; color: red')).toBe('blue');
    });

    it('applyTheme("purple") applies the blue preset', async () => {
        const theme = await import('./theme.js');
        theme.applyTheme('purple');
        const cls = document.documentElement.classList;
        expect(cls.contains('theme-blue')).toBe(true);
        expect(cls.contains('theme-purple')).toBe(false);
        expect(theme.currentTheme).toBe('blue');
    });

    it('applyTheme keeps custom hex themes untouched', async () => {
        const theme = await import('./theme.js');
        theme.applyTheme('#8b5cf6');
        expect(theme.currentTheme).toBe('#8b5cf6');
        expect(document.documentElement.style.getPropertyValue('--accent-primary')).toBe('#8b5cf6');
    });

    it('app store migrates a persisted purple theme to blue and writes it back', async () => {
        localStorage.setItem('zephyr.app', JSON.stringify({ currentTheme: 'purple' }));
        localStorage.setItem('appTheme', 'purple');
        vi.useFakeTimers();
        try {
            const { appStore } = await import('./state.js');
            expect(appStore.get('currentTheme')).toBe('blue');
            expect(localStorage.getItem('appTheme')).toBe('blue');
            // The store persists on a debounce; flush it and check what the next launch reads.
            vi.runAllTimers();
            expect(JSON.parse(localStorage.getItem('zephyr.app') || '{}').currentTheme).toBe('blue');
        } finally {
            vi.useRealTimers();
        }
    });

    it('app store keeps a persisted custom hex theme', async () => {
        localStorage.setItem('zephyr.app', JSON.stringify({ currentTheme: '#ff8800' }));
        const { appStore } = await import('./state.js');
        expect(appStore.get('currentTheme')).toBe('#ff8800');
    });

    it('settings init migrates a saved purple theme and persists it', async () => {
        const { initThemeSettings } = await import('./settings/theme.js');
        const { appStore } = await import('./state.js');
        const save = vi.fn(() => Promise.resolve());
        initThemeSettings({
            savedTheme: 'purple',
            savedThemeMode: 'dark',
            savedOpacity: 100,
            appMainContainer: null,
            appTitleIcon: null,
            themeCircles: /** @type {any} */ (document.querySelectorAll('[data-theme]')),
            customColorInput: null,
            opacitySlider: null,
            opacityValText: null,
            themeModeContainer: null,
            themeModeButtons: [],
            save,
        });
        expect(appStore.get('currentTheme')).toBe('blue');
        expect(document.documentElement.classList.contains('theme-blue')).toBe(true);
        // Only the theme field is patched; no full-settings read-modify-write.
        expect(saveSetting).toHaveBeenCalledWith('theme', 'blue');
        expect(save).not.toHaveBeenCalled();
    });

    it('settings init does not re-save a valid saved theme', async () => {
        const { initThemeSettings } = await import('./settings/theme.js');
        const save = vi.fn(() => Promise.resolve());
        initThemeSettings({
            savedTheme: 'green',
            savedThemeMode: 'dark',
            savedOpacity: 100,
            appMainContainer: null,
            appTitleIcon: null,
            themeCircles: /** @type {any} */ (document.querySelectorAll('[data-theme]')),
            customColorInput: null,
            opacitySlider: null,
            opacityValText: null,
            themeModeContainer: null,
            themeModeButtons: [],
            save,
        });
        expect(save).not.toHaveBeenCalled();
        expect(saveSetting).not.toHaveBeenCalledWith('theme', expect.anything());
    });
});

describe('purple removed from markup and tokens', () => {
    it('settings palette has no purple swatch', () => {
        const html = readFileSync(resolve(SRC, 'index.html'), 'utf-8');
        expect(html).not.toMatch(/data-theme="purple"/);
        expect(html).not.toMatch(/purple-\d{3}/);
    });

    it('token theme presets and accent default no longer include purple', () => {
        const themeCss = readFileSync(resolve(ROOT, 'packages/tokens/build/css/theme.css'), 'utf-8');
        expect(themeCss).not.toMatch(/theme-purple/);
        const vars = readFileSync(resolve(ROOT, 'packages/tokens/build/css/variables.css'), 'utf-8');
        expect(vars).toMatch(/--zephyr-color-accent: #007AFF;/);
        expect(vars).not.toMatch(/purple/i);
    });

});

describe('traffic colours: fixed blue download, fixed coral upload', () => {
    const vars = () => readFileSync(resolve(ROOT, 'packages/tokens/build/css/variables.css'), 'utf-8');
    /** @param {string} hex */
    const luminance = (hex) => {
        const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
            .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    /** @param {string} a @param {string} b */
    const contrast = (a, b) => {
        const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
        return (hi + 0.05) / (lo + 0.05);
    };

    it('download is blue in both modes (dark #0A84FF, light #007AFF)', () => {
        expect(vars()).toMatch(/:root \{[^}]*--zephyr-color-download: #0A84FF;/);
        expect(vars()).toMatch(/html:not\(\.dark\) \{[^}]*--zephyr-color-download: #007AFF;/);
    });

    it('upload is a soft coral in both modes (dark #FF6B6B, light #D13A3F)', () => {
        expect(vars()).toMatch(/:root \{[^}]*--zephyr-color-upload: #FF6B6B;/);
        expect(vars()).toMatch(/html:not\(\.dark\) \{[^}]*--zephyr-color-upload: #D13A3F;/);
    });

    it('light-mode upload text keeps >= 4.5:1 contrast on the light surfaces', () => {
        expect(contrast('#D13A3F', '#ffffff')).toBeGreaterThanOrEqual(4.5);
        expect(contrast('#D13A3F', '#f8fafc')).toBeGreaterThanOrEqual(4.5);
    });

    it('the amber download definition is gone but the warning colour is untouched', () => {
        expect(vars()).not.toMatch(/--zephyr-color-download: #(f59e0b|d97706);/i);
        expect(vars()).toMatch(/--zephyr-color-warning: #f59e0b;/);
        expect(vars()).toMatch(/--zephyr-color-warning: #d97706;/);
    });

    it('traffic chart, classic home and connections page use the traffic tokens, not purple literals', () => {
        for (const file of ['modules/traffic-chart.js', 'ui/console-home.js', 'modules/connections.js']) {
            const src = readFileSync(resolve(SRC, file), 'utf-8');
            expect(src, file).not.toMatch(/175,\s*82,\s*222|#af52de|purple/i);
        }
        const home = readFileSync(resolve(SRC, 'ui/console-home.js'), 'utf-8');
        expect(home).toMatch(/--zephyr-color-download/);
        expect(home).toMatch(/--zephyr-color-upload/);
        const conn = readFileSync(resolve(SRC, 'modules/connections.js'), 'utf-8');
        expect(conn).toMatch(/text-download/);
        expect(conn).toMatch(/text-upload/);
        expect(conn).not.toMatch(/#60a5fa|96,165,250/);
        const html = readFileSync(resolve(SRC, 'index.html'), 'utf-8');
        expect(html).toMatch(/bg-download\/80/);
        expect(html).toMatch(/bg-upload\/80/);
    });

    it('getThemeColors falls back to the fixed blue/coral pair', async () => {
        document.documentElement.removeAttribute('style');
        const { getThemeColors } = await import('../utils/color.js');
        const c = getThemeColors();
        expect(c.download).toBe('#0A84FF');
        expect(c.upload).toBe('#FF6B6B');
    });
});

describe('keyboard focus ring', () => {
    const css = () => readFileSync(resolve(SRC, 'styles.css'), 'utf-8');

    it('no stale focus colour token competes with the accent-based ring', () => {
        const vars = readFileSync(resolve(ROOT, 'packages/tokens/build/css/variables.css'), 'utf-8');
        expect(vars).not.toMatch(/--zephyr-focus-color:/);
        expect(css()).not.toMatch(/--zephyr-focus-color/);
    });

    it('focus ring follows the theme accent with a visible blue hard fallback', () => {
        const ring = css().match(/--zephyr-focus-ring: ([^;]+);/)?.[1] ?? '';
        expect(ring).toMatch(/var\(--accent-primary, #007AFF\)/);
        expect(ring).not.toMatch(/af52de|purple|violet/i);
        expect(css()).toMatch(/--color-accent: var\(--accent-primary, #007AFF\);/);
    });

    it('global :focus-visible outline keeps its 2px width/offset and a real colour', () => {
        const rule = css().match(/\):focus-visible \{\s*outline: ([^;]+);\s*outline-offset: ([^;]+);/);
        expect(rule).not.toBeNull();
        expect(rule?.[1]).toBe('2px solid var(--color-accent)');
        expect(rule?.[2]).toBe('2px');
        expect(rule?.[1]).not.toMatch(/transparent|none/);
    });

    it('ring opacity keeps the ring >= 3:1 against the dark and light backgrounds', () => {
        const vars = readFileSync(resolve(ROOT, 'packages/tokens/build/css/variables.css'), 'utf-8');
        const alphas = [...vars.matchAll(/--zephyr-focus-ring-alpha: (\d+)%;/g)].map((m) => Number(m[1]) / 100);
        expect(alphas.length).toBeGreaterThanOrEqual(1);
        /** @param {string} fg @param {string} bg @param {number} a */
        const blend = (fg, bg, a) => '#' + [1, 3, 5].map((i) => Math.round(
            parseInt(fg.slice(i, i + 2), 16) * a + parseInt(bg.slice(i, i + 2), 16) * (1 - a),
        ).toString(16).padStart(2, '0')).join('');
        for (const a of alphas) {
            const lum = (/** @type {string} */ h) => {
                const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
                    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
                return 0.2126 * r + 0.7152 * g + 0.0722 * b;
            };
            const cr = (/** @type {string} */ x, /** @type {string} */ y) => {
                const [hi, lo] = [lum(x), lum(y)].sort((p, q) => q - p);
                return (hi + 0.05) / (lo + 0.05);
            };
            expect(cr(blend('#007AFF', '#18181b', a), '#18181b')).toBeGreaterThanOrEqual(3);
            expect(cr(blend('#007AFF', '#f8fafc', a), '#f8fafc')).toBeGreaterThanOrEqual(3);
        }
    });
});

describe('focus ring contrast in light mode', () => {
    it('uses a darker, opaque shade of the accent with a blue fallback', () => {
        const css = readFileSync(resolve(SRC, 'styles.css'), 'utf-8');
        const start = css.indexOf('html:not(.dark) {');
        expect(start).toBeGreaterThanOrEqual(0);
        const block = css.slice(start, css.indexOf('}', start));
        expect(block).toContain('--zephyr-focus-ring: color-mix(in srgb, var(--accent-primary, #007AFF) 75%, black);');
    });
});
