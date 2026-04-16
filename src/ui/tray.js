// @ts-check
/**
 * Tray management - system tray icon, menu, and event listeners.
 * Extracted from ui.js for modularity.
 */

import { getConfig, getProxies, switchProxy, closeAllConnections, invoke, listen, restartCore } from '../api.js';
import { translations, currentLang } from '../i18n.js';
import { showNotification } from './notifications.js';
import { trayLogger } from '../utils/logger.js';
import { Bus, Events } from './events.js';
import { trayMenuCache, TRAY_CACHE_TTL, invalidateSettingsCache, invalidateProxiesCache } from './cache.js';
import { toError } from '../types/guards.js';
import { appStore } from './state.js';

// --- Tray event listener cleanup ---

/** @type {Array<() => void>} */
let _trayEventUnlisteners = [];

export function cleanupTrayEventListeners() {
    _trayEventUnlisteners.forEach(unlisten => {
        if (typeof unlisten === 'function') {
            unlisten();
        }
    });
    _trayEventUnlisteners = [];
}

// --- Tray status ---

export async function updateTrayStatus() {
    const tunToggle = /** @type {HTMLInputElement | null} */ (document.getElementById('tun-proxy-toggle'));
    const sysProxyToggle = /** @type {HTMLInputElement | null} */ (document.getElementById('sys-proxy-toggle'));

    const mode = tunToggle?.checked ? 'tun' : (sysProxyToggle?.checked ? 'sysproxy' : 'default');

    try {
        await invoke('change_tray_icon', { mode });
    } catch (err) {
        trayLogger.error('Failed to update tray icon', err);
    }
}

// --- Tray menu ---

export async function updateTrayMenu(forceRefresh = false) {
    const now = Date.now();
    const useCache = !forceRefresh && (now - trayMenuCache.lastUpdate) < TRAY_CACHE_TTL;

    const langKey = /** @type {'en'|'zh'|'ja'|'ko'} */(currentLang);
    const t = /** @type {Record<string, string>} */(translations[langKey]);
    const tunToggle = /** @type {HTMLInputElement | null} */ (document.getElementById('tun-proxy-toggle'));
    const sysProxyToggle = /** @type {HTMLInputElement | null} */ (document.getElementById('sys-proxy-toggle'));

    const sysProxyEnabled = sysProxyToggle?.checked || false;
    const tunEnabled = tunToggle?.checked || false;

    /** @type {string} */
    let currentMode;
    /** @type {any} */
    let configs;
    /** @type {Array<any>} */
    let proxyGroups;

    if (useCache && trayMenuCache.config && trayMenuCache.configs && trayMenuCache.proxyGroups) {
        /** @type {any} */
        const cachedConfig = trayMenuCache.config;
        currentMode = cachedConfig?.mode || 'rule';
        configs = trayMenuCache.configs;
        proxyGroups = trayMenuCache.proxyGroups;
    } else {
        const [config, configsList, proxyData, settings] = await Promise.all([
            getConfig(),
            invoke('list_configs'),
            getProxies(),
            invoke('get_settings'),
        ]);

        /** @type {any} */
        const cfg = config;
        currentMode = cfg?.mode || 'rule';

        try {
            const activeConfig = settings.last_config || 'config.yaml';
            /** @type {Array<any>} */
            const cl = configsList;
            configs = cl.map(/** @param {any} c */ (c) => ({
                name: c.name,
                is_active: c.name === activeConfig,
            }));
        } catch (e) {
            trayLogger.warn('Failed to get configs for tray menu', e);
            configs = [];
        }

        proxyGroups = [];
        try {
            /** @type {any} */
            const pd = proxyData;
            if (pd && pd.proxies) {
                const groupNames = Object.keys(pd.proxies).filter(/** @param {string} name */ (name) => {
                    const type = pd.proxies[name].type?.toLowerCase() || '';
                    return type === 'selector' || type === 'select';
                });

                proxyGroups = groupNames.slice(0, 5).map(/** @param {string} groupName */ (groupName) => {
                    const group = pd.proxies[groupName];
                    return {
                        name: groupName,
                        type: group.type,
                        now: group.now || '',
                        proxies: (group.all || []).slice(0, 20).map(/** @param {string} proxyName */ (proxyName) => ({
                            name: proxyName,
                            alive: pd.proxies[proxyName]?.alive,
                        })),
                    };
                });
            }
        } catch (e) {
            trayLogger.warn('Failed to get proxy groups for tray menu', e);
        }

        trayMenuCache.config = config || { mode: currentMode };
        trayMenuCache.configs = configs;
        trayMenuCache.proxyGroups = proxyGroups;
        trayMenuCache.lastUpdate = now;
    }

    try {
        await invoke('update_tray_full_menu', {
            showText: t.trayShow || "Show Zephyr",
            quitText: t.trayQuit || "Quit",
            sysProxyText: t.traySysProxy || "System Proxy",
            tunText: t.trayTunMode || "TUN Mode",
            ruleText: t.rule || "Rule",
            globalText: t.global || "Global",
            directText: t.direct || "Direct",
            subscriptionsText: t.traySubscriptions || "Subscriptions",
            proxiesText: t.trayProxies || "Proxies",
            sysProxyEnabled,
            tunEnabled,
            configs,
            proxyGroups,
            currentMode,
        });

        /** @type {any} */ (window)._currentSysProxyEnabled = sysProxyEnabled;
        /** @type {any} */ (window)._currentTunEnabled = tunEnabled;
    } catch (err) {
        trayLogger.error('Failed to update tray menu', err);
    }
}

// --- Tray event listeners ---

export async function initTrayEventListeners() {
    if (_trayEventUnlisteners.length > 0) return;

    // Listen for sys proxy toggle from tray
    const unlisten1 = await listen('tray-sysproxy-changed', async (event) => {
        /** @type {any} */
        const ev = event;
        const enabled = ev.payload;
        const toggle = /** @type {HTMLInputElement | null} */ (document.getElementById('sys-proxy-toggle'));

        if (toggle) {
            toggle.checked = enabled;
        }

        try {
            /** @type {any} */
            const currentConfig = await getConfig();
            const currentPort = currentConfig?.['mixed-port'] || currentConfig?.port || currentConfig?.['socks-port'] || 7890;

            if (enabled) {
                await invoke('enable_sysproxy', {
                    server: `127.0.0.1:${currentPort}`,
                    bypass: null,
                });
            } else {
                await invoke('disable_sysproxy');
            }

            import('./sysproxy.js').then(m => m.updateSysProxyUI());
            await updateTrayMenu();
        } catch (err) {
            trayLogger.error('Failed to toggle sys proxy from tray', err);
            if (toggle) toggle.checked = !enabled;
        }
    });
    _trayEventUnlisteners.push(unlisten1);

    // Listen for TUN toggle from tray
    const unlisten2 = await listen('tray-tun-changed', async (event) => {
        /** @type {any} */
        const ev = event;
        if (appStore.get('isNetworkUpdating')) return;

        const enabled = ev.payload;
        const toggle = /** @type {HTMLInputElement | null} */ (document.getElementById('tun-proxy-toggle'));

        if (toggle) {
            toggle.checked = enabled;
            setTimeout(async () => {
                try { await invoke('release_tun_toggle'); } catch (_) {}
            }, 60000);
        } else {
            try { await invoke('release_tun_toggle'); } catch (_) {}
        }
    });
    _trayEventUnlisteners.push(unlisten2);

    // Listen for mode change from tray
    const unlisten3 = await listen('tray-mode-changed', async (event) => {
        /** @type {any} */
        const ev = event;
        const mode = ev.payload;
        const buttons = document.querySelectorAll('[data-mode]');

        buttons.forEach((btn) => {
            if (btn.getAttribute('data-mode') === mode) {
                /** @type {HTMLElement} */ (btn).click();
            }
        });
    });
    _trayEventUnlisteners.push(unlisten3);

    // Listen for subscription change from tray
    const unlisten4 = await listen('tray-subscription-changed', async (event) => {
        /** @type {any} */
        const ev = event;
        const subName = ev.payload;
        const langKey = /** @type {'en'|'zh'|'ja'|'ko'} */(currentLang);
        const t = /** @type {Record<string, string>} */(translations[langKey]);

        try {
            showNotification(`${t.notifSwitchTo || 'Switched to'} ${subName}`, 'info');

            /** @type {any} */
            const settings = await invoke('get_settings');
            const customArgs = settings.custom_args || [];

            const coreResult = await restartCore(subName, customArgs);
            /** @type {any} */
            const result = coreResult;
            if (result && result.secret) {
                settings.last_config = subName;
                await invoke('save_settings', { settings });
                invalidateSettingsCache();

                await new Promise((r) => setTimeout(r, 500));
                import('./proxies.js').then(m => m.syncCoreConfig());
                await closeAllConnections();
                await updateTrayMenu();
            }
        } catch (err) {
            trayLogger.error('Failed to switch subscription from tray', err);
            showNotification(toError(err).toString(), 'error');
        }
    });

    // Listen for proxy change from tray
    const unlisten5 = await listen('tray-proxy-changed', async (event) => {
        /** @type {any} */
        const ev = event;
        const { group, proxy } = ev.payload;

        try {
            const success = await switchProxy(group, proxy);
            if (success) {
                invalidateProxiesCache();

                await closeAllConnections();
                import('./proxies.js').then(m => m.syncCoreConfig());

                const currentNodeEl = document.getElementById('current-node-name');
                if (currentNodeEl) currentNodeEl.textContent = proxy;

                const proxiesPage = document.querySelector('[data-page="proxies"]');
                if (proxiesPage && proxiesPage.classList.contains('hidden') === false) {
                    import('./proxies.js').then(m => m.renderProxies());
                }

                updateTrayMenu(true).catch(() => {});
            }
        } catch (err) {
            trayLogger.error('Failed to switch proxy from tray', err);
        }
    });
    _trayEventUnlisteners.push(unlisten5);
}

// --- Unified periodic sync ---

/** @type {ReturnType<typeof setInterval> | null} */
let _unifiedSyncInterval = null;

export function startUnifiedSync() {
    if (_unifiedSyncInterval) {
        clearInterval(_unifiedSyncInterval);
    }
    /** @type {any} */
    const win = window;
    if (win._sysProxyPollInterval) {
        clearInterval(win._sysProxyPollInterval);
        win._sysProxyPollInterval = null;
    }

    _unifiedSyncInterval = setInterval(async () => {
        try {
            const tunToggle = /** @type {HTMLInputElement | null} */ (document.getElementById('tun-proxy-toggle'));
            const sysProxyToggle = /** @type {HTMLInputElement | null} */ (document.getElementById('sys-proxy-toggle'));

            const [realSysProxyState, actualMode] = await Promise.all([
                invoke('get_sys_proxy'),
                invoke('get_tray_status'),
            ]);

            if (sysProxyToggle && sysProxyToggle.checked !== realSysProxyState) {
                sysProxyToggle.checked = realSysProxyState;
                import('./sysproxy.js').then(m => m.updateSysProxyUI());
            }

            const expectedMode = tunToggle?.checked ? 'tun' : (realSysProxyState ? 'sysproxy' : 'default');

            if (actualMode !== expectedMode) {
                await updateTrayStatus();
            }
        } catch (e) {
            trayLogger.error('Unified sync error', e);
        }
    }, 10000);
}

export function stopUnifiedSync() {
    if (_unifiedSyncInterval) {
        clearInterval(_unifiedSyncInterval);
        _unifiedSyncInterval = null;
    }
}
