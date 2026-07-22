// @ts-check
/**
 * Settings page module.
 * Extracted from ui.js -- contains the entire settings initialization,
 * theme handling, config/subscription/tunnel management, fake client,
 * UWP exemption, DNS config, and advanced settings navigation.
 *
 * All dependencies are explicitly imported; no reliance on window globals
 * for cross-module state (except where the original code intentionally
 * uses window for Tauri event unlisten handles).
 */

import {
    invoke,
    listen,
    openUrl,
    restartCore,
    abortLatencyTests,
    isAutoStartEnabled,
    enableAutoStart,
    disableAutoStart,
    openConfigFolder,
    openPrismFolder,
    setSecret,
    setBaseUrl,
} from '../api.js';
import { setWsSecret, setWsBaseUrl, connectTraffic } from '../websocket.js';
import { updateTrafficData } from '../modules/traffic-chart.js';
import { translations, setLanguage } from '../i18n.js';
import { debounce } from '../utils/debounce.js';
import { settingsLogger } from '../utils/logger.js';
import { showNotification, showConfirmModal, showUpdateNotesModal } from './notifications.js';
import { applyTheme } from './theme.js';
import { appStore } from './state.js';
import { Bus, Events } from './events.js';
import { invalidateSettingsCache } from './cache.js';
import { postRestartRecovery } from './lifecycle.js';
import { saveSetting, saveSettings } from './settings-helpers.js';
import { initNetworkOptim } from './network-optim.js';
import {
    DEFAULT_DNS_CONFIG,
    isValidIPv6,
    isValidDns,
    getDnsConfig,
    buildDnsRewritePayload,
    applyDnsRewrite,
    initDnsRewriteToggle,
} from './dns-shared.js';
import { toError } from '../types/guards.js';
import { COMMANDS } from '@zephyr/shared';
import { createFocusTrap } from '../utils/focus-trap.js';
import { createStatusRing } from './status-ring.js';
import * as prism from './prism.js';

// The following modules have not yet been extracted from ui.js.
// We import them from ui.js for now; when they are extracted, these
// imports will be updated to point to their own files.
import { switchPage } from './navigation.js';
import { initCustomDropdown } from './dropdown.js';
import { syncCoreConfig, startSmartAutoTest, stopSmartAutoTest } from './proxies.js';

// Settings submodules
import { initThemeSettings } from './settings/theme.js';
import { initTunnelSettings } from './settings/tunnels.js';
import { initSubscriptionSettings } from './settings/subscriptions.js';

let __langDropdown = null;
/** @type {(() => void) | null} */
let _dropUnlisten = null;

// ---------------------------------------------------------------------------
//  Utility: extract a human-readable name from a subscription URL
// ---------------------------------------------------------------------------
/**
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

// ---------------------------------------------------------------------------
//  Fake client helpers
// ---------------------------------------------------------------------------
/** @returns {string | null} */
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

/** @returns {string | null} */
function getSubscriptionUserAgent() {
    return getFakeClientUA();
}

/**
 * Sync the current fake client UA to backend settings
 * so the subscription scheduler can use it for auto-updates.
 * Uses atomic field-level update to avoid Read-Modify-Write race.
 */
async function syncUserAgentToBackend() {
    try {
        const ua = getSubscriptionUserAgent();
        await invoke(COMMANDS.UPDATE_SUBSCRIPTION_USER_AGENT, { userAgent: ua });
    } catch { /* ignore */ }
}

/** Debounced version for input events (avoids IPC on every keystroke). */
const debouncedSyncUA = debounce(() => syncUserAgentToBackend(), 500);

// ---------------------------------------------------------------------------
//  Copy Proxy Env Settings
// ---------------------------------------------------------------------------

/**
 * Initialize the "Copy Proxy Env" settings row:
 * - Copy button: copies env vars in the configured format
 * - Gear button: opens a modal to select the shell format
 */
function initCopyEnvSettings() {
    const copyBtn = document.getElementById('copy-env-btn');
    const formatBtn = document.getElementById('copy-env-format-btn');

    /** @type {() => Record<string, any>} */
    const getT = () => /** @type {any} */ (translations)[appStore.get('currentLang')] ?? {};

    // --- Copy button ---
    copyBtn?.addEventListener('click', async () => {
        try {
            // Clear any pending restore timeout to prevent text getting stuck
            if (copyBtn.dataset._copyTimeout) {
                clearTimeout(Number(copyBtn.dataset._copyTimeout));
                delete copyBtn.dataset._copyTimeout;
            }
            const settings = await invoke(COMMANDS.GET_SETTINGS);
            const { generateProxyEnvVars, copyToClipboard, resolveEnvFormat } = await import('./tray.js');
            const format = resolveEnvFormat(settings.copy_env_format);
            const { getConfig } = await import('../api.js');
            const currentConfig = /** @type {any} */ (await getConfig());
            const port = currentConfig?.['mixed-port'] || currentConfig?.port || currentConfig?.['socks-port'] || 7890;
            const text = generateProxyEnvVars(format, port);
            await copyToClipboard(text);
            const t = getT();
            // Visual feedback: briefly change button text (target span to preserve i18n)
            const textSpan = copyBtn.querySelector('span') || copyBtn;
            // Store original text only on first click (not during "Copied" state)
            if (!copyBtn.dataset._originalText) {
                copyBtn.dataset._originalText = textSpan.textContent || '';
            }
            textSpan.textContent = t.copyEnvCopied || 'Copied';
            copyBtn.style.color = 'var(--accent-primary, #6366f1)';
            const timeoutId = setTimeout(() => {
                textSpan.textContent = copyBtn.dataset._originalText || '';
                copyBtn.style.color = '';
                delete copyBtn.dataset._originalText;
                delete copyBtn.dataset._copyTimeout;
            }, 1500);
            copyBtn.dataset._copyTimeout = String(timeoutId);
        } catch (err) {
            settingsLogger.error('[copy-env] Failed to copy:', err);
        }
    });

    // --- Format selection modal (gear icon) ---
    formatBtn?.addEventListener('click', async () => {
        // Clean up any existing modal and its Escape listener
        const existingModal = document.getElementById('copy-env-format-modal');
        if (existingModal) {
            const existingHandler = /** @type {any} */ (existingModal)._escapeHandler;
            if (existingHandler) document.removeEventListener('keydown', existingHandler);
            existingModal.remove();
        }

        const t = getT();
        const settings = await invoke(COMMANDS.GET_SETTINGS);
        const { resolveEnvFormat: resolveEnvFormatImported } = await import('./tray.js');
        const currentFormat = resolveEnvFormatImported(settings.copy_env_format);

        const formats = [
            { key: 'bash', label: 'Bash / Zsh' },
            { key: 'fish', label: 'Fish' },
            { key: 'cmd', label: 'CMD' },
            { key: 'powershell', label: 'PowerShell' },
            { key: 'nushell', label: 'Nushell' },
        ];

        const modal = document.createElement('div');
        modal.id = 'copy-env-format-modal';
        modal.className = 'fixed inset-0 z-[var(--z-modal)] flex items-center justify-center bg-[var(--zephyr-bg-overlay)] backdrop-blur-md';
        // eslint-disable-next-line no-unsanitized/property -- i18n translation keys
        modal.innerHTML = ` // nosemgrep: js-innerhtml-assignment — verified safe, see eslint-disable above
            <div class="glass-card w-[360px] p-6 space-y-4">
                <div class="flex items-center justify-between">
                    <h3 class="text-sm font-bold text-[var(--text-primary)]">${t.copyEnvFormat || 'Shell Format'}</h3>
                    <button id="copy-env-modal-close" class="text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors">
                        <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
                    </button>
                </div>
                <div class="space-y-1">
                    ${formats.map(f => `
                        <button type="button" class="copy-env-format-option w-full flex items-center justify-between px-3 py-2.5 rounded-lg text-left transition-colors hover:bg-[var(--zephyr-bg-muted)] ${f.key === currentFormat ? 'bg-[var(--zephyr-bg-muted)]' : ''}" data-format="${f.key}" aria-pressed="${f.key === currentFormat ? 'true' : 'false'}">
                            <span class="text-xs text-[var(--text-primary)]">${f.label}</span>
                            ${f.key === currentFormat ? '<svg class="w-4 h-4 text-accent" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>' : ''}
                        </button>
                    `).join('')}
                </div>
            </div>
        `;

        document.body.appendChild(modal);
        document.body.style.overflow = 'hidden';

        // Animate in
        requestAnimationFrame(() => {
            const panel = modal.querySelector('.glass-card');
            if (panel instanceof HTMLElement) {
                panel.style.transform = 'scale(0.96)';
                panel.style.opacity = '0';
                requestAnimationFrame(() => {
                    panel.style.transition = 'all 0.25s cubic-bezier(0.16, 1, 0.3, 1)';
                    panel.style.transform = 'scale(1)';
                    panel.style.opacity = '1';
                });
            }
        });

        // Escape key to close modal
        /** @param {KeyboardEvent} e */
        let onEscape = /** @type {(e: KeyboardEvent) => void} */ (() => {});

        const closeModalInner = () => {
            document.body.style.overflow = '';
            document.removeEventListener('keydown', onEscape);
            const panel = modal.querySelector('.glass-card');
            if (panel instanceof HTMLElement) {
                panel.style.transition = 'all 0.15s ease-in';
                panel.style.transform = 'scale(0.96)';
                panel.style.opacity = '0';
                setTimeout(() => modal.remove(), 150);
            } else {
                modal.remove();
            }
        };

        onEscape = (e) => { if (e.key === 'Escape') closeModalInner(); };
        document.addEventListener('keydown', onEscape);
        // Store handler on modal for cleanup if modal is removed directly
        /** @type {any} */ (modal)._escapeHandler = onEscape;

        document.getElementById('copy-env-modal-close')?.addEventListener('click', closeModalInner);
        modal.addEventListener('click', (e) => { if (e.target === modal) closeModalInner(); });

        // Format selection
        modal.querySelectorAll('.copy-env-format-option').forEach(btn => {
            btn.addEventListener('click', async () => {
                const selectedFormat = btn.getAttribute('data-format');
                if (!selectedFormat) return;
                try {
                    await invoke(COMMANDS.PATCH_SETTINGS, { patch: { copy_env_format: selectedFormat } });
                } catch (err) {
                    settingsLogger.error('[copy-env] Failed to save format:', err);
                }
                closeModalInner();
            });
        });
    });
}

// ---------------------------------------------------------------------------
//  initUwpExemption
// ---------------------------------------------------------------------------
export function initUwpExemption() {
    const exemptBtn = document.getElementById('exempt-uwp-btn');
    const spinner = document.getElementById('uwp-spinner');

    if (exemptBtn) {
        if (!navigator.userAgent.includes('Windows')) {
            const container = document.getElementById('uwp-loopback-item');
            if (container) container.style.display = 'none';
        }

        exemptBtn.onclick = async () => {
            if (appStore.get('isNetworkUpdating')) return;

            /** @type {any} */
            const t = /** @type {any} */ (translations)[appStore.get('currentLang')];
            const confirmed = await showConfirmModal(
                t.uwpExemptTitle || "UWP Loopback Exemption",
                t.uwpExemptDesc || "This will apply loopback exemption to all UWP apps, which requires Administrator privileges. Do you want to continue?"
            );
            if (!confirmed) return;

            appStore.set('isNetworkUpdating', true);
            exemptBtn.classList.add('opacity-50', 'cursor-not-allowed');
            spinner?.classList.remove('hidden');

            try {
                await invoke(COMMANDS.EXEMPT_UWP_APPS);
                showNotification(
                    /** @type {any} */(/** @type {any} */ (translations)[appStore.get('currentLang')]).notifUwpSuccess || 'UWP Loopback exemption process started. Please check the UAC prompt.',
                    'success'
                );
            } catch (err) {
                const error = toError(err);
                showNotification(
                    `${(/** @type {any} */(/** @type {any} */ (translations)[appStore.get('currentLang')]).notifUwpFailed || 'Failed')}: ${error}`,
                    'error'
                );
            } finally {
                appStore.set('isNetworkUpdating', false);
                exemptBtn.classList.remove('opacity-50', 'cursor-not-allowed');
                spinner?.classList.add('hidden');
            }
        };
    }
}

// ---------------------------------------------------------------------------
function initLogSettingsModal() {
    const settingsBtn = document.getElementById('log-settings-btn');
    const exportBtn = document.getElementById('log-export-btn');

    /** @type {() => Record<string, any>} */
    const getT = () => /** @type {any} */ (translations)[appStore.get('currentLang')] ?? {};

    // --- Settings Modal (gear icon) ---
    settingsBtn?.addEventListener('click', () => {
        document.getElementById('log-settings-modal')?.remove();

        const t = getT();
        const logAppEnabled = appStore.get('logAppEnabled') || false;
        const logCoreEnabled = appStore.get('logCoreEnabled') || false;
        const retentionDays = appStore.get('logRetentionDays') ?? 3;
        const maxFileMb = appStore.get('logMaxFileMb') ?? 50;

        const modal = document.createElement('div');
        modal.id = 'log-settings-modal';
        modal.className = 'fixed inset-0 z-[var(--z-modal)] flex items-center justify-center bg-[var(--zephyr-bg-overlay)] backdrop-blur-md';
        // eslint-disable-next-line no-unsanitized/property -- i18n translation keys
        modal.innerHTML = ` // nosemgrep: js-innerhtml-assignment — verified safe, see eslint-disable above
            <div class="glass-card w-[400px] p-6 space-y-4">
                <div class="flex items-center justify-between">
                    <h3 class="text-sm font-bold text-[var(--text-primary)]">${t.logSettings || 'Log Settings'}</h3>
                    <button id="log-modal-close" class="text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors">
                        <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
                    </button>
                </div>

                <!-- Tab switcher -->
                <div class="flex gap-1 bg-[var(--zephyr-bg-muted)] rounded-lg p-1">
                    <button id="log-tab-app" class="log-tab-btn flex-1 text-2xs font-medium uppercase tracking-wider py-1.5 rounded-md transition-all">${t.logAppTab || 'App Logs'}</button>
                    <button id="log-tab-core" class="log-tab-btn flex-1 text-2xs font-medium uppercase tracking-wider py-1.5 rounded-md transition-all">${t.logCoreTab || 'Core Logs'}</button>
                </div>

                <!-- App Logs Tab -->
                <div id="log-panel-app" class="log-tab-panel space-y-3">
                    <div class="flex items-center justify-between">
                        <span class="text-xs text-[var(--text-primary)]">${t.logAppEnabled || 'Persist App Logs'}</span>
                        <label class="ios-switch">
                            <input type="checkbox" id="log-app-toggle" ${logAppEnabled ? 'checked' : ''}>
                            <span class="switch-slider"></span>
                        </label>
                    </div>
                    <div class="grid grid-cols-2 gap-3">
                        <div class="flex flex-col gap-1">
                            <label class="text-2xs text-[var(--text-muted)] font-medium uppercase tracking-wider">${t.logRetentionDays || 'Retention Days'}</label>
                            <div class="flex items-center gap-1">
                                <input id="log-retention-days" type="number" min="1" max="30" value="${retentionDays}" class="form-control form-control-md form-control-mono">
                                <span class="text-2xs text-[var(--text-muted)]">${t.logDaysUnit || 'days'}</span>
                            </div>
                        </div>
                        <div class="flex flex-col gap-1">
                            <label class="text-2xs text-[var(--text-muted)] font-medium uppercase tracking-wider">${t.logMaxFileMb || 'Max File Size'}</label>
                            <div class="flex items-center gap-1">
                                <input id="log-max-file-mb" type="number" min="1" max="500" value="${maxFileMb}" class="form-control form-control-md form-control-mono">
                                <span class="text-2xs text-[var(--text-muted)]">${t.logMbUnit || 'MB'}</span>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- Core Logs Tab -->
                <div id="log-panel-core" class="log-tab-panel space-y-3" style="display:none">
                    <div class="flex items-center justify-between">
                        <span class="text-xs text-[var(--text-primary)]">${t.logCoreEnabled || 'Persist Core Logs'}</span>
                        <label class="ios-switch">
                            <input type="checkbox" id="log-core-toggle" ${logCoreEnabled ? 'checked' : ''}>
                            <span class="switch-slider"></span>
                        </label>
                    </div>
                    <div class="grid grid-cols-2 gap-3">
                        <div class="flex flex-col gap-1">
                            <label class="text-2xs text-[var(--text-muted)] font-medium uppercase tracking-wider">${t.logRetentionDays || 'Retention Days'}</label>
                            <div class="flex items-center gap-1">
                                <input id="log-retention-days-2" type="number" min="1" max="30" value="${retentionDays}" class="form-control form-control-md form-control-mono">
                                <span class="text-2xs text-[var(--text-muted)]">${t.logDaysUnit || 'days'}</span>
                            </div>
                        </div>
                        <div class="flex flex-col gap-1">
                            <label class="text-2xs text-[var(--text-muted)] font-medium uppercase tracking-wider">${t.logMaxFileMb || 'Max File Size'}</label>
                            <div class="flex items-center gap-1">
                                <input id="log-max-file-mb-2" type="number" min="1" max="500" value="${maxFileMb}" class="form-control form-control-md form-control-mono">
                                <span class="text-2xs text-[var(--text-muted)]">${t.logMbUnit || 'MB'}</span>
                            </div>
                        </div>
                    </div>
                </div>

                <div class="flex justify-end pt-1">
                    <button id="log-modal-done" class="btn-ghost text-xs px-4 py-2">${t.done || 'Done'}</button>
                </div>
            </div>
        `;

        document.body.appendChild(modal);
        document.body.style.overflow = 'hidden';

        // Animate in
        requestAnimationFrame(() => {
            const panel = modal.querySelector('.glass-card');
            if (panel instanceof HTMLElement) {
                panel.style.transform = 'scale(0.96)';
                panel.style.opacity = '0';
                requestAnimationFrame(() => {
                    panel.style.transition = 'all 0.25s cubic-bezier(0.16, 1, 0.3, 1)';
                    panel.style.transform = 'scale(1)';
                    panel.style.opacity = '1';
                });
            }
        });

        const closeModal = () => {
            document.body.style.overflow = '';
            const panel = modal.querySelector('.glass-card');
            if (panel instanceof HTMLElement) {
                panel.style.transition = 'all 0.15s ease-in';
                panel.style.transform = 'scale(0.96)';
                panel.style.opacity = '0';
                setTimeout(() => modal.remove(), 150);
            } else {
                modal.remove();
            }
        };

        document.getElementById('log-modal-close')?.addEventListener('click', closeModal);
        modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
        document.getElementById('log-modal-done')?.addEventListener('click', closeModal);

        // Tab switching
        const tabApp = /** @type {HTMLElement} */ (modal.querySelector('#log-tab-app'));
        const tabCore = /** @type {HTMLElement} */ (modal.querySelector('#log-tab-core'));
        const panelApp = /** @type {HTMLElement} */ (modal.querySelector('#log-panel-app'));
        const panelCore = /** @type {HTMLElement} */ (modal.querySelector('#log-panel-core'));

        const activateTab = (/** @type {HTMLElement} */ tab, /** @type {HTMLElement} */ p) => {
            [tabApp, tabCore].forEach(tb => {
                tb.classList.remove('bg-[var(--zephyr-bg-card)]', 'text-[var(--text-primary)]', 'shadow-sm');
                tb.classList.add('text-[var(--text-muted)]');
            });
            [panelApp, panelCore].forEach(pn => { pn.style.display = 'none'; });
            tab.classList.add('bg-[var(--zephyr-bg-card)]', 'text-[var(--text-primary)]', 'shadow-sm');
            tab.classList.remove('text-[var(--text-muted)]');
            p.style.display = '';
        };
        activateTab(tabApp, panelApp);
        tabApp.onclick = () => activateTab(tabApp, panelApp);
        tabCore.onclick = () => activateTab(tabCore, panelCore);

        // Sync retention/max inputs between tabs
        const retentionInput = /** @type {HTMLInputElement} */ (modal.querySelector('#log-retention-days'));
        const retentionInput2 = /** @type {HTMLInputElement} */ (modal.querySelector('#log-retention-days-2'));
        const maxFileInput = /** @type {HTMLInputElement} */ (modal.querySelector('#log-max-file-mb'));
        const maxFileInput2 = /** @type {HTMLInputElement} */ (modal.querySelector('#log-max-file-mb-2'));

        retentionInput?.addEventListener('input', () => { if (retentionInput2) retentionInput2.value = retentionInput.value; saveSettings(); });
        retentionInput2?.addEventListener('input', () => { if (retentionInput) retentionInput.value = retentionInput2.value; saveSettings(); });
        maxFileInput?.addEventListener('input', () => { if (maxFileInput2) maxFileInput2.value = maxFileInput.value; saveSettings(); });
        maxFileInput2?.addEventListener('input', () => { if (maxFileInput) maxFileInput.value = maxFileInput2.value; saveSettings(); });

        // Toggle handlers
        const appToggle = /** @type {HTMLInputElement} */ (modal.querySelector('#log-app-toggle'));
        const coreToggle = /** @type {HTMLInputElement} */ (modal.querySelector('#log-core-toggle'));

        appToggle?.addEventListener('change', () => {
            appStore.set('logAppEnabled', appToggle.checked);
            saveSettings();
        });
        coreToggle?.addEventListener('change', () => {
            appStore.set('logCoreEnabled', coreToggle.checked);
            saveSettings();
        });

        // Save settings via patch_settings
        const saveSettings = debounce(async () => {
            try {
                let retention = parseInt(retentionInput?.value || '3', 10);
                if (isNaN(retention) || retention < 1) retention = 3;
                if (retention > 30) retention = 30;
                let maxMb = parseInt(maxFileInput?.value || '50', 10);
                if (isNaN(maxMb) || maxMb < 1) maxMb = 50;
                if (maxMb > 500) maxMb = 500;
                appStore.set('logRetentionDays', retention);
                appStore.set('logMaxFileMb', maxMb);
                await invoke('patch_settings', {
                    patch: {
                        log_app_enabled: appToggle?.checked ?? false,
                        log_core_enabled: coreToggle?.checked ?? false,
                        log_retention_days: retention,
                        log_max_file_mb: maxMb,
                    }
                });
            } catch (err) {
                settingsLogger.error('[log-settings] Failed to save:', err);
            }
        }, 500);
    });

    // --- Export Modal (export button) ---
    exportBtn?.addEventListener('click', () => {
        document.getElementById('log-export-modal')?.remove();

        const t = getT();
        const formatDate = (/** @type {Date} */ date) => {
            const yyyy = date.getFullYear();
            const mm = String(date.getMonth() + 1).padStart(2, '0');
            const dd = String(date.getDate()).padStart(2, '0');
            return `${yyyy}-${mm}-${dd}`;
        };
        const today = formatDate(new Date());
        const threeDaysAgoDate = new Date();
        threeDaysAgoDate.setDate(threeDaysAgoDate.getDate() - 3);
        const threeDaysAgo = formatDate(threeDaysAgoDate);

        const modal = document.createElement('div');
        modal.id = 'log-export-modal';
        modal.className = 'fixed inset-0 z-[var(--z-modal)] flex items-center justify-center bg-[var(--zephyr-bg-overlay)] backdrop-blur-md';
        // eslint-disable-next-line no-unsanitized/property -- i18n translation keys
        modal.innerHTML = ` // nosemgrep: js-innerhtml-assignment — verified safe, see eslint-disable above
            <div class="glass-card w-[480px] p-6 space-y-4">
                <div class="flex items-center justify-between">
                    <h3 class="text-sm font-bold text-[var(--text-primary)]">${t.logExportTitle || 'Export Logs'}</h3>
                    <button id="log-export-modal-close" class="text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors">
                        <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
                    </button>
                </div>

                <div class="grid grid-cols-2 gap-2">
                    <div class="flex flex-col gap-1">
                        <label class="text-2xs text-[var(--text-muted)]">${t.logExportFrom || 'From'}</label>
                        <input id="log-export-from" type="date" value="${threeDaysAgo}" class="form-control form-control-md form-control-mono">
                    </div>
                    <div class="flex flex-col gap-1">
                        <label class="text-2xs text-[var(--text-muted)]">${t.logExportTo || 'To'}</label>
                        <input id="log-export-to" type="date" value="${today}" class="form-control form-control-md form-control-mono">
                    </div>
                </div>

                <div class="flex flex-col gap-1">
                    <label class="text-2xs text-[var(--text-muted)]">${t.logExportLevel || 'Severity Level'}</label>
                    <div id="log-level-wrap" class="relative w-full">
                        <button id="log-level-trigger" type="button" class="select-common w-full flex items-center justify-between">
                            <span id="log-level-label">INFO</span>
                            <svg class="dropdown-arrow w-3.5 h-3.5 text-[var(--text-muted)] transition-transform duration-[var(--zephyr-time-micro)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="m6 9 6 6 6-6"></path>
                            </svg>
                        </button>
                        <div id="log-level-menu" class="hidden absolute left-0 right-0 top-[calc(100%+8px)] w-full rounded-lg border border-[var(--zephyr-border-default)] bg-[var(--zephyr-bg-elevated)] shadow-2xl z-30">
                            <div class="menu-scroll">
                                <button type="button" data-value="fatal" class="w-full text-left px-3 py-2 rounded-[var(--radius-dropdown-option)] text-xs text-[var(--text-secondary)] hover:bg-[var(--zephyr-bg-muted)] transition-colors">FATAL</button>
                                <button type="button" data-value="error" class="w-full text-left px-3 py-2 rounded-[var(--radius-dropdown-option)] text-xs text-[var(--text-secondary)] hover:bg-[var(--zephyr-bg-muted)] transition-colors">ERROR</button>
                                <button type="button" data-value="warn" class="w-full text-left px-3 py-2 rounded-[var(--radius-dropdown-option)] text-xs text-[var(--text-secondary)] hover:bg-[var(--zephyr-bg-muted)] transition-colors">WARN</button>
                                <button type="button" data-value="info" class="w-full text-left px-3 py-2 rounded-[var(--radius-dropdown-option)] text-xs text-[var(--text-secondary)] hover:bg-[var(--zephyr-bg-muted)] transition-colors">INFO</button>
                                <button type="button" data-value="debug" class="w-full text-left px-3 py-2 rounded-[var(--radius-dropdown-option)] text-xs text-[var(--text-secondary)] hover:bg-[var(--zephyr-bg-muted)] transition-colors">DEBUG</button>
                                <button type="button" data-value="trace" class="w-full text-left px-3 py-2 rounded-[var(--radius-dropdown-option)] text-xs text-[var(--text-secondary)] hover:bg-[var(--zephyr-bg-muted)] transition-colors">TRACE</button>
                            </div>
                        </div>
                        <select id="log-export-level" class="hidden">
                            <option value="fatal">FATAL</option>
                            <option value="error">ERROR</option>
                            <option value="warn">WARN</option>
                            <option value="info" selected>INFO</option>
                            <option value="debug">DEBUG</option>
                            <option value="trace">TRACE</option>
                        </select>
                    </div>
                </div>

                <div class="flex flex-col gap-2">
                    <button id="log-export-app" class="btn-ghost w-full">${t.logExportApp || 'Export App Logs'}</button>
                    <button id="log-export-core" class="btn-ghost w-full">${t.logExportCore || 'Export Core Logs'}</button>
                    <button id="log-export-all" class="btn-ghost w-full">${t.logExportAll || 'Export All'}</button>
                </div>
                <button id="log-open-folder" class="btn-ghost w-full">${t.logOpenFolder || 'Open Log Folder'}</button>
            </div>
        `;

        document.body.appendChild(modal);
        document.body.style.overflow = 'hidden';

        // Animate in
        requestAnimationFrame(() => {
            const panel = modal.querySelector('.glass-card');
            if (panel instanceof HTMLElement) {
                panel.style.transform = 'scale(0.96)';
                panel.style.opacity = '0';
                requestAnimationFrame(() => {
                    panel.style.transition = 'all 0.25s cubic-bezier(0.16, 1, 0.3, 1)';
                    panel.style.transform = 'scale(1)';
                    panel.style.opacity = '1';
                });
            }
        });

        const closeModal = () => {
            document.body.style.overflow = '';
            const panel = modal.querySelector('.glass-card');
            if (panel instanceof HTMLElement) {
                panel.style.transition = 'all 0.15s ease-in';
                panel.style.transform = 'scale(0.96)';
                panel.style.opacity = '0';
                setTimeout(() => modal.remove(), 150);
            } else {
                modal.remove();
            }
        };

        document.getElementById('log-export-modal-close')?.addEventListener('click', closeModal);
        modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });

        // Prevent wheel scroll from propagating to the background page
        const glassCard = modal.querySelector('.glass-card');
        glassCard?.addEventListener('wheel', (e) => {
            e.stopPropagation();
        }, { passive: true });

        // Initialize custom dropdown for severity level
        initCustomDropdown({
            wrapId: 'log-level-wrap',
            triggerId: 'log-level-trigger',
            menuId: 'log-level-menu',
            labelId: 'log-level-label',
            selectId: 'log-export-level',
        });

        // Prevent wheel scroll from propagating to the background page
        const levelMenu = modal.querySelector('#log-level-menu');
        levelMenu?.addEventListener('wheel', (e) => {
            e.stopPropagation();
        }, { passive: true });

        // Export handlers — run as un-awaited IIFE to avoid blocking the UI
        const doExport = (/** @type {string} */ logType) => {
            const from = /** @type {HTMLInputElement} */ (modal.querySelector('#log-export-from'))?.value || threeDaysAgo;
            const to = /** @type {HTMLInputElement} */ (modal.querySelector('#log-export-to'))?.value || today;
            const level = /** @type {HTMLSelectElement} */ (modal.querySelector('#log-export-level'))?.value || null;
            (async () => {
                try {
                    showNotification(t.logExporting || 'Exporting logs...');
                    const path = await invoke('export_logs', {
                        logType,
                        fromDate: from,
                        toDate: to,
                        level: level || null,
                    });
                    settingsLogger.info(`[log-settings] Exported to: ${path}`);
                    showNotification(t.logExportSuccess || 'Export completed', 'success');
                } catch (err) {
                    settingsLogger.error('[log-settings] Export failed:', err);
                    showNotification((err ?? 'Export failed').toString(), 'error');
                }
            })();
        };

        modal.querySelector('#log-export-app')?.addEventListener('click', () => doExport('app'));
        modal.querySelector('#log-export-core')?.addEventListener('click', () => doExport('core'));
        modal.querySelector('#log-export-all')?.addEventListener('click', () => doExport('all'));

        modal.querySelector('#log-open-folder')?.addEventListener('click', async () => {
            try {
                await invoke('open_log_folder');
            } catch (err) {
                settingsLogger.error('[log-settings] Failed to open folder:', err);
            }
        });
    });
}

//  initFakeClient
// ---------------------------------------------------------------------------
function initFakeClient() {
    const toggle = /** @type {HTMLInputElement} */ (document.getElementById('setting-fake-client'));
    const optionsContainer = document.getElementById('fake-client-options');
    const select = /** @type {HTMLSelectElement} */ (document.getElementById('fake-client-select'));
    const customContainer = document.getElementById('fake-client-custom-container');
    const customInput = /** @type {HTMLInputElement} */ (document.getElementById('fake-client-custom'));
    const spinner = document.getElementById('fake-client-spinner');

    if (!toggle || !optionsContainer || !select || !customInput) return;

    let isFetching = false;
    let versionsFetched = false;

    const storedEnabled = localStorage.getItem('fakeClientEnabled');
    const savedEnabled = storedEnabled === null ? true : storedEnabled === 'true';

    if (storedEnabled === null) {
        localStorage.setItem('fakeClientEnabled', 'true');
    }

    if (!localStorage.getItem('fakeClientType')) {
        localStorage.setItem('fakeClientType', 'clash-verge/1.6.0');
    }

    const savedType = localStorage.getItem('fakeClientType') || 'clash-verge/1.6.0';
    const savedCustom = localStorage.getItem('fakeClientCustom') || '';

    toggle.checked = savedEnabled;
    select.value = savedType;
    if (!select.value) select.value = 'custom';
    customInput.value = savedCustom;

    // Sync UA to backend on init so scheduler uses it from the start
    syncUserAgentToBackend();

    const fakeClientDropdown = initCustomDropdown({
        wrapId: 'fake-client-select-wrap',
        triggerId: 'fake-client-trigger',
        menuId: 'fake-client-menu',
        labelId: 'fake-client-label',
        selectId: 'fake-client-select',
        /** @param {string} val */
        onChange: (val) => {
            localStorage.setItem('fakeClientType', val);
            updateVisibility();
            syncUserAgentToBackend();
        },
    });

    function updateVisibility() {
        if (toggle.checked) {
            /** @type {HTMLElement} */ (optionsContainer).classList.remove('max-h-0', 'opacity-0', 'overflow-hidden');
            /** @type {HTMLElement} */ (optionsContainer).classList.add('max-h-40', 'opacity-100');
            if (select.value === 'custom' && customContainer) {
                customContainer.classList.remove('hidden');
            } else if (customContainer) {
                customContainer.classList.add('hidden');
            }
            if (!versionsFetched) {
                fetchLatestVersions();
            }
        } else {
            /** @type {HTMLElement} */ (optionsContainer).classList.remove('max-h-40', 'opacity-100');
            /** @type {HTMLElement} */ (optionsContainer).classList.add('max-h-0', 'opacity-0', 'overflow-hidden');
            setTimeout(() => { if (customContainer) customContainer.classList.add('hidden'); }, 300);
        }
    }

    async function fetchLatestVersions() {
        if (isFetching || versionsFetched) return;
        isFetching = true;
        spinner?.classList.remove('hidden');

        try {
            /** @type {any} */
            const versions = await invoke(COMMANDS.GET_LATEST_CLIENT_VERSIONS);

            const vergeOpt = select.querySelector('option[value^="clash-verge"]');
            const partyOpt = select.querySelector('option[value^="mihomo-party"]');
            const flclashOpt = select.querySelector('option[value^="Flclash"]');

            if (vergeOpt) { /** @type {HTMLOptionElement} */ (vergeOpt).value = versions.verge; vergeOpt.textContent = `Clash Verge Rev (${versions.verge})`; }
            if (partyOpt) { /** @type {HTMLOptionElement} */ (partyOpt).value = versions.mihomo_party; partyOpt.textContent = `mihomo-party (${versions.mihomo_party})`; }
            if (flclashOpt) { /** @type {HTMLOptionElement} */ (flclashOpt).value = versions.flclash; flclashOpt.textContent = `Flclash (${versions.flclash})`; }

            const menu = document.getElementById('fake-client-menu');
            if (menu) {
                const vergeBtn = menu.querySelector('[data-value^="clash-verge"]');
                const partyBtn = menu.querySelector('[data-value^="mihomo-party"]');
                const flclashBtn = menu.querySelector('[data-value^="Flclash"]');
                if (vergeBtn) { vergeBtn.setAttribute('data-value', versions.verge); vergeBtn.textContent = `Clash Verge Rev (${versions.verge})`; vergeBtn.setAttribute('data-label', `Clash Verge Rev (${versions.verge})`); }
                if (partyBtn) { partyBtn.setAttribute('data-value', versions.mihomo_party); partyBtn.textContent = `mihomo-party (${versions.mihomo_party})`; partyBtn.setAttribute('data-label', `mihomo-party (${versions.mihomo_party})`); }
                if (flclashBtn) { flclashBtn.setAttribute('data-value', versions.flclash); flclashBtn.textContent = `Flclash (${versions.flclash})`; flclashBtn.setAttribute('data-label', `Flclash (${versions.flclash})`); }
            }

            if (savedType && savedType.startsWith('clash-verge')) {
                select.value = versions.verge;
                localStorage.setItem('fakeClientType', versions.verge);
            } else if (savedType && savedType.startsWith('mihomo-party')) {
                select.value = versions.mihomo_party;
                localStorage.setItem('fakeClientType', versions.mihomo_party);
            } else if (savedType && savedType.startsWith('Flclash')) {
                select.value = versions.flclash;
                localStorage.setItem('fakeClientType', versions.flclash);
            } else {
                select.value = savedType;
            }

            if (fakeClientDropdown) fakeClientDropdown.syncUI();

            versionsFetched = true;
        } catch (err) {
            settingsLogger.error('Failed to fetch latest client versions', err);
        } finally {
            isFetching = false;
            spinner?.classList.add('hidden');
            updateVisibility();
        }
    }

    toggle.addEventListener('change', () => {
        localStorage.setItem('fakeClientEnabled', toggle.checked.toString());
        updateVisibility();
        syncUserAgentToBackend();
        if (!toggle.checked) {
            /** @type {any} */
            const t = /** @type {any} */ (translations)[appStore.get('currentLang')];
            showNotification(t.fakeClientWarning || "Warning: Disabling this may cause incorrect config format from subscriptions.", "warning");
        }
    });

    customInput.addEventListener('input', () => {
        localStorage.setItem('fakeClientCustom', customInput.value);
        debouncedSyncUA();
    });

    if (savedEnabled) {
        optionsContainer.style.transition = 'none';
        updateVisibility();
        setTimeout(() => optionsContainer.style.transition = '', 50);
    }
}

// ---------------------------------------------------------------------------
//  initSettings -- main entry point
// ---------------------------------------------------------------------------
export async function initSettings() {
    // Portable mode: hide unsupported options
    const isPortable = await invoke('get_portable_mode');
    if (isPortable) {
        const autostartRow = document.getElementById('row-autostart');
        const clientUpdateRow = document.getElementById('row-client-update');
        if (autostartRow) autostartRow.style.display = 'none';
        if (clientUpdateRow) clientUpdateRow.style.display = 'none';
    }

    const langSelect = /** @type {HTMLSelectElement} */ (document.getElementById('setting-lang'));
    const closeTrayToggle = /** @type {HTMLInputElement} */ (document.getElementById('setting-close-tray'));
    const lightweightModeToggle = /** @type {HTMLInputElement} */ (document.getElementById('setting-lightweight-mode'));
    const silentStartToggle = /** @type {HTMLInputElement} */ (document.getElementById('setting-silent-start'));
    const autoUpdateToggle = /** @type {HTMLInputElement} */ (document.getElementById('setting-auto-update'));
    const autoUpdateClientToggle = /** @type {HTMLInputElement} */ (document.getElementById('setting-auto-update-client'));
    const autostartToggle = /** @type {HTMLInputElement} */ (document.getElementById('setting-autostart'));
    const unifiedDelayToggle = /** @type {HTMLInputElement} */ (document.getElementById('setting-unified-delay'));
    const ipv6Toggle = /** @type {HTMLInputElement} */ (document.getElementById('setting-ipv6'));
    const allowLanToggle = /** @type {HTMLInputElement} */ (document.getElementById('setting-allow-lan'));
    const updateGeoBtn = document.getElementById('update-geo-btn');
    const addTunnelBtn = document.getElementById('add-tunnel-btn');
    const tunnelsList = document.getElementById('tunnels-list');
    const tunnelsEmpty = document.getElementById('tunnels-empty');
    /** @type {NodeListOf<HTMLElement>} */
    const themeCircles = document.querySelectorAll('[data-theme]');
    const checkUpdateBtn = /** @type {HTMLButtonElement|null} */ (document.getElementById('check-update-btn'));
    const nodeScrollToggle = /** @type {HTMLInputElement} */ (document.getElementById('setting-node-scroll'));
    const hideTimeoutToggle = /** @type {HTMLInputElement} */ (document.getElementById('setting-hide-timeout'));
    const failoverToggle = /** @type {HTMLInputElement} */ (document.getElementById('setting-failover'));
    const encryptConfigsToggle = /** @type {HTMLInputElement} */ (document.getElementById('setting-encrypt-configs'));
    const portConfigBtn = /** @type {HTMLButtonElement|null} */ (document.getElementById('port-config-btn'));
    const portDisplay = /** @type {HTMLElement|null} */ (document.getElementById('current-port-display'));
    const versionText = document.getElementById('core-version-text');
    const configsList = document.getElementById('configs-list');
    const customArgsInput = /** @type {HTMLInputElement} */ (document.getElementById('custom-args-input'));
    const applyArgsBtn = document.getElementById('apply-args-btn');
    const gotoAdvancedBtn = document.getElementById('btn-goto-advanced');
    const backSettingsBtn = document.getElementById('btn-back-settings');
    const customColorInput = /** @type {HTMLInputElement} */ (document.getElementById('custom-theme-color'));
    const opacitySlider = /** @type {HTMLInputElement} */ (document.getElementById('setting-opacity'));
    const opacityValText = document.getElementById('opacity-val-text');
    const restoreDefaultsBtn = document.getElementById('btn-restore-defaults');
    const openConfigFolderBtn = document.getElementById('open-config-folder-btn');
    const appMainContainer = document.getElementById('app-main-container');
    const themeModeContainer = document.getElementById('setting-theme-mode-container');
    const themeModeSlider = document.getElementById('setting-theme-mode-slider');
    /** @type {HTMLElement[]} */
    const themeModeButtons = Array.from(document.querySelectorAll('[data-theme-mode]'));
    const appTitleIcon = /** @type {HTMLImageElement} */ (document.getElementById('app-title-icon'));

    // ---- Forward declarations (used before their full definition below) ----
    /** @type {any[]} */
    let currentTunnels = [];

    // ---- Subscription & Config management (delegated to settings/subscriptions.js) ----
    // Initialized early so renderConfigs is available for language dropdown and drag-drop listeners.
    const subApi = initSubscriptionSettings({
        subAddBtn: document.getElementById('add-sub-btn'),
        updateAllSubBtn: document.getElementById('update-all-sub-btn'),
        configsList,
    });
    const renderConfigs = subApi.renderConfigs;

    // ---- Advanced settings navigation ----
    if (gotoAdvancedBtn) {
        gotoAdvancedBtn.onclick = () => {
            switchPage('advanced');
            // renderAdvancedSettings lives in ui.js (or its future module);
            // it is called via the navigation handler in initNavigation.
            // We import it lazily to avoid circular deps.
            import('./advanced.js').then(m => m.renderAdvancedSettings?.()).catch(() => {});
        };
    }

    const gotoGithubBtn = document.getElementById('btn-goto-github');
    if (gotoGithubBtn) {
        gotoGithubBtn.onclick = (e) => {
            e.preventDefault();
            openUrl('https://github.com/Juwan-Hwang/Zephyr');
        };
    }

    if (backSettingsBtn) {
        backSettingsBtn.onclick = () => {
            switchPage('settings');
        };
    }

    // ---- Custom args ----
    if (applyArgsBtn) {
        applyArgsBtn.onclick = async () => {
            const argsStr = customArgsInput.value.trim();
            /** @type {any} */
            const settings = await invoke(COMMANDS.GET_SETTINGS);
            const configPath = settings.last_config || 'config.yaml';
            const customArgs = argsStr.split('\n').filter(a => a.trim() !== '');

            /** @type {any} */
            const t = /** @type {any} */ (translations)[appStore.get('currentLang')];
            showNotification(t.notifSavingAndRestarting || "Saving and restarting core...");
            try {
                await save();
                abortLatencyTests();
                await restartCore(configPath, customArgs);
                await postRestartRecovery(configPath);
                showNotification(t.notifRestartSuccess || "Core restarted successfully", 'success');
            } catch (err) {
                const error = toError(err);
                showNotification(error.toString(), 'error');
            }
        };
    }

    // ---- Language dropdown ----
    if (langSelect) {
        langSelect.value = appStore.get('currentLang');

        const langDropdown = initCustomDropdown({
            wrapId: 'setting-lang-wrap',
            triggerId: 'setting-lang-trigger',
            menuId: 'setting-lang-menu',
            labelId: 'setting-lang-label',
            selectId: 'setting-lang',
            optionAttr: 'data-lang-value',
            /** @param {string} value */
            onChange: (value) => {
                setLanguage(value);
                appStore.set('currentLang', value);
                Bus.emit(Events.LANGUAGE_CHANGED, value);
                renderConfigs();
            },
        });

        __langDropdown = langDropdown;
    }

    // ---- UI Scale buttons ----
    const uiScaleButtons = document.querySelectorAll('.ui-scale-btn');
    const applyUiScale = (/** @type {number} */ scale) => {
        // Update button states
        uiScaleButtons.forEach(btn => {
            btn.classList.remove('bg-accent/20', 'dark:bg-accent/30', 'text-accent');
            btn.classList.add('bg-[var(--zephyr-bg-input)]', 'text-[var(--text-tertiary)]');
        });
        const activeBtn = document.getElementById(`ui-scale-${Math.round(scale * 100)}`);
        if (activeBtn) {
            activeBtn.classList.remove('bg-[var(--zephyr-bg-input)]', 'text-[var(--text-tertiary)]');
            activeBtn.classList.add('bg-accent/20', 'dark:bg-accent/30', 'text-accent');
        }
        // Apply scale via CSS custom property --ui-scale
        // The actual transform/size is handled by CSS on #app-main-container.
        // This avoids inline style conflicts with Tailwind classes and ensures
        // the scale is applied consistently on startup.
        document.documentElement.style.setProperty('--ui-scale', String(scale));
    };

    uiScaleButtons.forEach(btn => {
        btn.addEventListener('click', async () => {
            const scaleValue = parseInt(btn.id.replace('ui-scale-', '')) / 100;
            try {
                await invoke(COMMANDS.SET_UI_SCALE, { scale: scaleValue });
                applyUiScale(scaleValue);
            } catch (_e) {
                // silently ignore — non-critical
            }
        });
    });

    // ---- Load current settings ----
    /** @type {any} */
    const settings = await invoke(COMMANDS.GET_SETTINGS);

    // Sync global preferences to appStore immediately to prevent UI flicker
    // (these are loaded from settings.json before any async operations)
    if (settings.theme_mode && ['light', 'dark', 'auto'].includes(settings.theme_mode)) {
        appStore.set('currentThemeMode', settings.theme_mode);
    }
    if (settings.app_opacity != null) {
        const opacity = Number(settings.app_opacity);
        if (Number.isFinite(opacity)) {
            const clamped = Math.min(100, Math.max(0, opacity)) / 100;
            document.documentElement.style.setProperty('--app-opacity', String(clamped));
        }
    }

    if (closeTrayToggle) closeTrayToggle.checked = settings.close_to_tray;
    if (lightweightModeToggle) lightweightModeToggle.checked = settings.lightweight_mode || false;
    if (silentStartToggle) silentStartToggle.checked = settings.silent_start || false;
    if (autoUpdateToggle) autoUpdateToggle.checked = settings.auto_update;
    if (autoUpdateClientToggle) autoUpdateClientToggle.checked = settings.auto_update_client || false;
    if (autostartToggle && !isPortable) autostartToggle.checked = await isAutoStartEnabled();
    if (nodeScrollToggle) nodeScrollToggle.checked = !!settings.node_scroll;
    if (hideTimeoutToggle) hideTimeoutToggle.checked = settings.hide_timeout_nodes || false;
    if (failoverToggle) failoverToggle.checked = settings.failover_enabled || false;
    if (encryptConfigsToggle) encryptConfigsToggle.checked = settings.encrypt_configs || false;
    appStore.set('failoverEnabled', settings.failover_enabled || false);
    appStore.set('networkOptimAutoApply', settings.network_optim_auto_apply ?? false);
    appStore.set('encryptConfigs', settings.encrypt_configs || false);
    appStore.set('logAppEnabled', settings.log_app_enabled || false);
    appStore.set('logCoreEnabled', settings.log_core_enabled || false);
    appStore.set('logRetentionDays', settings.log_retention_days ?? 3);
    appStore.set('logMaxFileMb', settings.log_max_file_mb ?? 50);
    if (customArgsInput) customArgsInput.value = (settings.custom_args || []).join('\n');

    // Apply saved UI scale
    if (settings.ui_scale && settings.ui_scale > 0) {
        applyUiScale(settings.ui_scale);
    }

    // ---- Theme + Opacity (delegated to settings/theme.js) ----
    const _themeApi = initThemeSettings({
        savedTheme: settings.theme,
        savedThemeMode: settings.theme_mode || null,
        savedOpacity: settings.app_opacity != null ? settings.app_opacity : null,
        appMainContainer,
        appTitleIcon,
        themeCircles,
        customColorInput,
        opacitySlider,
        opacityValText,
        themeModeContainer,
        themeModeSlider,
        themeModeButtons,
        save: () => save(),
    });

    // ---- Restore defaults ----
    if (restoreDefaultsBtn) {
        restoreDefaultsBtn.onclick = async () => {
            /** @type {any} */
            const t = /** @type {any} */ (translations)[appStore.get('currentLang')];
            const confirmed = await showConfirmModal(
                t.restoreDefaultsTitle || "Restore Defaults",
                t.restoreDefaultsConfirm || "Are you sure you want to restore all settings to default values?"
            );
            if (!confirmed) return;

            /** @type {string[]} */
            const errors = [];
            /** @type {string[]} */
            const successItems = [];

            /**
             * @param {string} name
             * @param {() => Promise<void>} operation
             * @returns {Promise<boolean>}
             */
            const trackResult = async (name, operation) => {
                try {
                    await operation();
                    successItems.push(name);
                    return true;
                } catch (err) {
                    const error = toError(err);
                    settingsLogger.error(`Failed to reset ${name}`, err);
                    errors.push(`${name}: ${error.message || err}`);
                    return false;
                }
            };

            try {
                if (closeTrayToggle) {
                    closeTrayToggle.checked = true;
                    settings.close_to_tray = true;
                }
                if (autoUpdateToggle) {
                    autoUpdateToggle.checked = false;
                    settings.auto_update = false;
                }
                if (autoUpdateClientToggle) {
                    autoUpdateClientToggle.checked = false;
                    settings.auto_update_client = false;
                }
                if (hideTimeoutToggle) {
                    const wasHideTimeoutEnabled = hideTimeoutToggle.checked;
                    hideTimeoutToggle.checked = false;
                    settings.hide_timeout_nodes = false;
                    if (wasHideTimeoutEnabled) {
                        hideTimeoutToggle.dispatchEvent(new Event('change'));
                    }
                }
                if (nodeScrollToggle) {
                    nodeScrollToggle.checked = false;
                    settings.node_scroll = false;
                    successItems.push('nodeScroll');
                }
                if (failoverToggle) {
                    failoverToggle.checked = false;
                    settings.failover_enabled = false;
                    appStore.set('failoverEnabled', false);
                }
                if (silentStartToggle) {
                    silentStartToggle.checked = false;
                    settings.silent_start = false;
                }
                if (customArgsInput) {
                    customArgsInput.value = '';
                    settings.custom_args = [];
                }

                if (autostartToggle) {
                    autostartToggle.checked = false;
                    settings.autostart = false;
                    await trackResult('autostart', async () => {
                        await disableAutoStart();
                    });
                }

                if (unifiedDelayToggle) unifiedDelayToggle.checked = true;
                if (ipv6Toggle) ipv6Toggle.checked = false;
                if (allowLanToggle) allowLanToggle.checked = false;

                const dnsToggle = /** @type {HTMLInputElement} */ (document.getElementById('dns-rewrite-toggle'));
                if (dnsToggle) {
                    dnsToggle.checked = true;
                    settings.dns_rewrite_enabled = true;
                    await trackResult('dnsRewrite', async () => {
                        await applyDnsRewrite();
                    });
                }

                if (opacitySlider) {
                    opacitySlider.value = '100';
                    settings.app_opacity = 100;
                    if (opacityValText) opacityValText.textContent = '100%';
                    document.documentElement.style.setProperty('--app-opacity', '1');
                    if (appMainContainer) appMainContainer.style.backgroundColor = '';
                    successItems.push('opacity');
                }

                currentTunnels = [];
                tunnelApi.resetTunnels();

                await trackResult('coreConfig', async () => {
                    const result = await saveConfigToCore({
                        'unified-delay': true,
                        ipv6: false,
                        'allow-lan': false,
                        tunnels: [],
                    });
                    if (!result) {
                        throw new Error(t.failedSaveSettings || 'Failed to save core settings');
                    }
                });

                const fakeClientToggle = /** @type {HTMLInputElement} */ (document.getElementById('setting-fake-client'));
                if (fakeClientToggle) {
                    fakeClientToggle.checked = true;
                    localStorage.setItem('fakeClientEnabled', 'true');
                    localStorage.removeItem('fakeClientType');
                    localStorage.removeItem('fakeClientCustom');
                    const fakeClientSelect = /** @type {HTMLSelectElement} */ (document.getElementById('fake-client-select'));
                    if (fakeClientSelect) fakeClientSelect.value = 'clash-verge/1.6.0';
                    const optionsContainer = document.getElementById('fake-client-options');
                    if (optionsContainer) {
                        optionsContainer.classList.remove('max-h-0', 'opacity-0');
                        optionsContainer.classList.add('max-h-40', 'opacity-100');
                    }
                    successItems.push('fakeClient');
                }

                // Reset theme mode
                settings.theme_mode = 'auto';
                _themeApi.setThemeMode('auto', false);
                successItems.push('themeMode');

                // Reset global preference overrides (injected into runtime YAML)
                settings.mode = null;
                settings.tun_enabled = null;
                settings.mixed_port = null;
                settings.socks_port = null;
                settings.http_port = null;
                settings.ipv6 = null;
                settings.allow_lan = null;
                settings.unified_delay = null;
                settings.dns_nameservers = null;
                settings.dns_fallbacks = null;

                localStorage.removeItem('appTheme');
                appStore.set('currentTheme', 'zinc');
                settings.theme = 'zinc';
                applyTheme('zinc');
                document.querySelectorAll('.theme-btn').forEach(b => b.classList.remove('ring-2', 'ring-offset-2', 'ring-offset-[var(--zephyr-bg-secondary)]'));
                const defaultThemeBtn = document.querySelector('.theme-btn[data-theme="zinc"]');
                if (defaultThemeBtn) {
                    defaultThemeBtn.classList.add('ring-2', 'ring-offset-2', 'ring-offset-[var(--zephyr-bg-secondary)]', 'ring-zinc-500');
                }
                successItems.push('themeColor');

                await trackResult('appSettings', async () => {
                    await invoke(COMMANDS.SAVE_SETTINGS, { settings });
                });
                invalidateSettingsCache();

                // Re-render proxy list after settings are persisted (node_scroll CSS class depends on backend value)
                const proxyContainer = document.getElementById('proxies-list');
                if (proxyContainer) proxyContainer.replaceChildren();
                Bus.emit(Events.CONFIG_UPDATED);

                if (errors.length === 0) {
                    showNotification(t.settingsRestored || t.restoreDefaultsDesc || "Settings restored to default", "success");
                } else {
                    showNotification(`${t.partialRestore || 'Some settings failed to restore'}: ${errors.join(', ')}`, "warning");
                }
            } catch (err) {
                const error = toError(err);
                showNotification(`${t.restoreFailed || 'Failed to restore defaults'}: ${error.message || err}`, 'error');
            }
        };
    }

    // Theme color/mode/circles are handled by initThemeSettings above

    // ---- Settings persistence ----
    async function save() {
        try {
            /** @type {any} */
            const currentSettings = await invoke(COMMANDS.GET_SETTINGS);
            if (closeTrayToggle) currentSettings.close_to_tray = closeTrayToggle.checked;
            if (lightweightModeToggle) currentSettings.lightweight_mode = lightweightModeToggle.checked;
            if (silentStartToggle) currentSettings.silent_start = silentStartToggle.checked;
            if (autoUpdateToggle) currentSettings.auto_update = autoUpdateToggle.checked;
            if (autoUpdateClientToggle) currentSettings.auto_update_client = autoUpdateClientToggle.checked;
            if (autostartToggle) currentSettings.autostart = autostartToggle.checked;
            if (hideTimeoutToggle) currentSettings.hide_timeout_nodes = hideTimeoutToggle.checked;
            if (failoverToggle) currentSettings.failover_enabled = failoverToggle.checked;
            if (encryptConfigsToggle) currentSettings.encrypt_configs = encryptConfigsToggle.checked;
            currentSettings.theme = appStore.get('currentTheme');
            if (customArgsInput) currentSettings.custom_args = customArgsInput.value.split('\n').filter(a => a.trim() !== '');
            await invoke(COMMANDS.SAVE_SETTINGS, { settings: currentSettings });
            invalidateSettingsCache();
        } catch (err) {
            settingsLogger.error('Failed to save settings', err);
        }
    }

    const syncLightweightState = () => {
        if (lightweightModeToggle && closeTrayToggle) {
            lightweightModeToggle.disabled = !closeTrayToggle.checked;
            lightweightModeToggle.closest('.flex')?.classList.toggle('opacity-50', !closeTrayToggle.checked);
            if (!closeTrayToggle.checked && lightweightModeToggle.checked) {
                lightweightModeToggle.checked = false;
            }
        }
    };
    closeTrayToggle?.addEventListener('change', () => {
        syncLightweightState();
        save();
    });
    lightweightModeToggle?.addEventListener('change', save);
    silentStartToggle?.addEventListener('change', save);
    syncLightweightState();
    autoUpdateToggle?.addEventListener('change', async () => {
        await save();
        /** @type {any} */
        const t = /** @type {any} */ (translations)[appStore.get('currentLang')];
        showNotification(t.requireAppRestart || "Changes saved. Restart the app to take effect.", "info");
    });
    hideTimeoutToggle?.addEventListener('change', async () => {
        await save();
        Bus.emit(Events.CONFIG_UPDATED);
    });
    autoUpdateClientToggle?.addEventListener('change', async () => {
        await save();
        /** @type {any} */
        const t = /** @type {any} */ (translations)[appStore.get('currentLang')];
        showNotification(t.requireAppRestart || "Changes saved. Restart the app to take effect.", "info");
    });
    failoverToggle?.addEventListener('change', async () => {
        appStore.set('failoverEnabled', failoverToggle.checked);
        await save();
    });
    encryptConfigsToggle?.addEventListener('change', async () => {
        if (!encryptConfigsToggle) return;
        const enabled = encryptConfigsToggle.checked;
        const t = /** @type {any} */ (translations)[appStore.get('currentLang')];
        const confirmMsg = enabled
            ? (t.encryptConfigsConfirmEnable || "Enabling encryption will immediately encrypt all existing config files. You will not be able to edit config files with an external editor. Continue?")
            : (t.encryptConfigsConfirmDisable || "Disabling encryption will immediately decrypt all config files to plaintext. Continue?");
        if (!confirm(confirmMsg)) {
            encryptConfigsToggle.checked = !enabled;
            return;
        }
        appStore.set('encryptConfigs', enabled);
        (async () => {
            try {
                await invoke(COMMANDS.PATCH_SETTINGS, { patch: { encrypt_configs: enabled } });
                showNotification(
                    enabled
                        ? (t.encryptConfigsEnabled || "Config files encrypted")
                        : (t.encryptConfigsDisabled || "Config files decrypted"),
                    "info"
                );
            } catch (err) {
                encryptConfigsToggle.checked = !enabled;
                appStore.set('encryptConfigs', !enabled);
                showNotification(toError(err).message, "error");
            }
        })();
    });
    if (!isPortable) {
        autostartToggle?.addEventListener('change', async () => {
            if (!autostartToggle) return;
            const enabled = autostartToggle.checked;
            try {
                if (enabled) {
                    await enableAutoStart();
                } else {
                    await disableAutoStart();
                }
                await save();
            } catch (err) {
                const error = toError(err);
                autostartToggle.checked = !enabled;
                showNotification(error.toString(), 'error');
            }
        });
    }

    // ---- Save config to core ----
    /**
     * @param {Record<string, any>} patch
     * @returns {Promise<boolean>}
     */
    async function saveConfigToCore(patch) {
        try {
            /** @type {any} */
            const result = await invoke(COMMANDS.UPDATE_CONFIG, { patch });
            await syncCoreConfig();

            if (result && !result.hot_reload_success) {
                /** @type {any} */
                const t2 = /** @type {any} */ (translations)[appStore.get('currentLang')];
                showNotification(result.message || t2.requireRestart || "Changes saved. Restart the core to take effect.", "info");
            }
            return true;
        } catch (err) {
            settingsLogger.error('Failed to save config to core', err);
            /** @type {any} */
            const t2 = /** @type {any} */ (translations)[appStore.get('currentLang')];
            const error = toError(err);
            showNotification(error.toString() || t2.failedSaveSettings || 'Failed to save settings to core', 'error');
            return false;
        }
    }

    // ---- Core settings toggles ----
    unifiedDelayToggle?.addEventListener('change', async () => {
        if (!unifiedDelayToggle) return;
        // Hot-reload via core API, then persist to settings.json
        const ok = await saveConfigToCore({ 'unified-delay': unifiedDelayToggle.checked });
        if (ok) await saveSetting('unified_delay', unifiedDelayToggle.checked);
        /** @type {any} */
        const t = /** @type {any} */ (translations)[appStore.get('currentLang')];
        if (ok) showNotification(t.requireRestart || "Changes saved. Restart the core to take effect.", "info");
        else { unifiedDelayToggle.checked = !unifiedDelayToggle.checked; showNotification(t.saveFailed || "Failed to save", "error"); }
    });

    ipv6Toggle?.addEventListener('change', async () => {
        if (!ipv6Toggle) return;
        // Hot-reload via core API, then persist to settings.json
        const ok = await saveConfigToCore({ ipv6: ipv6Toggle.checked });
        if (ok) await saveSetting('ipv6', ipv6Toggle.checked);
        /** @type {any} */
        const t = /** @type {any} */ (translations)[appStore.get('currentLang')];
        if (ok) showNotification(t.requireRestart || "Changes saved. Restart the core to take effect.", "info");
        else { ipv6Toggle.checked = !ipv6Toggle.checked; showNotification(t.saveFailed || "Failed to save", "error"); }
    });

    allowLanToggle?.addEventListener('change', async () => {
        if (!allowLanToggle) return;
        // Hot-reload via core API, then persist to settings.json
        const ok = await saveConfigToCore({ 'allow-lan': allowLanToggle.checked });
        if (ok) await saveSetting('allow_lan', allowLanToggle.checked);
        /** @type {any} */
        const t = /** @type {any} */ (translations)[appStore.get('currentLang')];
        if (ok) showNotification(t.requireRestart || "Changes saved. Restart the core to take effect.", "info");
        else { allowLanToggle.checked = !allowLanToggle.checked; showNotification(t.saveFailed || "Failed to save", "error"); }
    });

    // ---- Port configuration modal ----
    const portModal = document.getElementById('port-config-modal');
    const portMixedInput = /** @type {HTMLInputElement|null} */ (document.getElementById('port-mixed-input'));
    const portSocksInput = /** @type {HTMLInputElement|null} */ (document.getElementById('port-socks-input'));
    const portRedirInput = /** @type {HTMLInputElement|null} */ (document.getElementById('port-redir-input'));
    const portTproxyInput = /** @type {HTMLInputElement|null} */ (document.getElementById('port-tproxy-input'));
    const portCancelBtn = /** @type {HTMLButtonElement|null} */ (document.getElementById('port-config-cancel'));
    const portSaveBtn = /** @type {HTMLButtonElement|null} */ (document.getElementById('port-config-save'));

    /**
     * Validate a port value: must be a decimal integer in [0, 65535] or empty (0 = disabled).
     * Rejects hex (0x10), octal, scientific notation, and decimals.
     * @param {string} raw
     * @returns {number} Parsed port (0 for empty = disable), or NaN if invalid.
     */
    function parsePortValue(raw) {
        const trimmed = raw.trim();
        if (trimmed === '') return 0; // empty = disable (0)
        if (!/^\d+$/.test(trimmed)) return NaN; // reject non-decimal-integer strings
        return Number(trimmed);
    }

    /** @type {ReturnType<typeof createFocusTrap> | null} */
    let portFocusTrap = null;

    /**
     * Open the port config modal and populate with current values.
     * Reads from settings.json first; falls back to core config for
     * any field that is null (meaning "use YAML default").
     */
    async function openPortModal() {
        try {
            const [userSettings, coreConfig] = await Promise.all([
                invoke(COMMANDS.GET_SETTINGS),
                invoke(COMMANDS.READ_CONFIG).catch(() => ({})),
            ]);
            /** @type {any} */
            const core = coreConfig || {};
            // Use settings.json values when set, otherwise fall back to core config
            if (portMixedInput) portMixedInput.value = String(userSettings.mixed_port ?? core['mixed-port'] ?? core.port ?? '');
            if (portSocksInput) portSocksInput.value = String(userSettings.socks_port ?? core['socks-port'] ?? '');
            if (portRedirInput) portRedirInput.value = String(core['redir-port'] ?? '');
            if (portTproxyInput) portTproxyInput.value = String(core['tproxy-port'] ?? '');
        } catch (err) {
            settingsLogger.warn('Failed to load port config for modal', err);
            return;
        }
        if (portModal) {
            portModal.classList.remove('hidden');
            portModal.classList.add('flex');
            // Animate in
            requestAnimationFrame(() => {
                const inner = portModal.querySelector('.glass-card');
                if (inner instanceof HTMLElement) {
                    inner.style.transform = 'scale(0.96)';
                    inner.style.opacity = '0';
                    requestAnimationFrame(() => {
                        inner.style.transition = 'all 0.25s cubic-bezier(0.16, 1, 0.3, 1)';
                        inner.style.transform = 'scale(1)';
                        inner.style.opacity = '1';
                    });
                }
            });
            if (portFocusTrap) portFocusTrap.destroy();
            portFocusTrap = createFocusTrap(portModal, { onEscape: closePortModal });
            portFocusTrap.activate();
        }
    }

    /**
     * Close the port config modal.
     */
    function closePortModal() {
        if (!portModal) return;
        if (portFocusTrap) {
            portFocusTrap.deactivate();
        }
        const inner = portModal.querySelector('.glass-card');
        if (inner instanceof HTMLElement) {
            inner.style.transition = 'all 0.15s ease-in';
            inner.style.transform = 'scale(0.96)';
            inner.style.opacity = '0';
            setTimeout(() => {
                portModal.classList.add('hidden');
                portModal.classList.remove('flex');
            }, 150);
        } else {
            portModal.classList.add('hidden');
            portModal.classList.remove('flex');
        }
    }

    if (portConfigBtn) {
        portConfigBtn.addEventListener('click', openPortModal);
    }
    if (portCancelBtn) {
        portCancelBtn.addEventListener('click', closePortModal);
    }
    if (portModal) {
        portModal.addEventListener('click', (e) => {
            if (e.target === portModal) closePortModal();
        });
    }

    if (portSaveBtn) {
        portSaveBtn.addEventListener('click', async () => {
            if (portSaveBtn.classList.contains('pointer-events-none')) return;
            portSaveBtn.classList.add('opacity-50', 'pointer-events-none');
            try {
                /** @type {any} */
                const t = /** @type {any} */ (translations)[appStore.get('currentLang')];

                const mixedVal = parsePortValue(portMixedInput?.value || '');
                const socksVal = parsePortValue(portSocksInput?.value || '');
                const redirVal = parsePortValue(portRedirInput?.value || '');
                const tproxyVal = parsePortValue(portTproxyInput?.value || '');

                // Validate range (0 = disabled, 1-65535 = valid port)
                const ports = [
                    { val: mixedVal, key: 'mixed-port', settingsKey: 'mixed_port' },
                    { val: socksVal, key: 'socks-port', settingsKey: 'socks_port' },
                    { val: redirVal, key: 'redir-port', settingsKey: null },
                    { val: tproxyVal, key: 'tproxy-port', settingsKey: null },
                ];
                for (const { val } of ports) {
                    if (!Number.isInteger(val) || val < 0 || val > 65535) {
                        showNotification(t.portRangeError || 'Port must be between 0 and 65535', 'error');
                        return;
                    }
                }

                // Require at least one active proxy port (mixed or socks)
                if (mixedVal === 0 && socksVal === 0) {
                    showNotification(t.portAllDisabledError || 'At least one proxy port (Mixed or SOCKS5) must be enabled', 'error');
                    return;
                }

                // Check for duplicates among the new port values.
                // Ports set to 0 (disabled) are ignored.
                const activePorts = ports.filter(p => p.val > 0).map(p => p.val);
                if (new Set(activePorts).size !== activePorts.length) {
                    showNotification(t.portDuplicateError || 'Ports must not duplicate each other', 'error');
                    return;
                }

                // Build patch — 0 disables the port, non-zero sets it
                // Always disable legacy 'port' key: when mixed-port > 0 it prevents
                // conflict, and when mixed-port = 0 the user intends to fully disable
                /** @type {Record<string, number>} */
                const patch = { port: 0 };
                /** @type {Record<string, number>} */
                const settingsPatch = {};
                for (const { val, key, settingsKey } of ports) {
                    patch[key] = val;
                    if (settingsKey) settingsPatch[settingsKey] = val;
                }

                const ok = await saveConfigToCore(patch);
                if (ok) {
                    // Persist port values to settings.json
                    await saveSettings(settingsPatch);
                    await loadSettingsFromCore();
                    closePortModal();
                }
            } finally {
                portSaveBtn.classList.remove('opacity-50', 'pointer-events-none');
            }
        });
    }

    // ---- Geo data update ----
    updateGeoBtn?.addEventListener('click', async () => {
        if (appStore.get('isNetworkUpdating')) return;
        appStore.set('isNetworkUpdating', true);

        const ring = createStatusRing(updateGeoBtn);
        ring.show();
        /** @type {(() => void) | undefined} */
        let unlisten;

        /** @type {any} */
        const t = /** @type {any} */ (translations)[appStore.get('currentLang')];
        showNotification(t.notifGeoUpdating || "Updating Geo databases...");

        try {
            unlisten = await listen('core-download-status', (/** @type {{ payload: { component?: string, progress: number } }} */ event) => {
                if (event.payload.component === 'geo_data') {
                    ring.setProgress(event.payload.progress);
                }
            });
            await invoke(COMMANDS.UPDATE_GEO_DATA);
            /** @type {any} */
            const t2 = /** @type {any} */ (translations)[appStore.get('currentLang')];
            showNotification(t2.notifGeoUpdateSuccess || "Geo databases updated and core restarted!", 'success');

            /** @type {any} */
            const geoSettings = await invoke(COMMANDS.GET_SETTINGS);
            const configPath = geoSettings.last_config || 'config.yaml';
            const customArgs = geoSettings.custom_args || [];
            abortLatencyTests();
            await restartCore(configPath, customArgs);
            await postRestartRecovery(configPath);
            ring.setSuccess();
        } catch (err) {
            ring.setError();
            const error = toError(err);
            showNotification(error.toString(), 'error');
} finally {
if (unlisten) unlisten();
setTimeout(() => {
ring.destroy();
appStore.set('isNetworkUpdating', false);
}, 3500);
}
    });

    // ---- Backup & Restore ----
    const exportBackupBtn = document.getElementById('export-backup-btn');
    const importBackupBtn = document.getElementById('import-backup-btn');

    exportBackupBtn?.addEventListener('click', async () => {
        if (exportBackupBtn.classList.contains('pointer-events-none')) return;
        exportBackupBtn.classList.add('opacity-50', 'pointer-events-none');
        /** @type {any} */
        const t = /** @type {any} */ (translations)[appStore.get('currentLang')];
        try {
            const savedPath = await invoke(COMMANDS.MISC.EXPORT_BACKUP);
            showNotification(
                (t?.backupExportSuccess || 'Backup exported to') + ': ' + savedPath,
                'success',
            );
        } catch (err) {
            const error = toError(err);
            showNotification(error.toString(), 'error');
        } finally {
            exportBackupBtn.classList.remove('opacity-50', 'pointer-events-none');
        }
    });

    importBackupBtn?.addEventListener('click', async () => {
        if (importBackupBtn.classList.contains('pointer-events-none')) return;
        importBackupBtn.classList.add('opacity-50', 'pointer-events-none');
        try {
            /** @type {any} */
            const t = /** @type {any} */ (translations)[appStore.get('currentLang')];
            const confirmed = await showConfirmModal(
                t?.backupImportConfirm || 'Importing will replace your current configuration. Continue?',
                '',
            );
            if (!confirmed) {
                importBackupBtn.classList.remove('opacity-50', 'pointer-events-none');
                return;
            }
            const result = await invoke(COMMANDS.MISC.IMPORT_BACKUP);
            showNotification(result, 'success');
            // Reload settings and restart core in the background to avoid
            // blocking the UI. The import is already complete at this point.
            (async () => {
                try {
                    const importedSettings = await invoke(COMMANDS.GET_SETTINGS) || {};
                    const configPath = importedSettings.last_config || 'config.yaml';
                    const customArgs = importedSettings.custom_args || [];
                    abortLatencyTests();
                    await restartCore(configPath, customArgs);
                    await postRestartRecovery(configPath);
                    window.location.reload();
                } catch (err) {
                    // eslint-disable-next-line no-console
                    console.error('Failed to restart core after backup restore:', err);
                    showNotification((err ?? 'Failed to restart core after restore').toString(), 'error');
                    // Delay reload to allow the user to read the error
                    // notification, but always reload to ensure UI-disk
                    // consistency (disk has the new imported settings).
                    setTimeout(() => {
                        window.location.reload();
                    }, 3000);
                }
            })();
        } catch (err) {
            const error = toError(err);
            showNotification(error.toString(), 'error');
            importBackupBtn.classList.remove('opacity-50', 'pointer-events-none');
        }
    });

    // ---- Tunnel management (delegated to settings/tunnels.js) ----
    const tunnelApi = initTunnelSettings({
        addTunnelBtn,
        tunnelsList,
        tunnelsEmpty,
        initialTunnels: currentTunnels,
        saveConfigToCore,
    });

    // ---- Load settings from core ----
    // Reads user preferences from settings.json; falls back to core config
    // for any field that is null (meaning "use YAML default").
    const loadSettingsFromCore = async () => {
        try {
            const [userSettings, coreConfig] = await Promise.all([
                invoke(COMMANDS.GET_SETTINGS),
                invoke(COMMANDS.READ_CONFIG).catch(() => ({})),
            ]);
            /** @type {any} */
            const config = coreConfig || {};
            // Prefer settings.json values; fall back to core config
            if (unifiedDelayToggle) unifiedDelayToggle.checked = userSettings.unified_delay != null ? !!userSettings.unified_delay : config['unified-delay'] !== false;
            if (ipv6Toggle) ipv6Toggle.checked = userSettings.ipv6 != null ? !!userSettings.ipv6 : !!config.ipv6;
            if (allowLanToggle) allowLanToggle.checked = userSettings.allow_lan != null ? !!userSettings.allow_lan : !!config['allow-lan'];

            // Update port display — use settings.json values when set, fallback to core config
            if (portDisplay) {
                // Check all ports in priority order: mixed > socks
                const settingsPort = [userSettings.mixed_port, userSettings.socks_port]
                    .find((port) => port != null && port > 0);
                const displayPort = settingsPort
                    || config['mixed-port'] || config.port || config['socks-port'] || 0;
                portDisplay.textContent = displayPort > 0 ? String(displayPort) : '--';
            }

            if (config.tunnels && Array.isArray(config.tunnels)) {
                currentTunnels = config.tunnels;
            } else {
                currentTunnels = [];
            }
            tunnelApi.setTunnels(currentTunnels);
        } catch (err) {
            settingsLogger.error('Failed to load core config into settings', err);
        }
    };

    // ---- Open config folder ----
    openConfigFolderBtn?.addEventListener('click', async () => {
        try {
            await openConfigFolder();
        } catch (err) {
            const error = toError(err);
            showNotification(error.toString(), 'error');
        }
    });

    // ---- Drag-and-drop import listener ----
    if (_dropUnlisten) {
        _dropUnlisten();
    }
    if (typeof listen === 'function') {
        listen('profiles-imported', (/** @type {{ payload: number }} */ event) => {
            const importedCount = event.payload;
            if (importedCount > 0) {
                /** @type {any} */
                const t = /** @type {any} */ (translations)[appStore.get('currentLang')];
                showNotification(`${t.profilesImported?.replace('{count}', importedCount) || `Successfully imported ${importedCount} profile(s)`}`, 'success');
                if (typeof /** @type {any} */ (window).refreshConfigs === 'function') {
                    /** @type {any} */ (window).refreshConfigs();
                }
                renderConfigs();
            }
        }).then(unlisten => {
            _dropUnlisten = unlisten;
        }).catch(e => settingsLogger.warn('Failed to listen for profiles-imported event', e));
    }

    // Theme circles are handled by initThemeSettings above

    // ---- Node scroll toggle ----
    nodeScrollToggle?.addEventListener('change', () => {
        if (!nodeScrollToggle) return;
        saveSetting('node_scroll', nodeScrollToggle.checked).catch((e) =>
            settingsLogger.warn("Failed to persist nodeScroll change", e)
        );
        // Clear the container to force full re-render (in-place update won't update CSS classes)
        const container = document.getElementById('proxies-list');
        if (container) container.replaceChildren();
        Bus.emit(Events.CONFIG_UPDATED);
    });

    // ---- Core version ----
    let currentCoreVersion = "";

    const loadCoreVersion = async () => {
        try {
            currentCoreVersion = await invoke(COMMANDS.GET_CORE_VERSION);
            if (versionText) versionText.textContent = currentCoreVersion.startsWith('v') ? currentCoreVersion : `v${currentCoreVersion}`;
        } catch (err) {
            settingsLogger.error('Failed to get core version', err);
            if (versionText) {
                /** @type {any} */
                const t = /** @type {any} */ (translations)[appStore.get('currentLang')];
                versionText.textContent = t.unknown || 'Unknown';
            }
        }
    };
    loadCoreVersion();

    // ---- App version ----
    const appVersionText = document.getElementById('app-version-text');
    if (appVersionText) {
        try {
            const appVersion = await invoke(COMMANDS.GET_APP_VERSION);
            appVersionText.textContent = appVersion;
        } catch {
            appVersionText.textContent = '-';
        }
    }

    loadSettingsFromCore();

    // ---- Auto-update check ----
    /**
     * @param {string} latestVersion
     * @param {string} downloadUrl
     */
    const performCoreUpdate = async (latestVersion, downloadUrl) => {
        if (!checkUpdateBtn) return;
        /** @type {any} */
        const t = /** @type {any} */ (translations)[appStore.get('currentLang')];
        const confirmed = await showConfirmModal(t.notifUpdateFound, latestVersion);
        if (!confirmed) return;

        const ring = createStatusRing(checkUpdateBtn);
        ring.show();
        /** @type {(() => void) | undefined} */
        let unlisten;

        try {
            unlisten = await listen('core-download-status', (/** @type {{ payload: { component?: string, progress: number } }} */ event) => {
                if (event.payload.component === 'core') {
                    ring.setProgress(event.payload.progress);
                }
            });
            showNotification(t.notifUpdating);
            /** @type {any} */
            const coreResult = await invoke(COMMANDS.UPDATE_CORE, {
                url: downloadUrl,
            });
            setBaseUrl(`http://127.0.0.1:${coreResult.port}`);
            setWsBaseUrl(`ws://127.0.0.1:${coreResult.port}`);
            setSecret(coreResult.secret);
            setWsSecret(coreResult.secret);

            // Reconnect traffic WebSocket to the new core instance
            connectTraffic((/** @type {any} */ data) => {
                updateTrafficData(data);
            });

            showNotification(t.notifUpdateSuccess, 'success');
            await loadCoreVersion();
            await syncCoreConfig();
            ring.setSuccess();
        } catch (err) {
            ring.setError();
            const error = toError(err);
            showNotification(error.toString(), 'error');
        } finally {
            if (unlisten) unlisten();
            setTimeout(() => ring.destroy(), 3500);
        }
    };

    /**
     * @param {string} version
     */
    const performClientUpdate = async (version) => {
        if (!checkUpdateBtn) return;
        /** @type {any} */
        const t = /** @type {any} */ (translations)[appStore.get('currentLang')];
        const ring = createStatusRing(checkUpdateBtn);
        ring.show();
        /** @type {(() => void) | undefined} */
        let unlisten;
        try {
            unlisten = await listen('core-download-status', (/** @type {{ payload: { component?: string, progress: number } }} */ event) => {
                if (event.payload.component === 'client') {
                    ring.setProgress(event.payload.progress);
                }
            });
            await invoke(COMMANDS.UPDATE_CLIENT);
            ring.setSuccess();
            showNotification(`${t.clientUpdateSuccess || 'Update downloaded'} (${version})`, 'success');
        } catch (e) {
            ring.setError();
            showNotification(`${t.clientUpdateFailed || 'Update failed'}: ${e}`, 'error');
        } finally {
            if (unlisten) unlisten();
            setTimeout(() => ring.destroy(), 3500);
        }
    };

    if (checkUpdateBtn) {
        checkUpdateBtn.onclick = async () => {
            if (checkUpdateBtn.disabled) return;
            checkUpdateBtn.disabled = true;

            try {
                const t = /** @type {any} */ (translations)[appStore.get('currentLang')];

                showNotification(t.notifUpdateCheck);

                // Check both core and client updates in parallel
                const [latest, clientInfo, currentAppVersion] = await Promise.all([
                    invoke(COMMANDS.GET_LATEST_VERSION),
                    invoke(COMMANDS.GET_LATEST_CLIENT_VERSION),
                    invoke(COMMANDS.GET_APP_VERSION),
                ]);

                const coreHasUpdate = latest && latest.version && latest.version !== currentCoreVersion;
                const clientHasUpdate = clientInfo && clientInfo.version && clientInfo.version !== currentAppVersion;

                if (!coreHasUpdate && !clientHasUpdate) {
                    showNotification(t.notifNoUpdate, 'success');
                    return;
                }

                if (coreHasUpdate && clientHasUpdate) {
                    // Both have updates — download Full version (includes core + client)
                    const confirmed = await showConfirmModal(
                        t.bothUpdateAvailable || 'Both core and client have updates',
                        `${t.coreUpdate || 'Core'}: ${currentCoreVersion} → ${latest.version}\n${t.clientUpdate || 'Client'}: ${currentAppVersion} → ${clientInfo.version}\n\n${t.recommendFullVersion || 'Recommend installing Full version'}`
                    );
                    if (confirmed) {
                        await performClientUpdate(clientInfo.version);
                    }
                } else if (coreHasUpdate) {
                    await performCoreUpdate(latest.version, latest.download_url);
                } else {
                    // Only client update
                    const confirmed = await showUpdateNotesModal(
                        `${t.clientUpdateAvailable || 'Client Update Available'}: v${clientInfo.version}`,
                        clientInfo.release_notes || ''
                    );
                    if (confirmed) {
                        await performClientUpdate(clientInfo.version);
                    }
                }
            } catch (err) {
                const error = toError(err);
                showNotification(error.toString(), 'error');
            } finally {
                checkUpdateBtn.disabled = false;
            }
        };
    }

    // ---- Extension Rules: Auto Apply toggle ----
    const autoApplyToggle = /** @type {HTMLInputElement|null} */ (document.getElementById('setting-auto-apply'));
    if (autoApplyToggle) {
        // Load current state
        try {
            const enabled = /** @type {boolean} */ (await invoke(COMMANDS.RULE_GET_AUTO_APPLY));
            autoApplyToggle.checked = !!enabled;
        } catch (err) {
            settingsLogger.warn('Failed to load auto-apply state', err);
        }

        // Sync toggle with actual watcher state
        try {
            const watching = /** @type {boolean} */ (await prism.isWatching());
            if (watching !== autoApplyToggle.checked) {
                settingsLogger.warn('Auto-apply toggle and watcher state disagree, syncing', { toggle: autoApplyToggle.checked, watching });
                autoApplyToggle.checked = watching;
            }
        } catch {
            // isWatching may not be available — ignore
        }

        autoApplyToggle.addEventListener('change', async () => {
            const checked = autoApplyToggle.checked;
            try {
                await invoke(COMMANDS.RULE_SET_AUTO_APPLY, { enabled: checked });
                if (checked) {
                    await prism.startWatching();
                } else {
                    await prism.stopWatching();
                }
            } catch (err) {
                settingsLogger.error('Failed to toggle auto-apply', err);
                autoApplyToggle.checked = !checked;
            }
        });
    }

    // ---- Extension Rules: Manage Rule Files button ----
    const manageRuleFilesBtn = document.getElementById('manage-rule-files-btn');
    if (manageRuleFilesBtn) {
        manageRuleFilesBtn.addEventListener('click', async () => {
            try {
                await openPrismFolder();
            } catch (err) {
                const error = toError(err);
                showNotification(error.toString(), 'error');
            }
        });
    }

    // --- Smart Proxy Selector ---
    const smartToggle = /** @type {HTMLInputElement|null} */ (document.getElementById('smart-toggle'));
    const smartConfigBtn = document.getElementById('smart-config-btn');

    if (smartToggle) {
        // Initialize from backend smart config, fallback to localStorage for migration
        const initSmartEnabled = async () => {
            try {
                /** @type {any} */
                const config = await prism.smartConfig();
                smartToggle.checked = config.enabled ?? localStorage.getItem('smartEnabled') === 'true';
            } catch {
                smartToggle.checked = localStorage.getItem('smartEnabled') === 'true';
            }
            document.documentElement.style.setProperty('--smart-enabled', smartToggle.checked ? '1' : '0');
        };

        smartToggle.onchange = async () => {
            document.documentElement.style.setProperty('--smart-enabled', smartToggle.checked ? '1' : '0');
            // Always sync to localStorage as fallback for migration scenarios
            localStorage.setItem('smartEnabled', String(smartToggle.checked));
            try {
                /** @type {any} */
                const config = await prism.smartConfig();
                config.enabled = smartToggle.checked;
                await prism.smartConfigSave(config);
            } catch (err) {
                settingsLogger.error('[smart] Failed to persist enabled state:', err);
            }
            Bus.emit(Events.CONFIG_UPDATED);
        };

        // Important: initialize smartToggle.checked BEFORE wiring auto-test toggle state.
        // Otherwise auto-test may be disabled/cleared on startup due to a race.
        await initSmartEnabled();
    }

    // Smart Auto-Test toggle
    const autoTestToggle = /** @type {HTMLInputElement|null} */ (document.getElementById('smart-auto-test-toggle'));
    if (autoTestToggle) {
        const savedAutoTest = localStorage.getItem('smartAutoTest');
        autoTestToggle.checked = savedAutoTest === 'true';
        // Disable auto-test toggle when smart is off
        const syncAutoTestState = () => {
            const smartOn = smartToggle?.checked ?? false;
            autoTestToggle.disabled = !smartOn;
            autoTestToggle.closest('.flex')?.classList.toggle('opacity-50', !smartOn);
            if (!smartOn && autoTestToggle.checked) {
                autoTestToggle.checked = false;
                localStorage.setItem('smartAutoTest', 'false');
                stopSmartAutoTest();
            }
        };
        syncAutoTestState();

        autoTestToggle.onchange = () => {
            if (autoTestToggle.disabled) {
                return;
            }
            localStorage.setItem('smartAutoTest', String(autoTestToggle.checked));
            if (autoTestToggle.checked) {
                startSmartAutoTest();
            } else {
                stopSmartAutoTest();
            }
        };

        // Re-sync when smart toggle changes (must be set after smartToggle.onchange)
        if (smartToggle && !/** @type {any} */(smartToggle)._onchangeWrapped) {
            /** @type {any} */(smartToggle)._onchangeWrapped = true;
            const origSmartOnChange = /** @type {((e?: Event) => any) | null | undefined} */ (smartToggle.onchange);
            smartToggle.onchange = async (e) => {
                if (origSmartOnChange) {
                    try {
                        await origSmartOnChange.call(smartToggle, e);
                    } catch (err) {
                        // eslint-disable-next-line no-console
                        console.error('Error in smart toggle change handler:', err);
                    }
                }
                (async () => {
                    try {
                        await syncAutoTestState();
                    } catch (err) {
                        // eslint-disable-next-line no-console
                        console.error('Error syncing auto test state:', err);
                    }
                })();
            };
        }
    }

    // Smart config modal (replaces inline expandable panel)
    if (smartConfigBtn) {
        smartConfigBtn.onclick = async () => {
            // Remove existing modal if any
            document.getElementById('smart-config-modal')?.remove();

            /** @type {Record<string, any>} */
            const t = /** @type {any} */ (translations)[appStore.get('currentLang')] ?? {};

            // Load current config
            /** @type {any} */
            let config = {};
            try {
                config = await prism.smartConfig();
            } catch (err) {
                settingsLogger.error('[smart] Failed to load config:', err);
            }

            const modal = document.createElement('div');
            modal.id = 'smart-config-modal';
            modal.className = 'fixed inset-0 z-[var(--z-modal)] flex items-center justify-center bg-[var(--zephyr-bg-overlay)] backdrop-blur-md';
            // eslint-disable-next-line no-unsanitized/property -- i18n translation keys
            modal.innerHTML = ` // nosemgrep: js-innerhtml-assignment — verified safe, see eslint-disable above
                <div class="glass-card w-[440px] p-6 space-y-5">
                    <div class="flex items-center justify-between">
                        <h3 class="text-sm font-bold text-[var(--text-primary)]">${t.smartProxyConfigTitle || 'Smart Proxy Settings'}</h3>
                        <button id="smart-modal-close" class="text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors">
                            <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
                        </button>
                    </div>
                    <div class="grid grid-cols-2 gap-4">
                        <div class="flex flex-col gap-1.5">
                            <label class="text-2xs text-[var(--text-muted)] font-medium uppercase tracking-wider">${t.smartProxyWeightLatency || 'Latency Weight'}</label>
                            <input id="smart-weight-latency" type="number" step="0.1" min="0" max="1" value="${config.latency_weight ?? 0.4}" class="form-control form-control-md form-control-mono">
                        </div>
                        <div class="flex flex-col gap-1.5">
                            <label class="text-2xs text-[var(--text-muted)] font-medium uppercase tracking-wider">${t.smartProxyWeightSuccess || 'Success Rate Weight'}</label>
                            <input id="smart-weight-success" type="number" step="0.1" min="0" max="1" value="${config.success_weight ?? 0.4}" class="form-control form-control-md form-control-mono">
                        </div>
                        <div class="flex flex-col gap-1.5">
                            <label class="text-2xs text-[var(--text-muted)] font-medium uppercase tracking-wider">${t.smartProxyWeightStability || 'Stability Weight'}</label>
                            <input id="smart-weight-stability" type="number" step="0.1" min="0" max="1" value="${config.stability_weight ?? 0.2}" class="form-control form-control-md form-control-mono">
                        </div>
                        <div class="flex flex-col gap-1.5">
                            <label class="text-2xs text-[var(--text-muted)] font-medium uppercase tracking-wider">${t.smartProxyHalfLife || 'Half-life (hours)'}</label>
                            <input id="smart-half-life" type="number" step="0.5" min="0.1" value="${config.half_life_hours ?? 1.0}" class="form-control form-control-md form-control-mono">
                        </div>
                        <div class="flex flex-col gap-1.5">
                            <label class="text-2xs text-[var(--text-muted)] font-medium uppercase tracking-wider">${t.smartProxyMinInterval || 'Min Test Interval (s)'}</label>
                            <input id="smart-min-interval" type="number" min="10" value="${config.min_interval_secs ?? 60}" class="form-control form-control-md form-control-mono">
                        </div>
                        <div class="flex flex-col gap-1.5">
                            <label class="text-2xs text-[var(--text-muted)] font-medium uppercase tracking-wider">${t.smartProxyMaxInterval || 'Max Test Interval (s)'}</label>
                            <input id="smart-max-interval" type="number" min="60" value="${config.max_interval_secs ?? 600}" class="form-control form-control-md form-control-mono">
                        </div>
                    </div>
                    <div class="flex justify-end pt-1">
                        <button id="smart-modal-done" class="btn-ghost text-xs px-4 py-2">${t.done || 'Done'}</button>
                    </div>
                </div>
            `;

            document.body.appendChild(modal);

            // Animate in
            requestAnimationFrame(() => {
                const panel = modal.querySelector('.glass-card');
                if (panel instanceof HTMLElement) {
                    panel.style.transform = 'scale(0.96)';
                    panel.style.opacity = '0';
                    requestAnimationFrame(() => {
                        panel.style.transition = 'all 0.25s cubic-bezier(0.16, 1, 0.3, 1)';
                        panel.style.transform = 'scale(1)';
                        panel.style.opacity = '1';
                    });
                }
            });

            const closeModal = () => {
                const panel = modal.querySelector('.glass-card');
                if (panel instanceof HTMLElement) {
                    panel.style.transition = 'all 0.15s ease-in';
                    panel.style.transform = 'scale(0.96)';
                    panel.style.opacity = '0';
                    setTimeout(() => modal.remove(), 150);
                } else {
                    modal.remove();
                }
            };

            document.getElementById('smart-modal-close')?.addEventListener('click', closeModal);
            modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
            document.getElementById('smart-modal-done')?.addEventListener('click', closeModal);

            // Save on input change (debounced)
            const inputs = /** @type {NodeListOf<HTMLInputElement>} */ (modal.querySelectorAll('input[type="number"]'));
            const saveConfig = debounce(async () => {
                try {
                    const configJson = {
                        latency_weight: parseFloat(/** @type {HTMLInputElement|null} */ (modal.querySelector('#smart-weight-latency'))?.value || '0.4'),
                        success_weight: parseFloat(/** @type {HTMLInputElement|null} */ (modal.querySelector('#smart-weight-success'))?.value || '0.4'),
                        stability_weight: parseFloat(/** @type {HTMLInputElement|null} */ (modal.querySelector('#smart-weight-stability'))?.value || '0.2'),
                        half_life_hours: parseFloat(/** @type {HTMLInputElement|null} */ (modal.querySelector('#smart-half-life'))?.value || '1.0'),
                        min_interval_secs: parseInt(/** @type {HTMLInputElement|null} */ (modal.querySelector('#smart-min-interval'))?.value || '60', 10),
                        max_interval_secs: parseInt(/** @type {HTMLInputElement|null} */ (modal.querySelector('#smart-max-interval'))?.value || '600', 10),
                    };
                    await prism.smartConfigSave(configJson);
                } catch (err) {
                    settingsLogger.error('[smart] Failed to save config:', err);
                }
            }, 500);
            inputs.forEach(input => input.addEventListener('input', /** @type {EventListener} */ (saveConfig)));
        };
    }

    // Initialize log settings modal
    initLogSettingsModal();

    initCopyEnvSettings();

    initFakeClient();

    // Initialize network optimization UI
    initNetworkOptim().catch(() => {});

    // Start smart auto-test scheduler if enabled
    const shouldStartAutoTest = localStorage.getItem('smartAutoTest') === 'true';
    if (shouldStartAutoTest) {
        // Delay to ensure smart toggle state is initialized first
        setTimeout(() => {
            startSmartAutoTest();
        }, 2000);
    }
}

// ---------------------------------------------------------------------------
//  DNS configuration (delegated to dns-shared.js)
// ---------------------------------------------------------------------------
export { DEFAULT_DNS_CONFIG, isValidIPv6, isValidDns, getDnsConfig, buildDnsRewritePayload, applyDnsRewrite, initDnsRewriteToggle };

// ---------------------------------------------------------------------------
//  Public API -- re-exports for other modules
// ---------------------------------------------------------------------------
export { getFakeClientUA, getSubscriptionUserAgent, extractNameFromUrl };
