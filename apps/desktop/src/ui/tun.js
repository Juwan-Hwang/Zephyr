// @ts-check
/**
 * TUN toggle logic - manage TUN virtual adapter mode.
 * Extracted from ui.js for modularity.
 */

import { patchConfig, closeAllConnections, invoke, restartCore, setSecret, getConfig } from '../api.js';
import { tunLogger } from '../utils/logger.js';
import { setWsSecret } from '../websocket.js';
import { showNotification } from './notifications.js';
import { translations, currentLang } from '../i18n.js';
import { persistConfigChanges } from './advanced.js';
import { appStore } from './state.js';
import { COMMANDS } from '@zephyr/shared';

export function initTunToggle() {
    const toggle = /** @type {HTMLInputElement|null} */ (document.getElementById('tun-proxy-toggle'));
    const statusText = document.getElementById('tun-status-text');
    const spinner = document.getElementById('tun-spinner');
    if (!toggle) return;

    /**
     * Attempt to recover from a TUN root-start failure by restarting the core.
     */
    async function recoverFromRootStartFailure() {
        try {
            const settings = await invoke(COMMANDS.GET_SETTINGS);
            const currentConfig = settings.last_config || 'config.yaml';
            const customArgs = settings.custom_args || [];
            await restartCore(currentConfig, customArgs);
        } catch (recoverErr) {
            tunLogger.error('recovery failed', recoverErr);
        }
    }

    toggle.onchange = async () => {
        if (appStore.get('isNetworkUpdating')) {
            toggle.checked = !toggle.checked;
            return;
        }

        const enable = toggle.checked;
        /** @type {Record<string, string>} */
        const t = /** @type {Record<string, string>} */ (/** @type {any} */ (translations)[currentLang]);
        const isMac = navigator.platform.toLowerCase().includes('mac');
        appStore.set('isNetworkUpdating', true);

        // Show loading state
        if (spinner) spinner.classList.remove('hidden');
        if (statusText) {
            statusText.textContent = t.configuringTun;
            statusText.classList.add('text-purple-400');
        }

        try {
            // On macOS, handle TUN mode with root privileges
            if (isMac) {
                if (enable) {
                    try {
                        const result = await invoke(COMMANDS.RESTART_AS_ROOT, { enableTun: true });
                        if (result) {
                            setSecret(result);
                            setWsSecret(result);
                        }
                    } catch (authErr) {
                        tunLogger.error('authErr', authErr);
                        if (authErr === 'canceled') {
                            showNotification(t.tunAuthCanceled || 'Authorization canceled', 'error');
                        } else if (authErr === 'root_start_failed') {
                            showNotification(t.tunStartFailed || 'TUN failed to start, recovering...', 'error');
                            await recoverFromRootStartFailure();
                        } else {
                            showNotification(t.tunAuthFailed || 'Authorization failed', 'error');
                        }
                        toggle.checked = false;
                        if (spinner) spinner.classList.add('hidden');
                        if (statusText) {
                            statusText.textContent = t.virtualAdapter;
                            statusText.classList.remove('text-purple-400');
                        }
                        appStore.set('isNetworkUpdating', false);
                        return;
                    }
                } else {
                    try {
                        await invoke(COMMANDS.SET_TUN_ENABLED, { enable: false });
                        await invoke(COMMANDS.DISABLE_CMD);
                        await new Promise(r => setTimeout(r, 1500));

                        const settings = await invoke(COMMANDS.GET_SETTINGS);
                        const currentConfig = settings.last_config || 'config.yaml';
                        const customArgs = settings.custom_args || [];
                        await new Promise(r => setTimeout(r, 1000));
                        await restartCore(currentConfig, customArgs);
                    } catch (restartErr) {
                        tunLogger.error('failed to disable TUN', restartErr);
                    }
                }
            } else {
                // Non-macOS: use API to update config
                await patchConfig({ tun: { enable } });
                await persistConfigChanges({ tun: { enable } });

                const _coreConfig = await invoke(COMMANDS.READ_CONFIG).catch(() => null);
                const config = await getConfig();
                /** @type {{tun?: {enable?: boolean}}} */
                const typedConfig = /** @type {{tun?: {enable?: boolean}}} */ (config);
                if (typedConfig?.tun?.enable !== enable) {
                    throw new Error(t.tunRejected || "Core rejected TUN mode change");
                }
            }

            await closeAllConnections();

            appStore.set('isTunEnabled', enable);

            showNotification(t.configSuccess, 'success');

            if (statusText) {
                statusText.textContent = enable ? t.proxyActive : t.virtualAdapter;
                if (!enable) statusText.classList.remove('text-purple-400');
            }
            if (spinner) spinner.classList.add('hidden');
            appStore.set('isNetworkUpdating', false);
            try { await invoke(COMMANDS.RELEASE_TUN_TOGGLE); } catch (_) {}
            // Reactive: subscribe() in initReactiveBindings() handles tray updates
        } catch {
            toggle.checked = !enable;
            appStore.set('isTunEnabled', !enable);
            if (statusText) {
                statusText.textContent = t.virtualAdapter;
                statusText.classList.remove('text-purple-400');
            }
            if (spinner) spinner.classList.add('hidden');
            showNotification(isMac ? t.tunFailedMac : t.tunFailed, 'error');
            appStore.set('isNetworkUpdating', false);
            try { await invoke(COMMANDS.RELEASE_TUN_TOGGLE); } catch (_) {}
            // Reactive: subscribe() in initReactiveBindings() handles tray updates
        }
    };
}
