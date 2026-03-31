import { setSecret, setBaseUrl, reloadConfig } from './api.js';
import { setWsSecret, connectTraffic, setWsBaseUrl } from './websocket.js';
import { 
  initChart, updateTrafficData, initNavigation, 
  initProxyToggle, initProxyControls, initSettings, 
  initWindowControls, applyTranslations, initModeSelector, initTunToggle,
  syncCoreConfig, initUwpExemption, initDnsRewriteToggle, initNodeWheel, updateTrayStatus,
  startTraySync, initTrayEventListeners, updateTrayMenu
} from './ui.js';

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

  try {
    await syncCoreConfig();
    await updateTrayStatus();
    await updateTrayMenu(); // Initialize tray menu with current state
    startTraySync(); // Start periodic tray status synchronization
  } catch (err) {
    console.warn("Initial syncCoreConfig failed:", err);
  }

  window._trafficWsHandle = connectTraffic((data) => {
    updateTrafficData(data);
  });
}

window.addEventListener('DOMContentLoaded', () => {
  initApp();
});
