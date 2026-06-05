// @ts-check
/**
 * Theme management.
 * Extracted from ui.js lines ~356-397.
 *
 * @module ui/theme
 */

/** Currently active theme name or hex color string. */
export let currentTheme = 'purple';

const VALID_THEMES = new Set(['purple', 'blue', 'green', 'orange', 'pink', 'zinc']);

const THEME_CLASSES = [
    'theme-purple', 'theme-blue', 'theme-green',
    'theme-orange', 'theme-pink', 'theme-zinc',
];

/**
 * Apply a theme to the document element.
 * Supports both preset theme names and hex color strings.
 *
 * @param {string} theme - Theme name (e.g. 'purple') or hex color (e.g. '#8b5cf6')
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
        const rv = isNaN(r) ? 175 : r;
        const gv = isNaN(g) ? 82 : g;
        const bv = isNaN(b) ? 222 : b;
        document.documentElement.style.setProperty('--accent-glow', `rgba(${rv}, ${gv}, ${bv}, 0.2)`);
        document.documentElement.style.setProperty('--accent-rgb', `${rv}, ${gv}, ${bv}`);
    } else {
        document.documentElement.style.removeProperty('--accent-primary');
        document.documentElement.style.removeProperty('--accent-glow');
        document.documentElement.style.removeProperty('--accent-rgb');

        const t = VALID_THEMES.has(theme) ? theme : 'purple';
        document.documentElement.classList.add(`theme-${t}`);
        currentTheme = t;
    }

    // Sync the custom color input if it's a hex theme
    /** @type {HTMLInputElement|null} */
    const customColorInput = /** @type {HTMLInputElement|null} */ (document.getElementById('custom-theme-color'));
    if (customColorInput && theme && theme.startsWith('#')) {
        customColorInput.value = theme;
    }
}
