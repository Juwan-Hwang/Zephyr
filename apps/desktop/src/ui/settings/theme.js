// @ts-check
/**
 * Theme management submodule for settings.
 *
 * Handles theme color selection, dark/light/auto mode switching,
 * opacity slider, and system theme media query listener.
 *
 * @module ui/settings/theme
 */

import { applyTheme } from '../theme.js';
import { appStore } from '../state.js';
import { Bus, Events } from '../events.js';
import { debounce } from '../../utils/debounce.js';
import { saveSetting } from '../settings-helpers.js';

/**
 * Initialize theme-related settings controls.
 *
 * @param {object} opts
 * @param {string} opts.savedTheme - The theme color string from backend settings (e.g. "zinc").
 * @param {string|null} opts.savedThemeMode - The theme mode from backend settings ("light", "dark", "auto").
 * @param {number|null} opts.savedOpacity - The opacity value from backend settings (0-100).
 * @param {HTMLElement|null} opts.appMainContainer - The main app container element.
 * @param {HTMLElement|null} opts.appTitleIcon - The app title icon element.
 * @param {NodeListOf<HTMLElement>} opts.themeCircles - All [data-theme] circle elements.
 * @param {HTMLInputElement|null} opts.customColorInput - The custom theme color input.
 * @param {HTMLInputElement|null} opts.opacitySlider - The opacity slider input.
 * @param {HTMLElement|null} opts.opacityValText - The opacity value display text.
 * @param {HTMLElement|null} opts.themeModeContainer - The theme mode toggle container.
 * @param {HTMLElement|null} opts.themeModeSlider - The theme mode slider indicator.
 * @param {HTMLElement[]} opts.themeModeButtons - The [data-theme-mode] button elements.
 * @param {() => Promise<void>} opts.save - Callback to persist settings to backend.
 */
export function initThemeSettings({
    savedTheme,
    savedThemeMode,
    savedOpacity,
    appMainContainer,
    appTitleIcon,
    themeCircles,
    customColorInput,
    opacitySlider,
    opacityValText,
    themeModeContainer,
    themeModeSlider,
    themeModeButtons,
    save,
}) {
    // ---- Theme color handling ----
    /**
     * @param {string} themeStr
     */
    const applyColorTheme = (themeStr) => {
        applyTheme(themeStr);
    };

    // ---- Theme mode handling ----
    /**
     * @param {boolean} isDark
     */
    const applyDarkMode = (isDark) => {
        if (isDark) {
            document.documentElement.classList.add('dark');
            if (appTitleIcon) appTitleIcon.src = 'dark-icon.png';
        } else {
            document.documentElement.classList.remove('dark');
            if (appTitleIcon) appTitleIcon.src = 'app-icon.png';
        }
        if (appMainContainer) appMainContainer.style.backgroundColor = '';
    };

    /** @type {string[]} */
    const themeModeMap = ['light', 'auto', 'dark'];
    let currentThemeMode = 'auto';
    const systemThemeMedia = window.matchMedia('(prefers-color-scheme: dark)');

    /**
     * @param {string} mode
     * @returns {boolean}
     */
    const resolveThemeModeToDark = (mode) => {
        if (mode === 'dark') return true;
        if (mode === 'light') return false;
        return systemThemeMedia.matches;
    };

    /**
     * @param {string} mode
     */
    const updateThemeModeUI = (mode) => {
        const idx = themeModeMap.indexOf(mode);
        if (themeModeSlider && idx !== -1) {
            themeModeSlider.style.transform = `translateX(${idx * 100}%)`;
        }
        themeModeButtons.forEach((btn, btnIdx) => {
            if (btnIdx === idx) {
                btn.classList.add('text-zinc-100');
                btn.classList.remove('text-zinc-400');
            } else {
                btn.classList.remove('text-zinc-100');
                btn.classList.add('text-zinc-400');
            }
        });
    };

    /**
     * @param {string} mode
     * @param {boolean} [persist=true]
     */
    async function setThemeMode(mode, persist = true) {
        if (!themeModeMap.includes(mode)) return;
        currentThemeMode = mode;
        appStore.set('currentThemeMode', mode);
        updateThemeModeUI(mode);
        applyDarkMode(resolveThemeModeToDark(mode));
        Bus.emit(Events.THEME_MODE_CHANGED, mode);
        if (persist) {
            localStorage.removeItem('darkMode');
            await saveSetting('theme_mode', mode);
        }
    }

    // Apply theme mode synchronously from settings (no flicker)
    // Migrate legacy localStorage keys if theme_mode not set
    let effectiveThemeMode = savedThemeMode && themeModeMap.includes(savedThemeMode) ? savedThemeMode : null;
    if (!effectiveThemeMode) {
        // First check localStorage.themeMode (used by older versions)
        const legacyThemeMode = localStorage.getItem('themeMode');
        if (legacyThemeMode !== null && themeModeMap.includes(legacyThemeMode)) {
            effectiveThemeMode = legacyThemeMode;
            saveSetting('theme_mode', effectiveThemeMode).catch(() => {});
            localStorage.removeItem('themeMode');
        } else {
            // Then check localStorage.darkMode (even older versions)
            const legacyDarkMode = localStorage.getItem('darkMode');
            if (legacyDarkMode !== null) {
                effectiveThemeMode = legacyDarkMode === 'true' ? 'dark' : 'light';
                saveSetting('theme_mode', effectiveThemeMode).catch(() => {});
                localStorage.removeItem('darkMode');
            } else {
                effectiveThemeMode = 'auto';
            }
        }
    }
    setThemeMode(effectiveThemeMode, false);

    if (!themeModeContainer?.dataset.bound) {
        if (themeModeContainer) themeModeContainer.dataset.bound = '1';
        themeModeButtons.forEach((btn) => {
            /** @type {HTMLElement} */ (btn).onclick = () => {
                const mode = btn.getAttribute('data-theme-mode');
                if (!mode) return;
                setThemeMode(mode, true);
            };
        });
    }

    /**
     * @param {MediaQueryListEvent} event
     */
    const systemThemeListener = (event) => {
        if (currentThemeMode === 'auto') {
            applyDarkMode(event.matches);
            Bus.emit(Events.THEME_MODE_CHANGED, 'auto');
        }
    };
    // Only register once -- prevent duplicate listeners on re-init
    if (!systemThemeMedia._zephyrBound) {
        if (typeof systemThemeMedia.addEventListener === 'function') {
            systemThemeMedia.addEventListener('change', systemThemeListener);
        } else if (typeof systemThemeMedia.addListener === 'function') {
            systemThemeMedia.addListener(systemThemeListener);
        }
        systemThemeMedia._zephyrBound = true;
    }

    applyColorTheme(savedTheme);

    if (customColorInput) {
        customColorInput.onchange = () => {
            const color = customColorInput.value;
            applyColorTheme(color);
            save();
        };
    }

    // ---- Theme circles ----
    themeCircles.forEach(circle => {
        /** @type {HTMLElement} */ (circle).onclick = () => {
            const theme = circle.getAttribute('data-theme') || '';
            applyTheme(theme);
            appStore.set('currentTheme', theme);
            Bus.emit(Events.THEME_CHANGED, theme);
            save();
        };
    });

    // ---- Opacity slider (with debounce) ----
    // Use synchronously passed value to avoid UI flicker
    const rawOpacity = savedOpacity != null ? Number(savedOpacity) : 100;
    const opacityVal = Number.isFinite(rawOpacity) ? String(Math.min(100, Math.max(0, rawOpacity))) : '100';
    document.documentElement.style.setProperty('--app-opacity', String(Number(opacityVal) / 100));
    if (opacitySlider) {
        opacitySlider.value = opacityVal;
        if (opacityValText) opacityValText.textContent = `${opacityVal}%`;

        const debouncedOpacity = debounce(/** @param {string} val */ (val) => {
            document.documentElement.style.setProperty('--app-opacity', String(Number(val) / 100));
            saveSetting('app_opacity', Number(val));
        }, 50);

        opacitySlider.addEventListener('input', (e) => {
            const target = /** @type {HTMLInputElement} */ (e.target);
            const val = target.value;
            if (opacityValText) opacityValText.textContent = `${val}%`;
            debouncedOpacity(val);
        });
    }

    // Return helpers needed by restore defaults
    return {
        setThemeMode,
        applyColorTheme,
    };
}
