import { setSecret, setBaseUrl, reloadConfig } from './api.js';
import { setWsSecret, connectTraffic, setWsBaseUrl } from './websocket.js';
import { 
  initChart, updateTrafficData, initNavigation, 
  initProxyToggle, initProxyControls, initSettings, 
  initWindowControls, applyTranslations, initModeSelector, initTunToggle,
  syncCoreConfig, initUwpExemption, initDnsRewriteToggle, initNodeWheel, updateTrayStatus,
  startUnifiedSync, initTrayEventListeners, updateTrayMenu, cleanupTrayEventListeners, stopUnifiedSync,
  showNotification
} from './ui.js';
import { cleanupChart } from './modules/traffic-chart.js';
import { translations } from './i18n.js';

const { invoke } = window.__TAURI__.core;

/**
 * Initialize UI and bind data
 */
async function initApp() {
  // Disable context menu globally except for draggable region
  document.addEventListener('contextmenu', (e) => {
    // Only allow context menu on the titlebar area
    if (e.target.hasAttribute('data-tauri-drag-region') || e.target.closest('[data-tauri-drag-region]')) {
      // Do nothing, allow default right click (which can open devtools if enabled)
      return;
    }
    e.preventDefault();
  });

  applyTranslations();
  initWindowControls();

  setTimeout(async () => {
    try {
      await invoke('show_main_window');
    } catch (e) {
      console.warn("Failed to show window", e);
    }
  }, 50);

  let secret = null;
  try {
    const settings = await invoke('get_settings');
    const configPath = settings.last_config || 'config.yaml';
    const customArgs = settings.custom_args || [];
    const coreResult = await invoke('start_core', { 
      configPath, 
      test: false,
      customArgs,
      secret: null 
    });
    secret = coreResult.secret;
    const port = coreResult.port;
    setBaseUrl(`http://127.0.0.1:${port}`);
    setWsBaseUrl(`ws://127.0.0.1:${port}`);
    setSecret(secret);
    setWsSecret(secret);
  } catch (err) {
    const message = err?.toString?.() || 'Core start failed';
    console.error('[App] Failed to start core:', err);
    alert(message);
    return;
  }

  initNavigation();
  initChart();
  initTrayEventListeners(); // Initialize tray event listeners
  await initProxyToggle();
  initDnsRewriteToggle();
  initModeSelector();
  initTunToggle();
  initProxyControls();
  initSettings();
  initUwpExemption();
  initNodeWheel();

  // Check if encryption key is properly persisted
  try {
    const keyPersisted = await window.__TAURI__.core.invoke('is_machine_key_persisted');
    if (!keyPersisted) {
      console.error('[Security] Machine key not persisted - encrypted data will be lost on restart');
      // Get current language and show notification
      const currentLang = localStorage.getItem('lang') || 'en';
      const t = translations[currentLang];
      showNotification(
        (t.keyNotPersistedTitle || 'Encryption Key Warning') + ': ' + 
        (t.keyNotPersistedMessage || 'The encryption key could not be persisted. Subscription URLs and other sensitive data will be lost after restart.'),
        'error'
      );
    }
  } catch (err) {
    console.error('Failed to check machine key status:', err);
  }

  try {
    await syncCoreConfig();
    await updateTrayStatus();
    await updateTrayMenu(); // Initialize tray menu with current state
    startUnifiedSync(); // Start unified periodic sync (replaces separate polling)
  } catch (err) {
    console.warn("Initial syncCoreConfig failed:", err);
  }

  window._trafficWsHandle = connectTraffic((data) => {
    updateTrafficData(data);
  });
  
  // Cleanup on window close/reload (for hot-reload during development)
  window.addEventListener('beforeunload', () => {
    cleanupTrayEventListeners();
    stopUnifiedSync();
    cleanupChart();
    
    // Close WebSocket connection
    if (window._trafficWsHandle) {
      window._trafficWsHandle.close();
    }
  });
}

window.addEventListener('DOMContentLoaded', () => {
  initApp();
});
