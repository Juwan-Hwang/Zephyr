// @ts-check
/**
 * Theme management submodule for settings.
 *
 * Handles theme color selection, dark/light/auto mode switching,
 * opacity slider, and system theme media query listener.
 *
 * @module ui/settings/theme
 */

import { applyTheme, currentTheme, normalizeTheme, DEFAULT_THEME } from '../theme.js';
import { appStore } from '../state.js';
import { Bus, Events } from '../events.js';
import { debounce } from '../../utils/debounce.js';
import { saveSetting } from '../settings-helpers.js';
import { selectSegment } from '../seg-control.js';
import { t } from '../../i18n.js';

/** i18n keys naming each preset accent. */
const PRESET_NAME_KEYS = /** @type {Record<string, string>} */ ({
    blue: 'themeColorBlue',
    green: 'themeColorGreen',
    orange: 'themeColorOrange',
    pink: 'themeColorPink',
});

/**
 * Subtitle naming the accent in use, e.g. "Current: Blue (default)".
 * @param {string} theme
 * @returns {string}
 */
export function themeColorSummary(theme) {
    const value = String(theme || '').toLowerCase();
    if (value.startsWith('#')) return t('themeColorCurrent', { name: `${t('themeColorCustom')} ${value.toUpperCase()}` });
    const key = PRESET_NAME_KEYS[value];
    if (!key) return t('themeColorDesc');
    const name = t(key);
    return t(value === DEFAULT_THEME ? 'themeColorCurrentDefault' : 'themeColorCurrent', { name });
}

let languageListenerBound = false;

/**
 * Initialize theme-related settings controls.
 *
 * @param {object} opts
 * @param {string} opts.savedTheme - The theme color string from backend settings (e.g. "blue" or "#3b82f6").
 * @param {string|null} opts.savedThemeMode - The theme mode from backend settings ("light", "dark", "auto").
 * @param {number|null} opts.savedOpacity - The opacity value from backend settings (0-100).
 * @param {HTMLElement|null} opts.appMainContainer - The main app container element.
 * @param {HTMLImageElement|null} opts.appTitleIcon - The app title icon element.
 * @param {NodeListOf<HTMLElement>} opts.themeCircles - All [data-theme] circle elements.
 * @param {HTMLInputElement|null} opts.customColorInput - The custom theme color input.
 * @param {HTMLInputElement|null} opts.opacitySlider - The opacity slider input.
 * @param {HTMLElement|null} opts.opacityValText - The opacity value display text.
 * @param {HTMLElement|null} opts.themeModeContainer - The theme mode toggle container.
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
    themeModeButtons,
    save,
}) {
    // ---- Theme color handling ----
    /**
     * @param {string} themeStr
     */
    const applyColorTheme = (themeStr) => {
        applyTheme(themeStr);
        syncThemeSelection(themeStr);
    };

    /**
     * Mark the accent colour in use: ring + tick on its swatch; the custom swatch shows
     * the chosen colour instead of the rainbow once one is picked.
     * @param {string} theme
     */
    const syncThemeSelection = (theme) => {
        const value = String(theme || '').toLowerCase();
        themeCircles.forEach((circle) => {
            const preset = (/** @type {HTMLElement} */ (circle).dataset.theme || '').toLowerCase();
            const on = preset === value;
            circle.classList.toggle('is-selected', on);
            circle.setAttribute('aria-pressed', on ? 'true' : 'false');
            // Screen readers get the colour's name in the interface language.
            const nameKey = PRESET_NAME_KEYS[preset];
            if (nameKey) circle.setAttribute('aria-label', t(nameKey));
        });
        const desc = document.getElementById('theme-color-desc');
        if (desc) {
            delete desc.dataset.i18n;
            desc.textContent = themeColorSummary(value);
        }
        const swatch = document.getElementById('custom-theme-swatch');
        if (swatch) {
            const isCustom = value.startsWith('#');
            swatch.classList.toggle('is-selected', isCustom);
            swatch.style.background = isCustom ? value : '';
        }
    };

    // ---- Theme mode handling ----
    /**
     * @param {boolean} isDark
     */
    const applyDarkMode = (isDark) => {
        if (isDark) {
            document.documentElement.classList.add('dark');
            if (appTitleIcon) appTitleIcon.src = 'app-lockup-dark.svg';
        } else {
            document.documentElement.classList.remove('dark');
            if (appTitleIcon) appTitleIcon.src = 'app-lockup.svg';
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
        selectSegment(themeModeContainer, themeModeMap.indexOf(mode));
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
    void setThemeMode(effectiveThemeMode, false);

    if (!themeModeContainer?.dataset.bound) {
        if (themeModeContainer) themeModeContainer.dataset.bound = '1';
        themeModeButtons.forEach((btn) => {
            /** @type {HTMLElement} */ (btn).onclick = () => {
                const mode = btn.getAttribute('data-theme-mode');
                if (!mode) return;
                void setThemeMode(mode, true);
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
    /** @type {MediaQueryList & { _zephyrBound?: boolean }} */
    const media = systemThemeMedia;
    if (!media._zephyrBound) {
        if (typeof media.addEventListener === 'function') {
            media.addEventListener('change', systemThemeListener);
        } else if (typeof media.addListener === 'function') {
            media.addListener(systemThemeListener);
        }
        media._zephyrBound = true;
    }

    const saved = typeof savedTheme === 'string' && savedTheme.trim() ? savedTheme : null;
    const stored = appStore.get('currentTheme');
    const storedTheme = typeof stored === 'string' && stored.trim() ? stored : null;
    const initialTheme = normalizeTheme(saved ?? storedTheme ?? DEFAULT_THEME);
    applyColorTheme(initialTheme);
    appStore.set('currentTheme', currentTheme);
    // Migrate removed presets (e.g. 'purple' -> 'blue') back into settings.json.
    // Patch only the theme field through the serialized settings queue; a
    // full read-modify-write here could race a queued `theme_mode` migration.
    if (saved !== null && saved !== currentTheme) {
        saveSetting('theme', currentTheme).catch(() => {});
    }

    if (customColorInput) {
        customColorInput.onchange = () => {
            const color = customColorInput.value;
            applyColorTheme(color);
            appStore.set('currentTheme', currentTheme);
            Bus.emit(Events.THEME_CHANGED, currentTheme);
            void save();
        };
    }

    // ---- Theme circles ----
    syncThemeSelection(currentTheme);
    if (!languageListenerBound) {
        languageListenerBound = true;
        Bus.on(Events.LANGUAGE_CHANGED, () => syncThemeSelection(appStore.get('currentTheme') || currentTheme));
        // Restore Defaults (and any other writer) changes the theme without a swatch click.
        appStore.subscribe('currentTheme', () => syncThemeSelection(appStore.get('currentTheme') || DEFAULT_THEME));
    }
    themeCircles.forEach(circle => {
        /** @type {HTMLElement} */ (circle).onclick = () => {
            const theme = circle.getAttribute('data-theme') || '';
            applyTheme(theme);
            syncThemeSelection(theme);
            appStore.set('currentTheme', theme);
            Bus.emit(Events.THEME_CHANGED, theme);
            void save();
        };
    });

    // ---- Opacity slider (with debounce) ----
    // Use synchronously passed value to avoid UI flicker
    const rawOpacity = savedOpacity != null ? Number(savedOpacity) : 100;
    // Clamp to the slider's real range [10, 100] so the thumb position, the
    // visible text and aria-valuetext always agree.
    const opacityVal = Number.isFinite(rawOpacity) ? String(Math.min(100, Math.max(10, rawOpacity))) : '100';
    document.documentElement.style.setProperty('--app-opacity', String(Number(opacityVal) / 100));
    /** Cancel a pending debounced opacity save (used by Restore Defaults). */
    let cancelPendingOpacity = () => {};
    if (opacitySlider) {
        opacitySlider.value = opacityVal;
        opacitySlider.setAttribute('aria-valuetext', `${opacityVal}%`);
        if (opacityValText) opacityValText.textContent = `${opacityVal}%`;

        const debouncedOpacity = debounce(/** @param {string} val */ (val) => {
            document.documentElement.style.setProperty('--app-opacity', String(Number(val) / 100));
            void saveSetting('app_opacity', Number(val));
        }, 50);
        cancelPendingOpacity = () => debouncedOpacity.cancel();

        opacitySlider.addEventListener('input', (e) => {
            const target = /** @type {HTMLInputElement} */ (e.target);
            const val = target.value;
            if (opacityValText) opacityValText.textContent = `${val}%`;
            opacitySlider.setAttribute('aria-valuetext', `${val}%`);
            debouncedOpacity(val);
        });
    }

    // Return helpers needed by restore defaults
    return {
        setThemeMode,
        applyColorTheme,
        cancelPendingOpacity,
    };
}
