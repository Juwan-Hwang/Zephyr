// @ts-check
/**
 * Subscription management submodule for settings.
 *
 * Handles subscription list rendering (renderConfigs), subscription add/update,
 * and the right-click context menu for rule library integration.
 *
 * @module ui/settings/subscriptions
 */

import {
    invoke,
    restartCore,
    abortLatencyTests,
} from '../../api.js';
import { switchToConfig, postRestartRecovery } from '../lifecycle.js';
import { COMMANDS } from '@zephyr/shared';
import { translations } from '../../i18n.js';
import { rulesLogger } from '../../utils/logger.js';
import { showNotification, showModal, showConfirmModal } from '../notifications.js';
import { appStore } from '../state.js';
import { getSettingsCached, getConfigsCached, invalidateSettingsCache, invalidateConfigsCache } from '../cache.js';
import { Bus, Events } from '../events.js';
import { formatFileSize } from '../../utils/format.js';
import { escapeHtml, escapeAttr } from '../../utils/sanitize.js';
import { removeContextMenu, createContextMenuContainer, attachContextMenuCloseHandlers } from '../../utils/context-menu.js';
import { generateDomId } from '../../utils/dom-id.js';
import { SVG_ICONS } from '../icons.js';
import { pasteToElement, renderPasteButtonHtml } from '../../utils/clipboard.js';
import { initCustomDropdown } from '../dropdown.js';
import * as prism from '../prism.js';

const normalizeConfigName = (/** @type {string | null | undefined} */ configName) => typeof configName === 'string' ? configName.toLowerCase().replace(/\.(ya?ml)$/i, '') : '';

/**
 * Extract a human-readable name from a subscription URL.
 * @param {string} url
 * @returns {string | null}
 */
function extractNameFromUrl(url) {
    try {
        const u = new URL(url);
        const name = u.searchParams.get('name') || u.searchParams.get('remark');
        if (name) return decodeURIComponent(name);
        if (u.hash) {
            const hash = u.hash.substring(1);
            if (hash.includes('remark=')) {
                return decodeURIComponent(hash.split('remark=')[1].split('&')[0]);
            }
            if (hash.length > 2 && !hash.includes('/')) return decodeURIComponent(hash);
        }
        const pathParts = u.pathname.split('/').filter(p => p.length > 0);
        if (pathParts.length > 0) {
            const last = pathParts[pathParts.length - 1];
            const base = last.split('.')[0];
            if (base.length > 2 && base !== 'config' && base !== 'clash') return base;
        }
        return u.hostname;
    } catch {
        return null;
    }
}

/**
 * Format a Unix timestamp as a relative time string.
 * @param {number | null | undefined} timestamp - Unix timestamp in seconds
 * @param {Record<string, string>} t - Translation object
 * @returns {string}
 */
function formatLastUpdated(timestamp, t) {
    if (!timestamp) return t.lastUpdatedNever || 'Never';
    const now = Math.floor(Date.now() / 1000);
    const diff = now - timestamp;
    if (diff < 60) return t.lastUpdatedJustNow || 'Just now';
    if (diff < 3600) return (t.lastUpdatedMinutesAgo || '{m} min ago').replace('{m}', String(Math.floor(diff / 60)));
    if (diff < 86400) return (t.lastUpdatedHoursAgo || '{h}h ago').replace('{h}', String(Math.floor(diff / 3600)));
    return (t.lastUpdatedDaysAgo || '{d}d ago').replace('{d}', String(Math.floor(diff / 86400)));
}

// ---- Module-level renderConfigs for use before init ----
// This is set by initSubscriptionSettings and used by showEditPanel
/** @type {any} */
let moduleRenderConfigs = null;

/** Track active edit modal dropdown for proper cleanup. */
/** @type {any} */
let activeEditDropdown = null;

/** UA client options — mirrors the global fake-client dropdown.
 *  `labelKey` entries are resolved via i18n at render time. */
const UA_OPTIONS = [
    { value: '', label: 'Use Global', labelKey: 'uaUseGlobal' },
    { value: 'clash-verge', label: 'Clash Verge Rev' },
    { value: 'mihomo-party', label: 'mihomo-party' },
    { value: 'Flclash', label: 'Flclash' },
    { value: 'Shadowrocket', label: 'Shadowrocket' },
];

/**
 * Resolve the display label for a UA option, using i18n when available.
 * @param {{ value: string, label: string, labelKey?: string }} opt
 * @param {Record<string, string>} t
 */
function uaLabel(opt, t) {
    return (opt.labelKey && t[opt.labelKey]) || opt.label;
}

/** Track active edit modal UA dropdown for proper cleanup. */
/** @type {any} */
let activeEditUADropdown = null;

/**
 * Show the edit panel for a subscription.
 * @param {{name: string, url_display?: string | null, last_updated?: number | null, auto_update_interval?: number | null, user_agent?: string | null}} configInfo
 */
async function showEditPanel(configInfo) {
    const t = (/** @type {Record<string, any>} */ (translations))[appStore.get('currentLang')] || {};

    const currentStem = configInfo.name.replace(/\.(yaml|yml)$/i, '');

    // Get current auto-update interval for this subscription (stored in metadata)
    const currentInterval = configInfo.auto_update_interval || 0;

    // Per-subscription UA (stored in metadata). Match by prefix to handle versioned values.
    const currentUA = configInfo.user_agent || '';

    // Auto-update options
    const autoUpdateOptions = [
        { value: '0', label: t.autoUpdateDisabled || 'Disabled' },
        { value: '43200', label: t.autoUpdate12h || 'Every 12 hours' },
        { value: '86400', label: t.autoUpdate1d || 'Every day' },
        { value: '259200', label: t.autoUpdate3d || 'Every 3 days' },
    ];
    const currentIntervalLabel = autoUpdateOptions.find(o => o.value === String(currentInterval))?.label || (t.autoUpdateDisabled || 'Disabled');

    // Build dropdown menu items (escape labels for XSS safety)
    const dropdownMenuItems = autoUpdateOptions.map(opt => 
        `<button type="button" data-value="${opt.value}" data-label="${escapeAttr(opt.label)}" class="dropdown-option w-full text-start px-3 py-2 rounded-[var(--radius-dropdown-option)] text-xs text-[var(--text-secondary)] hover:bg-[var(--zephyr-bg-muted)] transition-colors">${escapeHtml(opt.label)}</button>`
    ).join('');

    // Determine which UA option is currently selected (prefix match for versioned values)
    const matchedUAOpt = UA_OPTIONS.find(o => {
        if (o.value === '') return currentUA === '';
        return currentUA.startsWith(o.value);
    });
    const currentUALabel = matchedUAOpt ? uaLabel(matchedUAOpt, t) : (t.uaUseGlobal || 'Use Global');
    const currentUAValue = matchedUAOpt?.value ?? '';

    // Build UA dropdown menu items
    const uaMenuItems = UA_OPTIONS.map(opt => {
        const lbl = uaLabel(opt, t);
        return `<button type="button" data-value="${opt.value}" data-label="${escapeAttr(lbl)}" class="dropdown-option w-full text-start px-3 py-2 rounded-[var(--radius-dropdown-option)] text-xs text-[var(--text-secondary)] hover:bg-[var(--zephyr-bg-muted)] transition-colors">${escapeHtml(lbl)}</button>`;
    }).join('');

    // Remove any existing modal to prevent duplicate IDs
    const existingModal = document.getElementById('edit-subscription-modal');
    if (existingModal) {
        activeEditDropdown?.dispose();
        activeEditDropdown = null;
        activeEditUADropdown?.dispose();
        activeEditUADropdown = null;
        existingModal.remove();
    }

    // Animation duration (ms) — keep in sync with CSS transitions below
    const ANIMATION_DURATION = 300;

    // Create modal overlay (matching smart proxy config style)
    let isClosing = false;
    let isSaving = false;
    const modal = document.createElement('div');
    modal.id = 'edit-subscription-modal';
    modal.className = 'fixed inset-0 z-[var(--z-modal)] flex items-center justify-center bg-[var(--zephyr-bg-overlay)] backdrop-blur-md opacity-0 transition-opacity';
    modal.style.transitionDuration = `${ANIMATION_DURATION}ms`;
    // Escape all translation strings for XSS safety
    // eslint-disable-next-line no-unsanitized/property -- values escaped via escapeHtml() // nosemgrep: js-innerhtml-assignment — verified safe, see eslint-disable above
    modal.innerHTML = `
        <div class="glass-card w-[440px] p-6 space-y-5" style="opacity:0;transform:scale(0.95);transition:opacity ${ANIMATION_DURATION}ms cubic-bezier(0.16,1,0.3,1),transform ${ANIMATION_DURATION}ms cubic-bezier(0.16,1,0.3,1)">
            <div class="flex items-center justify-between">
                <h3 class="text-sm font-bold text-[var(--text-primary)]">${escapeHtml(t.editSubscription || 'Edit Subscription')}</h3>
                <button id="edit-modal-close" class="text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors">
                    <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
                </button>
            </div>
            <div class="space-y-4">
                <div class="flex flex-col gap-1.5">
                    <label for="edit-name" class="text-2xs text-[var(--text-muted)] font-medium uppercase tracking-wider">${escapeHtml(t.rename || 'Name')}</label>
                    <input id="edit-name" type="text" value="" class="form-control form-control-md">
                </div>
                <div class="flex flex-col gap-1.5">
                    <label for="edit-url" class="text-2xs text-[var(--text-muted)] font-medium uppercase tracking-wider">${escapeHtml(t.subscriptionUrl || 'Subscription URL')}</label>
                    <div class="input-paste-wrapper">
                        <input id="edit-url" type="text" value="" placeholder="${escapeAttr(t.subscriptionUrlPlaceholder || 'Enter new URL to replace')}" class="form-control form-control-md">
                        ${renderPasteButtonHtml('edit-url-paste-btn', t.paste || 'Paste')}
                    </div>
                </div>
                <div class="flex flex-col gap-1.5">
                    <label class="text-2xs text-[var(--text-muted)] font-medium uppercase tracking-wider">${escapeHtml(t.editUA || 'Update User-Agent')}</label>
                    <div id="edit-ua-wrap" class="relative">
                        <button id="edit-ua-trigger" type="button" class="select-common w-full flex items-center justify-between text-xs py-1.5">
                            <span id="edit-ua-label">${escapeHtml(currentUALabel)}</span>
                            <svg class="w-3.5 h-3.5 text-[var(--text-muted)] transition-transform duration-[var(--zephyr-time-micro)] dropdown-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 9 6 6 6-6"></path></svg>
                        </button>
                        <div id="edit-ua-menu" class="hidden absolute inset-inline-0 top-[calc(100%+6px)] rounded-lg border border-[var(--zephyr-border-default)] bg-[var(--zephyr-bg-elevated)] shadow-2xl z-30">
                            <div class="menu-scroll">
                                ${uaMenuItems}
                            </div>
                        </div>
                        <select id="edit-ua-select" class="hidden">
                            ${UA_OPTIONS.map(opt => `<option value="${opt.value}" ${opt.value === currentUAValue ? 'selected' : ''}>${escapeHtml(uaLabel(opt, t))}</option>`).join('')}
                        </select>
                    </div>
                </div>
            </div>
            <!-- Auto-update dropdown in bottom right -->
            <div class="flex items-center justify-between pt-2">
                <div class="flex items-center gap-2">
                    <label class="text-2xs text-[var(--text-muted)] font-medium uppercase tracking-wider">${escapeHtml(t.autoUpdateInterval || 'Auto Update')}</label>
                    <div id="edit-auto-update-wrap" class="relative">
                        <button id="edit-auto-update-trigger" type="button" class="select-common w-32 flex items-center justify-between text-xs py-1.5">
                            <span id="edit-auto-update-label">${escapeHtml(currentIntervalLabel)}</span>
                            <svg class="w-3.5 h-3.5 text-[var(--text-muted)] transition-transform duration-[var(--zephyr-time-micro)] dropdown-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 9 6 6 6-6"></path></svg>
                        </button>
                        <div id="edit-auto-update-menu" class="hidden absolute inset-inline-0 top-[calc(100%+6px)] rounded-lg border border-[var(--zephyr-border-default)] bg-[var(--zephyr-bg-elevated)] shadow-2xl z-30 w-40">
                            <div class="menu-scroll">
                                ${dropdownMenuItems}
                            </div>
                        </div>
                        <select id="edit-auto-update" class="hidden">
                            ${autoUpdateOptions.map(opt => `<option value="${opt.value}" ${opt.value === String(currentInterval) ? 'selected' : ''}>${escapeHtml(opt.label)}</option>`).join('')}
                        </select>
                    </div>
                </div>
                <div class="flex justify-end gap-2">
                    <button id="edit-modal-cancel" class="btn-ghost text-xs px-4 py-2">${escapeHtml(t.cancel || 'Cancel')}</button>
                    <button id="edit-modal-save" class="btn-accent text-xs px-4 py-2">${escapeHtml(t.save || 'Save')}</button>
                </div>
            </div>
        </div>
    `;

    document.body.appendChild(modal);

    // Cache panel reference for animations
    const panel = /** @type {HTMLElement | null} */ (modal.querySelector('.glass-card'));

    // Trigger enter animation (double rAF ensures browser paints initial state first)
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            if (!modal.isConnected || isClosing) return;
            modal.classList.remove('opacity-0');
            if (panel) {
                panel.style.opacity = '1';
                panel.style.transform = 'scale(1)';
            }
        });
    });

    // Set input value via DOM property (safe from XSS — no innerHTML interpolation)
    const editNameInput = /** @type {HTMLInputElement} */ (modal.querySelector('#edit-name'));
    if (editNameInput) editNameInput.value = currentStem;

    // Initialize custom dropdowns
    const autoUpdateDropdown = initCustomDropdown({
        wrapId: 'edit-auto-update-wrap',
        triggerId: 'edit-auto-update-trigger',
        menuId: 'edit-auto-update-menu',
        labelId: 'edit-auto-update-label',
        selectId: 'edit-auto-update',
    });
    activeEditDropdown = autoUpdateDropdown;

    const uaDropdown = initCustomDropdown({
        wrapId: 'edit-ua-wrap',
        triggerId: 'edit-ua-trigger',
        menuId: 'edit-ua-menu',
        labelId: 'edit-ua-label',
        selectId: 'edit-ua-select',
    });
    activeEditUADropdown = uaDropdown;

    const closeModal = () => {
        if (isClosing || isSaving) return;
        isClosing = true;
        autoUpdateDropdown?.dispose();
        uaDropdown?.dispose();
        activeEditDropdown = null;
        activeEditUADropdown = null;
        if (panel) {
            panel.style.opacity = '0';
            panel.style.transform = 'scale(0.95)';
        }
        modal.classList.add('opacity-0', 'pointer-events-none');
        setTimeout(() => modal.remove(), ANIMATION_DURATION);
    };
    // Close handlers
    document.getElementById('edit-modal-close')?.addEventListener('click', closeModal);
    document.getElementById('edit-modal-cancel')?.addEventListener('click', closeModal);
    modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });

    modal.querySelector('#edit-url-paste-btn')?.addEventListener('click', (e) => {
        e.preventDefault();
        const editUrlInput = /** @type {HTMLInputElement | null} */ (modal.querySelector('#edit-url'));
        if (editUrlInput) {
            const lang = appStore.get('currentLang') || 'en';
            const failMsg = /** @type {any} */ (translations)[lang]?.pasteFailed || translations.en.pasteFailed;
            pasteToElement(editUrlInput, true, () => showNotification(failMsg, 'warning'));
        }
    });

    // Save handler
    document.getElementById('edit-modal-save')?.addEventListener('click', async () => {
        if (isClosing || isSaving) return;
        const editNameEl = document.getElementById('edit-name');
        const newName = (editNameEl instanceof HTMLInputElement ? editNameEl.value : '').trim() || '';
        const editUrlEl = document.getElementById('edit-url');
        const newUrl = (editUrlEl instanceof HTMLInputElement ? editUrlEl.value : '').trim() || '';
        const editIntervalEl = document.getElementById('edit-auto-update');
        const newInterval = parseInt((editIntervalEl instanceof HTMLSelectElement ? editIntervalEl.value : '0'), 10);

        if (!newName) {
            showNotification(t.subscriptionNameRequired || 'Subscription name is required', 'error');
            return;
        }

        isSaving = true;
        const saveBtn = document.getElementById('edit-modal-save');
        const cancelBtn = document.getElementById('edit-modal-cancel');
        if (saveBtn) saveBtn.classList.add('opacity-50', 'pointer-events-none');
        if (cancelBtn) cancelBtn.classList.add('opacity-50', 'pointer-events-none');

        try {
            // Update URL, interval, and UA on the current name first.
            // This ensures that if an update fails, the state remains consistent
            // under the original name (more recoverable than a failed rename).
            if (newUrl) {
                await invoke(COMMANDS.UPDATE_CONFIG_URL, { name: configInfo.name, newUrl });
            }
            if (newInterval !== currentInterval) {
                await invoke(COMMANDS.UPDATE_SUBSCRIPTION_INTERVAL, { name: configInfo.name, interval: newInterval });
            }
            // Save per-subscription UA only if the selection actually changed
            const editUAEl = document.getElementById('edit-ua-select');
            const newUAPrefix = (editUAEl instanceof HTMLSelectElement ? editUAEl.value : '');
            if (newUAPrefix !== currentUAValue) {
                const resolvedUA = await resolvePerSubUA(newUAPrefix);
                await invoke(COMMANDS.UPDATE_SUBSCRIPTION_UA, { name: configInfo.name, userAgent: resolvedUA });
            }

            // Rename last — if this fails, updates are still applied under the old name
            if (newName !== currentStem) {
                await invoke(COMMANDS.RENAME_CONFIG, { oldName: configInfo.name, newName });
                invalidateSettingsCache();
            }

            invalidateConfigsCache();

            isSaving = false;
            closeModal();
            // Show notification based on what was changed
            if (newUrl) {
                showNotification(t.notifUrlUpdated || 'Subscription URL updated', 'success');
            } else {
                showNotification(t.notifSettingsSaved || 'Settings saved', 'success');
            }
            // Force fresh render to get updated metadata
            moduleRenderConfigs?.(true);
        } catch (err) {
            isSaving = false;
            if (saveBtn) saveBtn.classList.remove('opacity-50', 'pointer-events-none');
            if (cancelBtn) cancelBtn.classList.remove('opacity-50', 'pointer-events-none');
            showNotification(String(err), 'error');
        }
    });

    // Focus name input
    setTimeout(() => document.getElementById('edit-name')?.focus(), 100);
}

/**
 * @returns {string | null}
 */
function getFakeClientUA() {
    const storedEnabled = localStorage.getItem('fakeClientEnabled');
    const enabled = storedEnabled === 'true';
    if (!enabled) return null;
    const type = localStorage.getItem('fakeClientType');
    if (type === 'custom') {
        const custom = localStorage.getItem('fakeClientCustom');
        return custom ? custom : null;
    }
    return type || null;
}

/**
 * Resolve a UA prefix (from the per-subscription dropdown) to a full versioned UA string.
 * Uses latest client versions from the backend to build the full UA.
 * @param {string} prefix - e.g. 'clash-verge', 'mihomo-party', 'Flclash', 'Shadowrocket', or ''
 * @returns {Promise<string | null>} Full versioned UA or null for 'Use Global'
 */
async function resolvePerSubUA(prefix) {
    if (!prefix) return null;
    // Shadowrocket uses plain UA string (no version suffix)
    if (prefix === 'Shadowrocket') return 'Shadowrocket';
    try {
        /** @type {{verge: string, mihomo_party: string, flclash: string}} */
        const versions = await invoke(COMMANDS.GET_LATEST_CLIENT_VERSIONS);
        if (versions) {
            if (prefix === 'clash-verge') return versions.verge || prefix;
            if (prefix === 'mihomo-party') return versions.mihomo_party || prefix;
            if (prefix === 'Flclash') return versions.flclash || prefix;
        }
    } catch {
        // Fallback: return prefix as-is if version fetch fails
        return prefix;
    }
    return prefix;
}

/** @returns {string | null} */
function getSubscriptionUserAgent() {
    return getFakeClientUA();
}

/**
 * Initialize subscription management controls.
 *
 * @param {object} opts
 * @param {HTMLElement|null} opts.subAddBtn - The "Add Subscription" button.
 * @param {HTMLElement|null} opts.updateAllSubBtn - The "Update All Subscriptions" button.
 * @param {HTMLElement|null} opts.configsList - The configs list container.
 */
export function initSubscriptionSettings({
    subAddBtn,
    updateAllSubBtn,
    configsList,
}) {

    // ---- Subscription add ----
    if (subAddBtn) {
        subAddBtn.onclick = async () => {
            /** @type {any} */
            const t = /** @type {any} */ (translations)[appStore.get('currentLang')];
            const url = /** @type {string} */ (await showModal(t.addSubscription, t.urlPlaceholder || "Subscription URL"));
            if (!url) return;
            /** @type {any} */
            const t2 = /** @type {any} */ (translations)[appStore.get('currentLang')];
            showNotification(t2.notifDownloadingSub || "Downloading subscription...");
            try {
                const userAgent = getSubscriptionUserAgent();
                const name = extractNameFromUrl(url) || 'subscription';
                /** @type {any} */
                const invokeArgs = { url, name, overwrite: false };
                if (userAgent) {
                    invokeArgs.userAgent = userAgent;
                }
                /** @type {{name: string, message?: string}} */
                const savedConfig = await invoke(COMMANDS.DOWNLOAD_SUB, invokeArgs);
                const savedConfigName = savedConfig.name;

                invalidateConfigsCache();

                /** @type {any} */
                const subSettings = await invoke(COMMANDS.GET_SETTINGS);
                const currentConfig = subSettings.last_config || 'config.yaml';
                if (normalizeConfigName(savedConfigName) === normalizeConfigName(currentConfig)) {
                    abortLatencyTests();
                    const customArgs = subSettings.custom_args || [];
                    await restartCore(savedConfigName, customArgs);
                    await postRestartRecovery(savedConfigName);
                }

                /** @type {any} */
                const t3 = /** @type {any} */ (translations)[appStore.get('currentLang')];
                showNotification(t3.notifSubSuccess, 'success');
                renderConfigs();
            } catch (err) {
                const error = /** @type {Error} */ (err instanceof Error ? err : new Error(String(err)));
                /** @type {any} */
                const t4 = /** @type {any} */ (translations)[appStore.get('currentLang')];
                showNotification(`${t4.notifSubFailed}: ${error}`, 'error');
            }
        };
    }

    // ---- Update all subscriptions ----
    if (updateAllSubBtn) {
        updateAllSubBtn.onclick = async () => {
            /** @type {any} */
            const t = /** @type {any} */ (translations)[appStore.get('currentLang')];
            /** @type {any} */
            const configs = await invoke(COMMANDS.LIST_CONFIGS);
            const subConfigs = configs.filter(/** @param {any} c */ (c) => c.url_display);

            if (subConfigs.length === 0) {
                showNotification(t.notifNoSubToUpdate, 'info');
                return;
            }

            const icon = updateAllSubBtn.querySelector('svg');
            if (icon) icon.classList.add('animate-spin');
            updateAllSubBtn.classList.add('opacity-50', 'pointer-events-none');

            try {
                let successCount = 0;
                let failCount = 0;
                showNotification(t.notifUpdateCount.replace('{count}', String(subConfigs.length)));

                // Build batch items: only names needed, URLs resolved internally by backend
                const userAgent = getSubscriptionUserAgent();
                const batchItems = subConfigs.map(/** @param {any} c */ (c) => ({ name: c.name }));

                // Single batch call — no per-item rate limiting
                /** @type {Array<{name: string, success: boolean, error?: string}>} */
                const results = await invoke(COMMANDS.DOWNLOAD_SUB_BATCH, {
                    items: batchItems,
                    userAgent: userAgent || null,
                });

                for (const r of results) {
                    if (r.success) {
                        successCount++;
                    } else {
                        failCount++;
                        rulesLogger.error(`[settings] Failed to update ${r.name}: ${r.error || 'unknown'}`);
                    }
                }

                invalidateConfigsCache();

                /** @type {any} */
                const subSettings = await invoke(COMMANDS.GET_SETTINGS);
                const currentConfig = subSettings.last_config || 'config.yaml';
                const customArgs = subSettings.custom_args || [];
                const isCurrentConfigUpdated = results.some(r => r.success && normalizeConfigName(r.name) === normalizeConfigName(currentConfig));

                if (isCurrentConfigUpdated) {
                    abortLatencyTests();
                    await restartCore(currentConfig, customArgs);
                    await postRestartRecovery(currentConfig);
                }

                renderConfigs();

                if (failCount === 0) {
                    showNotification(t.notifUpdateAllComplete.replace('{success}', String(successCount)).replace('{fail}', String(failCount)), 'success');
                } else {
                    showNotification(t.notifUpdateAllComplete.replace('{success}', String(successCount)).replace('{fail}', String(failCount)), 'info');
                }
            } catch (err) {
                const error = /** @type {Error} */ (err instanceof Error ? err : new Error(String(err)));
                showNotification(error.toString(), 'error');
            } finally {
                if (icon) icon.classList.remove('animate-spin');
                updateAllSubBtn.classList.remove('opacity-50', 'pointer-events-none');
            }
        };
    }

    // ---- YAML-aware profile manipulation helpers ----

    /**
     * Parse profile values from a YAML block. Handles three formats:
     *   Flow array:   profile: [a, b]
     *   Block seq:    profile:\n    - a\n    - b
     *   Single value: profile: a
     * Returns { items: string[], startLine, endLine, indent } or null.
     */
    function parseProfileBlock(/** @type {string[]} */ lines, /** @type {number} */ profileLineIdx) {
        const header = lines[profileLineIdx];
        const hm = header.match(/^([ \t]*)profile\s*:\s*(.*)/);
        if (!hm) return null;
        const indent = hm[1];
        const rest = hm[2].trim();

        // Flow array: profile: [a, b]
        if (rest.startsWith('[')) {
            const items = rest.replace(/,\s*$/, '').slice(1, -1).split(',').map(s => s.trim()).filter(Boolean);
            return { items, startLine: profileLineIdx, endLine: profileLineIdx, indent };
        }

        // Single value: profile: a
        if (rest.length > 0 && !rest.startsWith('-') && !rest.startsWith('|') && !rest.startsWith('>')) {
            return { items: [rest], startLine: profileLineIdx, endLine: profileLineIdx, indent };
        }

        // Block sequence: profile:\n  - a\n  - b  (or empty: profile:\n  next_key:)
        const seqIndent = indent + '  '; // YAML standard: sequence items indented 2 more
        const items = [];
        let endLine = profileLineIdx;
        for (let i = profileLineIdx + 1; i < lines.length; i++) {
            const line = lines[i];
            // Check if this line is a sequence item under profile
            // Static regex captures indent + content; compare indent with startsWith
            // to preserve original behavior (allowed deeper indentation via \s*)
            // Use [ \t] instead of \s to avoid super-linear backtracking (SonarCloud)
            // Prefix-only pattern avoids (.+) backtracking (SonarCloud)
            const seqItemPrefix = line.match(/^([ \t]*)-[ \t]+/);
            if (seqItemPrefix && seqItemPrefix[1].startsWith(seqIndent)) {
                // Guard against empty items (e.g. "- " with no value) (Qodo)
                const itemValue = line.slice(seqItemPrefix[0].length).trim();
                if (itemValue) {
                    items.push(itemValue);
                    endLine = i;
                }
            } else if (line.match(/^\s*$/)) {
                // Blank line — skip but don't end
                continue;
            } else {
                // Non-sequence, non-blank line — end of block
                break;
            }
        }
        return { items, startLine: profileLineIdx, endLine, indent };
    }

    /**
     * Parse __when__ block from rule file content.
     * Returns { enabled: boolean, profiles: string[] } or null if no __when__.
     */
    function parseWhenBlock(/** @type {string} */ content) {
        if (!/__when__\s*:/i.test(content)) return null;

        const lines = content.split('\n');
        let inWhen = false;
        let whenIndent = 0;
        const result = { enabled: true, profiles: /** @type {string[]} */ ([]) };

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const trimmed = line.trim();

            // Enter __when__ block
            if (/^__when__\s*:/i.test(trimmed)) {
                inWhen = true;
                whenIndent = line.search(/\S/);
                // Check inline enabled: false (e.g., __when__: { enabled: false })
                const inline = trimmed.match(/enabled\s*:\s*(false|true)/i);
                if (inline) result.enabled = inline[1].toLowerCase() !== 'false';
                continue;
            }

            if (!inWhen) continue;

            // Exit when block ends (less indented or same level non-empty line)
            const currentIndent = line.search(/\S/);
            if (trimmed && currentIndent <= whenIndent) break;

            // Parse enabled field
            if (/^enabled\s*:/i.test(trimmed)) {
                result.enabled = !/false/i.test(trimmed);
                continue;
            }

            // Parse profile field
            const profileMatch = trimmed.match(/^profile\s*:\s*(.+)$/);
            if (profileMatch) {
                const value = profileMatch[1].trim();
                // Flow array: [a, b, c]
                if (value.startsWith('[')) {
                    const arr = value.slice(1, -1).split(',').map(s => s.trim()).filter(Boolean);
                    result.profiles.push(...arr);
                } else {
                    // Single value
                    result.profiles.push(value);
                }
                continue;
            }

            // Block sequence: - item
            if (trimmed.startsWith('- ')) {
                const item = trimmed.slice(2).trim();
                if (item) result.profiles.push(item);
            }
        }

        return result;
    }

    /**
     * Add a profile name to the __when__ block's profile field.
     * Handles flow array, block sequence, and single value formats.
     */
    function addProfileToWhen(/** @type {string} */ content, /** @type {string} */ profileName) {
        const lowerName = profileName.toLowerCase();
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
            const m = lines[i].match(/^\s*profile\s*:/);
            if (!m) continue;

            const parsed = parseProfileBlock(lines, i);
            if (!parsed) continue;

            // Already present?
            if (parsed.items.some(item => item.toLowerCase() === lowerName)) {
                return content;
            }

            parsed.items.push(profileName);

            // Rebuild: always output as flow array (simplest, unambiguous)
            const newLine = `${parsed.indent}profile: [${parsed.items.join(', ')}]`;
            const before = lines.slice(0, parsed.startLine);
            const after = lines.slice(parsed.endLine + 1);
            return [...before, newLine, ...after].join('\n');
        }
        return content;
    }

    /**
     * Remove a profile name from the __when__ block's profile field.
     * If no profiles remain, replaces with enabled: false.
     */
    function removeProfileFromWhen(/** @type {string} */ content, /** @type {string} */ profileName) {
        const lowerName = profileName.toLowerCase();
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
            const m = lines[i].match(/^\s*profile\s*:/);
            if (!m) continue;

            const parsed = parseProfileBlock(lines, i);
            if (!parsed) continue;

            const filtered = parsed.items.filter(item => item.toLowerCase() !== lowerName);

            let newLines;
            if (filtered.length === 0) {
                newLines = `${parsed.indent}enabled: false`;
            } else {
                newLines = `${parsed.indent}profile: [${filtered.join(', ')}]`;
            }

            const before = lines.slice(0, parsed.startLine);
            const after = lines.slice(parsed.endLine + 1);
            return [...before, newLines, ...after].join('\n');
        }
        return content;
    }

    // ---- Subscription card right-click context menu (rule library integration) ----

    /**
     * Show a context menu anchored at (x, y) for the given subscription card.
     *
     * @param {MouseEvent} e
     * @param {{ name: string, url_display?: string | null, last_updated?: number | null, auto_update_interval?: number | null, user_agent?: string | null }} configInfo
     */
    const showSubscriptionContextMenu = async (e, configInfo) => {
        e.preventDefault();
        e.stopPropagation();

        const t = /** @type {Record<string, string>} */ (/** @type {any} */ (translations)[appStore.get('currentLang')]);
        const name = configInfo.name;
        // Stem name for __when__.profile matching (must match get_current_profile() which uses file_stem)
        const profileStem = name.replace(/\.(yaml|yml)$/i, '');

        const { menu, scroll: menuScroll } = createContextMenuContainer(e);

        // --- "Edit" item ---
        const editItem = document.createElement('div');
        editItem.className = 'flex items-center gap-2 px-3 py-2 text-xs text-[var(--text-secondary)] hover:bg-accent/15 hover:text-accent cursor-pointer transition-colors';
        // eslint-disable-next-line no-unsanitized/property -- static SVG + values escaped via escapeHtml() // nosemgrep: js-innerhtml-assignment — verified safe, see eslint-disable above
        editItem.innerHTML = `<svg class="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg><span>${escapeHtml(t.edit || 'Edit')}</span>`;
        editItem.addEventListener('click', async (ev) => {
            ev.stopPropagation();
            removeContextMenu();
            showEditPanel({ name, url_display: configInfo.url_display, last_updated: configInfo.last_updated, auto_update_interval: configInfo.auto_update_interval, user_agent: configInfo.user_agent });
        });
        menuScroll.appendChild(editItem);

        // --- Separator ---
        const renameSep = document.createElement('div');
        renameSep.className = 'my-1 border-t border-[var(--zephyr-border-subtle)]';
        menuScroll.appendChild(renameSep);

        // --- "Extract Rules to Library" item ---
        const extractItem = document.createElement('div');
        extractItem.className = 'flex items-center gap-2 px-3 py-2 text-xs text-[var(--text-secondary)] hover:bg-accent/15 hover:text-accent cursor-pointer transition-colors';
        // eslint-disable-next-line no-unsanitized/property -- static SVG + values escaped via escapeHtml() // nosemgrep: js-innerhtml-assignment — verified safe, see eslint-disable above
        extractItem.innerHTML = `<svg class="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg><span>${escapeHtml(t.ruleLibrarySubscriptionExtract || 'Extract Rules to Library')}</span>`;
        extractItem.addEventListener('click', async (ev) => {
            ev.stopPropagation();
            removeContextMenu();
            try {
                const createdFile = await invoke(COMMANDS.RULE_EXTRACT_FROM_PROFILE, {
                    profileId: name,
                    name: name,
                });
                showNotification(`${t.ruleLibraryExtracted || 'Extracted'}: ${createdFile || name}`, 'success');
            } catch (err) {
                showNotification(String(err), 'error');
            }
        });
        menuScroll.appendChild(extractItem);

        // --- Separator ---
        const separator = document.createElement('div');
        separator.className = 'my-1 border-t border-[var(--zephyr-border-subtle)]';
        menuScroll.appendChild(separator);

        // --- "Extension Rules" submenu ---
        try {
            const [ruleFilesData, groupData, allConfigs] = await Promise.all([
                invoke(COMMANDS.RULE_LIST).catch(() => []),
                invoke(COMMANDS.RULE_GROUP_LIST).catch(() => ({ groups: [] })),
                invoke(COMMANDS.LIST_CONFIGS).catch(() => []),
            ]);

            const files = /** @type {{filename: string, rule_count: number, source: string}[]} */ (ruleFilesData || []);
            const groupsList = /** @type {{name: string, files: string[]}[]} */ ((groupData?.groups) || []);
            // All profile stems (for "exclude one profile" logic when unchecking global rules)
            const allProfileStems = (/** @type {any[]} */ (allConfigs || []))
                .map((c) => c.name.replace(/\.(yaml|yml)$/i, ''));

            if (files.length === 0) {
                const emptyItem = document.createElement('div');
                emptyItem.className = 'px-3 py-2 text-2xs text-[var(--text-tertiary)] italic';
                emptyItem.textContent = t.ruleLibraryNoRules || 'No rule files';
                menuScroll.appendChild(emptyItem);
            } else {
                // Build a map: filename -> group name (if any)
                const fileGroupMap = /** @type {Map<string, string>} */ (new Map());
                for (const g of groupsList) {
                    for (const f of g.files || []) {
                        fileGroupMap.set(f, g.name);
                    }
                }

                // Group files by their group
                const grouped = /** @type {Map<string, typeof files>} */ (new Map());
                const ungrouped = [];
                for (const f of files) {
                    const groupName = fileGroupMap.get(f.filename);
                    if (groupName) {
                        if (!grouped.has(groupName)) grouped.set(groupName, []);
                        grouped.get(groupName)?.push(f);
                    } else {
                        ungrouped.push(f);
                    }
                }

                // Helper: create a checkbox item for a rule file
                const createRuleItem = (/** @type {{filename: string, rule_count: number}} */ file) => {
                    const item = document.createElement('label');
                    item.className = 'flex items-center gap-2 px-3 py-1.5 text-xs text-[var(--text-secondary)] hover:bg-accent/10 hover:text-[var(--text-primary)] cursor-pointer transition-colors';

                    const checkbox = document.createElement('input');
                    checkbox.type = 'checkbox';
                    checkbox.className = 'w-3 h-3 rounded border-[var(--zephyr-border-default)] bg-[var(--zephyr-bg-input)] text-accent focus:ring-accent/50 shrink-0';
                    checkbox.checked = false;
                    checkbox.dataset.filename = file.filename;

                    // Check binding by parsing __when__ block from rule file.
                    // - __when__.enabled === false → unchecked (explicitly disabled)
                    // - __when__.profile contains current profile → checked
                    // - no __when__ → global rule, checked (assumes already applied)
                    invoke(COMMANDS.RULE_READ, { filename: file.filename })
                        .then((content) => {
                            const str = /** @type {string} */ (content || '');
                            const whenBlock = parseWhenBlock(str);
                            if (!whenBlock) {
                                // No __when__ → global rule, assume applied
                                checkbox.checked = true;
                                return;
                            }
                            if (whenBlock.enabled === false) {
                                checkbox.checked = false;
                                return;
                            }
                            // Use flat loop instead of .some() to reduce nesting (SonarCloud)
                            const normStem = profileStem.toLowerCase();
                            let profileFound = false;
                            for (const p of whenBlock.profiles) {
                                if (p.toLowerCase() === normStem) { profileFound = true; break; }
                            }
                            checkbox.checked = profileFound;
                        })
                        .catch(() => {});

                    checkbox.addEventListener('change', async (ev) => {
                        ev.stopPropagation();
                        // Remember target state and revert immediately to avoid false state
                        const targetChecked = checkbox.checked;
                        checkbox.checked = !targetChecked;

                        // Show spinner while processing
                        const spinner = document.createElement('span');
                        spinner.className = 'animate-spin ms-1 text-[var(--text-muted)]';
                        spinner.innerHTML = '<svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 2a10 10 0 0 1 10 10"/></svg>'; // nosemgrep: js-innerhtml-assignment — static HTML
                        item.appendChild(spinner);
                        checkbox.disabled = true;

                        try {
                            const currentContent = /** @type {string} */ (await invoke(COMMANDS.RULE_READ, { filename: file.filename }));

                            let newContent = currentContent;
                            const hasWhen = /__when__\s*:/i.test(newContent);
                            const hasProfile = /__when__\s*:\s*\{?[\s\S]*?profile\s*:/i.test(newContent);

                            rulesLogger.info(`[rule-toggle] file=${file.filename} target=${targetChecked} hasWhen=${hasWhen} hasProfile=${hasProfile} profileStem=${profileStem}`);
                            rulesLogger.info(`[rule-toggle] original content (first 500 chars):\n`, currentContent.slice(0, 500));

                            if (targetChecked) {
                                if (hasWhen) {
                                    // Remove stale enabled: false
                                    newContent = newContent.replace(/^[ \t]*enabled\s*:\s*false\s*?\n?/gim, '');
                                    if (hasProfile) {
                                        newContent = addProfileToWhen(newContent, profileStem);
                                    } else {
                                        // __when__ exists but no profile line — insert profile after __when__ header line
                                        const lines = newContent.split('\n');
                                        let insertIdx = -1;
                                        for (let i = 0; i < lines.length; i++) {
                                            if (/^__when__\s*:/i.test(lines[i])) {
                                                insertIdx = i + 1;
                                                break;
                                            }
                                        }
                                        if (insertIdx >= 0) {
                                            lines.splice(insertIdx, 0, `  profile: ${profileStem}`);
                                            newContent = lines.join('\n');
                                        }
                                    }
                                } else {
                                    newContent = `__when__:\n  profile: ${profileStem}\n\n${newContent}`;
                                }
                            } else if (hasProfile) {
                                newContent = removeProfileFromWhen(newContent, profileStem);
                            } else if (hasWhen) {
                                // Has __when__ but no profile line — add enabled: false to disable
                                newContent = newContent.replace(/(__when__\s*:\s*\n)/i, '$1  enabled: false\n');
                            } else {
                                // No __when__ at all — rule applies to all profiles.
                                // Add __when__ with all profiles EXCEPT the current one,
                                // so the rule still works for other profiles.
                                const normalizedStem = profileStem.toLowerCase();
                                const otherProfiles = [];
                                for (const p of allProfileStems) {
                                    if (p.toLowerCase() !== normalizedStem) otherProfiles.push(p);
                                }
                                if (otherProfiles.length > 0) {
                                    newContent = `__when__:\n  profile:\n${otherProfiles.map((p) => `    - ${p}`).join('\n')}\n\n${newContent}`;
                                } else {
                                    // Only one profile exists — disable the rule entirely
                                    newContent = `__when__:\n  enabled: false\n\n${newContent}`;
                                }
                            }

                            await invoke(COMMANDS.RULE_UPDATE, { filename: file.filename, content: newContent });
                            rulesLogger.info(`[rule-toggle] newContent (first 500 chars):\n`, newContent.slice(0, 500));
                            rulesLogger.info(`[rule-toggle] RULE_UPDATE done, calling prism.rebuild() ...`);
                            // Use rebuild instead of apply to ensure a clean base config.
                            // A plain apply() reads the existing run_config.yaml (which may
                            // contain rules from previously-enabled patches) and only appends
                            // new rules — it never removes stale ones. rebuild() resets the
                            // base to the original subscription profile first, so skipped/
                            // disabled patches produce no residual rules.
                            const rebuildResult = await prism.rebuild();
                            rulesLogger.info(`[rule-toggle] prism.rebuild() OK`, rebuildResult);
                            // Only update visual state after rebuild succeeds
                            checkbox.checked = targetChecked;
                            showNotification(
                                targetChecked
                                    ? `${t.ruleLibraryApplied || 'Applied'}: ${file.filename}`
                                    : `${t.ruleLibraryRemoved || 'Removed'}: ${file.filename}`,
                                'success',
                            );
                        } catch (err) {
                            rulesLogger.error(`[rule-toggle] FAILED`, err);
                            // Restore to previous state (opposite of target)
                            checkbox.checked = !targetChecked;
                            showNotification(String(err), 'error');
                        } finally {
                            checkbox.disabled = false;
                            spinner.remove();
                        }
                    });

                    const label = document.createElement('span');
                    label.className = 'truncate';
                    label.textContent = file.filename.replace(/\.yaml\.prism\.yaml$/i, '').replace(/\.(yaml|yml)$/i, '');

                    const count = document.createElement('span');
                    count.className = 'ms-auto text-2xs text-[var(--text-tertiary)] shrink-0';
                    count.textContent = String(file.rule_count || 0);

                    item.appendChild(checkbox);
                    item.appendChild(label);
                    item.appendChild(count);
                    return item;
                };

                // Render groups
                for (const [groupName, groupFiles] of grouped) {
                    const groupHeader = document.createElement('div');
                    groupHeader.className = 'flex items-center gap-1.5 px-3 py-1.5 text-2xs text-[var(--text-muted)] uppercase tracking-wider font-bold';
                    // eslint-disable-next-line no-unsanitized/property -- values escaped via escapeHtml() // nosemgrep: js-innerhtml-assignment — verified safe, see eslint-disable above
                    groupHeader.innerHTML = `<svg class="w-3 h-3 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>${escapeHtml(groupName)}`;
                    menuScroll.appendChild(groupHeader);

                    for (const f of groupFiles) {
                        menuScroll.appendChild(createRuleItem(f));
                    }
                }

                // Render ungrouped files
                if (ungrouped.length > 0 && grouped.size > 0) {
                    const sep = document.createElement('div');
                    sep.className = 'my-1 border-t border-[var(--zephyr-border-subtle)]';
                    menuScroll.appendChild(sep);
                }
                for (const f of ungrouped) {
                    menuScroll.appendChild(createRuleItem(f));
                }
            }
        } catch {
            // Silently skip rule list on error
        }

        document.body.appendChild(menu);
        attachContextMenuCloseHandlers(menu);
    };

    // ---- Config management (renderConfigs) ----
    /** @type {number} Render revision — incremented to invalidate stale in-flight renders */
    let _renderRev = 0;

    async function renderConfigs(forceFresh = false) {
        if (!configsList) return;

        const rev = ++_renderRev;

        const cfgSettings = forceFresh
            ? await invoke(COMMANDS.GET_SETTINGS)
            : await getSettingsCached();
        const configs = forceFresh
            ? await invoke(COMMANDS.LIST_CONFIGS)
            : await getConfigsCached();

        // A newer render or destroy() has superseded this call — bail out.
        if (rev !== _renderRev) return;

        const currentConfig = cfgSettings.last_config || 'config.yaml';
        const customArgs = cfgSettings.custom_args || [];
        const configOrder = cfgSettings.config_order || [];
        /** @type {any} */
        const t = /** @type {any} */ (translations)[appStore.get('currentLang')];

        // Sort configs by saved order; new configs appear at the end
        const sortedConfigs = [...configs].sort((a, b) => {
            const idxA = configOrder.indexOf(a.name);
            const idxB = configOrder.indexOf(b.name);
            if (idxA === -1 && idxB === -1) return 0;
            if (idxA === -1) return 1;
            if (idxB === -1) return -1;
            return idxA - idxB;
        });

        configsList.replaceChildren();

        // Mouse-based drag reorder (HTML5 DnD unreliable in Tauri WebView)
        // Bind document-level listeners only once
        if (!(/** @type {HTMLElement & {_dragBound?: boolean}} */ (configsList))._dragBound) {
            /** @type {HTMLElement & {_dragBound?: boolean}} */ (configsList)._dragBound = true;
            /** @type {any} */
            let dragState = null;

            configsList.addEventListener('mousedown', (e) => {
                if (!(e.target instanceof Element)) return;
                const card = /** @type {HTMLElement} */ (e.target.closest('[data-config-name]'));
                if (!card || e.button !== 0) return;
                dragState = { el: card, name: card.dataset.configName, startY: e.clientY, moved: false };
            });

            // iOS-style live reorder: cards slide to make room
            const gap = 12;

            document.addEventListener('mousemove', (e) => {
                if (!dragState) return;
                if (!dragState.moved && Math.abs(e.clientY - dragState.startY) < 5) return;

                // First move - create floating clone and placeholder
                if (!dragState.moved) {
                    dragState.moved = true;
                    const rect = dragState.el.getBoundingClientRect();
                    dragState.elHeight = rect.height;
                    dragState.el.style.opacity = '0';
                    dragState.el.style.pointerEvents = 'none';

                    // Create floating clone that follows mouse exactly
                    const clone = dragState.el.cloneNode(true);
                    clone.style.cssText = `
                        position: fixed;
                        left: ${rect.left}px;
                        top: ${rect.top}px;
                        width: ${rect.width}px;
                        pointer-events: none;
                        z-index: 1000;
                        opacity: 0.95;
                        transform: scale(1.05);
                        box-shadow: 0 20px 40px rgba(0,0,0,0.3), 0 0 0 1px rgba(124,139,160,0.2);
                        transition: transform 0.1s ease;
                    `;
                    document.body.appendChild(clone);
                    dragState.clone = clone;
                    dragState.offsetY = e.clientY - rect.top;
                    dragState.currentIndex = [...configsList.children].indexOf(dragState.el);
                }

                // Move clone with mouse (no spring - direct follow for responsiveness)
                const cloneY = e.clientY - dragState.offsetY;
                dragState.clone.style.top = cloneY + 'px';

                // Calculate which position we're hovering over
                const cards = /** @type {HTMLElement[]} */ ([...configsList.querySelectorAll('[data-config-name]')]);
                const listRect = configsList.getBoundingClientRect();
                const relativeY = e.clientY - listRect.top + configsList.scrollTop;

                let newIndex = 0;
                for (let i = 0; i < cards.length; i++) {
                    const card = cards[i];
                    if (card === dragState.el) continue;
                    const cardRect = card.getBoundingClientRect();
                    const cardMid = cardRect.top + cardRect.height / 2 - listRect.top + configsList.scrollTop;
                    if (relativeY > cardMid) {
                        newIndex = i + (cards.indexOf(card) < dragState.currentIndex ? 1 : 0);
                    }
                }
                dragState.targetIndex = newIndex;

                // Animate all cards to their new positions
                cards.forEach((card, i) => {
                    if (card === dragState.el) return;

                    // Calculate visual offset based on placeholder position
                    let offset = 0;
                    if (dragState.currentIndex < i && i <= newIndex) {
                        // Card is above placeholder, needs to slide up
                        offset = -(dragState.elHeight + gap);
                    } else if (newIndex <= i && i < dragState.currentIndex) {
                        // Card is below placeholder, needs to slide down
                        offset = dragState.elHeight + gap;
                    }

                    card.style.transform = `translateY(${offset}px)`;
                    card.style.transition = 'transform 0.2s cubic-bezier(0.2, 0, 0.2, 1)';
                });

                dragState.targetIndex = newIndex;
            });

            document.addEventListener('mouseup', async (e) => {
                if (!dragState) return;
                const { el, moved, clone, targetIndex, currentIndex } = dragState;
                dragState = null;

                if (!moved) {
                    // Just a click, restore and exit
                    el.style.opacity = '';
                    el.style.pointerEvents = '';
                    return;
                }

                e.stopImmediatePropagation();

                if (clone) {
                    const cards = /** @type {HTMLElement[]} */ ([...configsList.querySelectorAll('[data-config-name]')]);
                    const targetCard = cards[targetIndex];

                    if (targetCard && targetCard !== el) {
                        // 1. First, clear all transforms so cards are at their natural positions
                        //    (clone still covers the visual gap)
                        cards.forEach(c => {
                            c.style.transition = 'none';
                            c.style.transform = '';
                        });

                        // 2. Now move DOM (cards are at natural positions)
                        const insertBeforeEl = targetIndex > currentIndex
                            ? targetCard.nextSibling
                            : targetCard;
                        if (insertBeforeEl) {
                            configsList.insertBefore(el, insertBeforeEl);
                        } else {
                            configsList.appendChild(el);
                        }

                        // 3. Animate clone to el's new natural position
                        const elFinalRect = el.getBoundingClientRect();
                        const cloneRect = clone.getBoundingClientRect();
                        const deltaY = elFinalRect.top - cloneRect.top;

                        const animation = clone.animate([
                            { transform: 'translateY(0) scale(1.05)', opacity: 0.95 },
                            { transform: `translateY(${deltaY}px) scale(1)`, opacity: 1 }
                        ], {
                            duration: 150,
                            easing: 'cubic-bezier(0.25, 0.1, 0.25, 1)',
                            fill: 'forwards'
                        });

                        animation.onfinish = async () => {
                            // 4. Clone arrived at el's position — instant handoff
                            el.style.opacity = '';
                            el.style.pointerEvents = '';
                            clone.remove();

                            // 5. Save order (with error handling)
                            try {
                                const saveCards = /** @type {HTMLElement[]} */ ([...configsList.querySelectorAll('[data-config-name]')]);
                                const newOrder = saveCards.map(c => c.dataset.configName).filter((/** @type {string|undefined} */ name) => name !== undefined);
                                const s = await invoke(COMMANDS.GET_SETTINGS);
                                s.config_order = newOrder;
                                await invoke(COMMANDS.SAVE_SETTINGS, { settings: s });
                                invalidateSettingsCache();
                            } catch (err) {
                                showNotification(String(err), 'error');
                                await renderConfigs(true);
                            }
                        };
                    } else {
                        // No valid target - snap back
                        const startRect = el.getBoundingClientRect();
                        const cloneRect = clone.getBoundingClientRect();
                        const deltaY = startRect.top - cloneRect.top;

                        clone.animate([
                            { transform: 'translateY(0) scale(1.05)' },
                            { transform: `translateY(${deltaY}px) scale(1)` }
                        ], {
                            duration: 200,
                            easing: 'cubic-bezier(0.2, 0, 0.2, 1)'
                        }).onfinish = () => {
                            clone.remove();
                            el.style.opacity = '';
                            el.style.pointerEvents = '';
                            cards.forEach(c => {
                                c.style.transform = '';
                                c.style.transition = '';
                            });
                        };
                    }
                }
            }, true);
        }

        sortedConfigs.forEach((/** @type {any} */ configInfo) => {
            const name = configInfo.name;
            const isCurrent = name === currentConfig;

            const item = document.createElement('div');
            item.className = `glass-card flex flex-col p-4 transition-all group cursor-pointer relative ${isCurrent ? 'ring-1 ring-accent/50 shadow-[0_0_20px_rgba(var(--accent-rgb),0.2)]' : 'hover:shadow-lg'}`;
            item.dataset.configName = name;

            const row = document.createElement('div');
            row.className = "flex items-center justify-between";

            const left = document.createElement('div');
            left.className = 'flex items-center gap-3 pointer-events-none';

            const dot = document.createElement('div');
            dot.className = `w-2 h-2 rounded-full ${isCurrent ? 'bg-accent shadow-[0_0_8px_var(--accent-glow)]' : 'bg-[var(--text-tertiary)]'}`;

            const label = document.createElement('span');
            label.className = `text-xs transition-colors ${isCurrent ? 'font-bold text-[var(--text-primary)]' : 'text-[var(--text-secondary)]'}`;
            label.textContent = name.replace(/\.(yaml|yml)$/i, '');

            left.appendChild(dot);
            left.appendChild(label);

            const actions = document.createElement('div');
            actions.className = 'flex items-center gap-2 transition-opacity opacity-0 group-hover:opacity-100';

            // Delete button
            const delBtn = document.createElement('button');
            delBtn.className = 'btn-delete-icon';
            // eslint-disable-next-line no-unsanitized/property -- static SVG constant
            delBtn.innerHTML = SVG_ICONS.trash; // nosemgrep: js-innerhtml-assignment — verified safe, see eslint-disable above
            delBtn.title = t.delete;
            delBtn.onclick = async (e) => {
                e.stopPropagation();
                e.preventDefault();

                if (isCurrent) {
                    showNotification(t.cannotDeleteActive || 'Cannot delete the active configuration', 'warning');
                    return;
                }

                const confirmed = await showConfirmModal(
                    t.delete || 'Delete',
                    t.confirmDelete || `Are you sure you want to delete "${name}"?`
                );
                if (!confirmed) return;

                try {
                    await invoke(COMMANDS.DELETE_CONFIG, { name });
                    invalidateConfigsCache();
                    showNotification(t.notifDeleteSuccess, 'success');
                    renderConfigs();
                } catch (err) {
                    const error = /** @type {Error} */ (err instanceof Error ? err : new Error(String(err)));
                    showNotification(`${t.notifDeleteFailed}: ${error}`, 'error');
                }
            };

            // Update button (only if has URL)
            if (configInfo.url_display) {
                const updateBtn = document.createElement('button');
                updateBtn.type = 'button';
                updateBtn.className = 'p-1.5 rounded-md hover:bg-accent/20 text-[var(--text-muted)] hover:text-accent transition-colors';
                // eslint-disable-next-line no-unsanitized/property -- static SVG constant
                updateBtn.innerHTML = SVG_ICONS.refresh; // nosemgrep: js-innerhtml-assignment — verified safe, see eslint-disable above
                updateBtn.title = t.update;
                updateBtn.setAttribute('aria-label', t?.update || 'Update');
                updateBtn.onclick = async (e) => {
                    e.stopPropagation();
                    updateBtn.classList.add('animate-spin');
                    try {
                        // Prefer per-subscription UA, fall back to global fake-client UA
                        const userAgent = configInfo.user_agent || getSubscriptionUserAgent();
                        /** @type {any} */
                        const invokeArgs = { name: configInfo.name, overwrite: true };
                        if (userAgent) {
                            invokeArgs.userAgent = userAgent;
                        }
                        await invoke(COMMANDS.DOWNLOAD_SUB, invokeArgs);
                        invalidateConfigsCache();
                        if (isCurrent) {
                            abortLatencyTests();
                            const cfgCustomArgs = cfgSettings.custom_args || [];
                            await restartCore(configInfo.name, cfgCustomArgs);
                            await postRestartRecovery(configInfo.name);
                        }
                        showNotification(t.notifSubUpdateSuccess || t.notifSubSuccess, 'success');
                        renderConfigs();
                    } catch (err) {
                        const error = /** @type {Error} */ (err instanceof Error ? err : new Error(String(err)));
                        showNotification(`${t.notifSubFailed}: ${error}`, 'error');
                    } finally {
                        updateBtn.classList.remove('animate-spin');
                    }
                };
                actions.appendChild(updateBtn);
            }

            actions.appendChild(delBtn);

            const switchConfig = async () => {
                if (isCurrent || appStore.get('isNetworkUpdating')) return;

                appStore.set('isNetworkUpdating', true);
                item.classList.add('opacity-50', 'pointer-events-none');

                try {
                    const result = await switchToConfig(name, customArgs);
                    // 只在没有回退时显示成功通知（回退时已显示警告）
                    if (!result.fallbackOccurred) {
                        showNotification(t.configSuccess, 'success');
                    }
                    await renderConfigs();
                } catch (err) {
                    const error = /** @type {Error} */ (err instanceof Error ? err : new Error(String(err)));
                    showNotification(error.toString(), 'error');
                } finally {
                    appStore.set('isNetworkUpdating', false);
                    item.classList.remove('opacity-50', 'pointer-events-none');
                }
            };

            item.onclick = switchConfig;

            // Right-click context menu for rule library integration
            item.addEventListener('contextmenu', (e) => {
                showSubscriptionContextMenu(e, configInfo);
            });

            row.appendChild(left);
            row.appendChild(actions);
            item.appendChild(row);

            // SubInfo (Traffic usage)
            if (configInfo.sub_info) {
                const parts = configInfo.sub_info.split(';').map(/** @param {string} s */ (s) => s.trim());
                let upload = 0, download = 0, total = 0;
                parts.forEach(/** @param {string} p */ (p) => {
                    if (p.startsWith('upload=')) upload = parseInt(p.split('=')[1], 10) || 0;
                    if (p.startsWith('download=')) download = parseInt(p.split('=')[1], 10) || 0;
                    if (p.startsWith('total=')) total = parseInt(p.split('=')[1], 10) || 0;
                });

                if (total > 0) {
                    const used = upload + download;
                    const percentage = Math.min(100, Math.max(0, (used / total) * 100));

                    const usageContainer = document.createElement('div');
                    usageContainer.className = 'mt-3 mb-1 w-full';

                    const textRow = document.createElement('div');
                    const labelId = generateDomId('sub-usage-label');
                    textRow.id = labelId;
                    textRow.className = 'flex justify-between text-2xs text-[var(--text-muted)] mb-1.5 px-0.5 uppercase tracking-wider font-bold';
                    // eslint-disable-next-line no-unsanitized/property -- values from internal formatFileSize() + i18n keys
                    textRow.innerHTML = '<span>' + formatFileSize(used) + ' ' + (t?.usedSpace || 'used') + '</span><span>' + formatFileSize(total) + ' ' + (t?.totalSpace || 'total') + '</span>'; // nosemgrep: js-innerhtml-assignment — verified safe, see eslint-disable above

                    const barBg = document.createElement('div');
                    barBg.className = 'h-1.5 w-full bg-[var(--zephyr-bg-input)] rounded-full overflow-hidden border border-[var(--zephyr-border-subtle)]';

                    const barFill = document.createElement('div');
                    const clampedPercentage = isNaN(percentage) || !isFinite(percentage) ? 0 : Math.max(0, Math.min(100, percentage));
                    barFill.className = `h-full rounded-full transition-[width] duration-[var(--zephyr-time-page)] ${clampedPercentage > 90 ? 'bg-danger' : 'bg-accent'}`;
                    barFill.style.width = `${clampedPercentage}%`;

                    barBg.setAttribute('role', 'progressbar');
                    barBg.setAttribute('aria-labelledby', labelId);
                    barBg.setAttribute('aria-valuenow', String(Math.round(clampedPercentage)));
                    barBg.setAttribute('aria-valuemin', '0');
                    barBg.setAttribute('aria-valuemax', '100');
                    barBg.appendChild(barFill);
                    usageContainer.appendChild(textRow);
                    usageContainer.appendChild(barBg);
                    item.appendChild(usageContainer);
                }
            }

            // URL and last updated time in same row
            const t3 = (/** @type {Record<string, any>} */ (translations))[appStore.get('currentLang')] || {};
            const lastUpdatedText = formatLastUpdated(configInfo.last_updated, t3);
            const hasUrl = !!configInfo.url_display;
            const hasTime = lastUpdatedText !== (t3.lastUpdatedNever || 'Never');
            
            if (hasUrl || hasTime) {
                const infoRow = document.createElement('div');
                infoRow.className = 'flex items-center justify-between mt-1 gap-2';
                
                if (hasUrl) {
                    const urlLabel = document.createElement('div');
                    urlLabel.className = 'text-2xs text-[var(--text-tertiary)] truncate flex-1';
                    urlLabel.textContent = configInfo.url_display;
                    infoRow.appendChild(urlLabel);
                }
                
                if (hasTime) {
                    const timeEl = document.createElement('div');
                    timeEl.className = 'text-2xs text-[var(--text-tertiary)] shrink-0';
                    timeEl.textContent = lastUpdatedText;
                    infoRow.appendChild(timeEl);
                }
                
                item.appendChild(infoRow);
            }

            configsList.appendChild(item);
        });

        // Sync tray menu after rendering configs
        try {
            const { updateTrayMenu } = await import('../tray.js');
            updateTrayMenu(true).catch(() => {});
        } catch {}
    }

    // Initial render
    renderConfigs();

    // Auto-refresh when config changes (e.g. subscription switch from console).
    // Skip the expensive re-render when the settings list is not visible,
    // but still invalidate caches so data is fresh when the user returns.
    const _configUpdatedUnsub = Bus.on(Events.CONFIG_UPDATED, () => {
        invalidateSettingsCache();
        invalidateConfigsCache();
        const isVisible = configsList && !configsList.closest('.hidden');
        if (!isVisible) {
            _renderRev++; // Invalidate any in-flight render even when hidden.
            return;
        }
        renderConfigs().catch((e) => rulesLogger.warn('[settings] renderConfigs failed after CONFIG_UPDATED', e));
    });

    // Set module-level reference for use by showEditPanel
    moduleRenderConfigs = renderConfigs;

    return {
        renderConfigs,
        destroy: () => {
            _renderRev++; // Invalidate any in-flight render.
            _configUpdatedUnsub();
        },
    };
}