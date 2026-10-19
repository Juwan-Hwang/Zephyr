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
import { rulesLogger } from '../utils/logger.js';
import { SVG_ICONS } from './icons.js';
import { stopSmartAutoTest, startSmartAutoTest, refreshProxies } from './proxies.js';
import { t, currentLang } from '../i18n.js';
import { showNotification, showModal, showConfirmModal } from './notifications.js';
import { createFocusTrap } from '../utils/focus-trap.js';
import { showLinkDialog } from './link-dialog.js';
import { createEditor, getEditorContent } from './editor/prism-editor.js';

/**
 * Status text for the inline editor: "Ln 9, Col 31 · 248 chars".
 * @param {{ line: number, col: number, length: number }} pos
 */
function showInlineCursor(pos) {
    const el = document.getElementById('plugin-script-cursor');
    if (!el) return;
    const lc = (t('overrideLineCol') ?? 'Line @@line@@, Col @@col@@')
        .replace('@@line@@', String(pos.line)).replace('@@col@@', String(pos.col));
    const chars = (t('overrideCharCount') ?? '@@count@@ chars').replace('@@count@@', String(pos.length));
    el.textContent = `${lc} · ${chars}`;
    updateDirtyMarker();
}

/** Show "● Unsaved" in the breadcrumb while the editor differs from what was saved. */
function updateDirtyMarker() {
    document.getElementById('plugin-script-dirty')?.classList.toggle('hidden', !isScriptDirty());
}

/**
 * Swap the panel header between the list title and the editor breadcrumb.
 * @param {boolean} editing
 */
function setEditorChrome(editing) {
    document.getElementById('plugin-panel-title')?.classList.toggle('hidden', editing);
    document.getElementById('plugin-script-crumb')?.classList.toggle('hidden', !editing);
    document.getElementById('plugin-toolbar')?.classList.toggle('hidden', editing);
    document.getElementById('plugin-list')?.classList.toggle('hidden', editing);
    document.getElementById('plugin-script-area')?.classList.toggle('hidden', !editing);
}

/**
 * @typedef {Object} ScriptResult
 * @property {'ok'|'fail'|'warn'} kind
 * @property {string} label - bold lead ("Last apply succeeded")
 * @property {string[]} detail - quiet parts joined with " · "
 * @property {number|null} at - when it happened (ms), shown as relative time
 * @property {string} log - full output behind "View log" ('' hides the link)
 */

/** @type {ScriptResult|null} */
let _scriptResult = null;
/** @type {ReturnType<typeof setInterval>|null} */
let _resultTimer = null;

const RESULT_ICON = { ok: '✓', fail: '✕', warn: '!' };
const RESULT_COLOR = { ok: '--zephyr-color-success', fail: '--zephyr-color-danger', warn: '--zephyr-color-warning' };

/** @param {number} at */
function formatAgo(at) {
    const sec = Math.round((Date.now() - at) / 1000);
    if (sec < 45) return t('overrideJustNow') ?? 'just now';
    const rtf = new Intl.RelativeTimeFormat(currentLang, { numeric: 'auto' });
    const min = Math.round(sec / 60);
    return min < 60 ? rtf.format(-min, 'minute') : rtf.format(-Math.round(min / 60), 'hour');
}

/**
 * The result line for a real (saved and applied) run.
 * @param {any} result
 * @returns {ScriptResult}
 */
function runScriptResult(result) {
    const took = (t('overrideDuration') ?? 'Took @@ms@@ ms')
        .replace('@@ms@@', String(Math.round((result.durationUs ?? 0) / 1000)));
    if (result.success) {
        return {
            kind: 'ok',
            label: result.configModified ? (t('overrideLastApplyOk') ?? 'Last apply succeeded') : (t('overrideSavedNoChange') ?? 'Saved, config unchanged'),
            detail: [took], at: Date.now(), log: logText(result),
        };
    }
    return {
        kind: 'fail',
        label: t('overrideLastApplyFailed') ?? 'Last apply failed',
        detail: [formatScriptError(result.error) || String(result.error ?? ''), took].filter(Boolean),
        at: Date.now(), log: logText(result),
    };
}

/** Paint the one-line result under the editor from `_scriptResult`. */
function renderScriptResult() {
    const box = document.getElementById('plugin-script-result');
    const icon = document.getElementById('plugin-script-result-icon');
    const label = document.getElementById('plugin-script-status');
    const detail = document.getElementById('plugin-script-result-detail');
    const logBtn = document.getElementById('plugin-script-log-btn');
    const out = document.getElementById('plugin-script-output');
    if (!box) return;
    const r = _scriptResult;
    box.classList.toggle('hidden', !r);
    if (!r) {
        out?.classList.add('hidden');
        return;
    }
    const color = `var(${RESULT_COLOR[r.kind]})`;
    if (icon) {
        icon.textContent = RESULT_ICON[r.kind];
        icon.style.color = color;
        icon.style.backgroundColor = `color-mix(in srgb, ${color} 15%, transparent)`;
    }
    if (label) {
        label.textContent = r.label;
        label.style.color = r.kind === 'ok' ? '' : color;
    }
    if (detail) detail.textContent = [...r.detail, ...(r.at ? [formatAgo(r.at)] : [])].join(' · ');
    if (logBtn) logBtn.classList.toggle('hidden', !r.log);
    if (out) out.textContent = r.log;
}

/** @param {ScriptResult|null} r */
function setScriptResult(r) {
    _scriptResult = r;
    document.getElementById('plugin-script-output')?.classList.add('hidden');
    const logBtn = document.getElementById('plugin-script-log-btn');
    if (logBtn) logBtn.textContent = t('overrideViewLog') ?? 'View log';
    renderScriptResult();
    if (_resultTimer) { clearInterval(_resultTimer); _resultTimer = null; }
    if (r?.at) _resultTimer = setInterval(renderScriptResult, 30_000);
}

/** Proxy group count from the running core, or null when it cannot be read. */
async function countProxyGroups() {
    try {
        const { getProxies } = await import('../api.js');
        const data = /** @type {{ proxies?: Record<string, { name?: string, all?: unknown }> }} */ (await getProxies());
        return Object.values(data?.proxies ?? {})
            .filter(p => Array.isArray(p?.all) && p?.name !== 'GLOBAL').length;
    } catch {
        return null;
    }
}
import { escapeHtml, escapeAttr } from '../utils/sanitize.js';
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

/** Six-dot drag handle (same as the subscription cards). */
const GRIP_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg>';

/** Dialogs opened on top of the override panel, each with its own Esc handling. */
function isNestedDialogOpen() {
    if (document.getElementById('modal-bg')?.classList.contains('hidden') === false) return true;
    return !!document.getElementById('link-dialog') || !!document.getElementById('scope-editor-overlay');
}

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

/** Bumped on every editor open and on panel close; a load that finishes after a newer one is dropped. */
let _editorOpenGen = 0;

/** Script content as last loaded or saved — anything else in the editor is unsaved. */
let _savedScript = '';
/** Order of save/run writes: only the newest one that returns may update _savedScript. */
let _scriptWriteSeq = 0;
/** Script writes run one at a time, in the order they were started. */
let _scriptWriteChain = Promise.resolve();
/**
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
function queueScriptWrite(fn) {
    const run = _scriptWriteChain.then(fn, fn);
    _scriptWriteChain = run.then(() => undefined, () => undefined);
    return run;
}
/** @param {number} seq @param {string} source */
function markSaved(seq, source) {
    if (seq === _scriptWriteSeq) _savedScript = source;
}

/** @returns {boolean} */
function isScriptDirty() {
    const scriptArea = document.getElementById('plugin-script-area');
    if (!scriptArea || scriptArea.classList.contains('hidden')) return false;
    const view = (isFullscreenEditorOpen && fullscreenEditorView) ? fullscreenEditorView : scriptEditorView;
    if (!view) return false;
    return getEditorContent(view) !== _savedScript;
}

/**
 * Ask before leaving the editor with unsaved changes.
 * @returns {Promise<boolean>} true when it is fine to leave
 */
async function confirmLeaveEditor() {
    if (!isScriptDirty()) return true;
    return showConfirmModal(
        t('overrideUnsavedTitle') ?? 'Discard unsaved changes?',
        t('overrideUnsavedDesc') ?? 'Your edits to this script have not been saved.',
        { danger: true, confirmText: t('overrideDiscard') ?? 'Discard' }
    );
}

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
    // "View log" opens the full output under the result line.
    const logBtn = document.getElementById('plugin-script-log-btn');
    logBtn?.addEventListener('click', () => {
        if (!scriptOutput) return;
        const open = scriptOutput.classList.toggle('hidden') === false;
        logBtn.textContent = open ? (t('overrideHideLog') ?? 'Hide log') : (t('overrideViewLog') ?? 'View log');
    });
    // eslint-disable-next-line no-unused-vars -- placeholder for editor title
    const scriptTitle = document.getElementById('plugin-script-title');
    const scriptRunBtn = document.getElementById('plugin-script-run-btn');
    const scriptValidateBtn = document.getElementById('plugin-script-validate-btn');
    const scriptSaveBtn = document.getElementById('plugin-script-save-btn');
    const scriptBackBtn = document.getElementById('plugin-script-back-btn');

    if (!panel) return;

    // ── Panel open / close ──────────────────────────────────────────
    // Esc closes the panel (after the unsaved check); Tab stays inside it.
    const panelTrap = createFocusTrap(panel, {
        onEscape: () => {
            // The trap swallows Esc for the whole document, so it closes the
            // fullscreen editor itself and leaves nested dialogs to their own handlers.
            if (isFullscreenEditorOpen) { closeFullscreenEditor(); return; }
            void closePanel();
        },
        // Nested dialogs and the editor's autocomplete close themselves on Esc.
        passEscape: () => isNestedDialogOpen() || !!document.querySelector('.cm-tooltip-autocomplete'),
    });
    openBtn?.addEventListener('click', () => {
        panel.classList.remove('hidden');
        requestAnimationFrame(() => panelTrap.activate());
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
        void loadOverrides();
    });

    const closePanel = async () => {
        if (!(await confirmLeaveEditor())) return;
        // Leaving discards the edits: drop the editor so reopening starts clean.
        if (isFullscreenEditorOpen) closeFullscreenEditor();
        // An editor still loading its script has already switched the chrome: drop that load.
        _editorOpenGen++;
        setEditorChrome(false);
        if (scriptEditorView) {
            setScriptResult(null);
            scriptEditorView.destroy();
            scriptEditorView = null;
        }
        panelTrap.deactivate();
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

    // Ctrl/Cmd+S saves, Ctrl/Cmd+Enter saves and applies. Capture phase so the
    // editor's own Mod-Enter binding never inserts a line first.
    panel.addEventListener('keydown', (e) => {
        if (!(e.ctrlKey || e.metaKey) || e.altKey || scriptArea?.classList.contains('hidden')) return;
        const key = e.key.toLowerCase();
        if (key !== 's' && key !== 'enter') return;
        e.preventDefault();
        e.stopPropagation();
        (key === 's' ? scriptSaveBtn : scriptRunBtn)?.click();
    }, true);
    if (/mac/i.test(navigator.platform)) {
        panel.querySelectorAll('.script-kbd').forEach(k => { k.textContent = (k.textContent ?? '').replace('Ctrl', '⌘'); });
    }

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
    const moreBtn = document.getElementById('plugin-more-btn');
    const moreMenu = document.getElementById('plugin-more-dropdown');
    const closeMore = () => { moreMenu?.classList.add('hidden'); moreBtn?.setAttribute('aria-expanded', 'false'); };
    moreBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        const open = moreMenu?.classList.toggle('hidden') === false;
        moreBtn.setAttribute('aria-expanded', String(open));
    });
    document.addEventListener('click', closeMore);
    enableAllBtn?.addEventListener('click', () => { closeMore(); void bulkToggle(true); });
    disableAllBtn?.addEventListener('click', () => { closeMore(); void bulkToggle(false); });

    // ── Script area back button ─────────────────────────────────────
    scriptBackBtn?.addEventListener('click', async () => {
        if (!(await confirmLeaveEditor())) return;
        // A content load still in flight must not open an editor after Back.
        _editorOpenGen++;
        setEditorChrome(false);
        setScriptResult(null);
        if (scriptEditorView) { scriptEditorView.destroy(); scriptEditorView = null; }
        // Refresh list to reflect any changes
        void loadOverrides();
    });

    /** Current editor text (raw; trimmed only to check for empty). */
    const editorText = () => {
        if (scriptEditorView) return getEditorContent(scriptEditorView);
        return (scriptEditor instanceof HTMLInputElement || scriptEditor instanceof HTMLTextAreaElement) ? scriptEditor.value : '';
    };
    /** @param {string} s */
    const plain = (s) => s.replace(/^[✓✗⚠]\s*/u, '');

    // ── Script validate ─────────────────────────────────────────────
    scriptValidateBtn?.addEventListener('click', async () => {
        const source = editorText();
        if (!source.trim() || !activeOverrideId) return;
        // A check runs nothing, so it is a toast and the last-run line stays.
        try {
            const result = await overrideSetContent(activeOverrideId, source, true);
            if (result.success) showNotification(plain(t('overrideScriptSafe') ?? 'Syntax check passed'), 'success');
            else showNotification(formatScriptError(result.error) ?? (t('overrideScriptUnsafe') ?? 'Script may be unsafe'), 'error');
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            // If core is not running, show a friendlier message instead of a hard error
            if (msg.includes('Failed to read running config') || msg.includes('No such file')) {
                showNotification(plain(t('overrideCoreNotRunning') ?? 'Core not running, cannot validate'), 'warning');
            } else {
                showNotification(formatScriptError(msg) || msg, 'error');
            }
        }
    });

    // ── Script save (no apply) ──────────────────────────────────────
    scriptSaveBtn?.addEventListener('click', async () => {
        const source = editorText();
        if (!source.trim() || !activeOverrideId) return;
        try {
            const seq = ++_scriptWriteSeq;
            const id = activeOverrideId;
            await queueScriptWrite(() => overrideSetContent(id, source, false, true));
            markSaved(seq, source);
            updateDirtyMarker();
            showNotification(t('overrideSavedOnly') ?? 'Saved', 'success');
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            showNotification(formatScriptError(msg) || msg, 'error');
        }
    });

    // ── Script run (save + apply) ────────────────────────────────
    scriptRunBtn?.addEventListener('click', async () => {
        if (!activeOverrideId) return;
        const source = editorText();
        if (!source.trim()) return;

        stopSmartAutoTest();
        const id = activeOverrideId;
        const seq = ++_scriptWriteSeq;
        // Queued before the group count, so a later save cannot be written ahead of this one.
        /** @type {number|null} */
        let groupsBefore = null;

        try {
            const result = await queueScriptWrite(async () => {
                groupsBefore = await countProxyGroups();
                return overrideSetContent(id, source, false);
            });

            // Invalidate caches so renderProxies fetches fresh data
            const { invalidateProxiesCache, invalidateConfigCache } = await import('./cache.js');
            invalidateProxiesCache();
            invalidateConfigCache();

            // Another override opened during the run: its editor and result line
            // are not this run's to update.
            const stillOpen = activeOverrideId === id;
            // A returned log means the backend wrote the content before running it,
            // so it is saved even when the run itself failed.
            if (stillOpen) {
                markSaved(seq, source);
                updateDirtyMarker();
            }
            const shown = runScriptResult(result);
            if (stillOpen) setScriptResult(shown);

            // Wait for Mihomo to finish reloading, then refresh proxies page and say how the groups moved
            setTimeout(async () => {
                startSmartAutoTest();
                void refreshProxies();
                if (!result.success || !result.configModified || groupsBefore === null) return;
                const groupsAfter = await countProxyGroups();
                if (groupsAfter === null || groupsAfter === groupsBefore || _scriptResult !== shown) return;
                shown.detail.unshift((t('overrideGroupsDelta') ?? 'Proxy groups @@from@@ → @@to@@')
                    .replace('@@from@@', String(groupsBefore)).replace('@@to@@', String(groupsAfter)));
                renderScriptResult();
            }, 1000);

            if (result.success && result.configModified) {
                showNotification(t('overrideApplied') ?? 'Override applied and config reloaded', 'success');
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (activeOverrideId === id) {
                setScriptResult({ kind: 'fail', label: t('overrideLastApplyFailed') ?? 'Last apply failed', detail: [formatScriptError(msg) || msg], at: Date.now(), log: msg });
            } else {
                showNotification(formatScriptError(msg) || msg, 'error');
            }
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
        if (action === 'new-js') void createNewOverride('js');
        else if (action === 'new-prism') void createNewOverride('prism.yaml');
        else if (action === 'import-url') void importFromUrl();
        else if (action === 'export-all') void exportAllOverrides();
        else if (action === 'import-file') void importFromFile();
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
        const created = await overrideCreate(name.trim(), ext, 'local', null);
        await loadOverrides();
        // Go straight into the new script instead of leaving one more row to click.
        if (created?.id) void openEditor(created.id, created.name ?? name.trim(), created.ext ?? ext);
        else showNotification(t('overrideCreated') ?? 'Override created', 'success');
    } catch (err) {
        showNotification(String(err), 'error');
    }
}

// ═══════════════════════════════════════════════════════════════════════
//  Import from URL
// ═══════════════════════════════════════════════════════════════════════

async function importFromUrl() {
    // Link is checked as it is typed (same dialog as "Add subscription").
    const picked = await showLinkDialog({
        title: t('overrideImportUrlTitle') ?? 'Import override from URL',
        urlLabel: t('overrideLink') ?? 'Link',
        confirmText: t('overrideImportAction') ?? 'Import',
    });
    if (!picked) return;
    const trimmedUrl = picked.url;

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
        void loadOverrides();
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
            void loadOverrides();
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
    // Esc closes and Tab stays inside (this dialog used to ignore Esc).
    const scopeTrap = createFocusTrap(overlay, { onEscape: () => closeScope() });
    const closeScope = () => { scopeTrap.deactivate(); overlay.remove(); };

    const card = document.createElement('div');
    card.className = 'glass-card p-6 flex flex-col gap-4 w-[400px] max-w-[calc(100vw-48px)] max-h-[70vh] shadow-2xl';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');

    // Title
    const title = document.createElement('h3');
    title.className = 'dialog-title';
    title.id = 'scope-editor-title';
    title.textContent = t('overrideScopeTitle') ?? 'Override Scope';
    card.setAttribute('aria-labelledby', title.id);

    // Global toggle
    const globalRow = document.createElement('label');
    globalRow.className = 'flex items-center gap-3 cursor-pointer';
    const globalCheck = document.createElement('input');
    globalCheck.type = 'checkbox';
    globalCheck.checked = currentGlobal;
    globalCheck.className = 'w-4 h-4 rounded accent-[var(--accent-primary)]';
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
    saveBtn.className = 'btn-primary';
    saveBtn.textContent = t('confirm') ?? 'OK';
    saveBtn.disabled = true; // Disabled until profiles are loaded

    void (async () => {
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
            row.className = 'flex items-center gap-3 cursor-pointer px-2 py-1.5 rounded-md hover:bg-[var(--zephyr-bg-muted)]';
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.value = cfg.name || cfg;
            cb.checked = profileIds.includes(cb.value);
            cb.className = 'w-4 h-4 rounded accent-[var(--accent-primary)] profile-scope-cb';
            cb.dataset.profileName = cb.value;
            const label = document.createElement('span');
            label.className = 'text-xs text-[var(--text-secondary)] truncate';
            label.textContent = String(cfg.name || cfg).replace(/\.(yaml|yml)$/i, '');
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
    cancelBtn.className = 'btn-ghost';
    cancelBtn.textContent = t('cancel') ?? 'Cancel';
    cancelBtn.addEventListener('click', () => closeScope());

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
            void loadOverrides();
            scopeTrap.deactivate();
        } catch (err) {
            showNotification(String(err), 'error');
            closeScope();
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
        if (e.target === overlay) closeScope();
    });

    document.body.appendChild(overlay);
    scopeTrap.activate();
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
            // A filtered list holds only some overrides, so its order can't be saved.
            if (!(card instanceof HTMLElement) || e.button !== 0 || searchFilter) return;
            // Don't start drag from buttons; the grip handle has its own drag (bindOverrideDrag)
            if (target.closest('button, .override-drag-handle')) return;
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

                        // Same queue as the grip and keyboard moves, so saves land in action order.
                        _reorderChain = _reorderChain.then(async () => {
                            try {
                                await overrideReorder(newIds);
                                // No need to reload — DOM already matches
                            } catch (err) {
                                showNotification(String(err), 'error');
                                // Revert: reload from backend
                                await loadOverrides();
                            }
                        }).catch((e) => { rulesLogger.warn('Override move failed', e); });
                        await _reorderChain;
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

    pluginList.replaceChildren();

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
    bindOverrideDrag(container);
    container.classList.toggle('is-filtered', !!filter);
    const filtered = items.filter(item =>
        !filter || item.name?.toLowerCase().includes(filter)
    );

    // Empty state
    if (filtered.length === 0) {
        container.replaceChildren();
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
        container.replaceChildren();
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
    const scopeBtn = card.querySelector('[data-action="edit-scope"]');
    if (scopeBtn) {
        const scope = overrideScopeInfo(item);
        const value = scopeBtn.querySelector('[data-scope-value]');
        if (value) {
            value.textContent = scope.label;
            value.className = scope.className;
        }
    }

    const status = card.querySelector('[data-override-status]');
    if (status instanceof HTMLElement) {
        const text = overrideFailureText(item);
        status.textContent = text;
        status.classList.toggle('hidden', !text);
    }

    // Update enable switch
    const toggleInput = card.querySelector('.override-toggle-input');
    if (toggleInput instanceof HTMLInputElement) toggleInput.checked = !!item.enabled;
    const switchLabel = card.querySelector('.override-switch');
    if (switchLabel instanceof HTMLElement) switchLabel.title = item.enabled ? t('overrideDisable') : t('overrideEnable');
    card.classList.toggle('is-disabled', !item.enabled);

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

/**
 * "Applies to" value for an override row.
 * @param {any} item
 * @returns {{label: string, className: string}}
 */
export function overrideScopeInfo(item) {
    if (item.global) return { label: t('overrideScopeAll') || 'All subscriptions', className: 'font-semibold text-[var(--text-secondary)]' };
    const ids = item.profileIds || [];
    if (!ids.length) return { label: t('overrideScopeUnset') || 'No subscription', className: 'font-semibold text-[var(--zephyr-color-warning)]' };
    const label = ids.slice(0, 2).join(', ') + (ids.length > 2 ? ` +${ids.length - 2}` : '');
    return { label, className: 'font-semibold text-[var(--text-secondary)]' };
}

/**
 * One-line failure text for an enabled override whose last run failed; empty otherwise.
 * @param {any} item
 * @returns {string}
 */
export function overrideFailureText(item) {
    if (!item.enabled || item.lastSuccess !== false) return '';
    const head = t('overrideLastFailed') || 'Last run failed';
    const detail = (formatScriptError(item.lastError ?? null) || '').split('\n')[0].trim();
    return detail ? (t('overrideLastFailedDetail') || 'Last run failed: @@msg@@').replace('@@msg@@', detail) : head;
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
    card.className = 'glass-card p-4 flex items-center justify-between group rtl-slide hover:z-10 transition-transform duration-[var(--zephyr-time-standard)] cursor-pointer';
    card.dataset.id = item.id;
    card.tabIndex = 0;
    card.setAttribute('aria-keyshortcuts', 'Alt+ArrowUp Alt+ArrowDown');

    const isJs = item.ext === 'js';
    const typeLabel = isJs ? 'JS' : 'Prism';
    const badge = 'text-2xs font-semibold px-1.5 py-0.5 rounded-sm bg-[var(--zephyr-bg-muted)] text-[var(--text-secondary)] shrink-0';
    const scope = overrideScopeInfo(item);
    const failure = overrideFailureText(item);

    // eslint-disable-next-line no-unsanitized/property -- values escaped via escapeHtml() and escapeAttr() // nosemgrep: js-innerhtml-assignment — verified safe, see eslint-disable above
    card.innerHTML = `
        <div class="flex items-center gap-3 flex-1 min-w-0">
            <span class="override-drag-handle" aria-hidden="true" title="${escapeAttr(t('subDragHandle') || 'Drag to reorder (Alt+↑/↓)')}">${GRIP_ICON}</span>
            <div class="flex flex-col gap-1 min-w-0">
                <div class="flex items-center gap-2 min-w-0">
                    <span class="override-name text-sm text-[var(--text-primary)] font-medium truncate">${escapeHtml(item.name ?? '')}</span>
                    <span class="${badge}">${typeLabel}</span>
                    ${item.type === 'remote' ? `<span class="${badge} !font-normal">${escapeHtml(t('overrideRemote') || 'Remote')}</span>` : ''}
                </div>
                <div class="flex items-center gap-3 min-w-0 text-xs">
                    <button type="button" class="override-scope-btn shrink-0" data-action="edit-scope" title="${escapeAttr(t('overrideScopeTitle'))}">
                        <span class="text-[var(--text-tertiary)]">${escapeHtml(t('overrideScopeLabel') || 'Applies to')}</span>
                        <span data-scope-value class="${scope.className}">${escapeHtml(scope.label)}</span>
                        <svg class="w-3 h-3 text-[var(--text-tertiary)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
                    </button>
                    <span class="override-status truncate ${failure ? '' : 'hidden'}" data-override-status>${escapeHtml(failure)}</span>
                </div>
            </div>
        </div>
        <div class="flex items-center gap-1 shrink-0">
            <button type="button" class="override-up-btn opacity-0 group-hover:opacity-100 focus-visible:opacity-100 p-1.5 rounded-sm text-[var(--text-muted)] hover:text-accent hover:bg-accent/10 transition-[opacity,color] ${isFirst(item.id) ? 'invisible' : ''}" title="${escapeAttr(t('overrideMoveUp') || '上移')}" aria-label="${escapeAttr(t('overrideMoveUp') || '上移')}" data-id="${escapeAttr(String(item.id ?? ''))}">
                ${SVG_ICONS.arrowUp}
            </button>
            <button type="button" class="override-down-btn opacity-0 group-hover:opacity-100 focus-visible:opacity-100 p-1.5 rounded-sm text-[var(--text-muted)] hover:text-accent hover:bg-accent/10 transition-[opacity,color] ${isLast(item.id) ? 'invisible' : ''}" title="${escapeAttr(t('overrideMoveDown') || '下移')}" aria-label="${escapeAttr(t('overrideMoveDown') || '下移')}" data-id="${escapeAttr(String(item.id ?? ''))}">
                ${SVG_ICONS.arrowDown}
            </button>
            <button type="button" class="btn-delete-icon rounded-sm me-2" title="${escapeAttr(t('pluginUnload') || '删除')}" aria-label="${escapeAttr(t('pluginUnload') || '删除')}" data-action="delete">
                ${SVG_ICONS.trash}
            </button>
            <label class="ios-switch override-switch" title="${item.enabled ? (escapeAttr(t('overrideDisable') || '禁用')) : (escapeAttr(t('overrideEnable') || '启用'))}">
                <input type="checkbox" class="override-toggle-input" aria-label="${escapeAttr(item.name ?? '')}" ${item.enabled ? 'checked' : ''}>
                <span class="switch-slider"></span>
            </label>
        </div>
    `;

    // ── Click: card body → edit ─────────────────────────────────
    card.addEventListener('click', () => {
        void openEditor(item.id, item.name ?? '', item.ext ?? 'js');
    });

    // ── Click: delete ──────────────────────────────────────────
    card.querySelector('[data-action="delete"]')?.addEventListener('click', (e) => {
        e.stopPropagation();
        void showDeleteConfirm(item.id, item.name ?? '');
    });

    // ── Keyboard: Enter opens, Alt+↑/↓ moves (same as the arrow buttons) ──
    card.addEventListener('keydown', (e) => {
        if (e.target !== card) return;
        if (e.key === 'Enter' && !e.altKey) {
            e.preventDefault();
            void openEditor(item.id, item.name ?? '', item.ext ?? 'js');
        } else if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
            e.preventDefault();
            void reorderItem(item.id, e.key === 'ArrowUp' ? -1 : 1);
        }
    });
    card.querySelector('.override-drag-handle')?.addEventListener('click', (e) => e.stopPropagation());

    // ── Reorder buttons ────────────────────────────────────────
    card.querySelector('.override-up-btn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        void reorderItem(item.id, -1);
    });
    card.querySelector('.override-down-btn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        void reorderItem(item.id, 1);
    });

    // ── Enable switch (always visible) ───────────────────────
    const switchLabel = card.querySelector('.override-switch');
    switchLabel?.addEventListener('click', (e) => e.stopPropagation());
    card.querySelector('.override-toggle-input')?.addEventListener('change', (e) => {
        e.stopPropagation();
        const current = overrideItems.find(i => i.id === item.id) || item;
        void toggleOverride(item.id, !current.enabled);
    });
    card.classList.toggle('is-disabled', !item.enabled);

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

    if (!pluginList || !scriptArea) return;

    activeOverrideId = id;
    activeOverrideName = name;
    activeOverrideExt = ext;

    // Show editor; the list toolbar (search, new, bulk) means nothing while editing one script.
    setEditorChrome(true);

    if (scriptTitle) scriptTitle.textContent = name;
    const typeBadge = document.getElementById('plugin-script-type');
    if (typeBadge) {
        const isJs = ext === 'js';
        typeBadge.textContent = isJs ? 'JS' : 'Prism';
        typeBadge.className = `text-2xs font-semibold px-1.5 py-0.5 rounded-sm shrink-0 ${isJs ? 'bg-blue-500/20 text-blue-400' : 'bg-teal-500/20 text-teal-400'}`;
    }
    // Last run outcome, as the backend remembers it.
    const item = overrideItems.find(o => o.id === id);
    setScriptResult(item?.lastSuccess === true
        ? { kind: 'ok', label: t('overrideLastApplyOk') ?? 'Last apply succeeded', detail: [], at: null, log: '' }
        : item?.lastSuccess === false
            ? { kind: 'fail', label: t('overrideLastApplyFailed') ?? 'Last apply failed', detail: [], at: null, log: '' }
            : null);

    // Load content
    const openGen = ++_editorOpenGen;
    let content = '';
    try {
        content = await overrideGetContent(id);
    } catch {
        content = '';
    }
    // The panel was closed (or another script opened) while this one loaded.
    if (openGen !== _editorOpenGen) return;

    _scriptWriteSeq++;
    _savedScript = content || '';

    // Build CM6 editor
    if (scriptEditorView) { scriptEditorView.destroy(); scriptEditorView = null; }
    if (scriptCm6) {
        scriptCm6.replaceChildren();
        scriptEditorView = createEditor({
            parent: scriptCm6,
            content: content || '',
            language: ext === 'js' ? 'javascript' : 'yaml',
            onCursor: showInlineCursor,
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
function reorderItem(id, direction) {
    // A filtered list shows only some overrides: a step there would jump hidden ones
    // (same rule as dragging), so moves wait until the search is cleared.
    if (searchFilter) return _reorderChain;
    // Run moves one after another (key repeat), so an older save cannot land last.
    _reorderChain = _reorderChain.then(async () => {
        const idx = overrideItems.findIndex(i => i.id === id);
        if (idx < 0) return;
        await moveOverrideTo(id, idx + direction);
    }).catch((e) => { rulesLogger.warn('Override move failed', e); });
    return _reorderChain;
}

/** @type {Promise<void>} */
let _reorderChain = Promise.resolve();

/**
 * Move one override to a new index (arrow buttons, Alt+↑/↓, drag handle), keep focus, persist.
 * @param {string} id
 * @param {number} toIdx
 */
async function moveOverrideTo(id, toIdx) {
    const idx = overrideItems.findIndex(i => i.id === id);
    if (idx < 0 || toIdx < 0 || toIdx >= overrideItems.length || toIdx === idx) return;

    const before = overrideItems;
    const newItems = [...overrideItems];
    const [moved] = newItems.splice(idx, 1);
    newItems.splice(toIdx, 0, moved);
    overrideItems = newItems;

    // Update UI immediately without full reload
    const pluginList = document.getElementById('plugin-list');
    const hadFocus = document.activeElement instanceof HTMLElement && document.activeElement.dataset?.id === id;
    if (pluginList) renderOverrideCards(pluginList, overrideItems, searchFilter);
    if (hadFocus && pluginList) {
        getOverrideCards(pluginList).find(c => c.dataset.id === id)?.focus();
    }

    // Persist the NEW order to backend
    try {
        await overrideReorder(overrideItems.map(i => i.id));
    } catch (err) {
        overrideItems = before;
        if (pluginList) renderOverrideCards(pluginList, overrideItems, searchFilter);
        showNotification(String(err), 'error');
    }
}

/**
 * Drag handle reorder for the override list (mouse events; HTML5 DnD is unreliable in the WebView).
 * Bound once per container. Disabled while a search filter hides part of the list.
 * @param {HTMLElement} container
 */
function bindOverrideDrag(container) {
    const el = /** @type {HTMLElement & {_overrideDragBound?: boolean}} */ (container);
    if (el._overrideDragBound) return;
    el._overrideDragBound = true;

    /** @type {{ card: HTMLElement, id: string, startY: number, moved: boolean, target: number } | null} */
    let drag = null;

    const clearMarks = () => getOverrideCards(container).forEach(c => c.classList.remove('is-dragging', 'drop-above', 'drop-below'));

    container.addEventListener('mousedown', (e) => {
        if (e.button !== 0 || !(e.target instanceof Element) || searchFilter) return;
        if (!e.target.closest('.override-drag-handle')) return;
        const card = /** @type {HTMLElement|null} */ (e.target.closest('[data-id]'));
        if (!card?.dataset.id || card.parentElement !== container) return;
        e.preventDefault();
        drag = { card, id: card.dataset.id, startY: e.clientY, moved: false, target: -1 };
    });

    document.addEventListener('mousemove', (e) => {
        if (!drag) return;
        if (!drag.moved && Math.abs(e.clientY - drag.startY) < 5) return;
        drag.moved = true;
        const cards = getOverrideCards(container);
        const from = cards.indexOf(drag.card);
        // Index the dragged card would take if dropped here.
        let to = 0;
        cards.forEach((c, i) => {
            const r = c.getBoundingClientRect();
            if (e.clientY > r.top + r.height / 2) to = i + 1;
        });
        if (to > from) to -= 1;
        drag.target = to;
        clearMarks();
        drag.card.classList.add('is-dragging');
        // Mark the card the dragged one will land next to.
        if (to !== from) cards[to]?.classList.add(to > from ? 'drop-below' : 'drop-above');
    });

    document.addEventListener('mouseup', (e) => {
        if (!drag) return;
        const { id, moved, target } = drag;
        drag = null;
        clearMarks();
        if (!moved) return;
        e.stopPropagation();
        // Swallow the click that follows the drag so the card doesn't open the editor.
        /** @param {Event} ev */
        const swallow = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
        container.addEventListener('click', swallow, { capture: true, once: true });
        setTimeout(() => {
            container.removeEventListener('click', swallow, { capture: true });
            _reorderChain = _reorderChain.then(() => moveOverrideTo(id, target))
                .catch((err) => { rulesLogger.warn('Override move failed', err); });
        }, 0);
    }, true);
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
async function showDeleteConfirm(overrideId, overrideName) {
    const confirmed = await showConfirmModal(
        (t('overrideDeleteConfirmTitle') ?? 'Delete override "@@name@@"?').replace('@@name@@', overrideName),
        t('overrideDeleteConfirmMsg') ?? 'This action cannot be undone. The override script and execution logs will be deleted.',
        { danger: true, confirmText: t('delete') ?? 'Delete' }
    );
    if (!confirmed) return;
    try {
        await overrideDelete(overrideId);
        void loadOverrides();
    } catch (err) {
        showNotification(String(err), 'error');
    }
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
        // ESC to close, unless the editor (autocomplete) or a nested dialog took it
        if (e.key === 'Escape' && !e.defaultPrevented && !isNestedDialogOpen()) {
            closeFullscreenEditor();
        }
        // Ctrl/Cmd + Enter saves and runs; Ctrl/Cmd + S only saves, as in the inline editor
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            e.preventDefault();
            void runFullscreenEditor();
        } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
            e.preventDefault();
            void saveFullscreenEditor();
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
        typeBadge.className = `text-2xs px-2 py-0.5 rounded-sm ${isJs ? 'bg-blue-500/20 text-blue-400' : 'bg-teal-500/20 text-teal-400'}`;
    }

    // Create fullscreen editor
    if (fullscreenEditorView) {
        fullscreenEditorView.destroy();
        fullscreenEditorView = null;
    }

    cm6Container.replaceChildren();
    fullscreenEditorView = createEditor({
        parent: cm6Container,
        content: content,
        language: isJs ? 'javascript' : 'yaml',
        prismDsl: !isJs,
    });

    // Setup cursor position update
    setupFullscreenEditorStatus();

    // Focus editor
    (/** @type {{focus: () => void}} */ (/** @type {unknown} */ (fullscreenEditorView))).focus();

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
                scriptCm6.replaceChildren();
                scriptEditorView.destroy();
                scriptEditorView = createEditor({
                    parent: scriptCm6,
                    content: content,
                    language: activeOverrideExt === 'js' ? 'javascript' : 'yaml',
                    onCursor: showInlineCursor,
                    prismDsl: activeOverrideExt !== 'js',
                });
                updateDirtyMarker();
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
                status.className = 'text-[var(--zephyr-color-success)]';
            }
        } else {
            if (status) {
                status.textContent = '✗ ' + (formatScriptError(result.error) ?? (t('overrideScriptUnsafe') ?? 'Script may be unsafe'));
                status.className = 'text-[var(--zephyr-color-danger)]';
            }
        }
    } catch (err) {
        if (status) {
            status.textContent = '✗ ' + (err instanceof Error ? err.message : String(err));
            status.className = 'text-[var(--zephyr-color-danger)]';
        }
    }
}

/**
 * Save the fullscreen editor's script without running it (Ctrl/Cmd + S).
 */
async function saveFullscreenEditor() {
    if (!fullscreenEditorView || !activeOverrideId) return;
    const source = getEditorContent(fullscreenEditorView);
    if (!source.trim()) return;
    const status = document.getElementById('fullscreen-editor-status');
    try {
        const seq = ++_scriptWriteSeq;
        const id = activeOverrideId;
        await queueScriptWrite(() => overrideSetContent(id, source, false, true));
        markSaved(seq, source);
        if (status) {
            status.textContent = t('overrideSavedOnly') ?? 'Saved';
            status.className = 'text-[var(--zephyr-color-success)]';
        }
    } catch (err) {
        if (status) {
            status.textContent = formatScriptError(err instanceof Error ? err.message : String(err)) || String(err);
            status.className = 'text-[var(--zephyr-color-danger)]';
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
    // Saved as typed (like the inline editor), so the unsaved check compares like with like.
    const source = getEditorContent(fullscreenEditorView);

    if (!source.trim()) return;

    if (output) {
        output.replaceChildren();
        const div = document.createElement('div');
        div.className = 'text-[var(--text-muted)]';
        div.textContent = t('overrideExecuting') ?? 'Executing...';
        output.appendChild(div);
    }

    stopSmartAutoTest();

    const id = activeOverrideId;
    // Another override opened during the run: its editor and result line are
    // not this run's to update.
    const stillOpen = () => activeOverrideId === id;
    try {
        const seq = ++_scriptWriteSeq;
        const result = await queueScriptWrite(() => overrideSetContent(id, source, false));
        if (stillOpen()) {
            // Written before it ran, so saved even when the run failed.
            markSaved(seq, source);
            setScriptResult(runScriptResult(result));
        }

        // Invalidate caches so renderProxies fetches fresh data
        const { invalidateProxiesCache, invalidateConfigCache } = await import('./cache.js');
        invalidateProxiesCache();
        invalidateConfigCache();

        // Wait for Mihomo to finish reloading, then refresh proxies page
        setTimeout(() => {
            startSmartAutoTest();
            void refreshProxies();
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

        if (output && stillOpen()) {
            output.textContent = outputText;
            output.className = `flex-1 p-4 text-sm font-mono whitespace-pre-wrap break-all overflow-y-auto custom-scrollbar ${result.success ? 'text-[var(--zephyr-color-success)]' : 'text-[var(--zephyr-color-danger)]'}`;
        }

        if (status && stillOpen()) {
            status.textContent = result.success
                ? (t('overrideExecSuccess') ?? '✓ Execution successful')
                : (t('overrideExecFailed') ?? '✗ Execution failed');
            status.className = result.success ? 'text-[var(--zephyr-color-success)]' : 'text-[var(--zephyr-color-danger)]';
        }

        if (result.success && result.configModified) {
            showNotification(t('overrideApplied') ?? 'Overrides applied, config reloaded', 'success');
        }
    } catch (err) {
        const errorText = err instanceof Error ? err.message : String(err);
        if (!stillOpen()) showNotification(formatScriptError(errorText) || errorText, 'error');
        if (output && stillOpen()) {
            output.textContent = errorText;
            output.className = 'flex-1 p-4 text-sm font-mono text-[var(--zephyr-color-danger)] whitespace-pre-wrap break-all overflow-y-auto custom-scrollbar';
        }
        if (status && stillOpen()) {
            status.textContent = `✗ ${errorText}`;
            status.className = 'text-[var(--zephyr-color-danger)]';
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
        output.replaceChildren();
        const div = document.createElement('div');
        div.className = 'text-[var(--text-tertiary)]';
        div.textContent = t('overrideOutputEmpty') ?? 'No output';
        output.appendChild(div);
        output.className = 'flex-1 p-4 text-sm font-mono text-[var(--text-secondary)] whitespace-pre-wrap break-all overflow-y-auto custom-scrollbar';
    }
}

/**
 * Full output for "View log": the error, then each log line.
 * @param {{ error?: string|null, logs?: {level?: string, message: string}[] }} result
 */
function logText(result) {
    const lines = [];
    if (result.error) lines.push(formatScriptError(result.error) || String(result.error));
    for (const log of result.logs ?? []) lines.push(`[${log.level ?? 'Info'}] ${log.message}`);
    return lines.join('\n');
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
            copyBtn.style.color = 'var(--accent-primary, #007AFF)';
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
                copyBtn.style.color = 'var(--accent-primary, #007AFF)';
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

    // Fill the status bar for the opened document right away (it used to read "0 chars").
    const state = fullscreenEditorView.state;
    const head = state.selection.main.head;
    const line = state.doc.lineAt(head);
    if (cursorPos) {
        cursorPos.textContent = (t('overrideLineCol') ?? 'Line @@line@@, Col @@col@@')
            .replace('@@line@@', String(line.number))
            .replace('@@col@@', String(head - line.from + 1));
    }
    if (charCount) {
        charCount.textContent = (t('overrideCharCount') ?? '@@count@@ chars').replace('@@count@@', String(state.doc.length));
    }
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
