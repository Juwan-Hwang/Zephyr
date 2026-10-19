// @ts-check
/**
 * Mode selector logic - switch between Rule/Global/Direct modes.
 * Extracted from ui.js for modularity.
 */

import { invoke, closeAllConnections, switchProxy, getProxies, SPECIAL_PROXY_NAMES } from '../api.js';
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
    buttons.forEach((btn) => {
        /** @type {HTMLElement} */ (btn).onclick = () => {
            const mode = /** @type {string} */ (btn.getAttribute('data-mode'));
            applyMode(mode).catch((err) => {
                showNotification(toError(err).toString(), 'error');
            });
        };
    });
}

/**
 * Switch the core to `mode` and bring every surface along (mode buttons, proxies page,
 * tray via MODE_CHANGED). Shared by the mode buttons and the global shortcut so both
 * paths behave identically. The selected node is carried over when the target mode
 * still offers it; when it cannot be, a warning says so.
 * @param {string} mode
 * @param {{ silent?: boolean }} [opts] silent: the caller reports the outcome itself
 * @returns {Promise<false | 'ok' | 'partial'>} false when another network change is in
 *   progress; 'partial' when the mode changed but the selected node could not carry over
 * @throws when the backend rejects the mode change (the UI is reconciled with the
 *   live core before the error propagates)
 */
export async function applyMode(mode, { silent = false } = {}) {
    if (appStore.get('isNetworkUpdating')) return false;
    const container = document.getElementById('mode-selector-container');
    /** @type {Record<string, string>} */
    const t = /** @type {Record<string, string>} */ (/** @type {any} */ (translations)[currentLang] || /** @type {any} */ (translations).en);
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
        try {
            await invoke(COMMANDS.SWITCH_MODE, { mode });
        } catch (err) {
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
            throw err;
        }
        // Publish the new mode before any further await, so a
        // syncCoreConfig() already in flight sees the switch and does
        // not roll the UI and tray back to the old mode.
        appStore.set('currentOutboundMode', mode);
        // The backend writes settings.json, so drop the cached snapshot:
        // other readers take the mode from `getSettingsCached()`.
        invalidateSettingsCache();
        updateModeUI(mode);

        // 3. Close existing connections (fire-and-forget). The mode change has
        // already been applied and persisted; when the core is stopped this
        // rejects, which must not report the switch as failed.
        closeAllConnections().catch((e) =>
            modesLogger.warn("Failed to close connections", e)
        );

        // 4. Inherit node in target mode. The mode switch already succeeded,
        // so a failed inheritance must not fail the whole action.
        const inherited = await carryNodeOver(nodeToInherit, mode);

        import('./proxies.js').then(m => m.refreshProxies()).catch(() => {});
        if (!inherited && !silent) {
            // Part success is not full success: tell the user the node did not
            // carry over instead of booking it as applied.
            showNotification(`${t.configSuccess} — ${t.notifSwitchFailed}`, 'warning');
        }
        // Reactive: subscribe() in initReactiveBindings() handles tray menu update
        Bus.emit(Events.MODE_CHANGED, mode);
        return inherited ? 'ok' : 'partial';
    } finally {
        appStore.set('isNetworkUpdating', false);
        if (container) container.classList.remove('opacity-50', 'cursor-not-allowed');
    }
}

/**
 * Carry the previously selected node into the group the new mode exposes.
 * @param {string|null} nodeToInherit
 * @param {string} mode
 * @returns {Promise<boolean>} false when the node could not be carried over
 */
async function carryNodeOver(nodeToInherit, mode) {
    // A built-in selection (GLOBAL's default DIRECT, say) is not a node the
    // user picked, so there is nothing to carry over or to report as lost.
    if (!nodeToInherit || mode === 'direct'
        || SPECIAL_PROXY_NAMES.has(String(nodeToInherit).toUpperCase())) return true;
    try {
        const preferredGroupName = appStore.get('uiGroupName') || null;
        const resultAfter = await fetchProxyGroups({ preferredGroupName });
        // (A null lookup inspected no group, so it proves nothing
        // about inheritance and is not reported as a failure.)
        if (!resultAfter) return true;
        if (resultAfter.proxies.includes(nodeToInherit)) {
            // Use uiGroupName from resolver for accurate group targeting
            const targetGroup = resultAfter.uiGroupName || resultAfter.mainGroup;
            if (!targetGroup) return true;
            // Both shapes mean "not applied": a `false` result is the
            // reserved GLOBAL selection being rejected by the backend,
            // while a plain (non-reserved) group PUT raises ApiError.
            const applied = await switchProxy(targetGroup, nodeToInherit);
            if (applied) appStore.set('uiGroupName', targetGroup);
            else modesLogger.warn('Node inheritance switch was not applied');
            return applied;
        }
        // The previous node is not present in the target group, so it cannot
        // carry over and the group keeps its default selection. (When the group
        // already routes to the same node through a nested group, nothing changed.)
        if (await activeLeafMatches(resultAfter.current, nodeToInherit)) return true;
        modesLogger.warn('Node to inherit is not available in the target group');
        return false;
    } catch (e) {
        modesLogger.warn("Failed to carry the node over", e);
        return false;
    }
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
