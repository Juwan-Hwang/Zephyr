// @ts-check
/**
 * Mode selector logic - switch between Rule/Global/Direct modes.
 * Extracted from ui.js for modularity.
 */

import { invoke, closeAllConnections, switchProxy, getProxies } from '../api.js';
import { fetchProxyGroups } from './proxy-groups.js';
import { showNotification } from './notifications.js';
import { translations, currentLang } from '../i18n.js';
import { invalidateSettingsCache } from './cache.js';
import { Bus, Events } from './events.js';
import { modesLogger } from '../utils/logger.js';
import { toError } from '../types/guards.js';
import { appStore } from './state.js';
import { COMMANDS } from '@zephyr/shared';

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
                await invoke(COMMANDS.SWITCH_MODE, { mode });
                // The backend writes settings.json, so drop the cached snapshot:
                // other readers take the mode from `getSettingsCached()`.
                invalidateSettingsCache();
                updateModeUI(mode);

                // 3. Close existing connections (fire-and-forget)
                closeAllConnections().catch((e) =>
                    modesLogger.warn("Failed to close connections", e)
                );

                // 4. Inherit node in target mode
                let inherited = true;
                if (nodeToInherit && mode !== 'direct') {
                    const preferredGroupName = appStore.get('uiGroupName') || null;
                    const resultAfter = await fetchProxyGroups({ preferredGroupName });
                    if (resultAfter && resultAfter.proxies.includes(nodeToInherit)) {
                        // Use uiGroupName from resolver for accurate group targeting
                        const targetGroup = resultAfter.uiGroupName || resultAfter.mainGroup;
                        if (targetGroup) {
                            // The mode switch already succeeded, so a failed
                            // inheritance must not fail the whole action. Both
                            // shapes mean "not applied": a `false` result is the
                            // reserved GLOBAL selection being rejected by the
                            // backend, while a plain (non-reserved) group PUT
                            // raises ApiError — apiFetch normalises every
                            // non-2xx into a throw, so switchProxy never returns
                            // false for those.
                            try {
                                inherited = await switchProxy(targetGroup, nodeToInherit);
                                if (inherited) {
                                    appStore.set('uiGroupName', targetGroup);
                                } else {
                                    // switchProxy already logged the backend's
                                    // rejection reason for this shape.
                                    modesLogger.warn('Node inheritance switch was not applied');
                                }
                            } catch (e) {
                                inherited = false;
                                modesLogger.warn('Node inheritance switch threw', e);
                            }
                        }
                    } else if (resultAfter && !(await activeLeafMatches(resultAfter.current, nodeToInherit))) {
                        // (A null lookup inspected no group, so it proves nothing
                        // about inheritance and is not reported as a failure.)
                        // The previous node is not present in the target group, so
                        // it cannot carry over and the group keeps its default
                        // selection. That is not full success — reporting it as
                        // such would tell the user their node was kept while it
                        // silently changed. (When the group already routes to
                        // the same node through a nested group, nothing changed.)
                        inherited = false;
                        modesLogger.warn('Node to inherit is not available in the target group');
                    }
                }

                import('./proxies.js').then(m => m.renderProxies());
                if (inherited) {
                    showNotification(t.configSuccess, 'success');
                } else {
                    // Part success is not full success: tell the user the node
                    // did not carry over instead of booking it as applied.
                    showNotification(`${t.configSuccess} — ${t.notifSwitchFailed}`, 'warning');
                }

                appStore.set('isNetworkUpdating', false);
                if (container) container.classList.remove('opacity-50', 'cursor-not-allowed');
                // Reactive: subscribe() in initReactiveBindings() handles tray menu update
                Bus.emit(Events.MODE_CHANGED, mode);
            } catch (err) {
                showNotification(toError(err).toString(), 'error');
                // The backend can apply the mode to the core and still fail
                // (e.g. the settings write failed after the core PUT), so
                // reconcile the buttons with the live core instead of leaving
                // the previous mode highlighted. Awaited while the switch guard
                // is still held, so a later switch cannot be overwritten by
                // this older snapshot.
                try {
                    const m = await import('./proxies.js');
                    await m.syncCoreConfig();
                } catch (e) {
                    modesLogger.warn('Failed to reconcile mode after switch failure', e);
                }
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

/**
 * Whether the target group's selection already routes to the same node as the
 * previous selection, resolving nested groups down to their active leaf.
 * @param {string|null|undefined} current
 * @param {string|null|undefined} previous
 * @returns {Promise<boolean>}
 */
async function activeLeafMatches(current, previous) {
    if (!current || !previous) return false;
    try {
        const [{ resolveLeafNode }, data] = await Promise.all([import('./proxies.js'), getProxies()]);
        const proxyMap = /** @type {{proxies?: Record<string, any>}} */ (data)?.proxies;
        if (!proxyMap) return false;
        return resolveLeafNode(current, proxyMap) === resolveLeafNode(previous, proxyMap);
    } catch (e) {
        modesLogger.warn('Failed to resolve active node for inheritance check', e);
        return false;
    }
}
