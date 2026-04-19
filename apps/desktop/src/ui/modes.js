// @ts-check
/**
 * Mode selector logic - switch between Rule/Global/Direct modes.
 * Extracted from ui.js for modularity.
 */

import { patchConfig } from '../api.js';
import { persistConfigChanges } from './advanced.js';
import { closeAllConnections } from '../api.js';
import { fetchProxyGroups } from './proxy-groups.js';
import { switchProxy } from '../api.js';
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
            showNotification(t.configuring);

            try {
                // 1. Capture current node for inheritance
                let nodeToInherit = null;
                try {
                    const resultBefore = await fetchProxyGroups();
                    if (resultBefore) {
                        nodeToInherit = resultBefore.current;
                    }
                } catch (e) { modesLogger.warn("Failed to capture node for inheritance", e); }

                // 2. Switch mode
                await patchConfig({ mode });
                await persistConfigChanges({ mode });
                updateModeUI(mode);
                await closeAllConnections();

                // 3. Inherit node in target mode
                if (nodeToInherit && mode !== 'direct') {
                    const resultAfter = await fetchProxyGroups();
                    if (resultAfter && resultAfter.proxies.includes(nodeToInherit)) {
                        await switchProxy(resultAfter.mainGroup, nodeToInherit);
                    }
                }

                import('./proxies.js').then(m => m.renderProxies());
                showNotification(t.configSuccess, 'success');

                appStore.set('isNetworkUpdating', false);
                if (container) container.classList.remove('opacity-50', 'cursor-not-allowed');
                import('./tray.js').then(m => m.updateTrayMenu(true).catch(() => {}));
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
        slider.style.transform = `translateX(${idx * 100}%)`;
        buttons.forEach((b, i) => {
            if (i === idx) {
                b.classList.add('text-zinc-100');
                b.classList.remove('text-zinc-400');
            } else {
                b.classList.remove('text-zinc-100');
                b.classList.add('text-zinc-400');
            }
        });
    }
}
