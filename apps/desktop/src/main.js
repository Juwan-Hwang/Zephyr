// @ts-check
// ═══════════════════════════════════════════════════════════════════════════════
//  main.js — Application Entry Point
// ═══════════════════════════════════════════════════════════════════════════════
//  Orchestrates initialization of all subsystems in the correct order.
//  All imports are from dedicated sub-modules — no legacy ui.js dependency.
// ═══════════════════════════════════════════════════════════════════════════════

// Polyfill: Element.replaceChildren() for older WebViews (pre-Safari 14 / macOS 10.15)
//
// Design note (ES5 compatibility):
//
// This polyfill deliberately uses `var`, index-based `for` loops, and
// `this.removeChild(this.firstChild)` instead of `let`/`const`, `for...of`, and
// `Node.remove()`.  The polyfill exists precisely because the target WebView
// lacks `replaceChildren()` — such old engines may also lack ES6 features
// (`Symbol.iterator` for `for...of`) and DOM4 (`Node.remove()`).
//
// SonarCloud may flag `var` and the `for` loop as style violations.  Do NOT
// "fix" them to `let`/`for...of` — that would break the polyfill on the very
// old WebViews it was created for.
if (typeof Element.prototype.replaceChildren !== 'function') {
    Element.prototype.replaceChildren = function (/* ...nodes */) {
        while (this.firstChild) this.removeChild(this.firstChild);
        for (var i = 0; i < arguments.length; i++) {
            var arg = arguments[i];
            if (arg == null) continue;
            if (typeof arg === 'string' || typeof arg === 'number' || typeof arg === 'boolean') {
                this.appendChild(document.createTextNode(String(arg)));
            } else {
                this.appendChild(arg);
            }
        }
    };
}

import {
  invoke,
  listen,
  setBaseUrl,
  setSecret,
  setCoreReachable,
} from './api.js';
import {
  setBaseUrl as setWsBaseUrl,
  setSecret as setWsSecret,
  connectTraffic,
} from './websocket.js';
import {
  translations,
  applyTranslations,
} from './i18n.js';
import { initChart, updateTrafficData, cleanupChart } from './modules/traffic-chart.js';
import { initConnectionsPage } from './modules/connections.js';
import { initBackendEventListeners, cleanupBackendEventListeners } from './modules/backend-events.js';
import { apiLogger } from './utils/logger.js';
import { forwardToBackend } from './utils/frontend-log.js';
import { registerCleanup, runCleanup } from './utils/cleanup-registry.js';
import { COMMANDS } from '@zephyr/shared';
import * as prism from './ui/prism.js';

// --- UI module imports ---
import { showNotification } from './ui/notifications.js';
import { initSettings, initUwpExemption } from './ui/settings.js';
import { autoApplyIfNeeded } from './ui/network-optim.js';
import { initNavigation, switchPage, navigateTo } from './ui/navigation.js';
import { initProxyControls, syncCoreConfig, renderProxies } from './ui/proxies.js';
import { initPlugins } from './ui/plugins.js';
import { initModeSelector } from './ui/modes.js';
import { initConsoleHome, activateConsole, deactivateConsole } from './ui/console-home.js';
import { initTunToggle } from './ui/tun.js';
import { initDnsRewriteToggle } from './ui/dns.js';
import { initNodeWheel } from './ui/node-wheel.js';
import {
  initTrayEventListeners,
  startUnifiedSync,
  stopUnifiedSync,
  cleanupTrayEventListeners,
  updateTrayStatus,
  updateTrayMenu,
} from './ui/tray.js';
import { initProxyToggle, refreshSysProxyStatus } from './ui/sysproxy.js';
import { initWindowControls } from './ui/window-controls.js';
import { initDeepLink } from './ui/deep-link.js';
import { sendOSNotification } from './ui/os-notification.js';
import { initGlobalShortcut, registerDefaultShortcuts, initShortcutSettings } from './ui/global-shortcut.js';
import { bind } from './ui/bind.js';
import { appStore } from './ui/state.js';
import { Bus, Events } from './ui/events.js';
import { normalizeVersion, isRemoteNewer } from './utils/version-utils.js';

/** @type {any} */
const _win = /** @type {any} */ (window);

/** @type {{ close: Function, reconnect: Function, isMaxRetriesReached: Function } | null} */
let _trafficWsHandle = null;
/** @type {Function | null} */
let _configParseErrorListener = null;

/** Maximum time to wait for backend-event listener registration before
 *  degrading to console-only logging (e.g. browser dev mode where Tauri IPC
 *  is unavailable).
 */
const BACKEND_LISTENER_TIMEOUT_MS = 3000;

/**
 * Promise that resolves when backend event listeners are registered.
 *
 * Started at **module load time** (before `error`/`unhandledrejection` handlers
 * are installed) so that early bootstrap failures can still be forwarded to
 * the backend. `initApp()` awaits this promise to ensure registration is
 * complete before the first `apiLogger.info()` call.
 *
 * A `BACKEND_LISTENER_TIMEOUT_MS` timeout prevents a stalled IPC call from
 * blocking startup.
 */
const _backendListenersReady = _initBackendListenersWithTimeout();

/**
 * Register backend event listeners with a timeout.
 * If the timeout fires, startup proceeds with console-only logging.
 * @returns {Promise<void>}
 */
async function _initBackendListenersWithTimeout() {
  let timeoutId;
  try {
    const registration = initBackendEventListeners();
    // Prevent unhandled rejection if the timeout wins the race and the
    // listener registration rejects later (e.g. Tauri IPC failing slowly).
    registration.catch(() => {});
    await Promise.race([
      registration,
      new Promise((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error('backend-event listener registration timed out')),
          BACKEND_LISTENER_TIMEOUT_MS,
        );
      }),
    ]);
  } catch (err) {
    // Tauri IPC unavailable or slow (e.g. browser dev mode) — degrade to
    // console-only logging. apiLogger.warn prints to console.warn regardless.
    // We can't use apiLogger here because it might not be ready yet.
    // eslint-disable-next-line no-console
    console.warn('[Zephyr] Failed to init backend event listeners', err);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

// ═══════════════════════════════════════════════════════════════════
//  initReactiveBindings — Centralized Bus -> store -> DOM wiring
// ═══════════════════════════════════════════════════════════════════

/**
 * Wire Bus events to appStore and bind DOM elements reactively.
 * Called once during initApp after all UI modules are initialized.
 */
function initReactiveBindings() {
  // --- SysProxy toggle checkbox ---
  const sysProxyToggle = document.getElementById('sys-proxy-toggle');
  if (sysProxyToggle) {
    bind(appStore, sysProxyToggle, 'isSysProxyEnabled', 'checked');
  }

  // --- TUN toggle checkbox ---
  const tunToggle = document.getElementById('tun-proxy-toggle');
  if (tunToggle) {
    bind(appStore, tunToggle, 'isTunEnabled', 'checked');
  }

  // --- Tray auto-update on state changes ---
  appStore.subscribe('isSysProxyEnabled', () => { updateTrayStatus().catch(() => {}); updateTrayMenu().catch(() => {}); });
  appStore.subscribe('isTunEnabled', () => { updateTrayStatus().catch(() => {}); updateTrayMenu().catch(() => {}); });
  appStore.subscribe('currentOutboundMode', () => updateTrayMenu(true).catch(() => {}));

  // --- Bus event -> store wiring (for events from settings.js, i18n.js) ---
  Bus.on(Events.MODE_CHANGED, /** @param {string} mode */ (mode) => {
    appStore.set('currentOutboundMode', mode);
  });

  Bus.on(Events.LANGUAGE_CHANGED, /** @param {string} lang */ (lang) => {
    appStore.set('currentLang', lang);
  });

  Bus.on(Events.THEME_CHANGED, /** @param {string} theme */ (theme) => {
    appStore.set('currentTheme', theme);
  });
}

// ═══════════════════════════════════════════════════════════════════
//  Helper: Start core and configure API endpoints
// ═══════════════════════════════════════════════════════════════════

/**
 * Start the mihomo core, apply early UI settings, and configure API endpoints.
 * Returns true on success, false on failure (error already shown to user).
 * @returns {Promise<boolean>}
 */
async function startCoreAndConfigure() {
  /** @type {string|null} */
  let secret = null;
  try {
    const tGetSettings = performance.now();
    const settings = await invoke(COMMANDS.GET_SETTINGS);
    apiLogger.info(`[Zephyr] get_settings: +${(performance.now() - tGetSettings).toFixed(0)}ms`);

    // Apply saved UI scale early (before UI renders)
    if (settings.ui_scale && settings.ui_scale > 0 && settings.ui_scale !== 1) {
      document.documentElement.style.setProperty('--ui-scale', String(settings.ui_scale));
    }

    // Set home page mode and apply initial page visibility BEFORE any UI renders.
    // This prevents the flash of the minimal home page when console mode is enabled.
    const homePageMode = settings.home_page_mode || 'minimal';
    appStore.set('homePageMode', homePageMode);
    if (homePageMode === 'console') {
      // Use switchPage() to toggle page + glow visibility consistently
      switchPage('console');
      // Initialize console DOM early so content exists before rendering.
      // activateConsole() is called later in step 8b after the core is started.
      try { initConsoleHome(); } catch (err) { apiLogger.warn('Early console init failed', err); }
    }

    const tStartCore = performance.now();
    const configPath = settings.last_config || 'config.yaml';
    const customArgs = settings.custom_args || [];
    apiLogger.info(`[Zephyr] calling start_core (config=${configPath})`);
    const coreResult = await invoke(COMMANDS.START_CORE, {
      configPath,
      test: false,
      customArgs,
      secret: null,
    });
    apiLogger.info(`[Zephyr] start_core: +${(performance.now() - tStartCore).toFixed(0)}ms`);

    // If start_core silently fell back (requested config doesn't exist),
    // correct last_config to the actually loaded file.
    if (coreResult.active_config && coreResult.active_config !== configPath) {
      apiLogger.info(`[Zephyr] config fallback detected: requested "${configPath}" but loaded "${coreResult.active_config}", updating last_config`);
      try {
        await invoke(COMMANDS.UPDATE_LAST_CONFIG, { configName: coreResult.active_config });
      } catch (e) {
        apiLogger.warn(`[Zephyr] failed to update last_config after fallback: ${e}`);
      }
    }

    secret = coreResult.secret;
    const port = coreResult.port;

    setBaseUrl(`http://127.0.0.1:${port}`);
    setWsBaseUrl(`ws://127.0.0.1:${port}`);
    setSecret(secret || '');
    setWsSecret(secret || '');
    setCoreReachable(true);

    // 5b. Initialize Prism engine — compile patches and populate rule annotations.
    const tPrism = performance.now();
    prism.apply().then((applyResult) => {
        const elapsed = (performance.now() - tPrism).toFixed(0);
        const stats = applyResult?.stats;
        const annotationCount = applyResult?.rule_annotations?.length ?? 0;
        apiLogger.info(
            `[Zephyr] prism.apply: +${elapsed}ms | patches=${stats?.succeeded ?? '?'}/${stats?.total ?? '?'} | annotations=${annotationCount}`
        );
        if (annotationCount === 0 && (stats?.total ?? 0) > 0) {
            apiLogger.warn(
                '[Zephyr] prism.apply succeeded but produced 0 rule annotations.',
                'Check that .prism.yaml files use $prepend/$append DSL syntax.',
            );
        }
    }).catch((err) => {
        apiLogger.warn('[Zephyr] prism.apply failed (non-fatal, rules page may be empty):', err);
    });

    // 5c. Apply all enabled overrides (JS + Prism YAML).
    invoke(COMMANDS.OVERRIDE.APPLY_ALL).then((logs) => {
        const successCount = logs?.filter((/** @type {{success: boolean}} */ l) => l.success).length ?? 0;
        const failCount = logs?.filter((/** @type {{success: boolean}} */ l) => !l.success).length ?? 0;
        if (logs && logs.length > 0) {
            apiLogger.info(`[Zephyr] override_apply_all: ${successCount} succeeded, ${failCount} failed (${logs.length} total)`);
        }
    }).catch((err) => {
        apiLogger.warn('[Zephyr] override_apply_all failed (non-fatal):', err);
    });
  } catch (err) {
    const message = err?.toString?.() || 'Core start failed';
    apiLogger.error('Failed to start core', err);
    sendOSNotification('Zephyr', message).catch(() => {});
    alert(message);
    return false;
  }
  return true;
}

// ═══════════════════════════════════════════════════════════════════
//  Helper: Auto-check for updates on startup
// ═══════════════════════════════════════════════════════════════════

/**
 * Check for core and client updates after a short delay.
 * Non-blocking — all errors are caught and logged.
 */
// Version comparison utilities (normalizeVersion, isRemoteNewer) are now
// imported from ./utils/version-utils.js — shared with settings.js.

/** Check if a core update is available. @returns {Promise<boolean>} */
async function hasCoreUpdate() {
  try {
    const [latest, currentVersion] = await Promise.all([
      invoke(COMMANDS.GET_LATEST_VERSION),
      invoke(COMMANDS.GET_CORE_VERSION),
    ]);
    const remoteVer = normalizeVersion(latest.version);
    const localVer = normalizeVersion(currentVersion);
    if (!remoteVer || !localVer) return false;
    return isRemoteNewer(remoteVer, localVer);
  } catch (e) {
    apiLogger.warn('Auto core update check failed', e);
    return false;
  }
}

/** Check if a client update is available. @returns {Promise<boolean>} */
async function hasClientUpdate() {
  try {
    if (await invoke(COMMANDS.GET_PORTABLE_MODE)) return false;
    const [info, currentVersion] = await Promise.all([
      invoke(COMMANDS.GET_LATEST_CLIENT_VERSION),
      invoke(COMMANDS.GET_APP_VERSION),
    ]);
    const remoteVer = normalizeVersion(info.version);
    const localVer = normalizeVersion(currentVersion);
    if (!remoteVer || !localVer) return false;
    return isRemoteNewer(remoteVer, localVer);
  } catch (e) {
    apiLogger.warn('Auto client update check failed', e);
    return false;
  }
}

function scheduleAutoUpdateCheck() {
  const timer = setTimeout(async () => {
    try {
      const settings = await invoke(COMMANDS.GET_SETTINGS);
      const lang = localStorage.getItem('lang') || 'en';
      /** @type {Record<string, string>} */
      const t = /** @type {Record<string, string>} */ (
        /** @type {any} */ (translations)[lang] || /** @type {any} */ (translations).en
      );

      const coreHasUpdate = settings.auto_update ? await hasCoreUpdate() : false;
      const clientHasUpdate = settings.auto_update_client ? await hasClientUpdate() : false;

      // Notify the user about available updates
      if (coreHasUpdate && clientHasUpdate) {
        showNotification(
          t.bothUpdateAvailable || 'Both core and client have updates',
          'warning',
          t.recommendFullVersion || 'Recommend installing Full version'
        );
      } else if (coreHasUpdate) {
        showNotification(
          t.coreUpdateAvailable || 'Core update available',
          'warning'
        );
      } else if (clientHasUpdate) {
        showNotification(
          t.clientUpdateAvailable || 'Update Available',
          'warning'
        );
      }
    } catch (e) {
      apiLogger.warn('Auto update check failed', e);
    }
  }, 5000);
  registerCleanup(() => clearTimeout(timer));
}

// ═══════════════════════════════════════════════════════════════════
//  initApp — Main initialization sequence
// ═══════════════════════════════════════════════════════════════════

async function initApp() {
  const t0 = performance.now();

  // 0. Await backend event listeners (started at module load time).
  //
  // The listener registration was kicked off at the top of this module —
  // before `error`/`unhandledrejection` handlers were installed — so that
  // early bootstrap failures can be forwarded to the backend. Here we just
  // wait for it to complete (with a 3 s timeout built in).
  await _backendListenersReady;
  registerCleanup(cleanupBackendEventListeners);

  apiLogger.info(`[Zephyr] initApp started at ${new Date().toLocaleTimeString()}`);

  // 0a. Reset transient locks that may have been persisted to localStorage
  // by a prior session that crashed or was refreshed mid-operation.
  // While the transientKeys array in state.js prevents future persistence,
  // we also reset here to clean up any stale values from older builds.
  appStore.set('isNetworkUpdating', false);
  appStore.set('isTestingLatency', false);

  // 1. Disable context menu globally (except on draggable titlebar)
  document.addEventListener('contextmenu', (e) => {
    const target = /** @type {Element} */ (e.target);
    if (
      target.hasAttribute('data-tauri-drag-region') ||
      target.closest('[data-tauri-drag-region]')
    ) {
      return;
    }
    e.preventDefault();
  });

  // 2. Apply translations
  applyTranslations();

  // 3. Initialize window controls
  initWindowControls();

  // 4. Show window (unless silent start is enabled)
  setTimeout(async () => {
    let silentStart = false;
    try {
      const settings = await invoke(COMMANDS.GET_SETTINGS);
      silentStart = settings.silent_start || false;
    } catch (e) {
      apiLogger.warn('Failed to read settings for silent_start, falling back to showing window', e);
    }
    if (!silentStart) {
      try {
        await invoke(COMMANDS.SHOW_MAIN_WINDOW);
      } catch (e) {
        apiLogger.warn('Failed to show window', e);
      }
    } else {
      apiLogger.info('[Zephyr] silent_start enabled — staying hidden in tray');
    }
  }, 50);

  // 5. Start core and configure endpoints
  if (!(await startCoreAndConfigure())) return;

  // 6. Initialize all UI modules
  const tUI = performance.now();

  initNavigation({
    onProxies: () => { renderProxies(); },
    onAdvanced: () => { import('./ui/advanced.js').then(m => m.renderAdvancedSettings?.()).catch(() => {}); },
    onHome: () => { refreshSysProxyStatus().catch(() => {}); },
    onConsole: () => { activateConsole(); refreshSysProxyStatus().catch(() => {}); },
    onLeaveConsole: () => { deactivateConsole(); },
    onRuleLibrary: () => { import('./ui/rule-library.js').then(m => m.initRuleLibraryPage()).catch(() => {}); },
    onConnections: () => { initConnectionsPage(); },
    onLogs: () => { import('./ui/logs.js').then(m => m.initLogsPage()).catch(() => {}); },
    onLeaveLogs: () => { import('./ui/logs.js').then(m => m.destroyLogsPage()).catch(() => {}); },
    onLeaveProxies: () => {
        import('./ui/observed-group.js').then(m => m.stopObservedGroupWatcher()).catch(() => {});
        import('./ui/proxies.js').then(m => { if (m.stopProviderPoll) m.stopProviderPoll(); }).catch(() => {});
    },
  });
  initChart();
  initTrayEventListeners();
  await initProxyToggle();
  initDnsRewriteToggle();
  initModeSelector();
  initTunToggle();
  initProxyControls();
  initPlugins();
  await initSettings();
  initUwpExemption();
  autoApplyIfNeeded().catch(() => {}); // Non-blocking: avoid freezing UI on admin password prompt
  initNodeWheel();
  initShortcutSettings();

  // 6b. Initialize reactive bindings (Bus -> store -> DOM)
  initReactiveBindings();

  // 7b. Initialize deep link and global shortcut listeners
  initDeepLink().then((unlisten) => {
    registerCleanup(() => { unlisten(); });
  }).catch((err) => {
    apiLogger.warn('Failed to init deep link listener', err);
  });

  initGlobalShortcut().then((unlisten) => {
    registerCleanup(() => { unlisten(); });
  }).catch((err) => {
    apiLogger.warn('Failed to init global shortcut listener', err);
  });

  registerDefaultShortcuts().catch((err) => {
    apiLogger.warn('Failed to register default shortcuts', err);
  });

  // 7c. Network online & state change listener
  const onOnline = () => {
    Promise.resolve()
      .then(() => invoke(COMMANDS.NOTIFY_NETWORK_CHANGE, { source: 'browser_online' }))
      .catch(() => {});
  };
  const onOffline = () => {
    Promise.resolve()
      .then(() => invoke(COMMANDS.NOTIFY_NETWORK_CHANGE, { source: 'browser_offline' }))
      .catch(() => {});
  };
  window.addEventListener('online', onOnline);
  window.addEventListener('offline', onOffline);
  registerCleanup(() => {
    window.removeEventListener('online', onOnline);
    window.removeEventListener('offline', onOffline);
  });
  listen('network-state-changed', (event) => {
    const payload = event?.payload;
    apiLogger.info(
      `[Zephyr] Network state changed: reason=${payload?.reason} ` +
      `type=${payload?.new_state?.interface_type} connected=${payload?.new_state?.is_connected}`
    );
  }).then((unlisten) => {
    registerCleanup(() => { unlisten(); });
  }).catch((err) => {
    apiLogger.warn('Failed to init network state change listener', err);
  });

  apiLogger.info(`[Zephyr] UI modules: +${(performance.now() - tUI).toFixed(0)}ms`);

  // 7. Check encryption key persistence
  try {
    const keyPersisted = await invoke(COMMANDS.IS_MACHINE_KEY_PERSISTED);
    if (!keyPersisted) {
      apiLogger.error('Machine key not persisted — encrypted data will be lost on restart');
      const lang = localStorage.getItem('lang') || 'en';
      /** @type {Record<string, string>} */
      const t = /** @type {Record<string, string>} */ (/** @type {any} */ (translations)[lang]);
      showNotification(
        `${t.keyNotPersistedTitle || 'Encryption Key Warning'}: ${t.keyNotPersistedMessage || 'The encryption key could not be persisted. Subscription URLs and other sensitive data will be lost after restart.'}`,
        'error'
      );
    }
  } catch (err) {
    apiLogger.error('Failed to check machine key status', err);
  }

  // 8. Initial config sync and tray (parallel — no dependencies)
  try {
    await Promise.all([syncCoreConfig(), updateTrayStatus(), updateTrayMenu()]);
    startUnifiedSync();
  } catch (err) {
    apiLogger.warn('Initial sync failed', err);
  }

  // 8b. Activate console home page (if enabled and still visible)
  try {
    if (appStore.get('homePageMode') === 'console') {
      const consolePage = document.querySelector('[data-page="console"]');
      const isConsoleVisible = consolePage && !consolePage.classList.contains('hidden');
      // Only activate if the console page is still visible - the user may
      // have navigated to another page during the async startup steps.
      // activateConsole() calls initConsoleHome() internally and renders
      // the failure UI if initialization throws.
      if (isConsoleVisible) {
        activateConsole();
      }
    }
  } catch (err) {
    apiLogger.warn('Failed to init console home', err);
  }

  // 8c. Auto-check for updates on startup if enabled
  scheduleAutoUpdateCheck();

  // 9. Traffic WebSocket
  _trafficWsHandle = connectTraffic((/** @type {any} */ data) => {
    // Skip the minimal-home traffic pipeline when console mode is active -
    // the console dashboard subscribes to TRAFFIC_UPDATE directly.
    if (appStore.get('homePageMode') !== 'console') {
      updateTrafficData(data);
    }
    Bus.emit(Events.TRAFFIC_UPDATE, data);
  });

  // 9b. Reconnect traffic stream when core restarts
  const _unsubCoreRestarted = Bus.on(Events.CORE_RESTARTED, (/** @type {{ handle?: any }} */ { handle } = {}) => {
    // If forceReconnect() returned a new handle (fallback path), adopt it.
    if (handle) {
      // Close the existing handle first to prevent resource leaks,
      // unless both references point to the same object.
      if (_trafficWsHandle && _trafficWsHandle !== handle) {
        _trafficWsHandle.close();
      }
      _trafficWsHandle = handle;
    } else if (_trafficWsHandle) {
      _trafficWsHandle.reconnect();
    }
  });

  // 10b. Apply home page mode changes immediately when the user toggles
  //      the setting, so the visible page switches without requiring a
  //      manual navigation away and back.
  const _unsubHomePageMode = Bus.on(Events.HOME_PAGE_MODE_CHANGED, (/** @type {{ mode?: string, previous?: string }} */ { mode } = {}) => {
    if (!mode) return;
    // Update the store first so navigateToInternal() sees the new mode
    // and does not short-circuit on stale state.
    appStore.set('homePageMode', mode);
    // Only switch if the home or console page is currently visible.
    const homePage = document.querySelector('[data-page="home"]');
    const consolePage = document.querySelector('[data-page="console"]');
    const isHomeVisible = homePage && !homePage.classList.contains('hidden');
    const isConsoleVisible = consolePage && !consolePage.classList.contains('hidden');
    if (!isHomeVisible && !isConsoleVisible) return;

    if (mode === 'console') {
      navigateTo('console');
    } else {
      navigateTo('home');
    }
  });

  // 11. Cleanup handlers
  registerCleanup(() => {
    if (_configParseErrorListener) {
      _configParseErrorListener();
      _configParseErrorListener = null;
    }
  });
  registerCleanup(() => {
    _unsubCoreRestarted();
  });
  registerCleanup(() => {
    _unsubHomePageMode();
  });
  registerCleanup(() => {
    if (_trafficWsHandle) {
      _trafficWsHandle.close();
    }
  });
  registerCleanup(() => { cleanupChart(); });
  registerCleanup(() => { stopUnifiedSync(); });
  registerCleanup(cleanupTrayEventListeners);

  window.addEventListener('beforeunload', () => runCleanup());

  // 10. Heartbeat — let the backend know the webview is alive (Layer 2).
  // If this stops arriving (e.g. `WebView2` crash not caught by Layer 1),
  // the backend will recreate the window on the next show attempt.
  //
  // The heartbeat runs unconditionally — even when the window is hidden —
  // because a single `invoke` call every 15 s is negligible overhead,
  // and keeping it running simplifies the logic (no pause/resume events
  // needed, which Tauri does not emit natively for hide/show).
  const HEARTBEAT_INTERVAL_MS = 15_000;
  const sendHeartbeat = () => invoke(COMMANDS.HEARTBEAT).catch(() => {});
  sendHeartbeat();
  const _heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
  // Send an immediate heartbeat when the window gains focus. This ensures
  // that after showing a previously hidden window, the backend receives a
  // fresh heartbeat right away instead of waiting up to 15s.
  window.addEventListener('focus', sendHeartbeat);
  registerCleanup(() => {
    clearInterval(_heartbeatTimer);
    window.removeEventListener('focus', sendHeartbeat);
  });

  apiLogger.info(`[Zephyr] ✅ App ready! Total: ${(performance.now() - t0).toFixed(0)}ms`);
}

// ═══════════════════════════════════════════════════════════════════
//  Bootstrap
// ═══════════════════════════════════════════════════════════════════

// Global error handlers — catch uncaught exceptions and unhandled
// Promise rejections that would otherwise silently vanish from the
// app log. These run AFTER _backendListenersReady is started (above)
// so that forwarded logs have a listener ready to receive them.
window.addEventListener('error', (event) => {
    const { error: err, message, filename, lineno, colno } = event;
    const detail = err instanceof Error
        ? `${err.name}: ${err.message}\n${err.stack || ''}`
        : `${message} at ${filename}:${lineno}:${colno}`;
    forwardToBackend('error', 'uncaught', `[Uncaught] ${detail}`);
});

window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    const detail = reason instanceof Error
        ? `${reason.name}: ${reason.message}\n${reason.stack || ''}`
        : String(reason);
    forwardToBackend('error', 'rejection', `[Unhandled Rejection] ${detail}`);
});

window.addEventListener('DOMContentLoaded', () => {
  initApp().catch((err) => {
    apiLogger.error('Fatal: initApp threw an unhandled error', err);
  });
});
