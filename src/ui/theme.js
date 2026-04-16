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
 * Apply a theme to the document body.
 * Supports both preset theme names and hex color strings.
 *
 * @param {string} theme - Theme name (e.g. 'purple') or hex color (e.g. '#8b5cf6')
 */
export function applyTheme(theme) {
    currentTheme = theme;

    // Remove all possible theme classes
    THEME_CLASSES.forEach(cls => document.body.classList.remove(cls));

    if (theme && theme.startsWith('#')) {
        document.body.style.setProperty('--color-accent', theme);

        // Calculate glow from hex
        const r = parseInt(theme.slice(1, 3), 16) || 139;
        const g = parseInt(theme.slice(3, 5), 16) || 92;
        const b = parseInt(theme.slice(5, 7), 16) || 246;
        document.body.style.setProperty('--color-accent-glow', `rgba(${r}, ${g}, ${b}, 0.2)`);
    } else {
        document.body.style.removeProperty('--color-accent');
        document.body.style.removeProperty('--color-accent-glow');

        const t = VALID_THEMES.has(theme) ? theme : 'purple';
        document.body.classList.add(`theme-${t}`);
        currentTheme = t;
    }

    // Sync the custom color input if it's a hex theme
    /** @type {HTMLInputElement|null} */
    const customColorInput = /** @type {HTMLInputElement|null} */ (document.getElementById('custom-theme-color'));
    if (customColorInput && theme && theme.startsWith('#')) {
        customColorInput.value = theme;
    }
}
