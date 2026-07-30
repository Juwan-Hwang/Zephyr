// @ts-check
/**
 * System proxy toggle logic.
 * Extracted from ui.js for modularity.
 */

import { getConfig, invoke } from '../api.js';
import { sysproxyLogger } from '../utils/logger.js';
import { showNotification } from './notifications.js';
import { translations, currentLang } from '../i18n.js';
import { updateTrayStatus } from './tray.js';
import { appStore } from './state.js';
import { COMMANDS } from '@zephyr/shared';

export async function updateSysProxyUI() {
    const statusText = document.getElementById('proxy-status-text');
    const toggle = /** @type {HTMLInputElement|null} */ (document.getElementById('sys-proxy-toggle'));

    try {
        const isActive = await invoke(COMMANDS.GET_SYS_PROXY);

        appStore.set('isSysProxyEnabled', isActive);

        if (toggle && toggle.checked !== isActive) {
            toggle.checked = isActive;
        }

        if (!statusText) return;

        if (isActive) {
            statusText.textContent = /** @type {Record<string, string>} */ (/** @type {any} */ (translations)[currentLang]).proxyStatusActive || 'Proxy Active';
            statusText.classList.remove('text-[var(--text-muted)]');
            statusText.classList.add('text-accent');
        } else {
            statusText.textContent = /** @type {Record<string, string>} */ (/** @type {any} */ (translations)[currentLang]).proxyStatusReady || 'Ready to protect your traffic';
            statusText.classList.remove('text-accent');
            statusText.classList.add('text-[var(--text-muted)]');
        }
    } catch (err) {
        sysproxyLogger.error('Failed to update sys proxy UI', err);
    }
}

/**
 * Apply sys-proxy enable/disable to the backend and sync appStore.
 * Extracted from the toggle change handler so console-home can call it
 * directly without relying on DOM event dispatching.
 * @param {boolean} enabled
 * @throws {unknown} Re-throws the backend error so callers can handle
 *   notification and UI rollback.
 */
export async function setSysProxyEnabled(enabled) {
    /** @type {Record<string, any>} */
    const currentConfig = await getConfig();
    const currentPort = currentConfig?.['mixed-port'] || currentConfig?.port || currentConfig?.['socks-port'] || 7890;

    if (enabled) {
        await invoke(COMMANDS.ENABLE_SYSPROXY, {
            server: `127.0.0.1:${currentPort}`,
            bypass: null,
        });
    } else {
        await invoke(COMMANDS.DISABLE_SYSPROXY);
    }

    appStore.set('isSysProxyEnabled', enabled);
    updateSysProxyUI();
}

export async function initProxyToggle() {
    const toggle = /** @type {HTMLInputElement|null} */ (document.getElementById('sys-proxy-toggle'));
    const statusText = document.getElementById('proxy-status-text');

    if (!toggle || !statusText) return;

    // Fetch initial status
    try {
        const isEnabled = await invoke(COMMANDS.GET_SYS_PROXY);
        toggle.checked = isEnabled;
        updateSysProxyUI();
        await updateTrayStatus();
    } catch (err) {
        sysproxyLogger.error('Failed to get initial sys proxy status', err);
    }

    toggle.addEventListener('change', async (e) => {
        const target = /** @type {HTMLInputElement} */ (e.target);
        const enabled = target.checked;

        try {
            await setSysProxyEnabled(enabled);
        } catch (err) {
            sysproxyLogger.error('Failed to set sys proxy', err);
            const t = /** @type {Record<string, string>} */ (/** @type {any} */ (translations)[currentLang]);
            showNotification(`${t.errorPrefix || 'Error'}: ${err}`, 'error');
            target.checked = !enabled;
            appStore.set('isSysProxyEnabled', !enabled);
        }
    });
}
