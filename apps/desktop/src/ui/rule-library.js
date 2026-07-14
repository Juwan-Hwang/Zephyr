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

// ═══════════════════════════════════════════════════════════════════════
//  Internal state
// ═══════════════════════════════════════════════════════════════════════

/** @type {'rule-sets'|'active-rules'} */
let activeTab = 'rule-sets';

/** @type {any|null} CodeMirror EditorView for the rule text editor (null when not active). */
let ruleEditorView = null;

/** @type {{filename: string, rule_count: number, source: string}[]} */
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
            handleNewGroup();
        });

        document.getElementById('rl-btn-import')?.addEventListener('click', (e) => {
            e.stopPropagation();
            handleImportRules();
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
    updateStatusBar();
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
            if (isError) dotColor = 'bg-danger';
            else if (isCompiling) dotColor = 'bg-warning animate-pulse';
            else dotColor = 'bg-success';
            let stateLabel;
            if (isError) stateLabel = t.ruleLibraryStatusError || 'Error';
            else if (isCompiling) stateLabel = t.ruleLibraryStatusCompiling || 'Compiling';
            else stateLabel = t.ruleLibraryStatusReady || 'Ready';
            // eslint-disable-next-line no-unsanitized/property -- values escaped via escapeHtml()
            statusEl.innerHTML = `<span class="inline-block w-1.5 h-1.5 rounded-full ${dotColor} mr-1.5"></span>${escapeHtml(stateLabel)}`;
        }

        if (statsEl) {
            const fileCount = engineStats?.file_count ?? engineStats?.files ?? ruleFiles.length;
            const ruleCount = engineStats?.rule_count ?? engineStats?.rules ?? ruleFiles.reduce((sum, f) => sum + (f.rule_count || 0), 0);
            statsEl.textContent = `${fileCount} ${t.ruleLibraryFiles || 'files'}  ${ruleCount} ${t.ruleLibraryRules || 'rules'}`;
        }
    } catch {
        // Fallback to local computation
        if (statusEl) {
            const dot = '<span class="inline-block w-1.5 h-1.5 rounded-full bg-success mr-1.5"></span>';
            // eslint-disable-next-line no-unsanitized/property -- values escaped via escapeHtml()
            statusEl.innerHTML = dot + escapeHtml(t.ruleLibraryStatusReady || 'Ready');
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
        // eslint-disable-next-line no-unsanitized/property -- values escaped via escapeHtml()
        content.innerHTML = `
            <div class="flex items-center gap-1 mb-4 shrink-0">
                <button data-rl-tab="rule-sets" class="rl-tab px-4 py-1.5 text-sm rounded-[var(--zephyr-radius-surface)] transition-colors duration-[var(--zephyr-time-micro)] ${activeTab === 'rule-sets' ? 'bg-accent/20 text-accent' : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--zephyr-bg-muted)]'}">
                    ${escapeHtml(t.ruleLibraryManageFiles || 'Manage Rule Files')}
                </button>
                <button data-rl-tab="active-rules" class="rl-tab px-4 py-1.5 text-sm rounded-[var(--zephyr-radius-surface)] transition-colors duration-[var(--zephyr-time-micro)] ${activeTab === 'active-rules' ? 'bg-accent/20 text-accent' : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--zephyr-bg-muted)]'}">
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
        if (tab === activeTab) {
            btn.classList.add('bg-accent/20', 'text-accent');
            btn.classList.remove('text-[var(--text-muted)]');
        } else {
            btn.classList.remove('bg-accent/20', 'text-accent');
            btn.classList.add('text-[var(--text-muted)]');
        }
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
        // eslint-disable-next-line no-unsanitized/property -- values escaped via escapeHtml()
        container.innerHTML = `
            <div class="flex flex-col items-center justify-center py-20 gap-4">
                <svg class="w-16 h-16 text-[var(--text-tertiary)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"/>
                </svg>
                <p class="text-[var(--text-muted)] text-sm">${escapeHtml(t.ruleLibraryEmpty || 'No extension rules yet')}</p>
                <p class="text-[var(--text-secondary)] text-xs max-w-sm text-center">${escapeHtml(t.ruleLibraryEmptyHint || '')}</p>
                <div class="flex items-center gap-2 mt-2">
                    <button id="rl-btn-extract" class="px-4 py-2 text-sm rounded-[var(--zephyr-radius-surface)] bg-[var(--zephyr-bg-muted)] text-[var(--text-secondary)] hover:bg-[var(--zephyr-bg-input)] hover:text-[var(--text-primary)] transition-colors duration-[var(--zephyr-time-micro)]">
                        ${escapeHtml(t.ruleLibraryExtract || 'Extract from Subscription')}
                    </button>
                    <button id="rl-btn-import-empty" class="px-4 py-2 text-sm rounded-[var(--zephyr-radius-surface)] bg-accent/20 text-accent hover:bg-accent/30 transition-colors duration-[var(--zephyr-time-micro)]">
                        ${escapeHtml(t.ruleLibraryImport || 'Import Rules')}
                    </button>
                    <button id="rl-btn-create-file" class="px-4 py-2 text-sm rounded-[var(--zephyr-radius-surface)] bg-[var(--zephyr-bg-muted)] text-[var(--text-secondary)] hover:bg-[var(--zephyr-bg-input)] hover:text-[var(--text-primary)] transition-colors duration-[var(--zephyr-time-micro)]">
                        ${escapeHtml(t.ruleLibraryCreateFile || 'Create Rule File')}
                    </button>
                </div>
            </div>
        `;

        document.getElementById('rl-btn-extract')?.addEventListener('click', (e) => {
            e.stopPropagation();
            handleExtractFromSubscription();
        });
        document.getElementById('rl-btn-import-empty')?.addEventListener('click', (e) => {
            e.stopPropagation();
            handleImportRules();
        });
        document.getElementById('rl-btn-create-file')?.addEventListener('click', (e) => {
            e.stopPropagation();
            handleCreateRuleFile();
        });
        return;
    }

    // Build a map: filename -> file info
    const fileMap = new Map(ruleFiles.map((f) => [f.filename, f]));

    // Build a set of files that belong to a group
    const groupedFiles = new Set(groups.flatMap((g) => g.files));

    container.innerHTML = '';

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
    section.className = 'space-y-2';

    const totalRules = files.reduce((sum, f) => sum + (f.rule_count || 0), 0);

    // Group header
    const header = document.createElement('div');
    header.className = 'flex items-center justify-between py-2 px-3 rounded-[var(--zephyr-radius-overlay)] bg-[var(--zephyr-bg-muted)] cursor-pointer group hover:bg-[var(--zephyr-bg-input)] transition-colors duration-[var(--zephyr-time-micro)]';
    header.setAttribute('role', 'button');
    header.setAttribute('tabindex', '0');
    header.setAttribute('aria-expanded', 'true');
    header.addEventListener('keydown', (e) => { if (e.target === header && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); header.click(); } });
    // eslint-disable-next-line no-unsanitized/property -- values escaped via escapeHtml()
    header.innerHTML = `
        <div class="flex items-center gap-2">
            ${SVG_ICONS.collapseArrow}
            <span class="text-sm font-medium text-[var(--text-secondary)]">${escapeHtml(group.name)}</span>
            <span class="text-xs text-[var(--text-muted)]">${files.length} ${t.ruleLibraryFiles || 'files'}  ${totalRules} ${t.ruleLibraryRules || 'rules'}</span>
        </div>
    `;

    // Right-click context menu for group header (edit/delete) — only for real groups
    if (!isUngrouped) {
        header.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            showGroupContextMenu(e, group.name);
        });
    }

    // Toggle collapse
    const body = document.createElement('div');
    body.className = 'space-y-2 pl-2 transition-all duration-[var(--zephyr-time-standard)]';
    const bodyId = 'rl-group-body-' + Math.random().toString(36).substring(2, 9);
    body.id = bodyId;
    header.setAttribute('aria-controls', bodyId);

    header.addEventListener('click', () => {
        const isCollapsed = body.style.display === 'none';
        body.style.display = isCollapsed ? '' : 'none';
        header.setAttribute('aria-expanded', isCollapsed ? 'true' : 'false');
        const arrow = header.querySelector('.collapse-arrow');
        if (arrow instanceof HTMLElement) arrow.style.transform = isCollapsed ? '' : 'rotate(-90deg)';
    });

    // File cards
    files.forEach((file) => {
        body.appendChild(buildFileCard(file, fileMap));
    });

    section.appendChild(header);
    section.appendChild(body);
    return section;
}

/**
 * Build a file card element.
 * @param {(typeof ruleFiles)[number]} file
 * @param {Map<string, (typeof ruleFiles)[number]>} _fileMap
 * @returns {HTMLElement}
 */
function buildFileCard(file, _fileMap) {
    const t = /** @type {Record<string, string>} */ (/** @type {any} */ (translations)[currentLang] || {});
    const card = document.createElement('div');
    card.className = 'glass-card p-4 flex items-center justify-between group hover:translate-x-1 hover:z-10 transition-transform duration-[var(--zephyr-time-standard)] cursor-pointer';

    const sourceBadge = getSourceBadge(file.source);

    // eslint-disable-next-line no-unsanitized/property -- values escaped via escapeHtml()
    card.innerHTML = `
        <div class="flex items-center gap-4 flex-1 min-w-0">
            <div class="flex flex-col gap-0.5 min-w-0">
                <span class="text-sm text-[var(--text-primary)] font-medium truncate">${escapeHtml(file.filename.replace(/\.prism\.ya?ml$/i, ''))}</span>
                <span class="text-xs text-[var(--text-muted)]">${file.rule_count || 0} ${t.ruleLibraryRules || 'rules'}</span>
            </div>
            <span class="text-[10px] px-2 py-0.5 rounded-full shrink-0 ${sourceBadge.cls}">${escapeHtml(sourceBadge.label)}</span>
        </div>
    `;

    // Right-click context menu
    card.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        showFileContextMenu(e, file);
    });

    // Double-click to edit
    card.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        handleEditRule(file.filename);
    });

    return card;
}

/**
 * Get source badge styling and label.
 * @param {string} source
 * @returns {{cls: string, label: string}}
 */
function getSourceBadge(source) {
    const t = /** @type {Record<string, string>} */ (/** @type {any} */ (translations)[currentLang]);
    const s = (source || '').toLowerCase();
    if (s.includes('extract') || s.includes('subscription')) {
        return { cls: 'bg-info/15 text-info', label: t.ruleLibraryExtracted || 'Extracted' };
    }
    if (s.includes('import')) {
        return { cls: 'bg-accent/15 text-accent', label: t.ruleLibraryImported || 'Imported' };
    }
    return { cls: 'bg-[var(--zephyr-bg-muted)] text-[var(--text-muted)]', label: t.ruleLibraryManual || 'Manual' };
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
        // eslint-disable-next-line no-unsanitized/property -- values escaped via escapeHtml()
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
    ct.innerHTML = '';

    // Toolbar
    const toolbar = document.createElement('div');
    toolbar.className = 'flex items-center justify-between mb-4 shrink-0';
    // eslint-disable-next-line no-unsanitized/property -- values escaped via escapeHtml()
    toolbar.innerHTML = `
        <div class="flex items-center gap-2">
            <span id="arl-groups-count" class="text-xs text-[var(--text-muted)]">${escapeHtml(String(activeRules.length))} ${t.ruleLibraryActiveGroups || 'groups'}</span>
            <span class="text-xs text-[var(--text-tertiary)]">|</span>
            <span id="arl-rules-count" class="text-xs text-[var(--text-muted)]">${escapeHtml(String(totalRules))} ${t.ruleLibraryRules || 'rules'}</span>
        </div>
        <button id="rl-btn-insert-rule" class="px-3 py-1.5 text-xs rounded-[var(--zephyr-radius-surface)] bg-accent/20 text-accent hover:bg-accent/30 transition-colors duration-[var(--zephyr-time-micro)]">
            ${escapeHtml(t.ruleLibraryInsertRule || '+ Insert Rule')}
        </button>
    `;
    ct.appendChild(toolbar);

    toolbar.querySelector('#rl-btn-insert-rule')?.addEventListener('click', (e) => {
        e.stopPropagation();
        handleInsertRule();
    });

    // Virtual scroll container
    const scrollBox = document.createElement('div');
    scrollBox.className = 'overflow-y-auto custom-scrollbar pr-1';
    scrollBox.innerHTML = '<div id="arl-vs-spacer-top" style="height:0"></div><div id="arl-vs-lines" class="space-y-1"></div><div id="arl-vs-spacer-bottom" style="height:0"></div>';
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
                header.className = 'flex items-center justify-between p-2 rounded-[var(--zephyr-radius-surface)] bg-[var(--zephyr-bg-muted)] cursor-pointer select-none';
                header.setAttribute('role', 'button');
                header.setAttribute('tabindex', '0');
                header.setAttribute('aria-expanded', isCollapsed ? 'false' : 'true');
                header.addEventListener('keydown', (e) => { if (e.target === header && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); header.click(); } });
                // eslint-disable-next-line no-unsanitized/property -- values escaped via escapeHtml()
                header.innerHTML = `
                    <div class="flex items-center gap-3">
                        <svg class="w-3 h-3 text-[var(--text-muted)] collapse-arrow transition-transform duration-[var(--zephyr-time-micro)] ${isCollapsed ? 'rotate-[-90deg]' : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>
                        <span class="text-xs px-2 py-0.5 rounded-full ${badgeColor}">${escapeHtml(label)}</span>
                        <span class="text-[10px] text-[var(--text-muted)]">${ruleCount} rules</span>
                    </div>
                    <div class="flex items-center gap-2">
                        <span class="text-[10px] ${enabled ? 'text-success' : 'text-[var(--text-muted)]'}">${enabled ? '● ON' : '○ OFF'}</span>
                    </div>
                `;
                header.addEventListener('click', () => {
                    if (collapsedGroups.has(groupId)) {
                        collapsedGroups.delete(groupId);
                        header.setAttribute('aria-expanded', 'true');
                    } else {
                        collapsedGroups.add(groupId);
                        header.setAttribute('aria-expanded', 'false');
                    }
                    renderActiveRules();
                });
                fragment.appendChild(header);
            } else {
                const { raw, index, localIndex, groupLabel } = item;
                const parts = raw.split(',').map((/** @type {string} */ s) => s.trim());
                if (parts.length < 2) return;

                const type = parts[0];
                const value = parts[1];
                const policy = parts[2] || 'Proxy';
                const badgeColor = getGroupBadgeColor(groupLabel);

                const el = document.createElement('div');
                el.setAttribute('data-line-idx', String(idx));
                el.className = 'glass-card p-3 flex items-center justify-between group hover:translate-x-1 transition-transform duration-[var(--zephyr-time-micro)]';
                // eslint-disable-next-line no-unsanitized/property -- values escaped via escapeHtml()
                el.innerHTML = `
                    <div class="flex items-center gap-4 flex-1 min-w-0">
                        <span class="text-xs text-[var(--text-tertiary)] w-6 shrink-0">${localIndex}</span>
                        <div class="type-badge text-[var(--text-muted)] shrink-0">${escapeHtml(type)}</div>
                        <div class="text-xs text-[var(--text-secondary)] font-mono truncate max-w-[300px]" title="${escapeAttr(value)}">${escapeHtml(value)}</div>
                    </div>
                    <div class="flex items-center gap-2 shrink-0">
                        <span class="text-[10px] px-1.5 py-0.5 rounded-full ${badgeColor}">${escapeHtml(groupLabel)}</span>
                        <div class="text-2xs font-bold ${getPolicyColor(policy)} uppercase tracking-wider">${escapeHtml(policy)}</div>
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
        'bg-info/15 text-info',
        'bg-accent/15 text-accent',
        'bg-success/15 text-success',
        'bg-warning/15 text-warning',
        'bg-danger/15 text-danger',
        'bg-download/15 text-download',
        'bg-orange/15 text-orange',
        'bg-upload/15 text-upload',
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
 * 插入规则处理（任务 G 入口占位）。
 * 调用 prism.insertRuleStr 在指定位置插入规则。
 */
/**
 * 插入规则 — 支持字符串格式和 JSON 格式，支持 4 种位置策略。
 */
async function handleInsertRule() {
    const t = /** @type {Record<string, string>} */ (/** @type {any} */ (translations)[currentLang]);

    // ── 第一步：输入规则内容 ──
    const ruleStr = await showModal(
        t.ruleLibraryInsertRule || 'Insert Rule',
        t.ruleLibraryInsertRulePlaceholder || 'e.g. DOMAIN-SUFFIX,example.com,Proxy\nor JSON: {"type":"DOMAIN-SUFFIX","domain":"ad.com","policy":"REJECT"}',
        'DOMAIN-SUFFIX,example.com,Proxy',
    );
    if (!ruleStr || !ruleStr.trim()) return;

    const trimmed = ruleStr.trim();

    // ── 第二步：选择插入位置 ──
    // 获取当前 Prism 分组列表用于 AfterGroup 选项
    const groupOptions = activeRules
        .filter((g) => typeof g !== 'string' && g.group_id)
        .map((g) => ({ id: g.group_id, label: g.label || g.group_id }));

    // 构建选项列表（每个选项一行，用户输入行号选择）
    const lines = [`0: ${t.ruleLibraryInsertPositionBeforePrism || 'Before All Prism Rules (highest priority)'}`];
    groupOptions.forEach((g, i) => {
        lines.push(`${i + 1}: ${(t.ruleLibraryInsertPositionAfterGroup || 'After Group "{group}"').replace('{group}', g.label)}`);
    });
    lines.push(`${lines.length}: ${t.ruleLibraryInsertPositionAfterPrism || 'After All Prism Rules'}`);
    lines.push(`${lines.length + 1}: ${t.ruleLibraryInsertPositionAppend || 'End of Rules (lowest priority)'}`);

    const posInput = await showModal(
        t.ruleLibraryInsertPosition || 'Insert Position',
        `${t.ruleLibraryInsertPositionHint || 'Enter number:'}\n${lines.join('\n')}`,
        '0',
    );
    if (!posInput || !posInput.trim()) return;

    const posIndex = parseInt(posInput.trim(), 10);
    if (isNaN(posIndex) || posIndex < 0 || posIndex >= lines.length) {
        showNotification(t.ruleLibraryInsertPositionInvalid || 'Invalid position number', 'error');
        return;
    }

    // 解析位置策略
    let position, groupId;
    if (posIndex === 0) {
        position = 'before_prism';
    } else if (posIndex <= groupOptions.length) {
        position = 'after_group';
        groupId = groupOptions[posIndex - 1].id;
    } else if (posIndex === groupOptions.length + 1) {
        position = 'after_prism';
    } else {
        position = 'append';
    }

    // ── 第三步：判断格式并调用对应 API ──
    try {
        // 尝试解析为 JSON（高级用户格式）
        let isJson = false;
        try {
            const parsed = JSON.parse(trimmed);
            if (parsed && typeof parsed === 'object') {
                isJson = true;
                await prism.insertRule(parsed, position, groupId);
            }
        } catch {
            // 不是 JSON，按字符串格式处理
        }

        if (!isJson) {
            await prism.insertRuleStr(trimmed, position, groupId);
        }

        showNotification(`${t.ruleLibraryInsertRule || 'Insert Rule'}: ${t.ruleLibraryInsertSuccess || 'OK'}`, 'success');
        try { await prism.apply(); } catch (e) { rulesLogger.warn("[prism] apply failed:", e); }
        await refreshData({ loadActiveRules: true });
        render();
    } catch (err) {
        showNotification(String(err), 'error');
    }
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

    /** @type {{label: string, action: () => void}[]} */
    const items = [
        {
            label: t.ruleLibraryEditRule || 'Edit Rule',
            action: () => handleEditRule(file.filename),
        },
        {
            label: t.ruleLibraryViewChanges || 'View Impact on Config',
            action: () => handleViewChanges(file.filename),
        },
        {
            label: t.ruleLibraryRenameRule || 'Rename',
            action: () => handleRenameRule(file.filename),
        },
        {
            label: t.ruleLibraryDeleteRule || 'Delete',
            action: () => handleDeleteRule(file.filename),
        },
    ];

    // Move to Group submenu
    if (groups.length > 0) {
        items.push({
            label: t.ruleLibraryMoveToGroup || 'Move to Group',
            action: () => handleMoveToGroup(file.filename),
        });
    }

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
            label: t.ruleLibraryTrace || 'Trace',
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
        t.ruleLibraryDeleteTitle || 'Delete Group',
        name,
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
        .map((name, i) => `<button type="button" class="w-full text-left px-4 py-2.5 text-sm text-[var(--text-secondary)] hover:bg-accent/10 hover:text-accent transition-colors rounded-[var(--zephyr-radius-surface)]" data-group-index="${i}">${escapeHtml(name)}</button>`)
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
        t.ruleLibraryGroupNamePlaceholder || 'Enter file name',
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
        t.ruleLibraryGroupNamePlaceholder || 'Enter new name',
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
 */
async function handleDeleteRule(filename) {
    const t = /** @type {Record<string, string>} */ (/** @type {any} */ (translations)[currentLang]);
    const confirmed = await showConfirmModal(
        t.ruleLibraryDeleteTitle || 'Delete Rule Set',
        t.ruleLibraryDeleteConfirm || 'Are you sure you want to delete this rule set?',
    );
    if (!confirmed) return;

    try {
        await invoke(COMMANDS.RULE_DELETE, { filename });
        showNotification(`${t.ruleLibraryDeleteRule}: ${filename}`, 'success');
        try { await prism.apply(); } catch (e) { rulesLogger.warn("[prism] apply failed:", e); }
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
        <div class="flex flex-col overflow-hidden" style="max-height: calc(65vh - 6rem)">
            <div class="flex items-center justify-between shrink-0">
                <div class="flex items-center gap-2">
                    <button id="rl-editor-toggle" class="px-3 py-1 text-xs rounded-[var(--zephyr-radius-surface)] bg-[var(--zephyr-bg-muted)] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors">
                        ${escapeHtml(t.ruleLibrarySwitchToText || 'Text Editor')}
                    </button>
                    <button id="rl-editor-add" class="px-3 py-1 text-xs rounded-[var(--zephyr-radius-surface)] bg-[var(--zephyr-bg-muted)] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors">
                        + ${escapeHtml(t.ruleLibraryCreateRule || 'Create Rule')}
                    </button>
                </div>
            </div>
            <div id="rl-editor-visual" class="flex-1 min-h-0 overflow-y-auto overflow-x-clip custom-scrollbar pr-1 relative mt-4">
                <div id="rl-vs-spacer-top" style="height:0"></div>
                <div id="rl-vs-lines" class="space-y-2"></div>
                <div id="rl-vs-spacer-bottom" style="height:0"></div>
            </div>
            <div id="rl-editor-text" class="hidden flex-1 min-h-0 overflow-y-auto custom-scrollbar mt-4">
                <textarea id="rl-editor-textarea" class="form-control form-control-mono hidden w-full min-h-full rounded-[var(--zephyr-radius-overlay)] p-4 text-xs resize-none" aria-label="${escapeAttr(t.ruleLibraryRuleEditor || 'Rule Editor')}" spellcheck="false"></textarea>
                <div id="rl-editor-cm6" class="w-full min-h-full bg-[var(--zephyr-bg-input)] border border-[var(--zephyr-border-default)] rounded-[var(--zephyr-radius-overlay)] overflow-hidden"></div>
            </div>
            <div class="flex items-center justify-end gap-2 pt-3 border-t border-[var(--zephyr-border-subtle)] shrink-0">
                <button id="rl-editor-save" class="px-4 py-1.5 text-sm rounded-[var(--zephyr-radius-surface)] bg-accent/20 text-accent hover:bg-accent/30 transition-colors duration-[var(--zephyr-time-micro)]">
                    ${escapeHtml(t.ruleLibrarySave || 'Save')}
                </button>
            </div>
        </div>
    `;
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

    /** @type {'visual'|'text'} */
    let editorMode = 'visual';

    // Use onReady callback to wire up events while modal is open.
    // The Promise resolves when the modal closes (user clicks confirm/cancel).
    await showModal(filename, '', '', true, buildEditorHtml(t), (contentArea, closeEditor) => {
        // Wire up editor controls
        const visualContainer = /** @type {HTMLElement} */ (contentArea.querySelector('#rl-editor-visual'));
        const textContainer = contentArea.querySelector('#rl-editor-text');
        const textarea = /** @type {HTMLTextAreaElement} */ (contentArea.querySelector('#rl-editor-textarea'));
        const cm6Container = /** @type {HTMLElement} */ (contentArea.querySelector('#rl-editor-cm6'));
        const toggleBtn = /** @type {HTMLElement} */ (contentArea.querySelector('#rl-editor-toggle'));
        const addBtn = /** @type {HTMLElement} */ (contentArea.querySelector('#rl-editor-add'));
        const saveBtn = /** @type {HTMLElement} */ (contentArea.querySelector('#rl-editor-save'));

        if (!visualContainer || !textContainer || !textarea || !cm6Container || !toggleBtn) return;

        textarea.value = content;

        /** @type {number|null} */
        let dragSourceIndex = null;

        // ── Virtual scroll for rule editor (shared module) ──
        const VS_ROW_EST = 72;
        const vsSpacerTop = /** @type {HTMLElement} */ (visualContainer.querySelector('#rl-vs-spacer-top'));
        const vsLinesContainer = /** @type {HTMLElement} */ (visualContainer.querySelector('#rl-vs-lines'));
        const vsSpacerBottom = /** @type {HTMLElement} */ (visualContainer.querySelector('#rl-vs-spacer-bottom'));

        const ruleVs = createVirtualScroll({
            container: visualContainer,
            spacerTop: vsSpacerTop,
            spacerBottom: vsSpacerBottom,
            linesContainer: vsLinesContainer,
            itemCount: () => rules.length,
            renderItem: (idx, fragment) => {
                const rule = rules[idx];
                if (!rule) return;
                const card = createRuleCard(rule, idx);
                if (card) fragment.appendChild(card);
            },
            dataAttr: 'data-rule-index',
            rowHeightEst: VS_ROW_EST,
            overscanPx: 500,
            scrollQuantumPx: 300,
            maxMounted: 50,
        });

        /**
         * Create a single rule card element.
         * @param {string} rule
         * @param {number} index
         */
        function createRuleCard(rule, index) {
            const parts = rule.split(',').map((/** @type {string} */ s) => s.trim());
            if (parts.length < 2) return null;

            const type = parts[0];
            const value = parts[1];
            const policy = parts[2] || 'Proxy';
            const isFirst = index === 0;
            const isLast = index === rules.length - 1;

            const item = document.createElement('div');
            item.className = 'glass-card p-4 flex items-center justify-between group hover:translate-x-1 hover:z-10 transition-transform duration-[var(--zephyr-time-standard)] cursor-pointer';
            item.draggable = true;
            item.style.setProperty('-webkit-user-drag', 'element');
            item.dataset.ruleIndex = String(index);

            // eslint-disable-next-line no-unsanitized/property -- values escaped via escapeHtml/escapeAttr
            item.innerHTML = `
                <div class="flex items-center gap-4 flex-1">
                    <span class="text-xs text-[var(--text-tertiary)] w-6 shrink-0 cursor-grab active:cursor-grabbing select-none" title="${escapeAttr(t.ruleLibraryDragToReorder || 'Drag to reorder')}">${index + 1}</span>
                    <div class="type-badge text-[var(--text-muted)]">${escapeHtml(type)}</div>
                    <div class="text-xs text-[var(--text-secondary)] font-mono truncate max-w-[240px]">${escapeHtml(value)}</div>
                </div>
                <div class="flex items-center gap-2">
                    <div class="text-2xs font-bold ${getPolicyColor(policy)} uppercase tracking-wider mr-2">${escapeHtml(policy)}</div>
                    <button type="button" class="btn-rl-rule-top opacity-0 group-hover:opacity-100 focus-visible:opacity-100 p-1.5 rounded-[var(--zephyr-radius-surface)] text-[var(--text-muted)] hover:text-accent hover:bg-accent/10 transition-[opacity,color] ${isFirst ? 'invisible' : ''}" title="${escapeAttr(t.moveToTop || 'Move to Top')}" aria-label="${escapeAttr(t.moveToTop || 'Move to Top')}">
                        ${SVG_ICONS.arrowUp}
                    </button>
                    <button type="button" class="btn-rl-rule-bottom opacity-0 group-hover:opacity-100 focus-visible:opacity-100 p-1.5 rounded-[var(--zephyr-radius-surface)] text-[var(--text-muted)] hover:text-accent hover:bg-accent/10 transition-[opacity,color] ${isLast ? 'invisible' : ''}" title="${escapeAttr(t.moveToBottom || 'Move to Bottom')}" aria-label="${escapeAttr(t.moveToBottom || 'Move to Bottom')}">
                        ${SVG_ICONS.arrowDown}
                    </button>
                    <button class="btn-rl-rule-del opacity-0 group-hover:opacity-100 btn-delete-icon">
                        ${SVG_ICONS.trash}
                    </button>
                </div>
            `;

            const valueDiv = item.querySelector('.font-mono.truncate');
            if (valueDiv) valueDiv.setAttribute('title', value);

            // Move to top
            if (!isFirst) {
                item.querySelector('.btn-rl-rule-top')?.addEventListener('click', (ev) => {
                    ev.stopPropagation();
                    const [moved] = rules.splice(index, 1);
                    rules.unshift(moved);
                    ruleVs.invalidate();
                });
            }

            // Move to bottom
            if (!isLast) {
                item.querySelector('.btn-rl-rule-bottom')?.addEventListener('click', (ev) => {
                    ev.stopPropagation();
                    const [moved] = rules.splice(index, 1);
                    rules.push(moved);
                    ruleVs.invalidate();
                });
            }

            // Delete
            item.querySelector('.btn-rl-rule-del')?.addEventListener('click', (ev) => {
                ev.stopPropagation();
                rules.splice(index, 1);
                ruleVs.invalidate();
            });

            // Drag & Drop
            item.addEventListener('dragstart', (/** @type {DragEvent} */ ev) => {
                dragSourceIndex = index;
                if (ev.dataTransfer) {
                    ev.dataTransfer.effectAllowed = 'move';
                    ev.dataTransfer.setData('text/plain', String(index));
                }
                item.style.transform = 'none';
                requestAnimationFrame(() => item.classList.add('opacity-40'));
            });

            item.addEventListener('dragend', () => {
                item.classList.remove('opacity-40');
                item.style.transform = '';
                dragSourceIndex = null;
                /** @type {HTMLElement} */ (vsLinesContainer).querySelectorAll('.rl-drop-indicator').forEach((el) => el.remove());
            });

            item.addEventListener('dragover', (/** @type {DragEvent} */ ev) => {
                ev.preventDefault();
                if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move';
                /** @type {HTMLElement} */ (vsLinesContainer).querySelectorAll('.rl-drop-indicator').forEach((el) => el.remove());
                const rect = item.getBoundingClientRect();
                const midY = rect.top + (rect.height / 2);
                const indicator = document.createElement('div');
                indicator.className = 'rl-drop-indicator h-0.5 bg-accent rounded-full mx-2 transition-all';
                if (ev.clientY < midY) {
                    item.parentNode?.insertBefore(indicator, item);
                } else {
                    item.parentNode?.insertBefore(indicator, item.nextSibling);
                }
            });

            item.addEventListener('drop', (ev) => {
                ev.preventDefault();
                /** @type {HTMLElement} */ (vsLinesContainer).querySelectorAll('.rl-drop-indicator').forEach((el) => el.remove());
                if (dragSourceIndex === null || dragSourceIndex === index) return;
                const rect = item.getBoundingClientRect();
                const midY = rect.top + (rect.height / 2);
                let targetIndex = ev.clientY < midY ? index : index + 1;
                const [moved] = rules.splice(dragSourceIndex, 1);
                if (targetIndex > dragSourceIndex) targetIndex--;
                rules.splice(targetIndex, 0, moved);
                dragSourceIndex = null;
                ruleVs.invalidate();
            });

            return item;
        }

        const renderVisualEditor = () => {
            ruleVs.invalidate();
        };

        renderVisualEditor();

        // Add rule button
        addBtn?.addEventListener('click', (ev) => {
            ev.stopPropagation();
            rules.unshift('MATCH,Proxy');
            ruleVs.invalidate();
        });

        // Toggle between visual and text editor
        toggleBtn.addEventListener('click', (ev) => {
            ev.stopPropagation();
            if (editorMode === 'visual') {
                // Sync visual -> text
                const textContent = rules.join('\n');
                textarea.value = textContent;
                editorMode = 'text';
                visualContainer.classList.add('hidden');
                textContainer.classList.remove('hidden');
                toggleBtn.textContent = t.ruleLibrarySwitchToVisual || 'Visual Editor';
                // Create CM6 editor
                if (ruleEditorView) { ruleEditorView.destroy(); ruleEditorView = null; }
                cm6Container.innerHTML = '';
                ruleEditorView = createEditor({
                    parent: cm6Container,
                    content: textContent,
                    language: 'yaml',
                    prismDsl: true,
                });
            } else {
                // Sync text -> visual
                const textContent = ruleEditorView ? getEditorContent(ruleEditorView) : textarea.value;
                rules = textContent.split('\n').map((l) => l.trim()).filter(Boolean);
                editorMode = 'visual';
                textContainer.classList.add('hidden');
                visualContainer.classList.remove('hidden');
                toggleBtn.textContent = t.ruleLibrarySwitchToText || 'Text Editor';
                renderVisualEditor();
                // Destroy CM6 editor
                if (ruleEditorView) { ruleEditorView.destroy(); ruleEditorView = null; }
            }
        });

        // Save button
        saveBtn?.addEventListener('click', async (ev) => {
            ev.stopPropagation();
            const rawContent = editorMode === 'text'
                ? (ruleEditorView ? getEditorContent(ruleEditorView) : textarea.value)
                : null;
            // Cleanup CM6 editor before saving
            if (ruleEditorView) { ruleEditorView.destroy(); ruleEditorView = null; }
            await handleSaveRules(t, filename, rawContent, rules, content);
            await refreshData({ loadActiveRules: true });
            render();
            if (closeEditor) closeEditor(null);
        });
    });
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
                    <span class="inline-block w-2 h-2 rounded-full bg-success"></span>
                    <span class="text-xs font-medium text-success">+${added.length} ${t.ruleLibraryDiffAdded || 'added'}</span>
                </div>
                ${added.map((/** @type {any} */ r) => `<div class="px-3 py-1.5 rounded-[var(--zephyr-radius-surface)] bg-success/10 border border-success/20 text-xs text-success/70 font-mono">${escapeHtml(typeof r === 'string' ? r : JSON.stringify(r))}</div>`).join('')}
            </div>`;
        }
        if (removed.length > 0) {
            diffHtml += `<div class="space-y-1">
                <div class="flex items-center gap-2 mb-1">
                    <span class="inline-block w-2 h-2 rounded-full bg-danger"></span>
                    <span class="text-xs font-medium text-danger">-${removed.length} ${t.ruleLibraryDiffRemoved || 'removed'}</span>
                </div>
                ${removed.map((/** @type {any} */ r) => `<div class="px-3 py-1.5 rounded-[var(--zephyr-radius-surface)] bg-danger/10 border border-danger/20 text-xs text-danger/70 font-mono">${escapeHtml(typeof r === 'string' ? r : JSON.stringify(r))}</div>`).join('')}
            </div>`;
        }
        if (modified.length > 0) {
            diffHtml += `<div class="space-y-1">
                <div class="flex items-center gap-2 mb-1">
                    <span class="inline-block w-2 h-2 rounded-full bg-warning"></span>
                    <span class="text-xs font-medium text-warning">~${modified.length} ${t.ruleLibraryDiffModified || 'modified'}</span>
                </div>
                ${modified.map((/** @type {any} */ r) => `<div class="px-3 py-1.5 rounded-[var(--zephyr-radius-surface)] bg-warning/10 border border-warning/20 text-xs text-warning/70 font-mono">${escapeHtml(typeof r === 'string' ? r : JSON.stringify(r))}</div>`).join('')}
            </div>`;
        }

        const panelHtml = `
            <div class="space-y-4">
                <div class="flex items-center justify-between">
                    <span class="text-xs text-[var(--text-muted)]">${escapeHtml(filename)}</span>
                    <span class="text-xs text-[var(--text-muted)]">${totalChanges} ${t.ruleLibraryDiffChanges || 'changes'}</span>
                </div>
                <div class="space-y-3 overflow-y-auto max-h-[400px] custom-scrollbar pr-1">${diffHtml}</div>
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
 */
async function handleSaveRules(t, filename, rawContent, rules, originalContent) {
    try {
        const startTime = performance.now();

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
        const elapsed = Math.round(performance.now() - startTime);
        const ruleCount = finalContent.split('\n').filter(Boolean).length;

        try {
            const applyStart = performance.now();
            await prism.apply();
            const applyElapsed = Math.round(performance.now() - applyStart);
            showNotification(
                `${ruleCount} ${t.ruleLibraryAppliedStats || 'rules applied in'} ${elapsed}ms + compiled in ${applyElapsed}ms`,
                'success',
            );
        } catch (applyErr) {
            showNotification(
                `${ruleCount} ${t.ruleLibraryRules || 'rules'} saved in ${elapsed}ms, but apply failed: ${applyErr}`,
                'warning',
            );
        }
    } catch (err) {
        showNotification(String(err), 'error');
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
            <div class="flex items-center gap-1 mb-2">
                <button data-rl-import-tab="paste" class="rl-import-tab px-3 py-1 text-xs rounded-[var(--zephyr-radius-surface)] transition-colors duration-[var(--zephyr-time-micro)] bg-accent/20 text-accent">
                    ${escapeHtml(t.ruleLibraryImportPaste || 'Paste rules text')}
                </button>
                <button data-rl-import-tab="file" class="rl-import-tab px-3 py-1 text-xs rounded-[var(--zephyr-radius-surface)] transition-colors duration-[var(--zephyr-time-micro)] text-[var(--text-muted)] hover:text-[var(--text-secondary)]">
                    ${escapeHtml(t.ruleLibraryImportFile || 'Select file')}
                </button>
                <button data-rl-import-tab="url" class="rl-import-tab px-3 py-1 text-xs rounded-[var(--zephyr-radius-surface)] transition-colors duration-[var(--zephyr-time-micro)] text-[var(--text-muted)] hover:text-[var(--text-secondary)]">
                    ${escapeHtml(t.ruleLibraryImportUrl || 'Import from URL')}
                </button>
            </div>
            <div id="rl-import-paste" class="space-y-3">
                <textarea id="rl-import-text" class="form-control form-control-mono w-full h-32 rounded-[var(--zephyr-radius-overlay)] p-3 text-xs resize-none custom-scrollbar" placeholder="${escapeHtml(t.ruleLibraryImportPaste || '')}" spellcheck="false"></textarea>
            </div>
            <div id="rl-import-file" class="hidden space-y-3">
                <input id="rl-import-file-path" type="text" class="form-control form-control-lg" placeholder="${escapeHtml(t.ruleLibraryImportFile || '')}" />
            </div>
            <div id="rl-import-url" class="hidden space-y-3">
                <input id="rl-import-url-input" type="text" class="form-control form-control-lg" placeholder="https://..." />
            </div>
            <div class="space-y-2">
                <label class="text-xs text-[var(--text-muted)]">${escapeHtml(t.ruleLibraryGroupName || 'Name')}</label>
                <input id="rl-import-name" type="text" class="form-control form-control-lg" placeholder="my-rules" />
            </div>
            <div class="flex items-center justify-end gap-2 pt-2">
                <button id="rl-import-confirm" class="px-4 py-1.5 text-sm rounded-[var(--zephyr-radius-surface)] bg-accent/20 text-accent hover:bg-accent/30 transition-colors duration-[var(--zephyr-time-micro)]">
                    ${escapeHtml(t.ruleLibraryImportConfirm || 'Import')}
                </button>
            </div>
        </div>
    `;

    showModal(
        t.ruleLibraryImport || 'Import Rules',
        '',
        '',
        true,
        importHtml,
        (contentArea, close) => {
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
                        tabItem.className = 'rl-import-tab px-3 py-1 text-xs rounded-[var(--zephyr-radius-surface)] transition-colors duration-[var(--zephyr-time-micro)] text-[var(--text-muted)] hover:text-[var(--text-secondary)]';
                    });
                    tab.className = 'rl-import-tab px-3 py-1 text-xs rounded-[var(--zephyr-radius-surface)] transition-colors duration-[var(--zephyr-time-micro)] bg-accent/20 text-accent';

                    pastePanel?.classList.toggle('hidden', importMode !== 'paste');
                    filePanel?.classList.toggle('hidden', importMode !== 'file');
                    urlPanel?.classList.toggle('hidden', importMode !== 'url');
                });
            });

            // Wire up import confirm button
            contentArea.querySelector('#rl-import-confirm')?.addEventListener('click', async (ev) => {
                ev.stopPropagation();

                const btn = /** @type {HTMLElement} */ (ev.currentTarget);
                const nameInput = /** @type {HTMLInputElement} */ (contentArea.querySelector('#rl-import-name'));
                const name = nameInput?.value.trim() || 'imported-rules';

                // Prevent double-click and show loading state
                if (btn.dataset.busy === 'true') return;
                btn.dataset.busy = 'true';

                // Close modal immediately and notify background import
                close(null);
                showNotification(t.ruleLibraryImportApplying || 'Importing rules in background...', 'info');

                try {
                    let createdFile = '';

                    if (importMode === 'paste') {
                        const text = /** @type {HTMLTextAreaElement} */ (contentArea.querySelector('#rl-import-text'))?.value.trim();
                        if (!text) {
                            showNotification(t.ruleLibraryImportPaste, 'error');
                            return;
                        }
                        createdFile = await invoke(COMMANDS.RULE_IMPORT_TEXT, { text, name });
                    } else if (importMode === 'file') {
                        const filePath = /** @type {HTMLInputElement} */ (contentArea.querySelector('#rl-import-file-path'))?.value.trim();
                        if (!filePath) {
                            showNotification(t.ruleLibraryImportFile, 'error');
                            return;
                        }
                        createdFile = await invoke(COMMANDS.RULE_IMPORT_FILE, { filePath, name });
                    } else if (importMode === 'url') {
                        const url = /** @type {HTMLInputElement} */ (contentArea.querySelector('#rl-import-url-input'))?.value.trim();
                        if (!url) {
                            showNotification(t.ruleLibraryImportUrl, 'error');
                            return;
                        }
                        createdFile = await invoke(COMMANDS.RULE_IMPORT_URL, { url, name });
                    }

                    // Apply and refresh in background — modal already closed
                    try { await prism.apply(); } catch (e) { rulesLogger.warn("[prism] apply failed:", e); }
                    await refreshData({ loadActiveRules: true });
                    render();
                    showNotification(`${t.ruleLibraryImport}: ${createdFile || name}`, 'success');
                } catch (err) {
                    showNotification(String(err), 'error');
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
        showNotification(t.ruleLibraryExtract || 'No subscriptions available', 'info');
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
                return `<button type="button" class="w-full text-left px-4 py-3 text-sm text-[var(--text-secondary)] hover:bg-accent/10 hover:text-accent transition-colors rounded-[var(--zephyr-radius-surface)] flex items-center justify-between group/prof" data-profile-id="${escapeHtml(String(pId))}">
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
        t.ruleLibraryGroupNamePlaceholder || 'Enter name',
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
 * Trace 规则匹配报告 — 使用完整面板展示（等宽字体、可滚动、最大高度 400px）。
 * @param {string} rule
 * @param {number} index
 */
async function handleTraceRule(rule, index) {
    const t = /** @type {Record<string, string>} */ (/** @type {any} */ (translations)[currentLang]);

    try {
        const report = await prism.traceReportText();
        const reportStr = typeof report === 'string' ? report : JSON.stringify(report, null, 2);

        // 构建完整面板 HTML：glass-card 背景、等宽字体、可滚动
        const panelHtml = `
            <div class="space-y-3">
                <div class="flex items-center justify-between">
                    <span class="text-xs text-[var(--text-muted)]">${escapeHtml(t.ruleLibraryTraceDesc || 'Rule matching trace')} [${index}]</span>
                    <span class="text-xs text-[var(--text-tertiary)]">${escapeHtml(String(reportStr.length))} chars</span>
                </div>
                <pre class="glass-card p-4 text-xs text-[var(--text-secondary)] font-mono leading-relaxed whitespace-pre-wrap break-all overflow-y-auto max-h-[400px] custom-scrollbar">${escapeHtml(reportStr)}</pre>
            </div>
        `;

        await showModal(
            t.ruleLibraryTrace || 'Trace',
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
