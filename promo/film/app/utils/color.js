// @ts-check
/**
 * Color utility functions.
 *
 * @module color
 */

/**
 * Parse a hex color string to its RGB components.
 *
 * @param {string} hex - Hex color string, e.g. "#ff00aa" or "ff00aa"
 * @returns {{ r: number, g: number, b: number } | null} RGB object, or null if invalid
 *
 * @example
 * hexToRgb('#007aff'); // { r: 0, g: 122, b: 255 }
 * hexToRgb('invalid');  // null
 */
export function hexToRgb(hex) {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result
        ? {
              r: parseInt(result[1], 16),
              g: parseInt(result[2], 16),
              b: parseInt(result[3], 16),
          }
        : null;
}

/**
 * Read the theme accent and the fixed traffic colours from CSS custom properties.
 * Download (blue) and upload (coral) are fixed per light/dark mode and do not
 * follow the accent. Falls back to the dark-mode defaults if a variable is missing.
 *
 * @returns {{ accent: string, download: string, upload: string, secondary: string }} Color values from CSS variables
 *
 * @example
 * const { download, upload } = getThemeColors();
 * element.style.color = accent;
 */
export function getThemeColors() {
    const style = getComputedStyle(document.documentElement);

    return {
        accent: style.getPropertyValue('--accent-primary').trim() || '#007AFF',
        download: style.getPropertyValue('--zephyr-color-download').trim() || '#0A84FF',
        upload: style.getPropertyValue('--zephyr-color-upload').trim() || '#FF6B6B',
        secondary: style.getPropertyValue('--color-secondary').trim() || '#3b82f6',
    };
}
