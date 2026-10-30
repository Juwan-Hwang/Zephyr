// @ts-check
/**
 * Tray management - system tray icon, menu, and event listeners.
 * Extracted from ui.js for modularity.
 */

import { getConfig, getProxies, switchProxy, closeAllConnections, invoke, listen } from '../api.js';
import { switchToConfig } from './lifecycle.js';
import { activeProfile, currentProfile } from './active-profile.js';
import { saveProxySelection } from './proxy-memory.js';
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

/**
 * Remember a node picked in the tray for the running profile, as a pick on
 * the proxies page is: a later core restart restores this choice instead of
 * an older one. Skipped while the minimal config runs (no profile).
 * @param {string} profile - the profile from trayPickProfile
 * @param {string | null | undefined} group
 * @param {string} proxy
 */
async function rememberTraySelection(profile, group, proxy) {
    if (!profile) return;
    try {
        await saveProxySelection(profile, { node: proxy, group: group || undefined });
    } catch (err) {
        trayLogger.warn('Failed to remember the tray proxy choice', err);
    }
}

/**
 * The profile the core runs when a tray pick starts: read before the switch,
 * so a profile switch finishing meanwhile does not get this pick saved under
 * the new profile. '' when it cannot be read or the minimal config runs.
 * @returns {Promise<string>}
 */
async function trayPickProfile() {
    try {
        /** @type {any} */
        const settings = await invoke(COMMANDS.GET_SETTINGS);
        return activeProfile(settings, 'config.yaml') || '';
    } catch (err) {
        trayLogger.warn('Failed to read the profile for the tray proxy choice', err);
        return '';
    }
}

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
            // Forced: the tray already moved its check mark to the clicked
            // profile, and a cached menu would keep it there.
            await updateTrayMenu(true).catch((/** @type {unknown} */ err) => trayLogger.warn('Failed to refresh tray menu', err));
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

            // Sync core config first (updates appStore including TUN state), then update tray.
            // The switch already succeeded: a failed refresh is logged, not
            // reported as a failed switch.
            try {
                const { syncCoreConfig } = await import('./proxies.js');
                await syncCoreConfig();
            } catch (refreshErr) {
                trayLogger.warn('Refreshing after the tray subscription switch failed', refreshErr);
            }
            // Forced, and even when the sync failed: a refresh during the
            // switch cached the old profile's check mark.
            await updateTrayMenu(true).catch((/** @type {unknown} */ trayErr) => trayLogger.warn('Refreshing the tray after the subscription switch failed', trayErr));
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

        // A switch, mode change or core update holds this guard: the running
        // profile may change between reading it and switching the node, and
        // the pick would be saved under the old one (the node cards refuse too).
        if (appStore.get('isNetworkUpdating')) {
            showNotification(tr('updNetworkBusy', 'Another network change is in progress. Try again when it finishes.'), 'warning');
            await updateTrayMenu(true).catch((/** @type {unknown} */ err) => trayLogger.warn('Failed to refresh tray menu', err));
            return;
        }

        try {
            const profile = await trayPickProfile();
            // A change may have taken the guard while the profile was read:
            // check again right before switching, as the node cards do.
            if (appStore.get('isNetworkUpdating')) {
                showNotification(tr('updNetworkBusy', 'Another network change is in progress. Try again when it finishes.'), 'warning');
                await updateTrayMenu(true).catch((/** @type {unknown} */ err) => trayLogger.warn('Failed to refresh tray menu', err));
                return;
            }
            const success = await switchProxy(group, proxy);
            if (success) {
                invalidateProxiesCache();
                invalidateRunConfigCache();

                // Sync uiGroupName when tray explicitly specifies a group
                if (group) {
                    appStore.set('uiGroupName', group);
                }
                await rememberTraySelection(profile, group, proxy);

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
 * The newest text successfully copied, by any path, and the sequence
 * of the copy that recorded it. The text alone cannot identify which
 * copy the record belongs to: two copies of the same text, or a
 * direct write requested before a newer tray copy but resolving
 * after it, would otherwise corrupt the repair target. Every copy
 * takes a sequence when it is requested; a record is only replaced
 * by a newer sequence, and a failed copy only rolls back a record it
 * still owns.
 * @type {string | null}
 */
let latestCopiedText = null;
/** @type {number} */
let latestCopiedSeq = 0;
/** Monotonic sequence handed out to clipboard copies. @type {number} */
let clipboardSeq = 0;

/**
 * Take the sequence for a clipboard write that bypasses
 * `copyToClipboard` (the fullscreen editor and the console host copy
 * write directly). Capture it when the write is requested, and pass it
 * to `noteExternalClipboardWrite` when the write succeeds: a direct
 * write that was requested earlier but resolves later must not become
 * the repair target for a newer copy.
 * @returns {number}
 */
export function nextClipboardSeq() {
    clipboardSeq += 1;
    return clipboardSeq;
}

/**
 * The sequence of the newest text that actually landed on the
 * clipboard. Callers that queued a copy report its success only while
 * it still owns the clipboard: an external copy landing after it
 * replaces the text, and reusing the queued copy's success would
 * report a copy that is no longer on the clipboard.
 * @returns {number}
 */
export function getLatestLandedSeq() {
    return latestLandedSeq;
}

/**
 * Race a direct clipboard write against a timeout. A hung permission
 * prompt leaves `writeText` unsettled forever, so the caller would
 * stay silent with no feedback and no fallback — the same hang
 * `copyToClipboard` already races against 5 s. The timeout rejects
 * so the caller falls back (or reports failure); a write that lands
 * after the timeout is simply not observed — the race already
 * settled, and the fallback recorded whatever landed instead.
 * @param {Promise<void>} write the pending clipboard write
 * @param {number} [ms] timeout in ms
 * @returns {Promise<void>}
 */
export function withClipboardTimeout(write, ms = 5000) {
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timeoutId;
    const timeout = new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error('Clipboard write timed out')), ms);
    });
    return Promise.race([write, timeout]).finally(() => clearTimeout(timeoutId));
}

/**
 * The newest text actually on the clipboard, as far as confirmed
 * writes tell us — as opposed to `latestCopiedText`, which is the
 * newest text any copy was *asked* for. A copy claims the record the
 * moment it is requested, but it only lands when its write resolves;
 * until then the clipboard still holds whatever landed before. The
 * two must be told apart: repairing a stale landing towards a text
 * that never landed, or rolling a failed copy back past a newer
 * landing, both leave the tracker pointing somewhere the clipboard
 * is not.
 * @type {string | null}
 */
let latestLandedText = null;
/** Sequence of `latestLandedText`; 0 means nothing has landed yet. */
let latestLandedSeq = 0;

/**
 * Sequences of copies that failed both write paths. A failed copy's
 * claim must not be resurrected by a later copy's rollback: when two
 * overlapping copies fail in turn, the second one's rollback would
 * otherwise restore the first one's failed claim, and an older
 * reserved sequence would then be skipped without ever attempting its
 * write. One entry per failed copy; failures are rare, so the set
 * stays small.
 * @type {Set<number>}
 */
const failedClipboardSeqs = new Set();

/**
 * Record a clipboard write that bypassed `copyToClipboard`. Only a
 * newer sequence replaces the record: a direct write requested
 * before a newer tray copy but resolving after it is stale, and must
 * not overwrite the newer text. Only call on success — a failed
 * external write landed nothing. A stale write has already landed on
 * the clipboard and overwritten the newer tray text, so the newest
 * copy is re-asserted — otherwise the clipboard keeps the older text
 * while the tracker says the newer one. But only when the newer
 * record has itself landed: a claimed-but-unlanded tray copy is not
 * a repair target, and re-asserting it would overwrite the external
 * text that actually landed. In that case the external write is the
 * newest landing, and is remembered as such.
 * @param {string} text
 * @param {number} seq The sequence taken when the write was requested.
 * @returns {boolean} True when this write's text is the newest thing on
 * the clipboard, so the caller may report it as copied; false when a
 * newer copy claimed the record and this text was repaired away. A
 * direct write that bypasses `copyToClipboard` has no other way to
 * learn it was superseded.
 */
export function noteExternalClipboardWrite(text, seq) {
    if (seq > latestCopiedSeq) {
        latestCopiedText = text;
        latestCopiedSeq = seq;
        latestLandedText = text;
        latestLandedSeq = seq;
        return true;
    }
    if (latestCopiedText !== null && latestCopiedText !== text) {
        if (latestCopiedSeq === latestLandedSeq) {
            // The newer claim has landed: this write is superseded,
            // and the clipboard is repaired back to it.
            reassertLatestCopy(latestCopiedText, latestCopiedSeq);
            return false;
        }
        if (seq > latestLandedSeq) {
            // The newer claim has not landed yet: this write is the
            // newest landing, and is remembered as such.
            latestLandedText = text;
            latestLandedSeq = seq;
            return true;
        }
        if (latestLandedText !== null && latestLandedText !== text) {
            reassertLatestCopy(latestLandedText, latestLandedSeq);
        }
        return false;
    }
    // The clipboard holds this exact text — but that alone does not
    // settle it: a newer text may already have landed, and this stale
    // write just overwrote it. Treat it like the stale branch above:
    // record the landing when nothing newer landed yet; repair back to
    // the newest landing when something did; stay quiet only when the
    // newest landing already is this text. (When nothing was ever
    // claimed the record is empty and this is false, but that cannot
    // happen: a sequence is only stale once a newer claim exists.)
    if (latestCopiedText === text) {
        if (latestCopiedSeq === latestLandedSeq) return true;
        if (seq > latestLandedSeq) {
            latestLandedText = text;
            latestLandedSeq = seq;
            return true;
        }
        if (latestLandedText !== null && latestLandedText !== text) {
            reassertLatestCopy(latestLandedText, latestLandedSeq);
            return false;
        }
    }
    return latestCopiedText === text;
}

/**
 * Re-assert the newest text that actually landed, after a stale write
 * overwrote the clipboard. Only a text that has landed is a repair
 * target: re-asserting a claimed-but-unlanded copy would write a text
 * whose own copy may still fail, leaving the clipboard holding a text
 * the UI already reported as failed. When the newest claim has not
 * landed yet, the newest landing stands — it is already on the
 * clipboard, or is re-asserted here if the stale write differs from it.
 * @param {string} currentText The stale text that just landed.
 */
function reassertNewestLanded(currentText) {
    if (latestCopiedText !== null && latestCopiedText !== currentText && latestCopiedSeq === latestLandedSeq) {
        reassertLatestCopy(latestCopiedText, latestCopiedSeq);
    } else if (latestLandedText !== null && latestLandedText !== currentText) {
        reassertLatestCopy(latestLandedText, latestLandedSeq);
    }
}

/**
 * Re-assert the newest copied text after a write lands late.
 * Self-correcting: if a newer copy lands while this repair is still in
 * flight, the repair re-asserts the newest text again instead of leaving
 * the stale one on the clipboard. Each re-assertion is triggered by a
 * newer user copy, so the chain ends once the newest text stops changing.
 * Bounded like the main copy path: the write races the same 5 s timeout,
 * and a rejected or timed-out repair falls back to the textarea path — a
 * rejected repair landed nothing, but the stale text it was meant to
 * replace is still on the clipboard, so swallowing the failure would
 * leave the tracker claiming a text the clipboard does not hold. Only a
 * write that actually lands updates the landing record.
 * @param {string} expected
 * @param {number} targetSeq The sequence of the record being repaired —
 * the claim sequence when the claim has landed, the landing sequence
 * when the landing is older than the claim. The caller takes it from
 * the record it repairs: the text alone cannot identify it, because a
 * newer pending copy of the same text may exist, and its sequence must
 * not be claimed as this repair's landing.
 */
function reassertLatestCopy(expected, targetSeq) {
    const onLanded = () => {
        if (latestCopiedText === expected && latestCopiedSeq === targetSeq) {
            // The repair landed the current record: it is now the
            // newest thing actually on the clipboard.
            latestLandedText = expected;
            latestLandedSeq = targetSeq;
        } else {
            // A newer copy was requested while this repair was in
            // flight: re-assert the newest text that actually
            // landed (see `reassertNewestLanded`), not the newest
            // claim — the claim may still fail, and writing it
            // here would put a failed text on the clipboard.
            reassertNewestLanded(expected);
        }
    };
    const fallback = () => {
        // A newer copy has already landed since this repair started:
        // writing the older text now would only overwrite it and need
        // another repair — skip it, the newer copy reports itself.
        if (targetSeq < latestLandedSeq) return;
        // Same textarea path as the main copy's fallback (see
        // `copyToClipboard`): the repair runs outside any click, so the
        // command may not be enabled — a failed fallback leaves the
        // stale text, as before, but the attempt is bounded now and the
        // next clipboard event re-triggers the repair.
        try {
            const textarea = document.createElement('textarea');
            textarea.value = expected;
            textarea.style.position = 'fixed';
            textarea.style.opacity = '0';
            document.body.appendChild(textarea);
            const previouslyFocused = document.activeElement;
            textarea.select();
            try {
                if (!document.execCommand('copy')) return;
                onLanded();
            } finally {
                document.body.removeChild(textarea);
                if (previouslyFocused instanceof HTMLElement) {
                    previouslyFocused.focus();
                }
            }
        } catch (_) {
            // Best-effort: the next clipboard event re-triggers the repair.
        }
    };
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timeoutId;
    const writePromise = navigator.clipboard.writeText(expected);
    // Observe the write itself, not just the timeout race: a write
    // that lands after the race already settled (timed out) would
    // otherwise overwrite a newer copy without anyone noticing, and
    // the tracker would keep claiming the newer text. `onLanded`
    // either records this landing or, when a newer copy claimed the
    // record meanwhile, re-asserts the newest landed text — so a
    // second call from the race's success path would double-report
    // it, and the race only clears the timer now.
    writePromise.then(onLanded, () => {});
    Promise.race([
        writePromise,
        new Promise((_, reject) => {
            timeoutId = setTimeout(() => {
                reject(new Error('Clipboard repair timed out'));
            }, 5000);
        }),
    ]).then(
        () => {
            clearTimeout(timeoutId);
        },
        () => {
            clearTimeout(timeoutId);
            fallback();
        },
    );
}

/**
 * Copy text to clipboard with fallback for environments without clipboard API.
 * @param {string} text
 * @param {number} [seq] The sequence taken when the copy was requested.
 * Callers that await before copying (the settings copy button, which
 * reads settings and config first) pass the sequence they took at click
 * time, so a copy requested later cannot be overtaken by an older click
 * that resumes first. Defaults to a fresh sequence.
 * @returns {Promise<boolean>} True when this copy's text is the newest on
 * the clipboard; false when a newer copy claimed the record while this
 * write was in flight, so this text was repaired away and the caller
 * must not report it as copied. Throws when nothing landed.
 */
export async function copyToClipboard(text, seq) {
    // A clipboard write can hang: when the browser leaves the
    // permission prompt unanswered, `writeText` may never settle, and a
    // caller that serializes writes (the copy button's chain) would
    // stall forever. Give it a few seconds, then fall back to the
    // textarea path instead of waiting on it. The fallback is
    // best-effort: it needs the click's transient activation, which the
    // timeout (and the awaits before this call) may already have spent,
    // so on the timeout path it is expected to fail — the late native
    // write may still land afterwards.
    let timeoutId;
    // This copy's sequence, taken when it was requested: the record it
    // claims, the rollback it may perform, and the repair it may
    // trigger are all identified by it, not by the text — two copies
    // of the same text are different copies.
    const mySeq = seq ?? nextClipboardSeq();
    // A caller that passed an older click-time sequence may already
    // have been overtaken: a newer copy claimed the record while this
    // click was awaiting, so writing now would put the older click's
    // text on the clipboard last. Bail out silently — the newer copy
    // reports itself — without claiming the record or touching the
    // clipboard.
    if (latestCopiedSeq > mySeq) return false;
    // What was newest before this call: a failed copy rolls the record
    // back to it, but only if this call still owns the record (see the
    // rollback below). Nothing awaits between here and the assignment,
    // so this capture is the record as of the assignment.
    let previousCopiedText = latestCopiedText;
    let previousCopiedSeq = latestCopiedSeq;
    try {
        // No permission preflight: the write itself decides — a denied
        // permission rejects at once, an undecided one may sit on the
        // prompt and land late (the repair below re-asserts the newest
        // text then). Awaiting a permission query first could only
        // delay the write past the click's transient activation (up to
        // 2 s when the query hangs), after which both the write and
        // the fallback fail.
        // The newest text any copy was asked for. A native write that
        // outlives its timeout still lands when it eventually resolves,
        // so a late landing is repaired below by re-asserting this.
        latestCopiedText = text;
        latestCopiedSeq = mySeq;
        const writePromise = navigator.clipboard.writeText(text);
        // Prevent unhandled rejection if the timeout wins the race and the
        // write rejects later.
        writePromise.catch(() => {});
        // A write cannot be cancelled once started: if it resolves after
        // a newer copy ran, it lands the stale text over the newer one.
        // That is not only the timed-out case — an external copy (or a
        // concurrent one) can finish while this write is still pending,
        // and resolving then overwrites it. Re-assert the newest text
        // instead, so the clipboard ends up holding the latest copy. The
        // repair re-checks on landing (see `reassertLatestCopy`): a
        // repair that is itself still in flight when a newer copy lands
        // re-asserts the newest text again instead of leaving its own
        // stale text behind. The rejection handler is load-bearing:
        // without it, a write that rejects leaves this derived promise
        // rejected with nobody catching it (the `.catch` above only
        // covers the original promise), and Vitest fails the run on the
        // unhandled rejection. The repair only applies to writes that
        // resolve; a rejected write landed nothing, so there is nothing
        // to re-assert.
        writePromise.then(
            () => {
                // This write landed: while it still owns the record it
                // is the newest thing on the clipboard. A late landing
                // (after a newer copy claimed the record) still counts
                // when it is newer than the last recorded landing: this
                // text is now on the clipboard, so it is the newest
                // landing even though a newer claim is pending — without
                // this, the repair below reverts to the older landing
                // and the newest actually-landed text is lost. Only a
                // landing older than the recorded one leaves the record
                // alone, and the repair then re-asserts the newer text.
                if (mySeq === latestCopiedSeq || mySeq > latestLandedSeq) {
                    // A late landing after this copy's rollback: the
                    // claim was rolled back to an older text, but this
                    // text is now on the clipboard — restore the claim
                    // too, or an older reserved sequence would later be
                    // accepted as newer than this landing.
                    if (mySeq > latestCopiedSeq) {
                        latestCopiedText = text;
                        latestCopiedSeq = mySeq;
                    }
                    latestLandedText = text;
                    latestLandedSeq = mySeq;
                }
                // A newer copy claimed the record while this write was
                // pending: re-assert the newest text that actually
                // landed, not the newest claim — the claim may not
                // have landed yet (see `reassertNewestLanded`).
                reassertNewestLanded(text);
            },
            () => {},
        );
        await Promise.race([
            writePromise,
            new Promise((_, reject) => {
                timeoutId = setTimeout(
                    () => {
                        reject(new Error('Clipboard write timed out'));
                    },
                    5000,
                );
            }),
        ]);
        // The native write resolved: this copy is the newest on the
        // clipboard only while it still owns the record — a newer copy
        // may have claimed it while the write was pending, in which
        // case the repair above already re-asserted that newer text.
        return latestCopiedSeq === mySeq;
    } catch (_) {
        // The failure reason does not change the fallback: any failure
        // takes the textarea path, and the caller reports it if that
        // fails too — so the error value itself is unused here.
        // A newer copy has already landed: this stale text must not
        // overwrite it — the fallback would only be repaired away
        // again, and a rejected repair would leave the stale text on
        // the clipboard. Report superseded; the newer copy reports
        // itself.
        if (mySeq < latestLandedSeq) return false;
        try {
            // Fallback for environments without clipboard API
            const textarea = document.createElement('textarea');
            textarea.value = text;
            textarea.style.position = 'fixed';
            textarea.style.opacity = '0';
            document.body.appendChild(textarea);
            // select() moves focus onto the textarea, so remember where
            // it was: once the temporary element is removed, focus would
            // otherwise be lost (the clicked button would no longer be
            // focused).
            const previouslyFocused = document.activeElement;
            textarea.select();
            try {
                // execCommand returns false instead of throwing when the
                // command is not enabled (no user activation, e.g. after the
                // 5 s timeout above let the click's transient activation
                // expire). Ignoring it would report a copy that never
                // happened, so fail loudly and let the caller show the error.
                if (!document.execCommand('copy')) {
                    throw new Error('Copy command was not enabled');
                }
                // The fallback copy succeeded: it is the newest text now, so
                // record it like a native write — otherwise a late landing
                // of an earlier timed-out write would not be repaired (its
                // guard compares against this value). Only a successful
                // fallback records: a failed one must not become the text a
                // later repair re-asserts. And only while this copy still
                // owns the record: a newer copy may have claimed it while
                // this write was pending, and re-recording then would put
                // this older text back as the repair target.
                if (mySeq >= latestCopiedSeq) {
                    latestCopiedText = text;
                    latestCopiedSeq = mySeq;
                    latestLandedText = text;
                    latestLandedSeq = mySeq;
                    return true;
                }
                // A newer copy claimed the record while this write was
                // pending, so the fallback just overwrote its text on
                // the clipboard. That text is still the newest landing
                // when nothing newer landed yet: record it, or the
                // repair below reverts to the older landing. Report
                // this copy as superseded so the caller does not show
                // "Copied" for text that is no longer there.
                if (mySeq > latestLandedSeq) {
                    latestLandedText = text;
                    latestLandedSeq = mySeq;
                }
                reassertNewestLanded(text);
                return false;
            } finally {
                document.body.removeChild(textarea);
                if (previouslyFocused instanceof HTMLElement) {
                    previouslyFocused.focus();
                }
            }
        } catch (fallbackError) {
            // Both the native write and the fallback failed, so this
            // copy landed nothing: roll the record back to what it was
            // before this call, so a late landing of an earlier write
            // does not re-assert this failed text over a newer copy.
            // Record the failure first: a later overlapping copy's
            // rollback must not resurrect this claim (see below).
            failedClipboardSeqs.add(mySeq);
            // Only roll back a record this call still owns: a newer
            // copy may have claimed it since — of the same text, even
            // — and the text alone cannot tell them apart. And only as
            // far as the newest landing: a copy that landed while this
            // one was pending (an external write, for example) is newer
            // than the pre-call snapshot, and rolling past it would
            // lose it from the record entirely.
            if (latestCopiedSeq === mySeq) {
                if (latestLandedSeq > previousCopiedSeq) {
                    latestCopiedText = latestLandedText;
                    latestCopiedSeq = latestLandedSeq;
                } else if (failedClipboardSeqs.has(previousCopiedSeq)) {
                    // The record this rollback would restore to is
                    // itself a failed copy: it never landed, so keep
                    // the newest landing as the claim instead of
                    // resurrecting the failed text.
                    latestCopiedText = latestLandedText;
                    latestCopiedSeq = latestLandedSeq;
                } else {
                    latestCopiedText = previousCopiedText;
                    latestCopiedSeq = previousCopiedSeq;
                }
            }
            throw fallbackError;
        }
    } finally {
        clearTimeout(timeoutId);
    }
}
