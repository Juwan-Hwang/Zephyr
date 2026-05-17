// @ts-check
/**
 * Settings page module.
 * Extracted from ui.js -- contains the entire settings initialization,
 * theme handling, config/subscription/tunnel management, fake client,
 * UWP exemption, DNS config, and advanced settings navigation.
 *
 * All dependencies are explicitly imported; no reliance on window globals
 * for cross-module state (except where the original code intentionally
 * uses window for Tauri event unlisten handles).
 */

import {
    invoke,
    listen,
    openUrl,
    restartCore,
    abortLatencyTests,
    isAutoStartEnabled,
    enableAutoStart,
    disableAutoStart,
    openConfigFolder,
    openPrismFolder,
    setSecret,
    setBaseUrl,
} from '../api.js';
import { setWsSecret, setWsBaseUrl, connectTraffic } from '../websocket.js';
import { updateTrafficData } from '../modules/traffic-chart.js';
import { translations, setLanguage } from '../i18n.js';
import { debounce } from '../utils/debounce.js';
import { settingsLogger } from '../utils/logger.js';
import { showNotification, showConfirmModal, showUpdateNotesModal } from './notifications.js';
import { applyTheme } from './theme.js';
import { appStore } from './state.js';
import { Bus, Events } from './events.js';
import { invalidateSettingsCache } from './cache.js';
import { saveSetting, saveSettings } from './settings-helpers.js';
import {
    DEFAULT_DNS_CONFIG,
    isValidIPv6,
    isValidDns,
    getDnsConfig,
    buildDnsRewritePayload,
    applyDnsRewrite,
    initDnsRewriteToggle,
} from './dns-shared.js';
import { toError } from '../types/guards.js';
import { COMMANDS } from '@zephyr/shared';
import { createFocusTrap } from '../utils/focus-trap.js';
import * as prism from './prism.js';

// The following modules have not yet been extracted from ui.js.
// We import them from ui.js for now; when they are extracted, these
// imports will be updated to point to their own files.
import { switchPage } from './navigation.js';
import { initCustomDropdown } from './dropdown.js';
import { syncCoreConfig, startSmartAutoTest, stopSmartAutoTest } from './proxies.js';

// Settings submodules
import { initThemeSettings } from './settings/theme.js';
import { initTunnelSettings } from './settings/tunnels.js';
import { initSubscriptionSettings } from './settings/subscriptions.js';

let __langDropdown = null;
let _dropUnlisten = null;

// ---------------------------------------------------------------------------
//  Utility: extract a human-readable name from a subscription URL
// ---------------------------------------------------------------------------
/**
 * @param {string} url
 * @returns {string | null}
 */
function extractNameFromUrl(url) {
    try {
        const u = new URL(url);
        const name = u.searchParams.get('name') || u.searchParams.get('remark');
        if (name) return decodeURIComponent(name);
        if (u.hash) {
            const hash = u.hash.substring(1);
            if (hash.includes('remark=')) {
                return decodeURIComponent(hash.split('remark=')[1].split('&')[0]);
            }
            if (hash.length > 2 && !hash.includes('/')) return decodeURIComponent(hash);
        }
        const pathParts = u.pathname.split('/').filter(p => p.length > 0);
        if (pathParts.length > 0) {
            const last = pathParts[pathParts.length - 1];
            const base = last.split('.')[0];
            if (base.length > 2 && base !== 'config' && base !== 'clash') return base;
        }
        return u.hostname;
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------------------
//  Fake client helpers
// ---------------------------------------------------------------------------
/** @returns {string | null} */
function getFakeClientUA() {
    const storedEnabled = localStorage.getItem('fakeClientEnabled');
    const enabled = storedEnabled === 'true';
    if (!enabled) return null;
    const type = localStorage.getItem('fakeClientType');
    if (type === 'custom') {
        const custom = localStorage.getItem('fakeClientCustom');
        return custom ? custom : null;
    }
    return type || null;
}

/** @returns {string | null} */
function getSubscriptionUserAgent() {
    return getFakeClientUA();
}

/**
 * Sync the current fake client UA to backend settings
 * so the subscription scheduler can use it for auto-updates.
 * Uses atomic field-level update to avoid Read-Modify-Write race.
 */
async function syncUserAgentToBackend() {
    try {
        const ua = getSubscriptionUserAgent();
        await invoke(COMMANDS.UPDATE_SUBSCRIPTION_USER_AGENT, { userAgent: ua });
    } catch { /* ignore */ }
}

/** Debounced version for input events (avoids IPC on every keystroke). */
const debouncedSyncUA = debounce(() => syncUserAgentToBackend(), 500);

// ---------------------------------------------------------------------------
//  initUwpExemption
// ---------------------------------------------------------------------------
export function initUwpExemption() {
    const exemptBtn = document.getElementById('exempt-uwp-btn');
    const spinner = document.getElementById('uwp-spinner');

    if (exemptBtn) {
        if (!navigator.userAgent.includes('Windows')) {
            const container = document.getElementById('uwp-loopback-item');
            if (container) container.style.display = 'none';
        }

        exemptBtn.onclick = async () => {
            if (appStore.get('isNetworkUpdating')) return;

            /** @type {any} */
            const t = /** @type {any} */ (translations)[appStore.get('currentLang')];
            const confirmed = await showConfirmModal(
                t.uwpExemptTitle || "UWP Loopback Exemption",
                t.uwpExemptDesc || "This will apply loopback exemption to all UWP apps, which requires Administrator privileges. Do you want to continue?"
            );
            if (!confirmed) return;

            appStore.set('isNetworkUpdating', true);
            exemptBtn.classList.add('opacity-50', 'cursor-not-allowed');
            spinner?.classList.remove('hidden');

            try {
                await invoke(COMMANDS.EXEMPT_UWP_APPS);
                showNotification(
                    /** @type {any} */(/** @type {any} */ (translations)[appStore.get('currentLang')]).notifUwpSuccess || 'UWP Loopback exemption process started. Please check the UAC prompt.',
                    'success'
                );
            } catch (err) {
                const error = toError(err);
                showNotification(
                    `${(/** @type {any} */(/** @type {any} */ (translations)[appStore.get('currentLang')]).notifUwpFailed || 'Failed')}: ${error}`,
                    'error'
                );
            } finally {
                appStore.set('isNetworkUpdating', false);
                exemptBtn.classList.remove('opacity-50', 'cursor-not-allowed');
                spinner?.classList.add('hidden');
            }
        };
    }
}

// ---------------------------------------------------------------------------
//  initFakeClient
// ---------------------------------------------------------------------------
function initFakeClient() {
    const toggle = /** @type {HTMLInputElement} */ (document.getElementById('setting-fake-client'));
    const optionsContainer = document.getElementById('fake-client-options');
    const select = /** @type {HTMLSelectElement} */ (document.getElementById('fake-client-select'));
    const customContainer = document.getElementById('fake-client-custom-container');
    const customInput = /** @type {HTMLInputElement} */ (document.getElementById('fake-client-custom'));
    const spinner = document.getElementById('fake-client-spinner');

    if (!toggle || !optionsContainer || !select || !customInput) return;

    let isFetching = false;
    let versionsFetched = false;

    const storedEnabled = localStorage.getItem('fakeClientEnabled');
    const savedEnabled = storedEnabled === null ? true : storedEnabled === 'true';

    if (storedEnabled === null) {
        localStorage.setItem('fakeClientEnabled', 'true');
    }

    if (!localStorage.getItem('fakeClientType')) {
        localStorage.setItem('fakeClientType', 'clash-verge/1.6.0');
    }

    const savedType = localStorage.getItem('fakeClientType') || 'clash-verge/1.6.0';
    const savedCustom = localStorage.getItem('fakeClientCustom') || '';

    toggle.checked = savedEnabled;
    select.value = savedType;
    if (!select.value) select.value = 'custom';
    customInput.value = savedCustom;

    // Sync UA to backend on init so scheduler uses it from the start
    syncUserAgentToBackend();

    const fakeClientDropdown = initCustomDropdown({
        wrapId: 'fake-client-select-wrap',
        triggerId: 'fake-client-trigger',
        menuId: 'fake-client-menu',
        labelId: 'fake-client-label',
        selectId: 'fake-client-select',
        /** @param {string} val */
        onChange: (val) => {
            localStorage.setItem('fakeClientType', val);
            updateVisibility();
            syncUserAgentToBackend();
        },
    });

    function updateVisibility() {
        if (toggle.checked) {
            optionsContainer.classList.remove('max-h-0', 'opacity-0', 'overflow-hidden');
            optionsContainer.classList.add('max-h-40', 'opacity-100');
            if (select.value === 'custom' && customContainer) {
                customContainer.classList.remove('hidden');
            } else if (customContainer) {
                customContainer.classList.add('hidden');
            }
            if (!versionsFetched) {
                fetchLatestVersions();
            }
        } else {
            optionsContainer.classList.remove('max-h-40', 'opacity-100');
            optionsContainer.classList.add('max-h-0', 'opacity-0', 'overflow-hidden');
            setTimeout(() => { if (customContainer) customContainer.classList.add('hidden'); }, 300);
        }
    }

    async function fetchLatestVersions() {
        if (isFetching || versionsFetched) return;
        isFetching = true;
        spinner?.classList.remove('hidden');

        try {
            /** @type {any} */
            const versions = await invoke(COMMANDS.GET_LATEST_CLIENT_VERSIONS);

            const vergeOpt = select.querySelector('option[value^="clash-verge"]');
            const partyOpt = select.querySelector('option[value^="mihomo-party"]');
            const flclashOpt = select.querySelector('option[value^="Flclash"]');

            if (vergeOpt) { /** @type {HTMLOptionElement} */ (vergeOpt).value = versions.verge; vergeOpt.textContent = `Clash Verge Rev (${versions.verge})`; }
            if (partyOpt) { /** @type {HTMLOptionElement} */ (partyOpt).value = versions.mihomo_party; partyOpt.textContent = `mihomo-party (${versions.mihomo_party})`; }
            if (flclashOpt) { /** @type {HTMLOptionElement} */ (flclashOpt).value = versions.flclash; flclashOpt.textContent = `Flclash (${versions.flclash})`; }

            const menu = document.getElementById('fake-client-menu');
            if (menu) {
                const vergeBtn = menu.querySelector('[data-value^="clash-verge"]');
                const partyBtn = menu.querySelector('[data-value^="mihomo-party"]');
                const flclashBtn = menu.querySelector('[data-value^="Flclash"]');
                if (vergeBtn) { vergeBtn.setAttribute('data-value', versions.verge); vergeBtn.textContent = `Clash Verge Rev (${versions.verge})`; vergeBtn.setAttribute('data-label', `Clash Verge Rev (${versions.verge})`); }
                if (partyBtn) { partyBtn.setAttribute('data-value', versions.mihomo_party); partyBtn.textContent = `mihomo-party (${versions.mihomo_party})`; partyBtn.setAttribute('data-label', `mihomo-party (${versions.mihomo_party})`); }
                if (flclashBtn) { flclashBtn.setAttribute('data-value', versions.flclash); flclashBtn.textContent = `Flclash (${versions.flclash})`; flclashBtn.setAttribute('data-label', `Flclash (${versions.flclash})`); }
            }

            if (savedType && savedType.startsWith('clash-verge')) {
                select.value = versions.verge;
                localStorage.setItem('fakeClientType', versions.verge);
            } else if (savedType && savedType.startsWith('mihomo-party')) {
                select.value = versions.mihomo_party;
                localStorage.setItem('fakeClientType', versions.mihomo_party);
            } else if (savedType && savedType.startsWith('Flclash')) {
                select.value = versions.flclash;
                localStorage.setItem('fakeClientType', versions.flclash);
            } else {
                select.value = savedType;
            }

            if (fakeClientDropdown) fakeClientDropdown.syncUI();

            versionsFetched = true;
        } catch (err) {
            settingsLogger.error('Failed to fetch latest client versions', err);
        } finally {
            isFetching = false;
            spinner?.classList.add('hidden');
            updateVisibility();
        }
    }

    toggle.addEventListener('change', () => {
        localStorage.setItem('fakeClientEnabled', toggle.checked.toString());
        updateVisibility();
        syncUserAgentToBackend();
        if (!toggle.checked) {
            /** @type {any} */
            const t = /** @type {any} */ (translations)[appStore.get('currentLang')];
            showNotification(t.fakeClientWarning || "Warning: Disabling this may cause incorrect config format from subscriptions.", "warning");
        }
    });

    customInput.addEventListener('input', () => {
        localStorage.setItem('fakeClientCustom', customInput.value);
        debouncedSyncUA();
    });

    if (savedEnabled) {
        optionsContainer.style.transition = 'none';
        updateVisibility();
        setTimeout(() => optionsContainer.style.transition = '', 50);
    }
}

// ---------------------------------------------------------------------------
//  initSettings -- main entry point
// ---------------------------------------------------------------------------
export async function initSettings() {
    // Portable mode: hide unsupported options
    const isPortable = await invoke('get_portable_mode');
    if (isPortable) {
        const autostartRow = document.getElementById('row-autostart');
        const clientUpdateRow = document.getElementById('row-client-update');
        if (autostartRow) autostartRow.style.display = 'none';
        if (clientUpdateRow) clientUpdateRow.style.display = 'none';
    }

    const langSelect = /** @type {HTMLSelectElement} */ (document.getElementById('setting-lang'));
    const closeTrayToggle = /** @type {HTMLInputElement} */ (document.getElementById('setting-close-tray'));
    const autoUpdateToggle = /** @type {HTMLInputElement} */ (document.getElementById('setting-auto-update'));
    const autoUpdateClientToggle = /** @type {HTMLInputElement} */ (document.getElementById('setting-auto-update-client'));
    const autostartToggle = /** @type {HTMLInputElement} */ (document.getElementById('setting-autostart'));
    const unifiedDelayToggle = /** @type {HTMLInputElement} */ (document.getElementById('setting-unified-delay'));
    const ipv6Toggle = /** @type {HTMLInputElement} */ (document.getElementById('setting-ipv6'));
    const allowLanToggle = /** @type {HTMLInputElement} */ (document.getElementById('setting-allow-lan'));
    const updateGeoBtn = document.getElementById('update-geo-btn');
    const addTunnelBtn = document.getElementById('add-tunnel-btn');
    const tunnelsList = document.getElementById('tunnels-list');
    const tunnelsEmpty = document.getElementById('tunnels-empty');
    const themeCircles = document.querySelectorAll('[data-theme]');
    const checkUpdateBtn = /** @type {HTMLButtonElement|null} */ (document.getElementById('check-update-btn'));
    const nodeScrollToggle = /** @type {HTMLInputElement} */ (document.getElementById('setting-node-scroll'));
    const hideTimeoutToggle = /** @type {HTMLInputElement} */ (document.getElementById('setting-hide-timeout'));
    const portConfigBtn = /** @type {HTMLButtonElement|null} */ (document.getElementById('port-config-btn'));
    const portDisplay = /** @type {HTMLElement|null} */ (document.getElementById('current-port-display'));
    const versionText = document.getElementById('core-version-text');
    const configsList = document.getElementById('configs-list');
    const customArgsInput = /** @type {HTMLInputElement} */ (document.getElementById('custom-args-input'));
    const applyArgsBtn = document.getElementById('apply-args-btn');
    const gotoAdvancedBtn = document.getElementById('btn-goto-advanced');
    const backSettingsBtn = document.getElementById('btn-back-settings');
    const customColorInput = /** @type {HTMLInputElement} */ (document.getElementById('custom-theme-color'));
    const opacitySlider = /** @type {HTMLInputElement} */ (document.getElementById('setting-opacity'));
    const opacityValText = document.getElementById('opacity-val-text');
    const restoreDefaultsBtn = document.getElementById('btn-restore-defaults');
    const openConfigFolderBtn = document.getElementById('open-config-folder-btn');
    const appMainContainer = document.getElementById('app-main-container');
    const themeModeContainer = document.getElementById('setting-theme-mode-container');
    const themeModeSlider = document.getElementById('setting-theme-mode-slider');
    const themeModeButtons = Array.from(document.querySelectorAll('[data-theme-mode]'));
    const appTitleIcon = /** @type {HTMLImageElement} */ (document.getElementById('app-title-icon'));

    // ---- Forward declarations (used before their full definition below) ----
    /** @type {any[]} */
    let currentTunnels = [];

    // ---- Subscription & Config management (delegated to settings/subscriptions.js) ----
    // Initialized early so renderConfigs is available for language dropdown and drag-drop listeners.
    const subApi = initSubscriptionSettings({
        subAddBtn: document.getElementById('add-sub-btn'),
        updateAllSubBtn: document.getElementById('update-all-sub-btn'),
        configsList,
    });
    const renderConfigs = subApi.renderConfigs;

    // ---- Advanced settings navigation ----
    if (gotoAdvancedBtn) {
        gotoAdvancedBtn.onclick = () => {
            switchPage('advanced');
            // renderAdvancedSettings lives in ui.js (or its future module);
            // it is called via the navigation handler in initNavigation.
            // We import it lazily to avoid circular deps.
            import('./advanced.js').then(m => m.renderAdvancedSettings?.()).catch(() => {});
        };
    }

    const gotoGithubBtn = document.getElementById('btn-goto-github');
    if (gotoGithubBtn) {
        gotoGithubBtn.onclick = () => {
            openUrl('https://github.com/Juwan-Hwang/Zephyr');
        };
    }

    if (backSettingsBtn) {
        backSettingsBtn.onclick = () => {
            switchPage('settings');
        };
    }

    // ---- Custom args ----
    if (applyArgsBtn) {
        applyArgsBtn.onclick = async () => {
            const argsStr = customArgsInput.value.trim();
            /** @type {any} */
            const settings = await invoke(COMMANDS.GET_SETTINGS);
            const configPath = settings.last_config || 'config.yaml';
            const customArgs = argsStr.split('\n').filter(a => a.trim() !== '');

            /** @type {any} */
            const t = /** @type {any} */ (translations)[appStore.get('currentLang')];
            showNotification(t.notifSavingAndRestarting || "Saving and restarting core...");
            try {
                await save();
                abortLatencyTests();
                await restartCore(configPath, customArgs);
                showNotification(t.notifRestartSuccess || "Core restarted successfully", 'success');
                syncCoreConfig();
            } catch (err) {
                const error = toError(err);
                showNotification(error.toString(), 'error');
            }
        };
    }

    // ---- Language dropdown ----
    if (langSelect) {
        langSelect.value = appStore.get('currentLang');

        const langDropdown = initCustomDropdown({
            wrapId: 'setting-lang-wrap',
            triggerId: 'setting-lang-trigger',
            menuId: 'setting-lang-menu',
            labelId: 'setting-lang-label',
            selectId: 'setting-lang',
            optionAttr: 'data-lang-value',
            /** @param {string} value */
            onChange: (value) => {
                setLanguage(value);
                appStore.set('currentLang', value);
                Bus.emit(Events.LANGUAGE_CHANGED, value);
                renderConfigs();
            },
        });

        __langDropdown = langDropdown;
    }

    // ---- UI Scale buttons ----
    const uiScaleButtons = document.querySelectorAll('.ui-scale-btn');
    const applyUiScale = (scale) => {
        // Update button states
        uiScaleButtons.forEach(btn => {
            btn.classList.remove('bg-accent/20', 'dark:bg-accent/30', 'text-accent');
            btn.classList.add('bg-zinc-200', 'dark:bg-zinc-700/50', 'text-zinc-600', 'dark:text-zinc-400');
        });
        const activeBtn = document.getElementById(`ui-scale-${Math.round(scale * 100)}`);
        if (activeBtn) {
            activeBtn.classList.remove('bg-zinc-200', 'dark:bg-zinc-700/50', 'text-zinc-600', 'dark:text-zinc-400');
            activeBtn.classList.add('bg-accent/20', 'dark:bg-accent/30', 'text-accent');
        }
        // Apply scale via CSS custom property --ui-scale
        // The actual transform/size is handled by CSS on #app-main-container.
        // This avoids inline style conflicts with Tailwind classes and ensures
        // the scale is applied consistently on startup.
        document.documentElement.style.setProperty('--ui-scale', String(scale));
    };

    uiScaleButtons.forEach(btn => {
        btn.addEventListener('click', async () => {
            const scaleValue = parseInt(btn.id.replace('ui-scale-', '')) / 100;
            try {
                await invoke(COMMANDS.SET_UI_SCALE, { scale: scaleValue });
                applyUiScale(scaleValue);
            } catch (_e) {
                // silently ignore — non-critical
            }
        });
    });

    // ---- Load current settings ----
    /** @type {any} */
    const settings = await invoke(COMMANDS.GET_SETTINGS);

    // Sync global preferences to appStore immediately to prevent UI flicker
    // (these are loaded from settings.json before any async operations)
    if (settings.theme_mode && ['light', 'dark', 'auto'].includes(settings.theme_mode)) {
        appStore.set('currentThemeMode', settings.theme_mode);
    }
    if (settings.app_opacity != null) {
        document.documentElement.style.setProperty('--app-opacity', String(Number(settings.app_opacity) / 100));
    }

    if (closeTrayToggle) closeTrayToggle.checked = settings.close_to_tray;
    if (autoUpdateToggle) autoUpdateToggle.checked = settings.auto_update;
    if (autoUpdateClientToggle) autoUpdateClientToggle.checked = settings.auto_update_client || false;
    if (autostartToggle && !isPortable) autostartToggle.checked = await isAutoStartEnabled();
    if (nodeScrollToggle) nodeScrollToggle.checked = !!settings.node_scroll;
    if (hideTimeoutToggle) hideTimeoutToggle.checked = settings.hide_timeout_nodes || false;
    if (customArgsInput) customArgsInput.value = (settings.custom_args || []).join('\n');

    // Apply saved UI scale
    if (settings.ui_scale && settings.ui_scale > 0) {
        applyUiScale(settings.ui_scale);
    }

    // ---- Theme + Opacity (delegated to settings/theme.js) ----
    const _themeApi = initThemeSettings({
        savedTheme: settings.theme,
        savedThemeMode: settings.theme_mode || null,
        savedOpacity: settings.app_opacity != null ? settings.app_opacity : null,
        appMainContainer,
        appTitleIcon,
        themeCircles,
        customColorInput,
        opacitySlider,
        opacityValText,
        themeModeContainer,
        themeModeSlider,
        themeModeButtons,
        save: () => save(),
    });

    // ---- Restore defaults ----
    if (restoreDefaultsBtn) {
        restoreDefaultsBtn.onclick = async () => {
            /** @type {any} */
            const t = /** @type {any} */ (translations)[appStore.get('currentLang')];
            const confirmed = await showConfirmModal(
                t.restoreDefaultsTitle || "Restore Defaults",
                t.restoreDefaultsConfirm || "Are you sure you want to restore all settings to default values?"
            );
            if (!confirmed) return;

            /** @type {string[]} */
            const errors = [];
            /** @type {string[]} */
            const successItems = [];

            /**
             * @param {string} name
             * @param {() => Promise<void>} operation
             * @returns {Promise<boolean>}
             */
            const trackResult = async (name, operation) => {
                try {
                    await operation();
                    successItems.push(name);
                    return true;
                } catch (err) {
                    const error = toError(err);
                    settingsLogger.error(`Failed to reset ${name}`, err);
                    errors.push(`${name}: ${error.message || err}`);
                    return false;
                }
            };

            try {
                if (closeTrayToggle) {
                    closeTrayToggle.checked = true;
                    settings.close_to_tray = true;
                }
                if (autoUpdateToggle) {
                    autoUpdateToggle.checked = false;
                    settings.auto_update = false;
                }
                if (autoUpdateClientToggle) {
                    autoUpdateClientToggle.checked = false;
                    settings.auto_update_client = false;
                }
                if (hideTimeoutToggle) {
                    const wasHideTimeoutEnabled = hideTimeoutToggle.checked;
                    hideTimeoutToggle.checked = false;
                    settings.hide_timeout_nodes = false;
                    if (wasHideTimeoutEnabled) {
                        hideTimeoutToggle.dispatchEvent(new Event('change'));
                    }
                }
                if (nodeScrollToggle) {
                    nodeScrollToggle.checked = false;
                    settings.node_scroll = false;
                    successItems.push('nodeScroll');
                }
                if (customArgsInput) {
                    customArgsInput.value = '';
                    settings.custom_args = [];
                }

                if (autostartToggle) {
                    autostartToggle.checked = false;
                    settings.autostart = false;
                    await trackResult('autostart', async () => {
                        await disableAutoStart();
                    });
                }

                if (unifiedDelayToggle) unifiedDelayToggle.checked = true;
                if (ipv6Toggle) ipv6Toggle.checked = false;
                if (allowLanToggle) allowLanToggle.checked = false;

                const dnsToggle = /** @type {HTMLInputElement} */ (document.getElementById('dns-rewrite-toggle'));
                if (dnsToggle) {
                    dnsToggle.checked = true;
                    settings.dns_rewrite_enabled = true;
                    await trackResult('dnsRewrite', async () => {
                        await applyDnsRewrite();
                    });
                }

                if (opacitySlider) {
                    opacitySlider.value = '100';
                    settings.app_opacity = 100;
                    if (opacityValText) opacityValText.textContent = '100%';
                    document.documentElement.style.setProperty('--app-opacity', '1');
                    if (appMainContainer) appMainContainer.style.backgroundColor = '';
                    successItems.push('opacity');
                }

                currentTunnels = [];
                tunnelApi.resetTunnels();

                await trackResult('coreConfig', async () => {
                    const result = await saveConfigToCore({
                        'unified-delay': true,
                        ipv6: false,
                        'allow-lan': false,
                        tunnels: [],
                    });
                    if (!result) {
                        throw new Error(t.failedSaveSettings || 'Failed to save core settings');
                    }
                });

                const fakeClientToggle = /** @type {HTMLInputElement} */ (document.getElementById('setting-fake-client'));
                if (fakeClientToggle) {
                    fakeClientToggle.checked = true;
                    localStorage.setItem('fakeClientEnabled', 'true');
                    localStorage.removeItem('fakeClientType');
                    localStorage.removeItem('fakeClientCustom');
                    const fakeClientSelect = /** @type {HTMLSelectElement} */ (document.getElementById('fake-client-select'));
                    if (fakeClientSelect) fakeClientSelect.value = 'clash-verge/1.6.0';
                    const optionsContainer = document.getElementById('fake-client-options');
                    if (optionsContainer) {
                        optionsContainer.classList.remove('max-h-0', 'opacity-0');
                        optionsContainer.classList.add('max-h-40', 'opacity-100');
                    }
                    successItems.push('fakeClient');
                }

                // Reset theme mode
                settings.theme_mode = 'auto';
                _themeApi.setThemeMode('auto', false);
                successItems.push('themeMode');

                localStorage.removeItem('appTheme');
                appStore.set('currentTheme', 'zinc');
                applyTheme('zinc');
                document.querySelectorAll('.theme-btn').forEach(b => b.classList.remove('ring-2', 'ring-offset-2', 'ring-offset-zinc-900'));
                const defaultThemeBtn = document.querySelector('.theme-btn[data-theme="zinc"]');
                if (defaultThemeBtn) {
                    defaultThemeBtn.classList.add('ring-2', 'ring-offset-2', 'ring-offset-zinc-900', 'ring-zinc-500');
                }
                successItems.push('themeColor');

                await trackResult('appSettings', async () => {
                    await invoke(COMMANDS.SAVE_SETTINGS, { settings });
                });
                invalidateSettingsCache();

                if (errors.length === 0) {
                    showNotification(t.settingsRestored || t.restoreDefaultsDesc || "Settings restored to default", "success");
                } else {
                    showNotification(`${t.partialRestore || 'Some settings failed to restore'}: ${errors.join(', ')}`, "warning");
                }
            } catch (err) {
                const error = toError(err);
                showNotification(`${t.restoreFailed || 'Failed to restore defaults'}: ${error.message || err}`, 'error');
            }
        };
    }

    // Theme color/mode/circles are handled by initThemeSettings above

    // ---- Settings persistence ----
    async function save() {
        try {
            /** @type {any} */
            const currentSettings = await invoke(COMMANDS.GET_SETTINGS);
            if (closeTrayToggle) currentSettings.close_to_tray = closeTrayToggle.checked;
            if (autoUpdateToggle) currentSettings.auto_update = autoUpdateToggle.checked;
            if (autoUpdateClientToggle) currentSettings.auto_update_client = autoUpdateClientToggle.checked;
            if (autostartToggle) currentSettings.autostart = autostartToggle.checked;
            if (hideTimeoutToggle) currentSettings.hide_timeout_nodes = hideTimeoutToggle.checked;
            currentSettings.theme = appStore.get('currentTheme');
            if (customArgsInput) currentSettings.custom_args = customArgsInput.value.split('\n').filter(a => a.trim() !== '');
            await invoke(COMMANDS.SAVE_SETTINGS, { settings: currentSettings });
            invalidateSettingsCache();
        } catch (err) {
            settingsLogger.error('Failed to save settings', err);
        }
    }

    closeTrayToggle?.addEventListener('change', save);
    autoUpdateToggle?.addEventListener('change', async () => {
        await save();
        /** @type {any} */
        const t = /** @type {any} */ (translations)[appStore.get('currentLang')];
        showNotification(t.requireAppRestart || "Changes saved. Restart the app to take effect.", "info");
    });
    hideTimeoutToggle?.addEventListener('change', async () => {
        await save();
        Bus.emit(Events.CONFIG_UPDATED);
    });
    autoUpdateClientToggle?.addEventListener('change', async () => {
        await save();
        /** @type {any} */
        const t = /** @type {any} */ (translations)[appStore.get('currentLang')];
        showNotification(t.requireAppRestart || "Changes saved. Restart the app to take effect.", "info");
    });
    if (!isPortable) {
        autostartToggle?.addEventListener('change', async () => {
            if (!autostartToggle) return;
            const enabled = autostartToggle.checked;
            try {
                if (enabled) {
                    await enableAutoStart();
                } else {
                    await disableAutoStart();
                }
                await save();
            } catch (err) {
                const error = toError(err);
                autostartToggle.checked = !enabled;
                showNotification(error.toString(), 'error');
            }
        });
    }

    // ---- Save config to core ----
    /**
     * @param {Record<string, any>} patch
     * @returns {Promise<boolean>}
     */
    async function saveConfigToCore(patch) {
        try {
            /** @type {any} */
            const result = await invoke(COMMANDS.UPDATE_CONFIG, { patch });
            await syncCoreConfig();

            if (result && !result.hot_reload_success) {
                /** @type {any} */
                const t2 = /** @type {any} */ (translations)[appStore.get('currentLang')];
                showNotification(result.message || t2.requireRestart || "Changes saved. Restart the core to take effect.", "info");
            }
            return true;
        } catch (err) {
            settingsLogger.error('Failed to save config to core', err);
            /** @type {any} */
            const t2 = /** @type {any} */ (translations)[appStore.get('currentLang')];
            const error = toError(err);
            showNotification(error.toString() || t2.failedSaveSettings || 'Failed to save settings to core', 'error');
            return false;
        }
    }

    // ---- Core settings toggles ----
    unifiedDelayToggle?.addEventListener('change', async () => {
        if (!unifiedDelayToggle) return;
        // Hot-reload via core API, then persist to settings.json
        const ok = await saveConfigToCore({ 'unified-delay': unifiedDelayToggle.checked });
        if (ok) await saveSetting('unified_delay', unifiedDelayToggle.checked);
        /** @type {any} */
        const t = /** @type {any} */ (translations)[appStore.get('currentLang')];
        if (ok) showNotification(t.requireRestart || "Changes saved. Restart the core to take effect.", "info");
        else { unifiedDelayToggle.checked = !unifiedDelayToggle.checked; showNotification(t.saveFailed || "Failed to save", "error"); }
    });

    ipv6Toggle?.addEventListener('change', async () => {
        if (!ipv6Toggle) return;
        // Hot-reload via core API, then persist to settings.json
        const ok = await saveConfigToCore({ ipv6: ipv6Toggle.checked });
        if (ok) await saveSetting('ipv6', ipv6Toggle.checked);
        /** @type {any} */
        const t = /** @type {any} */ (translations)[appStore.get('currentLang')];
        if (ok) showNotification(t.requireRestart || "Changes saved. Restart the core to take effect.", "info");
        else { ipv6Toggle.checked = !ipv6Toggle.checked; showNotification(t.saveFailed || "Failed to save", "error"); }
    });

    allowLanToggle?.addEventListener('change', async () => {
        if (!allowLanToggle) return;
        // Hot-reload via core API, then persist to settings.json
        const ok = await saveConfigToCore({ 'allow-lan': allowLanToggle.checked });
        if (ok) await saveSetting('allow_lan', allowLanToggle.checked);
        /** @type {any} */
        const t = /** @type {any} */ (translations)[appStore.get('currentLang')];
        if (ok) showNotification(t.requireRestart || "Changes saved. Restart the core to take effect.", "info");
        else { allowLanToggle.checked = !allowLanToggle.checked; showNotification(t.saveFailed || "Failed to save", "error"); }
    });

    // ---- Port configuration modal ----
    const portModal = document.getElementById('port-config-modal');
    const portMixedInput = /** @type {HTMLInputElement|null} */ (document.getElementById('port-mixed-input'));
    const portSocksInput = /** @type {HTMLInputElement|null} */ (document.getElementById('port-socks-input'));
    const portRedirInput = /** @type {HTMLInputElement|null} */ (document.getElementById('port-redir-input'));
    const portTproxyInput = /** @type {HTMLInputElement|null} */ (document.getElementById('port-tproxy-input'));
    const portCancelBtn = /** @type {HTMLButtonElement|null} */ (document.getElementById('port-config-cancel'));
    const portSaveBtn = /** @type {HTMLButtonElement|null} */ (document.getElementById('port-config-save'));

    /**
     * Validate a port value: must be a decimal integer in [0, 65535] or empty (0 = disabled).
     * Rejects hex (0x10), octal, scientific notation, and decimals.
     * @param {string} raw
     * @returns {number} Parsed port (0 for empty = disable), or NaN if invalid.
     */
    function parsePortValue(raw) {
        const trimmed = raw.trim();
        if (trimmed === '') return 0; // empty = disable (0)
        if (!/^\d+$/.test(trimmed)) return NaN; // reject non-decimal-integer strings
        return Number(trimmed);
    }

    /** @type {ReturnType<typeof createFocusTrap> | null} */
    let portFocusTrap = null;

    /**
     * Open the port config modal and populate with current values.
     * Reads from settings.json first; falls back to core config for
     * any field that is null (meaning "use YAML default").
     */
    async function openPortModal() {
        try {
            const [userSettings, coreConfig] = await Promise.all([
                invoke(COMMANDS.GET_SETTINGS),
                invoke(COMMANDS.READ_CONFIG).catch(() => ({})),
            ]);
            /** @type {any} */
            const core = coreConfig || {};
            // Use settings.json values when set, otherwise fall back to core config
            if (portMixedInput) portMixedInput.value = String(userSettings.mixed_port ?? core['mixed-port'] ?? core.port ?? '');
            if (portSocksInput) portSocksInput.value = String(userSettings.socks_port ?? core['socks-port'] ?? '');
            if (portRedirInput) portRedirInput.value = String(core['redir-port'] ?? '');
            if (portTproxyInput) portTproxyInput.value = String(core['tproxy-port'] ?? '');
        } catch (err) {
            settingsLogger.warn('Failed to load port config for modal', err);
            return;
        }
        if (portModal) {
            portModal.classList.remove('hidden');
            portModal.classList.add('flex');
            if (portFocusTrap) portFocusTrap.destroy();
            portFocusTrap = createFocusTrap(portModal, { onEscape: closePortModal });
            portFocusTrap.activate();
        }
    }

    /**
     * Close the port config modal.
     */
    function closePortModal() {
        if (!portModal) return;
        if (portFocusTrap) {
            portFocusTrap.deactivate();
        }
        portModal.classList.add('hidden');
        portModal.classList.remove('flex');
    }

    if (portConfigBtn) {
        portConfigBtn.addEventListener('click', openPortModal);
    }
    if (portCancelBtn) {
        portCancelBtn.addEventListener('click', closePortModal);
    }
    if (portModal) {
        portModal.addEventListener('click', (e) => {
            if (e.target === portModal) closePortModal();
        });
    }

    if (portSaveBtn) {
        portSaveBtn.addEventListener('click', async () => {
            if (portSaveBtn.classList.contains('pointer-events-none')) return;
            portSaveBtn.classList.add('opacity-50', 'pointer-events-none');
            try {
                /** @type {any} */
                const t = /** @type {any} */ (translations)[appStore.get('currentLang')];

                const mixedVal = parsePortValue(portMixedInput?.value || '');
                const socksVal = parsePortValue(portSocksInput?.value || '');
                const redirVal = parsePortValue(portRedirInput?.value || '');
                const tproxyVal = parsePortValue(portTproxyInput?.value || '');

                // Validate range (0 = disabled, 1-65535 = valid port)
                const ports = [
                    { val: mixedVal, key: 'mixed-port', settingsKey: 'mixed_port' },
                    { val: socksVal, key: 'socks-port', settingsKey: 'socks_port' },
                    { val: redirVal, key: 'redir-port', settingsKey: null },
                    { val: tproxyVal, key: 'tproxy-port', settingsKey: null },
                ];
                for (const { val } of ports) {
                    if (!Number.isInteger(val) || val < 0 || val > 65535) {
                        showNotification(t.portRangeError || 'Port must be between 0 and 65535', 'error');
                        return;
                    }
                }

                // Require at least one active proxy port (mixed or socks)
                if (mixedVal === 0 && socksVal === 0) {
                    showNotification(t.portAllDisabledError || 'At least one proxy port (Mixed or SOCKS5) must be enabled', 'error');
                    return;
                }

                // Check for duplicates among the new port values.
                // Ports set to 0 (disabled) are ignored.
                const activePorts = ports.filter(p => p.val > 0).map(p => p.val);
                if (new Set(activePorts).size !== activePorts.length) {
                    showNotification(t.portDuplicateError || 'Ports must not duplicate each other', 'error');
                    return;
                }

                // Build patch — 0 disables the port, non-zero sets it
                // Always disable legacy 'port' key: when mixed-port > 0 it prevents
                // conflict, and when mixed-port = 0 the user intends to fully disable
                /** @type {Record<string, number>} */
                const patch = { port: 0 };
                /** @type {Record<string, number>} */
                const settingsPatch = {};
                for (const { val, key, settingsKey } of ports) {
                    patch[key] = val;
                    if (settingsKey) settingsPatch[settingsKey] = val;
                }

                const ok = await saveConfigToCore(patch);
                if (ok) {
                    // Persist port values to settings.json
                    await saveSettings(settingsPatch);
                    await loadSettingsFromCore();
                    closePortModal();
                }
            } finally {
                portSaveBtn.classList.remove('opacity-50', 'pointer-events-none');
            }
        });
    }

    // ---- Geo data update ----
    updateGeoBtn?.addEventListener('click', async () => {
        if (appStore.get('isNetworkUpdating')) return;
        appStore.set('isNetworkUpdating', true);

        const spinner = document.getElementById('geo-spinner');
        spinner?.classList.remove('hidden');
        updateGeoBtn.classList.add('opacity-50', 'pointer-events-none');

        /** @type {any} */
        const t = /** @type {any} */ (translations)[appStore.get('currentLang')];
        showNotification(t.notifGeoUpdating || "Updating Geo databases...");

        try {
            await invoke(COMMANDS.UPDATE_GEO_DATA);
            /** @type {any} */
            const t2 = /** @type {any} */ (translations)[appStore.get('currentLang')];
            showNotification(t2.notifGeoUpdateSuccess || "Geo databases updated and core restarted!", 'success');

            /** @type {any} */
            const geoSettings = await invoke(COMMANDS.GET_SETTINGS);
            const configPath = geoSettings.last_config || 'config.yaml';
            const customArgs = geoSettings.custom_args || [];
            abortLatencyTests();
            await restartCore(configPath, customArgs);
        } catch (err) {
            const error = toError(err);
            showNotification(error.toString(), 'error');
        } finally {
            appStore.set('isNetworkUpdating', false);
            spinner?.classList.add('hidden');
            updateGeoBtn.classList.remove('opacity-50', 'pointer-events-none');
        }
    });

    // ---- Tunnel management (delegated to settings/tunnels.js) ----
    const tunnelApi = initTunnelSettings({
        addTunnelBtn,
        tunnelsList,
        tunnelsEmpty,
        initialTunnels: currentTunnels,
        saveConfigToCore,
    });

    // ---- Load settings from core ----
    // Reads user preferences from settings.json; falls back to core config
    // for any field that is null (meaning "use YAML default").
    const loadSettingsFromCore = async () => {
        try {
            const [userSettings, coreConfig] = await Promise.all([
                invoke(COMMANDS.GET_SETTINGS),
                invoke(COMMANDS.READ_CONFIG).catch(() => ({})),
            ]);
            /** @type {any} */
            const config = coreConfig || {};
            // Prefer settings.json values; fall back to core config
            if (unifiedDelayToggle) unifiedDelayToggle.checked = userSettings.unified_delay != null ? !!userSettings.unified_delay : config['unified-delay'] !== false;
            if (ipv6Toggle) ipv6Toggle.checked = userSettings.ipv6 != null ? !!userSettings.ipv6 : !!config.ipv6;
            if (allowLanToggle) allowLanToggle.checked = userSettings.allow_lan != null ? !!userSettings.allow_lan : !!config['allow-lan'];

            // Update port display — use settings.json values when set, fallback to core config
            if (portDisplay) {
                const mixedPort = userSettings.mixed_port ?? (config['mixed-port'] || config.port || config['socks-port'] || 0);
                portDisplay.textContent = mixedPort > 0 ? String(mixedPort) : '--';
            }

            if (config.tunnels && Array.isArray(config.tunnels)) {
                currentTunnels = config.tunnels;
            } else {
                currentTunnels = [];
            }
            tunnelApi.setTunnels(currentTunnels);
        } catch (err) {
            settingsLogger.error('Failed to load core config into settings', err);
        }
    };

    // ---- Open config folder ----
    openConfigFolderBtn?.addEventListener('click', async () => {
        try {
            await openConfigFolder();
        } catch (err) {
            const error = toError(err);
            showNotification(error.toString(), 'error');
        }
    });

    // ---- Drag-and-drop import listener ----
    if (_dropUnlisten) {
        _dropUnlisten();
    }
    if (typeof listen === 'function') {
        listen('profiles-imported', (/** @type {{ payload: number }} */ event) => {
            const importedCount = event.payload;
            if (importedCount > 0) {
                /** @type {any} */
                const t = /** @type {any} */ (translations)[appStore.get('currentLang')];
                showNotification(`${t.profilesImported?.replace('{count}', importedCount) || `Successfully imported ${importedCount} profile(s)`}`, 'success');
                if (typeof /** @type {any} */ (window).refreshConfigs === 'function') {
                    /** @type {any} */ (window).refreshConfigs();
                }
                renderConfigs();
            }
        }).then(unlisten => {
            _dropUnlisten = unlisten;
        }).catch(e => settingsLogger.warn('Failed to listen for profiles-imported event', e));
    }

    // Theme circles are handled by initThemeSettings above

    // ---- Node scroll toggle ----
    nodeScrollToggle?.addEventListener('change', () => {
        if (!nodeScrollToggle) return;
        saveSetting('node_scroll', nodeScrollToggle.checked).catch((e) =>
            settingsLogger.warn("Failed to persist nodeScroll change", e)
        );
        // Clear the container to force full re-render (in-place update won't update CSS classes)
        const container = document.getElementById('proxies-list');
        if (container) container.innerHTML = '';
        Bus.emit(Events.CONFIG_UPDATED);
    });

    // ---- Core version ----
    let currentCoreVersion = "";

    const loadCoreVersion = async () => {
        try {
            currentCoreVersion = await invoke(COMMANDS.GET_CORE_VERSION);
            if (versionText) versionText.textContent = currentCoreVersion.startsWith('v') ? currentCoreVersion : `v${currentCoreVersion}`;
        } catch (err) {
            settingsLogger.error('Failed to get core version', err);
            if (versionText) {
                /** @type {any} */
                const t = /** @type {any} */ (translations)[appStore.get('currentLang')];
                versionText.textContent = t.unknown || 'Unknown';
            }
        }
    };
    loadCoreVersion();

    // ---- App version ----
    const appVersionText = document.getElementById('app-version-text');
    if (appVersionText) {
        try {
            const appVersion = await invoke(COMMANDS.GET_APP_VERSION);
            appVersionText.textContent = appVersion;
        } catch {
            appVersionText.textContent = '-';
        }
    }

    loadSettingsFromCore();

    // ---- Auto-update check ----
    /**
     * @param {string} latestVersion
     * @param {string} downloadUrl
     */
    const performCoreUpdate = async (latestVersion, downloadUrl) => {
        /** @type {any} */
        const t = /** @type {any} */ (translations)[appStore.get('currentLang')];
        const confirmed = await showConfirmModal(t.notifUpdateFound, latestVersion);
        if (confirmed) {
            showNotification(t.notifUpdating);
            /** @type {any} */
            const coreResult = await invoke(COMMANDS.UPDATE_CORE, {
                url: downloadUrl,
            });
            setBaseUrl(`http://127.0.0.1:${coreResult.port}`);
            setWsBaseUrl(`ws://127.0.0.1:${coreResult.port}`);
            setSecret(coreResult.secret);
            setWsSecret(coreResult.secret);

            // Reconnect traffic WebSocket to the new core instance
            connectTraffic((/** @type {any} */ data) => {
                updateTrafficData(data);
            });

            showNotification(t.notifUpdateSuccess, 'success');
            await loadCoreVersion();
            await syncCoreConfig();
        }
    };

    if (checkUpdateBtn) {
        checkUpdateBtn.onclick = async () => {
            if (checkUpdateBtn.disabled) return;
            checkUpdateBtn.disabled = true;

            try {
                const t = /** @type {any} */ (translations)[appStore.get('currentLang')];

                showNotification(t.notifUpdateCheck);

                // Check both core and client updates in parallel
                const [latest, clientInfo, currentAppVersion] = await Promise.all([
                    invoke(COMMANDS.GET_LATEST_VERSION),
                    invoke(COMMANDS.GET_LATEST_CLIENT_VERSION),
                    invoke(COMMANDS.GET_APP_VERSION),
                ]);

                const coreHasUpdate = latest && latest.version && latest.version !== currentCoreVersion;
                const clientHasUpdate = clientInfo && clientInfo.version && clientInfo.version !== currentAppVersion;

                if (!coreHasUpdate && !clientHasUpdate) {
                    showNotification(t.notifNoUpdate, 'success');
                    return;
                }

                if (coreHasUpdate && clientHasUpdate) {
                    // Both have updates — download Full version (includes core + client)
                    const confirmed = await showConfirmModal(
                        t.bothUpdateAvailable || 'Both core and client have updates',
                        `${t.coreUpdate || 'Core'}: ${currentCoreVersion} → ${latest.version}\n${t.clientUpdate || 'Client'}: ${currentAppVersion} → ${clientInfo.version}\n\n${t.recommendFullVersion || 'Recommend installing Full version'}`
                    );
                    if (confirmed) {
                        try {
                            await invoke(COMMANDS.UPDATE_CLIENT);
                            showNotification(`${t.clientUpdateSuccess || 'Update downloaded'} (${clientInfo.version})`, 'success');
                        } catch (e) {
                            showNotification(`${t.clientUpdateFailed || 'Update failed'}: ${e}`, 'error');
                        }
                    }
                } else if (coreHasUpdate) {
                    await performCoreUpdate(latest.version, latest.download_url);
                } else {
                    // Only client update
                    const confirmed = await showUpdateNotesModal(
                        `${t.clientUpdateAvailable || 'Client Update Available'}: v${clientInfo.version}`,
                        clientInfo.release_notes || ''
                    );
                    if (confirmed) {
                        try {
                            await invoke(COMMANDS.UPDATE_CLIENT);
                            showNotification(`${t.clientUpdateSuccess || 'Client update downloaded'} (${clientInfo.version})`, 'success');
                        } catch (e) {
                            showNotification(`${t.clientUpdateFailed || 'Client update failed'}: ${e}`, 'error');
                        }
                    }
                }
            } catch (err) {
                const error = toError(err);
                showNotification(error.toString(), 'error');
            } finally {
                checkUpdateBtn.disabled = false;
            }
        };
    }

    // ---- Extension Rules: Auto Apply toggle ----
    const autoApplyToggle = /** @type {HTMLInputElement|null} */ (document.getElementById('setting-auto-apply'));
    if (autoApplyToggle) {
        // Load current state
        try {
            const enabled = /** @type {boolean} */ (await invoke(COMMANDS.RULE_GET_AUTO_APPLY));
            autoApplyToggle.checked = !!enabled;
        } catch (err) {
            settingsLogger.warn('Failed to load auto-apply state', err);
        }

        // Sync toggle with actual watcher state
        try {
            const watching = /** @type {boolean} */ (await prism.isWatching());
            if (watching !== autoApplyToggle.checked) {
                settingsLogger.warn('Auto-apply toggle and watcher state disagree, syncing', { toggle: autoApplyToggle.checked, watching });
                autoApplyToggle.checked = watching;
            }
        } catch {
            // isWatching may not be available — ignore
        }

        autoApplyToggle.addEventListener('change', async () => {
            const checked = autoApplyToggle.checked;
            try {
                await invoke(COMMANDS.RULE_SET_AUTO_APPLY, { enabled: checked });
                if (checked) {
                    await prism.startWatching();
                } else {
                    await prism.stopWatching();
                }
            } catch (err) {
                settingsLogger.error('Failed to toggle auto-apply', err);
                autoApplyToggle.checked = !checked;
            }
        });
    }

    // ---- Extension Rules: Manage Rule Files button ----
    const manageRuleFilesBtn = document.getElementById('manage-rule-files-btn');
    if (manageRuleFilesBtn) {
        manageRuleFilesBtn.addEventListener('click', async () => {
            try {
                await openPrismFolder();
            } catch (err) {
                const error = toError(err);
                showNotification(error.toString(), 'error');
            }
        });
    }

    // --- Smart Proxy Selector ---
    const smartToggle = /** @type {HTMLInputElement|null} */ (document.getElementById('smart-toggle'));
    const smartConfigBtn = document.getElementById('smart-config-btn');

    if (smartToggle) {
        // Initialize from backend smart config, fallback to localStorage for migration
        const initSmartEnabled = async () => {
            try {
                const config = await prism.smartConfig();
                smartToggle.checked = config.enabled ?? localStorage.getItem('smartEnabled') === 'true';
            } catch {
                smartToggle.checked = localStorage.getItem('smartEnabled') === 'true';
            }
            document.documentElement.style.setProperty('--smart-enabled', smartToggle.checked ? '1' : '0');
        };

        smartToggle.onchange = async () => {
            document.documentElement.style.setProperty('--smart-enabled', smartToggle.checked ? '1' : '0');
            // Always sync to localStorage as fallback for migration scenarios
            localStorage.setItem('smartEnabled', String(smartToggle.checked));
            try {
                const config = await prism.smartConfig();
                config.enabled = smartToggle.checked;
                await prism.smartConfigSave(config);
            } catch (err) {
                settingsLogger.error('[smart] Failed to persist enabled state:', err);
            }
            Bus.emit(Events.CONFIG_UPDATED);
        };

        // Important: initialize smartToggle.checked BEFORE wiring auto-test toggle state.
        // Otherwise auto-test may be disabled/cleared on startup due to a race.
        await initSmartEnabled();
    }

    // Smart Auto-Test toggle
    const autoTestToggle = /** @type {HTMLInputElement|null} */ (document.getElementById('smart-auto-test-toggle'));
    if (autoTestToggle) {
        const savedAutoTest = localStorage.getItem('smartAutoTest');
        autoTestToggle.checked = savedAutoTest === 'true';
        // Disable auto-test toggle when smart is off
        const syncAutoTestState = () => {
            const smartOn = smartToggle?.checked ?? false;
            autoTestToggle.disabled = !smartOn;
            if (!smartOn && autoTestToggle.checked) {
                autoTestToggle.checked = false;
                localStorage.setItem('smartAutoTest', 'false');
                stopSmartAutoTest();
            }
        };
        syncAutoTestState();

        autoTestToggle.onchange = () => {
            if (autoTestToggle.disabled) {
                return;
            }
            localStorage.setItem('smartAutoTest', String(autoTestToggle.checked));
            if (autoTestToggle.checked) {
                startSmartAutoTest();
            } else {
                stopSmartAutoTest();
            }
        };

        // Re-sync when smart toggle changes (must be set after smartToggle.onchange)
        if (smartToggle) {
            const origSmartOnChange = smartToggle.onchange;
            smartToggle.onchange = async () => {
                await origSmartOnChange?.call(smartToggle);
                syncAutoTestState();
            };
        }
    }

    // Smart config modal (replaces inline expandable panel)
    if (smartConfigBtn) {
        smartConfigBtn.onclick = async () => {
            // Remove existing modal if any
            document.getElementById('smart-config-modal')?.remove();

            const t = /** @type {Record<string, string>} */ (translations)[appStore.get('currentLang')] ?? {};

            // Load current config
            let config = {};
            try {
                config = await prism.smartConfig();
            } catch (err) {
                settingsLogger.error('[smart] Failed to load config:', err);
            }

            const modal = document.createElement('div');
            modal.id = 'smart-config-modal';
            modal.className = 'fixed inset-0 z-[var(--z-modal)] flex items-center justify-center bg-black/40 backdrop-blur-md';
            modal.innerHTML = `
                <div class="glass-card w-[440px] p-6 space-y-5">
                    <div class="flex items-center justify-between">
                        <h3 class="text-sm font-bold text-zinc-800 dark:text-zinc-200">${t.smartProxyConfigTitle || 'Smart Proxy Settings'}</h3>
                        <button id="smart-modal-close" class="text-zinc-400 hover:text-zinc-800 dark:hover:text-zinc-200 transition-colors">
                            <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
                        </button>
                    </div>
                    <div class="grid grid-cols-2 gap-4">
                        <div class="flex flex-col gap-1.5">
                            <label class="text-2xs text-zinc-500 dark:text-zinc-400 font-medium uppercase tracking-wider">${t.smartProxyWeightLatency || 'Latency Weight'}</label>
                            <input id="smart-weight-latency" type="number" step="0.1" min="0" max="1" value="${config.latency_weight ?? 0.4}" class="input-mono text-xs">
                        </div>
                        <div class="flex flex-col gap-1.5">
                            <label class="text-2xs text-zinc-500 dark:text-zinc-400 font-medium uppercase tracking-wider">${t.smartProxyWeightSuccess || 'Success Rate Weight'}</label>
                            <input id="smart-weight-success" type="number" step="0.1" min="0" max="1" value="${config.success_weight ?? 0.4}" class="input-mono text-xs">
                        </div>
                        <div class="flex flex-col gap-1.5">
                            <label class="text-2xs text-zinc-500 dark:text-zinc-400 font-medium uppercase tracking-wider">${t.smartProxyWeightStability || 'Stability Weight'}</label>
                            <input id="smart-weight-stability" type="number" step="0.1" min="0" max="1" value="${config.stability_weight ?? 0.2}" class="input-mono text-xs">
                        </div>
                        <div class="flex flex-col gap-1.5">
                            <label class="text-2xs text-zinc-500 dark:text-zinc-400 font-medium uppercase tracking-wider">${t.smartProxyHalfLife || 'Half-life (hours)'}</label>
                            <input id="smart-half-life" type="number" step="0.5" min="0.1" value="${config.half_life_hours ?? 1.0}" class="input-mono text-xs">
                        </div>
                        <div class="flex flex-col gap-1.5">
                            <label class="text-2xs text-zinc-500 dark:text-zinc-400 font-medium uppercase tracking-wider">${t.smartProxyMinInterval || 'Min Test Interval (s)'}</label>
                            <input id="smart-min-interval" type="number" min="10" value="${config.min_interval_secs ?? 60}" class="input-mono text-xs">
                        </div>
                        <div class="flex flex-col gap-1.5">
                            <label class="text-2xs text-zinc-500 dark:text-zinc-400 font-medium uppercase tracking-wider">${t.smartProxyMaxInterval || 'Max Test Interval (s)'}</label>
                            <input id="smart-max-interval" type="number" min="60" value="${config.max_interval_secs ?? 600}" class="input-mono text-xs">
                        </div>
                    </div>
                    <div class="flex justify-end pt-1">
                        <button id="smart-modal-done" class="btn-ghost text-xs px-4 py-2">${t.done || 'Done'}</button>
                    </div>
                </div>
            `;

            document.body.appendChild(modal);

            // Animate in
            requestAnimationFrame(() => {
                const panel = modal.querySelector('.glass-card');
                if (panel) {
                    panel.style.transform = 'scale(0.96)';
                    panel.style.opacity = '0';
                    requestAnimationFrame(() => {
                        panel.style.transition = 'all 0.25s cubic-bezier(0.16, 1, 0.3, 1)';
                        panel.style.transform = 'scale(1)';
                        panel.style.opacity = '1';
                    });
                }
            });

            const closeModal = () => {
                const panel = modal.querySelector('.glass-card');
                if (panel) {
                    panel.style.transition = 'all 0.15s ease-in';
                    panel.style.transform = 'scale(0.96)';
                    panel.style.opacity = '0';
                    setTimeout(() => modal.remove(), 150);
                } else {
                    modal.remove();
                }
            };

            document.getElementById('smart-modal-close')?.addEventListener('click', closeModal);
            modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
            document.getElementById('smart-modal-done')?.addEventListener('click', closeModal);

            // Save on input change (debounced)
            const inputs = modal.querySelectorAll('input[type="number"]');
            const saveConfig = debounce(async () => {
                try {
                    const configJson = {
                        latency_weight: parseFloat(modal.querySelector('#smart-weight-latency')?.value || '0.4'),
                        success_weight: parseFloat(modal.querySelector('#smart-weight-success')?.value || '0.4'),
                        stability_weight: parseFloat(modal.querySelector('#smart-weight-stability')?.value || '0.2'),
                        half_life_hours: parseFloat(modal.querySelector('#smart-half-life')?.value || '1.0'),
                        min_interval_secs: parseInt(modal.querySelector('#smart-min-interval')?.value || '60', 10),
                        max_interval_secs: parseInt(modal.querySelector('#smart-max-interval')?.value || '600', 10),
                    };
                    await prism.smartConfigSave(configJson);
                } catch (err) {
                    settingsLogger.error('[smart] Failed to save config:', err);
                }
            }, 500);
            inputs.forEach(input => input.addEventListener('input', saveConfig));
        };
    }

    initFakeClient();

    // Start smart auto-test scheduler if enabled
    const shouldStartAutoTest = localStorage.getItem('smartAutoTest') === 'true';
    if (shouldStartAutoTest) {
        // Delay to ensure smart toggle state is initialized first
        setTimeout(() => {
            startSmartAutoTest();
        }, 2000);
    }
}

// ---------------------------------------------------------------------------
//  DNS configuration (delegated to dns-shared.js)
// ---------------------------------------------------------------------------
export { DEFAULT_DNS_CONFIG, isValidIPv6, isValidDns, getDnsConfig, buildDnsRewritePayload, applyDnsRewrite, initDnsRewriteToggle };

// ---------------------------------------------------------------------------
//  Public API -- re-exports for other modules
// ---------------------------------------------------------------------------
export { getFakeClientUA, getSubscriptionUserAgent, extractNameFromUrl };
