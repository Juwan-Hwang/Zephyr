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
    // eslint-disable-next-line no-unused-vars
    overrideUpdate,
    overrideDelete,
    overrideGetContent,
    overrideSetContent,
    overrideReorder,
    overrideToggle,
    // eslint-disable-next-line no-unused-vars
    overrideTest,
    // eslint-disable-next-line no-unused-vars
    overrideRefreshRemote,
    // eslint-disable-next-line no-unused-vars
    overrideApplyAll,
} from './prism.js';
import { SVG_ICONS } from './icons.js';
import { stopSmartAutoTest, startSmartAutoTest, renderProxies } from './proxies.js';
import { t } from '../i18n.js';
import { showNotification, showModal } from './notifications.js';
import { createEditor, getEditorContent } from './editor/prism-editor.js';
import { escapeAttr } from '../utils/sanitize.js';

// ═══════════════════════════════════════════════════════════════════════
//  Internal state
// ═══════════════════════════════════════════════════════════════════════

/** Currently active override ID being edited. */
let activeOverrideId = '';

/** Currently active override name (for editor title). */
let activeOverrideName = '';

/** Current override items list (for reorder). */
let overrideItems = [];

/** CodeMirror EditorView for the override script editor (null when not active). */
let scriptEditorView = null;

/** CodeMirror EditorView for the fullscreen editor (null when not active). */
let fullscreenEditorView = null;

/** Search filter string. */
let searchFilter = '';

/** Current active override extension for fullscreen editor. */
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
    // eslint-disable-next-line no-unused-vars
    const scriptCm6 = document.getElementById('plugin-script-cm6');
    const scriptOutput = document.getElementById('plugin-script-output');
    const scriptOutputToggle = document.getElementById('plugin-script-output-toggle');
    const scriptOutputLabel = document.getElementById('plugin-script-output-label');
    const scriptOutputChevron = document.getElementById('plugin-script-output-chevron');
    // ── Script output collapsible ────────────────────────────
    scriptOutputToggle?.addEventListener('click', () => {
        const isHidden = scriptOutput.style.display === 'none';
        scriptOutput.style.display = isHidden ? '' : 'none';
        if (scriptOutputChevron) {
            scriptOutputChevron.style.transform = isHidden ? 'rotate(180deg)' : '';
        }
        if (isHidden && scriptOutputLabel) {
            const lineCount = (scriptOutput.textContent?.match(/\n/g) || []).length + 1;
            scriptOutputLabel.textContent = `输出 (${lineCount} 行)`;
        }
    });
    // eslint-disable-next-line no-unused-vars
    const scriptTitle = document.getElementById('plugin-script-title');
    const scriptRunBtn = document.getElementById('plugin-script-run-btn');
    const scriptValidateBtn = document.getElementById('plugin-script-validate-btn');
    const scriptStatus = document.getElementById('plugin-script-status');
    const scriptBackBtn = document.getElementById('plugin-script-back-btn');

    if (!panel) return;

    // ── Panel open / close ──────────────────────────────────────────
    openBtn?.addEventListener('click', () => {
        panel.classList.remove('hidden');
        loadOverrides();
    });

    const closePanel = () => panel.classList.add('hidden');

    closeBtn?.addEventListener('click', closePanel);
    backdrop?.addEventListener('click', closePanel);

    // ── Header: search ──────────────────────────────────────────────
    const searchInput = document.getElementById('plugin-search-input');
    searchInput?.addEventListener('input', (e) => {
        searchFilter = e.target.value?.toLowerCase() ?? '';
        renderOverrideCards(pluginList, overrideItems, searchFilter);
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
        const source = (scriptEditorView ? getEditorContent(scriptEditorView) : (scriptEditor?.value ?? '')).trim();
        if (!source) return;

        scriptStatus.textContent = t('pluginValidating') ?? 'Validating...';
        scriptStatus.className = 'text-xs text-zinc-400';

        try {
            // Use overrideSetContent with dry_run for validation
            const result = await overrideSetContent(activeOverrideId, source, true);
            if (result.success) {
                scriptStatus.textContent = t('pluginScriptSafe') ?? 'Script is safe';
                scriptStatus.className = 'text-xs text-emerald-400';
            } else {
                scriptStatus.textContent = formatScriptError(result.error) ?? (t('pluginScriptUnsafe') ?? 'Script may be unsafe');
                scriptStatus.className = 'text-xs text-rose-400';
            }
        } catch (err) {
            scriptStatus.textContent = (err instanceof Error ? err.message : String(err));
            scriptStatus.className = 'text-xs text-rose-400';
        }
    });

    // ── Script run (save + execute) ──────────────────────────────
    scriptRunBtn?.addEventListener('click', async () => {
        if (!scriptOutput || !activeOverrideId) return;
        const source = (scriptEditorView ? getEditorContent(scriptEditorView) : (scriptEditor?.value ?? '')).trim();
        if (!source) return;

        scriptOutput.textContent = '';
        scriptOutput.className = 'text-xs text-zinc-400 font-mono whitespace-pre-wrap break-all';

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
                ? 'script-output px-4 pb-3 text-emerald-400 whitespace-pre-wrap break-all custom-scrollbar'
                : 'script-output px-4 pb-3 text-rose-400 whitespace-pre-wrap break-all custom-scrollbar';
            // Auto-expand collapsible output
            scriptOutput.style.display = '';
            scriptOutput.style.maxHeight = '120px';
            scriptOutput.style.overflowY = 'auto';
            if (scriptOutputChevron) scriptOutputChevron.style.transform = 'rotate(180deg)';
            if (scriptOutputLabel) {
                const lc = (outputText.match(/\n/g) || []).length + 1;
                scriptOutputLabel.textContent = `输出 (${lc} 行)`;
            }

            if (result.success && result.configModified) {
                showNotification(t('overrideApplied') ?? 'Override applied and config reloaded', 'success');
            }
        } catch (err) {
            scriptOutput.textContent = err instanceof Error ? err.message : String(err);
            scriptOutput.className = 'script-output px-4 pb-3 text-rose-400 whitespace-pre-wrap break-all custom-scrollbar';
            scriptOutput.style.display = '';
            scriptOutput.style.maxHeight = '120px';
            scriptOutput.style.overflowY = 'auto';
            if (scriptOutputChevron) scriptOutputChevron.style.transform = 'rotate(180deg)';
            if (scriptOutputLabel) scriptOutputLabel.textContent = '输出';
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

// eslint-disable-next-line no-unused-vars
function setupNewOverrideDropdown(panel) {
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
        const action = e.target.dataset.action;
        if (action === 'new-js') createNewOverride('js');
        else if (action === 'new-prism') createNewOverride('prism.yaml');
        dropdown.classList.add('hidden');
    });
}

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
//  Bulk toggle
// ═══════════════════════════════════════════════════════════════════════

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

    pluginList.innerHTML = '';

    try {
        overrideItems = (await overrideList()) ?? [];
    } catch {
        overrideItems = [];
    }

    renderOverrideCards(pluginList, overrideItems, searchFilter);
}

// ═══════════════════════════════════════════════════════════════════════
//  renderOverrideCards — build card grid
// ═══════════════════════════════════════════════════════════════════════

function renderOverrideCards(container, items, filter) {
    container.innerHTML = '';

    const filtered = items.filter(item =>
        !filter || item.name?.toLowerCase().includes(filter)
    );

    if (filtered.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'text-center text-zinc-500 text-sm py-12';
        empty.textContent = filter
            ? (t('overrideNoMatch') ?? 'No overrides match your search')
            : (t('overrideEmpty') ?? 'No overrides yet. Click + to create one.');
        container.appendChild(empty);
        return;
    }

    for (const item of filtered) {
        const card = buildOverrideCard(item);
        container.appendChild(card);
    }
}

// ═══════════════════════════════════════════════════════════════════════
//  buildOverrideCard — create a single override card
// ═══════════════════════════════════════════════════════════════════════

function buildOverrideCard(item) {
    const card = document.createElement('div');
    card.className = 'glass-card p-4 flex items-center justify-between group hover:translate-x-1 hover:z-10 transition-transform duration-300 cursor-pointer';
    card.dataset.id = item.id;

    // ── Type badge color ───────────────────────────────────────
    const isJs = item.ext === 'js';
    const typeColor = isJs ? 'bg-blue-500/20 text-blue-400' : 'bg-purple-500/20 text-purple-400';
    const typeLabel = isJs ? 'JS' : 'Prism';

    // ── Scope badge ───────────────────────────────────────────
    const scopeClass = item.global ? 'bg-emerald-500/20 text-emerald-400' : 'bg-zinc-500/20 text-zinc-400';
    const scopeLabel = item.global
        ? (t('overrideScopeGlobal') ?? '全局')
        : (item.profileIds?.length
            ? item.profileIds.slice(0, 2).join(', ') + (item.profileIds.length > 2 ? '…' : '')
            : (t('overrideScopeNone') ?? '无'));

    // ── Status indicator ───────────────────────────────────────
    const statusColor = item.enabled
        ? 'bg-emerald-400'
        : 'bg-zinc-600';

    // ── Status summary line ────────────────────────────────────
    const summaryText = item.enabled
        ? (t('overrideEnabled') ?? '● 已启用')
        : (t('overrideDisabled') ?? '○ 已禁用');

    card.innerHTML = `
        <div class="flex items-center gap-4 flex-1 min-w-0">
            <div class="w-2 h-2 rounded-full shrink-0 ${statusColor}" title="${summaryText}"></div>
            <div class="flex flex-col gap-1 min-w-0">
                <div class="flex items-center gap-2">
                    <span class="text-sm text-zinc-200 font-medium truncate">${escapeHtml(item.name ?? '')}</span>
                    <span class="text-2xs px-1.5 py-0.5 rounded ${typeColor} shrink-0">${typeLabel}</span>
                    ${item.type === 'remote' ? '<span class="text-2xs px-1.5 py-0.5 rounded bg-sky-500/20 text-sky-400 shrink-0">🌐</span>' : ''}
                </div>
                <div class="flex items-center gap-2">
                    <span class="text-2xs px-1.5 py-0.5 rounded ${scopeClass}">${escapeHtml(scopeLabel)}</span>
                    <span class="text-xs text-zinc-500">${summaryText}</span>
                </div>
            </div>
        </div>
        <div class="flex items-center gap-2 shrink-0">
            <button class="override-toggle-btn opacity-0 group-hover:opacity-100 p-1.5 rounded-lg hover:bg-accent/10 transition-all" title="${item.enabled ? (escapeAttr(t('overrideDisable') || '禁用')) : (escapeAttr(t('overrideEnable') || '启用'))}" data-id="${item.id}" data-enabled="${item.enabled}">
                ${item.enabled
                    ? `<svg class="w-3.5 h-3.5 text-emerald-400" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 14.5v-9l6 4.5-6 4.5z"/></svg>`
                    : `<svg class="w-3.5 h-3.5 text-zinc-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="10" y1="15" x2="10" y2="9"/><line x1="14" y1="15" x2="14" y2="9"/></svg>`
                }
            </button>
            <button class="override-up-btn opacity-0 group-hover:opacity-100 p-1.5 rounded-lg text-zinc-500 hover:text-accent hover:bg-accent/10 transition-all ${isFirst(item.id) ? 'invisible' : ''}" title="${escapeAttr(t('overrideMoveUp') || '上移')}" data-id="${item.id}">
                ${SVG_ICONS.arrowUp}
            </button>
            <button class="override-down-btn opacity-0 group-hover:opacity-100 p-1.5 rounded-lg text-zinc-500 hover:text-accent hover:bg-accent/10 transition-all ${isLast(item.id) ? 'invisible' : ''}" title="${escapeAttr(t('overrideMoveDown') || '下移')}" data-id="${item.id}">
                ${SVG_ICONS.arrowDown}
            </button>
            <button class="btn-delete-icon opacity-0 group-hover:opacity-100" title="${escapeAttr(t('pluginUnload') || '删除')}" data-action="delete">
                ${SVG_ICONS.trash}
            </button>
        </div>
    `;

    // ── Click: card body → edit ─────────────────────────────────
    card.addEventListener('click', () => {
        openEditor(item.id, item.name ?? '', item.ext);
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

    return card;
}

// ═══════════════════════════════════════════════════════════════════════
//  Editor
// ═══════════════════════════════════════════════════════════════════════

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
        scriptOutput.className = 'script-output px-4 pb-3 text-zinc-400 whitespace-pre-wrap break-all custom-scrollbar';
    }
    if (scriptStatus) {
        scriptStatus.textContent = '';
        scriptStatus.className = 'text-xs text-zinc-400';
    }
    if (scriptOutputChevron) scriptOutputChevron.style.transform = '';
    if (scriptOutputLabel) scriptOutputLabel.textContent = '输出';

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

async function toggleOverride(id, enabled) {
    try {
        await overrideToggle(id, enabled);
        await loadOverrides();
    } catch (err) {
        showNotification(String(err), 'error');
    }
}

// ═══════════════════════════════════════════════════════════════════════
//  Reorder
// ═══════════════════════════════════════════════════════════════════════

async function reorderItem(id, direction) {
    const ids = overrideItems.map(i => i.id);
    const idx = ids.indexOf(id);
    if (idx < 0) return;

    const newIdx = idx + direction;
    if (newIdx < 0 || newIdx >= ids.length) return;

    // Swap
    [ids[idx], ids[newIdx]] = [ids[newIdx], ids[idx]];

    try {
        await overrideReorder(ids);
        await loadOverrides();
    } catch (err) {
        showNotification(String(err), 'error');
    }
}

function isFirst(id) {
    return overrideItems[0]?.id === id;
}

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
    overlay.id = 'plugin-unload-confirm';
    overlay.className = 'fixed inset-0 z-[9999] flex items-center justify-center';
    overlay.style.background = 'rgba(0,0,0,0.5)';

    const card = document.createElement('div');
    card.className = 'glass-card p-6 flex flex-col gap-4 min-w-[320px] max-w-[420px] shadow-2xl';

    const title = document.createElement('div');
    title.className = 'text-sm font-semibold text-zinc-200';
    title.textContent = t('overrideDeleteConfirmTitle') ?? `删除覆写 "${overrideName}"？`;

    const msg = document.createElement('div');
    msg.className = 'text-xs text-zinc-400';
    msg.textContent = t('overrideDeleteConfirmMsg') ?? '此操作不可撤销。覆写脚本和执行日志都将被删除。';

    const btnRow = document.createElement('div');
    btnRow.className = 'flex items-center justify-end gap-2';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn-ghost text-xs px-4 py-1.5 rounded-lg';
    cancelBtn.textContent = t('cancel') ?? '取消';
    cancelBtn.addEventListener('click', () => overlay.remove());

    const confirmBtn = document.createElement('button');
    confirmBtn.className = 'bg-rose-600 hover:bg-rose-500 text-white text-xs px-4 py-1.5 rounded-lg font-medium';
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
    if (title) title.textContent = activeOverrideName || '编辑脚本';

    // Update type badge
    const isJs = activeOverrideExt === 'js';
    if (typeBadge) {
        typeBadge.textContent = isJs ? 'JS' : 'Prism';
        typeBadge.className = `text-2xs px-2 py-0.5 rounded ${isJs ? 'bg-blue-500/20 text-blue-400' : 'bg-purple-500/20 text-purple-400'}`;
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
    fullscreenEditorView.focus();

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
        status.textContent = '正在验证...';
        status.className = 'text-zinc-400';
    }

    try {
        const result = await overrideSetContent(activeOverrideId, source, true);
        if (result.success) {
            if (status) {
                status.textContent = '✓ 脚本安全';
                status.className = 'text-emerald-400';
            }
        } else {
            if (status) {
                status.textContent = `✗ ${formatScriptError(result.error) ?? '脚本可能不安全'}`;
                status.className = 'text-rose-400';
            }
        }
    } catch (err) {
        if (status) {
            status.textContent = `✗ ${err instanceof Error ? err.message : String(err)}`;
            status.className = 'text-rose-400';
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
        output.innerHTML = '<div class="text-zinc-500">执行中...</div>';
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
            output.className = `flex-1 p-4 text-sm font-mono whitespace-pre-wrap break-all overflow-y-auto custom-scrollbar ${result.success ? 'text-emerald-400' : 'text-rose-400'}`;
        }

        if (status) {
            status.textContent = result.success ? '✓ 执行成功' : '✗ 执行失败';
            status.className = result.success ? 'text-emerald-400' : 'text-rose-400';
        }

        if (result.success && result.configModified) {
            showNotification('覆写已应用，配置已重载', 'success');
        }
    } catch (err) {
        const errorText = err instanceof Error ? err.message : String(err);
        if (output) {
            output.textContent = errorText;
            output.className = 'flex-1 p-4 text-sm font-mono text-rose-400 whitespace-pre-wrap break-all overflow-y-auto custom-scrollbar';
        }
        if (status) {
            status.textContent = `✗ ${errorText}`;
            status.className = 'text-rose-400';
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
        output.innerHTML = '<div class="text-zinc-600 italic">点击"保存并执行"查看输出...</div>';
        output.className = 'flex-1 p-4 text-sm font-mono text-zinc-400 whitespace-pre-wrap break-all overflow-y-auto custom-scrollbar';
    }
}

/**
 * Convert script error line numbers to user-friendly format.
 * The wrapper script adds ~23 lines of preamble before user script.
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
            return `脚本第 ${userLine} 行，第 ${colNum} 列`;
        }
        // If line is within wrapper, just show original with note
        return `引擎内部 (eval_script:${lineNum}:${colNum})`;
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
            copyBtn.textContent = '已复制';
            copyBtn.style.color = 'var(--color-accent, #6366f1)';
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
                copyBtn.textContent = '已复制';
                copyBtn.style.color = 'var(--color-accent, #6366f1)';
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
 */
function setupFullscreenEditorStatus() {
    if (!fullscreenEditorView) return;

    const cursorPos = document.getElementById('fullscreen-editor-cursor-pos');
    const charCount = document.getElementById('fullscreen-editor-char-count');

    // Use updateListener extension instead of overriding dispatch
    const updateStatus = () => {
        // Update cursor position
        if (cursorPos) {
            const pos = fullscreenEditorView.state.selection.main.head;
            const line = fullscreenEditorView.state.doc.lineAt(pos);
            cursorPos.textContent = `行 ${line.number}, 列 ${pos - line.from + 1}`;
        }

        // Update character count
        if (charCount) {
            charCount.textContent = `${fullscreenEditorView.state.doc.length} 字符`;
        }
    };

    // Initial update
    updateStatus();

    // Setup periodic update (since we can't easily add extension after creation)
    const statusInterval = setInterval(() => {
        if (!isFullscreenEditorOpen || !fullscreenEditorView) {
            clearInterval(statusInterval);
            return;
        }
        updateStatus();
    }, 100);
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

function escapeHtml(str) {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
