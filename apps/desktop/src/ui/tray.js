// @ts-check
/**
 * Tray management - system tray icon, menu, and event listeners.
 * Extracted from ui.js for modularity.
 */

import { getConfig, getProxies, switchProxy, closeAllConnections, invoke, listen } from '../api.js';
import { switchToConfig } from './lifecycle.js';
import { currentProfile } from './active-profile.js';
import { t as tFunc } from '../i18n.js';
import { showNotification } from './notifications.js';
import { trayLogger } from '../utils/logger.js';
import { trayMenuCache, TRAY_CACHE_TTL, invalidateProxiesCache } from './cache.js';
import { toError } from '../types/guards.js';
import { appStore } from './state.js';
import { COMMANDS } from '@zephyr/shared';
import { invalidateRunConfigCache } from './run-config-cache.js';

/** Safely refresh sysproxy status with logging */
function refreshSysProxyStatusSafe() {
    import('./sysproxy.js').then(m => m.refreshSysProxyStatus()).catch(err => {
        trayLogger.warn('Failed to refresh sysproxy status', err);
    });
}

/** Restore sys-proxy through the serialization queue (prevents TOCTOU race). */
function restoreSysProxySafe() {
    // Without a subscription the core runs the direct-only minimal config: a leftover
    // ownership marker must not turn the system proxy back on.
    if (appStore.get('noSubscription')) return;
    import('./sysproxy.js').then(m => m.restoreSysProxy()).catch(err => {
        trayLogger.warn('Failed to restore system proxy', err);
    });
}

/** Resolve a translation key with a fallback when the key is missing. */
const tr = (/** @type {string} */ key, /** @type {string} */ fallback) => {
    const val = tFunc(key);
    return val === key ? fallback : val;
};

// --- Tray event listener cleanup ---

/** @type {Array<() => void | Promise<void>>} */
let _trayEventUnlisteners = [];

export async function cleanupTrayEventListeners() {
    const unlisteners = _trayEventUnlisteners;
    _trayEventUnlisteners = [];
    await Promise.all(unlisteners.map(async (unlisten) => {
        if (typeof unlisten === 'function') {
            try {
                await unlisten();
            } catch (err) {
                trayLogger.warn('[tray] unlisten failed during cleanup:', err);
            }
        }
    }));
}

// --- Tray status ---

/** Sequence of `updateTrayStatus` calls, used to discard stale results. */
let _trayStatusSeq = 0;

/**
 * Push a tray icon mode: the backend-derived mode, or `modeOverride`
 * when given. The periodic sync passes its expected mode so a stopped
 * core can be shown idle without rewriting the store's TUN / sysproxy
 * preferences.
 *
 * Without an override the mode comes from the backend's proxy status —
 * the same live state the backend's own icon refresh reads. The store
 * cannot substitute for it: its TUN flag is only realigned with the
 * backend by the periodic sync, so between an override hot-reload
 * flipping TUN on the running core and the next sync tick, a
 * store-driven caller (preference subscriptions, shortcuts, toggles)
 * would paint the icon the store believes in instead of the one the
 * core is actually in, and it would stay wrong until that tick. The
 * store's mode is only the fallback for an unanswered status query.
 *
 * @param {string} [modeOverride] - Mode to apply instead of the derived mode.
 */
export async function updateTrayStatus(modeOverride) {
    const seq = ++_trayStatusSeq;
    let mode = modeOverride;
    if (!mode) {
        const proxyStatus = await invoke(COMMANDS.GET_TRAY_PROXY_STATUS).catch(() => null);
        // A newer update began while this query was in flight: its mode is
        // fresher than anything this call can derive from its older sample,
        // and applying `stopped` here could paint idle over an active icon
        // the newer call already set, leaving the wrong icon up until the
        // periodic sync's next tick repairs it.
        if (seq !== _trayStatusSeq) return;
        if (proxyStatus === 'tun') {
            mode = 'tun';
        } else if (proxyStatus === 'sysproxy') {
            mode = 'sysproxy';
        } else if (proxyStatus === 'running' || proxyStatus === 'stopped') {
            mode = 'default';
        } else {
            const isTunEnabled = appStore.get('isTunEnabled');
            const isSysProxyEnabled = appStore.get('isSysProxyEnabled');
            if (isTunEnabled) mode = 'tun';
            else if (isSysProxyEnabled) mode = 'sysproxy';
            else mode = 'default';
        }
    }

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
            const activeConfig = currentProfile(settings, 'config.yaml');
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
                showText: tr('trayShow', 'Show Zephyr'),
                quitText: tr('trayQuit', 'Quit'),
                sysProxyText: tr('traySysProxy', 'System Proxy'),
                tunText: tr('trayTunMode', 'TUN Mode'),
                ruleText: tr('rule', 'Rule'),
                globalText: tr('global', 'Global'),
                directText: tr('direct', 'Direct'),
                subscriptionsText: tr('traySubscriptions', 'Subscriptions'),
                proxiesText: tr('trayProxies', 'Proxies'),
                copyEnvText: tr('trayCopyEnv', 'Copy Proxy Env'),
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
        let enabled = ev.payload;
        const toggle = /** @type {HTMLInputElement | null} */ (document.getElementById('sys-proxy-toggle'));
        // Without a subscription the system proxy would only reach DIRECT: undo a tray enable,
        // as the switches and the shortcut refuse it.
        if (enabled && appStore.get('noSubscription')) {
            try {
                const { setSysProxyEnabled } = await import('./sysproxy.js');
                await setSysProxyEnabled(false);
                enabled = false;
            } catch (err) {
                trayLogger.warn('Failed to undo tray system proxy without a subscription', err);
            }
            showNotification(tFunc('sysProxyNeedsSubscription') || 'Available once a subscription is added', 'warning');
            // The backend already drew the tray as enabled, and the store may not change
            // (it was false before), so its subscribers would not redraw it.
            updateTrayStatus().catch(() => {});
            updateTrayMenu(true).catch(() => {});
        }

        // Rust backend has already toggled the system proxy; just sync the UI.
        appStore.set('isSysProxyEnabled', enabled);
        if (toggle) toggle.checked = enabled;
        refreshSysProxyStatusSafe();
        // appStore.subscribe in main.js already triggers updateTrayMenu()
    });
    _trayEventUnlisteners.push(unlisten1);

    // Listen for TUN toggle from tray
    const unlisten2 = await listen('tray-tun-changed', async (event) => {
        /** @type {any} */
        const ev = event;
        // `toggle_tun` took the backend toggle lock before emitting; a dropped
        // event must hand it back or every later tray toggle is ignored.
        if (appStore.get('isNetworkUpdating')) {
            invoke(COMMANDS.RELEASE_TUN_TOGGLE).catch(() => {});
            return;
        }

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

        // A core update or another switch is restarting the core: starting a
        // second restart now would race it.
        if (appStore.get('isNetworkUpdating')) {
            showNotification(tr('updNetworkBusy', 'Another network change is in progress. Try again when it finishes.'), 'warning');
            await updateTrayMenu().catch((/** @type {unknown} */ err) => trayLogger.warn('Failed to refresh tray menu', err));
            return;
        }
        appStore.set('isNetworkUpdating', true);
        try {
            /** @type {any} */
            const settings = await invoke(COMMANDS.GET_SETTINGS);
            const customArgs = settings.custom_args || [];

            const result = await switchToConfig(subName, customArgs);

            // 只在没有回退时显示切换通知（回退时已显示警告）
            if (!result.fallbackOccurred) {
                showNotification(`${tr('notifSwitchTo', 'Switched to')} ${subName}`, 'info');
            }

            // Sync core config first (updates appStore including TUN state), then update tray
            const { syncCoreConfig } = await import('./proxies.js');
            await syncCoreConfig();
            await updateTrayMenu();
        } catch (err) {
            trayLogger.error('Failed to switch subscription from tray', err);
            showNotification(toError(err).toString(), 'error');
        } finally {
            appStore.set('isNetworkUpdating', false);
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
                    import('./proxies.js').then(m => m.refreshProxies()).catch(() => {});
                }

                updateTrayMenu(true).catch(() => {});
                // Refresh tray again after a short delay to ensure mihomo has updated `now`
                setTimeout(() => updateTrayMenu(true).catch(() => {}), 500);
            } else {
                // A GLOBAL selection is routed through the backend and reported
                // as a rejected request instead of a thrown error, so surface it
                // instead of failing silently on a user-initiated switch.
                trayLogger.warn('Tray proxy switch was not applied');
                showNotification(tr('notifSwitchFailed', 'Failed to switch node'), 'error');
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
        showNotification(tr('trayCopyEnvSuccess', 'Proxy env vars copied'), 'info');
    });
    _trayEventUnlisteners.push(unlisten6);

    // Listen for clipboard write failure from tray (Rust-side arboard error)
    const unlisten7 = await listen('tray-copy-env-failed', async (event) => {
        /** @type {any} */
        const ev = event;
        showNotification(`${tr('trayCopyEnvFailed', 'Failed to copy proxy env')}: ${ev.payload}`, 'error');
    });
    _trayEventUnlisteners.push(unlisten7);
}

// --- Unified periodic sync ---

/** @type {ReturnType<typeof setInterval> | null} */
let _unifiedSyncInterval = null;

/**
 * Align the store's TUN flag with the state a stopped core's tray item
 * displays: the saved preference, or the run config's `tun.enable` when
 * no preference was recorded — the same fallback the backend's
 * `tray_tun_shown_enabled` uses.
 *
 * While the core runs, the alignment in `alignTunStoreWithBackend`
 * copies the core's live TUN state into the store, including a live
 * override an override reload recorded ahead of the preference. That
 * override is dropped when the core stops, so without this the in-app
 * switch keeps showing the override's value while the tray item already
 * shows the preference the next start will apply.
 *
 * The toggle guards match the running alignment: skip while a network
 * update is in flight (checked again after the reads), and drop the
 * result when a toggle that started and finished during the reads has
 * already recorded its outcome in the store.
 */
async function alignStoreWithStoppedTunPreference() {
    if (appStore.get('isNetworkUpdating')) return;
    const tunAtStart = appStore.get('isTunEnabled');
    const settings = await invoke(COMMANDS.GET_SETTINGS).catch(() => null);
    if (!settings) return;
    let shown = settings.tun_enabled;
    // Windows: an unelevated process starts the core without TUN whatever the
    // preference says, and the backend reports TUN off (see
    // `applicable_tun_preference`): show the same, so the switch offers the
    // administrator relaunch instead of claiming TUN is on.
    if (navigator.userAgent.toLowerCase().includes('windows')
        && await invoke(COMMANDS.IS_PROCESS_ELEVATED).catch(() => null) === false) {
        shown = false;
    }
    if (shown === null || shown === undefined) {
        // Read the config directly, not through the cache: the cache
        // answers a failed read with its stale entry, while the backend
        // treats an unreadable run config as TUN off — a stopped core
        // whose file is gone would otherwise keep showing the cached
        // state here while the tray item already shows off.
        const config = await invoke(COMMANDS.CORE.READ_CONFIG).catch(() => null);
        shown = config?.tun?.enable ?? false;
    }
    if (appStore.get('isNetworkUpdating')) return;
    if (appStore.get('isTunEnabled') !== tunAtStart) return;
    const shownEnabled = Boolean(shown);
    if (shownEnabled !== appStore.get('isTunEnabled')) {
        appStore.set('isTunEnabled', shownEnabled);
    }
}

/**
 * Align the store's TUN flag with the backend's live TUN state.
 *
 * The backend's tray proxy status answers from its live TUN state, while
 * the store-driven icon writers paint from this store. If the two
 * disagree about TUN, those writers re-apply the store's mode on every
 * preference change, and the backend's own refresh keeps flipping the
 * icon back — the two writers never converge.
 * While the core is running its state is the truth the toggle claims to
 * show, so align the store with it first. When the core is stopped the
 * status carries no TUN information, and the store is aligned with the
 * saved preference instead (see `alignStoreWithStoppedTunPreference`):
 * the running alignment may have copied a live override into the store,
 * and that override dies with the core.
 *
 * The alignment does not use the samples the sync took when its tick
 * started: the slowest invoke can take long enough for a TUN toggle to
 * finish meanwhile — writing the stale sample then would flip the store
 * back to the pre-toggle state until the next tick. Pairing two of
 * those samples can also straddle a core start, pairing a pre-start
 * mode with a post-start running state. So the alignment re-reads the
 * one status that reports running state and TUN together, and skips
 * while a network update is in flight, checked again after the
 * re-read: a toggle in progress owns `isTunEnabled` until it has
 * recorded its outcome. A toggle that started and finished during
 * the re-read is caught the same way, by comparing the store against
 * the value it held when the re-read began.
 *
 * @param {string} proxyStatus - The proxy status sampled by the sync tick.
 * @returns {Promise<string | null>} The fresh status the alignment read, or
 * `null` when it read none (the tick's own sample was already `stopped`, a
 * network update is in flight, or the re-read failed). The sync builds its
 * icon decision on this freshest sample when there is one: the core can
 * stop between the tick's first sample and this re-read, and a decision
 * built on the first sample would push an active icon for a stopped core.
 */
async function alignTunStoreWithBackend(proxyStatus) {
    if (appStore.get('isNetworkUpdating')) return null;
    if (proxyStatus === 'stopped') {
        await alignStoreWithStoppedTunPreference();
        return null;
    }
    const tunAtStart = appStore.get('isTunEnabled');
    const freshProxyStatus = await invoke(COMMANDS.GET_TRAY_PROXY_STATUS).catch(() => null);
    if (!freshProxyStatus) return null;
    if (freshProxyStatus === 'stopped') {
        await alignStoreWithStoppedTunPreference();
        return freshProxyStatus;
    }
    if (appStore.get('isNetworkUpdating')) return null;
    // A toggle that started and finished while the status request was
    // in flight has already recorded its outcome in the store, and the
    // `isNetworkUpdating` check above cannot see it any more. The
    // response was sampled before that toggle, so writing it would
    // flip the store back to the pre-toggle value until the next tick.
    if (appStore.get('isTunEnabled') !== tunAtStart) return freshProxyStatus;
    const backendTunEnabled = freshProxyStatus === 'tun';
    if (backendTunEnabled !== appStore.get('isTunEnabled')) {
        appStore.set('isTunEnabled', backendTunEnabled);
    }
    return freshProxyStatus;
}

/**
 * Whether the core answers. The system proxy is only put back while it does:
 * pointing it at a port nobody listens on (the core is still starting, or
 * stopped) would cut the connection; the periodic check tries again.
 * @returns {Promise<boolean>}
 */
async function coreAnswers() {
    try {
        await getConfig();
        return true;
    } catch {
        return false;
    }
}

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
    void (async () => {
        try {
            const [sysProxyOn, hasOwnership] = await Promise.all([
                invoke(COMMANDS.GET_SYS_PROXY),
                invoke(COMMANDS.HAS_SYSPROXY_OWNERSHIP),
            ]);
            if (!sysProxyOn && hasOwnership && await coreAnswers()) {
                // Route through the serialization queue to prevent racing
                // with a concurrent user-initiated disable.
                restoreSysProxySafe();
            }
        } catch (_) {
            // Non-critical: periodic sync will retry
        }
    })();

    _unifiedSyncInterval = setInterval(async () => {
        try {
            const [realSysProxyState, proxyStatus, hasOwnership] = await Promise.all([
                invoke(COMMANDS.GET_SYS_PROXY),
                invoke(COMMANDS.GET_TRAY_PROXY_STATUS),
                invoke(COMMANDS.HAS_SYSPROXY_OWNERSHIP),
            ]);

            if (realSysProxyState !== appStore.get('isSysProxyEnabled')) {
                appStore.set('isSysProxyEnabled', realSysProxyState);
                refreshSysProxyStatusSafe();
            }

            // Guard: if we own the proxy but it was disabled externally, restore it
            if (!realSysProxyState && hasOwnership && await coreAnswers()) {
                // Route through the serialization queue to prevent racing
                // with a concurrent user-initiated disable.
                restoreSysProxySafe();
            }

            const freshProxyStatus = await alignTunStoreWithBackend(proxyStatus);

            // A network update in flight owns `isTunEnabled` and the tray
            // icon until it records its outcome. A correction pushed from
            // the store's not-yet-committed flag could paint the pre-toggle
            // mode over the icon the update flow set, so this tick leaves
            // the icon to that flow.
            if (appStore.get('isNetworkUpdating')) return;

            // The correction compares the icon the tray is actually
            // showing — the backend records every icon writer's latest
            // claim — against the mode the freshest proxy status implies.
            // Deriving both sides from the status itself would agree even
            // when the icon is wrong: a TUN / sysproxy icon left up after
            // the core stopped, or an idle icon painted while the core
            // was mid-restart, would never show up as a mismatch. A
            // stopped core runs neither TUN nor the system proxy, so its
            // expected mode is idle regardless of the store's preferences.
            const effectiveProxyStatus = freshProxyStatus ?? proxyStatus;

            let expectedMode = 'default';
            if (effectiveProxyStatus === 'tun') expectedMode = 'tun';
            else if (effectiveProxyStatus === 'sysproxy') expectedMode = 'sysproxy';

            const actualMode = await invoke(COMMANDS.GET_TRAY_ICON_MODE).catch(() => null);
            if (actualMode === null || actualMode === expectedMode) return;

            // Revalidate before pushing: this tick's samples can predate
            // a proxy or TUN toggle that finished while they were being
            // read, and a correction built on them would paint the stale
            // mode over the icon that toggle just set — with later ticks
            // then seeing matching states and leaving it there. Only a
            // mismatch that survives a fresh set of samples is pushed.
            if (appStore.get('isNetworkUpdating')) return;
            const [freshStatus, freshIconMode] = await Promise.all([
                invoke(COMMANDS.GET_TRAY_PROXY_STATUS).catch(() => null),
                invoke(COMMANDS.GET_TRAY_ICON_MODE).catch(() => null),
            ]);
            if (!freshStatus || !freshIconMode || appStore.get('isNetworkUpdating')) return;

            let freshExpectedMode = 'default';
            if (freshStatus === 'tun') freshExpectedMode = 'tun';
            else if (freshStatus === 'sysproxy') freshExpectedMode = 'sysproxy';

            if (freshIconMode !== freshExpectedMode) {
                await updateTrayStatus(freshExpectedMode);
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
    const normalized = typeof format === 'string' ? format.toLowerCase() : undefined;
    const validFormats = ['bash', 'fish', 'cmd', 'powershell', 'nushell'];
    if (normalized && validFormats.includes(normalized)) return normalized;
    return detectDefaultShellFormat();
}

/**
 * Generate proxy environment variable strings for various shell formats.
 * @param {string} format - Shell format: bash, fish, cmd, powershell, nushell
 * @param {number} port - Proxy port number
 * @param {'http' | 'socks5h'} [scheme] - URL scheme the listener speaks
 * @returns {string} Formatted env var string ready to copy
 */
export function generateProxyEnvVars(format, port = 7890, scheme = 'http') {
    const proxy = `${scheme}://127.0.0.1:${port}`;
    const normalized = typeof format === 'string' ? format.toLowerCase() : undefined;
    switch (normalized) {
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
