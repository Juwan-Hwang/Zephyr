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
    readAutoStartEnabled,
    enableAutoStart,
    disableAutoStart,
    openConfigFolder,
    openPrismFolder,
    setSecret,
    setBaseUrl,
    getConfig,
    closeAllConnections,
} from '../api.js';
import { setWsSecret, setWsBaseUrl, forceReconnect } from '../websocket.js';
import { translations, setLanguage } from '../i18n.js';
import { escapeHtml } from '../utils/sanitize.js';
import { debounce } from '../utils/debounce.js';
import { createSerialQueue } from '../utils/sequential.js';
import { settingsLogger } from '../utils/logger.js';
import { showNotification, showConfirmModal } from './notifications.js';
import { applyTheme, DEFAULT_THEME } from './theme.js';
import { appStore } from './state.js';
import { Bus, Events } from './events.js';
import { pasteWithFeedback } from '../utils/clipboard.js';
import { checkConsoleWidthNotification } from './console-width.js';
import { invalidateSettingsCache } from './cache.js';
import { postRestartRecovery, restartedProfile, withPageBusy } from './lifecycle.js';
import { saveSetting, saveSettingChecked, saveSettings } from './settings-helpers.js';
import { initNetworkOptim } from './network-optim.js';
import {
    DEFAULT_DNS_CONFIG,
    isValidIPv6,
    isValidDns,
    getDnsConfig,
    buildDnsRewritePayload,
    applyDnsRewrite,
    dnsShownAfterFailure,
    forgetUnsavedDnsChoice,
    initDnsRewriteToggle,
} from './dns-shared.js';
import { toError } from '../types/guards.js';
import { COMMANDS } from '@zephyr/shared';
import { createFocusTrap } from '../utils/focus-trap.js';

/** Focus trap of each open settings dialog, so a reopen can release the old one. */
const _modalTraps = new WeakMap();
/** Shortest automatic latency-test interval the smart settings accept (seconds). */
const SMART_MIN_TEST_INTERVAL_SECS = 60;
/** Remove a still-open dialog by id, releasing its focus trap first. @param {string} id */
function dropOpenModal(id) {
    const el = document.getElementById(id);
    if (!el) return;
    _modalTraps.get(el)?.deactivate();
    el.remove();
}
import { initSettingsNav } from './settings-nav.js';
import { createStatusRing } from './status-ring.js';
import * as prism from './prism.js';

// The following modules have not yet been extracted from ui.js.
// We import them from ui.js for now; when they are extracted, these
// imports will be updated to point to their own files.
import { navigateTo } from './navigation.js';
import { initCustomDropdown } from './dropdown.js';
import { registerCleanup } from '../utils/cleanup-registry.js';
import { syncCoreConfig, startSmartAutoTest, stopSmartAutoTest } from './proxies.js';
import { updateModeUI } from './modes.js';

// Settings submodules
import { initThemeSettings } from './settings/theme.js';
import { initTunnelSettings } from './settings/tunnels.js';
import { applyFailover, applySmart, applyAutoTest, readSmartState, readAutoTestEnabled, shownFailover, queueSmartConfigWrite, smartEnabledOf } from './settings/auto-switch.js';
import { initSubscriptionSettings, keepFallbackProfile } from './settings/subscriptions.js';
import { withResetChanges } from './settings/reset-merge.js';
import { selectSegment } from './seg-control.js';
import { openUpdateDialog, showPendingUpdateNote } from './update-dialog.js';
import { createClientVersionFetcher, isValidClientVersions } from './settings/client-version-fetch.js';

let __langDropdown = null;
/** @type {(() => Promise<void>) | null} */
let _dropUnlisten = null;

/**
 * Release a Tauri event listener; a failed unlisten is logged, never thrown.
 * @param {() => Promise<void>} unlisten
 */
function dropListener(unlisten) {
    unlisten().catch(e => settingsLogger.warn('Failed to remove event listener', e));
}

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
 * - Format chip: shows the shell format and opens a menu to change it
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
            // Same rule as the tray copy: an HTTP-capable listener first, else
            // the SOCKS listener with a socks5h:// URL; never an invented port.
            const httpPort = currentConfig?.['mixed-port'] || currentConfig?.port;
            const socksPort = currentConfig?.['socks-port'];
            const port = httpPort || socksPort;
            if (!port) throw new Error('No proxy listener is configured');
            const text = generateProxyEnvVars(format, port, httpPort ? 'http' : 'socks5h');
            await copyToClipboard(text);
            const t = getT();
            // Visual feedback: briefly change button text (target span to preserve i18n)
            const textSpan = copyBtn.querySelector('span') || copyBtn;
            // Store original text only on first click (not during "Copied" state)
            if (!copyBtn.dataset._originalText) {
                copyBtn.dataset._originalText = textSpan.textContent || '';
            }
            textSpan.textContent = t.copyEnvCopied || 'Copied';
            copyBtn.style.color = 'var(--accent-primary, #007AFF)';
            const timeoutId = setTimeout(() => {
                textSpan.textContent = copyBtn.dataset._originalText || '';
                copyBtn.style.color = '';
                delete copyBtn.dataset._originalText;
                delete copyBtn.dataset._copyTimeout;
            }, 1500);
            copyBtn.dataset._copyTimeout = String(timeoutId);
        } catch (err) {
            settingsLogger.error('[copy-env] Failed to copy:', err);
            showNotification(`${getT().copyFailed || 'Copy failed'}: ${toError(err).message}`, 'error');
        }
    });

    // --- Shell format: a visible chip next to Copy, opening a small menu ---
    const formatLabel = document.getElementById('copy-env-format-label');
    const formatMenu = document.getElementById('copy-env-format-menu');
    const formatList = formatMenu?.querySelector('.menu-scroll');
    const formats = [
        { key: 'bash', label: 'Bash / Zsh', short: 'Bash' },
        { key: 'fish', label: 'Fish', short: 'Fish' },
        { key: 'cmd', label: 'CMD', short: 'CMD' },
        { key: 'powershell', label: 'PowerShell', short: 'PowerShell' },
        { key: 'nushell', label: 'Nushell', short: 'Nushell' },
    ];
    /** @type {string} */
    let currentFormat = 'bash';
    /** The format settings hold (what Copy uses); a failed pick falls back to it. */
    let savedFormat = 'bash';
    /** Bumped on every pick, so a settings read started earlier cannot undo it. */
    let formatPickSeq = 0;
    /** @type {Promise<unknown>} */
    let formatSaveChain = Promise.resolve();

    /** @param {string} key */
    const showFormat = (key) => {
        currentFormat = key;
        if (formatLabel) formatLabel.textContent = formats.find(f => f.key === key)?.short || key;
        formatList?.querySelectorAll('[data-format]').forEach(el => {
            const on = /** @type {HTMLElement} */ (el).dataset.format === key;
            el.setAttribute('aria-checked', String(on));
            el.classList.toggle('is-selected', on);
        });
    };

    if (formatList) {
        formatList.replaceChildren(...formats.map(f => {
            const b = document.createElement('button');
            b.type = 'button';
            b.setAttribute('role', 'menuitemradio');
            b.dataset.format = f.key;
            b.className = 'env-format-option w-full flex items-center justify-between px-3 py-2 rounded-[var(--radius-dropdown-option)] text-xs text-[var(--text-secondary)] hover:bg-[var(--zephyr-bg-muted)] transition-colors text-start';
            const span = document.createElement('span');
            span.textContent = f.label;
            b.appendChild(span);
            return b;
        }));
    }

    const closeMenu = () => {
        formatMenu?.classList.add('hidden');
        formatBtn?.setAttribute('aria-expanded', 'false');
    };
    const openMenu = () => {
        formatMenu?.classList.remove('hidden');
        formatBtn?.setAttribute('aria-expanded', 'true');
        /** @type {HTMLElement|null|undefined} */ (formatList?.querySelector('[aria-checked="true"]'))?.focus();
    };

    formatBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        if (formatMenu?.classList.contains('hidden')) openMenu(); else closeMenu();
    });
    formatList?.addEventListener('click', async (e) => {
        const btn = /** @type {HTMLElement|null} */ ((/** @type {HTMLElement} */ (e.target)).closest('[data-format]'));
        const key = btn?.dataset.format;
        if (!key) return;
        const mySeq = ++formatPickSeq;
        showFormat(key);
        closeMenu();
        formatBtn?.focus();
        // Saves go out one after another, so the last pick is the one that ends up saved.
        const save = formatSaveChain.then(() => invoke(COMMANDS.PATCH_SETTINGS, { patch: { copy_env_format: key } }));
        formatSaveChain = save.catch(() => {});
        try {
            await save;
            savedFormat = key;
        } catch (err) {
            settingsLogger.error('[copy-env] Failed to save format:', err);
            // Copy reads the saved format: the chip must not claim one that was not saved
            // (unless a newer pick has replaced it since). savedFormat may still be the
            // placeholder if the first read had not landed, so read settings again.
            if (mySeq === formatPickSeq) {
                showFormat(savedFormat);
                void loadFormat();
            }
            const tr = /** @type {any} */ (translations)[appStore.get('currentLang')] ?? {};
            showNotification(tr.saveFailed || 'Failed to save', 'error');
        }
    });
    formatMenu?.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { closeMenu(); formatBtn?.focus(); return; }
        if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
        e.preventDefault();
        const items = /** @type {HTMLElement[]} */ (Array.from(formatList?.querySelectorAll('[data-format]') || []));
        const i = items.indexOf(/** @type {HTMLElement} */ (document.activeElement));
        items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
    });
    document.addEventListener('click', (e) => {
        if (!formatMenu || formatMenu.classList.contains('hidden')) return;
        if (!(/** @type {HTMLElement} */ (e.target)).closest('#copy-env-format-wrap')) closeMenu();
    });

    let formatLoadSeq = 0;
    const loadFormat = async () => {
        const seq = ++formatLoadSeq;
        const picked = formatPickSeq;
        try {
            // Read only after the picks already made are saved, or the read can return the old format.
            await formatSaveChain;
            const settings = await invoke(COMMANDS.GET_SETTINGS);
            const { resolveEnvFormat } = await import('./tray.js');
            // A newer read, or a format picked meanwhile, wins over this one.
            if (seq !== formatLoadSeq || picked !== formatPickSeq) return;
            savedFormat = resolveEnvFormat(settings.copy_env_format);
            showFormat(savedFormat);
        } catch { if (seq === formatLoadSeq) showFormat(currentFormat); }
    };
    void loadFormat();
    // Restore Defaults clears the format; it emits CONFIG_UPDATED when done.
    Bus.on(Events.CONFIG_UPDATED, () => { void loadFormat(); });
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
            // Another network change may have started while the dialog was open.
            if (appStore.get('isNetworkUpdating')) {
                showNotification(t.updNetworkBusy || 'Another network change is in progress. Try again when it finishes.', 'warning');
                return;
            }

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
        dropOpenModal('log-settings-modal');

        const t = getT();
        const logAppEnabled = Boolean(appStore.get('logAppEnabled'));
        const logCoreEnabled = Boolean(appStore.get('logCoreEnabled'));
        const rawRetention = Number(appStore.get('logRetentionDays'));
        const retentionDays = Number.isInteger(rawRetention) && rawRetention >= 1 && rawRetention <= 30 ? rawRetention : 3;
        const rawMaxFileMb = Number(appStore.get('logMaxFileMb'));
        const maxFileMb = Number.isInteger(rawMaxFileMb) && rawMaxFileMb >= 1 && rawMaxFileMb <= 500 ? rawMaxFileMb : 50;

        const modal = document.createElement('div');
        modal.id = 'log-settings-modal';
        modal.className = 'fixed inset-0 z-[var(--z-modal)] flex items-center justify-center bg-[var(--zephyr-bg-overlay)] backdrop-blur-md';
        // eslint-disable-next-line no-unsanitized/property -- i18n translation keys escaped via escapeHtml() // nosemgrep: js-innerhtml-assignment — verified safe, see eslint-disable above
        modal.innerHTML = `
            <div class="glass-card w-[420px] p-6 space-y-5" role="dialog" aria-modal="true" aria-labelledby="log-modal-title">
                <div class="flex items-center justify-between">
                    <h3 id="log-modal-title" class="dialog-title">${escapeHtml(t.logSettingsTitle || 'Log Settings')}</h3>
                    <button type="button" id="log-modal-close" class="text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors" aria-label="${escapeHtml(t.close || 'Close')}">
                        <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
                    </button>
                </div>

                <div class="space-y-3">
                    <label class="flex items-center justify-between gap-4 cursor-pointer">
                        <span class="text-sm text-[var(--text-primary)]">${escapeHtml(t.logAppEnabled || 'Save app logs')}</span>
                        <span class="ios-switch">
                            <input type="checkbox" id="log-app-toggle" ${logAppEnabled ? 'checked' : ''}>
                            <span class="switch-slider"></span>
                        </span>
                    </label>
                    <label class="flex items-center justify-between gap-4 cursor-pointer">
                        <span class="text-sm text-[var(--text-primary)]">${escapeHtml(t.logCoreEnabled || 'Save core logs')}</span>
                        <span class="ios-switch">
                            <input type="checkbox" id="log-core-toggle" ${logCoreEnabled ? 'checked' : ''}>
                            <span class="switch-slider"></span>
                        </span>
                    </label>
                </div>

                <div class="h-px bg-[var(--zephyr-bg-muted)]"></div>

                <div id="log-limits" class="grid grid-cols-2 gap-3">
                    <div class="flex flex-col gap-1.5">
                        <label for="log-retention-days" class="text-xs font-medium text-[var(--text-muted)]">${escapeHtml(t.logRetentionDays || 'Keep for')}</label>
                        <div class="input-unit">
                            <input id="log-retention-days" type="number" min="1" max="30" value="${retentionDays}" class="form-control form-control-md form-control-mono">
                            <span class="input-unit-label">${escapeHtml(t.logDaysUnit || 'days')}</span>
                        </div>
                    </div>
                    <div class="flex flex-col gap-1.5">
                        <label for="log-max-file-mb" class="text-xs font-medium text-[var(--text-muted)]">${escapeHtml(t.logMaxFileMb || 'Max file size')}</label>
                        <div class="input-unit">
                            <input id="log-max-file-mb" type="number" min="1" max="500" value="${maxFileMb}" class="form-control form-control-md form-control-mono">
                            <span class="input-unit-label">${escapeHtml(t.logMbUnit || 'MB')}</span>
                        </div>
                    </div>
                </div>

                <div class="flex justify-end pt-1">
                    <button type="button" id="log-modal-done" class="btn-primary">${escapeHtml(t.done || 'Done')}</button>
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
            logTrap.deactivate();
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

        // Esc closes; Tab stays inside the dialog.
        // closeModal() releases it, whichever control closes the dialog.
        const logTrap = createFocusTrap(modal, { onEscape: () => closeModal() });
        _modalTraps.set(modal, logTrap);
        logTrap.activate();
        document.getElementById('log-modal-close')?.addEventListener('click', closeModal);
        modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
        document.getElementById('log-modal-done')?.addEventListener('click', closeModal);

        const retentionInput = /** @type {HTMLInputElement} */ (modal.querySelector('#log-retention-days'));
        const maxFileInput = /** @type {HTMLInputElement} */ (modal.querySelector('#log-max-file-mb'));
        const limits = modal.querySelector('#log-limits');
        retentionInput?.addEventListener('input', () => saveSettings());
        maxFileInput?.addEventListener('input', () => saveSettings());

        // Toggle handlers. Retention and size apply to both files; they are dimmed when neither is saved.
        const appToggle = /** @type {HTMLInputElement} */ (modal.querySelector('#log-app-toggle'));
        const coreToggle = /** @type {HTMLInputElement} */ (modal.querySelector('#log-core-toggle'));
        const syncLimits = () => {
            const any = !!(appToggle?.checked || coreToggle?.checked);
            limits?.classList.toggle('opacity-50', !any);
            if (retentionInput) retentionInput.disabled = !any;
            if (maxFileInput) maxFileInput.disabled = !any;
        };
        syncLimits();

        appToggle?.addEventListener('change', () => {
            appStore.set('logAppEnabled', appToggle.checked);
            syncLimits();
            saveSettings();
        });
        coreToggle?.addEventListener('change', () => {
            appStore.set('logCoreEnabled', coreToggle.checked);
            syncLimits();
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
        dropOpenModal('log-export-modal');

        const t = getT();
        /** "INFO and above"; FATAL and TRACE read fine on their own. */
        const levelLabel = (/** @type {string} */ lv) => escapeHtml(
            lv === 'FATAL' ? lv : String(t.logLevelAndAbove || '@@level@@ and above').replace('@@level@@', lv));
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
        // eslint-disable-next-line no-unsanitized/property -- i18n translation keys escaped via escapeHtml() // nosemgrep: js-innerhtml-assignment — verified safe, see eslint-disable above
        modal.innerHTML = `
            <div class="glass-card w-[480px] p-6 space-y-4" role="dialog" aria-modal="true" aria-labelledby="log-export-title">
                <div class="flex items-center justify-between">
                    <h3 id="log-export-title" class="dialog-title">${escapeHtml(t.logExportTitle || 'Export Logs')}</h3>
                    <button type="button" id="log-export-modal-close" class="text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors" aria-label="${escapeHtml(t.close || 'Close')}">
                        <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
                    </button>
                </div>

                <div class="grid grid-cols-2 gap-2">
                    <div class="flex flex-col gap-1">
                        <label for="log-export-from" class="text-xs font-medium text-[var(--text-muted)]">${escapeHtml(t.logExportFrom || 'From')}</label>
                        <input id="log-export-from" type="date" value="${threeDaysAgo}" class="form-control form-control-md form-control-mono">
                    </div>
                    <div class="flex flex-col gap-1">
                        <label for="log-export-to" class="text-xs font-medium text-[var(--text-muted)]">${escapeHtml(t.logExportTo || 'To')}</label>
                        <input id="log-export-to" type="date" value="${today}" class="form-control form-control-md form-control-mono">
                    </div>
                </div>

                <div class="flex flex-col gap-1">
                    <span class="text-xs font-medium text-[var(--text-muted)]">${escapeHtml(t.logExportLevel || 'Minimum level')}</span>
                    <div id="log-level-wrap" class="relative w-full">
                        <button id="log-level-trigger" type="button" class="select-common w-full flex items-center justify-between">
                            <span id="log-level-label">${levelLabel('INFO')}</span>
                            <svg class="dropdown-arrow w-3.5 h-3.5 text-[var(--text-muted)] transition-transform duration-[var(--zephyr-time-micro)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="m6 9 6 6 6-6"></path>
                            </svg>
                        </button>
                        <div id="log-level-menu" class="hidden absolute inset-inline-0 top-[calc(100%+8px)] w-full rounded-lg border border-[var(--zephyr-border-default)] bg-[var(--zephyr-bg-elevated)] shadow-2xl z-30">
                            <div class="menu-scroll">
                                <button type="button" data-value="fatal" class="w-full text-start px-3 py-2 rounded-[var(--radius-dropdown-option)] text-xs text-[var(--text-secondary)] hover:bg-[var(--zephyr-bg-muted)] transition-colors">${levelLabel('FATAL')}</button>
                                <button type="button" data-value="error" class="w-full text-start px-3 py-2 rounded-[var(--radius-dropdown-option)] text-xs text-[var(--text-secondary)] hover:bg-[var(--zephyr-bg-muted)] transition-colors">${levelLabel('ERROR')}</button>
                                <button type="button" data-value="warn" class="w-full text-start px-3 py-2 rounded-[var(--radius-dropdown-option)] text-xs text-[var(--text-secondary)] hover:bg-[var(--zephyr-bg-muted)] transition-colors">${levelLabel('WARN')}</button>
                                <button type="button" data-value="info" class="w-full text-start px-3 py-2 rounded-[var(--radius-dropdown-option)] text-xs text-[var(--text-secondary)] hover:bg-[var(--zephyr-bg-muted)] transition-colors">${levelLabel('INFO')}</button>
                                <button type="button" data-value="debug" class="w-full text-start px-3 py-2 rounded-[var(--radius-dropdown-option)] text-xs text-[var(--text-secondary)] hover:bg-[var(--zephyr-bg-muted)] transition-colors">${levelLabel('DEBUG')}</button>
                                <button type="button" data-value="trace" class="w-full text-start px-3 py-2 rounded-[var(--radius-dropdown-option)] text-xs text-[var(--text-secondary)] hover:bg-[var(--zephyr-bg-muted)] transition-colors">${levelLabel('TRACE')}</button>
                            </div>
                        </div>
                        <select id="log-export-level" class="hidden">
                            <option value="fatal">${levelLabel('FATAL')}</option>
                            <option value="error">${levelLabel('ERROR')}</option>
                            <option value="warn">${levelLabel('WARN')}</option>
                            <option value="info" selected>${levelLabel('INFO')}</option>
                            <option value="debug">${levelLabel('DEBUG')}</option>
                            <option value="trace">${levelLabel('TRACE')}</option>
                        </select>
                    </div>
                </div>

                <div class="flex flex-col gap-1.5">
                    <span class="text-xs font-medium text-[var(--text-muted)]">${escapeHtml(t.logExportContent || 'Include')}</span>
                    <div class="seg-tabs seg-tabs-lg w-full" role="radiogroup" aria-label="${escapeHtml(t.logExportContent || 'Include')}">
                        <button type="button" role="radio" aria-checked="false" data-log-type="app" class="seg-tab flex-1 justify-center">${escapeHtml(t.logAppTab || 'App logs')}</button>
                        <button type="button" role="radio" aria-checked="false" data-log-type="core" class="seg-tab flex-1 justify-center">${escapeHtml(t.logCoreTab || 'Core logs')}</button>
                        <button type="button" role="radio" aria-checked="true" data-log-type="all" class="seg-tab active flex-1 justify-center">${escapeHtml(t.logExportBoth || 'Both')}</button>
                    </div>
                </div>
                <div class="flex items-center justify-between pt-2">
                    <button type="button" id="log-open-folder" class="row-action ms-[-10px]">${escapeHtml(t.logOpenFolder || 'Open Log Folder')}</button>
                    <button type="button" id="log-export-go" class="btn-primary">${escapeHtml(t.logExport || 'Export')}</button>
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
            exportTrap.deactivate();
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

        // closeModal() releases it, whichever control closes the dialog.
        // An open level menu is portalled to <body>: Escape closes it first, not the dialog.
        const exportTrap = createFocusTrap(modal, {
            onEscape: () => closeModal(),
            passEscape: () => {
                const menu = document.getElementById('log-level-menu');
                return !!menu && !menu.classList.contains('hidden');
            },
        });
        _modalTraps.set(modal, exportTrap);
        exportTrap.activate();
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
            void (async () => {
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

        /** @type {string} */
        let logType = 'all';
        const typeButtons = /** @type {HTMLElement[]} */ (Array.from(modal.querySelectorAll('[data-log-type]')));
        typeButtons.forEach((b) => b.addEventListener('click', () => {
            logType = b.dataset.logType || 'all';
            typeButtons.forEach((x) => {
                const on = x === b;
                x.classList.toggle('active', on);
                x.setAttribute('aria-checked', String(on));
            });
        }));
        modal.querySelector('#log-export-go')?.addEventListener('click', () => doExport(logType));

        modal.querySelector('#log-open-folder')?.addEventListener('click', async () => {
            try {
                await invoke('open_log_folder');
            } catch (err) {
                settingsLogger.error('[log-settings] Failed to open folder:', err);
            }
        });
    });
}

// ---------------------------------------------------------------------------
// Third-party licenses viewer (About section). The texts are embedded in the
// backend (get_third_party_licenses) from the same file that ships as a
// package resource, so what the user reads here is byte-identical to the
// THIRD-PARTY-LICENSES.txt installed with the app.
// ---------------------------------------------------------------------------
function initLicensesModal() {
    const viewBtn = document.getElementById('view-licenses-btn');
    if (!viewBtn) return;

    viewBtn.addEventListener('click', async () => {
        dropOpenModal('licenses-modal');

        const t = /** @type {any} */ (translations)[appStore.get('currentLang')] ?? {};

        const modal = document.createElement('div');
        modal.id = 'licenses-modal';
        modal.className = 'fixed inset-0 z-[var(--z-modal)] flex items-center justify-center bg-[var(--zephyr-bg-overlay)] backdrop-blur-md p-4';
        // eslint-disable-next-line no-unsanitized/property -- title/close labels escaped via escapeHtml(); the license body is set via textContent, never innerHTML // nosemgrep: js-innerhtml-assignment — verified safe, see eslint-disable above
        modal.innerHTML = `
            <div class="glass-card flex max-h-full w-[min(760px,92vw)] flex-col gap-4 p-6" role="dialog" aria-modal="true" aria-labelledby="licenses-modal-title">
                <div class="flex shrink-0 items-center justify-between">
                    <h3 id="licenses-modal-title" class="dialog-title">${escapeHtml(t.thirdPartyLicenses || 'Third-party Licenses')}</h3>
                    <button type="button" id="licenses-modal-close" class="text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors" aria-label="${escapeHtml(t.close || 'Close')}">
                        <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
                    </button>
                </div>
                <pre id="licenses-modal-body" tabindex="0" aria-labelledby="licenses-modal-title" class="select-text max-h-[65vh] min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-[var(--text-secondary)]"></pre>
                <div class="flex shrink-0 justify-end pt-1">
                    <button type="button" id="licenses-modal-done" class="btn-primary">${escapeHtml(t.done || 'Done')}</button>
                </div>
            </div>
        `;

        document.body.appendChild(modal);
        document.body.style.overflow = 'hidden';

        // Animate in (same pattern as the log settings dialog)
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
            trap.deactivate();
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

        const trap = createFocusTrap(modal, { onEscape: () => closeModal() });
        _modalTraps.set(modal, trap);
        trap.activate();
        document.getElementById('licenses-modal-close')?.addEventListener('click', closeModal);
        // Only a press that starts on the backdrop counts as a backdrop
        // click: dragging a text selection out of the panel and releasing
        // over the backdrop must not dismiss the viewer.
        let pressStartedOnBackdrop = false;
        modal.addEventListener('pointerdown', (e) => { pressStartedOnBackdrop = e.target === modal; });
        modal.addEventListener('click', (e) => { if (e.target === modal && pressStartedOnBackdrop) closeModal(); });
        document.getElementById('licenses-modal-done')?.addEventListener('click', closeModal);

        const body = modal.querySelector('#licenses-modal-body');
        try {
            const text = await invoke(COMMANDS.GET_THIRD_PARTY_LICENSES);
            if (body) body.textContent = typeof text === 'string' ? text : String(text ?? '');
        } catch (err) {
            settingsLogger.error('[licenses] Failed to load license texts:', err);
            if (body) body.textContent = t.thirdPartyLicensesLoadFailed || 'Failed to load the license texts.';
        }
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
    void syncUserAgentToBackend();

    // Owns the lookup: single in-flight request, exponential backoff on
    // failure/empty replies, and a bounded number of automatic retries.
    // Previously the `finally` re-entered updateVisibility() -> fetch, which
    // spun in a tight loop whenever the backend failed fast.
    const versionFetcher = createClientVersionFetcher({
        fetch: () => {
            spinner?.classList.remove('hidden');
            return invoke(COMMANDS.GET_LATEST_CLIENT_VERSIONS);
        },
        isValid: isValidClientVersions,
        onSuccess: applyLatestVersions,
        onFailure: (err) => {
            settingsLogger.error('Failed to fetch latest client versions', err);
        },
        onSettled: () => {
            spinner?.classList.add('hidden');
            updateVisibility();
        },
    });
    registerCleanup(() => versionFetcher.dispose());

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
            void syncUserAgentToBackend();
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
            versionFetcher.request();
        } else {
            /** @type {HTMLElement} */ (optionsContainer).classList.remove('max-h-40', 'opacity-100');
            /** @type {HTMLElement} */ (optionsContainer).classList.add('max-h-0', 'opacity-0', 'overflow-hidden');
            setTimeout(() => { if (customContainer) customContainer.classList.add('hidden'); }, 300);
        }
    }

    /**
     * Apply fetched client versions to the select, the custom dropdown menu
     * and the persisted selection.
     * @param {import('./settings/client-version-fetch.js').ClientVersions} versions
     */
    function applyLatestVersions(versions) {
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
    }

    toggle.addEventListener('change', () => {
        localStorage.setItem('fakeClientEnabled', toggle.checked.toString());
        // Re-enabling is an explicit user action: allow a fresh retry budget.
        if (toggle.checked) versionFetcher.retryNow();
        else versionFetcher.pause();
        updateVisibility();
        void syncUserAgentToBackend();
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

document.getElementById('fake-client-custom-paste-btn')?.addEventListener('click', (e) => {
    e.preventDefault();
    void pasteWithFeedback(customInput, showNotification, translations, appStore.get('currentLang') || 'en');
});

    if (savedEnabled) {
        optionsContainer.style.transition = 'none';
        updateVisibility();
        setTimeout(() => optionsContainer.style.transition = '', 50);
    }
}

/** @type {boolean} In-flight guard for home-mode switch. */
let _homeModeSwitchInFlight = false;
/**
 * The newest click made while a switch was saving: it runs once that one is saved.
 * @type {{ mode: 'minimal' | 'console', setUI: ((mode: string) => void)|undefined }|null}
 */
let _queuedHomeMode = null;
/**
 * Counts saved home-mode writes (a click's patch, a reset's snapshot), each
 * taken in the settings write queue: "Restore Defaults" shows the minimal
 * mode only when its own snapshot is still the last one saved.
 */
let _homeModeWrites = 0;
/** @type {string|null} The home mode the last of those writes saved. */
let _lastSavedHomeMode = null;

/**
 * Whether "Restore Defaults" should show the minimal mode it saved: only when
 * its snapshot is still the last write and no click is waiting to save.
 * @param {number} resetWrite the write count right after the reset's snapshot
 */
export function resetKeepsHomeMode(resetWrite) {
    return _homeModeWrites === resetWrite && !_homeModeSwitchInFlight;
}

/** For tests: the current home-mode write count. */
export function homeModeWritesForTests() {
    return _homeModeWrites;
}

/**
 * A click while a home-mode save runs: queued so the last click wins once
 * that save lands; clicking back to the mode being saved cancels the queue.
 * @param {'minimal' | 'console'} mode
 * @param {string} previous the mode being saved
 * @param {((mode: string) => void)|undefined} setHomeModeUI
 */
function queueHomeModeClick(mode, previous, setHomeModeUI) {
    const pending = _queuedHomeMode ? _queuedHomeMode.mode : previous;
    if (mode === pending) return;
    _queuedHomeMode = mode === previous ? null : { mode, setUI: setHomeModeUI };
    if (setHomeModeUI) setHomeModeUI(mode);
}

/**
 * A failed home-mode save: show what is on disk (the last saved mode, as a
 * reset saved before or while this click waited leaves its own, else the
 * mode loaded) and drop any click queued behind it.
 * @param {unknown} err
 * @param {string} previous
 * @param {((mode: string) => void)|undefined} setHomeModeUI
 */
function homeModeSaveFailed(err, previous, setHomeModeUI) {
    settingsLogger.error('Failed to save home_page_mode', err);
    const shown = _lastSavedHomeMode || previous;
    if (setHomeModeUI) setHomeModeUI(shown);
    appStore.set('homePageMode', shown);
    if (shown !== previous) Bus.emit(Events.HOME_PAGE_MODE_CHANGED, { mode: shown, previous });
    showNotification(toError(err).message, 'error');
    _queuedHomeMode = null;
}

/**
 * Switches the home page mode and executes persistence, cache invalidation, events, and width hint.
 * @param {'minimal' | 'console'} mode
 * @param {((mode: string) => void)|undefined} [setHomeModeUI]
 */
export async function switchHomePageMode(mode, setHomeModeUI) {
    const previous = appStore.get('homePageMode') || 'minimal';
    if (_homeModeSwitchInFlight) {
        queueHomeModeClick(mode, previous, setHomeModeUI);
        return;
    }
    if (mode === previous) return;
    _homeModeSwitchInFlight = true;
    if (setHomeModeUI) setHomeModeUI(mode);
    appStore.set('homePageMode', mode);
    try {
        // In the settings write queue, so a "Restore Defaults" snapshot saved
        // around it lands in a known order and reset can tell which came last.
        await queueSmartConfigWrite(async () => {
            await invoke(COMMANDS.PATCH_SETTINGS, { patch: { home_page_mode: mode } });
            _homeModeWrites += 1;
            _lastSavedHomeMode = mode;
        });
    } catch (err) {
        homeModeSaveFailed(err, previous, setHomeModeUI);
        throw err;
    } finally {
        _homeModeSwitchInFlight = false;
    }
    const queued = _queuedHomeMode;
    _queuedHomeMode = null;
    // Post-persistence side effects — failures here must not roll back the
    // already-successful persistence or show a misleading "Failed to save" toast.
    invalidateSettingsCache();
    Bus.emit(Events.HOME_PAGE_MODE_CHANGED, { mode, previous });
    if (mode === 'console') {
        checkConsoleWidthNotification();
    }
    if (queued) {
        // Starts (and marks itself in flight) before this returns.
        switchHomePageMode(queued.mode, queued.setUI).catch(() => { /* reported by that call */ });
    }
}

// ---------------------------------------------------------------------------
//  initSettings -- main entry point
// ---------------------------------------------------------------------------
/** Dependencies for the auto-switch, node scoring and scheduled test switches. */
function autoSwitchDeps() {
    return {
        getSmartConfig: () => prism.smartConfig(),
        saveSmartConfig: (/** @type {any} */ cfg) => prism.smartConfigSave(cfg),
        // Must reject on failure so the switch can report it and go back.
        saveSetting: saveSettingChecked,
        setStore: (/** @type {string} */ k, /** @type {any} */ v) => appStore.set(k, v),
        getStore: (/** @type {string} */ k) => appStore.get(k),
        startAutoTest: startSmartAutoTest,
        stopAutoTest: stopSmartAutoTest,
        onChanged: () => Bus.emit(Events.CONFIG_UPDATED),
        getFailoverPolicy: () => prism.failoverGetPolicy(),
        setFailoverPolicy: (/** @type {any} */ policy) => prism.failoverSetPolicy(policy),
        onRollbackFailed: (/** @type {unknown} */ err) => settingsLogger.error('[failover] Failed to undo the setting:', err),
    };
}

export async function initSettings() {
    initSettingsNav();
    // Portable mode: hide unsupported options
    const isPortable = await invoke(COMMANDS.GET_PORTABLE_MODE);
    if (isPortable) {
        const autostartRow = document.getElementById('row-autostart');
        const clientUpdateRow = document.getElementById('row-client-update');
        if (autostartRow) autostartRow.style.display = 'none';
        if (clientUpdateRow) clientUpdateRow.style.display = 'none';
        // A search typed while the check was pending counted these rows: filter again.
        const search = document.getElementById('settings-search');
        if (search instanceof HTMLInputElement && search.value) search.dispatchEvent(new Event('input'));
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
    // The swatches are native <button>s, so Enter / Space already click them.
    const checkUpdateBtn = /** @type {HTMLButtonElement|null} */ (document.getElementById('check-update-btn'));
    const hideTimeoutToggle = /** @type {HTMLInputElement} */ (document.getElementById('setting-hide-timeout'));
    const failoverToggle = /** @type {HTMLInputElement|null} */ (document.getElementById('setting-failover'));
    const smartToggle = /** @type {HTMLInputElement|null} */ (document.getElementById('smart-toggle'));
    const autoTestToggle = /** @type {HTMLInputElement|null} */ (document.getElementById('smart-auto-test-toggle'));
    const encryptConfigsToggle = /** @type {HTMLInputElement} */ (document.getElementById('setting-encrypt-configs'));
    const portConfigBtn = /** @type {HTMLButtonElement|null} */ (document.getElementById('port-config-btn'));
    const portDisplay = /** @type {HTMLElement|null} */ (document.getElementById('current-port-display'));
    const versionText = document.getElementById('core-version-text');
    const configsList = document.getElementById('configs-list');
    const customArgsInput = /** @type {HTMLTextAreaElement} */ (document.getElementById('custom-args-input'));
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
    /** @type {HTMLElement[]} */
    const themeModeButtons = Array.from(document.querySelectorAll('[data-theme-mode]'));
    const appTitleIcon = /** @type {HTMLImageElement} */ (document.getElementById('app-title-icon'));

    // ---- Forward declarations (used before their full definition below) ----
    /** @type {any[]} */
    let currentTunnels = [];
    /**
     * Bumped by every change of that switch (the switch itself, Restore Defaults): a
     * pending rollback or policy re-read started before it must not undo it.
     */
    const switchSeq = { failover: 0, smart: 0, autoTest: 0 };
    /** Whether the scoring switch's first value came from the engine (not a localStorage guess). */
    let smartKnown = false;
    /** Scoring changes clicked but not yet saved: an engine re-read must not undo them on screen. */
    let smartPending = 0;
    /** Scoring values received from the engine via SMART_ENABLED_SYNCED. */
    let smartSyncs = 0;
    /** Scheduled-test changes waiting in the write queue. */
    let autoTestPending = 0;
    /** Scheduled tests need scoring: the switch is unavailable (and off) while scoring is off. */
    const syncAutoTestAvailability = () => {
        if (!autoTestToggle) return;
        const smartOn = smartToggle?.checked ?? false;
        autoTestToggle.disabled = !smartOn;
        document.getElementById('row-smart-auto-test')?.classList.toggle('opacity-50', !smartOn);
        if (!smartOn) autoTestToggle.checked = false;
    };

    // ---- Subscription & Config management (delegated to settings/subscriptions.js) ----
    // Initialized early so renderConfigs is available for language dropdown and drag-drop listeners.
    const subApi = initSubscriptionSettings({
        subAddBtn: document.getElementById('add-sub-btn'),
        updateAllSubBtn: document.getElementById('update-all-sub-btn'),
        configsList,
    });
    const renderConfigs = subApi.renderConfigs;
    /** Store destroy for cleanup during settings reset/teardown. */
    const _destroySubscriptionSettings = subApi.destroy;
    if (typeof _destroySubscriptionSettings === 'function') {
        registerCleanup(_destroySubscriptionSettings);
    }

    // ---- Advanced settings navigation ----
    if (gotoAdvancedBtn) {
        gotoAdvancedBtn.onclick = () => {
            navigateTo('advanced');
        };
    }

    const gotoGithubBtn = document.getElementById('btn-goto-github');
    if (gotoGithubBtn) {
        gotoGithubBtn.onclick = (e) => {
            e.preventDefault();
            openUrl('https://github.com/Juwan-Hwang/Zephyr').catch(err => settingsLogger.warn('Failed to open GitHub page', err));
        };
    }

    if (backSettingsBtn) {
        backSettingsBtn.onclick = () => {
            navigateTo('settings');
        };
    }

    // ---- Custom args ----
document.getElementById('custom-args-paste-btn')?.addEventListener('click', (e) => {
    e.preventDefault();
    if (customArgsInput) {
        void pasteWithFeedback(customArgsInput, showNotification, translations, appStore.get('currentLang') || 'en');
    }
});

    if (applyArgsBtn) {
        applyArgsBtn.onclick = async () => {
            const argsStr = customArgsInput.value.trim();
            /** @type {any} */
            const settings = await invoke(COMMANDS.GET_SETTINGS);
            const configPath = settings.last_config || 'config.yaml';
            const customArgs = argsStr.split('\n').map(a => a.trim()).filter(Boolean);

            /** @type {any} */
            const t = /** @type {any} */ (translations)[appStore.get('currentLang')];
            showNotification(t.notifSavingAndRestarting || "Saving and restarting core...");
            try {
                await save();
                abortLatencyTests();
                const recovery = await withPageBusy(async () => {
                    const coreResult = await restartCore(configPath, customArgs);
                    return postRestartRecovery(restartedProfile(coreResult, configPath));
                });
                if (recovery?.failed) {
                    showNotification(t.restartRecoveryWarn || 'The core restarted, but some proxy choices, patches or overrides couldn’t be restored.', 'warning');
                } else {
                    showNotification(t.notifRestartSuccess || "Core restarted", 'success');
                }
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
                void renderConfigs();
            },
        });

        __langDropdown = langDropdown;
    }

    // ---- UI Scale buttons ----
    const UI_SCALES = [1, 1.1, 1.25, 1.5];
    const uiScaleContainer = document.getElementById('setting-ui-scale-container');
    const uiScaleButtons = document.querySelectorAll('.ui-scale-btn');
    const applyUiScale = (/** @type {number} */ scale) => {
        // Same sliding thumb as the theme / home-mode controls (ui/seg-control.js)
        selectSegment(uiScaleContainer, UI_SCALES.findIndex((s) => Math.abs(s - scale) < 0.001));
        // Apply scale via CSS custom property --ui-scale
        // The actual transform/size is handled by CSS on #app-main-container.
        // This avoids inline style conflicts with Tailwind classes and ensures
        // the scale is applied consistently on startup.
        document.documentElement.style.setProperty('--ui-scale', String(scale));
    };

    // Saves run one after another in click order and each one that succeeds is
    // applied in that order, so the UI always ends on the value that was saved
    // last (a failed newer click leaves the last saved scale showing).
    const uiScaleQueue = createSerialQueue();
    // A click saved before the settings below load wins over their older value.
    let uiScaleSaved = false;
    uiScaleButtons.forEach(btn => {
        btn.addEventListener('click', async () => {
            const scaleValue = parseInt(btn.id.replace('ui-scale-', '')) / 100;
            try {
                // The settings write queue first (as save() and the reset
                // take them): the DNS and subscription-order saves write a
                // whole settings snapshot there, and one read before this
                // click would otherwise save the old scale back.
                await queueSmartConfigWrite(() => uiScaleQueue.run(async () => {
                    await invoke(COMMANDS.SET_UI_SCALE, { scale: scaleValue });
                    uiScaleSaved = true;
                    applyUiScale(scaleValue);
                }));
            } catch (_e) {
                // silently ignore — non-critical
            }
        });
    });

    // An update that ended unseen in a page that has since been replaced.
    void showPendingUpdateNote();

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
    if (hideTimeoutToggle) hideTimeoutToggle.checked = settings.hide_timeout_nodes || false;
    if (encryptConfigsToggle) encryptConfigsToggle.checked = settings.encrypt_configs || false;
    appStore.set('failoverEnabled', settings.failover_enabled || false);
    appStore.set('networkOptimAutoApply', settings.network_optim_auto_apply ?? false);
    appStore.set('encryptConfigs', settings.encrypt_configs || false);
    appStore.set('logAppEnabled', settings.log_app_enabled || false);
    appStore.set('logCoreEnabled', settings.log_core_enabled || false);
    appStore.set('logRetentionDays', settings.log_retention_days ?? 3);
    appStore.set('logMaxFileMb', settings.log_max_file_mb ?? 50);
    if (customArgsInput) customArgsInput.value = (settings.custom_args || []).join('\n');

    // Apply saved UI scale (unset means the default 100%)
    if (!uiScaleSaved) applyUiScale(settings.ui_scale > 0 ? settings.ui_scale : 1);

    // ---- Home page mode ----
    const homeModeContainer = document.getElementById('setting-home-mode-container');
    const homeModeButtons = document.querySelectorAll('[data-home-mode]');
    const HOME_MODES = ['minimal', 'console'];
    /** @param {string} mode */
    const setHomeModeUI = (mode) => selectSegment(homeModeContainer, HOME_MODES.indexOf(mode));
    const savedHomePageMode = settings.home_page_mode === 'console' ? 'console' : 'minimal';
    setHomeModeUI(savedHomePageMode);
    appStore.set('homePageMode', savedHomePageMode);
    _lastSavedHomeMode = savedHomePageMode;
    homeModeButtons.forEach((btn) => {
        btn.addEventListener('click', async () => {
            const mode = /** @type {HTMLElement} */ (btn).dataset.homeMode;
            if (!mode) return;
            try {
                await switchHomePageMode(/** @type {'minimal'|'console'} */ (mode), setHomeModeUI);
            } catch {
                // error handled inside switchHomePageMode
            }
        });
    });

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
        themeModeButtons,
        save: () => save(),
    });

    // ---- Restore defaults ----
    if (restoreDefaultsBtn) {
        restoreDefaultsBtn.onclick = async () => {
            /** @type {any} */
            const t = /** @type {any} */ (translations)[appStore.get('currentLang')];
            const confirmed = await showConfirmModal(
                t.restoreDefaultsConfirmTitle || "Restore default settings?",
                t.restoreDefaultsConfirmLead || "This only resets the preferences on this page; you can change them again anytime.",
                {
                    danger: true,
                    confirmText: t.restoreDefaultsBtn || 'Restore defaults',
                    points: [
                        { tone: 'danger', label: t.restoreDefaultsResetsLabel || 'Resets: ', text: t.restoreDefaultsResetsList || '' },
                        { tone: 'success', label: t.restoreDefaultsKeepsLabel || 'Keeps: ', text: t.restoreDefaultsKeepsList || '' },
                    ],
                }
            );
            if (!confirmed) return;

            // The reset saves the whole settings object: start from what is stored now,
            // not the copy read when the page loaded, so a setting changed since then
            // (and not reset here) is not reverted by the save.
            try {
                const fresh = await invoke(COMMANDS.GET_SETTINGS);
                if (fresh && typeof fresh === 'object') {
                    for (const k of Object.keys(settings)) delete settings[k];
                    Object.assign(settings, fresh);
                }
            } catch (err) {
                settingsLogger.warn('Failed to re-read settings before reset', err);
            }
            // The snapshot as read: the save below writes only what the reset
            // changed in it onto the settings stored by then.
            /** @type {Record<string, unknown>} */
            const resetBase = JSON.parse(JSON.stringify(settings));
            // Every key the reset sets: its value wins over one saved while the
            // reset ran, even when the snapshot already held that value.
            /** @type {Set<string>} */
            const resetKeys = new Set();
            /** @param {string} key @param {unknown} value */
            const resetTo = (key, value) => {
                settings[key] = value;
                resetKeys.add(key);
            };

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
                    resetTo('close_to_tray', true);
                }
                if (autoUpdateToggle) {
                    autoUpdateToggle.checked = false;
                    resetTo('auto_update', false);
                }
                if (autoUpdateClientToggle) {
                    autoUpdateClientToggle.checked = false;
                    resetTo('auto_update_client', false);
                }
                if (hideTimeoutToggle) {
                    const wasHideTimeoutEnabled = hideTimeoutToggle.checked;
                    hideTimeoutToggle.checked = false;
                    resetTo('hide_timeout_nodes', false);
                    if (wasHideTimeoutEnabled) {
                        hideTimeoutToggle.dispatchEvent(new Event('change'));
                    }
                }
                if (failoverToggle) {
                    failoverToggle.checked = false;
                    settings.failover_enabled = false;
                    const seq = ++switchSeq.failover;
                    if (!await trackResult('failover', () => applyFailover(false, autoSwitchDeps()))) {
                        // Not saved: applyFailover put the store back. Show and keep that
                        // (the settings save below writes this snapshot).
                        const stored = !!appStore.get('failoverEnabled');
                        settings.failover_enabled = stored;
                        // Shown as the normal path does: off while the Prism page has the policy off.
                        /** @type {any} */
                        let policy = null;
                        if (stored) {
                            try { policy = await prism.failoverGetPolicy(); } catch { /* unknown: follow the setting */ }
                        }
                        if (seq === switchSeq.failover) failoverToggle.checked = shownFailover(stored, policy);
                    }
                }
                if (smartToggle) {
                    // Scoring off also stops scheduled tests.
                    smartToggle.checked = false;
                    const seq = ++switchSeq.smart;
                    switchSeq.autoTest++;
                    syncAutoTestAvailability();
                    // A config re-read queued ahead of this must not show scoring on again.
                    smartPending++;
                    let saved;
                    try {
                        saved = await trackResult('smartScoring', () => applySmart(false, autoSwitchDeps()));
                    } finally {
                        smartPending--;
                    }
                    if (!saved) {
                        // Not saved: applySmart put scoring (and the scheduled tests it
                        // stopped) back. Show what is in effect now.
                        // If the engine can't be read now, what applySmart put back on
                        // screen is the best answer (localStorage may hold an old guess).
                        const restored = await queueSmartConfigWrite(async () => {
                            const read = await readSmartState({ getSmartConfig: () => prism.smartConfig() });
                            return read.known ? read.enabled : document.documentElement.style.getPropertyValue('--smart-enabled') === '1';
                        });
                        if (seq === switchSeq.smart) {
                            smartToggle.checked = restored;
                            syncAutoTestAvailability();
                            if (autoTestToggle && restored) autoTestToggle.checked = readAutoTestEnabled();
                        }
                    }
                }
                if (silentStartToggle) {
                    silentStartToggle.checked = false;
                    resetTo('silent_start', false);
                }
                if (customArgsInput) {
                    customArgsInput.value = '';
                    resetTo('custom_args', []);
                }

                if (autostartToggle) {
                    autostartToggle.checked = false;
                    resetTo('autostart', false);
                    // Portable builds have no autostart plugin (the control is
                    // hidden): nothing is registered, so there is nothing to undo.
                    if (!isPortable && !await trackResult('autostart', async () => {
                        await disableAutoStart();
                    })) {
                        // Still registered with the OS: show and save what is in
                        // effect, as the switch itself does when this fails.
                        let still = !!resetBase.autostart;
                        try { still = await readAutoStartEnabled(); } catch { /* unreadable: keep the setting */ }
                        autostartToggle.checked = still;
                        settings.autostart = still;
                    }
                }

                if (unifiedDelayToggle) unifiedDelayToggle.checked = true;
                if (ipv6Toggle) ipv6Toggle.checked = false;
                if (allowLanToggle) allowLanToggle.checked = false;

                const dnsToggle = /** @type {HTMLInputElement} */ (document.getElementById('dns-rewrite-toggle'));
                if (dnsToggle) {
                    dnsToggle.checked = true;
                    resetTo('dns_rewrite_enabled', true);
                    // The default servers: the saved custom ones are reset below
                    // and only saved at the end, after this has been applied.
                    if (!await trackResult('dnsRewrite', async () => {
                        await applyDnsRewrite(DEFAULT_DNS_CONFIG);
                    })) {
                        // Refused by the core: show and save what is in effect,
                        // as the switch itself does when this fails.
                        const shown = await dnsShownAfterFailure(true, resetBase.dns_rewrite_enabled !== false);
                        dnsToggle.checked = shown;
                        settings.dns_rewrite_enabled = shown;
                    }
                }

                if (opacitySlider) {
                    opacitySlider.value = '100';
                    resetTo('app_opacity', 100);
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
                resetTo('theme_mode', 'auto');
                void _themeApi.setThemeMode('auto', false);
                successItems.push('themeMode');

                // Reset the proxy mode preference explicitly. A full-snapshot save
                // can no longer clear it: the backend keeps the authoritative mode
                // (`switch_mode` owns live changes) so a stale snapshot carrying
                // `mode: null` cannot revert a concurrent user choice. Clearing it
                // is therefore an explicit partial update, and the live core is
                // brought to the default through `switch_mode` below.

                await trackResult('mode', async () => {
                    // Live core and the stored preference, in one call, always.
                    // `switch_mode` with `clearPreference` sets the core to the
                    // default and clears the stored mode under the same
                    // `GLOBAL_MODE_LOCK` hold, so a mode the user picks
                    // concurrently cannot be erased by a separate settings patch.
                    // Switching to the mode the core is already on is a harmless
                    // no-op, so there is no need to read the live mode first.
                    // The backend picks the mode the next start runs without a
                    // preference (the profile's `mode:`, else `rule`) and
                    // returns it, so the live core and the next launch agree.
                    /** @type {string} */
                    const defaultMode = await invoke(COMMANDS.SWITCH_MODE, { clearPreference: true });
                    invalidateSettingsCache();
                    updateModeUI(defaultMode);
                    // As a normal mode switch does: connections opened under the
                    // old mode keep its routing until they close. The mode is
                    // already committed, so a failed close only warns.
                    closeAllConnections().catch((e) =>
                        settingsLogger.warn('Failed to close connections after mode reset', e)
                    );
                    // The buttons alone are not the mode: the store (console
                    // selector, tray menu) follows MODE_CHANGED.
                    Bus.emit(Events.MODE_CHANGED, defaultMode);
                });

                // Reset global preference overrides (injected into runtime YAML)
                resetTo('mixed_port', null);
                resetTo('socks_port', null);
                resetTo('http_port', null);
                resetTo('ipv6', null);
                resetTo('allow_lan', null);
                resetTo('unified_delay', null);
                resetTo('dns_nameservers', null);
                resetTo('dns_fallbacks', null);

                localStorage.removeItem('appTheme');
                appStore.set('currentTheme', DEFAULT_THEME);
                resetTo('theme', DEFAULT_THEME);
                applyTheme(DEFAULT_THEME);
                document.querySelectorAll('.theme-btn').forEach(b => b.classList.remove('ring-2', 'ring-offset-2', 'ring-offset-[var(--zephyr-bg-secondary)]'));
                const defaultThemeBtn = document.querySelector('.theme-btn[data-theme="blue"]');
                if (defaultThemeBtn) {
                    defaultThemeBtn.classList.add('ring-2', 'ring-offset-2', 'ring-offset-[var(--zephyr-bg-secondary)]', 'ring-zinc-500');
                }
                successItems.push('themeColor');

                // In the switches' queue, then the scale buttons' queue (the
                // same order save() takes them): a pending auto-switch change
                // settles first (its store value may be a click that is about
                // to roll back), and a scale click saved meanwhile can't land
                // between this save and the scale it applies.
                // Saved even when the log-size patch after it fails: the home
                // mode below follows the saved settings.
                let appSettingsSaved = false;
                // The TUN item's restart ran, but some recovery step failed.
                let recoveryFailed = false;
                let resetHomeWrite = -1;
                await trackResult('appSettings', () => queueSmartConfigWrite(() => uiScaleQueue.run(async () => {
                    resetTo('home_page_mode', 'minimal');
                    // Items the reset used to skip (the confirm says "all settings"):
                    resetTo('ui_scale', 1);
                    resetTo('lightweight_mode', false);
                    delete settings.copy_env_format;   // missing → backend default for this platform
                    resetKeys.add('copy_env_format');
                    resetTo('log_retention_days', 3);
                    resetTo('log_max_file_mb', 50);
                    // Owned by the auto-switch switch: if it was turned on while the
                    // reset ran, this snapshot must not save it back off.
                    if (failoverToggle) resetTo('failover_enabled', !!appStore.get('failoverEnabled'));
                    // Onto what is stored now: a save that landed while the
                    // reset ran (a proxy choice, a subscription update) stays.
                    const forced = [...resetKeys];
                    /** @type {any} */
                    // Unread, the snapshot alone would put back everything
                    // saved while the reset ran: the item fails instead.
                    const now = await invoke(COMMANDS.GET_SETTINGS);
                    if (!now || typeof now !== 'object') throw new Error('Settings could not be read before saving the reset');
                    const stored = withResetChanges(now, resetBase, settings, forced);
                    await invoke(COMMANDS.SAVE_SETTINGS, { settings: stored });
                    appSettingsSaved = true;
                    // The DNS rewrite choice is in the saved settings now.
                    forgetUnsavedDnsChoice();
                    _homeModeWrites += 1;
                    _lastSavedHomeMode = 'minimal';
                    resetHomeWrite = _homeModeWrites;
                    // Saved: show the saved scale even if the patch below fails.
                    applyUiScale(1);
                    if (lightweightModeToggle) lightweightModeToggle.checked = false;
                    appStore.set('logRetentionDays', 3);
                    appStore.set('logMaxFileMb', 50);
                    // The running log writers take a new size limit only through a patch.
                    await invoke(COMMANDS.PATCH_SETTINGS, { patch: { log_max_file_mb: 50 } });
                })));
                invalidateSettingsCache();
                // Runs after the snapshot above is saved: a TUN-off restart
                // rebuilds run_config.yaml from settings.json, so it must see
                // the reset ports/IPv6/LAN preferences, not the old ones.
                // `save_settings` keeps the backend's `tun_enabled`, so saving
                // first does not affect this item.
                //
                // Same for TUN: the backend keeps the authoritative value (the TUN
                // commands apply changes to the running core first), so a stale
                // snapshot cannot revert a concurrent toggle. Resetting it is an
                // explicit partial update.
                await trackResult('tun_enabled', async () => {
                    // Live core first, then the stored preference — the same
                    // order the mode reset above uses, and for the same reason:
                    // clearing only the preference would leave the core routing
                    // through TUN while `settings.json` says the default, and
                    // macOS startup reads that flag to pick the TUN path.
                    //
                    // TUN is the case where I would rather not touch the live
                    // core: disabling it means a root restart, which on macOS
                    // raises the administrator dialog as a side effect of
                    // "Restore Defaults". Doing nothing is worse — it reports a
                    // reset that did not happen — so the core is disabled when it
                    // is actually on, and a failure is reported rather than
                    // swallowed.
                    // Read from the live core: `appStore` is a cache that
                    // `syncCoreConfig()` refreshes only when the core reports a
                    // `tun` block, so it can be stale.
                    //
                    // No fallback to the cache when the read fails: a stale
                    // `false` would clear the preference while the core keeps
                    // TUN on. A failed read only counts as "TUN off" when the
                    // backend confirms no core is running (uptime `null`);
                    // then there is no live TUN to disable and the stored
                    // preference must still be cleared, or the next start
                    // turns TUN back on. Any other failure fails this item.
                    // Serialize with the TUN toggle and Geo update for the
                    // whole item, the live read included: both restart the
                    // core under this lock, and a toggle that lands between
                    // the read and the preference clear below would have its
                    // freshly saved preference wiped while the core runs TUN.
                    if (appStore.get('isNetworkUpdating')) {
                        throw new Error('A TUN or network change is already in progress');
                    }
                    appStore.set('isNetworkUpdating', true);
                    try {
                        /** @type {any} */
                        let liveConfig = null;
                        try {
                            liveConfig = await getConfig();
                        } catch (err) {
                            // A failed uptime lookup must not mask the config error.
                            const uptime = await invoke(COMMANDS.GET_CORE_UPTIME).catch(() => undefined);
                            if (uptime !== null) throw err;
                        }
                        const tunOn = Boolean(liveConfig?.tun?.enable);
                        if (tunOn) {
                            await invoke(COMMANDS.DISABLE_CMD);
                            // `disable_tun_cmd` stops the root core on macOS and only
                            // rewrites `run_config.yaml` elsewhere — neither leaves
                            // the core running without TUN. Without this the reset
                            // would report success with no core at all (macOS) or
                            // with TUN still active (Windows/Linux). This mirrors the
                            // TUN toggle in tun.js: disable, then bring the core
                            // back up on the updated config.
                            //
                            // TUN is off from here on, so the store is updated
                            // before the restart: a failed restart is then reported
                            // as itself instead of leaving the toggle showing TUN on.
                            //
                            // The preference is cleared only *after* the restart:
                            // `DISABLE_CMD` recorded `false`, and clearing it first
                            // would let a profile with `tun.enable: true` bring TUN
                            // straight back on this restart. Cleared afterwards, the
                            // next start follows the profile, which is the default.
                            appStore.set('isTunEnabled', false);
                            let clearErr = null;
                            try {
                                const afterDisable = await invoke(COMMANDS.GET_SETTINGS);
                                const configName = afterDisable.last_config || 'config.yaml';
                                // The snapshot (custom args included) is saved above.
                                const coreResult = await restartCore(configName, settings.custom_args || []);
                                // The core can fall back to another profile, or to
                                // the minimal config: say so, save the one it runs
                                // (the next launch must not retry the rejected
                                // file), and recover the one it loaded.
                                await keepFallbackProfile(coreResult, configName);
                                const recovery = await postRestartRecovery(restartedProfile(coreResult, configName));
                                if (recovery?.failed) recoveryFailed = true;
                            } finally {
                                // A failed preference write must not replace a
                                // restart error: that is the failure to report.
                                // After a successful restart it is reported below:
                                // `DISABLE_CMD` left `tun_enabled: false` stored,
                                // which is not the default.
                                await invoke(COMMANDS.PATCH_SETTINGS, { patch: { tun_enabled: null } })
                                    .catch((err) => {
                                        clearErr = err;
                                        settingsLogger.warn('[RestoreDefaults] could not clear tun_enabled', err);
                                    });
                                Bus.emit(Events.CONFIG_UPDATED);
                            }
                            if (clearErr) throw clearErr;
                            return;
                        }
                        // The live core has no TUN (or no core is running); the
                        // cached store may still say otherwise.
                        appStore.set('isTunEnabled', false);
                        await invoke(COMMANDS.PATCH_SETTINGS, { patch: { tun_enabled: null } });
                    } finally {
                        appStore.set('isNetworkUpdating', false);
                    }
                });

                // A home-mode click saved after the snapshot, or still
                // waiting to save, keeps its mode.
                if (appSettingsSaved && resetKeepsHomeMode(resetHomeWrite)) {
                    const previousHomeMode = appStore.get('homePageMode') || 'minimal';
                    appStore.set('homePageMode', 'minimal');
                    setHomeModeUI('minimal');
                    // Emit event so main.js switches the visible page if needed
                    if (previousHomeMode !== 'minimal') {
                        Bus.emit(Events.HOME_PAGE_MODE_CHANGED, { mode: 'minimal', previous: previousHomeMode });
                    }
                }

                // Re-render proxy list after settings are persisted
                const proxyContainer = document.getElementById('proxies-list');
                if (proxyContainer) proxyContainer.replaceChildren();
                Bus.emit(Events.CONFIG_UPDATED);

                if (errors.length > 0) {
                    showNotification(`${t.partialRestore || 'Some settings failed to restore'}: ${errors.join(', ')}`, "warning");
                } else if (!recoveryFailed) {
                    showNotification(t.settingsRestored || t.restoreDefaultsDesc || "Settings restored to default", "success");
                }
                if (recoveryFailed) {
                    showNotification(t.restartRecoveryWarn || 'The core restarted, but some proxy choices, patches or overrides couldn’t be restored.', 'warning');
                }
            } catch (err) {
                const error = toError(err);
                showNotification(`${t.restoreFailed || 'Failed to restore defaults'}: ${error.message || err}`, 'error');
            }
        };
    }

    // Theme color/mode/circles are handled by initThemeSettings above

    // ---- Settings persistence ----
    // Saves a full settings snapshot: run it in the switches' write queue, so an older
    // snapshot can never land after (and undo) a queued failover write, and in
    // the UI scale queue, so it can't read the old scale and save it back over a
    // scale click saved between its read and its write.
    function save() {
        return queueSmartConfigWrite(() => uiScaleQueue.run(saveNow));
    }
    async function saveNow() {
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
            // Owned by the auto-switch switch (applyFailover keeps the store current; the
            // switch may show off only because the Prism page turned the policy off).
            if (failoverToggle) currentSettings.failover_enabled = !!appStore.get('failoverEnabled');
            currentSettings.theme = appStore.get('currentTheme');
            if (customArgsInput) currentSettings.custom_args = customArgsInput.value.split('\n').map(a => a.trim()).filter(Boolean);
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
        void save();
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
    encryptConfigsToggle?.addEventListener('change', async () => {
        if (!encryptConfigsToggle) return;
        const enabled = encryptConfigsToggle.checked;
        const t = /** @type {any} */ (translations)[appStore.get('currentLang')];
        const confirmMsg = enabled
            ? (t.encryptConfigsConfirmEnable || "Enabling encryption will immediately encrypt all existing config files. You will not be able to edit config files with an external editor. Continue?")
            : (t.encryptConfigsConfirmDisable || "Disabling encryption will immediately decrypt all config files to plaintext. Continue?");
        // The app's own confirm dialog instead of the browser's native confirm().
        const ok = await showConfirmModal(
            enabled ? (t.encryptConfigsConfirmEnableTitle || 'Encrypt config files?') : (t.encryptConfigsConfirmDisableTitle || 'Decrypt config files?'),
            confirmMsg,
            { danger: enabled, confirmText: enabled ? (t.encryptConfigsConfirmEnableBtn || 'Encrypt') : (t.encryptConfigsConfirmDisableBtn || 'Decrypt') },
        );
        if (!ok) {
            encryptConfigsToggle.checked = !enabled;
            return;
        }
        appStore.set('encryptConfigs', enabled);
        void (async () => {
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
     * @returns {Promise<boolean|'restart'>} true when hot-reloaded, 'restart' when saved
     *   but the core must restart (already announced), false when it failed
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
                return 'restart';
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
        // Hot reload already applied it; saveConfigToCore warns itself when a restart is needed.
        if (ok === true) showNotification(t.settingApplied || "Applied", "success");
        // "restart": saved, takes effect after the restart notice saveConfigToCore already showed.
        else if (ok !== 'restart') { unifiedDelayToggle.checked = !unifiedDelayToggle.checked; showNotification(t.saveFailed || "Failed to save", "error"); }
    });

    ipv6Toggle?.addEventListener('change', async () => {
        if (!ipv6Toggle) return;
        // Hot-reload via core API, then persist to settings.json
        const ok = await saveConfigToCore({ ipv6: ipv6Toggle.checked });
        if (ok) await saveSetting('ipv6', ipv6Toggle.checked);
        /** @type {any} */
        const t = /** @type {any} */ (translations)[appStore.get('currentLang')];
        // Hot reload already applied it; saveConfigToCore warns itself when a restart is needed.
        if (ok === true) showNotification(t.settingApplied || "Applied", "success");
        // "restart": saved, takes effect after the restart notice saveConfigToCore already showed.
        else if (ok !== 'restart') { ipv6Toggle.checked = !ipv6Toggle.checked; showNotification(t.saveFailed || "Failed to save", "error"); }
    });

    allowLanToggle?.addEventListener('change', async () => {
        if (!allowLanToggle) return;
        // Hot-reload via core API, then persist to settings.json
        const ok = await saveConfigToCore({ 'allow-lan': allowLanToggle.checked });
        if (ok) await saveSetting('allow_lan', allowLanToggle.checked);
        /** @type {any} */
        const t = /** @type {any} */ (translations)[appStore.get('currentLang')];
        // Hot reload already applied it; saveConfigToCore warns itself when a restart is needed.
        if (ok === true) showNotification(t.settingApplied || "Applied", "success");
        // "restart": saved, takes effect after the restart notice saveConfigToCore already showed.
        else if (ok !== 'restart') { allowLanToggle.checked = !allowLanToggle.checked; showNotification(t.saveFailed || "Failed to save", "error"); }
    });

    // ---- Port configuration modal ----
    const portModal = document.getElementById('port-config-modal');
    const portMixedInput = /** @type {HTMLInputElement|null} */ (document.getElementById('port-mixed-input'));
    const portSocksInput = /** @type {HTMLInputElement|null} */ (document.getElementById('port-socks-input'));
    const portRedirInput = /** @type {HTMLInputElement|null} */ (document.getElementById('port-redir-input'));
    const portTproxyInput = /** @type {HTMLInputElement|null} */ (document.getElementById('port-tproxy-input'));
    const portCancelBtn = /** @type {HTMLButtonElement|null} */ (document.getElementById('port-config-cancel'));
    const portSaveBtn = /** @type {HTMLButtonElement|null} */ (document.getElementById('port-config-save'));

    // Redir works on Linux and macOS (pf); TProxy is Linux-only. Hidden fields keep their values.
    const portUa = navigator.userAgent.toLowerCase();
    const portIsLinux = portUa.includes('linux');
    const portRedirShown = portIsLinux || portUa.includes('mac');
    if (!portIsLinux) portTproxyInput?.parentElement?.classList.add('hidden');
    if (!portRedirShown) document.getElementById('port-linux-group')?.classList.add('hidden');

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
                /** @type {{ val: number, key: string, settingsKey: string|null }[]} */
                const ports = [
                    { val: mixedVal, key: 'mixed-port', settingsKey: 'mixed_port' },
                    { val: socksVal, key: 'socks-port', settingsKey: 'socks_port' },
                ];
                // Hidden Redir/TProxy fields are left out of range checks and writes.
                if (portRedirShown) ports.push({ val: redirVal, key: 'redir-port', settingsKey: null });
                if (portIsLinux) ports.push({ val: tproxyVal, key: 'tproxy-port', settingsKey: null });
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

                // Two listeners cannot share a port (0 = disabled, ignored). Hidden Redir/TProxy
                // ports may still be live in the core config, so they count here too.
                const hiddenLive = [
                    ...(portRedirShown ? [] : [redirVal]),
                    ...(portIsLinux ? [] : [tproxyVal]),
                ].filter(v => Number.isInteger(v));
                const used = [...ports.map(p => p.val), ...hiddenLive].filter(v => v > 0);
                if (new Set(used).size !== used.length) {
                    showNotification(t.portDuplicateError || 'Each port can only be used once', 'error');
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
        /** @type {(() => Promise<void>) | undefined} */
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
            /** @type {any} */
            const geoSettings = await invoke(COMMANDS.GET_SETTINGS);
            const configPath = geoSettings.last_config || 'config.yaml';
            const customArgs = geoSettings.custom_args || [];
            abortLatencyTests();
            const coreResult = await restartCore(configPath, customArgs);
            // The profile the core loaded (it may fall back to another one).
            const recovery = await postRestartRecovery(restartedProfile(coreResult, configPath));
            ring.setSuccess();
            // Only after the restart actually worked.
            if (recovery?.failed) {
                showNotification(t2.restartRecoveryWarn || 'The core restarted, but some proxy choices, patches or overrides couldn’t be restored.', 'warning');
            } else {
                showNotification(t2.notifGeoUpdateSuccess || "Geo databases updated and core restarted", 'success');
            }
        } catch (err) {
            ring.setError();
            const error = toError(err);
            showNotification(error.toString(), 'error');
        } finally {
            if (unlisten) dropListener(unlisten);
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
                t?.backupImportDesc || 'The core restarts and the window reloads after the import.',
                { confirmText: t?.backupImportBtn || 'Import and restart' },
            );
            if (!confirmed) {
                importBackupBtn.classList.remove('opacity-50', 'pointer-events-none');
                return;
            }
            // The import replaces settings and restarts the core: not while a
            // core update, a profile switch or another restart is running (the
            // reload would cut its recovery short), and nothing may start one
            // until the page reloads.
            if (appStore.get('isNetworkUpdating')) {
                showNotification(t?.updNetworkBusy || 'Another network change is in progress. Try again when it finishes.', 'warning');
                importBackupBtn.classList.remove('opacity-50', 'pointer-events-none');
                return;
            }
            appStore.set('isNetworkUpdating', true);
            let result;
            try {
                result = await invoke(COMMANDS.MISC.IMPORT_BACKUP);
            } catch (err) {
                appStore.set('isNetworkUpdating', false);
                throw err;
            }
            showNotification(result, 'success');
            // Reload settings and restart core in the background to avoid
            // blocking the UI. The import is already complete at this point.
            void (async () => {
                let reloadDelay = 0;
                try {
                    const importedSettings = await invoke(COMMANDS.GET_SETTINGS) || {};
                    const configPath = importedSettings.last_config || 'config.yaml';
                    const customArgs = importedSettings.custom_args || [];
                    abortLatencyTests();
                    const coreResult = await restartCore(configPath, customArgs);
                    const recovery = await postRestartRecovery(restartedProfile(coreResult, configPath));
                    if (recovery?.failed) {
                        // Same warning as the other restarts, with time to read it.
                        showNotification(t?.restartRecoveryWarn || 'The core restarted, but some proxy choices, patches or overrides couldn’t be restored.', 'warning');
                        reloadDelay = 3000;
                    }
                } catch (err) {
                    // eslint-disable-next-line no-console
                    console.error('Failed to restart core after backup restore:', err);
                    showNotification((err ?? 'Failed to restart core after restore').toString(), 'error');
                    // Delay reload to allow the user to read the error
                    // notification, but always reload to ensure UI-disk
                    // consistency (disk has the new imported settings).
                    reloadDelay = 3000;
                }
                // The lock stays held until the reload replaces the page
                // (the error delay included): a change started in between
                // would be cut off by it. The reloaded page starts unlocked.
                setTimeout(() => {
                    window.location.reload();
                }, reloadDelay);
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
        dropListener(_dropUnlisten);
        _dropUnlisten = null;
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
                void renderConfigs();
            }
        }).then(unlisten => {
            _dropUnlisten = unlisten;
        }).catch(e => settingsLogger.warn('Failed to listen for profiles-imported event', e));
    }

    // Theme circles are handled by initThemeSettings above

    // ---- Node scroll toggle ----

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
    void loadCoreVersion();

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

    void loadSettingsFromCore();

    // ---- Check for updates (one dialog for every state: ui/update-dialog.js) ----
    /**
     * The profile the new core actually loaded: start_core may fall back to
     * another one without changing last_config, and null means a minimal
     * config with no saved selection to restore.
     * @param {any} coreResult
     */
    const recoveryProfile = async (coreResult) => {
        if (coreResult && 'active_config' in coreResult) return coreResult.active_config ?? '';
        /** @type {any} */
        const current = await invoke(COMMANDS.GET_SETTINGS);
        return current?.last_config || 'config.yaml';
    };
    /** Point the API and traffic stream at the core an update started. @param {any} coreResult */
    const pointAtNewCore = (coreResult) => {
        if (coreResult?.port) {
            setBaseUrl(`http://127.0.0.1:${coreResult.port}`);
            setWsBaseUrl(`ws://127.0.0.1:${coreResult.port}`);
        }
        if (coreResult?.secret !== undefined) {
            setSecret(coreResult.secret);
            setWsSecret(coreResult.secret);
        }
    };
    /**
     * A minimal config (no subscription) or another profile: the
     * subscription-only controls follow what the new core loaded.
     * @param {any} coreResult
     * @param {boolean} ranProfile - a profile ran before the update
     */
    const followLoadedProfile = async (coreResult, ranProfile) => {
        if (!coreResult || !('active_config' in coreResult)) return;
        appStore.set('noSubscription', coreResult.active_config === null);
        // The new core rejected the saved profile and loaded another one
        // (or the minimal config): say so, and save the one it runs, as a
        // switch does, so the next launch does not retry the broken file.
        // Already on the minimal config, the update rejected nothing.
        if (!ranProfile && coreResult.active_config === null) return;
        try {
            /** @type {any} */
            const saved = await invoke(COMMANDS.GET_SETTINGS);
            await keepFallbackProfile(coreResult, saved?.last_config || 'config.yaml');
        } catch (err) {
            settingsLogger.warn('Checking the profile after the core update failed', err);
        }
    };
    /** After an in-app core update: point the API and traffic stream at the new core. */
    const onCoreUpdated = async (/** @type {any} */ coreResult) => {
        pointAtNewCore(coreResult);
        // forceReconnect() keeps the original callback (TRAFFIC_UPDATE for the console
        // dashboard); main.js picks up the new handle from CORE_RESTARTED.
        const newHandle = forceReconnect();
        if (!newHandle) {
            settingsLogger.warn('forceReconnect() returned null — traffic stream may be stalled after core update');
        }
        // Every listener learns of the restart (caches, latency state), with
        // the profile it actually loaded when known (a fallback or the minimal
        // config), as after any other restart.
        /** @type {{ handle?: any, activeConfig?: string | null }} */
        const restarted = { handle: newHandle || undefined };
        if (coreResult && 'active_config' in coreResult) restarted.activeConfig = coreResult.active_config;
        // Read before the restart event updates it: already on the minimal
        // config (no subscription yet), the update rejected nothing.
        const ranProfile = !appStore.get('noSubscription');
        Bus.emit(Events.CORE_RESTARTED, restarted);
        await followLoadedProfile(coreResult, ranProfile);
        await loadCoreVersion();
        // The new core started from the saved profile: re-run the Prism
        // patches and enabled overrides and restore the proxy selection, as
        // after any other core restart.
        // A step that did not finish (a patch or override that failed to
        // apply) makes the dialog warn instead of reporting a clean update.
        /** @type {{ failed: number } | null} */
        let recovery = null;
        try {
            recovery = await postRestartRecovery(await recoveryProfile(coreResult));
        } catch (err) {
            settingsLogger.warn('Recovery after the core update failed', err);
        }
        if (!recovery) {
            // Recovery stopped before its own refresh (a finished one already
            // synced the page, and counts a failed sync): refresh it here.
            try {
                await syncCoreConfig();
            } catch (err) {
                settingsLogger.warn('Refresh after the core update failed', err);
            }
        }
        if (!recovery || recovery.failed) {
            // Tells the dialog the saved choices, not just its view, may differ.
            throw Object.assign(new Error('Recovery after the core update did not finish'), { recovery: true });
        }
    };

    if (checkUpdateBtn) {
        // With close-to-tray off, closing the window quits the app and the update with it.
        checkUpdateBtn.onclick = () => openUpdateDialog({ onCoreUpdated, closeQuits: () => !!closeTrayToggle && !closeTrayToggle.checked });
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

    // --- Auto-switch nodes (failover), node scoring and scheduled tests: three switches ---
    /**
     * Wire one switch: apply its change in the shared queue; a failed save is reported
     * and the switch shows what is in effect after the rollback (two queued changes can
     * both fail, so "the opposite of this click" may be wrong), unless a later change
     * of the same switch took over.
     * @param {HTMLInputElement} toggle
     * @param {'failover'|'smart'|'autoTest'} key
     * @param {(on: boolean) => Promise<void>} apply
     * @param {() => boolean | Promise<boolean>} effective  what the setting is now
     * @param {() => void} [after]  runs after the switch changes or goes back
     */
    const wireSwitch = (toggle, key, apply, effective, after) => {
        toggle.addEventListener('change', async () => {
            const on = toggle.checked;
            const seq = ++switchSeq[key];
            after?.();
            try {
                await apply(on);
            } catch (err) {
                settingsLogger.error(`[${key}] Failed to save:`, err);
                const t = /** @type {any} */ (translations)[appStore.get('currentLang')] ?? {};
                showNotification(t.saveFailed || 'Failed to save', 'error');
                if (seq !== switchSeq[key]) return;
                /** @type {boolean} */
                let now = !on;
                try { now = await effective(); } catch { /* keep the pre-click state */ }
                if (seq !== switchSeq[key]) return;
                toggle.checked = now;
                after?.();
            }
        });
    };

    if (failoverToggle) {
        /** What the switch shows: the setting, unless the Prism page turned the policy off. */
        const readFailoverShown = async () => {
            const stored = !!appStore.get('failoverEnabled');
            /** @type {any} */
            let policy = null;
            if (stored) {
                try { policy = await prism.failoverGetPolicy(); } catch { /* unknown: keep what the setting says */ }
            }
            return shownFailover(stored, policy);
        };
        failoverToggle.checked = !!appStore.get('failoverEnabled');
        // The Prism page can turn the failover policy off or on later: follow it. The read
        // waits in the write queue, so it sees a change in progress finished, and it is
        // dropped if the switch was used meanwhile or a newer read started (the first
        // read included).
        let viewSeq = 0;
        const initSeq = switchSeq.failover;
        const initView = viewSeq;
        void readFailoverShown().then((shown) => {
            if (initSeq === switchSeq.failover && initView === viewSeq) failoverToggle.checked = shown;
        });
        Bus.on(Events.FAILOVER_POLICY_CHANGED, () => {
            const seq = ++viewSeq;
            const changeSeq = switchSeq.failover;
            void queueSmartConfigWrite(readFailoverShown).then((shown) => {
                if (seq === viewSeq && changeSeq === switchSeq.failover) failoverToggle.checked = shown;
            }, (err) => settingsLogger.warn('[failover] Failed to re-read state:', err));
        });
        wireSwitch(failoverToggle, 'failover', (on) => applyFailover(on, autoSwitchDeps()),
            () => queueSmartConfigWrite(readFailoverShown));
    }

    // Both switches are wired before scoring is read, so a click meanwhile is saved
    // and the read result does not overwrite it.
    if (autoTestToggle) {
        autoTestToggle.checked = readAutoTestEnabled();
        wireSwitch(autoTestToggle, 'autoTest', async (on) => {
            const seq = switchSeq.autoTest;
            autoTestPending++;
            try {
                await applyAutoTest(on, autoSwitchDeps());
            } finally {
                autoTestPending--;
            }
            // With scoring off the change is saved as off: show what was saved.
            if (seq === switchSeq.autoTest) autoTestToggle.checked = readAutoTestEnabled();
        }, () => readAutoTestEnabled());
    }

    if (smartToggle) {
        const initSeq = switchSeq.smart;
        wireSwitch(smartToggle, 'smart', async (on) => {
            // Scoring off also stops scheduled tests: a pending rollback of that switch must not restart them.
            if (!on) switchSeq.autoTest++;
            const autoTestSeq = switchSeq.autoTest;
            smartPending++;
            try {
                await applySmart(on, autoSwitchDeps());
            } finally {
                smartPending--;
            }
            // The change may have waited behind others (an earlier "off" stops the
            // scheduled tests only when it runs): show what was actually saved,
            // unless that switch was used since.
            if (autoTestToggle && autoTestSeq === switchSeq.autoTest) {
                autoTestToggle.checked = readAutoTestEnabled();
                syncAutoTestAvailability();
            }
        }, () => document.documentElement.style.getPropertyValue('--smart-enabled') === '1', () => {
            syncAutoTestAvailability();
            // A failed "off" puts scheduled tests back as they were.
            if (autoTestToggle && smartToggle.checked) autoTestToggle.checked = readAutoTestEnabled();
        });
        // A config reload re-read scoring from the engine (say it was unreadable here
        // at startup): show it, unless the switch was used since.
        const onSmartSynced = (/** @type {any} */ data) => {
            if (typeof data?.enabled !== 'boolean') return;
            smartKnown = true;
            smartSyncs++;
            if (smartPending > 0) return;
            smartToggle.checked = data.enabled;
            // Scheduled tests may have been turned off with it (engine says scoring is off),
            // unless their own change is still waiting to be saved.
            if (autoTestToggle && autoTestPending === 0) autoTestToggle.checked = readAutoTestEnabled();
            syncAutoTestAvailability();
        };
        Bus.on(Events.SMART_ENABLED_SYNCED, onSmartSynced);
        registerCleanup(() => Bus.off(Events.SMART_ENABLED_SYNCED, onSmartSynced));

        // The engine's config first, localStorage as the fallback.
        const syncsBefore = smartSyncs;
        // In the write queue: an answer from before a switch save must not
        // land after it and put the older value into the fallback.
        const smartState = await queueSmartConfigWrite(
            () => readSmartState({ getSmartConfig: () => prism.smartConfig() }),
        );
        smartKnown = smartKnown || smartState.known;
        // A sync from the engine that landed meanwhile is newer than this read.
        if (initSeq === switchSeq.smart && smartPending === 0 && syncsBefore === smartSyncs) {
            smartToggle.checked = smartState.enabled;
            document.documentElement.style.setProperty('--smart-enabled', smartToggle.checked ? '1' : '0');
        }
    }

    if (autoTestToggle) {
        // Left on by an older build while scoring is off: it never ran, so it goes off.
        // Only when scoring was really read: a localStorage guess must not turn it off for good.
        if (smartToggle && smartKnown && !smartToggle.checked && autoTestToggle.checked) {
            applyAutoTest(false, autoSwitchDeps())
                .catch((err) => settingsLogger.warn('[autoTest] Failed to clear stale setting:', err));
        }
        syncAutoTestAvailability();
    }

    // Node scoring parameters (scoring weights, test interval)
    const smartConfigBtn = document.getElementById('smart-config-btn');
    if (smartConfigBtn) {
        smartConfigBtn.onclick = async () => {
            // Remove existing modal if any
            dropOpenModal('smart-config-modal');

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

            // smart.toml keeps these nested (score.weights, score.decay, scheduler).
            const score0 = /** @type {any} */ (config)?.score || {};
            const sched0 = /** @type {any} */ (config)?.scheduler || {};
            const cv = {
                lat: Number(score0.weights?.latency_p90 ?? 0.4),
                suc: Number(score0.weights?.success_rate ?? 0.4),
                stab: Number(score0.weights?.stability ?? 0.2),
                // Each test pass measures every node: never more often than once a minute
                // (the old plugin page wrote a 10 s minimum nobody chose).
                minI: Math.max(SMART_MIN_TEST_INTERVAL_SECS, Number(sched0.min_interval_secs ?? 60) || 60),
                maxI: Number(sched0.max_interval_secs ?? 600),
                half: Number(score0.decay?.half_life_hours ?? 1.0),
            };

            const modal = document.createElement('div');
            modal.id = 'smart-config-modal';
            modal.className = 'fixed inset-0 z-[var(--z-modal)] flex items-center justify-center bg-[var(--zephyr-bg-overlay)] backdrop-blur-md';
            // NOTE: config.* values (latency_weight, success_weight, etc.) come from
            // prism.smartConfig() which calls a Tauri command backed by Rust f64 types.
            // They are NOT user-controlled strings and cannot contain HTML — they are
            // guaranteed to be numbers by the Rust type system.  Do not add HTML escaping
            // here; it would produce visible "&amp;" artifacts in the number inputs.
            // eslint-disable-next-line no-unsanitized/property -- i18n translation keys escaped via escapeHtml() // nosemgrep: js-innerhtml-assignment — verified safe, see eslint-disable above
            modal.innerHTML = `
                <div class="glass-card w-[460px] p-6 space-y-5" role="dialog" aria-modal="true" aria-labelledby="smart-modal-title">
                    <div class="flex items-center justify-between">
                        <h3 id="smart-modal-title" class="dialog-title">${escapeHtml(t.smartProxyConfigTitle || 'Node Scoring Parameters')}</h3>
                        <button type="button" id="smart-modal-close" class="text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors" aria-label="${escapeHtml(t.close || 'Close')}">
                            <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
                        </button>
                    </div>
                    <fieldset class="space-y-2" aria-labelledby="smart-weights-legend">
                        <div class="flex items-baseline justify-between">
                            <span id="smart-weights-legend" class="text-xs font-semibold text-[var(--text-secondary)]">${escapeHtml(t.smartProxyWeights || 'Score weights')}</span>
                            <span id="smart-weight-sum" class="text-2xs tabular-nums text-[var(--text-muted)]"></span>
                        </div>
                        <div class="grid grid-cols-3 gap-3">
                            <div class="flex flex-col gap-1.5">
                                <label for="smart-weight-latency" class="text-xs font-medium text-[var(--text-muted)]">${escapeHtml(t.smartProxyWeightLatency || 'Latency')}</label>
                                <input id="smart-weight-latency" type="number" step="0.1" min="0" max="1" value="${cv.lat}" class="form-control form-control-md form-control-mono">
                            </div>
                            <div class="flex flex-col gap-1.5">
                                <label for="smart-weight-success" class="text-xs font-medium text-[var(--text-muted)]">${escapeHtml(t.smartProxyWeightSuccess || 'Success rate')}</label>
                                <input id="smart-weight-success" type="number" step="0.1" min="0" max="1" value="${cv.suc}" class="form-control form-control-md form-control-mono">
                            </div>
                            <div class="flex flex-col gap-1.5">
                                <label for="smart-weight-stability" class="text-xs font-medium text-[var(--text-muted)]">${escapeHtml(t.smartProxyWeightStability || 'Stability')}</label>
                                <input id="smart-weight-stability" type="number" step="0.1" min="0" max="1" value="${cv.stab}" class="form-control form-control-md form-control-mono">
                            </div>
                        </div>
                    </fieldset>
                    <fieldset class="space-y-2">
                        <legend class="text-xs font-semibold text-[var(--text-secondary)]">${escapeHtml(t.smartProxyTestInterval || 'Test interval')}</legend>
                        <div class="grid grid-cols-3 gap-3">
                            <div class="flex flex-col gap-1.5">
                                <label for="smart-min-interval" class="text-xs font-medium text-[var(--text-muted)]">${escapeHtml(t.smartProxyMinInterval || 'Min (s)')}</label>
                                <input id="smart-min-interval" type="number" min="${SMART_MIN_TEST_INTERVAL_SECS}" step="10" value="${cv.minI}" class="form-control form-control-md form-control-mono">
                            </div>
                            <div class="flex flex-col gap-1.5">
                                <label for="smart-max-interval" class="text-xs font-medium text-[var(--text-muted)]">${escapeHtml(t.smartProxyMaxInterval || 'Max (s)')}</label>
                                <input id="smart-max-interval" type="number" min="60" step="60" value="${cv.maxI}" class="form-control form-control-md form-control-mono">
                            </div>
                            <div class="flex flex-col gap-1.5">
                                <label for="smart-half-life" class="text-xs font-medium text-[var(--text-muted)]">${escapeHtml(t.smartProxyHalfLife || 'Half-life (h)')}</label>
                                <input id="smart-half-life" type="number" step="0.5" min="0.1" value="${cv.half}" class="form-control form-control-md form-control-mono">
                            </div>
                        </div>
                    </fieldset>
                    <div class="flex items-center justify-between pt-1">
                        <button type="button" id="smart-modal-reset" class="row-action ms-[-10px]">${escapeHtml(t.smartProxyResetDefaults || 'Reset to defaults')}</button>
                        <button type="button" id="smart-modal-done" class="btn-primary">${escapeHtml(t.done || 'Done')}</button>
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
                smartTrap.deactivate();
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

            // closeModal() releases it, whichever control closes the dialog.
        const smartTrap = createFocusTrap(modal, { onEscape: () => closeModal() });
        _modalTraps.set(modal, smartTrap);
            smartTrap.activate();
            document.getElementById('smart-modal-close')?.addEventListener('click', closeModal);
            modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
            document.getElementById('smart-modal-done')?.addEventListener('click', closeModal);

            // Save on input change (debounced). Out-of-range values are clamped on save.
            const inputs = /** @type {NodeListOf<HTMLInputElement>} */ (modal.querySelectorAll('input[type="number"]'));
            /** @param {string} id */
            const num = (id) => Number.parseFloat(/** @type {HTMLInputElement|null} */ (modal.querySelector(`#${id}`))?.value ?? '');
            const sumEl = modal.querySelector('#smart-weight-sum');
            const showSum = () => {
                if (!sumEl) return;
                const sum = [num('smart-weight-latency'), num('smart-weight-success'), num('smart-weight-stability')]
                    .reduce((a, v) => a + (Number.isFinite(v) ? v : 0), 0);
                sumEl.textContent = `${t.smartProxyWeightSum || 'Total'} ${sum.toFixed(1)}`;
                const off = Math.abs(sum - 1) > 0.001;
                sumEl.classList.toggle('text-[var(--zephyr-color-warning)]', off);
                sumEl.classList.toggle('text-[var(--text-muted)]', !off);
            };
            showSum();
            const saveConfig = debounce(async () => {
                try {
                    const clamp = (/** @type {number} */ v, /** @type {number} */ lo, /** @type {number} */ hi, /** @type {number} */ dflt) =>
                        (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt);
                    const minI = Math.round(clamp(num('smart-min-interval'), SMART_MIN_TEST_INTERVAL_SECS, 86400, 60));
                    const maxI = Math.round(clamp(num('smart-max-interval'), minI, 86400, Math.max(600, minI)));
                    const weights = {
                        latency_p90: clamp(num('smart-weight-latency'), 0, 1, 0.4),
                        success_rate: clamp(num('smart-weight-success'), 0, 1, 0.4),
                        stability: clamp(num('smart-weight-stability'), 0, 1, 0.2),
                    };
                    // All weights at zero score nothing: keep the saved ones until one
                    // is raised (the total shown is already flagged), but still save
                    // the half-life and the intervals.
                    const keepWeights = weights.latency_p90 + weights.success_rate + weights.stability <= 0;
                    // Read and write in the switches' queue: neither can overwrite the
                    // other's change, and `enabled` stays whatever the switch last saved.
                    await queueSmartConfigWrite(async () => {
                        // A failed read must not save a config without `enabled`: let the error surface.
                        const current = /** @type {any} */ (await prism.smartConfig()) || {};
                        const score = current.score || {};
                        await prism.smartConfigSave({
                            ...current,
                            enabled: smartEnabledOf(current),
                            score: {
                                ...score,
                                type: score.type || 'ema',
                                weights: keepWeights ? { ...score.weights } : { ...score.weights, ...weights },
                                decay: { ...score.decay, half_life_hours: clamp(num('smart-half-life'), 0.1, 168, 1.0) },
                            },
                            scheduler: { ...current.scheduler, min_interval_secs: minI, max_interval_secs: maxI },
                        });
                    });
                } catch (err) {
                    settingsLogger.error('[smart] Failed to save config:', err);
                }
            }, 500);
            inputs.forEach(input => input.addEventListener('input', () => { showSum(); saveConfig(); }));
            modal.querySelector('#smart-modal-reset')?.addEventListener('click', () => {
                /** @type {Record<string, string>} */
                const defaults = {
                    'smart-weight-latency': '0.4', 'smart-weight-success': '0.4', 'smart-weight-stability': '0.2',
                    'smart-min-interval': '60', 'smart-max-interval': '600', 'smart-half-life': '1',
                };
                for (const [id, v] of Object.entries(defaults)) {
                    const el = /** @type {HTMLInputElement|null} */ (modal.querySelector(`#${id}`));
                    if (el) el.value = v;
                }
                showSum();
                saveConfig();
            });
        };
    }

    // Initialize log settings modal
    initLogSettingsModal();

    // Initialize third-party licenses viewer
    initLicensesModal();

    initCopyEnvSettings();

    initFakeClient();

    // Initialize network optimization UI
    initNetworkOptim().catch(() => {});

    // Start smart auto-test scheduler if enabled
    const shouldStartAutoTest = readAutoTestEnabled();
    if (shouldStartAutoTest) {
        // Delay to ensure smart toggle state is initialized first
        setTimeout(() => {
            // Scoring may have been turned off (stopping scheduled tests) meanwhile.
            if (readAutoTestEnabled()) startSmartAutoTest();
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
