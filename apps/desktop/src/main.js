// @ts-check
// ═══════════════════════════════════════════════════════════════════════════════
//  main.js — Application Entry Point
// ═══════════════════════════════════════════════════════════════════════════════
//  Orchestrates initialization of all subsystems in the correct order.
//  All imports are from dedicated sub-modules — no legacy ui.js dependency.
// ═══════════════════════════════════════════════════════════════════════════════

import {
  invoke,
  setBaseUrl,
  setSecret,
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
import { apiLogger } from './utils/logger.js';
import { registerCleanup, runCleanup } from './utils/cleanup-registry.js';
import { COMMANDS } from '@zephyr/shared';
import * as prism from './ui/prism.js';

// --- UI module imports ---
import { showNotification } from './ui/notifications.js';
import { initSettings, initUwpExemption } from './ui/settings.js';
import { initNavigation } from './ui/navigation.js';
import { initProxyControls, syncCoreConfig, renderProxies } from './ui/proxies.js';
import { initPlugins } from './ui/plugins.js';
import { initModeSelector } from './ui/modes.js';
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
import { initProxyToggle, updateSysProxyUI } from './ui/sysproxy.js';
import { initWindowControls } from './ui/window-controls.js';
import { initDeepLink } from './ui/deep-link.js';
import { sendOSNotification } from './ui/os-notification.js';
import { initGlobalShortcut, registerDefaultShortcuts, initShortcutSettings } from './ui/global-shortcut.js';
import { bind } from './ui/bind.js';
import { appStore } from './ui/state.js';
import { Bus, Events } from './ui/events.js';

/** @type {any} */
const _win = /** @type {any} */ (window);

let _trafficWsHandle = null;
let _configParseErrorListener = null;

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
  appStore.subscribe('isSysProxyEnabled', () => updateTrayStatus().catch(() => {}));
  appStore.subscribe('isTunEnabled', () => updateTrayStatus().catch(() => {}));
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
//  initApp — Main initialization sequence
// ═══════════════════════════════════════════════════════════════════

async function initApp() {
  const t0 = performance.now();
  apiLogger.info(`[Zephyr] initApp started at ${new Date().toLocaleTimeString()}`);

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

  // 4. Show window
  setTimeout(async () => {
    try {
      await invoke(COMMANDS.SHOW_MAIN_WINDOW);
    } catch (e) {
      apiLogger.warn('Failed to show window', e);
    }
  }, 50);

  // 5. Start core and configure endpoints
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

    secret = coreResult.secret;
    const port = coreResult.port;

    setBaseUrl(`http://127.0.0.1:${port}`);
    setWsBaseUrl(`ws://127.0.0.1:${port}`);
    setSecret(secret || '');
    setWsSecret(secret || '');

    // 5b. Initialize Prism engine — compile patches and populate rule annotations.
    // mihomo already started with run_config.yaml (previous compile output), so rules
    // are already active. This apply() runs in the background to refresh annotations
    // for the "Active Rules" tab. Non-blocking: UI renders immediately.
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

        // 5c. Apply all enabled JS overrides after prism.apply completes.
        // This ensures override scripts run against the latest compiled config.
        invoke(COMMANDS.OVERRIDE.APPLY_ALL).then((logs) => {
            const successCount = logs?.filter((/** @type {{success: boolean}} */ l) => l.success).length ?? 0;
            const failCount = logs?.filter((/** @type {{success: boolean}} */ l) => !l.success).length ?? 0;
            if (logs && logs.length > 0) {
                apiLogger.info(`[Zephyr] override_apply_all: ${successCount} succeeded, ${failCount} failed (${logs.length} total)`);
            }
        }).catch((err) => {
            apiLogger.warn('[Zephyr] override_apply_all failed (non-fatal):', err);
        });
    }).catch((err) => {
        apiLogger.warn('[Zephyr] prism.apply failed (non-fatal, rules page may be empty):', err);
    });
  } catch (err) {
    const message = err?.toString?.() || 'Core start failed';
    apiLogger.error('Failed to start core', err);
    sendOSNotification('Zephyr', message).catch(() => {});
    alert(message);
    return;
  }

  // 6. Initialize all UI modules
  const tUI = performance.now();

  initNavigation({
    onProxies: () => { renderProxies(); },
    onAdvanced: () => { import('./ui/advanced.js').then(m => m.renderAdvancedSettings?.()).catch(() => {}); },
    onHome: () => { updateSysProxyUI(); },
    onRuleLibrary: () => { import('./ui/rule-library.js').then(m => m.initRuleLibraryPage()).catch(() => {}); },
    onConnections: () => { initConnectionsPage(); },
    onLogs: () => { import('./ui/logs.js').then(m => m.initLogsPage()).catch(() => {}); },
    onLeaveLogs: () => { import('./ui/logs.js').then(m => m.destroyLogsPage()).catch(() => {}); },
    onLeaveProxies: () => { import('./ui/observed-group.js').then(m => m.stopObservedGroupWatcher()).catch(() => {}); },
  });
  initChart();
  initTrayEventListeners();
  await initProxyToggle();
  initDnsRewriteToggle();
  initModeSelector();
  initTunToggle();
  initProxyControls();
  initPlugins();
  initSettings();
  initUwpExemption();
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

  // 8b. Auto-check for updates on startup if enabled
  setTimeout(async () => {
    try {
      const settings = await invoke(COMMANDS.GET_SETTINGS);
      const lang = localStorage.getItem('lang') || 'en';
      /** @type {Record<string, string>} */
      const t = /** @type {Record<string, string>} */ (/** @type {any} */ (translations)[lang]);

      let coreHasUpdate = false;
      let clientHasUpdate = false;

      // Check core update if auto_update is enabled
      if (settings.auto_update) {
        try {
          const latest = await invoke(COMMANDS.GET_LATEST_VERSION);
          const currentVersion = await invoke(COMMANDS.GET_CORE_VERSION);
          if (latest.version !== currentVersion) {
            coreHasUpdate = true;
          }
        } catch (e) {
          apiLogger.warn('Auto core update check failed', e);
        }
      }

      // Check client update if auto_update_client is enabled (skip in portable mode)
      const isPortable = await invoke('get_portable_mode');
      if (!isPortable && settings.auto_update_client) {
        try {
          const info = await invoke(COMMANDS.GET_LATEST_CLIENT_VERSION);
          const currentVersion = await invoke(COMMANDS.GET_APP_VERSION);
          if (info.version !== currentVersion) {
            clientHasUpdate = true;
          }
        } catch (e) {
          apiLogger.warn('Auto client update check failed', e);
        }
      }

      // If both have updates, show special notification recommending Full version
      if (coreHasUpdate && clientHasUpdate) {
        showNotification(
          t.bothUpdateAvailable || 'Both core and client have updates',
          'warning',
          t.recommendFullVersion || 'Recommend installing Full version'
        );
      }
    } catch (e) {
      apiLogger.warn('Auto update check failed', e);
    }
  }, 5000);

  // 9. Traffic WebSocket
  _trafficWsHandle = connectTraffic((/** @type {any} */ data) => {
    updateTrafficData(data);
  });

  // 11. Cleanup handlers
  registerCleanup(() => {
    if (_configParseErrorListener) {
      _configParseErrorListener();
      _configParseErrorListener = null;
    }
  });
  registerCleanup(() => {
    if (_trafficWsHandle) {
      _trafficWsHandle.close();
    }
  });
  registerCleanup(() => { cleanupChart(); });
  registerCleanup(() => { stopUnifiedSync(); });
  registerCleanup(() => { cleanupTrayEventListeners(); });

  window.addEventListener('beforeunload', () => runCleanup());

  apiLogger.info(`[Zephyr] ✅ App ready! Total: ${(performance.now() - t0).toFixed(0)}ms`);
}

// ═══════════════════════════════════════════════════════════════════
//  Bootstrap
// ═══════════════════════════════════════════════════════════════════

window.addEventListener('DOMContentLoaded', () => {
  initApp().catch((err) => {
    apiLogger.error('Fatal: initApp threw an unhandled error', err);
  });
});
