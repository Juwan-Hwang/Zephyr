// @ts-check
/**
 * Network Optimization module.
 * Allows users to apply/revert TCP parameter tuning from the settings page.
 */

import { invoke } from '../api.js';
import { showNotification, showConfirmModal, showModal } from './notifications.js';
import { saveSetting } from './settings-helpers.js';
import { appStore } from './state.js';
import { t } from '../i18n.js';
import { COMMANDS } from '@zephyr/shared';
import { toError } from '../types/guards.js';

let isApplied = false;
let isLoading = false;

/** @type {Promise<boolean>|null} Cached status check promise to avoid duplicate IPC calls */
let statusCheckPromise = null;

/**
 * Check current optimization status from the backend.
 * Caches the promise to prevent redundant concurrent IPC calls during startup.
 * @returns {Promise<boolean>}
 */
async function checkStatus() {
    if (statusCheckPromise) return statusCheckPromise;
    statusCheckPromise = _checkStatusInner();
    try {
        return await statusCheckPromise;
    } finally {
        statusCheckPromise = null;
    }
}

async function _checkStatusInner() {
    try {
        const result = await invoke(COMMANDS.CHECK_NET_OPTIM_STATUS);
        isApplied = result?.applied === true;
        return isApplied;
    } catch {
        isApplied = false;
        return false;
    }
}

/**
 * Update UI elements to reflect current state.
 */
function updateUI() {
    const btn = /** @type {HTMLButtonElement|null} */ (document.getElementById('network-optim-btn'));
    const dot = document.getElementById('network-optim-status-dot');
    if (!btn || !dot) return;

    if (isLoading) {
        btn.disabled = true;
        btn.classList.add('opacity-50');
        return;
    }

    btn.disabled = false;
    btn.classList.remove('opacity-50');

    if (isApplied) {
        dot.className = 'w-2 h-2 rounded-full bg-success transition-colors';
        const span = document.createElement('span');
        span.setAttribute('data-i18n', 'networkOptimRevert');
        span.textContent = t('networkOptimRevert');
        btn.replaceChildren(span);
    } else {
        dot.className = 'w-2 h-2 rounded-full bg-[var(--text-tertiary)] transition-colors';
        const span = document.createElement('span');
        span.setAttribute('data-i18n', 'networkOptimApply');
        span.textContent = t('networkOptimApply');
        btn.replaceChildren(span);
    }
}

/**
 * Show the apply confirmation modal with details and auto-apply checkbox.
 */
async function showApplyModal() {
    const autoApplyChecked = appStore.get('networkOptimAutoApply');
    let autoApplyValue = autoApplyChecked;

    const result = await showModal(
        t('networkOptimModalTitle'),
        '',
        '',
        true,
        '',
        (contentArea, _close) => {
            // Restore confirm/cancel buttons (hidden by isCustomContent=true)
            const confirmBtn = document.getElementById('modal-confirm');
            const cancelBtn = document.getElementById('modal-cancel');
            if (confirmBtn) confirmBtn.classList.remove('hidden');
            if (cancelBtn) cancelBtn.classList.remove('hidden');

            // Replace the default input with our custom content
            contentArea.replaceChildren();

            const wrapper = document.createElement('div');
            wrapper.className = 'space-y-4 text-sm text-[var(--text-secondary)]';

            const desc = document.createElement('p');
            desc.className = 'text-[var(--text-secondary)]';
            desc.textContent = t('networkOptimModalDesc');
            wrapper.appendChild(desc);

            const changesBox = document.createElement('div');
            changesBox.className = 'bg-[var(--zephyr-bg-input)] rounded-lg p-4 space-y-2 text-xs';
            const changesTitle = document.createElement('h4');
            changesTitle.className = 'font-bold text-[var(--text-primary)] uppercase tracking-wider';
            changesTitle.textContent = t('networkOptimModalChanges');
            changesBox.appendChild(changesTitle);
            const ul = document.createElement('ul');
            ul.className = 'space-y-1 text-[var(--text-secondary)] list-disc list-inside';
            for (let i = 1; i <= 5; i++) {
                const li = document.createElement('li');
                li.textContent = t(`networkOptimChange${i}`);
                ul.appendChild(li);
            }
            changesBox.appendChild(ul);
            wrapper.appendChild(changesBox);

            const infoBox = document.createElement('div');
            infoBox.className = 'bg-blue-500/10 border border-blue-500/20 rounded-lg p-3 text-xs text-blue-400';
            infoBox.textContent = t('networkOptimModalInfo');
            wrapper.appendChild(infoBox);

            const label = document.createElement('label');
            label.className = 'flex items-center gap-3 cursor-pointer';
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.id = 'network-optim-auto-apply';
            checkbox.className = 'w-4 h-4 rounded accent-accent';
            checkbox.checked = autoApplyChecked;
            checkbox.addEventListener('change', () => {
                autoApplyValue = checkbox.checked;
            });
            const labelSpan = document.createElement('span');
            labelSpan.className = 'text-[var(--text-secondary)] text-sm';
            labelSpan.textContent = t('networkOptimAutoApply');
            label.appendChild(checkbox);
            label.appendChild(labelSpan);
            wrapper.appendChild(label);

            contentArea.appendChild(wrapper);
        }
    );

    if (result === null) return; // User canceled

    // Use the closure variable instead of querying DOM (element is removed after modal closes)
    try {
        await saveSetting('network_optim_auto_apply', autoApplyValue);
    } catch (e) {
        showNotification(`${t('networkOptimApplyFailed')}: ${toError(e).message}`, 'error');
        return;
    }
    appStore.set('networkOptimAutoApply', autoApplyValue);

    // Apply optimizations
    await applyOptimizations();
}

/**
 * Show the revert confirmation modal.
 */
async function showRevertModal() {
    const confirmed = await showConfirmModal(
        t('networkOptimRevertTitle'),
        t('networkOptimRevertDesc')
    );
    if (!confirmed) return;
    await revertOptimizations();
}

/**
 * Apply network optimizations.
 */
async function applyOptimizations() {
    isLoading = true;
    updateUI();
    try {
        await invoke(COMMANDS.APPLY_NET_OPTIM);
        isApplied = true;
        showNotification(t('networkOptimApplied'), 'success');
    } catch (e) {
        const error = toError(e);
        const msg = error.message || error.toString();
        if (msg.toLowerCase().includes('canceled') || msg.toLowerCase().includes('cancelled')) {
            showNotification(t('networkOptimCanceled'), 'info');
        } else {
            showNotification(`${t('networkOptimApplyFailed')}: ${msg}`, 'error');
        }
    } finally {
        isLoading = false;
        updateUI();
    }
}

/**
 * Revert network optimizations.
 */
async function revertOptimizations() {
    isLoading = true;
    updateUI();
    try {
        await invoke(COMMANDS.REVERT_NET_OPTIM);
        isApplied = false;
        showNotification(t('networkOptimReverted'), 'success');
    } catch (e) {
        const error = toError(e);
        const msg = error.message || error.toString();
        if (msg.toLowerCase().includes('canceled') || msg.toLowerCase().includes('cancelled')) {
            showNotification(t('networkOptimCanceled'), 'info');
        } else {
            showNotification(`${t('networkOptimRevertFailed')}: ${msg}`, 'error');
        }
    } finally {
        isLoading = false;
        updateUI();
    }
}

/**
 * Initialize the network optimization UI.
 * Call this from settings.js initSettings().
 */
export async function initNetworkOptim() {
    const btn = document.getElementById('network-optim-btn');
    if (!btn) return;

    // Check current status
    await checkStatus();
    updateUI();

    // Button click handler
    btn.addEventListener('click', () => {
        if (isLoading) return;
        if (isApplied) {
            showRevertModal();
        } else {
            showApplyModal();
        }
    });
}

/**
 * Auto-apply optimizations on startup if enabled.
 * Call this from the app initialization flow.
 */
export async function autoApplyIfNeeded() {
    const autoApply = appStore.get('networkOptimAutoApply');
    if (!autoApply) return;

    const applied = await checkStatus();
    if (applied) {
        isApplied = true;
        updateUI();
        return;
    }

    try {
        await invoke(COMMANDS.APPLY_NET_OPTIM);
        isApplied = true;
        updateUI();
    } catch {
        // Silently fail on startup auto-apply
    }
}
