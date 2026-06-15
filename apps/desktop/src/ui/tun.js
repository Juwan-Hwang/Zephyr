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
import { saveSetting } from './settings-helpers.js';
import { appStore } from './state.js';
import { COMMANDS } from '@zephyr/shared';
import { postRestartRecovery } from './lifecycle.js';

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
            await postRestartRecovery(currentConfig);
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
            statusText.classList.add('text-accent');
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
                        await saveSetting('tun_enabled', true);
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
                        if (statusText) {
                            statusText.textContent = t.virtualAdapter;
                            statusText.classList.remove('text-accent');
                        }
                        return;
                    }
                } else {
                    try {
                        await invoke(COMMANDS.SET_TUN_ENABLED, { enable: false });
                        await invoke(COMMANDS.DISABLE_CMD);
                        await saveSetting('tun_enabled', false);
                        await new Promise(r => setTimeout(r, 1500));

                        const settings = await invoke(COMMANDS.GET_SETTINGS);
                        const currentConfig = settings.last_config || 'config.yaml';
                        const customArgs = settings.custom_args || [];
                        await new Promise(r => setTimeout(r, 1000));
                        await restartCore(currentConfig, customArgs);
                        await postRestartRecovery(currentConfig);
                    } catch (restartErr) {
                        tunLogger.error('failed to disable TUN', restartErr);
                    }
                }
            } else {
                // Non-macOS: use API to update config
                await patchConfig({ tun: { enable } });
                await saveSetting('tun_enabled', enable);

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
                if (!enable) statusText.classList.remove('text-accent');
            }
        } catch (_err) {
            toggle.checked = !enable;
            appStore.set('isTunEnabled', !enable);
            if (statusText) {
                statusText.textContent = t.virtualAdapter;
                statusText.classList.remove('text-accent');
            }

            const isLinux = navigator.userAgent.toLowerCase().includes('linux');
            if (isLinux && enable) {
                const grantPermission = confirm(
                    t.tunLinuxPermissionPrompt ||
                    'TUN mode requires network capabilities and polkit rules.\nGrant permission now?'
                );
                if (grantPermission) {
                    let permissionGranted = false;
                    try {
                        await invoke(COMMANDS.GRANT_LINUX_PERMISSION);
                        permissionGranted = true;
                    } catch (grantErr) {
                        tunLogger.error('Linux TUN permission grant failed', grantErr);
                        if (grantErr === 'canceled') {
                            showNotification(t.tunAuthCanceled || 'Authorization canceled', 'error');
                        } else {
                            showNotification(t.tunLinuxPermissionFailed || 'Failed to grant permission', 'error');
                        }
                    }

                    if (permissionGranted) {
                        try {
                            showNotification(t.tunLinuxPermissionGranted || 'Permission granted. Restarting core...', 'success');
                            await saveSetting('tun_enabled', true);
                            try { await invoke(COMMANDS.STOP_CORE); } catch (_) {}
                            const settings = await invoke(COMMANDS.GET_SETTINGS);
                            const currentConfig = settings.last_config || 'config.yaml';
                            const customArgs = settings.custom_args || [];
                            const coreResult = await restartCore(currentConfig, customArgs);
                            await postRestartRecovery(currentConfig);
                            if (coreResult?.secret) {
                                setSecret(coreResult.secret);
                                setWsSecret(coreResult.secret);
                            }
                            await closeAllConnections();

                            appStore.set('isTunEnabled', true);
                            toggle.checked = true;
                            if (statusText) {
                                statusText.textContent = t.proxyActive;
                                statusText.classList.add('text-accent');
                            }
                            showNotification(t.configSuccess, 'success');
                            return;
                        } catch (retryErr) {
                            tunLogger.error('TUN retry failed after permission grant', retryErr);
                            await saveSetting('tun_enabled', false);
                            try {
                                const settings = await invoke(COMMANDS.GET_SETTINGS);
                                const currentConfig = settings.last_config || 'config.yaml';
                                const customArgs = settings.custom_args || [];
                                await restartCore(currentConfig, customArgs);
                                await postRestartRecovery(currentConfig);
                            } catch (restartErr) {
                                tunLogger.error('Core restart without TUN also failed', restartErr);
                            }
                            showNotification(t.tunFailed || 'TUN mode failed after permission grant', 'error');
                        }
                    }
                }
            } else {
                showNotification(isMac ? t.tunFailedMac : t.tunFailed, 'error');
            }

        } finally {
            if (spinner) spinner.classList.add('hidden');
            appStore.set('isNetworkUpdating', false);
            try { await invoke(COMMANDS.RELEASE_TUN_TOGGLE); } catch (_) {}
        }
    };
}
