// @ts-check
/**
 * Override management module — upgrades the existing plugin panel on the
 * subscriptions page to support persistent override scripts.
 *
 * Override scripts modify Mihomo config via `main(config)` and are persisted
 * across sessions. They are stored in `prism/overrides/` and executed via
 * `execute_with_write` (QuickJS sandbox).
 *
 * @module ui/plugins
 */

import {
    overrideList,
    overrideCreate,
    overrideUpdate,
    overrideDelete,
    overrideGetContent,
    overrideSetContent,
    overrideReorder,
    overrideToggle,
    // eslint-disable-next-line no-unused-vars -- reserved for future use
    overrideTest,
    // eslint-disable-next-line no-unused-vars -- reserved for future use
    overrideRefreshRemote,
    // eslint-disable-next-line no-unused-vars -- reserved for future use
    overrideApplyAll,
    overrideExport,
    overrideImport,
} from './prism.js';
import { SVG_ICONS } from './icons.js';
import { stopSmartAutoTest, startSmartAutoTest, renderProxies } from './proxies.js';
import { t } from '../i18n.js';
import { showNotification, showModal } from './notifications.js';
import { createEditor, getEditorContent } from './editor/prism-editor.js';
import { escapeAttr } from '../utils/sanitize.js';
import { EditorView, StateEffect } from '../cm6.bundle.js';

// ═══════════════════════════════════════════════════════════════════════
//  Internal helpers
// ═══════════════════════════════════════════════════════════════════════

/**
 * Get override card elements that are direct children of the list container.
 * IMPORTANT: Cards contain buttons with data-id, so querySelectorAll('[data-id]')
 * would match those too (4 matches per card). We must only select top-level cards.
 * @param {HTMLElement} container
 * @returns {HTMLElement[]}
 */
function getOverrideCards(container) {
    return /** @type {HTMLElement[]} */ ([...container.children].filter(c => c instanceof HTMLElement && c.dataset?.id));
}

// ═══════════════════════════════════════════════════════════════════════
//  Internal state
// ═══════════════════════════════════════════════════════════════════════

/** Currently active override ID being edited. */
let activeOverrideId = '';

/** Currently active override name (for editor title). */
let activeOverrideName = '';

/**
 * Current override items list (for reorder).
 * @type {import('./prism.js').OverrideItem[]}
 */
let overrideItems = [];

/** Drag state for mouse-based reorder (HTML5 DnD unreliable in Tauri WebView). @type {null|{el: HTMLElement, id: string, startY: number, moved: boolean, elHeight?: number, offsetY?: number, clone?: HTMLElement, currentIndex?: number, cardMids?: number[], cards?: HTMLElement[], targetIndex?: number}} */
let _dragState = null;

/** CodeMirror EditorView for the override script editor (null when not active). @type {EditorView|null} */
let scriptEditorView = null;

/** CodeMirror EditorView for the fullscreen editor (null when not active). @type {EditorView|null} */
let fullscreenEditorView = null;

/** Search filter string. @type {string} */
let searchFilter = '';

/** Current active override extension for fullscreen editor. @type {string} */
let activeOverrideExt = '';

/** Whether fullscreen editor is currently open. */
let isFullscreenEditorOpen = false;

// ═══════════════════════════════════════════════════════════════════════
//  Public entry point
// ═══════════════════════════════════════════════════════════════════════

export function initPlugins() {
    // ── DOM references ──────────────────────────────────────────────
    const openBtn = document.getElementById('open-plugins-btn');
    const closeBtn = document.getElementById('close-plugins-btn');
    const panel = document.getElementById('plugin-panel');
    const backdrop = document.getElementById('plugin-panel-backdrop');
    const pluginList = document.getElementById('plugin-list');
    const scriptArea = document.getElementById('plugin-script-area');
    const scriptEditor = document.getElementById('plugin-script-editor');
    // eslint-disable-next-line no-unused-vars -- placeholder for CodeMirror editor
    const scriptCm6 = document.getElementById('plugin-script-cm6');
    const scriptOutput = document.getElementById('plugin-script-output');
    const scriptOutputToggle = document.getElementById('plugin-script-output-toggle');
    const scriptOutputLabel = document.getElementById('plugin-script-output-label');
    const scriptOutputChevron = document.getElementById('plugin-script-output-chevron');
    // ── Script output collapsible ────────────────────────────
    scriptOutputToggle?.addEventListener('click', () => {
        if (!scriptOutput) return;
        const isHidden = scriptOutput.style.display === 'none';
        scriptOutput.style.display = isHidden ? '' : 'none';
        if (scriptOutputChevron) {
            scriptOutputChevron.style.transform = isHidden ? 'rotate(180deg)' : '';
        }
        if (isHidden && scriptOutputLabel) {
            const lineCount = (scriptOutput.textContent?.match(/\n/g) || []).length + 1;
            scriptOutputLabel.textContent = (t('overrideOutputLineCount') || 'Output (@@count@@ lines)').replace('@@count@@', String(lineCount));
        }
    });
    // eslint-disable-next-line no-unused-vars -- placeholder for editor title
    const scriptTitle = document.getElementById('plugin-script-title');
    const scriptRunBtn = document.getElementById('plugin-script-run-btn');
    const scriptValidateBtn = document.getElementById('plugin-script-validate-btn');
    const scriptStatus = document.getElementById('plugin-script-status');
    const scriptBackBtn = document.getElementById('plugin-script-back-btn');

    if (!panel) return;

    // ── Panel open / close ──────────────────────────────────────────
    openBtn?.addEventListener('click', () => {
        panel.classList.remove('hidden');
        // Animate in
        requestAnimationFrame(() => {
            const inner = panel.querySelector('.plugin-panel');
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
        loadOverrides();
    });

    const closePanel = () => {
        const inner = panel.querySelector('.plugin-panel');
        if (inner instanceof HTMLElement) {
            inner.style.transition = 'all 0.15s ease-in';
            inner.style.transform = 'scale(0.96)';
            inner.style.opacity = '0';
            setTimeout(() => panel.classList.add('hidden'), 150);
        } else {
            panel.classList.add('hidden');
        }
    };

    closeBtn?.addEventListener('click', closePanel);
    backdrop?.addEventListener('click', closePanel);

    // ── Header: search ──────────────────────────────────────────────
    const searchInput = document.getElementById('plugin-search-input');
    searchInput?.addEventListener('input', (e) => {
        if (e.target instanceof HTMLInputElement) {
            searchFilter = e.target.value.toLowerCase();
        } else {
            searchFilter = '';
        }
        if (pluginList) renderOverrideCards(pluginList, overrideItems, searchFilter);
    });

    // ── Header: new override dropdown ─────────────────────────────
    setupNewOverrideDropdown(panel);

    // ── Header: bulk actions ───────────────────────────────────────
    const enableAllBtn = document.getElementById('plugin-enable-all-btn');
    const disableAllBtn = document.getElementById('plugin-disable-all-btn');
    enableAllBtn?.addEventListener('click', () => bulkToggle(true));
    disableAllBtn?.addEventListener('click', () => bulkToggle(false));

    // ── Script area back button ─────────────────────────────────────
    scriptBackBtn?.addEventListener('click', () => {
        pluginList?.classList.remove('hidden');
        scriptArea?.classList.add('hidden');
        if (scriptEditorView) { scriptEditorView.destroy(); scriptEditorView = null; }
        // Refresh list to reflect any changes
        loadOverrides();
    });

    // ── Script validate ─────────────────────────────────────────────
    scriptValidateBtn?.addEventListener('click', async () => {
        if (!scriptStatus) return;
        const source = (scriptEditorView ? getEditorContent(scriptEditorView) : ((scriptEditor instanceof HTMLInputElement || scriptEditor instanceof HTMLTextAreaElement) ? scriptEditor.value : '')).trim();
        if (!source) return;

        scriptStatus.textContent = t('overrideValidating') ?? 'Validating...';
        scriptStatus.className = 'text-xs text-[var(--text-secondary)]';

        try {
            // Use overrideSetContent with dry_run for validation
            const result = await overrideSetContent(activeOverrideId, source, true);
            if (result.success) {
                scriptStatus.textContent = t('overrideScriptSafe') ?? '✓ Script safe';
                scriptStatus.className = 'text-xs text-success';
            } else {
                scriptStatus.textContent = '✗ ' + (formatScriptError(result.error) ?? (t('overrideScriptUnsafe') ?? 'Script may be unsafe'));
                scriptStatus.className = 'text-xs text-danger';
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            // If core is not running, show a friendlier message instead of a hard error
            if (msg.includes('Failed to read running config') || msg.includes('No such file')) {
                scriptStatus.textContent = t('overrideCoreNotRunning') ?? '⚠ Core not running, cannot validate';
                scriptStatus.className = 'text-xs text-warning';
            } else {
                scriptStatus.textContent = '✗ ' + msg;
                scriptStatus.className = 'text-xs text-danger';
            }
        }
    });

    // ── Script run (save + execute) ──────────────────────────────
    scriptRunBtn?.addEventListener('click', async () => {
        if (!scriptOutput || !activeOverrideId) return;
        const source = (scriptEditorView ? getEditorContent(scriptEditorView) : ((scriptEditor instanceof HTMLInputElement || scriptEditor instanceof HTMLTextAreaElement) ? scriptEditor.value : '')).trim();
        if (!source) return;

        scriptOutput.textContent = '';
        scriptOutput.className = 'text-xs text-[var(--text-secondary)] font-mono whitespace-pre-wrap break-all';

        stopSmartAutoTest();

        try {
            const result = await overrideSetContent(activeOverrideId, source, false);

            // Invalidate caches so renderProxies fetches fresh data
            const { invalidateProxiesCache, invalidateConfigCache } = await import('./cache.js');
            invalidateProxiesCache();
            invalidateConfigCache();

            // Wait for Mihomo to finish reloading, then refresh proxies page
            setTimeout(() => {
                startSmartAutoTest();
                renderProxies();
            }, 1000);

            const lines = [];
            if (result.logs?.length) {
                lines.push('── logs ──────────────────────');
                for (const log of result.logs) {
                    lines.push(`[${log.level ?? 'Info'}] ${log.message}`);
                }
                lines.push('');
            }

            lines.push('── result ───────────────────');
            lines.push(`success        : ${result.success}`);
            lines.push(`configModified : ${result.configModified}`);
            lines.push(`duration       : ${result.durationUs ?? 0} µs`);
            if (result.error) {
                lines.push(`error          : ${formatScriptError(result.error)}`);
            }

            const outputText = lines.join('\n');
            scriptOutput.textContent = outputText;
            scriptOutput.className = result.success
                ? 'script-output px-4 pb-3 text-success whitespace-pre-wrap break-all custom-scrollbar'
                : 'script-output px-4 pb-3 text-danger whitespace-pre-wrap break-all custom-scrollbar';
            // Auto-expand collapsible output
            scriptOutput.style.display = '';
            scriptOutput.style.maxHeight = '120px';
            scriptOutput.style.overflowY = 'auto';
            if (scriptOutputChevron) scriptOutputChevron.style.transform = 'rotate(180deg)';
            if (scriptOutputLabel) {
                const lc = (outputText.match(/\n/g) || []).length + 1;
                scriptOutputLabel.textContent = (t('overrideOutputLineCount') || 'Output (@@count@@ lines)').replace('@@count@@', String(lc));
            }

            if (result.success && result.configModified) {
                showNotification(t('overrideApplied') ?? 'Override applied and config reloaded', 'success');
            }
        } catch (err) {
            scriptOutput.textContent = err instanceof Error ? err.message : String(err);
            scriptOutput.className = 'script-output px-4 pb-3 text-danger whitespace-pre-wrap break-all custom-scrollbar';
            scriptOutput.style.display = '';
            scriptOutput.style.maxHeight = '120px';
            scriptOutput.style.overflowY = 'auto';
            if (scriptOutputChevron) scriptOutputChevron.style.transform = 'rotate(180deg)';
            if (scriptOutputLabel) scriptOutputLabel.textContent = t('overrideOutput') || 'Output';
            // Resume auto test on error too
            setTimeout(() => {
                startSmartAutoTest();
            }, 1000);
        }
    });

    // ── Fullscreen editor button ──────────────────────────────────
    const fullscreenBtn = document.getElementById('plugin-script-fullscreen-btn');
    fullscreenBtn?.addEventListener('click', () => {
        openFullscreenEditor();
    });

    // ── Initialize fullscreen editor ──────────────────────────────
    initFullscreenEditor();
}

// ═══════════════════════════════════════════════════════════════════════
//  New override dropdown
// ═══════════════════════════════════════════════════════════════════════

/**
 * @param {HTMLElement} _panel
 */
function setupNewOverrideDropdown(_panel) {
    const newBtn = document.getElementById('plugin-new-btn');
    const dropdown = document.getElementById('plugin-new-dropdown');

    if (!newBtn || !dropdown) return;

    newBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        dropdown.classList.toggle('hidden');
    });

    document.addEventListener('click', () => {
        dropdown.classList.add('hidden');
    });

    dropdown.addEventListener('click', (e) => {
        e.stopPropagation();
        // Use closest() to handle clicks on nested elements (e.g., <span> inside <button>)
        const target = e.target;
        if (!(target instanceof Element)) return;
        const actionEl = target.closest('[data-action]');
        const action = actionEl instanceof HTMLElement ? actionEl.dataset.action : undefined;
        if (action === 'new-js') createNewOverride('js');
        else if (action === 'new-prism') createNewOverride('prism.yaml');
        else if (action === 'import-url') importFromUrl();
        else if (action === 'export-all') exportAllOverrides();
        else if (action === 'import-file') importFromFile();
        dropdown.classList.add('hidden');
    });
}

/**
 * @param {'js' | 'prism.yaml'} ext
 */
async function createNewOverride(ext) {
    const name = await showModal(
        t('overrideNamePrompt') ?? 'Enter override name:',
        '',
        ''
    );
    if (!name?.trim()) return;

    try {
        await overrideCreate(name.trim(), ext, 'local', null);
        showNotification(t('overrideCreated') ?? 'Override created', 'success');
        loadOverrides();
    } catch (err) {
        showNotification(String(err), 'error');
    }
}

// ═══════════════════════════════════════════════════════════════════════
//  Import from URL
// ═══════════════════════════════════════════════════════════════════════

async function importFromUrl() {
    const url = await showModal(
        t('overrideImportUrlPrompt') ?? 'Enter remote URL:',
        '',
        'https://'
    );
    if (!url?.trim()) return;

    const trimmedUrl = url.trim();
    if (!trimmedUrl.toLowerCase().startsWith('http://') && !trimmedUrl.toLowerCase().startsWith('https://')) {
        showNotification(t('overrideInvalidUrl') ?? 'Invalid URL', 'error');
        return;
    }

    // Extract filename once (strip query params / fragments) — reuse for name & ext detection
    const name = trimmedUrl.split('/').filter(Boolean).pop()?.split(/[?#]/)[0] || 'Remote Override';
    const ext = name.toLowerCase().endsWith('.yaml') || name.toLowerCase().endsWith('.yml')
        ? 'prism.yaml'
        : 'js';

    try {
        await overrideCreate(
            name,
            ext,
            'remote',
            trimmedUrl,
        );
        showNotification(t('overrideCreated') ?? 'Override created', 'success');
        loadOverrides();
    } catch (err) {
        showNotification(String(err), 'error');
    }
}

// ═══════════════════════════════════════════════════════════════════════
//  Export / Import
// ═══════════════════════════════════════════════════════════════════════

async function exportAllOverrides() {
    if (overrideItems.length === 0) {
        showNotification(t('overrideExportEmpty') ?? 'No overrides to export', 'info');
        return;
    }

    try {
        const filePath = await overrideExport();
        const fileName = filePath.split(/[/\\]/).pop() || filePath;
        const label = t('overrideExportSuccess') ?? 'Exported to: @@path@@';
        showNotification(filePath, 'success', label.replace('@@path@@', fileName));
    } catch (err) {
        showNotification(String(err), 'error');
    }
}

/**
 * Import overrides from a user-selected JSON file.
 * Reads the file, validates format, then creates each override.
 */
async function importFromFile() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';

    input.addEventListener('change', async () => {
        const file = input.files?.[0];
        if (!file) return;

        try {
            const json = await file.text();
            const count = await overrideImport(json);
            showNotification(
                (t('overrideImportSuccess') ?? 'Imported @@count@@ overrides').replace('@@count@@', String(count)),
                'success'
            );
            loadOverrides();
        } catch (err) {
            showNotification(String(err), 'error');
        }
    });

    input.click();
}

// ═══════════════════════════════════════════════════════════════════════
//  Scope Editor (subscription association)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Open a scope editor modal for the given override.
 * Lets the user toggle between "global" and "specific subscriptions".
 * @param {string} overrideId
 * @param {boolean} currentGlobal
 * @param {string[]} currentProfileIds
 */
function openScopeEditor(overrideId, currentGlobal, currentProfileIds) {
    const existing = document.getElementById('scope-editor-overlay');
    existing?.remove();

    const overlay = document.createElement('div');
    overlay.className = 'fixed inset-0 z-[var(--z-modal)] flex items-center justify-center bg-[var(--zephyr-bg-overlay)] backdrop-blur-md';
    overlay.id = 'scope-editor-overlay';
    overlay.style.background = '';

    const card = document.createElement('div');
    card.className = 'glass-card p-6 flex flex-col gap-4 min-w-[360px] max-w-[480px] max-h-[70vh] shadow-2xl';

    // Title
    const title = document.createElement('div');
    title.className = 'text-sm font-semibold text-[var(--text-primary)]';
    title.textContent = t('overrideScopeTitle') ?? 'Override Scope';

    // Global toggle
    const globalRow = document.createElement('label');
    globalRow.className = 'flex items-center gap-3 cursor-pointer';
    const globalCheck = document.createElement('input');
    globalCheck.type = 'checkbox';
    globalCheck.checked = currentGlobal;
    globalCheck.className = 'w-4 h-4 rounded accent-indigo-500';
    const globalLabel = document.createElement('span');
    globalLabel.className = 'text-sm text-[var(--text-secondary)]';
    globalLabel.textContent = t('overrideScopeGlobal') ?? 'Global (applies to all subscriptions)';
    globalRow.appendChild(globalCheck);
    globalRow.appendChild(globalLabel);

    // Profile list container
    const profileContainer = document.createElement('div');
    profileContainer.className = 'flex flex-col gap-1.5 overflow-y-auto max-h-[40vh] custom-scrollbar';

    // Fetch and render profiles
    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'bg-info hover:bg-info/80 text-white text-xs px-4 py-1.5 rounded-[var(--zephyr-radius-control)] font-medium';
    saveBtn.textContent = t('confirm') ?? 'OK';
    saveBtn.disabled = true; // Disabled until profiles are loaded

    (async () => {
        let configs = [];
        try {
            const { invoke } = await import('../api.js');
            const { COMMANDS } = await import('@zephyr/shared');
            configs = await invoke(COMMANDS.LIST_CONFIGS) ?? [];
        } catch { configs = []; }

        const profileIds = currentGlobal ? [] : (currentProfileIds || []);

        if (configs.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'text-xs text-[var(--text-muted)] py-2';
            empty.textContent = t('overrideNoProfiles') ?? 'No subscriptions found';
            profileContainer.appendChild(empty);
        }

        for (const cfg of configs) {
            const row = document.createElement('label');
            row.className = 'flex items-center gap-3 cursor-pointer px-2 py-1.5 rounded-[var(--zephyr-radius-control)] hover:bg-[var(--zephyr-bg-muted)]';
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.value = cfg.name || cfg;
            cb.checked = profileIds.includes(cb.value);
            cb.className = 'w-4 h-4 rounded accent-indigo-500 profile-scope-cb';
            cb.dataset.profileName = cb.value;
            const label = document.createElement('span');
            label.className = 'text-xs text-[var(--text-secondary)] truncate';
            label.textContent = cfg.name || cfg;
            row.appendChild(cb);
            row.appendChild(label);
            profileContainer.appendChild(row);
        }

        saveBtn.disabled = false;
    })();

    // Toggle profile container visibility based on global checkbox
    const updateVisibility = () => {
        profileContainer.style.display = globalCheck.checked ? 'none' : '';
    };
    globalCheck.addEventListener('change', updateVisibility);
    updateVisibility();

    // Auto-detect: if all profiles are checked, switch to global mode
    const checkAllSelected = () => {
        const allCbs = /** @type {HTMLInputElement[]} */ ([...profileContainer.querySelectorAll('.profile-scope-cb')]);
        if (allCbs.length === 0) return;
        const allChecked = allCbs.every(cb => cb instanceof HTMLInputElement && cb.checked);
        if (allChecked && !globalCheck.checked) {
            globalCheck.checked = true;
            updateVisibility();
        }
    };
    profileContainer.addEventListener('change', (e) => {
        if (e.target instanceof HTMLInputElement && e.target.classList.contains('profile-scope-cb')) {
            checkAllSelected();
        }
    });

    // Button row
    const btnRow = document.createElement('div');
    btnRow.className = 'flex items-center justify-end gap-2';

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'btn-ghost text-xs px-4 py-1.5 rounded-[var(--zephyr-radius-control)]';
    cancelBtn.textContent = t('cancel') ?? 'Cancel';
    cancelBtn.addEventListener('click', () => overlay.remove());

    saveBtn.addEventListener('click', async () => {
        saveBtn.disabled = true;
        cancelBtn.disabled = true;

        // Collect selected profiles; auto-upgrade to global if all are checked
        const allCbs = /** @type {HTMLInputElement[]} */ ([...profileContainer.querySelectorAll('.profile-scope-cb')]);
        const selectedProfiles = allCbs.filter(cb => cb.checked).map(cb => cb.dataset.profileName ?? '');
        const isGlobal = globalCheck.checked || selectedProfiles.length === allCbs.length;

        try {
            await overrideUpdate(overrideId, {
                global: isGlobal,
                profileIds: isGlobal ? [] : selectedProfiles,
            });
            overlay.remove();
            loadOverrides();
        } catch (err) {
            showNotification(String(err), 'error');
            overlay.remove();
        }
    });

    btnRow.appendChild(cancelBtn);
    btnRow.appendChild(saveBtn);
    card.appendChild(title);
    card.appendChild(globalRow);
    card.appendChild(profileContainer);
    card.appendChild(btnRow);
    overlay.appendChild(card);

    // Click backdrop to close
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) overlay.remove();
    });

    document.body.appendChild(overlay);
    saveBtn.focus();
}

// ═══════════════════════════════════════════════════════════════════════
//  Bulk toggle
// ═══════════════════════════════════════════════════════════════════════

/**
 * @param {boolean} enabled
 */
async function bulkToggle(enabled) {
    try {
        for (const item of overrideItems) {
            if (item.enabled !== enabled) {
                await overrideToggle(item.id, enabled);
            }
        }
        await loadOverrides();
    } catch (err) {
        showNotification(String(err), 'error');
    }
}

// ═══════════════════════════════════════════════════════════════════════
//  loadOverrides — fetch and render override list
// ═══════════════════════════════════════════════════════════════════════

async function loadOverrides() {
    const pluginList = document.getElementById('plugin-list');
    if (!pluginList) return;

    // Mouse-based drag reorder (HTML5 DnD unreliable in Tauri WebView)
    // Bind document-level listeners only once
    if (!(/** @type {Record<string, any>} */ (pluginList)._dragBound)) {
        /** @type {Record<string, any>} */ (pluginList)._dragBound = true;

        // body has transform: scale(var(--ui-scale)), so CSS pixel values
        // are scaled when rendered. getBoundingClientRect/clientY return
        // viewport pixels (already scaled). Divide by ui-scale to convert
        // viewport px → CSS px for style properties inside the scaled body.
        const getUiScale = () =>
            parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ui-scale')) || 1;

        pluginList.addEventListener('mousedown', (e) => {
            const target = e.target;
            if (!(target instanceof Element)) return;
            const card = target.closest('[data-id]');
            if (!(card instanceof HTMLElement) || e.button !== 0) return;
            // Don't start drag from buttons
            if (target.closest('button')) return;
            _dragState = { el: card, id: card.dataset.id ?? '', startY: e.clientY, moved: false };
        });

        // space-y-2 = 0.5rem = 8px (CSS pixels, not viewport pixels)
        const gap = 8;

        document.addEventListener('mousemove', (e) => {
            if (!_dragState) return;
            if (!_dragState.moved && Math.abs(e.clientY - _dragState.startY) < 5) return;

            const curIdx = _dragState.currentIndex ?? getOverrideCards(pluginList).indexOf(_dragState.el);

            // First move — create floating clone & cache card positions
            if (!_dragState.moved) {
                _dragState.moved = true;
                const uiScale = getUiScale();
                const rect = _dragState.el.getBoundingClientRect();
                // Convert viewport px → CSS px for use in style properties
                _dragState.elHeight = rect.height / uiScale;
                _dragState.offsetY = (e.clientY - rect.top) / uiScale;
                _dragState.el.style.opacity = '0';
                _dragState.el.style.pointerEvents = 'none';

                const clone = /** @type {HTMLElement} */ (_dragState.el.cloneNode(true));
                clone.style.cssText = `
                    position: fixed;
                    left: ${rect.left / uiScale}px;
                    top: ${rect.top / uiScale}px;
                    width: ${rect.width / uiScale}px;
                    pointer-events: none;
                    z-index: 1000;
                    opacity: 0.95;
                    transform: scale(1.05);
                    box-shadow: 0 20px 40px rgba(0,0,0,0.3), 0 0 0 1px rgba(124,139,160,0.2);
                    transition: transform 0.1s ease;
                `;
                document.body.appendChild(clone);
                _dragState.clone = clone;

                // Cache cards and their vertical midpoints once at drag start
                const cards = getOverrideCards(pluginList);
                const listRect = pluginList.getBoundingClientRect();
                _dragState.currentIndex = cards.indexOf(_dragState.el);
                // Midpoints stored in CSS-px space so they can be directly
                // compared with scrollTop (also CSS px) and translateY offsets.
                _dragState.cardMids = cards.map((c) => {
                    const cr = c.getBoundingClientRect();
                    return (cr.top + cr.height / 2 - listRect.top) / uiScale + pluginList.scrollTop;
                });
                _dragState.cards = cards;

                // Apply transition to all non-dragged cards once
                cards.forEach((card, i) => {
                    if (i === curIdx) return;
                    card.style.transition = 'transform 0.2s cubic-bezier(0.2, 0, 0.2, 1)';
                });
            }

            // Move clone with mouse (e.clientY is viewport px → convert to CSS px)
            if (!_dragState.clone) return;
            const uiScale = getUiScale();
            const cloneY = (e.clientY / uiScale) - (_dragState.offsetY ?? 0);
            _dragState.clone.style.top = cloneY + 'px';

            // Calculate insert position using cached midpoints
            // Convert viewport delta to CSS px, then add scrollTop (already CSS px)
            const listRect = pluginList.getBoundingClientRect();
            const relativeY = (e.clientY - listRect.top) / uiScale + pluginList.scrollTop;

            let insertAfter = -1;
            const cardMids = _dragState.cardMids ?? [];
            for (let i = 0; i < cardMids.length; i++) {
                if (i === curIdx) continue;
                if (relativeY > cardMids[i]) {
                    insertAfter = i;
                }
            }
            _dragState.targetIndex = insertAfter;

            // Animate cards to make room — only update transform (not transition)
            const elHeight = _dragState.elHeight ?? 0;
            _dragState.cards?.forEach((card, i) => {
                if (i === curIdx) return;
                let offset = 0;
                if (curIdx < i && i <= insertAfter) {
                    offset = -(elHeight + gap);
                } else if (insertAfter < i && i < curIdx) {
                    offset = elHeight + gap;
                }
                card.style.transform = `translateY(${offset}px)`;
            });
        });

        document.addEventListener('mouseup', async (e) => {
            if (!_dragState) return;
            const { el, moved, clone, cards = [] } = _dragState;
            const targetIndex = _dragState.targetIndex ?? -1;
            const currentIndex = _dragState.currentIndex ?? -1;
            _dragState = null;

            if (!moved) {
                el.style.opacity = '';
                el.style.pointerEvents = '';
                return;
            }

            e.stopImmediatePropagation();

            if (clone) {
                const insertAfter = targetIndex;
                const finalIndex = insertAfter >= currentIndex ? insertAfter : insertAfter + 1;
                const needsMove = finalIndex !== currentIndex;

                if (needsMove) {
                    // 1. Clear transforms so cards are at natural positions
                    cards.forEach(c => {
                        c.style.transition = 'none';
                        c.style.transform = '';
                    });

                    // 2. Move DOM — insert el after cards[insertAfter]
                    el.remove();
                    if (insertAfter === -1) {
                        const firstCard = cards[0];
                        if (firstCard && firstCard.parentElement) {
                            firstCard.parentElement.insertBefore(el, firstCard);
                        } else {
                            pluginList.appendChild(el);
                        }
                    } else {
                        const anchor = cards[insertAfter];
                        const parent = anchor.parentElement;
                        if (parent) {
                            const next = anchor.nextSibling;
                            if (next) {
                                parent.insertBefore(el, next);
                            } else {
                                parent.appendChild(el);
                            }
                        }
                    }

                    // 3. Force reflow before reading positions
                    void el.offsetWidth;

                    // 4. Animate clone to final position
                    // deltaY is in viewport px — convert to CSS px for
                    // the Web Animations API running inside the scaled body.
                    const uiScale = getUiScale();
                    const elFinalRect = el.getBoundingClientRect();
                    const cloneRect = clone.getBoundingClientRect();
                    const deltaY = (elFinalRect.top - cloneRect.top) / uiScale;

                    const animation = clone.animate([
                        { transform: 'translateY(0) scale(1.05)', opacity: 0.95 },
                        { transform: `translateY(${deltaY}px) scale(1)`, opacity: 1 }
                    ], {
                        duration: 150,
                        easing: 'cubic-bezier(0.25, 0.1, 0.25, 1)',
                        fill: 'forwards'
                    });

                    animation.onfinish = async () => {
                        el.style.opacity = '';
                        el.style.pointerEvents = '';
                        clone.remove();

                        // Save new order
                        const newIds = getOverrideCards(pluginList)
                            .map(c => c.dataset.id)
                            .filter(/** @param {string|undefined} id */ (id) => id !== undefined);

                        // Update in-memory order to match DOM
                        const newItems = [];
                        for (const id of newIds) {
                            const item = overrideItems.find(i => i.id === id);
                            if (item) newItems.push(item);
                        }
                        overrideItems = newItems;

                        try {
                            await overrideReorder(newIds);
                            // No need to reload — DOM already matches
                        } catch (err) {
                            showNotification(String(err), 'error');
                            // Revert: reload from backend
                            await loadOverrides();
                        }
                    };
                } else {
                    // No actual position change — snap back
                    cards.forEach(c => {
                        c.style.transition = 'none';
                        c.style.transform = '';
                    });
                    clone.remove();
                    el.style.opacity = '';
                    el.style.pointerEvents = '';
                }
            }
        });
    }

    pluginList.innerHTML = '';

    try {
        overrideItems = (await overrideList()) ?? [];
    } catch {
        overrideItems = [];
    }

    renderOverrideCards(pluginList, overrideItems, searchFilter);
}

// ═══════════════════════════════════════════════════════════════════════
//  renderOverrideCards — build card grid (with in-place diff for no flash)
// ═══════════════════════════════════════════════════════════════════════

/**
 * @param {HTMLElement} container
 * @param {import('./prism.js').OverrideItem[]} items
 * @param {string} filter
 */
function renderOverrideCards(container, items, filter) {
    const filtered = items.filter(item =>
        !filter || item.name?.toLowerCase().includes(filter)
    );

    // Empty state
    if (filtered.length === 0) {
        container.innerHTML = '';
        const empty = document.createElement('div');
        empty.className = 'text-center text-[var(--text-muted)] text-sm py-12';
        empty.textContent = filter
            ? (t('overrideNoMatch') ?? 'No overrides match your search')
            : (t('overrideEmpty') ?? 'No overrides yet. Click + to create one.');
        container.appendChild(empty);
        return;
    }

    // Get existing cards
    const existingCards = getOverrideCards(container);
    const existingIds = new Set(existingCards.map(c => c.dataset.id).filter(/** @param {string|undefined} id */ (id) => id !== undefined));
    const newIds = new Set(filtered.map(i => i.id));

    // Check if we can do in-place update (same items, just reorder or update)
    const canUpdateInPlace = existingCards.length > 0 &&
        existingCards.length === filtered.length &&
        [...existingIds].every(id => newIds.has(id));

    if (canUpdateInPlace) {
        // In-place update: just reorder and update content
        const cardMap = new Map();
        existingCards.forEach(c => cardMap.set(c.dataset.id, c));

        filtered.forEach((item) => {
            const card = cardMap.get(item.id);
            if (!card) return;

            // Update content that may have changed
            updateOverrideCardContent(card, item);
        });

        // Re-append in new order
        filtered.forEach(item => {
            const card = cardMap.get(item.id);
            if (card) container.appendChild(card);
        });
    } else {
        // Full rebuild (first render or items added/removed)
        container.innerHTML = '';
        for (const item of filtered) {
            const card = buildOverrideCard(item);
            container.appendChild(card);
        }
    }
}

/**
 * Update card content without rebuilding (prevents flash)
 * @param {HTMLElement} card
 * @param {any} item
 */
function updateOverrideCardContent(card, item) {
    // Update status indicator
    const statusDot = card.querySelector('.rounded-full[title]');
    if (statusDot instanceof HTMLElement) {
        const statusColor = !item.enabled
            ? 'bg-[var(--text-tertiary)]'
            : item.lastSuccess === false
                ? 'bg-danger'
                : 'bg-success';
        let summaryText;
        if (!item.enabled) {
            summaryText = t('overrideDisabled');
        } else if (item.lastSuccess === false) {
            summaryText = t('overrideFailed');
        } else {
            summaryText = t('overrideEnabled');
        }
        statusDot.className = `w-2 h-2 rounded-full shrink-0 ${statusColor}`;
        statusDot.title = summaryText;
    }

    // Update scope badge
    const scopeBadge = card.querySelector('[data-action="edit-scope"]');
    if (scopeBadge) {
        const scopeClass = item.global ? 'bg-success/20 text-success' : 'bg-[var(--zephyr-bg-muted)] text-[var(--text-secondary)]';
        const scopeLabel = item.global
            ? t('overrideScopeGlobal')
            : (item.profileIds?.length
                ? item.profileIds.slice(0, 2).join(', ') + (item.profileIds.length > 2 ? '…' : '')
                : t('overrideScopeNone'));
        scopeBadge.className = `text-2xs px-1.5 py-0.5 rounded-[var(--zephyr-radius-control)] ${scopeClass} cursor-pointer hover:opacity-80 transition-opacity`;
        scopeBadge.textContent = scopeLabel;
    }

    // Update status text
    const statusText = card.querySelector('[data-override-status]');
    if (statusText) {
        if (!item.enabled) {
            statusText.textContent = t('overrideDisabled');
            statusText.className = 'text-xs text-[var(--text-muted)]';
        } else if (item.lastSuccess === false) {
            statusText.textContent = t('overrideFailed');
            statusText.className = 'text-xs text-danger';
        } else {
            statusText.textContent = t('overrideEnabled');
            statusText.className = 'text-xs text-[var(--text-muted)]';
        }
    }

    // Update toggle button
    const toggleBtn = card.querySelector('.override-toggle-btn');
    if (toggleBtn instanceof HTMLElement) {
        toggleBtn.dataset.enabled = String(item.enabled);
        toggleBtn.title = item.enabled
            ? t('overrideDisable')
            : t('overrideEnable');
        // eslint-disable-next-line no-unsanitized/property -- static SVG icon
        toggleBtn.innerHTML = item.enabled
            ? `<svg class="w-3.5 h-3.5 text-success" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 14.5v-9l6 4.5-6 4.5z"/></svg>`
            : `<svg class="w-3.5 h-3.5 text-[var(--text-muted)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="10" y1="15" x2="10" y2="9"/><line x1="14" y1="15" x2="14" y2="9"/></svg>`;
    }

    // Update up/down button visibility
    const upBtn = card.querySelector('.override-up-btn');
    const downBtn = card.querySelector('.override-down-btn');
    if (upBtn) {
        upBtn.classList.toggle('invisible', isFirst(item.id));
    }
    if (downBtn) {
        downBtn.classList.toggle('invisible', isLast(item.id));
    }
}

// ═══════════════════════════════════════════════════════════════════════
//  buildOverrideCard — create a single override card
// ═══════════════════════════════════════════════════════════════════════

/**
 * @param {import('./prism.js').OverrideItem} item
 * @returns {HTMLElement}
 */
function buildOverrideCard(item) {
    const card = document.createElement('div');
    card.className = 'glass-card p-4 flex items-center justify-between group hover:translate-x-1 hover:z-10 transition-transform duration-[var(--zephyr-time-standard)] cursor-pointer';
    card.dataset.id = item.id;

    // ── Type badge color ───────────────────────────────────────
    const isJs = item.ext === 'js';
    const typeColor = isJs ? 'bg-info/20 text-info' : 'bg-download/20 text-download';
    const typeLabel = isJs ? 'JS' : 'Prism';

    // ── Scope badge ───────────────────────────────────────────
    const scopeClass = item.global ? 'bg-success/20 text-success' : 'bg-[var(--zephyr-bg-muted)] text-[var(--text-secondary)]';
    const scopeLabel = item.global
        ? t('overrideScopeGlobal')
        : (item.profileIds?.length
            ? item.profileIds.slice(0, 2).join(', ') + (item.profileIds.length > 2 ? '…' : '')
            : t('overrideScopeNone'));

    // ── Status indicator ───────────────────────────────────────
    const statusColor = !item.enabled
        ? 'bg-[var(--text-tertiary)]'
        : item.lastSuccess === false
            ? 'bg-danger'
            : 'bg-success';

    // ── Status summary line ────────────────────────────────────
    let summaryText;
    let summaryClass;
    if (!item.enabled) {
        summaryText = t('overrideDisabled');
        summaryClass = 'text-[var(--text-muted)]';
    } else if (item.lastSuccess === false) {
        summaryText = t('overrideFailed');
        summaryClass = 'text-danger';
    } else {
        summaryText = t('overrideEnabled');
        summaryClass = 'text-[var(--text-muted)]';
    }

    // eslint-disable-next-line no-unsanitized/property -- values escaped via escapeHtml()
    card.innerHTML = `
        <div class="flex items-center gap-4 flex-1 min-w-0">
            <div class="w-2 h-2 rounded-full shrink-0 ${statusColor}" title="${summaryText}"></div>
            <div class="flex flex-col gap-1 min-w-0">
                <div class="flex items-center gap-2">
                    <span class="text-sm text-[var(--text-primary)] font-medium truncate">${escapeHtml(item.name ?? '')}</span>
                    <span class="text-2xs px-1.5 py-0.5 rounded-[var(--zephyr-radius-control)] ${typeColor} shrink-0">${typeLabel}</span>
                    ${item.type === 'remote' ? '<span class="text-2xs px-1.5 py-0.5 rounded-[var(--zephyr-radius-control)] bg-info/20 text-info shrink-0">🌐</span>' : ''}
                </div>
                <div class="flex items-center gap-2">
                    <span class="text-2xs px-1.5 py-0.5 rounded-[var(--zephyr-radius-control)] ${scopeClass} cursor-pointer hover:opacity-80 transition-opacity" data-action="edit-scope">${escapeHtml(scopeLabel)}</span>
                    <span class="text-xs ${summaryClass}" data-override-status>${summaryText}</span>
                </div>
            </div>
        </div>
        <div class="flex items-center gap-2 shrink-0">
            <button class="override-toggle-btn opacity-0 group-hover:opacity-100 focus-visible:opacity-100 p-1.5 rounded-[var(--zephyr-radius-control)] hover:bg-accent/10 transition-[opacity,color]" title="${item.enabled ? (escapeAttr(t('overrideDisable') || '禁用')) : (escapeAttr(t('overrideEnable') || '启用'))}" aria-label="${item.enabled ? (escapeAttr(t('overrideDisable') || '禁用')) : (escapeAttr(t('overrideEnable') || '启用'))}" data-id="${item.id}" data-enabled="${item.enabled}">
                ${item.enabled
                    ? `<svg class="w-3.5 h-3.5 text-success" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 14.5v-9l6 4.5-6 4.5z"/></svg>`
                    : `<svg class="w-3.5 h-3.5 text-[var(--text-muted)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="10" y1="15" x2="10" y2="9"/><line x1="14" y1="15" x2="14" y2="9"/></svg>`
                }
            </button>
            <button class="override-up-btn opacity-0 group-hover:opacity-100 focus-visible:opacity-100 p-1.5 rounded-[var(--zephyr-radius-control)] text-[var(--text-muted)] hover:text-accent hover:bg-accent/10 transition-[opacity,color] ${isFirst(item.id) ? 'invisible' : ''}" title="${escapeAttr(t('overrideMoveUp') || '上移')}" aria-label="${escapeAttr(t('overrideMoveUp') || '上移')}" data-id="${item.id}">
                ${SVG_ICONS.arrowUp}
            </button>
            <button class="override-down-btn opacity-0 group-hover:opacity-100 focus-visible:opacity-100 p-1.5 rounded-[var(--zephyr-radius-control)] text-[var(--text-muted)] hover:text-accent hover:bg-accent/10 transition-[opacity,color] ${isLast(item.id) ? 'invisible' : ''}" title="${escapeAttr(t('overrideMoveDown') || '下移')}" aria-label="${escapeAttr(t('overrideMoveDown') || '下移')}" data-id="${item.id}">
                ${SVG_ICONS.arrowDown}
            </button>
            <button type="button" class="btn-delete-icon opacity-0 group-hover:opacity-100 focus-visible:opacity-100 rounded-[var(--zephyr-radius-control)]" title="${escapeAttr(t('pluginUnload') || '删除')}" aria-label="${escapeAttr(t('pluginUnload') || '删除')}" data-action="delete">
                ${SVG_ICONS.trash}
            </button>
        </div>
    `;

    // ── Click: card body → edit ─────────────────────────────────
    card.addEventListener('click', () => {
        openEditor(item.id, item.name ?? '', item.ext ?? 'js');
    });

    // ── Click: delete ──────────────────────────────────────────
    card.querySelector('[data-action="delete"]')?.addEventListener('click', (e) => {
        e.stopPropagation();
        showDeleteConfirm(item.id, item.name ?? '');
    });

    // ── Reorder buttons ────────────────────────────────────────
    card.querySelector('.override-up-btn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        reorderItem(item.id, -1);
    });
    card.querySelector('.override-down-btn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        reorderItem(item.id, 1);
    });

    // ── Inline toggle button ─────────────────────────────────
    card.querySelector('.override-toggle-btn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleOverride(item.id, !item.enabled);
    });

    // ── Inline toggle: click status dot ───────────────────────
    card.querySelector('.rounded-full')?.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleOverride(item.id, !item.enabled);
    });

    // ── Click: scope badge → edit scope ───────────────────────
    card.querySelector('[data-action="edit-scope"]')?.addEventListener('click', (e) => {
        e.stopPropagation();
        openScopeEditor(item.id, item.global ?? false, item.profileIds || []);
    });

    return card;
}

// ═══════════════════════════════════════════════════════════════════════
//  Editor
// ═══════════════════════════════════════════════════════════════════════

/**
 * @param {string} id
 * @param {string} name
 * @param {string} ext
 */
async function openEditor(id, name, ext) {
    const pluginList = document.getElementById('plugin-list');
    const scriptArea = document.getElementById('plugin-script-area');
    const scriptCm6 = document.getElementById('plugin-script-cm6');
    const scriptTitle = document.getElementById('plugin-script-title');
    const scriptOutput = document.getElementById('plugin-script-output');
    const scriptStatus = document.getElementById('plugin-script-status');
    const scriptOutputChevron = document.getElementById('plugin-script-output-chevron');
    const scriptOutputLabel = document.getElementById('plugin-script-output-label');

    if (!pluginList || !scriptArea) return;

    activeOverrideId = id;
    activeOverrideName = name;
    activeOverrideExt = ext;

    // Show editor
    pluginList.classList.add('hidden');
    scriptArea.classList.remove('hidden');

    if (scriptTitle) scriptTitle.textContent = name;
    if (scriptOutput) {
        scriptOutput.textContent = '';
        scriptOutput.style.display = 'none';
        scriptOutput.className = 'script-output px-4 pb-3 text-[var(--text-secondary)] whitespace-pre-wrap break-all custom-scrollbar';
    }
    if (scriptStatus) {
        scriptStatus.textContent = '';
        scriptStatus.className = 'text-xs text-[var(--text-secondary)]';
    }
    if (scriptOutputChevron) scriptOutputChevron.style.transform = '';
    if (scriptOutputLabel) scriptOutputLabel.textContent = t('overrideOutput') || 'Output';

    // Load content
    let content = '';
    try {
        content = await overrideGetContent(id);
    } catch {
        content = '';
    }

    // Build CM6 editor
    if (scriptEditorView) { scriptEditorView.destroy(); scriptEditorView = null; }
    if (scriptCm6) {
        scriptCm6.innerHTML = '';
        scriptEditorView = createEditor({
            parent: scriptCm6,
            content: content || '',
            language: ext === 'js' ? 'javascript' : 'yaml',
            prismDsl: ext !== 'js',
        });
    }
}

// ═══════════════════════════════════════════════════════════════════════
//  Toggle
// ═══════════════════════════════════════════════════════════════════════

/**
 * @param {string} id
 * @param {boolean} enabled
 */
async function toggleOverride(id, enabled) {
    // Update in memory first for instant UI feedback
    const item = overrideItems.find(i => i.id === id);
    if (!item) return;

    const oldEnabled = item.enabled;
    item.enabled = enabled;

    // Update UI immediately
    const pluginList = document.getElementById('plugin-list');
    if (pluginList) renderOverrideCards(pluginList, overrideItems, searchFilter);

    try {
        await overrideToggle(id, enabled);
    } catch (err) {
        // Revert on error
        item.enabled = oldEnabled;
        if (pluginList) renderOverrideCards(pluginList, overrideItems, searchFilter);
        showNotification(String(err), 'error');
    }
}

// ═══════════════════════════════════════════════════════════════════════
//  Reorder
// ═══════════════════════════════════════════════════════════════════════

/**
 * @param {string} id
 * @param {number} direction
 */
async function reorderItem(id, direction) {
    const idx = overrideItems.findIndex(i => i.id === id);
    if (idx < 0) return;

    const newIdx = idx + direction;
    if (newIdx < 0 || newIdx >= overrideItems.length) return;

    // Swap in memory first for instant UI feedback (no flash)
    const newItems = [...overrideItems];
    [newItems[idx], newItems[newIdx]] = [newItems[newIdx], newItems[idx]];
    overrideItems = newItems;

    // Update UI immediately without full reload
    const pluginList = document.getElementById('plugin-list');
    if (pluginList) renderOverrideCards(pluginList, overrideItems, searchFilter);

    // Persist the NEW order to backend
    try {
        await overrideReorder(overrideItems.map(i => i.id));
    } catch (err) {
        // Revert on error
        [overrideItems[idx], overrideItems[newIdx]] = [overrideItems[newIdx], overrideItems[idx]];
        if (pluginList) renderOverrideCards(pluginList, overrideItems, searchFilter);
        showNotification(String(err), 'error');
    }
}

/**
 * @param {string} id
 */
function isFirst(id) {
    return overrideItems[0]?.id === id;
}

/**
 * @param {string} id
 */
function isLast(id) {
    return overrideItems[overrideItems.length - 1]?.id === id;
}

// ═══════════════════════════════════════════════════════════════════════
//  Delete confirm
// ═══════════════════════════════════════════════════════════════════════

/**
 * @param {string} overrideId
 * @param {string} overrideName
 */
function showDeleteConfirm(overrideId, overrideName) {
    const existing = document.getElementById('plugin-unload-confirm');
    existing?.remove();

    const overlay = document.createElement('div');
    overlay.className = 'fixed inset-0 z-[var(--z-modal)] flex items-center justify-center bg-[var(--zephyr-bg-overlay)] backdrop-blur-md';
    overlay.id = 'plugin-unload-confirm';
    overlay.style.background = '';

    const card = document.createElement('div');
    card.className = 'glass-card p-6 flex flex-col gap-4 min-w-[320px] max-w-[420px] shadow-2xl';

    const title = document.createElement('div');
    title.className = 'text-sm font-semibold text-[var(--text-primary)]';
    title.textContent = (t('overrideDeleteConfirmTitle') ?? 'Delete override "@@name@@"?').replace('@@name@@', overrideName);

    const msg = document.createElement('div');
    msg.className = 'text-xs text-[var(--text-secondary)]';
    msg.textContent = t('overrideDeleteConfirmMsg') ?? 'This action cannot be undone. The override script and execution logs will be deleted.';

    const btnRow = document.createElement('div');
    btnRow.className = 'flex items-center justify-end gap-2';

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'btn-ghost text-xs px-4 py-1.5 rounded-[var(--zephyr-radius-control)]';
    cancelBtn.textContent = t('cancel') ?? '取消';
    cancelBtn.addEventListener('click', () => overlay.remove());

    const confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.className = 'bg-danger hover:bg-danger/80 text-white text-xs px-4 py-1.5 rounded-[var(--zephyr-radius-control)] font-medium';
    confirmBtn.textContent = t('confirm') ?? '确认';
    confirmBtn.addEventListener('click', async () => {
        confirmBtn.disabled = true;
        cancelBtn.disabled = true;
        try {
            await overrideDelete(overrideId);
            overlay.remove();
            loadOverrides();
        } catch (err) {
            showNotification(String(err), 'error');
            overlay.remove();
        }
    });

    btnRow.appendChild(cancelBtn);
    btnRow.appendChild(confirmBtn);
    card.appendChild(title);
    card.appendChild(msg);
    card.appendChild(btnRow);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    confirmBtn.focus();
}

// ═══════════════════════════════════════════════════════════════════════
//  Fullscreen Editor
// ═══════════════════════════════════════════════════════════════════════

/**
 * Initialize fullscreen editor event listeners.
 */
function initFullscreenEditor() {
    const closeBtn = document.getElementById('fullscreen-editor-close-btn');
    const validateBtn = document.getElementById('fullscreen-editor-validate-btn');
    const runBtn = document.getElementById('fullscreen-editor-run-btn');
    const clearOutputBtn = document.getElementById('fullscreen-editor-clear-output-btn');
    const copyOutputBtn = document.getElementById('fullscreen-editor-copy-output-btn');
    const overlay = document.getElementById('fullscreen-editor-overlay');

    closeBtn?.addEventListener('click', closeFullscreenEditor);
    validateBtn?.addEventListener('click', validateFullscreenEditor);
    runBtn?.addEventListener('click', runFullscreenEditor);
    clearOutputBtn?.addEventListener('click', clearFullscreenOutput);
    copyOutputBtn?.addEventListener('click', copyFullscreenOutput);

    // Close on backdrop click
    overlay?.addEventListener('click', (e) => {
        if (e.target === overlay) {
            closeFullscreenEditor();
        }
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
        if (!isFullscreenEditorOpen) return;
        // ESC to close
        if (e.key === 'Escape') {
            closeFullscreenEditor();
        }
        // Ctrl/Cmd + Enter to run
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            runFullscreenEditor();
        }
    });

    // Initialize resizer
    initResizer();
}

/**
 * Open fullscreen editor with current override content.
 */
function openFullscreenEditor() {
    if (!activeOverrideId || !scriptEditorView) return;

    const overlay = document.getElementById('fullscreen-editor-overlay');
    const _container = document.getElementById('fullscreen-editor-container');
    const cm6Container = document.getElementById('fullscreen-editor-cm6');
    const title = document.getElementById('fullscreen-editor-title');
    const typeBadge = document.getElementById('fullscreen-editor-type-badge');

    if (!overlay || !cm6Container) return;

    // Get current content from small editor
    const content = getEditorContent(scriptEditorView);

    // Show overlay with animation
    overlay.classList.remove('hidden');
    // Trigger reflow
    void overlay.offsetWidth;
    overlay.classList.remove('opacity-0', 'pointer-events-none');
    overlay.querySelector('#fullscreen-editor-container')?.classList.remove('scale-95');
    isFullscreenEditorOpen = true;

    // Update title
    if (title) title.textContent = activeOverrideName || (t('overrideEditScript') || 'Edit Script');

    // Update type badge
    const isJs = activeOverrideExt === 'js';
    if (typeBadge) {
        typeBadge.textContent = isJs ? 'JS' : 'Prism';
        typeBadge.className = `text-2xs px-2 py-0.5 rounded-[var(--zephyr-radius-control)] ${isJs ? 'bg-info/20 text-info' : 'bg-download/20 text-download'}`;
    }

    // Create fullscreen editor
    if (fullscreenEditorView) {
        fullscreenEditorView.destroy();
        fullscreenEditorView = null;
    }

    cm6Container.innerHTML = '';
    fullscreenEditorView = createEditor({
        parent: cm6Container,
        content: content,
        language: isJs ? 'javascript' : 'yaml',
        prismDsl: !isJs,
    });

    // Setup cursor position update
    setupFullscreenEditorStatus();

    // Focus editor
    /** @type {{focus: function(): void}} */ (/** @type {unknown} */ (fullscreenEditorView)).focus();

    // Clear output
    clearFullscreenOutput();
}

/**
 * Close fullscreen editor and sync content back to small editor.
 */
function closeFullscreenEditor() {
    if (!isFullscreenEditorOpen) return;

    const overlay = document.getElementById('fullscreen-editor-overlay');
    const container = document.getElementById('fullscreen-editor-container');

    // Animate out
    overlay?.classList.add('opacity-0', 'pointer-events-none');
    container?.classList.add('scale-95');

    // Wait for animation to finish before hiding
    setTimeout(() => {
        // Sync content back to small editor if it exists
        if (fullscreenEditorView && scriptEditorView) {
            const content = getEditorContent(fullscreenEditorView);
            // Update small editor content
            const scriptCm6 = document.getElementById('plugin-script-cm6');
            if (scriptCm6) {
                scriptCm6.innerHTML = '';
                scriptEditorView.destroy();
                scriptEditorView = createEditor({
                    parent: scriptCm6,
                    content: content,
                    language: activeOverrideExt === 'js' ? 'javascript' : 'yaml',
                    prismDsl: activeOverrideExt !== 'js',
                });
            }
        }

        // Destroy fullscreen editor
        if (fullscreenEditorView) {
            fullscreenEditorView.destroy();
            fullscreenEditorView = null;
        }

        // Hide overlay
        overlay?.classList.add('hidden');
        isFullscreenEditorOpen = false;
    }, 300);
}

/**
 * Validate script in fullscreen editor.
 */
async function validateFullscreenEditor() {
    if (!fullscreenEditorView) return;

    const status = document.getElementById('fullscreen-editor-status');
    const source = getEditorContent(fullscreenEditorView).trim();

    if (!source) return;

    if (status) {
        status.textContent = t('overrideValidating') ?? 'Validating...';
        status.className = 'text-[var(--text-secondary)]';
    }

    try {
        const result = await overrideSetContent(activeOverrideId, source, true);
        if (result.success) {
            if (status) {
                status.textContent = t('overrideScriptSafe') ?? '✓ Script safe';
                status.className = 'text-success';
            }
        } else {
            if (status) {
                status.textContent = '✗ ' + (formatScriptError(result.error) ?? (t('overrideScriptUnsafe') ?? 'Script may be unsafe'));
                status.className = 'text-danger';
            }
        }
    } catch (err) {
        if (status) {
            status.textContent = '✗ ' + (err instanceof Error ? err.message : String(err));
            status.className = 'text-danger';
        }
    }
}

/**
 * Run script in fullscreen editor.
 */
async function runFullscreenEditor() {
    if (!fullscreenEditorView || !activeOverrideId) return;

    const output = document.getElementById('fullscreen-editor-output');
    const status = document.getElementById('fullscreen-editor-status');
    const source = getEditorContent(fullscreenEditorView).trim();

    if (!source) return;

    if (output) {
        // eslint-disable-next-line no-unsanitized/property -- i18n translation keys
        output.innerHTML = '<div class="text-[var(--text-muted)]">' + (t('overrideExecuting') ?? 'Executing...') + '</div>';
    }

    stopSmartAutoTest();

    try {
        const result = await overrideSetContent(activeOverrideId, source, false);

        // Invalidate caches so renderProxies fetches fresh data
        const { invalidateProxiesCache, invalidateConfigCache } = await import('./cache.js');
        invalidateProxiesCache();
        invalidateConfigCache();

        // Wait for Mihomo to finish reloading, then refresh proxies page
        setTimeout(() => {
            startSmartAutoTest();
            renderProxies();
        }, 1000);

        const lines = [];
        if (result.logs?.length) {
            lines.push('── logs ──────────────────────');
            for (const log of result.logs) {
                lines.push(`[${log.level ?? 'Info'}] ${log.message}`);
            }
            lines.push('');
        }

        lines.push('── result ───────────────────');
        lines.push(`success        : ${result.success}`);
        lines.push(`configModified : ${result.configModified}`);
        lines.push(`duration       : ${result.durationUs ?? 0} µs`);
        if (result.error) {
            lines.push(`error          : ${formatScriptError(result.error)}`);
        }

        const outputText = lines.join('\n');

        if (output) {
            output.textContent = outputText;
            output.className = `flex-1 p-4 text-sm font-mono whitespace-pre-wrap break-all overflow-y-auto custom-scrollbar ${result.success ? 'text-success' : 'text-danger'}`;
        }

        if (status) {
            status.textContent = result.success
                ? (t('overrideExecSuccess') ?? '✓ Execution successful')
                : (t('overrideExecFailed') ?? '✗ Execution failed');
            status.className = result.success ? 'text-success' : 'text-danger';
        }

        if (result.success && result.configModified) {
            showNotification(t('overrideApplied') ?? 'Overrides applied, config reloaded', 'success');
        }
    } catch (err) {
        const errorText = err instanceof Error ? err.message : String(err);
        if (output) {
            output.textContent = errorText;
            output.className = 'flex-1 p-4 text-sm font-mono text-danger whitespace-pre-wrap break-all overflow-y-auto custom-scrollbar';
        }
        if (status) {
            status.textContent = `✗ ${errorText}`;
            status.className = 'text-danger';
        }
        setTimeout(() => {
            startSmartAutoTest();
        }, 1000);
    }
}

/**
 * Clear fullscreen editor output.
 */
function clearFullscreenOutput() {
    const output = document.getElementById('fullscreen-editor-output');
    if (output) {
        // eslint-disable-next-line no-unsanitized/property -- i18n translation keys
        output.innerHTML = '<div class="text-[var(--text-tertiary)] italic">' + (t('overrideOutputPlaceholder') ?? 'Click "Save & Run" to see output...') + '</div>';
        output.className = 'flex-1 p-4 text-sm font-mono text-[var(--text-secondary)] whitespace-pre-wrap break-all overflow-y-auto custom-scrollbar';
    }
}

/**
 * Convert script error line numbers to user-friendly format.
 * The wrapper script adds ~23 lines of preamble before user script.
 * @param {string|null} error
 * @returns {string|null}
 */
function formatScriptError(error) {
    if (!error) return error;
    
    // Wrapper script preamble lines:
    // - build_wrapper_script: ~22 lines
    // - write-back logic: ~16 lines (before user script starts)
    // Total offset: ~23 lines (1-indexed)
    const WRAPPER_OFFSET = 23;
    
    // Replace eval_script:LINE:COL with user-friendly line numbers
    return error.replace(/eval_script:(\d+):(\d+)/g, (match, line, col) => {
        const lineNum = parseInt(line, 10);
        const colNum = parseInt(col, 10);
        const userLine = lineNum - WRAPPER_OFFSET;
        
        if (userLine > 0) {
            return ((t('overrideScriptLine') ?? 'Script line @@line@@, column @@col@@')
                .replace('@@line@@', String(userLine))
                .replace('@@col@@', String(colNum)));
        }
        // If line is within wrapper, just show original with note
        return ((t('overrideEngineInternal') ?? 'Engine internal (eval_script:@@line@@:@@col@@)')
            .replace('@@line@@', String(lineNum))
            .replace('@@col@@', String(colNum)));
    });
}

/**
 * Copy fullscreen editor output to clipboard.
 */
function copyFullscreenOutput() {
    const output = document.getElementById('fullscreen-editor-output');
    const copyBtn = document.getElementById('fullscreen-editor-copy-output-btn');
    if (!output) return;

    const text = output.textContent || output.innerText || '';
    if (!text.trim()) return;

    navigator.clipboard.writeText(text).then(() => {
        if (copyBtn) {
            const originalText = copyBtn.textContent;
            copyBtn.textContent = t('overrideCopied') || 'Copied';
            copyBtn.style.color = 'var(--accent-primary, #6366f1)';
            setTimeout(() => {
                copyBtn.textContent = originalText;
                copyBtn.style.color = '';
            }, 1500);
        }
    }).catch(() => {
        // Fallback for environments without clipboard API
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        try {
            document.execCommand('copy');
            if (copyBtn) {
                const originalText = copyBtn.textContent;
                copyBtn.textContent = t('overrideCopied') || 'Copied';
                copyBtn.style.color = 'var(--accent-primary, #6366f1)';
                setTimeout(() => {
                    copyBtn.textContent = originalText;
                    copyBtn.style.color = '';
                }, 1500);
            }
        } catch (_e) {
            // silently fail
        }
        document.body.removeChild(textarea);
    });
}

/**
 * Setup fullscreen editor status bar updates.
 * Uses CodeMirror's updateListener extension for efficient, event-driven updates
 * instead of polling with setInterval.
 */
function setupFullscreenEditorStatus() {
    if (!fullscreenEditorView) return;

    const cursorPos = document.getElementById('fullscreen-editor-cursor-pos');
    const charCount = document.getElementById('fullscreen-editor-char-count');

    // Inject an updateListener extension into the existing editor
    const listener = EditorView.updateListener.of((/** @type {import('../cm6.bundle.js').ViewUpdate} */ update) => {
        if (!update.selectionSet && !update.docChanged) return;

        // Update cursor position
        if (cursorPos && update.selectionSet) {
            const pos = update.state.selection.main.head;
            const line = update.state.doc.lineAt(pos);
            cursorPos.textContent = (t('overrideLineCol') ?? 'Line @@line@@, Col @@col@@')
                .replace('@@line@@', String(line.number))
                .replace('@@col@@', String(pos - line.from + 1));
        }

        // Update character count
        if (charCount && update.docChanged) {
            charCount.textContent = (t('overrideCharCount') ?? '@@count@@ chars')
                .replace('@@count@@', String(update.state.doc.length));
        }
    });

    fullscreenEditorView.dispatch({
        effects: StateEffect.appendConfig.of([listener]),
    });
}

/**
 * Initialize resizer for dragging between editor and output panel.
 */
function initResizer() {
    const resizer = document.getElementById('fullscreen-editor-resizer');
    const mainPanel = document.getElementById('fullscreen-editor-main');
    const sidebar = document.getElementById('fullscreen-editor-sidebar');

    if (!resizer || !mainPanel || !sidebar) return;

    let isResizing = false;

    resizer.addEventListener('mousedown', (e) => {
        isResizing = true;
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
        e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
        if (!isResizing) return;

        const container = document.getElementById('fullscreen-editor-container');
        if (!container) return;

        const containerRect = container.getBoundingClientRect();
        const offsetX = e.clientX - containerRect.left;
        const sidebarWidth = containerRect.width - offsetX;

        // Clamp sidebar width
        const minWidth = 200;
        const maxWidth = Math.min(600, containerRect.width - 400);
        const newWidth = Math.max(minWidth, Math.min(maxWidth, sidebarWidth));

        sidebar.style.flexBasis = `${newWidth}px`;
        mainPanel.style.flexBasis = `calc(100% - ${newWidth}px - 6px)`;

        // Refresh CodeMirror
        if (fullscreenEditorView) {
            fullscreenEditorView.requestMeasure();
        }
    });

    document.addEventListener('mouseup', () => {
        if (isResizing) {
            isResizing = false;
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
        }
    });
}

// ═══════════════════════════════════════════════════════════════════════
//  Utilities
// ═══════════════════════════════════════════════════════════════════════

/**
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
