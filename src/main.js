import { setSecret, setBaseUrl } from './api.js';
import { setWsSecret, connectTraffic, setWsBaseUrl } from './websocket.js';
import { 
  initChart, updateTrafficData, initNavigation, 
  initProxyToggle, initProxyControls, initSettings, 
  initWindowControls, applyTranslations, initModeSelector, initTunToggle,
  syncCoreConfig, initUwpExemption, initDnsRewriteToggle, initNodeWheel, updateTrayStatus,
  initCoreLoadingOverlay, finishCoreLoadingOverlay, failCoreLoadingOverlay, startTraySync
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
  try {
    const isFirstRun = await window.__TAURI__.core.invoke('is_first_run').catch(() => false);
    if (isFirstRun) {
        await initCoreLoadingOverlay();
    }
  } catch (e) {
      console.warn('Failed to check first run status:', e);
  }
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
    const coreResult = await invoke('bootstrap_core', { configPath, customArgs });
    secret = coreResult.secret;
    const port = coreResult.port;
    setBaseUrl(`http://127.0.0.1:${port}`);
    setWsBaseUrl(`ws://127.0.0.1:${port}`);
    setSecret(secret);
    setWsSecret(secret);
  } catch (err) {
    const message = err?.toString?.() || '核心启动失败';
    failCoreLoadingOverlay(message);
    console.error('[App] Failed to bootstrap core:', err);
    return;
  }

  initNavigation();
  initChart();
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
    startTraySync(); // Start periodic tray status synchronization
  } catch (err) {
    console.warn("Initial syncCoreConfig failed:", err);
  }

  window._trafficWsHandle = connectTraffic((data) => {
    updateTrafficData(data);
  });

  finishCoreLoadingOverlay();
}

window.addEventListener('DOMContentLoaded', () => {
  initApp();
});
