// @ts-check
/**
 * Rule Library page module — manage Prism Engine rule files (.prism.yaml).
 *
 * Two-tab layout:
 *   1. Rule Sets  — CRUD for .prism.yaml files, groups, import/export
 *   2. Active Rules — read-only view of currently running rules
 *
 * @module ui/rule-library
 */

import { invoke } from '../api.js';
import { COMMANDS } from '@zephyr/shared';
import { generateDomId } from '../utils/dom-id.js';
import { translations, currentLang } from '../i18n.js';
import { showNotification, showModal, showConfirmModal } from './notifications.js';
import { Bus, Events } from './events.js';
import * as prism from './prism.js';
import { escapeHtml, escapeAttr } from '../utils/sanitize.js';
import { getPolicyColor } from '../utils/rule-utils.js';
import { rulesLogger } from '../utils/logger.js';
import { showContextMenu } from '../utils/context-menu.js';
import { SVG_ICONS } from './icons.js';
import { createVirtualScroll } from '../utils/virtual-scroll.js';
import { createEditor, getEditorContent } from './editor/prism-editor.js';
import { parseRulesFromYaml, rebuildYamlWithRules, wrapRulesAsPrismYaml } from './rule-library/yaml-utils.js';
import { pasteWithFeedback, renderPasteButtonHtml } from '../utils/clipboard.js';
import { initCustomDropdown } from './dropdown.js';
import { fetchProxyGroups } from './proxy-groups.js';
import {
    RULE_TYPES, ruleTypeLabel, parseRuleLine, buildRuleLine, looksLikeFullRule, loadPolicyNames, dropdownHtml,
} from './rule-library/rule-form.js';

/** Largest rule file the import accepts (matches the backend's MAX_RESPONSE_SIZE). */
const MAX_IMPORT_BYTES = 10 * 1024 * 1024;

// ═══════════════════════════════════════════════════════════════════════
//  Internal state
// ═══════════════════════════════════════════════════════════════════════

/** @type {'rule-sets'|'active-rules'} */
let activeTab = 'rule-sets';

/** @type {any|null} CodeMirror EditorView for the rule text editor (null when not active). */
let ruleEditorView = null;

/** @type {{filename: string, rule_count: number, source: string, enabled?: boolean}[]} */
let ruleFiles = [];

/** @type {{name: string, files: string[]}[]} */
let groups = [];

/** @type {any[]} 实际为 RuleGroup[]（prism.listRules() 返回值），每个对象包含 group_id, label, enabled, immutable, rules: [{raw, index}] */
let activeRules = [];

/** @type {import('../utils/virtual-scroll.js').VirtualScrollHandle | null} */
let activeRulesVs = null;
/** @type {ResizeObserver|null} */
let activeRulesResizeObs = null;
/** @type {HTMLElement|null} Active rules tab container (cached for collapse/expand) */
let activeRulesContainer = null;

/** Flattened view items for active rules virtual scroll.
 *  Each item is either { kind: 'group-header', group, ruleCount } or { kind: 'rule', raw, index, groupId }
 *  @type {any[]} */
let activeRulesFlat = [];
/** @type {Set<string>} Collapsed group IDs */
const collapsedGroups = new Set();

// ═══════════════════════════════════════════════════════════════════════
//  Public entry point
// ═══════════════════════════════════════════════════════════════════════

export async function initRuleLibraryPage() {
    const content = document.getElementById('rl-content');
    if (!content) return;

    // Reset virtual scroll when re-entering the page from navigation
    // (the DOM may have been cleared by another page's render)
    if (activeRulesVs) {
        activeRulesVs.destroy();
        activeRulesVs = null;
    }
    if (activeRulesResizeObs) {
        activeRulesResizeObs.disconnect();
        activeRulesResizeObs = null;
    }

    // Bind top-level buttons once
    if (!content.dataset.init) {
        content.dataset.init = 'true';

        document.getElementById('rl-btn-new-group')?.addEventListener('click', (e) => {
            e.stopPropagation();
            void handleNewGroup();
        });

        document.getElementById('rl-btn-import')?.addEventListener('click', (e) => {
            e.stopPropagation();
            void handleImportRules();
        });

        // Re-render tab bar text when language changes
        Bus.on(Events.I18N_APPLIED, () => render());
    }

    // Always refresh data on page entry
    await refreshData({ loadActiveRules: true });
    render();
}

// ═══════════════════════════════════════════════════════════════════════
//  Data layer
// ═══════════════════════════════════════════════════════════════════════

/**
 * @param {{loadActiveRules?: boolean}} [options]
 */
async function refreshData(options) {
    const { loadActiveRules = activeTab === 'active-rules' } = options || {};
    try {
        const promises = [
            invoke(COMMANDS.RULE_LIST),
            invoke(COMMANDS.RULE_GROUP_LIST),
        ];
        // Only fetch active rules when explicitly requested (e.g. user switches to active-rules tab)
        // to avoid slow listRules() blocking page entry
        if (loadActiveRules) {
            promises.push(
                prism.listRules().catch((err) => {
                    rulesLogger.warn('[RuleLibrary] prism.listRules() failed, active rules will be empty:', err);
                    return [];
                }),
            );
        }
        const results = await Promise.all(promises);
        ruleFiles = /** @type {typeof ruleFiles} */ (results[0] || []);
        groups = /** @type {typeof groups} */ ((results[1]?.groups) || []);
        if (loadActiveRules) {
            activeRules = /** @type {typeof activeRules} */ (results[2] || []);
        }
    } catch (err) {
        showNotification(String(err), 'error');
    }
    void updateStatusBar();
}

async function updateStatusBar() {
    const t = /** @type {Record<string, string>} */ (/** @type {any} */ (translations)[currentLang]);
    const statusEl = document.getElementById('rl-status');
    const statsEl = document.getElementById('rl-stats');

    try {
        const [engineStatus, engineStats] = await Promise.all([
            prism.status().catch(() => null),
            prism.stats().catch(() => null),
        ]);

        if (statusEl) {
            const state = engineStatus?.state || engineStatus?.status || 'idle';
            const isError = state === 'error';
            const isCompiling = state === 'compiling';
            let dotColor;
            if (isError) dotColor = 'bg-rose-500';
            else if (isCompiling) dotColor = 'bg-amber-400 animate-pulse';
            else dotColor = 'bg-emerald-400';
            let stateLabel;
            if (isError) stateLabel = t.ruleLibraryStatusError || 'Error';
            else if (isCompiling) stateLabel = t.ruleLibraryStatusCompiling || 'Compiling';
            else stateLabel = t.ruleLibraryStatusReady || 'Ready';
            // eslint-disable-next-line no-unsanitized/property -- values escaped via escapeHtml() // nosemgrep: js-innerhtml-assignment — verified safe, see eslint-disable above
            statusEl.innerHTML = `<span class="inline-block w-1.5 h-1.5 rounded-full ${dotColor} me-1.5"></span>${escapeHtml(stateLabel)}`;
        }

        if (statsEl) {
            const fileCount = engineStats?.file_count ?? engineStats?.files ?? ruleFiles.length;
            const ruleCount = engineStats?.rule_count ?? engineStats?.rules ?? ruleFiles.reduce((sum, f) => sum + (f.rule_count || 0), 0);
            statsEl.textContent = `${fileCount} ${t.ruleLibraryFiles || 'files'}  ${ruleCount} ${t.ruleLibraryRules || 'rules'}`;
        }
    } catch {
        // Fallback to local computation
        if (statusEl) {
            const dot = '<span class="inline-block w-1.5 h-1.5 rounded-full bg-emerald-400 me-1.5"></span>';
            // eslint-disable-next-line no-unsanitized/property -- values escaped via escapeHtml()
            statusEl.innerHTML = dot + escapeHtml(t.ruleLibraryStatusReady || 'Ready'); // nosemgrep: js-innerhtml-assignment — verified safe, see eslint-disable above
        }
        if (statsEl) {
            const totalRules = ruleFiles.reduce((sum, f) => sum + (f.rule_count || 0), 0);
            statsEl.textContent = `${ruleFiles.length} ${t.ruleLibraryFiles || 'files'}  ${totalRules} ${t.ruleLibraryRules || 'rules'}`;
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════
//  Top-level render
// ═══════════════════════════════════════════════════════════════════════

function render() {
    const content = document.getElementById('rl-content');
    if (!content) return;
    const t = /** @type {Record<string, string>} */ (/** @type {any} */ (translations)[currentLang]);

    // Active rules tab uses its own virtual scroll — disable outer overflow to avoid double scrollbar
    if (activeTab === 'active-rules') {
        content.classList.remove('overflow-y-auto', 'space-y-4');
        content.classList.add('overflow-hidden', 'flex', 'flex-col');
    } else {
        content.classList.remove('overflow-hidden', 'flex', 'flex-col');
        content.classList.add('overflow-y-auto', 'space-y-4');
    }

    // Only rebuild tab bar + content if it doesn't exist yet.
    // This preserves the virtual scroll instance during re-renders
    // (e.g. after import, language change, etc.).
    let tabContent = document.getElementById('rl-tab-content');
    if (!tabContent) {
        // eslint-disable-next-line no-unsanitized/property -- values escaped via escapeHtml() // nosemgrep: js-innerhtml-assignment — verified safe, see eslint-disable above
        content.innerHTML = `
            <div class="seg-tabs mb-4 shrink-0" role="tablist">
                <button type="button" role="tab" data-rl-tab="rule-sets" aria-selected="${activeTab === 'rule-sets'}" class="rl-tab seg-tab ${activeTab === 'rule-sets' ? 'active' : ''}">
                    ${escapeHtml(t.ruleLibraryManageFiles || 'Manage Rule Files')}
                </button>
                <button type="button" role="tab" data-rl-tab="active-rules" aria-selected="${activeTab === 'active-rules'}" class="rl-tab seg-tab ${activeTab === 'active-rules' ? 'active' : ''}">
                    ${escapeHtml(t.ruleLibraryActiveRules || 'Active Rules')}
                </button>
            </div>
            <div id="rl-tab-content"></div>
        `;

        // Tab click handlers
        content.querySelectorAll('.rl-tab').forEach((btn) => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const newTab = /** @type {string} */ (/** @type {HTMLElement} */ (btn).dataset.rlTab);
                if (newTab === activeTab) return;
                activeTab = /** @type {'rule-sets'|'active-rules'} */ (newTab);
                // Reflect the selection now so the roving tab stop is right while data loads.
                content.querySelectorAll('.rl-tab').forEach((tab) => {
                    const on = /** @type {HTMLElement} */ (tab).dataset.rlTab === activeTab;
                    tab.classList.toggle('active', on);
                    tab.setAttribute('aria-selected', String(on));
                });
                // Always refresh active rules when switching to that tab
                if (activeTab === 'active-rules') {
                    await refreshData({ loadActiveRules: true });
                }
                // Destroy old virtual scroll before switching tabs
                if (activeRulesVs) {
                    activeRulesVs.destroy();
                    activeRulesVs = null;
                }
                if (activeRulesResizeObs) {
                    activeRulesResizeObs.disconnect();
                    activeRulesResizeObs = null;
                }
                render();
            });
        });

        tabContent = document.getElementById('rl-tab-content');
    }

    // Update tab button active states and text (for i18n reactivity)
    content.querySelectorAll('.rl-tab').forEach((btn) => {
        const tab = /** @type {HTMLElement} */ (btn).dataset.rlTab;
        if (tab === 'rule-sets') {
            btn.textContent = t.ruleLibraryManageFiles || 'Manage Rule Files';
        } else if (tab === 'active-rules') {
            btn.textContent = t.ruleLibraryActiveRules || 'Active Rules';
        }
        btn.classList.toggle('active', tab === activeTab);
        btn.setAttribute('aria-selected', String(tab === activeTab));
    });

    if (tabContent) {
        if (activeTab === 'rule-sets') {
            tabContent.className = '';
            renderRuleSets(tabContent);
        } else {
            tabContent.className = 'flex-1 min-h-0 flex flex-col';
            renderActiveRules(tabContent);
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════
//  Rule Sets tab
// ═══════════════════════════════════════════════════════════════════════

/**
 * @param {HTMLElement} container
 */
function renderRuleSets(container) {
    const t = /** @type {Record<string, string>} */ (/** @type {any} */ (translations)[currentLang]);

    // Empty state
    if (ruleFiles.length === 0) {
        // eslint-disable-next-line no-unsanitized/property -- values escaped via escapeHtml() // nosemgrep: js-innerhtml-assignment — verified safe, see eslint-disable above
        container.innerHTML = `
            <div class="empty-state">
                <svg class="w-12 h-12 text-[var(--text-tertiary)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"/>
                </svg>
                <p class="text-[var(--text-muted)] text-sm">${escapeHtml(t.ruleLibraryEmpty || 'No extension rules yet')}</p>
                <p class="text-[var(--text-secondary)] text-xs max-w-sm text-center">${escapeHtml(t.ruleLibraryEmptyHint || '')}</p>
                <div class="flex flex-wrap items-center justify-center gap-2 mt-2">
                    <button type="button" id="rl-btn-extract" class="btn-ghost">
                        ${escapeHtml(t.ruleLibraryExtract || 'Extract from Subscription')}
                    </button>
                    <button type="button" id="rl-btn-import-empty" class="btn-accent">
                        ${escapeHtml(t.ruleLibraryImport || 'Import Rules')}
                    </button>
                    <button type="button" id="rl-btn-create-file" class="btn-ghost">
                        ${escapeHtml(t.ruleLibraryCreateFile || 'Create Rule File')}
                    </button>
                </div>
            </div>
        `;

        document.getElementById('rl-btn-extract')?.addEventListener('click', (e) => {
            e.stopPropagation();
            void handleExtractFromSubscription();
        });
        document.getElementById('rl-btn-import-empty')?.addEventListener('click', (e) => {
            e.stopPropagation();
            void handleImportRules();
        });
        document.getElementById('rl-btn-create-file')?.addEventListener('click', (e) => {
            e.stopPropagation();
            void handleCreateRuleFile();
        });
        return;
    }

    // Build a map: filename -> file info
    const fileMap = new Map(ruleFiles.map((f) => [f.filename, f]));

    // Build a set of files that belong to a group
    const groupedFiles = new Set(groups.flatMap((g) => g.files));

    container.replaceChildren();

    // Render each group as a collapsible section
    groups.forEach((group) => {
        const groupFiles = /** @type {(typeof ruleFiles)[number][]} */ (group.files
            .map((name) => fileMap.get(name))
            .filter(Boolean));

        container.appendChild(buildGroupSection(group, groupFiles, fileMap));
    });

    // Ungrouped files
    const ungroupedFiles = ruleFiles.filter((f) => !groupedFiles.has(f.filename));
    if (ungroupedFiles.length > 0) {
        container.appendChild(buildGroupSection(
            { name: t.ruleLibraryUngrouped || 'Ungrouped', files: ungroupedFiles.map((f) => f.filename) },
            ungroupedFiles,
            fileMap,
            true,
        ));
    }
}

/**
 * Build a collapsible group section element.
 * @param {{name: string, files: string[]}} group
 * @param {(typeof ruleFiles)[number][]} files
 * @param {Map<string, (typeof ruleFiles)[number]>} fileMap
 * @param {boolean} [isUngrouped]
 * @returns {HTMLElement}
 */
function buildGroupSection(group, files, fileMap, isUngrouped = false) {
    const t = /** @type {Record<string, string>} */ (/** @type {any} */ (translations)[currentLang]);
    const section = document.createElement('div');
    section.className = 'rl-group space-y-2';

    const totalRules = files.reduce((sum, f) => sum + (f.rule_count || 0), 0);

    // Group header
    const header = document.createElement('div');
    header.className = 'rl-group-header group';
    header.setAttribute('role', 'button');
    header.setAttribute('tabindex', '0');
    header.setAttribute('aria-expanded', 'true');
    header.addEventListener('keydown', (e) => { if (e.target === header && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); header.click(); } });
    // eslint-disable-next-line no-unsanitized/property -- values escaped via escapeHtml() // nosemgrep: js-innerhtml-assignment — verified safe, see eslint-disable above
    header.innerHTML = `
        <div class="flex items-center gap-2">
            ${SVG_ICONS.collapseArrow}
            <span class="text-[13px] font-semibold text-[var(--text-secondary)] truncate">${escapeHtml(group.name)}</span>
            <span class="text-xs text-[var(--text-muted)] tabular-nums whitespace-nowrap">${files.length} ${t.ruleLibraryFiles || 'files'} · ${totalRules} ${t.ruleLibraryRules || 'rules'}</span>
        </div>
        ${isUngrouped ? '' : `<button type="button" class="rl-icon-btn rl-group-more" title="${escapeAttr(t.moreActions || 'More')}" aria-label="${escapeAttr(`${t.moreActions || 'More'} · ${group.name}`)}" aria-haspopup="menu">${ICON_MORE}</button>`}
    `;

    // Group actions (rename / delete): visible ⋯ button, right-click still works — only for real groups
    if (!isUngrouped) {
        header.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            showGroupContextMenu(e, group.name);
        });
        const moreBtn = /** @type {HTMLElement|null} */ (header.querySelector('.rl-group-more'));
        moreBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            openMenuFromButton(moreBtn, (ev) => showGroupContextMenu(ev, group.name));
        });
        moreBtn?.addEventListener('keydown', (e) => e.stopPropagation());
    }

    // Toggle collapse
    const body = document.createElement('div');
    body.className = 'space-y-2 transition-all duration-[var(--zephyr-time-standard)]';
    const bodyId = generateDomId('rl-group-body');
    body.id = bodyId;
    header.setAttribute('aria-controls', bodyId);

    header.addEventListener('click', () => {
        const isCollapsed = body.style.display === 'none';
        body.style.display = isCollapsed ? '' : 'none';
        header.setAttribute('aria-expanded', isCollapsed ? 'true' : 'false');
        header.style.opacity = isCollapsed ? '' : '0.55';
        const arrow = /** @type {SVGElement|null} */ (header.querySelector('.collapse-arrow'));
        if (arrow) arrow.style.transform = isCollapsed ? '' : 'rotate(-90deg)';
    });

    // File cards
    files.forEach((file) => {
        body.appendChild(buildFileCard(file, fileMap));
    });

    section.appendChild(header);
    section.appendChild(body);
    return section;
}

const ICON_PENCIL = '<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
const ICON_MORE = '<svg class="w-4 h-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>';

/**
 * Open a context menu under a button (for the visible ⋯ buttons).
 * @param {HTMLElement} btn
 * @param {(e: MouseEvent) => void} open
 */
function openMenuFromButton(btn, open) {
    const r = btn.getBoundingClientRect();
    open(new MouseEvent('contextmenu', { clientX: r.left, clientY: r.bottom + 4, bubbles: false, cancelable: true }));
}

/**
 * Build a file card element: name · count · format, then the enable switch, edit and ⋯
 * (the same actions as the right-click menu, now visible).
 * @param {(typeof ruleFiles)[number]} file
 * @param {Map<string, (typeof ruleFiles)[number]>} _fileMap
 * @returns {HTMLElement}
 */
function buildFileCard(file, _fileMap) {
    const t = /** @type {Record<string, string>} */ (/** @type {any} */ (translations)[currentLang] || {});
    const enabled = file.enabled !== false;
    const displayName = file.filename.replace(/\.prism\.ya?ml$/i, '');
    const card = document.createElement('div');
    card.className = `glass-card rl-file-card group ${enabled ? '' : 'is-disabled'}`;
    card.dataset.filename = file.filename;

    const sourceBadge = getSourceBadge(file.source);
    const countText = `${file.rule_count || 0} ${t.ruleLibraryRules || 'rules'}`;
    const switchId = generateDomId('rl-file-switch');

    // eslint-disable-next-line no-unsanitized/property -- values escaped via escapeHtml() // nosemgrep: js-innerhtml-assignment — verified safe, see eslint-disable above
    card.innerHTML = `
        <div class="flex items-center gap-4 flex-1 min-w-0 rl-file-main">
            <div class="flex flex-col gap-0.5 min-w-0">
                <span class="rl-file-name text-sm text-[var(--text-primary)] font-medium truncate">${escapeHtml(displayName)}</span>
                <span class="text-xs text-[var(--text-muted)]">${escapeHtml(countText)}${enabled ? '' : ` · ${escapeHtml(t.ruleLibraryOff || 'Off')}`}</span>
            </div>
            <span class="text-2xs font-medium px-2 py-0.5 rounded-full shrink-0 ${sourceBadge.cls}">${escapeHtml(sourceBadge.label)}</span>
        </div>
        <div class="rl-file-actions">
            <label class="ios-switch" for="${switchId}" title="${escapeAttr(enabled ? (t.ruleLibraryOn || 'On') : (t.ruleLibraryOff || 'Off'))}">
                <input type="checkbox" id="${switchId}" class="rl-file-toggle" ${enabled ? 'checked' : ''} aria-label="${escapeAttr((t.ruleLibraryEnableFile || 'Enable “@@name@@”').replace('@@name@@', displayName))}">
                <span class="switch-slider"></span>
            </label>
            <span class="rl-file-sep" aria-hidden="true"></span>
            <button type="button" class="rl-icon-btn is-round rl-file-edit" ${enabled ? '' : 'disabled'} title="${escapeAttr(t.ruleLibraryEditRule || 'Edit')}" aria-label="${escapeAttr(`${t.ruleLibraryEditRule || 'Edit'} ${displayName}`)}">${ICON_PENCIL}</button>
            <button type="button" class="rl-icon-btn is-round rl-file-more" title="${escapeAttr(t.moreActions || 'More')}" aria-label="${escapeAttr(`${t.moreActions || 'More'} · ${displayName}`)}" aria-haspopup="menu">${ICON_MORE}</button>
        </div>
    `;

    const toggle = /** @type {HTMLInputElement|null} */ (card.querySelector('.rl-file-toggle'));
    toggle?.addEventListener('change', () => handleToggleFile(file, toggle.checked, toggle));
    toggle?.addEventListener('click', (e) => e.stopPropagation());

    card.querySelector('.rl-file-edit')?.addEventListener('click', (e) => {
        e.stopPropagation();
        if (enabled) void handleEditRule(file.filename);
    });
    const moreBtn = /** @type {HTMLElement|null} */ (card.querySelector('.rl-file-more'));
    moreBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        openMenuFromButton(moreBtn, (ev) => showFileContextMenu(ev, file));
    });

    // Right-click keeps working
    card.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        showFileContextMenu(e, file);
    });

    // Double-click on the card body still opens the editor
    card.querySelector('.rl-file-main')?.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        if (enabled) void handleEditRule(file.filename);
    });

    return card;
}

/**
 * Enable / disable a rule file (the engine parks it as `.disabled`), then rebuild the config.
 * @param {(typeof ruleFiles)[number]} file
 * @param {boolean} enabled
 * @param {HTMLInputElement} input
 */
async function handleToggleFile(file, enabled, input) {
    const t = /** @type {Record<string, string>} */ (/** @type {any} */ (translations)[currentLang] || {});
    input.disabled = true;
    try {
        const changed = await prism.toggleGroup(file.filename, enabled);
        if (changed === false) throw new Error(`${file.filename}: ${t.ruleLibraryToggleFailed || 'could not change state'}`);
        // Rebuild from the profile so a disabled file's rules are actually removed.
        try { await prism.rebuild(); } catch (e) {
            rulesLogger.warn('[prism] rebuild failed, falling back to apply:', e);
            // Apply only adds patches: a disabled file's rules stay until a rebuild works, so say so.
            if (!enabled) showNotification(String(e), 'error');
            try { await prism.apply(); } catch (error_) {
                rulesLogger.warn('[prism] apply failed:', error_);
                if (enabled) showNotification(String(error_), 'error');
            }
        }
        await refreshData({ loadActiveRules: true });
        render();
    } catch (err) {
        input.checked = !enabled;
        input.disabled = false;
        showNotification(String(err), 'error');
    }
}

/**
 * Get source badge styling and label.
 * @param {string} source
 * @returns {{cls: string, label: string}}
 */
function getSourceBadge(source) {
    const t = /** @type {Record<string, string>} */ (/** @type {any} */ (translations)[currentLang]);
    // The backend reports the file's *format* (clash / surge / unknown / empty), not where it
    // came from — so every file used to read "Manual". Show the format, or nothing.
    const s = (source || '').toLowerCase();
    if (s === 'clash') return { cls: 'bg-[var(--zephyr-bg-muted)] text-[var(--text-muted)]', label: t.ruleFormatClash || 'Clash format' };
    if (s === 'surge') return { cls: 'bg-[var(--zephyr-bg-muted)] text-[var(--text-muted)]', label: t.ruleFormatSurge || 'Surge format' };
    return { cls: 'hidden', label: '' };
}

// ═══════════════════════════════════════════════════════════════════════
//  Active Rules tab — 按 RuleGroup[] 分组渲染
// ═══════════════════════════════════════════════════════════════════════

/**
 * 渲染 Active Rules 标签页。
 * activeRules 为 RuleGroup[] 数组，每个 group 包含：
 *   - group_id: string
 *   - label: string（来源标签，如"广告过滤"）
 *   - enabled: boolean
 *   - immutable: boolean
 *   - rules: Array<{ raw: string, index: number }>
 *
 * 每个 group 渲染为可折叠区块，header 显示 label + 文件数 + 规则数 + 启用状态。
 * 每条 rule 显示：序号 + type badge + value + 来源标签 + policy。
 * Prism 规则加来源徽章（label 名称），非 Prism 规则无徽章。
 * 列表顶部有"插入规则"按钮。
 * @param {HTMLElement} [container]
 */
function renderActiveRules(container) {
    const t = /** @type {Record<string, string>} */ (/** @type {any} */ (translations)[currentLang]);

    // Cache container for collapse/expand re-renders
    if (container) activeRulesContainer = container;
    const ct = activeRulesContainer || container;
    if (!ct) return;

    if (!activeRules || activeRules.length === 0) {
        if (activeRulesVs) {
            activeRulesVs.destroy();
            activeRulesVs = null;
        }
        if (activeRulesResizeObs) {
            activeRulesResizeObs.disconnect();
            activeRulesResizeObs = null;
        }
        // eslint-disable-next-line no-unsanitized/property -- values escaped via escapeHtml() // nosemgrep: js-innerhtml-assignment — verified safe, see eslint-disable above
        ct.innerHTML = `
            <div class="flex flex-col items-center justify-center py-20 gap-4">
                <svg class="w-16 h-16 text-[var(--text-tertiary)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z"/>
                    <path d="m9 12 2 2 4-4"/>
                </svg>
                <p class="text-[var(--text-muted)] text-sm">${escapeHtml(t.ruleLibraryActiveRulesDesc || 'Rules currently in effect')}</p>
            </div>
        `;
        return;
    }

    // ── Flatten groups + rules into a single list for virtual scroll ──
    activeRulesFlat = [];
    /** @type {number} Local rule counter (1-based, for display only) */
    let localRuleIdx = 0;
    for (const group of activeRules) {
        if (typeof group === 'string') continue;
        const groupId = group.group_id || group.id || '';
        const ruleCount = (group.rules?.length) || 0;
        const isCollapsed = collapsedGroups.has(groupId);
        activeRulesFlat.push({ kind: 'group-header', group, ruleCount, isCollapsed });
        if (!isCollapsed) {
            for (const rule of group.rules || []) {
                localRuleIdx++;
                activeRulesFlat.push({
                    kind: 'rule',
                    raw: rule.raw || String(rule),
                    index: rule.index ?? 0,
                    localIndex: localRuleIdx,
                    groupId,
                    groupLabel: group.label || group.group_id || '',
                });
            }
        }
    }

    const totalRules = activeRules.reduce((s, g) => s + ((g.rules?.length) || 0), 0);

    // If virtual scroll already exists, just invalidate to re-render with new data.
    // This preserves scroll position and avoids destroying/recreating the scroll container.
    if (activeRulesVs) {
        // Update toolbar stats
        const groupsSpan = ct.querySelector('#arl-groups-count');
        const rulesSpan = ct.querySelector('#arl-rules-count');
        if (groupsSpan) groupsSpan.textContent = `${activeRules.length} ${t.ruleLibraryActiveGroups || 'groups'}`;
        if (rulesSpan) rulesSpan.textContent = `${totalRules} ${t.ruleLibraryRules || 'rules'}`;
        activeRulesVs.invalidate();
        return;
    }

    // ── Build DOM structure (first time only) ──
    ct.replaceChildren();

    // Toolbar
    const toolbar = document.createElement('div');
    toolbar.className = 'flex items-center justify-between mb-4 shrink-0';
    // eslint-disable-next-line no-unsanitized/property -- values escaped via escapeHtml() // nosemgrep: js-innerhtml-assignment — verified safe, see eslint-disable above
    toolbar.innerHTML = `
        <div class="flex items-center gap-2">
            <span id="arl-groups-count" class="text-xs text-[var(--text-muted)]">${escapeHtml(String(activeRules.length))} ${t.ruleLibraryActiveGroups || 'groups'}</span>
            <span class="text-xs text-[var(--text-tertiary)]">|</span>
            <span id="arl-rules-count" class="text-xs text-[var(--text-muted)]">${escapeHtml(String(totalRules))} ${t.ruleLibraryRules || 'rules'}</span>
        </div>
        <div class="flex items-center gap-2">
            <button type="button" id="rl-btn-trace" class="btn-ghost" title="${escapeAttr(t.ruleLibraryTraceDesc || 'Rule matching trace')}">
                <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12h4l3 8 4-16 3 8h4"/></svg>
                <span>${escapeHtml(t.ruleLibraryTraceReport || 'Match trace')}</span>
            </button>
            <button type="button" id="rl-btn-insert-rule" class="btn-accent">
                <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>
                <span>${escapeHtml(t.ruleLibraryInsertRule || 'Insert Rule')}</span>
            </button>
        </div>
    `;
    ct.appendChild(toolbar);

    toolbar.querySelector('#rl-btn-trace')?.addEventListener('click', (e) => {
        e.stopPropagation();
        void handleTraceRule();
    });

    toolbar.querySelector('#rl-btn-insert-rule')?.addEventListener('click', (e) => {
        e.stopPropagation();
        void handleInsertRule();
    });

    // Virtual scroll container
    const scrollBox = document.createElement('div');
    scrollBox.className = 'overflow-y-auto custom-scrollbar pe-1';
    scrollBox.innerHTML = '<div id="arl-vs-spacer-top" style="height:0"></div><div id="arl-vs-lines" class="space-y-1"></div><div id="arl-vs-spacer-bottom" style="height:0"></div>'; // nosemgrep: js-innerhtml-assignment — static HTML
    ct.appendChild(scrollBox);

    // Compute available height using the page container (which has constrained height)
    function fitScrollBoxHeight() {
        const page = document.querySelector('[data-page="rule-library"]');
        if (!page || !scrollBox.parentElement) return;
        const pageRect = page.getBoundingClientRect();
        const boxRect = scrollBox.getBoundingClientRect();
        const available = pageRect.bottom - boxRect.top;
        if (available > 0) scrollBox.style.height = `${available}px`;
    }
    if (activeRulesResizeObs) { activeRulesResizeObs.disconnect(); activeRulesResizeObs = null; }
    requestAnimationFrame(fitScrollBoxHeight);
    activeRulesResizeObs = new ResizeObserver(fitScrollBoxHeight);
    activeRulesResizeObs.observe(ct);

    const spacerTop = /** @type {HTMLElement} */ (scrollBox.querySelector('#arl-vs-spacer-top'));
    const spacerBottom = /** @type {HTMLElement} */ (scrollBox.querySelector('#arl-vs-spacer-bottom'));
    const linesContainer = /** @type {HTMLElement} */ (scrollBox.querySelector('#arl-vs-lines'));

    // ── Create virtual scroll ──
    activeRulesVs = createVirtualScroll({
        container: scrollBox,
        spacerTop,
        spacerBottom,
        linesContainer,
        itemCount: () => activeRulesFlat.length,
        rowHeightEst: 48,
        maxMounted: 300,
        renderItem(idx, fragment) {
            const item = activeRulesFlat[idx];
            if (!item) return;

            if (item.kind === 'group-header') {
                const { group, ruleCount, isCollapsed } = item;
                const groupId = group.group_id || group.id || '';
                const label = group.label || groupId || '';
                const enabled = group.enabled !== false;
                const badgeColor = getGroupBadgeColor(label);

                const header = document.createElement('div');
                header.setAttribute('data-line-idx', String(idx));
                header.className = `flex items-center justify-between p-2 rounded-[var(--radius-md)] border border-[var(--zephyr-border-subtle)] bg-[var(--zephyr-bg-input)] cursor-pointer select-none hover:border-[var(--zephyr-border-strong)] transition-all duration-[var(--zephyr-time-micro)] ${isCollapsed ? 'opacity-60' : ''}`;
                header.setAttribute('role', 'button');
                header.setAttribute('tabindex', '0');
                header.setAttribute('aria-expanded', isCollapsed ? 'false' : 'true');
                header.addEventListener('keydown', (e) => { if (e.target === header && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); header.click(); } });
                // eslint-disable-next-line no-unsanitized/property -- values escaped via escapeHtml() // nosemgrep: js-innerhtml-assignment — verified safe, see eslint-disable above
                header.innerHTML = `
                    <div class="flex items-center gap-3">
                        <svg class="w-3 h-3 text-[var(--text-muted)] collapse-arrow transition-transform duration-[var(--zephyr-time-micro)] ${isCollapsed ? 'rotate-[-90deg]' : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>
                        <span class="text-xs px-2 py-0.5 rounded-full ${badgeColor}">${escapeHtml(label)}</span>
                        <span class="text-2xs tabular-nums text-[var(--text-muted)]">${ruleCount} ${escapeHtml(t.ruleLibraryRules || 'rules')}</span>
                    </div>
                    <div class="flex items-center gap-2">
                        <span class="text-2xs tabular-nums ${enabled ? 'text-emerald-500' : 'text-[var(--text-muted)]'}">${escapeHtml(enabled ? (t.ruleLibraryOn || 'On') : (t.ruleLibraryOff || 'Off'))}</span>
                    </div>
                `;
                header.addEventListener('click', () => {
                    const activeLineIdx = document.activeElement?.getAttribute('data-line-idx');
                    if (collapsedGroups.has(groupId)) {
                        collapsedGroups.delete(groupId);
                        header.setAttribute('aria-expanded', 'true');
                    } else {
                        collapsedGroups.add(groupId);
                        header.setAttribute('aria-expanded', 'false');
                    }
                    renderActiveRules();
                    if (activeLineIdx) {
                        const newEl = container?.querySelector('[data-line-idx="' + activeLineIdx + '"]');
                        (/** @type {HTMLElement} */ (newEl))?.focus();
                    }
                });
                fragment.appendChild(header);
            } else {
                const { raw, index, localIndex } = item;
                const parts = raw.split(',').map((/** @type {string} */ s) => s.trim());
                if (parts.length < 2) return;

                const type = parts[0];
                const value = parts[1];
                const policy = parts[2] || 'Proxy';

                const el = document.createElement('div');
                el.setAttribute('data-line-idx', String(idx));
                el.className = 'active-rule-row flex items-center justify-between group';
                // eslint-disable-next-line no-unsanitized/property -- values escaped via escapeHtml() // nosemgrep: js-innerhtml-assignment — verified safe, see eslint-disable above
                el.innerHTML = `
                    <div class="flex items-center gap-4 flex-1 min-w-0">
                        <span class="text-xs text-[var(--text-tertiary)] w-6 shrink-0">${localIndex}</span>
                        <div class="type-badge text-[var(--text-muted)] shrink-0">${escapeHtml(type)}</div>
                        <div class="text-xs text-[var(--text-secondary)] font-mono truncate max-w-[300px]" title="${escapeAttr(value)}">${escapeHtml(value)}</div>
                    </div>
                    <div class="flex items-center gap-2 shrink-0">
                        <div class="text-xs font-semibold ${getPolicyColor(policy)}">${escapeHtml(policy)}</div>
                    </div>
                `;
                el.addEventListener('contextmenu', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    showActiveRuleContextMenu(e, raw, index);
                });
                fragment.appendChild(el);
            }
        },
    });
}

/**
 * 根据分组标签名称生成柔和的徽章样式类。
 * 使用字符串哈希映射到预定义的 Tailwind 色彩组合。
 * @param {string} label
 * @returns {string} Tailwind CSS 类名
 */
function getGroupBadgeColor(label) {
    // 预定义的柔和色彩方案（bg + text）
    const palette = [
        'bg-blue-500/15 text-blue-400',
        'bg-accent/15 text-accent',
        'bg-emerald-500/15 text-emerald-400',
        'bg-amber-500/15 text-amber-400',
        'bg-rose-500/15 text-rose-400',
        'bg-teal-500/15 text-teal-400',
        'bg-orange/15 text-orange',
        'bg-blue-500/15 text-blue-400',
        'bg-pink/15 text-pink',
    ];
    // 简单哈希：取字符串 charCode 之和取模
    let hash = 0;
    for (let i = 0; i < label.length; i++) {
        hash = ((hash << 5) - hash + label.charCodeAt(i)) | 0;
    }
    return palette[Math.abs(hash) % palette.length];
}

/**
 * Display name for an active-rules group (its label, or the file name without `.prism.yaml`).
 * @param {any} g
 * @returns {string}
 */
function groupDisplayName(g) {
    const raw = String(g.label || g.group_id || '');
    return raw.replace(/\.prism\.ya?ml$/i, '');
}

/**
 * Insert Rule — one form: type / match / policy, with the position as a visible choice.
 * A whole rule line (or a JSON rule object) pasted into the match field is used as is.
 */
async function handleInsertRule() {
    const t = /** @type {Record<string, string>} */ (/** @type {any} */ (translations)[currentLang]);

    const groupOptions = activeRules
        .filter((g) => typeof g !== 'string' && g.group_id)
        .map((g) => ({ id: String(g.group_id), label: groupDisplayName(g) }));

    /** @type {{position: string, groupId?: string, label: string, hint?: string}[]} */
    const positions = [
        { position: 'before_prism', label: t.ruleLibraryInsertPosBeforeAll || 'Before all extension rules', hint: t.ruleLibraryInsertHighest || 'Highest priority' },
        ...groupOptions.map((g) => ({
            position: 'after_group',
            groupId: g.id,
            label: (t.ruleLibraryInsertPosAfterGroup || 'After “@@name@@”').replace('@@name@@', g.label),
        })),
        { position: 'after_prism', label: t.ruleLibraryInsertPosAfterAll || 'After all extension rules' },
        { position: 'append', label: t.ruleLibraryInsertPosEnd || 'End of all rules', hint: t.ruleLibraryInsertLowest || 'Lowest priority' },
    ];

    const policies = await loadPolicyNames(() => fetchProxyGroups());
    const typeOptions = RULE_TYPES.map((r) => ({ value: r.value, label: ruleTypeLabel(r.value, t) }));
    const policyOptions = policies.map((p) => ({ value: p, label: p }));

    const positionsHtml = positions.map((p, i) => `
        <label class="rl-pos-option">
            <input type="radio" name="rl-insert-pos" value="${i}" ${i === 0 ? 'checked' : ''} />
            <span class="rl-pos-label">${escapeHtml(p.label)}</span>
            ${p.hint ? `<span class="rl-pos-hint">${escapeHtml(p.hint)}</span>` : ''}
        </label>`).join('');

    const formHtml = `
        <div class="rl-insert-form space-y-4">
            <div class="rl-insert-grid">
                <div class="space-y-2 min-w-0">
                    <span class="rl-field-label">${escapeHtml(t.ruleLibraryRuleType || 'Rule type')}</span>
                    ${dropdownHtml('rl-insert-type', typeOptions, 'DOMAIN-SUFFIX', t.ruleLibraryRuleType || 'Rule type')}
                </div>
                <div class="space-y-2 min-w-0">
                    <label for="rl-insert-value" class="rl-field-label">${escapeHtml(t.ruleLibraryRuleMatch || 'Match')}</label>
                    <input id="rl-insert-value" type="text" class="form-control form-control-lg form-control-mono" placeholder="example.com" spellcheck="false" />
                </div>
            </div>
            <div class="space-y-2">
                <span class="rl-field-label">${escapeHtml(t.ruleLibraryRulePolicy || 'Then use')}</span>
                ${dropdownHtml('rl-insert-policy', policyOptions, policies[0] || 'DIRECT', t.ruleLibraryRulePolicy || 'Then use')}
            </div>
            <div class="space-y-2">
                <span class="rl-field-label">${escapeHtml(t.ruleLibraryInsertWhere || 'Position (earlier wins)')}</span>
                <div class="rl-pos-list">${positionsHtml}</div>
            </div>
            <p class="text-2xs text-[var(--text-muted)]">${escapeHtml(t.ruleLibraryInsertRawHint || 'A whole rule line also works:')} <code class="font-mono">DOMAIN-SUFFIX,example.com,Proxy</code></p>
            <div id="rl-insert-error" class="hidden text-xs text-[var(--zephyr-color-danger)]" aria-live="polite"></div>
            <div class="flex items-center justify-end gap-2 pt-1">
                <button type="button" id="rl-insert-cancel" class="btn-ghost">${escapeHtml(t.cancel || 'Cancel')}</button>
                <button type="button" id="rl-insert-confirm" class="btn-primary">${escapeHtml(t.ruleLibraryInsertConfirm || 'Insert')}</button>
            </div>
        </div>
    `;

    /** @type {any[]} */
    const dropdowns = [];
    await showModal(t.ruleLibraryInsertRule || 'Insert Rule', '', '', true, formHtml, (contentArea, close) => {
        const typeDd = initCustomDropdown({
            wrapId: 'rl-insert-type-wrap', triggerId: 'rl-insert-type-trigger', menuId: 'rl-insert-type-menu',
            labelId: 'rl-insert-type-label', selectId: 'rl-insert-type-select',
            onChange: (/** @type {string} */ v) => syncValueField(v),
        });
        const policyDd = initCustomDropdown({
            wrapId: 'rl-insert-policy-wrap', triggerId: 'rl-insert-policy-trigger', menuId: 'rl-insert-policy-menu',
            labelId: 'rl-insert-policy-label', selectId: 'rl-insert-policy-select',
        });
        if (typeDd) dropdowns.push(typeDd);
        if (policyDd) dropdowns.push(policyDd);

        const valueInput = /** @type {HTMLInputElement|null} */ (contentArea.querySelector('#rl-insert-value'));
        const errorEl = contentArea.querySelector('#rl-insert-error');
        /** @param {string} msg */
        const showError = (msg) => {
            if (!errorEl) return;
            errorEl.textContent = msg;
            errorEl.classList.toggle('hidden', !msg);
        };
        /** @param {string} type */
        function syncValueField(type) {
            if (!valueInput) return;
            const isMatch = type === 'MATCH';
            valueInput.disabled = isMatch;
            if (isMatch) valueInput.value = '';
        }

        contentArea.querySelector('#rl-insert-cancel')?.addEventListener('click', () => close(null));

        const confirmBtn = /** @type {HTMLButtonElement|null} */ (contentArea.querySelector('#rl-insert-confirm'));
        const submit = async () => {
            if (!confirmBtn || confirmBtn.disabled) return;
            const type = typeDd?.getValue() || 'DOMAIN-SUFFIX';
            const policy = policyDd?.getValue() || 'DIRECT';
            const value = (valueInput?.value || '').trim();
            const checked = /** @type {HTMLInputElement|null} */ (contentArea.querySelector('input[name="rl-insert-pos"]:checked'));
            const pos = positions[Number(checked?.value || 0)] || positions[0];

            let ruleText = '';
            if (looksLikeFullRule(value)) ruleText = value;
            else if (type === 'MATCH') ruleText = buildRuleLine(type, '', policy);
            else if (!value) { showError(t.ruleLibraryInsertNeedValue || 'Enter what to match'); valueInput?.focus(); return; }
            else ruleText = buildRuleLine(type, value, policy);

            showError('');
            confirmBtn.disabled = true;
            try {
                /** @type {any} */
                let parsed = null;
                if (ruleText.startsWith('{')) {
                    try { parsed = JSON.parse(ruleText); } catch { parsed = null; }
                }
                if (parsed && typeof parsed === 'object') await prism.insertRule(parsed, pos.position, pos.groupId);
                else await prism.insertRuleStr(ruleText, pos.position, pos.groupId);
                close(null);
                showNotification(t.ruleLibraryInsertSuccess || 'Rule inserted', 'success');
                try { await prism.apply(); } catch (e) { rulesLogger.warn('[prism] apply failed:', e); }
                await refreshData({ loadActiveRules: true });
                render();
            } catch (err) {
                showError(String(err));
                confirmBtn.disabled = false;
            }
        };
        confirmBtn?.addEventListener('click', (ev) => { ev.stopPropagation(); void submit(); });
        valueInput?.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); void submit(); } });
    });
    dropdowns.forEach((d) => d.dispose());
}

// ═══════════════════════════════════════════════════════════════════════
//  Context menus
// ═══════════════════════════════════════════════════════════════════════

/**
 * Group header context menu.
 * @param {MouseEvent} e
 * @param {string} groupName
 */
function showGroupContextMenu(e, groupName) {
    const t = /** @type {Record<string, string>} */ (/** @type {any} */ (translations)[currentLang]);

    showContextMenu(e, [
        {
            label: t.ruleLibraryEditGroup || 'Edit Group Name',
            action: () => handleRenameGroup(groupName),
        },
        {
            label: t.ruleLibraryDeleteGroup || 'Delete Group',
            action: () => handleDeleteGroup(groupName),
        },
    ]);
}

/**
 * File card context menu.
 * @param {MouseEvent} e
 * @param {(typeof ruleFiles)[number]} file
 */
function showFileContextMenu(e, file) {
    const t = /** @type {Record<string, string>} */ (/** @type {any} */ (translations)[currentLang]);
    const enabled = file.enabled !== false;

    /** @type {{label: string, action: () => void}[]} */
    const items = [];
    if (enabled) {
        items.push(
            { label: t.ruleLibraryEditRule || 'Edit Rule', action: () => handleEditRule(file.filename) },
            { label: t.ruleLibraryViewChanges || 'View Impact on Config', action: () => handleViewChanges(file.filename) },
            { label: t.ruleLibraryRenameRule || 'Rename', action: () => handleRenameRule(file.filename) },
        );
    }
    if (groups.length > 0) {
        items.push({ label: t.ruleLibraryMoveToGroup || 'Move to Group', action: () => handleMoveToGroup(file.filename) });
    }
    items.push({ label: t.ruleLibraryDeleteRule || 'Delete', action: () => handleDeleteRule(file.filename, enabled) });

    showContextMenu(e, items);
}

/**
 * Active rule context menu.
 * @param {MouseEvent} e
 * @param {string} rule
 * @param {number} index
 */
function showActiveRuleContextMenu(e, rule, index) {
    const t = /** @type {Record<string, string>} */ (/** @type {any} */ (translations)[currentLang]);

    showContextMenu(e, [
        {
            label: t.ruleLibraryTraceReport || 'Match trace',
            action: () => handleTraceRule(rule, index),
        },
    ]);
}

// ═══════════════════════════════════════════════════════════════════════
//  Group actions
// ═══════════════════════════════════════════════════════════════════════

async function handleNewGroup() {
    const t = /** @type {Record<string, string>} */ (/** @type {any} */ (translations)[currentLang]);
    const name = await showModal(
        t.ruleLibraryGroupName || 'Group Name',
        t.ruleLibraryGroupNamePlaceholder || 'Enter group name',
    );
    if (!name || !name.trim()) return;

    try {
        await invoke(COMMANDS.RULE_GROUP_CREATE, { name: name.trim() });
        showNotification(`${t.ruleLibraryNewGroup}: ${name.trim()}`, 'success');
        await refreshData({ loadActiveRules: true });
        render();
    } catch (err) {
        showNotification(String(err), 'error');
    }
}

/**
 * @param {string} oldName
 */
async function handleRenameGroup(oldName) {
    const t = /** @type {Record<string, string>} */ (/** @type {any} */ (translations)[currentLang]);
    const newName = await showModal(
        t.ruleLibraryEditGroup || 'Edit Group Name',
        t.ruleLibraryGroupNamePlaceholder || 'Enter group name',
        oldName,
    );
    if (!newName || !newName.trim() || newName.trim() === oldName) return;

    try {
        await invoke(COMMANDS.RULE_GROUP_RENAME, { oldName, newName: newName.trim() });
        showNotification(`${t.ruleLibraryEditGroup}: ${newName.trim()}`, 'success');
        await refreshData({ loadActiveRules: true });
        render();
    } catch (err) {
        showNotification(String(err), 'error');
    }
}

/**
 * @param {string} name
 */
async function handleDeleteGroup(name) {
    const t = /** @type {Record<string, string>} */ (/** @type {any} */ (translations)[currentLang]);
    const confirmed = await showConfirmModal(
        (t.ruleLibraryDeleteGroupTitle || 'Delete group “@@name@@”?').replace('@@name@@', name),
        t.ruleLibraryDeleteGroupDesc || 'Files in this group move to Ungrouped; they are not deleted.',
        { danger: true, confirmText: t.delete || 'Delete' },
    );
    if (!confirmed) return;

    try {
        await invoke(COMMANDS.RULE_GROUP_DELETE, { name });
        showNotification(`${t.ruleLibraryRemoved || 'Removed'}: ${name}`, 'success');
        await refreshData({ loadActiveRules: true });
        render();
    } catch (err) {
        showNotification(String(err), 'error');
    }
}

/**
 * @param {string} filename
 */
async function handleMoveToGroup(filename) {
    const t = /** @type {Record<string, string>} */ (/** @type {any} */ (translations)[currentLang]);

    // Build submenu with group names
    const groupNames = groups.map((g) => g.name);
    if (groupNames.length === 0) return;

    // Use a simple modal to pick group
    const optionsHtml = groupNames
        .map((name, i) => `<button type="button" class="w-full text-start px-4 py-2.5 text-sm text-[var(--text-secondary)] hover:bg-accent/10 hover:text-accent transition-colors rounded-lg" data-group-index="${i}">${escapeHtml(name)}</button>`)
        .join('');

    const result = await showModal(
        t.ruleLibraryMoveToGroup || 'Move to Group',
        '',
        '',
        true,
        `<div class="space-y-1">${optionsHtml}</div>`,
        // onReady: bind click handlers — clicking a group button immediately closes and returns it
        (contentArea, close) => {
            contentArea.querySelector('.space-y-1')?.addEventListener('click', (e) => {
                const target = e.target;
                if (!(target instanceof Element)) return;
                const btn = target.closest('[data-group-index]');
                if (!(btn instanceof HTMLElement)) return;
                close(btn);
            });
        },
    );

    if (!result || !(result instanceof HTMLElement)) return;

    const idx = parseInt(/** @type {string} */ (result.dataset.groupIndex), 10);
    const targetGroup = groupNames[idx];
    if (!targetGroup) return;

    try {
        await invoke(COMMANDS.RULE_GROUP_MOVE, { filename, targetGroup });
        showNotification(`${filename} -> ${targetGroup}`, 'success');
        await refreshData({ loadActiveRules: true });
        render();
    } catch (err) {
        showNotification(String(err), 'error');
    }
}

// ═══════════════════════════════════════════════════════════════════════
//  Rule file actions
// ═══════════════════════════════════════════════════════════════════════

async function handleCreateRuleFile() {
    const t = /** @type {Record<string, string>} */ (/** @type {any} */ (translations)[currentLang]);
    const name = await showModal(
        t.ruleLibraryCreateFile || 'Create Rule File',
        t.ruleLibraryFileNamePlaceholder || 'Rule set name',
        'my-rules',
    );
    if (!name || !name.trim()) return;

    const filename = name.trim().endsWith('.prism.yaml') ? name.trim() : `${name.trim()}.prism.yaml`;

    try {
        await invoke(COMMANDS.RULE_CREATE, { name: filename, content: 'rules:\n  $append:\n' });
        showNotification(`${t.ruleLibraryCreateFile}: ${filename}`, 'success');
        try { await prism.apply(); } catch (e) { rulesLogger.warn("[prism] apply failed:", e); }
        await refreshData({ loadActiveRules: true });
        render();
    } catch (err) {
        showNotification(String(err), 'error');
    }
}

/**
 * @param {string} oldFilename
 */
async function handleRenameRule(oldFilename) {
    const t = /** @type {Record<string, string>} */ (/** @type {any} */ (translations)[currentLang]);
    const displayName = oldFilename.replace(/\.prism\.ya?ml$/i, '');
    const newName = await showModal(
        t.ruleLibraryRenameRule || 'Rename',
        t.ruleLibraryFileNamePlaceholder || 'Rule set name',
        displayName,
    );
    if (!newName || !newName.trim() || newName.trim() === displayName) return;

    const normalized = `${newName.trim()}.prism.yaml`;

    try {
        await invoke(COMMANDS.RULE_RENAME, { oldFilename, newFilename: normalized });
        showNotification(`${t.ruleLibraryRenameRule || 'Renamed'}: ${normalized}`, 'success');
        try { await prism.apply(); } catch (e) { rulesLogger.warn("[prism] apply failed:", e); }
        await refreshData({ loadActiveRules: true });
        render();
    } catch (err) {
        showNotification(String(err), 'error');
    }
}

/**
 * @param {string} filename
 * @param {boolean} [enabled=true] - false for a parked (.disabled) file, which is re-enabled first so it can be removed
 */
async function handleDeleteRule(filename, enabled = true) {
    const t = /** @type {Record<string, string>} */ (/** @type {any} */ (translations)[currentLang]);
    const count = ruleFiles.find((f) => f.filename === filename)?.rule_count || 0;
    const confirmed = await showConfirmModal(
        (t.ruleLibraryDeleteFileTitle || 'Delete “@@name@@”?').replace('@@name@@', filename.replace(/(\.prism)?\.(ya?ml|txt|list)$/i, '')),
        count > 0
            ? (t.ruleLibraryDeleteFileDescCount || 'Its **@@count@@ rules** are removed from the configuration right away. This cannot be undone.').replace('@@count@@', String(count))
            : t.ruleLibraryDeleteFileDesc || 'Its rules are removed from the configuration right away. This cannot be undone.',
        { danger: true, confirmText: t.delete || 'Delete' },
    );
    if (!confirmed) return;

    try {
        if (!enabled && !(await prism.toggleGroup(filename, true))) throw new Error(`Could not re-enable ${filename} for deletion`);
        try {
            await invoke(COMMANDS.RULE_DELETE, { filename });
        } catch (delErr) {
            // Put a switched-off file back the way it was: its rules must not come back.
            if (!enabled) await prism.toggleGroup(filename, false).catch(() => {});
            throw delErr;
        }
        showNotification(`${t.ruleLibraryDeleteRule}: ${filename}`, 'success');
        // Rebuild so the deleted file's rules leave the running config (apply only adds).
        try { await prism.rebuild(); } catch (e) {
            rulesLogger.warn('[prism] rebuild failed, falling back to apply:', e);
            showNotification(String(e), 'error');
            try { await prism.apply(); } catch (error_) { rulesLogger.warn('[prism] apply failed:', error_); }
        }
        await refreshData({ loadActiveRules: true });
        render();
    } catch (err) {
        showNotification(String(err), 'error');
    }
}

/**
 * Build the rule editor HTML.
 * @param {Record<string, string>} t
 * @returns {string}
 */
function buildEditorHtml(t) {
    return `
        <div class="rl-editor flex flex-col overflow-hidden" style="max-height: calc(65vh - 6rem)">
            <div class="flex items-center justify-between gap-3 shrink-0">
                <div class="seg-tabs" role="tablist">
                    <button type="button" role="tab" data-rl-mode="visual" aria-selected="true" class="rl-editor-mode seg-tab active">${escapeHtml(t.ruleLibraryModeVisual || 'Visual')}</button>
                    <button type="button" role="tab" data-rl-mode="text" aria-selected="false" class="rl-editor-mode seg-tab">${escapeHtml(t.ruleLibraryModeText || 'Text')}</button>
                </div>
                <button type="button" id="rl-editor-add" class="btn-accent">
                    <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>
                    <span>${escapeHtml(t.ruleLibraryAddRule || 'Add rule')}</span>
                </button>
            </div>
            <div id="rl-editor-visual-wrap" class="rl-editor-list flex-1 min-h-0 flex flex-col mt-4">
                <div id="rl-editor-new" class="hidden rl-rule-row is-editing shrink-0"></div>
                <div id="rl-editor-visual" class="flex-1 min-h-0 overflow-y-auto overflow-x-clip custom-scrollbar relative">
                    <div id="rl-vs-spacer-top" style="height:0"></div>
                    <div id="rl-vs-lines"></div>
                    <div id="rl-vs-spacer-bottom" style="height:0"></div>
                </div>
                <div id="rl-editor-empty" class="hidden py-8 text-center text-xs text-[var(--text-muted)]">${escapeHtml(t.ruleLibraryNoRulesInFile || 'No rules in this file')}</div>
            </div>
            <div id="rl-editor-text" class="hidden flex-1 min-h-0 overflow-y-auto custom-scrollbar mt-4">
                <textarea id="rl-editor-textarea" class="form-control form-control-mono hidden w-full min-h-full p-4 text-xs resize-none" aria-label="${escapeAttr(t.ruleLibraryRuleEditor || 'Rule Editor')}" spellcheck="false"></textarea>
                <div id="rl-editor-cm6" data-code-editor class="w-full min-h-full bg-[var(--zephyr-bg-input)] border border-[var(--zephyr-border-default)] rounded-xl overflow-hidden"></div>
            </div>
            <div class="flex items-center gap-2 pt-3 mt-3 border-t border-[var(--zephyr-border-subtle)] shrink-0">
                <div id="rl-editor-dirty" class="rl-dirty hidden">${escapeHtml(t.unsavedChanges || 'Unsaved changes')}</div>
                <div class="flex items-center gap-2 ms-auto">
                    <button type="button" id="rl-editor-cancel" class="btn-ghost">${escapeHtml(t.cancel || 'Cancel')}</button>
                    <button type="button" id="rl-editor-save" class="btn-primary">${escapeHtml(t.ruleLibrarySaveApply || 'Save and apply')}</button>
                </div>
            </div>
        </div>
    `;
}

/**
 * Markup of the inline rule form (type / match / policy / ✓ ✕).
 * @param {string} prefix - id prefix
 * @param {{type: string, value: string, policy: string}} draft
 * @param {string[]} policies
 * @param {Record<string, string>} t
 * @returns {string}
 */
function ruleFormRowHtml(prefix, draft, policies, t) {
    const typeOptions = RULE_TYPES.map((r) => ({ value: r.value, label: ruleTypeLabel(r.value, t) }));
    if (draft.type && !RULE_TYPES.some((r) => r.value === draft.type)) typeOptions.push({ value: draft.type, label: draft.type });
    const policyList = draft.policy && !policies.includes(draft.policy) ? [draft.policy, ...policies] : policies;
    const policyOptions = policyList.map((p) => ({ value: p, label: p }));
    return `
        <div class="rl-rule-form">
            ${dropdownHtml(`${prefix}-type`, typeOptions, draft.type || 'DOMAIN-SUFFIX', t.ruleLibraryRuleType || 'Rule type')}
            <input id="${prefix}-value" type="text" class="form-control form-control-md form-control-mono rl-rule-form-value" placeholder="example.com" value="${escapeAttr(draft.value)}" aria-label="${escapeAttr(t.ruleLibraryRuleMatch || 'Match')}" spellcheck="false" ${draft.type === 'MATCH' ? 'disabled' : ''} />
            ${dropdownHtml(`${prefix}-policy`, policyOptions, draft.policy || policyList[0] || 'DIRECT', t.ruleLibraryRulePolicy || 'Then use')}
            <button type="button" id="${prefix}-ok" class="rl-icon-btn is-ok" title="${escapeAttr(t.confirm || 'Confirm')}" aria-label="${escapeAttr(t.confirm || 'Confirm')}">
                <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>
            </button>
            <button type="button" id="${prefix}-cancel" class="rl-icon-btn" title="${escapeAttr(t.cancel || 'Cancel')}" aria-label="${escapeAttr(t.cancel || 'Cancel')}">
                <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
            </button>
        </div>
    `;
}

/**
 * Wire an inline rule form that is already in the document.
 * @param {string} prefix
 * @param {{type: string, value: string, policy: string, extra: string[]}} draft - updated as the user edits
 * @param {(line: string) => void} onCommit
 * @param {() => void} onCancel
 * @returns {() => void} dispose
 */
function bindRuleForm(prefix, draft, onCommit, onCancel) {
    const valueInput = /** @type {HTMLInputElement|null} */ (document.getElementById(`${prefix}-value`));
    const typeDd = initCustomDropdown({
        wrapId: `${prefix}-type-wrap`, triggerId: `${prefix}-type-trigger`, menuId: `${prefix}-type-menu`,
        labelId: `${prefix}-type-label`, selectId: `${prefix}-type-select`,
        onChange: (/** @type {string} */ v) => {
            draft.type = v;
            if (valueInput) {
                valueInput.disabled = v === 'MATCH';
                if (v === 'MATCH') { valueInput.value = ''; draft.value = ''; }
            }
        },
    });
    const policyDd = initCustomDropdown({
        wrapId: `${prefix}-policy-wrap`, triggerId: `${prefix}-policy-trigger`, menuId: `${prefix}-policy-menu`,
        labelId: `${prefix}-policy-label`, selectId: `${prefix}-policy-select`,
        onChange: (/** @type {string} */ v) => { draft.policy = v; },
    });
    if (typeDd && !draft.type) draft.type = typeDd.getValue();
    if (policyDd && !draft.policy) draft.policy = policyDd.getValue();

    const commit = () => {
        const value = (valueInput?.value || '').trim();
        if (looksLikeFullRule(value)) { onCommit(value); return; }
        if (draft.type !== 'MATCH' && !value) {
            valueInput?.classList.add('is-invalid');
            valueInput?.setAttribute('aria-invalid', 'true');
            valueInput?.focus();
            return;
        }
        onCommit(buildRuleLine(draft.type, value, draft.policy, draft.extra));
    };
    valueInput?.addEventListener('input', () => {
        draft.value = valueInput.value;
        valueInput.classList.remove('is-invalid');
        valueInput.removeAttribute('aria-invalid');
    });
    valueInput?.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
    });
    document.getElementById(`${prefix}-ok`)?.addEventListener('click', (ev) => { ev.stopPropagation(); commit(); });
    document.getElementById(`${prefix}-cancel`)?.addEventListener('click', (ev) => { ev.stopPropagation(); onCancel(); });
    return () => {
        typeDd?.dispose();
        policyDd?.dispose();
    };
}

/**
 * @param {string} filename
 */
async function handleEditRule(filename) {
    const t = /** @type {Record<string, string>} */ (/** @type {any} */ (translations)[currentLang]);

    let content = '';
    try {
        content = await invoke(COMMANDS.RULE_READ, { filename });
    } catch (err) {
        showNotification(String(err), 'error');
        return;
    }

    // Parse rules from YAML content for visual editor
    let rules = parseRulesFromYaml(content);
    const originalText = rules.join('\n');
    const policies = await loadPolicyNames(() => fetchProxyGroups());

    /** @type {'visual'|'text'} */
    let editorMode = 'visual';
    /** @type {import('../utils/virtual-scroll.js').VirtualScrollHandle|null} */
    let ruleVs = null;
    /** @type {(() => void)|null} */
    let disposeNewForm = null;
    /** @type {(() => void)|null} */
    let disposeEditForm = null;

    // The inline rule form needs more room than the standard 560px dialog.
    const modalContainer = document.getElementById('modal-container');
    await showModal(filename, '', '', true, buildEditorHtml(t), (contentArea, closeEditor) => {
        if (modalContainer) modalContainer.style.width = 'min(720px, 92vw)';
        const visualWrap = /** @type {HTMLElement} */ (contentArea.querySelector('#rl-editor-visual-wrap'));
        const visualContainer = /** @type {HTMLElement} */ (contentArea.querySelector('#rl-editor-visual'));
        const textContainer = contentArea.querySelector('#rl-editor-text');
        const textarea = /** @type {HTMLTextAreaElement} */ (contentArea.querySelector('#rl-editor-textarea'));
        const cm6Container = /** @type {HTMLElement} */ (contentArea.querySelector('#rl-editor-cm6'));
        const addBtn = /** @type {HTMLElement} */ (contentArea.querySelector('#rl-editor-add'));
        const saveBtn = /** @type {HTMLButtonElement} */ (contentArea.querySelector('#rl-editor-save'));
        const newRow = /** @type {HTMLElement} */ (contentArea.querySelector('#rl-editor-new'));
        const emptyEl = contentArea.querySelector('#rl-editor-empty');
        const dirtyEl = contentArea.querySelector('#rl-editor-dirty');

        if (!visualWrap || !visualContainer || !textContainer || !textarea || !cm6Container) return;

        textarea.value = content;

        /** Index of the row being edited in place, or null. */
        /** @type {number|null} */
        let editingIndex = null;
        /** @type {{type: string, value: string, policy: string, extra: string[]}} */
        let editDraft = { type: '', value: '', policy: '', extra: [] };
        let editFocused = false;
        /** @type {number|null} */
        let dragSourceIndex = null;

        const currentRules = () => {
            if (editorMode === 'text') {
                const text = ruleEditorView ? getEditorContent(ruleEditorView) : textarea.value;
                return text.split('\n').map((l) => l.trim()).filter(Boolean);
            }
            return rules;
        };
        const updateDirty = () => {
            const dirty = currentRules().join('\n') !== originalText;
            dirtyEl?.classList.toggle('hidden', !dirty);
        };
        const updateEmpty = () => {
            emptyEl?.classList.toggle('hidden', rules.length > 0 || !newRow.classList.contains('hidden'));
        };

        // ── Virtual scroll for rule editor (shared module) ──
        const vsSpacerTop = /** @type {HTMLElement} */ (visualContainer.querySelector('#rl-vs-spacer-top'));
        const vsLinesContainer = /** @type {HTMLElement} */ (visualContainer.querySelector('#rl-vs-lines'));
        const vsSpacerBottom = /** @type {HTMLElement} */ (visualContainer.querySelector('#rl-vs-spacer-bottom'));

        const vs = createVirtualScroll({
            container: visualContainer,
            spacerTop: vsSpacerTop,
            spacerBottom: vsSpacerBottom,
            linesContainer: vsLinesContainer,
            itemCount: () => rules.length,
            renderItem: (idx, fragment) => {
                const rule = rules[idx];
                if (rule === undefined) return;
                fragment.appendChild(idx === editingIndex ? createEditRow(idx) : createRuleRow(rule, idx));
            },
            dataAttr: 'data-rule-index',
            rowHeightEst: 44,
            overscanPx: 500,
            scrollQuantumPx: 300,
            maxMounted: 80,
        });
        ruleVs = vs;

        const refreshList = () => {
            vs.clearHeightCache();
            vs.invalidate();
            updateEmpty();
            updateDirty();
            if (editingIndex !== null) requestAnimationFrame(bindEditRow);
        };

        /**
         * Row in edit mode (form). Its dropdowns are wired once it is in the document.
         * @param {number} index
         */
        function createEditRow(index) {
            const row = document.createElement('div');
            row.id = 'rl-edit-row';
            row.className = 'rl-rule-row is-editing';
            row.dataset.ruleIndex = String(index);
            // eslint-disable-next-line no-unsanitized/property -- values escaped in ruleFormRowHtml() // nosemgrep: js-innerhtml-assignment — verified safe, see eslint-disable above
            row.innerHTML = ruleFormRowHtml('rl-edit', editDraft, policies, t);
            return row;
        }

        function bindEditRow() {
            const row = document.getElementById('rl-edit-row');
            if (!row || row.dataset.bound === '1') return;
            row.dataset.bound = '1';
            disposeEditForm?.();
            disposeEditForm = bindRuleForm('rl-edit', editDraft, (line) => {
                if (editingIndex !== null) rules[editingIndex] = line;
                stopEditing();
            }, stopEditing);
            // Re-mounted after a scroll keeps the caret where it was; only the first mount takes focus.
            if (!editFocused) {
                editFocused = true;
                /** @type {HTMLInputElement|null} */ (document.getElementById('rl-edit-value'))?.focus();
            }
        }

        /**
         * Change `rules` and keep the open edit row on the same rule (or close it
         * when that rule is removed). `op` is applied to a copy of the indices too.
         * @param {(arr: any[]) => void} op
         */
        function mutateRules(op) {
            if (editingIndex !== null) {
                const ids = rules.map((_, i) => i);
                op(ids);
                const at = ids.indexOf(editingIndex);
                if (at < 0) { disposeEditForm?.(); disposeEditForm = null; editingIndex = null; }
                else editingIndex = at;
            }
            op(rules);
            refreshList();
        }

        /**
         * Commit the open edit row and the new-rule form, as their ✓ would.
         * @returns {boolean} false when one of them is invalid and stays open
         */
        function commitOpenForms() {
            if (editingIndex !== null) {
                const ok = document.getElementById('rl-edit-ok');
                if (ok) {
                    ok.click();
                } else {
                    // The edit row scrolled out of the virtual list: commit its draft directly.
                    const value = editDraft.value.trim();
                    if (looksLikeFullRule(value)) rules[editingIndex] = value;
                    // An emptied value (out of sight) is an abandoned edit: the rule stays as it was.
                    else if (editDraft.type === 'MATCH' || value) rules[editingIndex] = buildRuleLine(editDraft.type, value, editDraft.policy, editDraft.extra);
                    stopEditing();
                }
                if (editingIndex !== null) return false;
            }
            if (!newRow.classList.contains('hidden')) {
                const valueInput = /** @type {HTMLInputElement|null} */ (document.getElementById('rl-new-value'));
                // MATCH disables the field on purpose: an empty value is only an abandoned form otherwise.
                if (!valueInput?.value.trim() && !valueInput?.disabled) { closeNewForm(); return true; }
                document.getElementById('rl-new-ok')?.click();
                if (!newRow.classList.contains('hidden')) return false;
            }
            return true;
        }

        function stopEditing() {
            disposeEditForm?.();
            disposeEditForm = null;
            editingIndex = null;
            refreshList();
        }

        /** @param {number} index */
        function startEditing(index) {
            closeNewForm();
            disposeEditForm?.();
            disposeEditForm = null;
            const parsed = parseRuleLine(rules[index]);
            editDraft = { type: parsed.type, value: parsed.value, policy: parsed.policy, extra: parsed.extra };
            editingIndex = index;
            editFocused = false;
            refreshList();
        }

        /**
         * Compact read-only row: number (drag handle) · type · match · policy · ↑ ↓ delete.
         * Click (or Enter) edits it in place.
         * @param {string} rule
         * @param {number} index
         */
        function createRuleRow(rule, index) {
            const { type, value, policy } = parseRuleLine(rule);
            const isRaw = !rule.includes(',');
            const isFirst = index === 0;
            const isLast = index === rules.length - 1;

            const item = document.createElement('div');
            item.className = 'rl-rule-row group';
            item.draggable = true;
            item.tabIndex = 0;
            item.style.setProperty('-webkit-user-drag', 'element');
            item.dataset.ruleIndex = String(index);
            item.setAttribute('aria-label', `${index + 1}. ${rule}`);

            // eslint-disable-next-line no-unsanitized/property -- values escaped via escapeHtml/escapeAttr // nosemgrep: js-innerhtml-assignment — verified safe, see eslint-disable above
            item.innerHTML = `
                <span class="rl-rule-num cursor-grab active:cursor-grabbing select-none" title="${escapeAttr(t.ruleLibraryDragToReorder || 'Drag to reorder')}">${index + 1}</span>
                ${isRaw ? '' : `<span class="type-badge text-[var(--text-muted)] shrink-0">${escapeHtml(type)}</span>`}
                <span class="rl-rule-value font-mono truncate" title="${escapeAttr(isRaw ? rule : value)}">${escapeHtml(isRaw ? rule : value)}</span>
                <span class="rl-rule-policy text-xs font-semibold truncate ${getPolicyColor(policy)}">${escapeHtml(policy)}</span>
                <span class="rl-rule-actions">
                    <button type="button" class="rl-icon-btn btn-rl-rule-up ${isFirst ? 'invisible' : ''}" title="${escapeAttr(t.moveUp || 'Move up')}" aria-label="${escapeAttr(t.moveUp || 'Move up')}">${SVG_ICONS.arrowUp}</button>
                    <button type="button" class="rl-icon-btn btn-rl-rule-down ${isLast ? 'invisible' : ''}" title="${escapeAttr(t.moveDown || 'Move down')}" aria-label="${escapeAttr(t.moveDown || 'Move down')}">${SVG_ICONS.arrowDown}</button>
                    <button type="button" class="rl-icon-btn is-danger btn-rl-rule-del" title="${escapeAttr(t.delete || 'Delete')}" aria-label="${escapeAttr(t.delete || 'Delete')}">${SVG_ICONS.trash}</button>
                </span>
            `;

            item.addEventListener('click', (ev) => {
                if (ev.target instanceof Element && ev.target.closest('button')) return;
                startEditing(index);
            });
            item.addEventListener('keydown', (ev) => {
                if (ev.target === item && (ev.key === 'Enter' || ev.key === 'F2')) { ev.preventDefault(); startEditing(index); }
            });

            item.querySelector('.btn-rl-rule-up')?.addEventListener('click', (ev) => {
                ev.stopPropagation();
                if (index === 0) return;
                mutateRules((a) => { [a[index - 1], a[index]] = [a[index], a[index - 1]]; });
            });
            item.querySelector('.btn-rl-rule-down')?.addEventListener('click', (ev) => {
                ev.stopPropagation();
                if (index >= rules.length - 1) return;
                mutateRules((a) => { [a[index + 1], a[index]] = [a[index], a[index + 1]]; });
            });
            item.querySelector('.btn-rl-rule-del')?.addEventListener('click', (ev) => {
                ev.stopPropagation();
                mutateRules((a) => { a.splice(index, 1); });
            });

            // Drag & Drop
            item.addEventListener('dragstart', (/** @type {DragEvent} */ ev) => {
                dragSourceIndex = index;
                if (ev.dataTransfer) {
                    ev.dataTransfer.effectAllowed = 'move';
                    ev.dataTransfer.setData('text/plain', String(index));
                }
                requestAnimationFrame(() => item.classList.add('opacity-40'));
            });
            item.addEventListener('dragend', () => {
                item.classList.remove('opacity-40');
                dragSourceIndex = null;
                vsLinesContainer.querySelectorAll('.rl-drop-indicator').forEach((el) => el.remove());
            });
            item.addEventListener('dragover', (/** @type {DragEvent} */ ev) => {
                ev.preventDefault();
                if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move';
                vsLinesContainer.querySelectorAll('.rl-drop-indicator').forEach((el) => el.remove());
                const rect = item.getBoundingClientRect();
                const indicator = document.createElement('div');
                indicator.className = 'rl-drop-indicator h-0.5 bg-accent rounded-full mx-2';
                if (ev.clientY < rect.top + (rect.height / 2)) item.parentNode?.insertBefore(indicator, item);
                else item.parentNode?.insertBefore(indicator, item.nextSibling);
            });
            item.addEventListener('drop', (ev) => {
                ev.preventDefault();
                vsLinesContainer.querySelectorAll('.rl-drop-indicator').forEach((el) => el.remove());
                if (dragSourceIndex === null || dragSourceIndex === index) return;
                const rect = item.getBoundingClientRect();
                let targetIndex = ev.clientY < rect.top + (rect.height / 2) ? index : index + 1;
                const from = dragSourceIndex;
                if (targetIndex > from) targetIndex--;
                const to = targetIndex;
                dragSourceIndex = null;
                mutateRules((a) => { const [moved] = a.splice(from, 1); a.splice(to, 0, moved); });
            });

            return item;
        }

        // ── New rule: an inline form above the list (the list stays as it is) ──
        function closeNewForm() {
            disposeNewForm?.();
            disposeNewForm = null;
            newRow.classList.add('hidden');
            newRow.replaceChildren();
            updateEmpty();
        }
        function openNewForm() {
            if (editingIndex !== null) stopEditing();
            if (!newRow.classList.contains('hidden')) {
                /** @type {HTMLInputElement|null} */ (document.getElementById('rl-new-value'))?.focus();
                return;
            }
            // A file usually sends everything to one group: start from the policy of the newest rule.
            const lastPolicy = rules.length ? parseRuleLine(rules[0]).policy : '';
            /** @type {{type: string, value: string, policy: string, extra: string[]}} */
            const draft = { type: 'DOMAIN-SUFFIX', value: '', policy: lastPolicy || '', extra: [] };
            // eslint-disable-next-line no-unsanitized/property -- values escaped in ruleFormRowHtml() // nosemgrep: js-innerhtml-assignment — verified safe, see eslint-disable above
            newRow.innerHTML = ruleFormRowHtml('rl-new', draft, policies, t);
            newRow.classList.remove('hidden');
            updateEmpty();
            disposeNewForm = bindRuleForm('rl-new', draft, (line) => {
                rules.unshift(line);
                closeNewForm();
                visualContainer.scrollTop = 0;
                refreshList();
            }, closeNewForm);
            /** @type {HTMLInputElement|null} */ (document.getElementById('rl-new-value'))?.focus();
        }

        refreshList();
        // The virtual list re-creates rows while scrolling; re-wire the edit row when it comes back.
        visualContainer.addEventListener('scroll', () => {
            if (editingIndex !== null) requestAnimationFrame(bindEditRow);
        }, { passive: true });

        addBtn?.addEventListener('click', (ev) => {
            ev.stopPropagation();
            openNewForm();
        });

        // ── Visual / text ──
        /** @param {'visual'|'text'} mode */
        const setMode = (mode) => {
            if (mode === editorMode) return;
            // Keep what is typed in an open row: commit it, or stay if it is invalid.
            if (mode === 'text' && !commitOpenForms()) return;
            contentArea.querySelectorAll('.rl-editor-mode').forEach((b) => {
                const on = /** @type {HTMLElement} */ (b).dataset.rlMode === mode;
                b.classList.toggle('active', on);
                b.setAttribute('aria-selected', String(on));
            });
            if (mode === 'text') {
                closeNewForm();
                const textContent = rules.join('\n');
                textarea.value = textContent;
                editorMode = 'text';
                visualWrap.classList.add('hidden');
                textContainer.classList.remove('hidden');
                addBtn?.classList.add('hidden');
                if (ruleEditorView) { ruleEditorView.destroy(); ruleEditorView = null; }
                cm6Container.replaceChildren();
                ruleEditorView = createEditor({
                    parent: cm6Container,
                    content: textContent,
                    language: 'yaml',
                    prismDsl: true,
                    onChange: () => updateDirty(),
                });
            } else {
                rules = currentRules();
                editorMode = 'visual';
                textContainer.classList.add('hidden');
                visualWrap.classList.remove('hidden');
                addBtn?.classList.remove('hidden');
                if (ruleEditorView) { ruleEditorView.destroy(); ruleEditorView = null; }
                refreshList();
            }
            updateDirty();
        };
        contentArea.querySelectorAll('.rl-editor-mode').forEach((b) => {
            b.addEventListener('click', (ev) => {
                ev.stopPropagation();
                setMode(/** @type {'visual'|'text'} */ (/** @type {HTMLElement} */ (b).dataset.rlMode));
            });
        });

        contentArea.querySelector('#rl-editor-cancel')?.addEventListener('click', () => closeEditor(null));

        // Save and apply
        saveBtn?.addEventListener('click', async (ev) => {
            ev.stopPropagation();
            if (saveBtn.disabled) return;
            // An open row's edits are part of the save (or it stays open when invalid).
            if (editorMode !== 'text' && !commitOpenForms()) return;
            saveBtn.disabled = true;
            const rawContent = editorMode === 'text'
                ? (ruleEditorView ? getEditorContent(ruleEditorView) : textarea.value)
                : null;
            // A failed write keeps the editor open with the edits, so it can be retried.
            if (!(await handleSaveRules(t, filename, rawContent, rules, content))) { saveBtn.disabled = false; return; }
            if (ruleEditorView) { ruleEditorView.destroy(); ruleEditorView = null; }
            await refreshData({ loadActiveRules: true });
            render();
            closeEditor(null);
        });
    });

    // Modal closed (saved, cancelled, Esc or backdrop): release editor resources.
    if (modalContainer) modalContainer.style.width = '';
    // (casts: TS narrows these to `null` because they are only assigned inside the callback)
    /** @type {(() => void)|null} */ (disposeNewForm)?.();
    /** @type {(() => void)|null} */ (disposeEditForm)?.();
    /** @type {import('../utils/virtual-scroll.js').VirtualScrollHandle|null} */ (ruleVs)?.destroy();
    if (ruleEditorView) { ruleEditorView.destroy(); ruleEditorView = null; }
}

/**
 * View Changes: show which rules a .prism.yaml file contributed to the final config.
 * @param {string} filename
 */
async function handleViewChanges(filename) {
    const t = /** @type {Record<string, string>} */ (/** @type {any} */ (translations)[currentLang]);
    try {
        // Use cached trace from last apply() — no recompilation needed.
        // Fallback to apply() on first use (cache is empty).
        let traces = (await prism.getLastTrace().catch(() => [])) || [];
        if (traces.length === 0) {
            const applyResult = await prism.apply();
            traces = applyResult?.trace || [];
        }
        const match = traces.find(
            (/** @type {any} */ tr) => tr.source_file === filename || tr.source_file === `${filename}.prism.yaml`,
        );
        if (!match) {
            showNotification(`${filename}: ${t.ruleLibraryNoPatch || 'No patch data found'}`, 'warning');
            return;
        }
        const diff = await prism.previewRules(/** @type {any} */ (match).patch_id);

        const added = Array.isArray(diff?.added) ? diff.added : [];
        const removed = Array.isArray(diff?.removed) ? diff.removed : [];
        const modified = Array.isArray(diff?.modified) ? diff.modified : [];
        const totalChanges = added.length + removed.length + modified.length;

        if (totalChanges === 0) {
            showNotification(t.ruleLibraryNoChanges || 'No changes contributed by this file', 'info');
            return;
        }

        let diffHtml = '';
        if (added.length > 0) {
            diffHtml += `<div class="space-y-1">
                <div class="flex items-center gap-2 mb-1">
                    <span class="inline-block w-2 h-2 rounded-full bg-emerald-400"></span>
                    <span class="text-xs font-medium text-emerald-400">+${added.length} ${t.ruleLibraryDiffAdded || 'added'}</span>
                </div>
                ${added.map((/** @type {any} */ r) => `<div class="px-3 py-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-xs text-emerald-300 font-mono">${escapeHtml(typeof r === 'string' ? r : JSON.stringify(r))}</div>`).join('')}
            </div>`;
        }
        if (removed.length > 0) {
            diffHtml += `<div class="space-y-1">
                <div class="flex items-center gap-2 mb-1">
                    <span class="inline-block w-2 h-2 rounded-full bg-rose-400"></span>
                    <span class="text-xs font-medium text-rose-400">-${removed.length} ${t.ruleLibraryDiffRemoved || 'removed'}</span>
                </div>
                ${removed.map((/** @type {any} */ r) => `<div class="px-3 py-1.5 rounded-lg bg-rose-500/10 border border-rose-500/20 text-xs text-rose-300 font-mono">${escapeHtml(typeof r === 'string' ? r : JSON.stringify(r))}</div>`).join('')}
            </div>`;
        }
        if (modified.length > 0) {
            diffHtml += `<div class="space-y-1">
                <div class="flex items-center gap-2 mb-1">
                    <span class="inline-block w-2 h-2 rounded-full bg-amber-400"></span>
                    <span class="text-xs font-medium text-amber-400">~${modified.length} ${t.ruleLibraryDiffModified || 'modified'}</span>
                </div>
                ${modified.map((/** @type {any} */ r) => `<div class="px-3 py-1.5 rounded-lg bg-amber-500/10 border border-amber-500/20 text-xs text-amber-300 font-mono">${escapeHtml(typeof r === 'string' ? r : JSON.stringify(r))}</div>`).join('')}
            </div>`;
        }

        const panelHtml = `
            <div class="space-y-4">
                <div class="flex items-center justify-between">
                    <span class="text-xs text-[var(--text-muted)]">${escapeHtml(filename)}</span>
                    <span class="text-xs text-[var(--text-muted)]">${totalChanges} ${t.ruleLibraryDiffChanges || 'changes'}</span>
                </div>
                <div class="space-y-3 overflow-y-auto max-h-[400px] custom-scrollbar pe-1">${diffHtml}</div>
            </div>
        `;

        await showModal(t.ruleLibraryViewChanges || 'View Changes', '', '', true, panelHtml);
    } catch (err) {
        showNotification(String(err), 'error');
    }
}

/**
 * Handle saving rules from the editor.
 * @param {Record<string,string>} t
 * @param {string} filename
 * @param {string|null} rawContent - If text mode, the raw textarea value; if visual mode, null
 * @param {string[]} rules - Current rules array (from visual editor)
 * @param {string} originalContent - Original file content (for preserving metadata)
 * @returns {Promise<boolean>} false when the file could not be written
 */
async function handleSaveRules(t, filename, rawContent, rules, originalContent) {
    try {

        let finalContent;
        if (rawContent !== null) {
            // Text mode: use raw content as-is
            // But for .prism.yaml files, ensure the content is valid YAML
            if (filename.endsWith('.prism.yaml') || filename.endsWith('.prism.yml')) {
                finalContent = wrapRulesAsPrismYaml(rawContent, originalContent);
            } else {
                finalContent = rawContent;
            }
        } else {
            // Visual mode: rebuild YAML with rules, preserving __when__ and other metadata
            finalContent = rebuildYamlWithRules(originalContent, rules);
        }

        await invoke(COMMANDS.RULE_UPDATE, { filename, content: finalContent });
        // Count actual rule lines (TYPE,value[,policy]), not every YAML line.
        const ruleCount = finalContent.split('\n')
            .map((l) => l.trim().replace(/^-\s*/, ''))
            .filter((l) => /^[A-Z][A-Z0-9-]*,/.test(l)).length;

        try {
            await prism.apply();
            showNotification(
                (t.ruleLibrarySavedApplied || 'Saved and applied · @@count@@ rules').replace('@@count@@', String(ruleCount)),
                'success',
            );
        } catch (applyErr) {
            showNotification(
                `${t.ruleLibrarySavedApplyFailed || 'Saved, but applying failed'}: ${applyErr}`,
                'warning',
            );
        }
        return true;
    } catch (err) {
        showNotification(String(err), 'error');
        return false;
    }
}

// ═══════════════════════════════════════════════════════════════════════
//  Import dialog
// ═══════════════════════════════════════════════════════════════════════

async function handleImportRules() {
    const t = /** @type {Record<string, string>} */ (/** @type {any} */ (translations)[currentLang]);

    /** @type {'paste'|'file'|'url'} */
    let importMode = 'paste';

    const importHtml = `
        <div class="space-y-4">
            <p class="text-xs text-[var(--text-muted)]">${escapeHtml(t.ruleLibraryImportHint || '')}</p>
            <div class="seg-tabs" role="tablist">
                <button type="button" role="tab" data-rl-import-tab="paste" class="rl-import-tab seg-tab active">${escapeHtml(t.ruleLibraryImportPaste || 'Paste rules text')}</button>
                <button type="button" role="tab" data-rl-import-tab="file" class="rl-import-tab seg-tab">${escapeHtml(t.ruleLibraryImportFile || 'Select file')}</button>
                <button type="button" role="tab" data-rl-import-tab="url" class="rl-import-tab seg-tab">${escapeHtml(t.ruleLibraryImportUrl || 'Import from URL')}</button>
            </div>
            <div id="rl-import-paste" class="space-y-2">
                <div class="textarea-paste-wrapper">
                    <textarea id="rl-import-text" aria-label="${escapeAttr(t.ruleLibraryImportPaste || 'Rule Text')}" class="form-control form-control-mono w-full h-32 rounded-xl p-3 text-xs resize-none custom-scrollbar" placeholder="${escapeAttr(t.ruleLibraryImportPaste || '')}" spellcheck="false"></textarea>
                    ${renderPasteButtonHtml('rl-import-paste-btn', t.paste || 'Paste', true)}
                </div>
            </div>
            <div id="rl-import-file" class="hidden space-y-3">
                <!-- A real file picker (read in the page, then imported as text) instead of typing a path. -->
                <label class="rl-import-drop" for="rl-import-file-input">
                    <input id="rl-import-file-input" type="file" accept=".yaml,.yml,.txt,.list,.conf" class="sr-only" />
                    <div id="rl-import-file-label">${escapeHtml(t.ruleLibraryChooseFile || 'Choose a file or drop it here')}</div>
                </label>
            </div>
            <div id="rl-import-url" class="hidden space-y-3">
                <div class="input-paste-wrapper">
                    <input id="rl-import-url-input" aria-label="${escapeAttr(t.ruleLibraryImportUrl || 'Import from URL')}" type="text" class="form-control form-control-lg" placeholder="https://..." />
                    ${renderPasteButtonHtml('rl-import-url-paste-btn', t.paste || 'Paste', false)}
                </div>
            </div>
            <div class="space-y-2">
                <label for="rl-import-name" class="text-xs text-[var(--text-muted)]">${escapeHtml(t.ruleLibraryRuleSetName || 'Rule set name')}</label>
                <input id="rl-import-name" type="text" class="form-control form-control-lg" placeholder="my-rules" />
            </div>
            <div id="rl-import-error" class="hidden text-xs text-[var(--zephyr-color-danger)]" aria-live="polite"></div>
            <div class="flex items-center justify-end gap-2 pt-2">
                <button type="button" id="rl-import-confirm" class="btn-primary">
                    ${escapeHtml(t.ruleLibraryImportConfirm || 'Import')}
                </button>
            </div>
        </div>
    `;

    void showModal(
        t.ruleLibraryImport || 'Import Rules',
        '',
        '',
        true,
        importHtml,
        (contentArea, close) => {
            // Wire up paste buttons
contentArea.querySelector('#rl-import-paste-btn')?.addEventListener('click', () => {
    const textarea = /** @type {HTMLTextAreaElement | null} */ (contentArea.querySelector('#rl-import-text'));
    if (textarea) void pasteWithFeedback(textarea, showNotification, translations, currentLang);
});
contentArea.querySelector('#rl-import-url-paste-btn')?.addEventListener('click', () => {
    const urlInput = /** @type {HTMLInputElement | null} */ (contentArea.querySelector('#rl-import-url-input'));
    if (urlInput) void pasteWithFeedback(urlInput, showNotification, translations, currentLang);
});

            // Wire up import tab switching
            const importTabs = contentArea.querySelectorAll('.rl-import-tab');
            const pastePanel = contentArea.querySelector('#rl-import-paste');
            const filePanel = contentArea.querySelector('#rl-import-file');
            const urlPanel = contentArea.querySelector('#rl-import-url');

            importTabs.forEach((tab) => {
                tab.addEventListener('click', (ev) => {
                    ev.stopPropagation();
                    importMode = /** @type {'paste'|'file'|'url'} */ (/** @type {HTMLElement} */ (tab).dataset.rlImportTab);

                    importTabs.forEach((tabItem) => {
                        tabItem.classList.toggle('active', tabItem === tab);
                        tabItem.setAttribute('aria-selected', tabItem === tab ? 'true' : 'false');
                    });
                    showError('');

                    pastePanel?.classList.toggle('hidden', importMode !== 'paste');
                    filePanel?.classList.toggle('hidden', importMode !== 'file');
                    urlPanel?.classList.toggle('hidden', importMode !== 'url');
                });
            });

            const errorEl = contentArea.querySelector('#rl-import-error');
            /** @param {string} msg */
            function showError(msg) {
                if (!errorEl) return;
                errorEl.textContent = msg;
                errorEl.classList.toggle('hidden', !msg);
            }

            // File: read it here and import as text (no path typing, no backend change).
            /** @type {string} */
            let fileText = '';
            const fileInput = /** @type {HTMLInputElement|null} */ (contentArea.querySelector('#rl-import-file-input'));
            const fileLabel = contentArea.querySelector('#rl-import-file-label');
            const nameInputEl = /** @type {HTMLInputElement|null} */ (contentArea.querySelector('#rl-import-name'));
            let takeSeq = 0;
            /** @param {File|undefined|null} file */
            const takeFile = async (file) => {
                if (!file) return;
                // The latest pick wins, even when an earlier read finishes after it.
                const seq = ++takeSeq;
                // Same 10 MB cap as the backend: do not read a huge file into memory.
                if (file.size > MAX_IMPORT_BYTES) {
                    fileText = '';
                    showError(`${file.name}: > ${MAX_IMPORT_BYTES / 1024 / 1024} MB`);
                    return;
                }
                const text = await file.text();
                if (seq !== takeSeq) return;
                fileText = text;
                if (fileLabel) fileLabel.textContent = file.name;
                if (nameInputEl && !nameInputEl.value.trim()) nameInputEl.value = file.name.replace(/\.[^.]+$/, '');
                showError('');
            };
            fileInput?.addEventListener('change', () => takeFile(fileInput.files?.[0]));
            const drop = contentArea.querySelector('.rl-import-drop');
            drop?.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('is-over'); });
            drop?.addEventListener('dragleave', () => drop.classList.remove('is-over'));
            drop?.addEventListener('drop', (e) => {
                e.preventDefault();
                drop.classList.remove('is-over');
                void takeFile(/** @type {DragEvent} */ (e).dataTransfer?.files?.[0]);
            });

            // Wire up import confirm button: validate in place, close only once the import worked.
            contentArea.querySelector('#rl-import-confirm')?.addEventListener('click', async (ev) => {
                ev.stopPropagation();

                const btn = /** @type {HTMLButtonElement} */ (ev.currentTarget);
                const name = nameInputEl?.value.trim() || 'imported-rules';
                if (btn.dataset.busy === 'true') return;

                const text = /** @type {HTMLTextAreaElement} */ (contentArea.querySelector('#rl-import-text'))?.value.trim();
                const url = /** @type {HTMLInputElement} */ (contentArea.querySelector('#rl-import-url-input'))?.value.trim();
                if (importMode === 'paste' && !text) { showError(t.ruleLibraryImportNeedText || 'Paste some rules first'); return; }
                if (importMode === 'file' && !fileText.trim()) { showError(t.ruleLibraryImportNeedFile || 'Choose a file first'); return; }
                if (importMode === 'url' && !/^https?:\/\/\S+$/i.test(url || '')) { showError(t.ruleLibraryImportNeedUrl || 'Enter a valid http(s) link'); return; }

                btn.dataset.busy = 'true';
                btn.disabled = true;
                const label = btn.textContent;
                btn.textContent = t.ruleLibraryImportApplying || 'Importing...';
                showError('');
                try {
                    let createdFile = '';
                    if (importMode === 'paste') createdFile = await invoke(COMMANDS.RULE_IMPORT_TEXT, { text, name });
                    else if (importMode === 'file') createdFile = await invoke(COMMANDS.RULE_IMPORT_TEXT, { text: fileText, name });
                    else createdFile = await invoke(COMMANDS.RULE_IMPORT_URL, { url, name });

                    close(null);
                    try { await prism.apply(); } catch (e) { rulesLogger.warn("[prism] apply failed:", e); }
                    await refreshData({ loadActiveRules: true });
                    render();
                    showNotification(`${t.ruleLibraryImport}: ${createdFile || name}`, 'success');
                } catch (err) {
                    showError(String(err));
                    btn.disabled = false;
                    btn.textContent = label;
                } finally {
                    delete btn.dataset.busy;
                }
            });
        },
    );
}

// ═══════════════════════════════════════════════════════════════════════
//  Extract from subscription
// ═══════════════════════════════════════════════════════════════════════

async function handleExtractFromSubscription() {
    const t = /** @type {Record<string, string>} */ (/** @type {any} */ (translations)[currentLang]);

    // 列出所有可用 profile
    let profiles = [];
    try {
        profiles = await prism.listProfiles();
    } catch {
        // Profiles 可能不可用
    }

    if (!profiles || profiles.length === 0) {
        showNotification(t.ruleLibraryNoSubscriptions || 'No subscriptions yet', 'info');
        return;
    }

    // ── Profile 选择逻辑 ──
    // 如果只有一个 profile，直接使用，无需选择
    let selectedProfileId = null;
    if (profiles.length === 1) {
        selectedProfileId = profiles[0].id || profiles[0].name || profiles[0];
    } else {
        // 多个 profile：弹出选择对话框
        const profileOptionsHtml = profiles
            .map((/** @type {any} */ p, /** @type {number} */ i) => {
                const pName = p.name || p.label || p.id || `Profile ${i + 1}`;
                const pId = p.id || p.name || p;
                return `<button type="button" class="w-full text-start px-4 py-3 text-sm text-[var(--text-secondary)] hover:bg-accent/10 hover:text-accent transition-colors rounded-lg flex items-center justify-between group/prof" data-profile-id="${escapeAttr(String(pId))}">
                    <span>${escapeHtml(String(pName))}</span>
                    <span class="text-xs text-[var(--text-muted)]">${escapeHtml(String(pId))}</span>
                </button>`;
            })
            .join('');

        const selectResult = await showModal(
            t.ruleLibrarySelectProfile || 'Select Profile',
            '',
            '',
            true,
            `<div class="space-y-1">${profileOptionsHtml}</div>`,
            (contentArea, close) => {
                contentArea.querySelectorAll('[data-profile-id]').forEach((btn) => {
                    btn.addEventListener('click', () => close(/** @type {HTMLElement} */ (btn)));
                });
            },
        );

        if (!selectResult) return;

        // selectResult is the clicked button element (passed via onReady close)
        selectedProfileId = /** @type {string} */ ((/** @type {HTMLElement} */ (selectResult)).dataset.profileId);
    }

    if (!selectedProfileId) return;

    // ── 名称输入框 ──
    const name = await showModal(
        t.ruleLibrarySubscriptionExtract || 'Extract Rules to Library',
        t.ruleLibraryFileNamePlaceholder || 'Rule set name',
        'extracted-rules',
    );
    if (!name || !name.trim()) return;

    try {
        const createdFile = await invoke(COMMANDS.RULE_EXTRACT_FROM_PROFILE, {
            profileId: String(selectedProfileId),
            name: name.trim(),
        });
        showNotification(`${t.ruleLibraryExtracted}: ${createdFile || name.trim()}`, 'success');
        try { await prism.apply(); } catch (e) { rulesLogger.warn("[prism] apply failed:", e); }
        await refreshData({ loadActiveRules: true });
        render();
    } catch (err) {
        showNotification(String(err), 'error');
    }
}

// ═══════════════════════════════════════════════════════════════════════
//  Trace
// ═══════════════════════════════════════════════════════════════════════

/**
 * Rule matching trace report for the whole engine. Opened from the Active Rules toolbar
 * and from a rule row's right-click menu.
 * @param {string} [_rule]
 * @param {number} [_index]
 */
async function handleTraceRule(_rule, _index) {
    const t = /** @type {Record<string, string>} */ (/** @type {any} */ (translations)[currentLang]);

    try {
        const report = await prism.traceReportText();
        const reportStr = typeof report === 'string' ? report : JSON.stringify(report, null, 2);
        const body = reportStr.trim()
            ? `<pre class="glass-card p-4 text-xs text-[var(--text-secondary)] font-mono leading-relaxed whitespace-pre-wrap break-all overflow-y-auto max-h-[400px] custom-scrollbar">${escapeHtml(reportStr)}</pre>`
            : `<p class="py-8 text-center text-xs text-[var(--text-muted)]">${escapeHtml(t.ruleLibraryTraceEmpty || 'No trace yet')}</p>`;
        const panelHtml = `<div class="space-y-3">${body}</div>`;

        await showModal(
            t.ruleLibraryTraceReport || 'Match trace',
            '',
            '',
            true,
            panelHtml,
        );
    } catch (err) {
        showNotification(String(err), 'error');
    }
}

// ═══════════════════════════════════════════════════════════════════════
//  Helpers
// ═══════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════
