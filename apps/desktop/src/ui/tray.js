// @ts-check
/**
 * Tray management - system tray icon, menu, and event listeners.
 * Extracted from ui.js for modularity.
 */

import { getConfig, getProxies, switchProxy, closeAllConnections, invoke, listen } from '../api.js';
import { switchToConfig } from './lifecycle.js';
import { translations, currentLang } from '../i18n.js';
import { showNotification } from './notifications.js';
import { trayLogger } from '../utils/logger.js';
import { trayMenuCache, TRAY_CACHE_TTL, invalidateProxiesCache } from './cache.js';
import { toError } from '../types/guards.js';
import { appStore } from './state.js';
import { COMMANDS } from '@zephyr/shared';
import { invalidateRunConfigCache } from './run-config-cache.js';

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
    const isTunEnabled = appStore.get('isTunEnabled');
    const isSysProxyEnabled = appStore.get('isSysProxyEnabled');
    let mode;
    if (isTunEnabled) mode = 'tun';
    else if (isSysProxyEnabled) mode = 'sysproxy';
    else mode = 'default';

    try {
        await invoke(COMMANDS.CHANGE_TRAY_ICON, { mode });
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

    const sysProxyEnabled = appStore.get('isSysProxyEnabled');
    const tunEnabled = appStore.get('isTunEnabled');

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
            invoke(COMMANDS.LIST_CONFIGS),
            getProxies(),
            invoke(COMMANDS.GET_SETTINGS),
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
                // Use the resolver's active UI group if available, otherwise fall back
                // to finding the first selector group.
                // Prefer uiGroupName over uiPrimaryGroupName: in global mode,
                // uiGroupName is 'GLOBAL' (the actually routing group), while
                // uiPrimaryGroupName may point to a selector that doesn't affect routing.
                let mainGroup = appStore.get('uiGroupName')
                    || appStore.get('uiPrimaryGroupName');
                if (!mainGroup || !pd.proxies[mainGroup]) {
                    const groupNames = Object.keys(pd.proxies).filter(/** @param {string} name */ (name) => {
                        const type = pd.proxies[name].type?.toLowerCase() || '';
                        return type === 'selector' || type === 'select';
                    });
                    mainGroup = groupNames[0];
                }
                if (mainGroup) {
                    const group = pd.proxies[mainGroup];
                    proxyGroups = [{
                        name: mainGroup,
                        type: group.type,
                        now: group.now || '',
                        proxies: (group.all || []).slice(0, 20).map(/** @param {string} proxyName */ (proxyName) => ({
                            name: proxyName,
                            alive: pd.proxies[proxyName]?.alive,
                        })),
                    }];
                }
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
        await invoke(COMMANDS.UPDATE_TRAY_FULL_MENU, {
            params: {
                showText: t.trayShow || "Show Zephyr",
                quitText: t.trayQuit || "Quit",
                sysProxyText: t.traySysProxy || "System Proxy",
                tunText: t.trayTunMode || "TUN Mode",
                ruleText: t.rule || "Rule",
                globalText: t.global || "Global",
                directText: t.direct || "Direct",
                subscriptionsText: t.traySubscriptions || "Subscriptions",
                proxiesText: t.trayProxies || "Proxies",
                copyEnvText: t.trayCopyEnv || "Copy Proxy Env",
                sysProxyEnabled,
                tunEnabled,
                configs,
                proxyGroups,
                currentMode,
            },
        });

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

        // Rust backend has already toggled the system proxy; just sync the UI.
        appStore.set('isSysProxyEnabled', enabled);
        if (toggle) toggle.checked = enabled;
        import('./sysproxy.js').then(m => m.updateSysProxyUI());
        // appStore.subscribe in main.js already triggers updateTrayMenu()
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
            toggle.dispatchEvent(new Event('change'));
            setTimeout(async () => {
                try { await invoke(COMMANDS.RELEASE_TUN_TOGGLE); } catch (_) {}
            }, 60000);
        } else {
            try { await invoke(COMMANDS.RELEASE_TUN_TOGGLE); } catch (_) {}
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
            /** @type {any} */
            const settings = await invoke(COMMANDS.GET_SETTINGS);
            const customArgs = settings.custom_args || [];

            const result = await switchToConfig(subName, customArgs);

            // 只在没有回退时显示切换通知（回退时已显示警告）
            if (!result.fallbackOccurred) {
                showNotification(`${t.notifSwitchTo || 'Switched to'} ${subName}`, 'info');
            }

            // Sync core config first (updates appStore including TUN state), then update tray
            const { syncCoreConfig } = await import('./proxies.js');
            await syncCoreConfig();
            await updateTrayMenu();
        } catch (err) {
            trayLogger.error('Failed to switch subscription from tray', err);
            showNotification(toError(err).toString(), 'error');
        }
    });

    // Listen for proxy change from tray
    _trayEventUnlisteners.push(unlisten4);

    const unlisten5 = await listen('tray-proxy-changed', async (event) => {
        /** @type {any} */
        const ev = event;
        const { group, proxy } = ev.payload;

        try {
            const success = await switchProxy(group, proxy);
            if (success) {
                invalidateProxiesCache();
                invalidateRunConfigCache();

                // Sync uiGroupName when tray explicitly specifies a group
                if (group) {
                    appStore.set('uiGroupName', group);
                }

                await closeAllConnections();
                // Let syncCoreConfig() handle the display update with leaf node resolution
                import('./proxies.js').then(m => m.syncCoreConfig()).catch(() => {});

                const proxiesPage = document.querySelector('[data-page="proxies"]');
                if (proxiesPage && proxiesPage.classList.contains('hidden') === false) {
                    import('./proxies.js').then(m => m.renderProxies());
                }

                updateTrayMenu(true).catch(() => {});
                // Refresh tray again after a short delay to ensure mihomo has updated `now`
                setTimeout(() => updateTrayMenu(true).catch(() => {}), 500);
            }
        } catch (err) {
            trayLogger.error('Failed to switch proxy from tray', err);
        }
    });
    _trayEventUnlisteners.push(unlisten5);

    // Listen for copy proxy env from tray (Rust-side clipboard write)
    // On Linux, WebKit2GTK requires window focus for navigator.clipboard,
    // which isn't guaranteed when clicking from the tray menu.
    // Rust now handles the clipboard write via arboard, so we just show the notification.
    const unlisten6 = await listen('tray-copy-env-done', async () => {
        const langKey = /** @type {'en'|'zh'|'ja'|'ko'} */(currentLang);
        const t = /** @type {Record<string, string>} */(translations[langKey] || {});
        showNotification(t.trayCopyEnvSuccess || 'Proxy env vars copied', 'info');
    });
    _trayEventUnlisteners.push(unlisten6);

    // Listen for clipboard write failure from tray (Rust-side arboard error)
    const unlisten7 = await listen('tray-copy-env-failed', async (event) => {
        /** @type {any} */
        const ev = event;
        const langKey = /** @type {'en'|'zh'|'ja'|'ko'} */(currentLang);
        const t = /** @type {Record<string, string>} */(translations[langKey] || {});
        showNotification(`${t.trayCopyEnvFailed || 'Failed to copy proxy env'}: ${ev.payload}`, 'error');
    });
    _trayEventUnlisteners.push(unlisten7);
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

    // Crash recovery: if ownership marker exists from a previous crash, restore proxy immediately
    (async () => {
        try {
            const [sysProxyOn, hasOwnership] = await Promise.all([
                invoke(COMMANDS.GET_SYS_PROXY),
                invoke(COMMANDS.HAS_SYSPROXY_OWNERSHIP),
            ]);
            if (!sysProxyOn && hasOwnership) {
                await invoke(COMMANDS.RESTORE_SYS_PROXY);
                appStore.set('isSysProxyEnabled', true);
                import('./sysproxy.js').then(m => m.updateSysProxyUI());
            }
        } catch (_) {
            // Non-critical: periodic sync will retry
        }
    })();

    _unifiedSyncInterval = setInterval(async () => {
        try {
            const [realSysProxyState, actualMode, hasOwnership] = await Promise.all([
                invoke(COMMANDS.GET_SYS_PROXY),
                invoke(COMMANDS.GET_TRAY_STATUS),
                invoke(COMMANDS.HAS_SYSPROXY_OWNERSHIP),
            ]);

            if (realSysProxyState !== appStore.get('isSysProxyEnabled')) {
                appStore.set('isSysProxyEnabled', realSysProxyState);
                import('./sysproxy.js').then(m => m.updateSysProxyUI());
            }

            // Guard: if we own the proxy but it was disabled externally, restore it
            if (!realSysProxyState && hasOwnership) {
                (async () => {
                    try {
                        await invoke(COMMANDS.RESTORE_SYS_PROXY);
                        appStore.set('isSysProxyEnabled', true);
                        import('./sysproxy.js').then(m => m.updateSysProxyUI());
                    } catch (restoreErr) {
                        trayLogger.error('Failed to restore system proxy', restoreErr);
                    }
                })();
            }

            let expectedMode;
            if (appStore.get('isTunEnabled')) expectedMode = 'tun';
            else if (realSysProxyState) expectedMode = 'sysproxy';
            else expectedMode = 'default';

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

// --- Proxy env var generation ---

/**
 * Detect the default shell format based on the current platform.
 * @returns {string} Shell format key: bash, cmd, powershell, fish, nushell
 */
export function detectDefaultShellFormat() {
    const ua = navigator.userAgent.toLowerCase();
    if (ua.includes('windows')) return 'powershell';
    return 'bash';
}

/**
 * Resolve the effective shell format from the user's setting.
 * Falls back to platform detection if the stored value is empty or invalid.
 * @param {string} format - Format from settings
 * @returns {string} Resolved format key
 */
export function resolveEnvFormat(format) {
    const normalized = format?.toLowerCase();
    const validFormats = ['bash', 'fish', 'cmd', 'powershell', 'nushell'];
    if (normalized && validFormats.includes(normalized)) return normalized;
    return detectDefaultShellFormat();
}

/**
 * Generate proxy environment variable strings for various shell formats.
 * @param {string} format - Shell format: bash, fish, cmd, powershell, nushell
 * @param {number} port - Proxy port number
 * @returns {string} Formatted env var string ready to copy
 */
export function generateProxyEnvVars(format, port = 7890) {
    const proxy = `http://127.0.0.1:${port}`;
    switch (format?.toLowerCase()) {
        case 'bash':
            return `export http_proxy=${proxy} https_proxy=${proxy} all_proxy=${proxy} HTTP_PROXY=${proxy} HTTPS_PROXY=${proxy} ALL_PROXY=${proxy}`;
        case 'fish':
            return `set -x http_proxy ${proxy}; set -x https_proxy ${proxy}; set -x all_proxy ${proxy}; set -x HTTP_PROXY ${proxy}; set -x HTTPS_PROXY ${proxy}; set -x ALL_PROXY ${proxy}`;
        case 'cmd':
            return `set http_proxy=${proxy}&set https_proxy=${proxy}&set all_proxy=${proxy}`;
        case 'powershell':
            return `$env:http_proxy="${proxy}"; $env:https_proxy="${proxy}"; $env:all_proxy="${proxy}"; $env:HTTP_PROXY="${proxy}"; $env:HTTPS_PROXY="${proxy}"; $env:ALL_PROXY="${proxy}"`;
        case 'nushell':
            return `$env.http_proxy = "${proxy}"; $env.https_proxy = "${proxy}"; $env.all_proxy = "${proxy}"; $env.HTTP_PROXY = "${proxy}"; $env.HTTPS_PROXY = "${proxy}"; $env.ALL_PROXY = "${proxy}"`;
        default:
            return `export http_proxy=${proxy} https_proxy=${proxy} all_proxy=${proxy} HTTP_PROXY=${proxy} HTTPS_PROXY=${proxy} ALL_PROXY=${proxy}`;
    }
}

/**
 * Copy text to clipboard with fallback for environments without clipboard API.
 * @param {string} text
 * @returns {Promise<void>}
 */
export async function copyToClipboard(text) {
    try {
        await navigator.clipboard.writeText(text);
    } catch (_) {
        // Fallback for environments without clipboard API
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        try {
            document.execCommand('copy');
        } finally {
            document.body.removeChild(textarea);
        }
    }
}
