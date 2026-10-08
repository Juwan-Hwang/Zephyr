// @ts-check
/**
 * Mode selector logic - switch between Rule/Global/Direct modes.
 * Extracted from ui.js for modularity.
 */

import { invoke, closeAllConnections, switchProxy } from '../api.js';
import { fetchProxyGroups } from './proxy-groups.js';
import { showNotification } from './notifications.js';
import { translations, currentLang } from '../i18n.js';
import { Bus, Events } from './events.js';
import { modesLogger } from '../utils/logger.js';
import { toError } from '../types/guards.js';
import { appStore } from './state.js';

export function initModeSelector() {
    const buttons = document.querySelectorAll('[data-mode]');
    const container = document.getElementById('mode-selector-container');

    buttons.forEach((btn) => {
        /** @type {HTMLElement} */ (btn).onclick = async () => {
            if (appStore.get('isNetworkUpdating')) return;

            const mode = /** @type {string} */ (btn.getAttribute('data-mode'));
            /** @type {Record<string, string>} */
            const t = /** @type {Record<string, string>} */ (/** @type {any} */ (translations)[currentLang]);

            appStore.set('isNetworkUpdating', true);
            if (container) container.classList.add('opacity-50', 'cursor-not-allowed');

            try {
                // 1. Capture current node for inheritance
                let nodeToInherit = null;
                try {
                    const preferredGroupName = appStore.get('uiGroupName') || null;
                    const resultBefore = await fetchProxyGroups({ preferredGroupName });
                    if (resultBefore) {
                        nodeToInherit = resultBefore.current;
                    }
                } catch (e) { modesLogger.warn("Failed to capture node for inheritance", e); }

                // 2. Switch mode (hot-reload via REST API — instant)
                // Routed through the backend so the user-mode generation bump
                // happens under the restore lock; otherwise an in-flight
                // fallback restore could overwrite the user's choice. The
                // backend persists the accepted mode to settings.json itself.
                await invoke('switch_mode', { mode });
                updateModeUI(mode);

                // 3. Close existing connections (fire-and-forget)
                closeAllConnections().catch((e) =>
                    modesLogger.warn("Failed to close connections", e)
                );

                // 4. Inherit node in target mode
                if (nodeToInherit && mode !== 'direct') {
                    const preferredGroupName = appStore.get('uiGroupName') || null;
                    const resultAfter = await fetchProxyGroups({ preferredGroupName });
                    if (resultAfter && resultAfter.proxies.includes(nodeToInherit)) {
                        // Use uiGroupName from resolver for accurate group targeting
                        const targetGroup = resultAfter.uiGroupName || resultAfter.mainGroup;
                        if (targetGroup) {
                            // A `false` result means the reserved GLOBAL selection
                            // was rejected (or a non-reserved group PUT failed):
                            // do not book it as inherited.
                            const inheritedOk = await switchProxy(targetGroup, nodeToInherit);
                            if (inheritedOk) {
                                appStore.set('uiGroupName', targetGroup);
                            } else {
                                modesLogger.warn('Node inheritance switch was not applied');
                            }
                        }
                    }
                }

                import('./proxies.js').then(m => m.renderProxies());
                showNotification(t.configSuccess, 'success');

                appStore.set('isNetworkUpdating', false);
                if (container) container.classList.remove('opacity-50', 'cursor-not-allowed');
                // Reactive: subscribe() in initReactiveBindings() handles tray menu update
                Bus.emit(Events.MODE_CHANGED, mode);
            } catch (err) {
                showNotification(toError(err).toString(), 'error');
                appStore.set('isNetworkUpdating', false);
                if (container) container.classList.remove('opacity-50', 'cursor-not-allowed');
            }
        };
    });
}

/**
 * @param {string} mode
 */
export function updateModeUI(mode) {
    const buttons = document.querySelectorAll('[data-mode]');
    const slider = document.getElementById('mode-slider');
    const modes = ['rule', 'global', 'direct'];
    const idx = modes.indexOf(mode.toLowerCase());

    if (idx !== -1 && slider) {
        slider.style.transform = `translateX(calc(var(--rtl-sign, 1) * ${idx * 100}%))`;
        buttons.forEach((b, i) => {
            if (i === idx) {
                b.classList.add('text-[var(--text-primary)]');
                b.classList.remove('text-[var(--text-secondary)]');
            } else {
                b.classList.remove('text-[var(--text-primary)]');
                b.classList.add('text-[var(--text-secondary)]');
            }
        });
    }
}
