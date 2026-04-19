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
    reloadConfig,
    isAutoStartEnabled,
    enableAutoStart,
    disableAutoStart,
    openConfigFolder,
    closeAllConnections,
    getConfig,
    setSecret,
    setBaseUrl,
    patchConfig,
} from '../api.js';
import { setWsSecret, setWsBaseUrl } from '../websocket.js';
import { translations, setLanguage } from '../i18n.js';
import { debounce } from '../utils/debounce.js';
import { formatFileSize } from '../utils/format.js';
import { settingsLogger } from '../utils/logger.js';
import { showNotification, showModal, showConfirmModal, showUpdateNotesModal } from './notifications.js';
import { applyTheme } from './theme.js';
import { appStore } from './state.js';
import { Bus, Events } from './events.js';
import { getSettingsCached, getConfigsCached, invalidateSettingsCache, invalidateConfigsCache } from './cache.js';
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

// The following modules have not yet been extracted from ui.js.
// We import them from ui.js for now; when they are extracted, these
// imports will be updated to point to their own files.
import { switchPage } from './navigation.js';
import { initCustomDropdown } from './dropdown.js';
import { syncCoreConfig } from './proxies.js';
import { renderProxies } from './proxies.js';

// ---------------------------------------------------------------------------
//  Shared SVG icon snippets (kept local -- only the ones settings needs)
// ---------------------------------------------------------------------------
const SVG_ICONS = {
    trash: '<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
    refresh: '<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg>',
};

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
    } catch (e) {
        return null;
    }
}

// ---------------------------------------------------------------------------
//  Utility: address validation (IPv4:port, [IPv6]:port, hostname:port)
// ---------------------------------------------------------------------------
/**
 * @param {string} addr
 * @returns {boolean}
 */
function isValidAddress(addr) {
    // IPv6 with port: [ipv6]:port
    const ipv6Match = addr.match(/^\[([0-9a-fA-F:]+)\]:(\d+)$/);
    if (ipv6Match) {
        const port = parseInt(ipv6Match[2], 10);
        return isValidIPv6(ipv6Match[1]) && port > 0 && port <= 65535;
    }
    // IPv4 with port
    const ipv4Match = addr.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3}):(\d+)$/);
    if (ipv4Match) {
        const octets = [ipv4Match[1], ipv4Match[2], ipv4Match[3], ipv4Match[4]];
        const validOctets = octets.every(o => {
            const num = parseInt(o, 10);
            return num >= 0 && num <= 255;
        });
        const port = parseInt(ipv4Match[5], 10);
        return validOctets && port > 0 && port <= 65535;
    }
    // Hostname with port
    const hostMatch = addr.match(/^([a-zA-Z0-9][-a-zA-Z0-9.]*):(\d+)$/);
    if (hostMatch) {
        const port = parseInt(hostMatch[2], 10);
        return port > 0 && port <= 65535;
    }
    return false;
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
                    (/** @type {any} */(/** @type {any} */ (translations)[appStore.get('currentLang')]).notifUwpFailed || 'Failed') + ': ' + error,
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
        },
    });

    const updateVisibility = () => {
        if (toggle.checked) {
            optionsContainer.classList.remove('max-h-0', 'opacity-0', 'overflow-hidden');
            optionsContainer.classList.add('max-h-40', 'opacity-100');
            if (select.value === 'custom' && customContainer) {
                customContainer.classList.remove('hidden');
            } else {
                if (customContainer) customContainer.classList.add('hidden');
            }
            if (!versionsFetched) {
                fetchLatestVersions();
            }
        } else {
            optionsContainer.classList.remove('max-h-40', 'opacity-100');
            optionsContainer.classList.add('max-h-0', 'opacity-0', 'overflow-hidden');
            setTimeout(() => { if (customContainer) customContainer.classList.add('hidden'); }, 300);
        }
    };

    const fetchLatestVersions = async () => {
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

            if (savedType && savedType.startsWith('clash-verge')) select.value = versions.verge;
            else if (savedType && savedType.startsWith('mihomo-party')) select.value = versions.mihomo_party;
            else if (savedType && savedType.startsWith('Flclash')) select.value = versions.flclash;
            else select.value = savedType;

            if (fakeClientDropdown) fakeClientDropdown.syncUI();

            versionsFetched = true;
        } catch (err) {
            settingsLogger.error('Failed to fetch latest client versions', err);
        } finally {
            isFetching = false;
            spinner?.classList.add('hidden');
            updateVisibility();
        }
    };

    toggle.addEventListener('change', () => {
        localStorage.setItem('fakeClientEnabled', toggle.checked.toString());
        updateVisibility();
        if (!toggle.checked) {
            /** @type {any} */
            const t = /** @type {any} */ (translations)[appStore.get('currentLang')];
            showNotification(t.fakeClientWarning || "Warning: Disabling this may cause incorrect config format from subscriptions.", "warning");
        }
    });

    customInput.addEventListener('input', () => {
        localStorage.setItem('fakeClientCustom', customInput.value);
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

        /** @type {any} */ (window).__langDropdown = langDropdown;
    }

    // ---- Load current settings ----
    /** @type {any} */
    const settings = await invoke(COMMANDS.GET_SETTINGS);
    if (closeTrayToggle) closeTrayToggle.checked = settings.close_to_tray;
    if (autoUpdateToggle) autoUpdateToggle.checked = settings.auto_update;
    if (autoUpdateClientToggle) autoUpdateClientToggle.checked = settings.auto_update_client || false;
    if (autostartToggle) autostartToggle.checked = await isAutoStartEnabled();
    if (nodeScrollToggle) nodeScrollToggle.checked = localStorage.getItem('nodeScroll') === 'true';
    if (customArgsInput) customArgsInput.value = (settings.custom_args || []).join('\n');

    // ---- Opacity slider (with debounce) ----
    const savedOpacity = localStorage.getItem('appOpacity') || '100';
    if (opacitySlider) {
        opacitySlider.value = savedOpacity;
        if (opacityValText) opacityValText.textContent = `${savedOpacity}%`;
        document.documentElement.style.setProperty('--app-opacity', String(Number(savedOpacity) / 100));

        const debouncedOpacity = debounce(/** @param {string} val */ (val) => {
            document.documentElement.style.setProperty('--app-opacity', String(Number(val) / 100));
            localStorage.setItem('appOpacity', val);
        }, 50);

        opacitySlider.addEventListener('input', (e) => {
            const target = /** @type {HTMLInputElement} */ (e.target);
            const val = target.value;
            if (opacityValText) opacityValText.textContent = `${val}%`;
            debouncedOpacity(val);
        });
    }

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
                if (nodeScrollToggle) {
                    nodeScrollToggle.checked = false;
                    localStorage.setItem('nodeScroll', 'false');
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
                    localStorage.setItem('dnsRewrite', 'true');
                    await trackResult('dnsRewrite', async () => {
                        await applyDnsRewrite();
                    });
                }

                if (opacitySlider) {
                    opacitySlider.value = '100';
                    localStorage.setItem('appOpacity', '100');
                    if (opacityValText) opacityValText.textContent = '100%';
                    document.documentElement.style.setProperty('--app-opacity', '1');
                    if (appMainContainer) appMainContainer.style.backgroundColor = '';
                    successItems.push('opacity');
                }

                currentTunnels = [];
                renderTunnels();

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

                await trackResult('appSettings', async () => {
                    await invoke(COMMANDS.SAVE_SETTINGS, { settings });
                });
                invalidateSettingsCache();

                localStorage.setItem('themeMode', 'auto');
                setThemeMode('auto', false);
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

    const getStoredThemeMode = () => {
        const savedThemeMode = localStorage.getItem('themeMode');
        if (savedThemeMode && themeModeMap.includes(savedThemeMode)) return savedThemeMode;
        const legacyDarkMode = localStorage.getItem('darkMode');
        if (legacyDarkMode === 'true') return 'dark';
        if (legacyDarkMode === 'false') return 'light';
        return 'auto';
    };

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
    const setThemeMode = (mode, persist = true) => {
        if (!themeModeMap.includes(mode)) return;
        currentThemeMode = mode;
        if (persist) {
            localStorage.setItem('themeMode', mode);
            localStorage.removeItem('darkMode');
        }
        updateThemeModeUI(mode);
        applyDarkMode(resolveThemeModeToDark(mode));
        Bus.emit(Events.THEME_MODE_CHANGED, mode);
    };

    setThemeMode(getStoredThemeMode(), false);

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
    if (typeof systemThemeMedia.addEventListener === 'function') {
        systemThemeMedia.addEventListener('change', systemThemeListener);
    } else if (typeof systemThemeMedia.addListener === 'function') {
        systemThemeMedia.addListener(systemThemeListener);
    }

    applyColorTheme(settings.theme);

    if (customColorInput) {
        customColorInput.onchange = () => {
            const color = customColorInput.value;
            applyColorTheme(color);
            save();
        };
    }

    // ---- Settings persistence ----
    const save = async () => {
        try {
            /** @type {any} */
            const currentSettings = await invoke(COMMANDS.GET_SETTINGS);
            if (closeTrayToggle) currentSettings.close_to_tray = closeTrayToggle.checked;
            if (autoUpdateToggle) currentSettings.auto_update = autoUpdateToggle.checked;
            if (autoUpdateClientToggle) currentSettings.auto_update_client = autoUpdateClientToggle.checked;
            if (autostartToggle) currentSettings.autostart = autostartToggle.checked;
            currentSettings.theme = appStore.get('currentTheme');
            if (customArgsInput) currentSettings.custom_args = customArgsInput.value.split('\n').filter(a => a.trim() !== '');
            await invoke(COMMANDS.SAVE_SETTINGS, { settings: currentSettings });
            invalidateSettingsCache();
        } catch (err) {
            settingsLogger.error('Failed to save settings', err);
        }
    };

    closeTrayToggle?.addEventListener('change', save);
    autoUpdateToggle?.addEventListener('change', async () => {
        await save();
        /** @type {any} */
        const t = /** @type {any} */ (translations)[appStore.get('currentLang')];
        showNotification(t.requireAppRestart || "更改已保存，需重启应用生效", "info");
    });
    autoUpdateClientToggle?.addEventListener('change', async () => {
        await save();
        /** @type {any} */
        const t = /** @type {any} */ (translations)[appStore.get('currentLang')];
        showNotification(t.requireAppRestart || "更改已保存，需重启应用生效", "info");
    });
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

    // ---- Save config to core ----
    /**
     * @param {Record<string, any>} patch
     * @returns {Promise<boolean>}
     */
    const saveConfigToCore = async (patch) => {
        try {
            /** @type {any} */
            const result = await invoke(COMMANDS.UPDATE_CONFIG, { patch });
            await syncCoreConfig();

            if (result && !result.hot_reload_success) {
                    /** @type {any} */
                    const t2 = /** @type {any} */ (translations)[appStore.get('currentLang')];
                    showNotification(result.message || t2.requireRestart || "更改已保存，需重启核心生效", "info");
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
    };

    // ---- Core settings toggles ----
    unifiedDelayToggle?.addEventListener('change', () => {
        if (!unifiedDelayToggle) return;
        saveConfigToCore({ 'unified-delay': unifiedDelayToggle.checked });
        /** @type {any} */
        const t = /** @type {any} */ (translations)[appStore.get('currentLang')];
        showNotification(t.requireRestart || "更改已保存，需重启核心生效", "info");
    });

    ipv6Toggle?.addEventListener('change', () => {
        if (!ipv6Toggle) return;
        saveConfigToCore({ ipv6: ipv6Toggle.checked });
        /** @type {any} */
        const t = /** @type {any} */ (translations)[appStore.get('currentLang')];
        showNotification(t.requireRestart || "更改已保存，需重启核心生效", "info");
    });

    allowLanToggle?.addEventListener('change', () => {
        if (!allowLanToggle) return;
        saveConfigToCore({ 'allow-lan': allowLanToggle.checked });
        /** @type {any} */
        const t = /** @type {any} */ (translations)[appStore.get('currentLang')];
        showNotification(t.requireRestart || "更改已保存，需重启核心生效", "info");
    });

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

    // ---- Tunnel management ----
    /** @type {any[]} */
    let currentTunnels = [];

    const renderTunnels = () => {
        if (!tunnelsList) return;

        if (!currentTunnels || currentTunnels.length === 0) {
            tunnelsList.innerHTML = '';
            if (tunnelsEmpty) tunnelsList.appendChild(tunnelsEmpty);
            if (tunnelsEmpty) tunnelsEmpty.style.display = 'block';
            return;
        }

        if (tunnelsEmpty) tunnelsEmpty.style.display = 'none';
        tunnelsList.innerHTML = '';

        currentTunnels.forEach((tunnel, index) => {
            const item = document.createElement('div');
            item.className = 'flex items-center justify-between bg-black/20 border border-white/5 rounded-xl p-3 hover:border-white/10 transition-all';

            const info = document.createElement('div');
            info.className = 'flex flex-col gap-1';

            const topRow = document.createElement('div');
            topRow.className = 'flex items-center gap-2';

            const protocolBadge = document.createElement('span');
            protocolBadge.className = 'type-badge text-zinc-300';
            protocolBadge.textContent = tunnel.network.join(', ');

            const target = document.createElement('span');
            target.className = 'text-xs font-medium text-zinc-200';
            target.textContent = tunnel.target;

            topRow.appendChild(protocolBadge);
            topRow.appendChild(target);

            const listen = document.createElement('span');
            listen.className = 'text-2xs text-zinc-500 font-mono';
            /** @type {any} */
            const t = /** @type {any} */ (translations)[appStore.get('currentLang')];
            listen.textContent = `${t.listen || 'Listen'}: ${tunnel.address}`;

            info.appendChild(topRow);
            info.appendChild(listen);

            const delBtn = document.createElement('button');
            delBtn.className = 'btn-delete-icon';
            delBtn.innerHTML = SVG_ICONS.trash;
            delBtn.onclick = () => {
                currentTunnels.splice(index, 1);
                saveConfigToCore({ tunnels: currentTunnels });
                renderTunnels();
            };

            item.appendChild(info);
            item.appendChild(delBtn);
            tunnelsList.appendChild(item);
        });
    };

    addTunnelBtn?.addEventListener('click', async () => {
        /** @type {any} */
        const t = /** @type {any} */ (translations)[appStore.get('currentLang')];
        const customHtml = `
            <div class="space-y-4">
                <div>
                    <label class="block text-2xs text-zinc-500 uppercase tracking-wider mb-1.5">${t.tunnelProtocol || 'Protocol'}</label>
                    <input type="text" id="tunnel-protocol-input" placeholder="tcp, udp, or tcp,udp" value="tcp,udp" class="input-mono">
                </div>
                <div>
                    <label class="block text-2xs text-zinc-500 uppercase tracking-wider mb-1.5">${t.tunnelNetwork || 'Listen Address'}</label>
                    <input type="text" id="tunnel-address-input" placeholder="e.g., 127.0.0.1:6553" class="input-mono">
                </div>
                <div>
                    <label class="block text-2xs text-zinc-500 uppercase tracking-wider mb-1.5">${t.tunnelTarget || 'Target Address'}</label>
                    <input type="text" id="tunnel-target-input" placeholder="e.g., 8.8.8.8:53" class="input-mono">
                </div>
            </div>
        `;

        const contentArea = /** @type {HTMLElement} */ (await showModal(t.addPortForwarding || "Add Port Forwarding", "", "", true, customHtml));
        if (!contentArea) return;

        const protocolInput = /** @type {HTMLInputElement} */ (contentArea.querySelector('#tunnel-protocol-input'));
        const addressInput = /** @type {HTMLInputElement} */ (contentArea.querySelector('#tunnel-address-input'));
        const targetInput = /** @type {HTMLInputElement} */ (contentArea.querySelector('#tunnel-target-input'));

        const protocolStr = protocolInput.value.trim();
        const address = addressInput.value.trim();
        const target = targetInput.value.trim();

        if (!protocolStr || !address || !target) {
            showNotification(t.valueEmpty || 'Value cannot be empty', 'error');
            return;
        }

        const protocols = protocolStr.split(',').map(s => s.trim().toLowerCase()).filter(s => s);
        const validProtocols = ['tcp', 'udp'];
        const invalidProtocols = protocols.filter(p => !validProtocols.includes(p));

        if (protocols.length === 0 || invalidProtocols.length > 0) {
            showNotification(t.invalidProtocol || 'Invalid protocol. Use tcp, udp, or both.', 'error');
            return;
        }

        if (!isValidAddress(address)) {
            showNotification(t.invalidAddressFormat || 'Invalid listen address format. Use host:port', 'error');
            return;
        }

        if (!isValidAddress(target)) {
            showNotification(t.invalidTargetFormat || 'Invalid target address format. Use host:port', 'error');
            return;
        }

        const network = protocols;
        currentTunnels.push({ network, address, target });
        saveConfigToCore({ tunnels: currentTunnels });
        renderTunnels();
    });

    // ---- Load settings from core ----
    const loadSettingsFromCore = async () => {
        try {
            /** @type {any} */
            const config = await invoke(COMMANDS.READ_CONFIG);
            if (unifiedDelayToggle) unifiedDelayToggle.checked = config['unified-delay'] !== false;
            if (ipv6Toggle) ipv6Toggle.checked = !!config.ipv6;
            if (allowLanToggle) allowLanToggle.checked = !!config['allow-lan'];

            if (config.tunnels && Array.isArray(config.tunnels)) {
                currentTunnels = config.tunnels;
            } else {
                currentTunnels = [];
            }
            renderTunnels();
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
    if (/** @type {any} */ (window)._dropUnlisten) {
        /** @type {any} */ (window)._dropUnlisten();
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
            /** @type {any} */ (window)._dropUnlisten = unlisten;
        }).catch(e => settingsLogger.warn('Failed to listen for profiles-imported event', e));
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

    // ---- Node scroll toggle ----
    nodeScrollToggle?.addEventListener('change', () => {
        if (!nodeScrollToggle) return;
        localStorage.setItem('nodeScroll', String(nodeScrollToggle.checked));
        // Clear the container to force full re-render (in-place update won't update CSS classes)
        const container = document.getElementById('proxies-list');
        if (container) container.innerHTML = '';
        renderProxies();
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
        } catch (e) {
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

            if (/** @type {any} */ (window)._trafficWsHandle) {
                /** @type {any} */ (window)._trafficWsHandle.reconnect();
            }

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

    // ---- Subscription management ----
    const subAddBtn = document.getElementById('add-sub-btn');
    if (subAddBtn) {
        subAddBtn.onclick = async () => {
            /** @type {any} */
            const t = /** @type {any} */ (translations)[appStore.get('currentLang')];
            const url = /** @type {string} */ (await showModal(t.addSubscription, t.urlPlaceholder || "Subscription URL"));
            if (!url) return;
            /** @type {any} */
            const t2 = /** @type {any} */ (translations)[appStore.get('currentLang')];
            showNotification(t2.notifDownloadingSub || "Downloading subscription...");
            try {
                const userAgent = getSubscriptionUserAgent();
                const name = extractNameFromUrl(url) || 'subscription';
                /** @type {any} */
                const invokeArgs = { url, name };
                if (userAgent) {
                    invokeArgs.userAgent = userAgent;
                }
                await invoke(COMMANDS.DOWNLOAD_SUB, invokeArgs);

                invalidateConfigsCache();

                /** @type {any} */
                const subSettings = await invoke(COMMANDS.GET_SETTINGS);
                const currentConfig = subSettings.last_config || 'config.yaml';
                if (name === currentConfig || name === currentConfig + '.yaml') {
                    await reloadConfig();
                }

                /** @type {any} */
                const t3 = /** @type {any} */ (translations)[appStore.get('currentLang')];
                showNotification(t3.notifSubSuccess, 'success');
                renderConfigs();
            } catch (err) {
                const error = toError(err);
                /** @type {any} */
                const t4 = /** @type {any} */ (translations)[appStore.get('currentLang')];
                showNotification(`${t4.notifSubFailed}: ${error}`, 'error');
            }
        };
    }

    // ---- Update all subscriptions ----
    const updateAllSubBtn = document.getElementById('update-all-sub-btn');
    if (updateAllSubBtn) {
        updateAllSubBtn.onclick = async () => {
            /** @type {any} */
            const t = /** @type {any} */ (translations)[appStore.get('currentLang')];
            /** @type {any} */
            const configs = await invoke(COMMANDS.LIST_CONFIGS);
            const subConfigs = configs.filter(/** @param {any} c */ (c) => c.url_display);

            if (subConfigs.length === 0) {
                showNotification(t.notifNoSubToUpdate, 'info');
                return;
            }

            const icon = updateAllSubBtn.querySelector('svg');
            if (icon) icon.classList.add('animate-spin');
            updateAllSubBtn.classList.add('opacity-50', 'pointer-events-none');

            let successCount = 0;
            let failCount = 0;
            showNotification(t.notifUpdateCount.replace('{count}', String(subConfigs.length)));

            for (const config of subConfigs) {
                try {
                    const userAgent = getSubscriptionUserAgent();
                    const fullUrl = await invoke(COMMANDS.GET_CONFIG_URL, { name: config.name });
                    await invoke(COMMANDS.DOWNLOAD_SUB, { url: fullUrl, name: config.name, userAgent });
                    successCount++;
                } catch (err) {
                    failCount++;
                    settingsLogger.error(`Failed to update ${config.name}`, err);
                }
            }

            invalidateConfigsCache();

            /** @type {any} */
            const subSettings = await invoke(COMMANDS.GET_SETTINGS);
            const currentConfig = subSettings.last_config || 'config.yaml';
            const customArgs = subSettings.custom_args || [];
            const wasCurrentUpdated = subConfigs.some(/** @param {any} c */ (c) => c.name === currentConfig);

            if (wasCurrentUpdated && successCount > 0) {
                await restartCore(currentConfig, customArgs);
            }

            if (icon) icon.classList.remove('animate-spin');
            updateAllSubBtn.classList.remove('opacity-50', 'pointer-events-none');
            renderConfigs();

            if (failCount === 0) {
                showNotification(t.notifUpdateAllComplete.replace('{success}', String(successCount)).replace('{fail}', String(failCount)), 'success');
            } else {
                showNotification(t.notifUpdateAllComplete.replace('{success}', String(successCount)).replace('{fail}', String(failCount)), 'info');
            }
        };
    }

    // ---- Config management ----
    const renderConfigs = async () => {
        if (!configsList) return;

        const [configs, cfgSettings] = await Promise.all([
            getConfigsCached(),
            getSettingsCached(),
        ]);

        const currentConfig = cfgSettings.last_config || 'config.yaml';
        const customArgs = cfgSettings.custom_args || [];
        /** @type {any} */
        const t = /** @type {any} */ (translations)[appStore.get('currentLang')];

        configsList.innerHTML = '';
        configs.forEach((/** @type {any} */ configInfo) => {
            const name = configInfo.name;
            const isCurrent = name === currentConfig;

            const item = document.createElement('div');
            item.className = `glass-card flex flex-col p-4 transition-all group cursor-pointer relative ${isCurrent ? 'ring-1 ring-accent/50 shadow-[0_0_20px_rgba(var(--color-accent-rgb),0.2)]' : 'hover:shadow-lg'}`;

            const row = document.createElement('div');
            row.className = "flex items-center justify-between";

            const left = document.createElement('div');
            left.className = 'flex items-center gap-3 pointer-events-none';

            const dot = document.createElement('div');
            dot.className = `w-2 h-2 rounded-full ${isCurrent ? 'bg-accent shadow-[0_0_8px_var(--color-accent-glow)]' : 'bg-zinc-700'}`;

            const label = document.createElement('span');
            label.className = `text-xs transition-colors ${isCurrent ? 'font-bold text-zinc-100' : 'text-zinc-400'}`;
            label.textContent = name;

            left.appendChild(dot);
            left.appendChild(label);

            const actions = document.createElement('div');
            actions.className = 'flex items-center gap-2 transition-all opacity-0 group-hover:opacity-100';

            // Delete button
            const delBtn = document.createElement('button');
            delBtn.className = 'btn-delete-icon';
            delBtn.innerHTML = SVG_ICONS.trash;
            delBtn.title = t.delete;
            delBtn.onclick = async (e) => {
                e.stopPropagation();
                e.preventDefault();

                if (isCurrent) {
                    showNotification(t.cannotDeleteActive || 'Cannot delete the active configuration', 'warning');
                    return;
                }

                const confirmed = await showConfirmModal(
                    t.delete || 'Delete',
                    t.confirmDelete || `Are you sure you want to delete "${name}"?`
                );
                if (!confirmed) return;

                try {
                    await invoke(COMMANDS.DELETE_CONFIG, { name });
                    invalidateConfigsCache();
                    showNotification(t.notifDeleteSuccess, 'success');
                    renderConfigs();
                } catch (err) {
                    const error = toError(err);
                    showNotification(`${t.notifDeleteFailed}: ${error}`, 'error');
                }
            };

            // Update button (only if has URL)
            if (configInfo.url_display) {
                const updateBtn = document.createElement('button');
                updateBtn.className = 'p-1.5 rounded-md hover:bg-accent/20 text-zinc-500 hover:text-accent transition-all';
                updateBtn.innerHTML = SVG_ICONS.refresh;
                updateBtn.title = t.update;
                updateBtn.onclick = async (e) => {
                    e.stopPropagation();
                    updateBtn.classList.add('animate-spin');
                    try {
                        const userAgent = getSubscriptionUserAgent();
                        const fullUrl = await invoke(COMMANDS.GET_CONFIG_URL, { name: configInfo.name });
                        await invoke(COMMANDS.DOWNLOAD_SUB, { url: fullUrl, name: configInfo.name, userAgent });
                        invalidateConfigsCache();
                        if (isCurrent) {
                            const cfgCustomArgs = cfgSettings.custom_args || [];
                            await restartCore(configInfo.name, cfgCustomArgs);
                        }
                        showNotification(t.notifSubSuccess, 'success');
                        renderConfigs();
                    } catch (err) {
                        const error = toError(err);
                        showNotification(`${t.notifSubFailed}: ${error}`, 'error');
                    } finally {
                        updateBtn.classList.remove('animate-spin');
                    }
                };
                actions.appendChild(updateBtn);
            }

            actions.appendChild(delBtn);

            const switchConfig = async () => {
                if (isCurrent || appStore.get('isNetworkUpdating')) return;

                appStore.set('isNetworkUpdating', true);
                item.classList.add('opacity-50', 'pointer-events-none');

                try {
                    /** @type {any} */
                    const coreResult = await restartCore(name, customArgs);
                    if (coreResult && coreResult.secret) {
                        showNotification(t.configSuccess, 'success');

                        /** @type {any} */
                        const s = await invoke(COMMANDS.GET_SETTINGS);
                        s.last_config = name;
                        await invoke(COMMANDS.SAVE_SETTINGS, { settings: s });
                        invalidateSettingsCache();

                        await new Promise(r => setTimeout(r, 1000));
                        await renderConfigs();
                        await renderProxies();
                        await syncCoreConfig();
                        await closeAllConnections();
                    }
                } catch (err) {
                    const error = toError(err);
                    showNotification(error.toString(), 'error');
                } finally {
                    appStore.set('isNetworkUpdating', false);
                    item.classList.remove('opacity-50', 'pointer-events-none');
                }
            };

            item.onclick = switchConfig;

            row.appendChild(left);
            row.appendChild(actions);
            item.appendChild(row);

            // SubInfo (Traffic usage)
            if (configInfo.sub_info) {
                const parts = configInfo.sub_info.split(';').map(/** @param {string} s */ (s) => s.trim());
                let upload = 0, download = 0, total = 0;
                parts.forEach(/** @param {string} p */ (p) => {
                    if (p.startsWith('upload=')) upload = parseInt(p.split('=')[1]) || 0;
                    if (p.startsWith('download=')) download = parseInt(p.split('=')[1]) || 0;
                    if (p.startsWith('total=')) total = parseInt(p.split('=')[1]) || 0;
                });

                if (total > 0) {
                    const used = upload + download;
                    const percentage = Math.min(100, Math.max(0, (used / total) * 100));

                    const usageContainer = document.createElement('div');
                    usageContainer.className = 'mt-3 mb-1 w-full';

                    const textRow = document.createElement('div');
                    textRow.className = 'flex justify-between text-2xs text-zinc-500 mb-1.5 px-0.5 uppercase tracking-wider font-bold';
                    textRow.innerHTML = `<span>${formatFileSize(used)} ${t.usedSpace || 'used'}</span><span>${formatFileSize(total)} ${t.totalSpace || 'total'}</span>`;

                    const barBg = document.createElement('div');
                    barBg.className = 'h-1.5 w-full bg-black/40 rounded-full overflow-hidden border border-white/5';

                    const barFill = document.createElement('div');
                    barFill.className = `h-full rounded-full transition-all duration-1000 ${percentage > 90 ? 'bg-rose-500' : 'bg-accent'}`;
                    barFill.style.width = `${percentage}%`;

                    barBg.appendChild(barFill);
                    usageContainer.appendChild(textRow);
                    usageContainer.appendChild(barBg);
                    item.appendChild(usageContainer);
                }
            }

            if (configInfo.url_display) {
                const urlLabel = document.createElement('div');
                urlLabel.className = 'text-2xs text-zinc-600 truncate mt-1 w-full';
                urlLabel.textContent = configInfo.url_display;
                item.appendChild(urlLabel);
            }

            configsList.appendChild(item);
        });

        // Sync tray menu after rendering configs
        try {
            const { updateTrayMenu } = await import('./tray.js');
            updateTrayMenu(true).catch(() => {});
        } catch {}
    };

    renderConfigs();

    initFakeClient();
}

// ---------------------------------------------------------------------------
//  DNS configuration (delegated to dns-shared.js)
// ---------------------------------------------------------------------------
export { DEFAULT_DNS_CONFIG, isValidIPv6, isValidDns, getDnsConfig, buildDnsRewritePayload, applyDnsRewrite, initDnsRewriteToggle };

// ---------------------------------------------------------------------------
//  Public API -- re-exports for other modules
// ---------------------------------------------------------------------------
export { getFakeClientUA, getSubscriptionUserAgent, extractNameFromUrl };
