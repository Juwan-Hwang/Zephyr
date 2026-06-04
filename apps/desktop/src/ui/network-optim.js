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

let isApplied = false;
let isLoading = false;

/**
 * Check current optimization status from the backend.
 * @returns {Promise<boolean>}
 */
async function checkStatus() {
    try {
        const result = await invoke(COMMANDS.CHECK_STATUS);
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
    const btn = document.getElementById('network-optim-btn');
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
        dot.className = 'w-2 h-2 rounded-full bg-green-500 transition-all';
        const span = document.createElement('span');
        span.setAttribute('data-i18n', 'networkOptimRevert');
        span.textContent = t('networkOptimRevert');
        btn.replaceChildren(span);
    } else {
        dot.className = 'w-2 h-2 rounded-full bg-zinc-600 transition-all';
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
    const autoApplyChecked = appStore.get('networkOptimAutoApply') ? 'checked' : '';

    const customHtml = `
        <div class="space-y-4 text-sm text-zinc-300">
            <p class="text-zinc-400">${t('networkOptimModalDesc')}</p>
            <div class="bg-black/30 rounded-lg p-4 space-y-2 text-xs">
                <h4 class="font-bold text-zinc-200 uppercase tracking-wider">${t('networkOptimModalChanges')}</h4>
                <ul class="space-y-1 text-zinc-400 list-disc list-inside">
                    <li>${t('networkOptimChange1')}</li>
                    <li>${t('networkOptimChange2')}</li>
                    <li>${t('networkOptimChange3')}</li>
                    <li>${t('networkOptimChange4')}</li>
                    <li>${t('networkOptimChange5')}</li>
                </ul>
            </div>
            <div class="bg-amber-500/10 border border-amber-500/20 rounded-lg p-3 text-xs text-amber-400">
                ${t('networkOptimModalWarning')}
            </div>
            <label class="flex items-center gap-3 cursor-pointer">
                <input type="checkbox" id="network-optim-auto-apply" class="w-4 h-4 rounded accent-accent" ${autoApplyChecked}>
                <span class="text-zinc-300 text-sm">${t('networkOptimAutoApply')}</span>
            </label>
        </div>
    `;

    const result = await showModal(
        t('networkOptimModalTitle'),
        '',
        '',
        true,
        customHtml
    );

    if (result === null) return; // User canceled

    // Save auto-apply preference
    const autoApplyCheckbox = document.getElementById('network-optim-auto-apply');
    const autoApply = autoApplyCheckbox?.checked ?? false;
    saveSetting('network_optim_auto_apply', autoApply);
    appStore.set('networkOptimAutoApply', autoApply);

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
        await invoke(COMMANDS.APPLY);
        isApplied = true;
        showNotification(t('networkOptimApplied'), 'success');
    } catch (e) {
        const msg = e?.toString() || '';
        if (msg.includes('canceled') || msg.includes('cancelled')) {
            showNotification(t('networkOptimCanceled'), 'info');
        } else {
            showNotification(t('networkOptimApplyFailed'), 'error');
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
        await invoke(COMMANDS.REVERT);
        isApplied = false;
        showNotification(t('networkOptimReverted'), 'success');
    } catch (e) {
        const msg = e?.toString() || '';
        if (msg.includes('canceled') || msg.includes('cancelled')) {
            showNotification(t('networkOptimCanceled'), 'info');
        } else {
            showNotification(t('networkOptimRevertFailed'), 'error');
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
    if (applied) return; // Already applied

    try {
        await invoke(COMMANDS.APPLY);
        isApplied = true;
    } catch {
        // Silently fail on startup auto-apply
    }
}
