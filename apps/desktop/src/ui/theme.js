// @ts-check
/**
 * Theme management.
 * Extracted from ui.js lines ~356-397.
 *
 * @module ui/theme
 */

/** Currently active theme name or hex color string. */
export let currentTheme = 'blue';

/** Theme applied when nothing (or something unknown) is saved. */
export const DEFAULT_THEME = 'blue';

export const VALID_THEMES = new Set(['blue', 'green', 'orange', 'pink', 'zinc']);

/**
 * Preset names that were removed but may still be persisted in user
 * settings / localStorage. They are transparently mapped to a current preset.
 * @type {Readonly<Record<string, string>>}
 */
const LEGACY_THEME_ALIASES = Object.freeze({ purple: 'blue' });

const THEME_CLASSES = [
    'theme-purple', 'theme-blue', 'theme-green',
    'theme-orange', 'theme-pink', 'theme-zinc',
];

/** A custom accent: #rgb or #rrggbb, the forms applyTheme can expand. */
const HEX_THEME_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** @param {number} channel */
function linearChannel(channel) {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

/** Darken an accent to the requested luminance while retaining its hue.
 * @param {number[]} rgb
 * @param {number} shade
 * @param {number} [maxLuminance]
 */
function shadedAccent(rgb, shade, maxLuminance = 0.175) {
    let channels = rgb.map((c) => Math.floor(c * shade));
    while (0.2126 * linearChannel(channels[0]) + 0.7152 * linearChannel(channels[1]) + 0.0722 * linearChannel(channels[2]) > maxLuminance) {
        shade = Math.max(0, shade - 0.01);
        channels = rgb.map((c) => Math.floor(c * shade));
    }
    return `rgb(${channels.join(', ')})`;
}

/** @param {string} accent */
function applyButtonContrast(accent) {
    let hex = HEX_THEME_RE.test(accent) ? accent.slice(1) : '007aff';
    if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
    const rgb = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
    const style = document.documentElement.style;
    style.setProperty('--accent-button-bg', shadedAccent(rgb, 0.84));
    style.setProperty('--accent-button-hover-light', shadedAccent(rgb, 0.74));
    style.setProperty('--accent-button-hover-dark', shadedAccent(rgb, 0.90));
    // Light surfaces may also carry a subtle accent tint: leave more contrast than white requires.
    style.setProperty('--accent-text-light', shadedAccent(rgb, 0.72, 0.1));
}

/**
 * Normalize a persisted theme value: well-formed custom hex colors are kept as-is
 * (a malformed one falls back to the default),
 * legacy preset names are migrated, unknown values fall back to the default.
 *
 * @param {unknown} theme
 * @returns {string}
 */
export function normalizeTheme(theme) {
    if (typeof theme !== 'string' || !theme.trim()) return DEFAULT_THEME;
    const value = theme.trim();
    if (value.startsWith('#')) return HEX_THEME_RE.test(value) ? value : DEFAULT_THEME;
    if (Object.prototype.hasOwnProperty.call(LEGACY_THEME_ALIASES, value)) return LEGACY_THEME_ALIASES[value];
    return VALID_THEMES.has(value) ? value : DEFAULT_THEME;
}

/**
 * Apply a theme to the document element.
 * Supports both preset theme names and hex color strings.
 *
 * @param {string} theme - Theme name (e.g. 'blue') or hex color (e.g. '#007aff')
 */
export function applyTheme(theme) {
    currentTheme = theme;

    // Remove all possible theme classes from html element
    THEME_CLASSES.forEach(cls => document.documentElement.classList.remove(cls));

    if (theme && theme.startsWith('#')) {
        document.documentElement.style.setProperty('--accent-primary', theme);

        // Expand 3-char hex (#fff) to 6-char (#ffffff) for consistent parsing
        let hex = theme.slice(1);
        if (hex.length === 3) {
            hex = hex.split('').map(c => c + c).join('');
        }
        const r = parseInt(hex.slice(0, 2), 16);
        const g = parseInt(hex.slice(2, 4), 16);
        const b = parseInt(hex.slice(4, 6), 16);
        const rv = isNaN(r) ? 0 : r;
        const gv = isNaN(g) ? 122 : g;
        const bv = isNaN(b) ? 255 : b;
        document.documentElement.style.setProperty('--accent-glow', `rgba(${rv}, ${gv}, ${bv}, 0.2)`);
        document.documentElement.style.setProperty('--accent-rgb', `${rv}, ${gv}, ${bv}`);
    } else {
        document.documentElement.style.removeProperty('--accent-primary');
        document.documentElement.style.removeProperty('--accent-glow');
        document.documentElement.style.removeProperty('--accent-rgb');

        const t = normalizeTheme(theme);
        document.documentElement.classList.add(`theme-${t}`);
        currentTheme = t;
    }

    applyButtonContrast(theme && theme.startsWith('#') ? theme
        : getComputedStyle(document.documentElement).getPropertyValue('--accent-primary').trim());

    // Sync the custom color input if it's a hex theme
    /** @type {HTMLInputElement|null} */
    const customColorInput = /** @type {HTMLInputElement|null} */ (document.getElementById('custom-theme-color'));
    if (customColorInput && theme && theme.startsWith('#')) {
        customColorInput.value = theme;
    }
}
