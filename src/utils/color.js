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
 * hexToRgb('#8b5cf6'); // { r: 139, g: 92, b: 246 }
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
 * Read theme-aware accent and secondary colors from CSS custom properties.
 * Falls back to sensible defaults if the variables are not defined.
 *
 * @returns {{ accent: string, secondary: string }} Color values from CSS variables
 *
 * @example
 * const { accent, secondary } = getThemeColors();
 * element.style.color = accent;
 */
export function getThemeColors() {
    const style = getComputedStyle(document.documentElement);

    return {
        accent: style.getPropertyValue('--color-accent').trim() || '#8b5cf6',
        secondary: style.getPropertyValue('--color-secondary').trim() || '#3b82f6',
    };
}
