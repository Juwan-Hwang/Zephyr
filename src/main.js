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
  listen,
} from './api.js';
import {
  setBaseUrl as setWsBaseUrl,
  setSecret as setWsSecret,
  connectTraffic,
} from './websocket.js';
import {
  translations,
  currentLang,
  applyTranslations,
} from './i18n.js';
import { escapeHtml } from './utils/sanitize.js';
import { initChart, updateTrafficData, cleanupChart } from './modules/traffic-chart.js';
import { initConnectionsPage, destroyConnectionsPage } from './modules/connections.js';
import { apiLogger } from './utils/logger.js';
import { registerCleanup, runCleanup } from './utils/cleanup-registry.js';

// --- UI module imports ---
import { showNotification } from './ui/notifications.js';
import { initSettings, initUwpExemption } from './ui/settings.js';
import { initNavigation } from './ui/navigation.js';
import { initProxyControls, syncCoreConfig, renderProxies } from './ui/proxies.js';
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

/** @type {any} */
const _win = /** @type {any} */ (window);

// ═══════════════════════════════════════════════════════════════════
//  initApp — Main initialization sequence
// ═══════════════════════════════════════════════════════════════════

async function initApp() {
  const t0 = performance.now();
  console.log(`[Zephyr] initApp started at ${new Date().toLocaleTimeString()}`);

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
      await invoke('show_main_window');
    } catch (e) {
      apiLogger.warn('Failed to show window', e);
    }
  }, 50);

  // 5. Start core and configure endpoints
  /** @type {string|null} */
  let secret = null;
  try {
    const tGetSettings = performance.now();
    const settings = await invoke('get_settings');
    console.log(`[Zephyr] get_settings: +${(performance.now() - tGetSettings).toFixed(0)}ms`);

    const tStartCore = performance.now();
    const configPath = settings.last_config || 'config.yaml';
    const customArgs = settings.custom_args || [];
    const coreResult = await invoke('start_core', {
      configPath,
      test: false,
      customArgs,
      secret: null,
    });
    console.log(`[Zephyr] start_core: +${(performance.now() - tStartCore).toFixed(0)}ms`);

    secret = coreResult.secret;
    const port = coreResult.port;

    setBaseUrl(`http://127.0.0.1:${port}`);
    setWsBaseUrl(`ws://127.0.0.1:${port}`);
    setSecret(secret || '');
    setWsSecret(secret || '');
  } catch (err) {
    const message = err?.toString?.() || 'Core start failed';
    apiLogger.error('Failed to start core', err);
    alert(message);
    return;
  }

  // 6. Initialize all UI modules
  const tUI = performance.now();

  initNavigation({
    onProxies: () => { renderProxies(); },
    onAdvanced: () => { import('./ui/advanced.js').then(m => m.renderAdvancedSettings?.()).catch(() => {}); },
    onHome: () => { updateSysProxyUI(); },
    onRules: () => { import('./ui/rules.js').then(m => m.initRulesPage()).catch(() => {}); },
    onConnections: () => { initConnectionsPage(); },
    onLogs: () => { import('./ui/logs.js').then(m => m.initLogsPage()).catch(() => {}); },
    onLeaveLogs: () => { import('./ui/logs.js').then(m => m.destroyLogsPage()).catch(() => {}); },
  });
  initChart();
  initTrayEventListeners();
  await initProxyToggle();
  initDnsRewriteToggle();
  initModeSelector();
  initTunToggle();
  initProxyControls();
  initSettings();
  initUwpExemption();
  initNodeWheel();

  console.log(`[Zephyr] UI modules: +${(performance.now() - tUI).toFixed(0)}ms`);

  // 7. Check encryption key persistence
  try {
    const keyPersisted = await invoke('is_machine_key_persisted');
    if (!keyPersisted) {
      apiLogger.error('Machine key not persisted — encrypted data will be lost on restart');
      const lang = localStorage.getItem('lang') || 'en';
      /** @type {Record<string, string>} */
      const t = /** @type {Record<string, string>} */ (/** @type {any} */ (translations)[lang]);
      showNotification(
        (t.keyNotPersistedTitle || 'Encryption Key Warning') + ': ' +
        (t.keyNotPersistedMessage || 'The encryption key could not be persisted. Subscription URLs and other sensitive data will be lost after restart.'),
        'error'
      );
    }
  } catch (err) {
    apiLogger.error('Failed to check machine key status', err);
  }

  // 8. Initial config sync and tray
  try {
    await syncCoreConfig();
    await updateTrayStatus();
    await updateTrayMenu();
    startUnifiedSync();
  } catch (err) {
    apiLogger.warn('Initial syncCoreConfig failed', err);
  }

  // 9. Config parse error listener
  if (!_win._configParseErrorListener) {
    listen('config-parse-error', (event) => {
      /** @type {Record<string, string>} */
      const t = /** @type {Record<string, string>} */ (/** @type {any} */ (translations)[currentLang] || /** @type {any} */ (translations).en);
      showNotification(
        t.configParseErrorMsg || 'Configuration file could not be parsed. Using empty config.',
        'warning',
        t.configParseErrorTitle || 'Configuration Parse Error'
      );
      apiLogger.error('[Config]', event.payload);
    }).then((unlisten) => {
      _win._configParseErrorListener = unlisten;
    });
  }

  // 10. Traffic WebSocket
  _win._trafficWsHandle = connectTraffic((/** @type {any} */ data) => {
    updateTrafficData(data);
  });

  // 11. Cleanup handlers
  registerCleanup(() => {
    if (_win._configParseErrorListener) {
      _win._configParseErrorListener();
      _win._configParseErrorListener = null;
    }
  });
  registerCleanup(() => {
    if (_win._trafficWsHandle) {
      _win._trafficWsHandle.close();
    }
  });
  registerCleanup(() => { cleanupChart(); });
  registerCleanup(() => { stopUnifiedSync(); });
  registerCleanup(() => { cleanupTrayEventListeners(); });

  window.addEventListener('beforeunload', () => runCleanup());

  console.log(`[Zephyr] ✅ App ready! Total: ${(performance.now() - t0).toFixed(0)}ms`);
}

// ═══════════════════════════════════════════════════════════════════
//  Bootstrap
// ═══════════════════════════════════════════════════════════════════

window.addEventListener('DOMContentLoaded', () => {
  initApp().catch((err) => {
    apiLogger.error('Fatal: initApp threw an unhandled error', err);
  });
});
