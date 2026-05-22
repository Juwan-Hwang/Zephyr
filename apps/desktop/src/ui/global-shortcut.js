// @ts-check
/**
 * Global Shortcut handler module.
 *
 * Listens for `global-shortcut` events from the Rust backend
 * and executes the corresponding UI actions.
 */

import { listen, invoke, getCurrentWindow, patchConfig, closeAllConnections, getConfig } from '../api.js';
import { saveSetting } from './settings-helpers.js';
import { showNotification } from './notifications.js';
import { translations } from '../i18n.js';
import { updateSysProxyUI } from './sysproxy.js';
import { updateTrayStatus, updateTrayMenu } from './tray.js';
import { updateModeUI } from './modes.js';
import { appStore } from './state.js';
import { COMMANDS } from '@zephyr/shared';
import { apiLogger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Platform detection
// ---------------------------------------------------------------------------

const isMac = navigator.platform.toLowerCase().includes('mac');

/**
 * Convert a Tauri accelerator string to a display-friendly format.
 * On Mac: CmdOrCtrl → ⌘, Ctrl → ⌃, Alt → ⌥, Shift ⇧
 * On Windows/Linux: CmdOrCtrl → Ctrl, keep as-is
 * @param {string} accel
 * @returns {string}
 */
function formatAccelerator(accel) {
    if (!accel) return '';
    return accel
        .replace(/CmdOrCtrl/gi, isMac ? '⌘' : 'Ctrl')
        .replace(/Control/gi, isMac ? '⌃' : 'Ctrl')
        .replace(/Alt/gi, isMac ? '⌥' : 'Alt')
        .replace(/Shift/gi, isMac ? '⇧' : 'Shift')
        .replace(/Space/gi, '␣')
        .replace(/\bUp\b/gi, '↑')
        .replace(/\bDown\b/gi, '↓')
        .replace(/\bLeft\b/gi, '←')
        .replace(/\bRight\b/gi, '→');
}

/**
 * Build a Tauri accelerator from a KeyboardEvent.
 * Uses CmdOrCtrl for cross-platform compatibility.
 * @param {KeyboardEvent} e
 * @returns {string}
 */
function buildAccelerator(e) {
    const parts = [];
    if (e.ctrlKey || e.metaKey) parts.push('CmdOrCtrl');
    if (e.shiftKey) parts.push('Shift');
    if (e.altKey) parts.push('Alt');
    const key = e.key;
    if (!['Control', 'Shift', 'Alt', 'Meta'].includes(key)) {
        const keyMap = /** @type {Record<string, string>} */ ({ ' ': 'Space', 'ArrowUp': 'Up', 'ArrowDown': 'Down', 'ArrowLeft': 'Left', 'ArrowRight': 'Right' });
        parts.push(keyMap[key] || key.toUpperCase());
    }
    return parts.join('+');
}

// ---------------------------------------------------------------------------
// Supported actions registry
// ---------------------------------------------------------------------------

const SUPPORTED_ACTIONS = [
    { id: 'toggle-window', labelKey: 'shortcutToggleWindow' },
    { id: 'toggle-proxy', labelKey: 'shortcutToggleProxy' },
    { id: 'toggle-tun', labelKey: 'shortcutToggleTun' },
    { id: 'mode-rule', labelKey: 'shortcutModeRule' },
    { id: 'mode-global', labelKey: 'shortcutModeGlobal' },
    { id: 'mode-direct', labelKey: 'shortcutModeDirect' },
];

const DEFAULT_ACCELERATORS = /** @type {Record<string, string>} */ ({
    'toggle-window': 'CmdOrCtrl+Shift+Z',
    'toggle-proxy': 'CmdOrCtrl+Shift+P',
    'toggle-tun': '',
    'mode-rule': '',
    'mode-global': '',
    'mode-direct': '',
});

// ---------------------------------------------------------------------------
// Enabled state
// ---------------------------------------------------------------------------

const SHORTCUTS_ENABLED_KEY = 'global_shortcuts_enabled';

function isShortcutsEnabled() {
    return localStorage.getItem(SHORTCUTS_ENABLED_KEY) !== 'false';
}

// ---------------------------------------------------------------------------
// Shortcut storage helpers
// ---------------------------------------------------------------------------

/**
 * @returns {Record<string, string>}
 */
function loadShortcuts() {
    try {
        const saved = JSON.parse(localStorage.getItem('custom_shortcuts') || '{}');
        const result = /** @type {Record<string, string>} */ ({});
        for (const a of SUPPORTED_ACTIONS) {
            // Use saved value if key exists (even if empty string = user cleared it)
            // Otherwise fall back to default
            if (a.id in saved) {
                result[a.id] = saved[a.id];
            } else {
                result[a.id] = DEFAULT_ACCELERATORS[a.id] || '';
            }
        }
        return result;
    } catch {
        const result = /** @type {Record<string, string>} */ ({});
        for (const a of SUPPORTED_ACTIONS) result[a.id] = DEFAULT_ACCELERATORS[a.id] || '';
        return result;
    }
}

function saveShortcuts(/** @type {string} */ action, /** @type {string} */ accelerator) {
    const shortcuts = loadShortcuts();
    shortcuts[action] = accelerator;
    localStorage.setItem('custom_shortcuts', JSON.stringify(shortcuts));
}

function _removeShortcut(/** @type {string} */ action) {
    const shortcuts = loadShortcuts();
    shortcuts[action] = '';
    localStorage.setItem('custom_shortcuts', JSON.stringify(shortcuts));
    try {
        invoke(COMMANDS.SHORTCUTS.UNREGISTER_SHORTCUT, { action }).catch(() => {});
    } catch { /* ignore */ }
}

function getTranslations(/** @type {string} */ lang) {
    const all = /** @type {any} */ (translations);
    return all[lang] || all.en || {};
}

function getActionLabel(/** @type {string} */ actionId, /** @type {Record<string, string>} */ t) {
    const found = SUPPORTED_ACTIONS.find(a => a.id === actionId);
    if (found) return t[found.labelKey] || found.id;
    return actionId;
}

// ---------------------------------------------------------------------------
// Register / unregister shortcuts
// ---------------------------------------------------------------------------

export async function registerDefaultShortcuts() {
    if (!isShortcutsEnabled()) return;
    const shortcuts = loadShortcuts();
    for (const [action, accelerator] of Object.entries(shortcuts)) {
        if (!accelerator) continue;
        try {
            await invoke(COMMANDS.SHORTCUTS.REGISTER_SHORTCUT, { action, accelerator });
        } catch (err) {
            apiLogger.warn(`[GlobalShortcut] Failed to register ${action}:`, err);
        }
    }
}

export async function setShortcutsEnabled(/** @type {boolean} */ enabled) {
    localStorage.setItem(SHORTCUTS_ENABLED_KEY, enabled ? 'true' : 'false');
    if (!enabled) {
        const shortcuts = loadShortcuts();
        for (const action of Object.keys(shortcuts)) {
            try { await invoke(COMMANDS.SHORTCUTS.UNREGISTER_SHORTCUT, { action }).catch(() => {}); } catch { /* ignore */ }
        }
    } else {
        await registerDefaultShortcuts();
    }
}

// ---------------------------------------------------------------------------
// Shortcut settings modal UI
// ---------------------------------------------------------------------------

export function initShortcutSettings() {
    const openBtn = document.getElementById('open-shortcut-settings-btn');
    if (!openBtn) return;
    openBtn.addEventListener('click', () => openShortcutModal());
}

function openShortcutModal() {
    const lang = localStorage.getItem('lang') || 'en';
    const t = getTranslations(lang);

    const existing = document.getElementById('shortcut-modal');
    if (existing) existing.remove();

    const enabled = isShortcutsEnabled();

    const modal = document.createElement('div');
    modal.id = 'shortcut-modal';
    modal.className = 'fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-md';
    modal.innerHTML = `
        <div class="glass-card p-6 w-full max-w-md mx-4 space-y-4">
            <div class="flex items-center justify-between">
                <h3 class="text-sm font-bold text-zinc-800 dark:text-zinc-200">${t.globalShortcut || 'Global Shortcuts'}</h3>
                <button id="shortcut-modal-close" class="text-zinc-400 hover:text-zinc-800 dark:hover:text-zinc-200 transition-colors">
                    <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
                </button>
            </div>
            <div class="flex items-center justify-between py-2">
                <span class="text-xs text-zinc-600 dark:text-zinc-300">${t.enableGlobalShortcuts || 'Enable Global Shortcuts'}</span>
                <label class="ios-switch">
                    <input type="checkbox" id="shortcut-enable-toggle" ${enabled ? 'checked' : ''} />
                    <span class="switch-slider"></span>
                </label>
            </div>
            <div class="h-px bg-black/5 dark:bg-white/5"></div>
            <div id="shortcut-list" class="space-y-3"></div>
            <div class="flex items-center justify-between pt-2 border-t border-black/10 dark:border-white/10">
                <button id="shortcut-add-btn" class="btn-ghost text-xs px-3 py-1.5 text-accent">+ ${t.addShortcut || 'Add Shortcut'}</button>
                <button id="shortcut-modal-done" class="btn-ghost text-xs px-3 py-1.5">${t.done || 'Done'}</button>
            </div>
        </div>
    `;

    document.body.appendChild(modal);

    // Close all shortcut dropdowns when clicking outside the modal
    const closeDropdowns = (/** @type {Event} */ e) => {
        if (!modal.contains(/** @type {Node} */ (e.target))) {
            modal.querySelectorAll('.shortcut-dropdown-menu').forEach(m => m.classList.add('hidden'));
        }
    };
    document.addEventListener('click', closeDropdowns);

    // Store cleanup function on modal element
    /** @type {any} */ (modal)._cleanup = () => {
        document.removeEventListener('click', closeDropdowns);
    };

    /** Clean up event listeners and remove modal */
    function closeModal() {
        if (/** @type {any} */ (modal)._cleanup) /** @type {any} */ (modal)._cleanup();
        modal.remove();
    }

    document.getElementById('shortcut-modal-close')?.addEventListener('click', () => closeModal());
    modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
    document.getElementById('shortcut-modal-done')?.addEventListener('click', () => closeModal());

    const enableToggle = /** @type {HTMLInputElement|null} */ (document.getElementById('shortcut-enable-toggle'));
    const shortcutList = document.getElementById('shortcut-list');
    if (enableToggle && shortcutList) {
        enableToggle.addEventListener('change', async () => {
            await setShortcutsEnabled(enableToggle.checked);
            shortcutList.style.opacity = enableToggle.checked ? '1' : '0.4';
            shortcutList.style.pointerEvents = enableToggle.checked ? 'auto' : 'none';
        });
        if (!enabled) {
            shortcutList.style.opacity = '0.4';
            shortcutList.style.pointerEvents = 'none';
        }
    }

    renderShortcutList(t);

    document.getElementById('shortcut-add-btn')?.addEventListener('click', () => {
        addShortcutRow(t, '', '');
    });
}

/**
 * Get actions that are NOT yet in the list.
 * @returns {string[]}
 */
function _getUnboundActions() {
    const shortcuts = loadShortcuts();
    const boundActions = new Set(Object.keys(shortcuts).filter(a => shortcuts[a]));
    return SUPPORTED_ACTIONS.filter(a => !boundActions.has(a.id)).map(a => a.id);
}

function renderShortcutList(/** @type {Record<string, string>} */ t) {
    const list = document.getElementById('shortcut-list');
    if (!list) return;

    const shortcuts = loadShortcuts();
    list.innerHTML = '';

    // Only show actions that have an accelerator set
    for (const actionDef of SUPPORTED_ACTIONS) {
        const accelerator = shortcuts[actionDef.id] || '';
        if (!accelerator) continue;
        addShortcutRow(t, actionDef.id, accelerator);
    }
}

/**
 * @param {Record<string, string>} t
 * @param {string} actionId
 * @param {string} [existingAccelerator]
 */
function addShortcutRow(t, actionId, existingAccelerator) {
    const list = document.getElementById('shortcut-list');
    if (!list) return;

    const row = document.createElement('div');
    row.className = 'flex items-center gap-3';
    row.dataset.action = actionId;

    // Track original state to detect modifications
    let originalAction = actionId;
    let originalAccelerator = existingAccelerator || '';
    let hasChanged = false;

    /** Stores the raw Tauri accelerator (e.g. "CmdOrCtrl+Shift+Z") */
    let rawAccelerator = existingAccelerator || '';

    // --- Save button (hidden by default, shown only when changed) ---
    const saveBtn = document.createElement('button');
    saveBtn.className = 'btn-ghost text-xs px-2 py-1.5';
    saveBtn.textContent = t.save || 'Save';
    saveBtn.style.display = 'none';

    /** Check if current state differs from original */
    function checkChanged() {
        const currentAction = row.dataset.action || '';
        const currentAccel = rawAccelerator;
        hasChanged = (currentAction !== originalAction) || (currentAccel !== originalAccelerator);
        saveBtn.style.display = hasChanged ? '' : 'none';
    }

    // --- Action dropdown ---
    const selectWrap = document.createElement('div');
    selectWrap.className = 'relative flex-1';

    const selectBtn = document.createElement('button');
    selectBtn.type = 'button';
    selectBtn.className = 'select-common w-full flex items-center justify-between';
    const currentLabel = actionId ? getActionLabel(actionId, t) : (t.selectAction || 'Select action');
    selectBtn.innerHTML = `
        <span class="select-label">${currentLabel}</span>
        <svg class="w-3.5 h-3.5 text-zinc-500 transition-transform duration-200 dropdown-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 9 6 6 6-6"></path></svg>
    `;

    const dropdownMenu = document.createElement('div');
    dropdownMenu.className = 'shortcut-dropdown-menu hidden absolute left-0 right-0 top-[calc(100%+6px)] rounded-lg p-1 z-30';

    // Populate options: filter out already-bound actions when adding new row
    const currentShortcuts = loadShortcuts();
    const boundActions = new Set(Object.keys(currentShortcuts).filter(a => currentShortcuts[a]));
    const availableActions = actionId
        ? SUPPORTED_ACTIONS
        : SUPPORTED_ACTIONS.filter(a => !boundActions.has(a.id));

    for (const actionDef of availableActions) {
        const opt = document.createElement('button');
        opt.type = 'button';
        opt.dataset.value = actionDef.id;
        opt.className = 'dropdown-option w-full text-left px-3 py-2 rounded-[18px] text-xs text-zinc-700 dark:text-zinc-200 transition-all';
        if (actionDef.id === actionId) opt.classList.add('active');
        opt.textContent = getActionLabel(actionDef.id, t);
        opt.addEventListener('click', () => {
            const label = selectBtn.querySelector('.select-label');
            if (label) label.textContent = getActionLabel(actionDef.id, t);
            row.dataset.action = actionDef.id;
            dropdownMenu.classList.add('hidden');
            checkChanged();
        });
        dropdownMenu.appendChild(opt);
    }

    selectBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        // Close other shortcut dropdowns
        list.querySelectorAll('.shortcut-dropdown-menu').forEach(m => {
            if (m !== dropdownMenu) m.classList.add('hidden');
        });
        dropdownMenu.classList.toggle('hidden');
    });

    selectWrap.appendChild(selectBtn);
    selectWrap.appendChild(dropdownMenu);

    // --- Key recorder input ---
    const keyInput = document.createElement('input');
    keyInput.type = 'text';
    keyInput.className = 'select-common w-28 text-center cursor-pointer';
    keyInput.readOnly = true;
    keyInput.placeholder = t.clickToRecord || 'Click to record';
    keyInput.value = existingAccelerator ? formatAccelerator(existingAccelerator) : '';

    keyInput.addEventListener('focus', () => {
        rawAccelerator = existingAccelerator || rawAccelerator;
        keyInput.value = '';
        keyInput.placeholder = t.pressKeys || 'Press keys...';
    });

    keyInput.addEventListener('blur', () => {
        if (!keyInput.value) {
            keyInput.value = rawAccelerator ? formatAccelerator(rawAccelerator) : '';
            keyInput.placeholder = t.clickToRecord || 'Click to record';
        }
        checkChanged();
    });

    keyInput.addEventListener('keydown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const accel = buildAccelerator(e);
        if (accel.split('+').length >= 2) {
            rawAccelerator = accel;
            keyInput.value = formatAccelerator(accel);
            keyInput.placeholder = '';
            keyInput.blur();
        }
    });

    // --- Save button click handler ---
    saveBtn.addEventListener('click', async () => {
        const currentAction = /** @type {string} */ (row.dataset.action);
        if (!currentAction) {
            showNotification(t.shortcutSelectAction || 'Please select an action', 'error');
            return;
        }
        if (!rawAccelerator) {
            try { await invoke(COMMANDS.SHORTCUTS.UNREGISTER_SHORTCUT, { action: currentAction }); } catch { /* ignore */ }
            const sc = loadShortcuts();
            sc[currentAction] = '';
            localStorage.setItem('custom_shortcuts', JSON.stringify(sc));
            showNotification(t.shortcutCleared || 'Shortcut cleared', 'success');
            row.remove();
            return;
        }
        try {
            await invoke(COMMANDS.SHORTCUTS.REGISTER_SHORTCUT, { action: currentAction, accelerator: rawAccelerator });
            saveShortcuts(currentAction, rawAccelerator);
            originalAction = currentAction;
            originalAccelerator = rawAccelerator;
            hasChanged = false;
            saveBtn.style.display = 'none';
            showNotification(t.shortcutSaved || 'Shortcut saved', 'success');
        } catch (err) {
            showNotification(`${t.shortcutFailed || 'Failed'}: ${err}`, 'error');
        }
    });

    // --- Clear/delete button ---
    const clearBtn = document.createElement('button');
    clearBtn.className = 'text-zinc-500 hover:text-rose-400 transition-colors p-1';
    clearBtn.title = t.delete || 'Delete';
    clearBtn.innerHTML = '<svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>';
    clearBtn.addEventListener('click', async () => {
        const currentAction = row.dataset.action;
        if (!currentAction) return;
        keyInput.value = '';
        rawAccelerator = '';
        // Directly invoke unregister to ensure it completes before removing UI
        try {
            await invoke(COMMANDS.SHORTCUTS.UNREGISTER_SHORTCUT, { action: currentAction });
        } catch { /* may fail if not registered */ }
        // Update localStorage
        const shortcuts = loadShortcuts();
        shortcuts[currentAction] = '';
        localStorage.setItem('custom_shortcuts', JSON.stringify(shortcuts));
        row.remove();
    });

    row.append(selectWrap, keyInput, saveBtn, clearBtn);
    list.appendChild(row);
}

// ---------------------------------------------------------------------------
// Event listener for global shortcuts
// ---------------------------------------------------------------------------

export async function initGlobalShortcut() {
    return listen('global-shortcut', async (/** @type {{ payload: { action: string } }} */ event) => {
        if (!isShortcutsEnabled()) return;
        const { action } = event.payload;

        switch (action) {
            case 'toggle-window': await toggleWindow(); break;
            case 'toggle-proxy': await toggleProxy(); break;
            case 'toggle-tun': await toggleTun(); break;
            case 'mode-rule': await switchMode('rule'); break;
            case 'mode-global': await switchMode('global'); break;
            case 'mode-direct': await switchMode('direct'); break;
            default: apiLogger.warn(`[GlobalShortcut] Unknown action: ${action}`);
        }
    });
}

// ---------------------------------------------------------------------------
// Shortcut actions (with rate protection)
// ---------------------------------------------------------------------------

/** Mutex lock to prevent concurrent toggle operations */
let _actionLock = false;

async function toggleWindow() {
    try {
        const win = getCurrentWindow();
        const visible = await win.isVisible();
        if (visible) { await win.hide(); } else { await win.show(); await win.setFocus(); }
    } catch (err) {
        apiLogger.warn('[GlobalShortcut] Failed to toggle window:', err);
    }
}

async function toggleProxy() {
    if (_actionLock) return;
    _actionLock = true;
    const lang = localStorage.getItem('lang') || 'en';
    const t = /** @type {Record<string, string>} */ (/** @type {any} */ (translations)[lang] || /** @type {any} */ (translations).en);
    try {
        const enabled = await invoke(COMMANDS.GET_SYS_PROXY);
        if (enabled) {
            await invoke(COMMANDS.DISABLE_SYSPROXY);
            showNotification(t.proxyInactive || 'System proxy disabled', 'info');
        } else {
            /** @type {Record<string, any>} */
            const currentConfig = await getConfig();
            const currentPort = currentConfig?.['mixed-port'] || currentConfig?.port || currentConfig?.['socks-port'] || 7890;
            await invoke(COMMANDS.ENABLE_SYSPROXY, {
                server: `127.0.0.1:${currentPort}`,
                bypass: null,
            });
            showNotification(t.proxyActive || 'System proxy enabled', 'success');
        }
        // Update UI and tray after toggle (await UI update first so tray reads correct state)
        await updateSysProxyUI();
        await updateTrayStatus();
        updateTrayMenu().catch(() => {});
    } catch (err) {
        showNotification(err?.toString?.() || 'Unknown error', 'error');
    } finally {
        _actionLock = false;
    }
}

async function toggleTun() {
    if (_actionLock) return;
    if (appStore.get('isNetworkUpdating')) return;
    _actionLock = true;
    try {
        // Simulate clicking the TUN toggle to reuse the full TUN switch logic
        // (including macOS root auth, persistConfigChanges, closeAllConnections, UI/tray updates)
        const tunToggle = /** @type {HTMLInputElement|null} */ (document.getElementById('tun-proxy-toggle'));
        if (!tunToggle) {
            apiLogger.warn('[GlobalShortcut] TUN toggle element not found');
            return;
        }
        // Flip the checked state and dispatch change event to trigger tun.js handler
        tunToggle.checked = !tunToggle.checked;
        tunToggle.dispatchEvent(new Event('change', { bubbles: true }));
    } catch (err) {
        const lang = localStorage.getItem('lang') || 'en';
        const t = /** @type {Record<string, string>} */ (/** @type {any} */ (translations)[lang] || /** @type {any} */ (translations).en);
        showNotification(`${t.tunToggleFailed || 'TUN toggle failed'}: ${err}`, 'error');
    } finally {
        _actionLock = false;
    }
}

async function switchMode(/** @type {string} */ mode) {
    if (_actionLock) return;
    _actionLock = true;
    const lang = localStorage.getItem('lang') || 'en';
    const t = /** @type {Record<string, string>} */ (/** @type {any} */ (translations)[lang] || /** @type {any} */ (translations).en);
    try {
        await patchConfig({ mode });
        await saveSetting('mode', mode);
        await closeAllConnections();
        const modeNames = /** @type {Record<string, string>} */ ({ rule: t.modeRule || 'Rule', global: t.modeGlobal || 'Global', direct: t.modeDirect || 'Direct' });
        showNotification(`${t.switchedTo || 'Switched to'} ${modeNames[mode] || mode}`, 'success');
        // Update mode UI and tray
        updateModeUI(mode);
        await updateTrayStatus();
        updateTrayMenu().catch(() => {});
    } catch (err) {
        showNotification(`${t.modeSwitchFailed || 'Mode switch failed'}: ${err}`, 'error');
    } finally {
        _actionLock = false;
    }
}
