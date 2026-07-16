/**
 * Plugins & Scripts + Smart & Failover page logic.
 *
 * Complete UI integration for all 77 Prism Tauri commands.
 * Covers: Plugin lifecycle, Script engine, Sandbox config,
 * Smart scoring, Failover policy, KV store, Hooks, Permissions.
 */

import * as prism from './prism.js';
import { showNotification } from './notifications.js';
import { t } from '../i18n.js';

// ═══════════════════════════════════════════════════════════════════════
//  Navigation
// ═══════════════════════════════════════════════════════════════════════

export function initPluginsSmartPages() {
    const btnPlugins = document.getElementById('btn-goto-plugins');
    if (btnPlugins) btnPlugins.addEventListener('click', () => navigateToPage('plugins'));

    const btnSmart = document.getElementById('btn-goto-smart');
    if (btnSmart) btnSmart.addEventListener('click', () => navigateToPage('smart'));

    const backPlugins = document.getElementById('btn-back-settings-plugins');
    if (backPlugins) backPlugins.addEventListener('click', () => navigateToPage('settings'));

    const backSmart = document.getElementById('btn-back-settings-smart');
    if (backSmart) backSmart.addEventListener('click', () => navigateToPage('settings'));

    initPluginsPage();
    initScriptsSection();
    initSmartPage();
}

/**
 * @param {string} pageId
 */
function navigateToPage(pageId) {
    document.querySelectorAll('[data-page]').forEach(p => p.classList.add('hidden'));
    const target = document.querySelector(`[data-page="${pageId}"]`);
    if (target) { target.classList.remove('hidden'); target.classList.add('flex'); }
    if (pageId === 'settings') {
        ['plugins', 'smart', 'advanced'].forEach(p => {
            const el = document.querySelector(`[data-page="${p}"]`);
            if (el) { el.classList.add('hidden'); el.classList.remove('flex'); }
        });
    }
}

// ═══════════════════════════════════════════════════════════════════════
//  Plugins Page — Discover / Load / Unload / Execute / Hooks / Permissions
// ═══════════════════════════════════════════════════════════════════════

function initPluginsPage() {
    // Discover
    const discoverBtn = document.getElementById('plugin-discover-btn');
    if (discoverBtn instanceof HTMLButtonElement) {
        discoverBtn.addEventListener('click', async () => {
            discoverBtn.disabled = true;
            try {
                const plugins = await prism.pluginDiscover();
                renderPluginsList(plugins);
            } catch (e) { showNotification(String(e), 'error'); }
            finally { discoverBtn.disabled = false; }
        });
    }

    // Add plugin hint
    const addBtn = document.getElementById('plugin-add-btn');
    if (addBtn) {
        addBtn.addEventListener('click', () => {
            showNotification('Place plugin folder in prism/plugins/ directory, then click Discover', 'info');
        });
    }

    // KV Store
    const kvRefresh = document.getElementById('kv-refresh-btn');
    if (kvRefresh) kvRefresh.addEventListener('click', loadKvStore);

    const kvClear = document.getElementById('kv-clear-btn');
    if (kvClear) {
        kvClear.addEventListener('click', async () => {
            try {
                const keys = await prism.kvKeys();
                for (const key of keys) await prism.kvDelete(key);
                showNotification(`Cleared ${keys.length} KV entries`, 'success');
                loadKvStore();
            } catch (e) { showNotification(String(e), 'error'); }
        });
    }

    loadKvStore();
    loadHooksList();
    loadPermissionsList();
}

/**
 * @param {Array<{id?: string, name?: string, description?: string, version?: string}>} plugins
 */
async function renderPluginsList(plugins) {
    const container = document.getElementById('plugins-list');
    if (!container) return;
    if (!plugins || plugins.length === 0) {
         
    container.innerHTML = '<div class="glass-card p-6 text-center text-[var(--text-tertiary)] text-xs">No plugins found.</div>';
        return;
    }

    // Also load the list of currently loaded plugins to determine state
    let loadedIds = [];
    try { const loaded = await prism.pluginListLoaded(); loadedIds = loaded.map((/** @type {{id: string}} */ p) => p.id); } catch {}

    // eslint-disable-next-line no-unsanitized/property -- values escaped via esc()
    container.innerHTML = plugins.map(p => {
        const id = p.id || '';
        const isLoaded = loadedIds.includes(id);
        return `
        <div class="glass-card p-4">
            <div class="flex items-center justify-between">
                <div class="flex items-center gap-4">
                    <div class="w-10 h-10 rounded-md ${isLoaded ? 'bg-green-500/10 border-green-500/20 text-green-400' : 'bg-[var(--zephyr-bg-muted)] border-[var(--zephyr-border-subtle)] text-[var(--text-muted)]'} border flex items-center justify-center">
                        <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>
                    </div>
                    <div>
                        <p class="text-sm font-semibold text-[var(--text-primary)]">${esc(p.name || id || 'Unknown')}</p>
                        <p class="text-2xs text-[var(--text-muted)]">${esc(p.description || '')} ${p.version ? `v${esc(p.version)}` : ''}</p>
                    </div>
                </div>
                <div class="flex items-center gap-1">
                    <button class="p-action-btn btn-ghost text-2xs" data-id="${esc(id)}" data-action="${isLoaded ? 'unload' : 'load'}">
                        ${isLoaded ? 'Unload' : 'Load'}
                    </button>
                    <button class="p-action-btn btn-ghost text-2xs" data-id="${esc(id)}" data-action="execute" title="Run entry script">
                        Run
                    </button>
                    <button class="p-action-btn btn-ghost text-2xs text-red-400" data-id="${esc(id)}" data-action="delete">Delete</button>
                </div>
            </div>
        </div>`;
    }).join('');

    container.querySelectorAll('.p-action-btn').forEach(btn => {
        if (!(btn instanceof HTMLElement)) return;
        btn.addEventListener('click', async () => {
            const id = btn.dataset.id;
            const action = btn.dataset.action;
            if (!id || !action) return;
            try {
                if (action === 'load') {
                    await prism.pluginLoad(id);
                    showNotification(`Plugin ${id} loaded`, 'success');
                } else if (action === 'unload') {
                    await prism.pluginUnload(id);
                    showNotification(`Plugin ${id} unloaded`, 'success');
                } else if (action === 'execute') {
                    const result = await prism.pluginExecute(id);
                    showNotification(
                        result.success ? `Plugin ${id} executed (${result.duration_us}µs)` : `Plugin ${id} failed: ${result.error}`,
                        result.success ? 'success' : 'error'
                    );
                } else if (action === 'delete') {
                    await prism.pluginDelete(id);
                    showNotification(`Plugin ${id} deleted`, 'success');
                }
                const updated = await prism.pluginDiscover();
                renderPluginsList(updated);
            } catch (e) { showNotification(String(e), 'error'); }
        });
    });
}

// ── Hooks List ──

async function loadHooksList() {
    const container = document.getElementById('hooks-list');
    if (!container) return;
    try {
        const hooks = /** @type {Array<{name: string, isHighFrequency?: boolean}>} */ (/** @type {unknown} */ (await prism.pluginListHooks('*')));
        if (!hooks || hooks.length === 0) {
             
    container.innerHTML = '<div class="text-[var(--text-tertiary)] text-xs text-center py-2">No hooks available</div>';
            return;
        }
        // eslint-disable-next-line no-unsanitized/property -- values escaped via esc()
    container.innerHTML = hooks.map(h => `
            <div class="flex items-center justify-between py-1 px-2 rounded-md hover:bg-[var(--zephyr-bg-muted)]">
                <span class="text-xs text-[var(--text-secondary)]">${esc(h.name)}</span>
                <div class="flex items-center gap-2">
                    ${h.isHighFrequency ? '<span class="text-2xs text-warning">high-freq</span>' : ''}
                    <button class="hook-trigger-btn btn-ghost text-2xs" data-hook="${esc(h.name)}">Trigger</button>
                </div>
            </div>
        `).join('');

        container.querySelectorAll('.hook-trigger-btn').forEach(btn => {
            if (!(btn instanceof HTMLElement)) return;
            btn.addEventListener('click', async () => {
                const hookName = btn.dataset.hook;
                if (!hookName) return;
                try {
                    const results = await prism.pluginExecuteHook(hookName, {});
                    const succeeded = results.filter((/** @type {{success: boolean}} */ r) => r.success).length;
                    showNotification(`Hook "${hookName}": ${succeeded}/${results.length} plugins responded`, 'success');
                } catch (e) { showNotification(String(e), 'error'); }
            });
        });
    } catch (e) {
        // eslint-disable-next-line no-unsanitized/property -- values escaped via esc()
    container.innerHTML = `<div class="text-red-400 text-xs text-center py-2">${esc(String(e))}</div>`;
    }
}

// ── Permissions List ──

async function loadPermissionsList() {
    const container = document.getElementById('permissions-list');
    if (!container) return;
    try {
        const perms = /** @type {Array<{name: string, displayName: string, allowedForConfigPlugin?: boolean, allowedForUiExtension?: boolean}>} */ (/** @type {unknown} */ (await prism.pluginListPermissions('*')));
        if (!perms || perms.length === 0) {
             
    container.innerHTML = '<div class="text-[var(--text-tertiary)] text-xs text-center py-2">No permissions</div>';
            return;
        }
        // eslint-disable-next-line no-unsanitized/property -- values escaped via esc()
    container.innerHTML = perms.map(p => `
            <div class="flex items-center justify-between py-1 px-2 rounded-md hover:bg-[var(--zephyr-bg-muted)]">
                <div>
                    <span class="text-xs text-[var(--text-secondary)] font-mono">${esc(p.name)}</span>
                    <span class="text-2xs text-[var(--text-muted)] ml-2">${esc(p.displayName)}</span>
                </div>
                <div class="flex gap-2">
                    ${p.allowedForConfigPlugin ? '<span class="text-2xs text-blue-400">config</span>' : ''}
                    ${p.allowedForUiExtension ? '<span class="text-2xs text-green-400">ui</span>' : ''}
                </div>
            </div>
        `).join('');
    } catch (e) {
        // eslint-disable-next-line no-unsanitized/property -- values escaped via esc()
    container.innerHTML = `<div class="text-red-400 text-xs text-center py-2">${esc(String(e))}</div>`;
    }
}

// ── KV Store ──

async function loadKvStore() {
    const container = document.getElementById('kv-store-list');
    if (!container) return;
    try {
        const keys = await prism.kvKeys();
        if (!keys || keys.length === 0) {
             
    container.innerHTML = '<div class="text-[var(--text-tertiary)] text-xs text-center py-2">KV Store is empty</div>';
            return;
        }
        const entries = [];
        for (const key of keys.slice(0, 100)) {
            const value = await prism.kvGet(key);
            entries.push({ key, value });
        }
        // eslint-disable-next-line no-unsanitized/property -- values escaped via esc()
    container.innerHTML = entries.map(e => `
            <div class="flex items-center justify-between py-1 px-2 rounded-md hover:bg-[var(--zephyr-bg-muted)]">
                <div class="flex-1 min-w-0">
                    <span class="text-xs text-[var(--text-secondary)] font-mono">${esc(e.key)}</span>
                    <span class="text-2xs text-[var(--text-tertiary)] ml-2 truncate">${esc(JSON.stringify(e.value)?.slice(0, 60) || 'null')}</span>
                </div>
                <div class="flex items-center gap-1 ml-2">
                    <button class="kv-edit-btn text-2xs text-blue-400 hover:text-blue-300" data-key="${esc(e.key)}">edit</button>
                    <button class="kv-delete-key-btn text-2xs text-red-400 hover:text-red-300" data-key="${esc(e.key)}">✕</button>
                </div>
            </div>
        `).join('');

        container.querySelectorAll('.kv-delete-key-btn').forEach(btn => {
            if (!(btn instanceof HTMLElement)) return;
            btn.addEventListener('click', async () => {
                const key = btn.dataset.key;
                if (!key) return;
                try {
                    await prism.kvDelete(key);
                    showNotification(`Deleted: ${key}`, 'success');
                    loadKvStore();
                } catch (e) { showNotification(String(e), 'error'); }
            });
        });

        // kv_set — edit button opens inline edit
        container.querySelectorAll('.kv-edit-btn').forEach(btn => {
            if (!(btn instanceof HTMLElement)) return;
            btn.addEventListener('click', async () => {
                const key = btn.dataset.key;
                if (!key) return;
                const current = await prism.kvGet(key);
                const newVal = prompt(`Edit value for "${key}":`, JSON.stringify(current ?? null, null, 2));
                if (newVal === null) return;
                try {
                    await prism.kvSet(key, JSON.parse(newVal));
                    showNotification(`Updated: ${key}`, 'success');
                    loadKvStore();
                } catch (e) { showNotification(String(e), 'error'); }
            });
        });
    } catch (e) {
        // eslint-disable-next-line no-unsanitized/property -- values escaped via esc()
    container.innerHTML = `<div class="text-red-400 text-xs text-center py-2">${esc(String(e))}</div>`;
    }
}

// ═══════════════════════════════════════════════════════════════════════
//  Scripts Section — Execute / Validate / Sandbox / Limits / Grant/Revoke
// ═══════════════════════════════════════════════════════════════════════

function initScriptsSection() {
    // Run script
    const runBtn = document.getElementById('script-run-btn');
    if (runBtn instanceof HTMLButtonElement) {
        runBtn.addEventListener('click', async () => {
            const scriptEditor = /** @type {HTMLInputElement|HTMLTextAreaElement|null} */ (document.getElementById('script-editor'));
            const scriptNameEl = /** @type {HTMLInputElement|HTMLTextAreaElement|null} */ (document.getElementById('script-name'));
            const code = scriptEditor?.value || '';
            const name = scriptNameEl?.value || 'untitled';
            if (!code.trim()) { showNotification('Script is empty', 'error'); return; }
            runBtn.disabled = true;
            try {
                const result = await prism.scriptExecute(code, name);
                const logArea = document.getElementById('script-output');
                if (logArea instanceof HTMLTextAreaElement || logArea instanceof HTMLInputElement) {
                    logArea.value = result.logs.map(l => `[${l.level}] ${l.message}`).join('\n') +
                        (result.error ? `\nERROR: ${result.error}` : '') +
                        `\n\nDuration: ${result.duration_us}µs — ${result.success ? 'OK' : 'FAILED'}`;
                }
                showNotification(result.success ? 'Script executed' : `Script failed: ${result.error}`, result.success ? 'success' : 'error');
            } catch (e) { showNotification(String(e), 'error'); }
            finally { runBtn.disabled = false; }
        });
    }

    // Validate script
    const validateBtn = document.getElementById('script-validate-btn');
    if (validateBtn) {
        validateBtn.addEventListener('click', async () => {
            const scriptEditor = /** @type {HTMLInputElement|HTMLTextAreaElement|null} */ (document.getElementById('script-editor'));
            const code = scriptEditor?.value || '';
            if (!code.trim()) return;
            try {
                const safe = await prism.scriptValidate(code);
                showNotification(safe ? 'Script is safe' : 'Script contains unsafe patterns', safe ? 'success' : 'error');
            } catch (e) { showNotification(String(e), 'error'); }
        });
    }

    // Sandbox config
    const sandboxSaveBtn = document.getElementById('sandbox-save-btn');
    if (sandboxSaveBtn) {
        sandboxSaveBtn.addEventListener('click', async () => {
            try {
                await prism.scriptSetSandbox({
                    allowNetwork: getCheckboxValue('sandbox-allow-network'),
                    allowFilesystem: getCheckboxValue('sandbox-allow-filesystem'),
                    allowChildProcess: getCheckboxValue('sandbox-allow-child-process'),
                    allowWorkers: getCheckboxValue('sandbox-allow-workers'),
                });
                showNotification('Sandbox config saved', 'success');
                loadSandboxConfig();
            } catch (e) { showNotification(String(e), 'error'); }
        });
    }
    loadSandboxConfig();

    // Limits config
    const limitsSaveBtn = document.getElementById('limits-save-btn');
    if (limitsSaveBtn) {
        limitsSaveBtn.addEventListener('click', async () => {
            try {
                await prism.scriptSetLimits({
                    maxExecutionTimeMs: getNumberInput('limit-exec-time', 5000),
                    maxMemoryBytes: getNumberInput('limit-memory', 52428800),
                    maxLoopIterations: getNumberInput('limit-loops', 100000),
                    maxRecursionDepth: getNumberInput('limit-recursion', 32),
                });
                showNotification('Script limits saved', 'success');
                loadLimitsConfig();
            } catch (e) { showNotification(String(e), 'error'); }
        });
    }
    loadLimitsConfig();
}

async function loadSandboxConfig() {
    try {
        const sb = await prism.scriptGetSandbox();
        setCheckboxValue('sandbox-allow-network', sb.allowNetwork);
        setCheckboxValue('sandbox-allow-filesystem', sb.allowFilesystem);
        setCheckboxValue('sandbox-allow-child-process', sb.allowChildProcess);
        setCheckboxValue('sandbox-allow-workers', sb.allowWorkers);
        // Show safety status
        const safe = await prism.scriptIsSandboxSafe();
        const indicator = document.getElementById('sandbox-safe-indicator');
        if (indicator) {
            indicator.textContent = safe ? '● Safe' : '● Unsafe';
            indicator.className = `text-xs ${safe ? 'text-green-400' : 'text-red-400'}`;
        }
    } catch {}
}

async function loadLimitsConfig() {
    try {
        const lim = await prism.scriptGetLimits();
        setInputValue('limit-exec-time', lim.maxExecutionTimeMs);
        setInputValue('limit-memory', lim.maxMemoryBytes);
        setInputValue('limit-loops', lim.maxLoopIterations);
        setInputValue('limit-recursion', lim.maxRecursionDepth);
    } catch {}
}

// ═══════════════════════════════════════════════════════════════════════
//  Smart & Failover Page — Full integration
// ═══════════════════════════════════════════════════════════════════════

function initSmartPage() {
    loadSmartConfig();
    loadFailoverPolicy();
    loadSmartRankings();

    // Save smart config (with validation)
    const saveSmartBtn = document.getElementById('smart-save-config-btn');
    if (saveSmartBtn) {
        saveSmartBtn.addEventListener('click', async () => {
            // Validate before save
            try {
                const errors = await prism.smartValidateConfig();
                if (errors.length > 0) {
                    showNotification(`Config validation failed: ${errors.join('; ')}`, 'error');
                    return;
                }
            } catch {}
            await saveSmartConfig();
        });
    }

    // Clear history
    const clearHistoryBtn = document.getElementById('smart-clear-history-btn');
    if (clearHistoryBtn) {
        clearHistoryBtn.addEventListener('click', async () => {
            try {
                await prism.smartClearHistory();
                showNotification('Smart history cleared', 'success');
                loadSmartRankings();
            } catch (e) { showNotification(String(e), 'error'); }
        });
    }

    // Save failover policy
    const saveFailoverBtn = document.getElementById('failover-save-btn');
    if (saveFailoverBtn) saveFailoverBtn.addEventListener('click', saveFailoverPolicy);

    // Reset failover counts
    const resetFailoverBtn = document.getElementById('failover-reset-btn');
    if (resetFailoverBtn) {
        resetFailoverBtn.addEventListener('click', async () => {
            try {
                await prism.failoverReset();
                showNotification('Failover counts reset', 'success');
            } catch (e) { showNotification(String(e), 'error'); }
        });
    }

    // Refresh rankings
    const rankRefreshBtn = document.getElementById('smart-rank-refresh-btn');
    if (rankRefreshBtn) rankRefreshBtn.addEventListener('click', loadSmartRankings);

    // Select best node
    const selectBestBtn = document.getElementById('smart-select-best-btn');
    if (selectBestBtn) {
        selectBestBtn.addEventListener('click', async () => {
            try {
                const best = await prism.smartSelectBest();
                if (best) {
                    showNotification(t('notifBestNode', { name: best.name, score: best.score?.toFixed(1) || '?' }), 'success');
                } else {
                    showNotification(t('notifNoNodesForSelection'), 'error');
                }
            } catch (e) { showNotification(String(e), 'error'); }
        });
    }

    // Trim history
    const trimBtn = document.getElementById('smart-trim-btn');
    if (trimBtn) {
        trimBtn.addEventListener('click', async () => {
            const trimMaxEl = /** @type {HTMLInputElement|HTMLTextAreaElement|null} */ (document.getElementById('smart-trim-max'));
            const max = parseInt(trimMaxEl?.value || '500', 10);
            try {
                await prism.smartTrimHistory(max);
                showNotification(`History trimmed to ${max} records`, 'success');
                loadSmartRankings();
            } catch (e) { showNotification(String(e), 'error'); }
        });
    }

    // Load scheduler config display
    loadSchedulerConfig();
}

async function loadSmartConfig() {
    try {
        const config = /** @type {Record<string, any>} */ (await prism.smartConfig());
        if (!config) return;
        const score = config.score || {};
        const weights = score.weights || {};
        const decay = score.decay || {};
        const scheduler = config.scheduler || {};
        setInputValue('smart-weight-latency', weights.latency_p90 ?? 0.4);
        setInputValue('smart-weight-success', weights.success_rate ?? 0.4);
        setInputValue('smart-weight-stability', weights.stability ?? 0.2);
        setInputValue('smart-decay-half-life', decay.half_life_hours ?? 1.0);
        setInputValue('smart-base-interval', scheduler.base_interval_secs ?? 300);
        setCheckboxValue('smart-adaptive-toggle', scheduler.adaptive !== false);
    } catch {}
}

async function saveSmartConfig() {
    try {
        // Fetch current config to preserve the enabled state
        const currentConfig = /** @type {Record<string, any>} */ (await prism.smartConfig().catch(() => ({})));
        await prism.smartConfigSave({
            enabled: currentConfig.enabled ?? false,
            score: {
                type: 'ema',
                weights: {
                    latency_p90: getNumberInput('smart-weight-latency', 0.4),
                    success_rate: getNumberInput('smart-weight-success', 0.4),
                    stability: getNumberInput('smart-weight-stability', 0.2),
                },
                decay: { half_life_hours: getNumberInput('smart-decay-half-life', 1.0) },
            },
            scheduler: {
                base_interval_secs: getNumberInput('smart-base-interval', 300),
                adaptive: getCheckboxValue('smart-adaptive-toggle'),
                max_interval_secs: 3600,
                min_interval_secs: 10,
            },
        });
        showNotification('Smart config saved', 'success');
    } catch (e) { showNotification(String(e), 'error'); }
}

async function loadSchedulerConfig() {
    const container = document.getElementById('scheduler-info');
    if (!container) return;
    try {
        const sc = /** @type {Record<string, any>} */ (await prism.smartSchedulerConfig());
        // eslint-disable-next-line no-unsanitized/property -- values escaped via esc()
    container.innerHTML = `            <div class="flex gap-4 text-2xs text-[var(--text-muted)]">
                <span>Base: ${sc.baseIntervalSecs}s</span>
                <span>Adaptive: ${sc.adaptive ? 'on' : 'off'}</span>
                <span>Max: ${sc.maxIntervalSecs || 3600}s</span>
                <span>Min: ${sc.minIntervalSecs || 10}s</span>
            </div>`;
    } catch {}
}

async function loadFailoverPolicy() {
    try {
        const policy = /** @type {Record<string, any>} */ (await prism.failoverGetPolicy());
        if (!policy) return;
        setCheckboxValue('failover-enabled-toggle', policy.enabled ?? false);
        setInputValue('failover-threshold', policy.threshold ?? 3);
        setInputValue('failover-cooldown', policy.cooldownSecs ?? 60);
        setInputValue('failover-fallback-group', policy.fallbackGroup || '');
    } catch {}
}

async function saveFailoverPolicy() {
    try {
        await prism.failoverSetPolicy({
            enabled: getCheckboxValue('failover-enabled-toggle'),
            threshold: getNumberInput('failover-threshold', 3),
            cooldownSecs: getNumberInput('failover-cooldown', 60),
            fallbackGroup: getStringInput('failover-fallback-group') || undefined,
        });
        showNotification('Failover policy saved', 'success');
    } catch (e) { showNotification(String(e), 'error'); }
}

async function loadSmartRankings() {
    const container = document.getElementById('smart-rankings-list');
    if (!container) return;
    try {
        const rankings = await prism.smartRank();
        if (!rankings || rankings.length === 0) {
             
    container.innerHTML = '<div class="text-[var(--text-tertiary)] text-xs text-center py-4">No ranking data. Run speed tests first.</div>';
            return;
        }
        // eslint-disable-next-line no-unsanitized/property -- values escaped via esc()
    container.innerHTML = rankings.map((r, i) => {
            const score = typeof r.score === 'number' ? r.score.toFixed(1) : '?';
            const barWidth = Math.min(100, Math.max(0, Number(r.score) || 0));
            const barColor = barWidth >= 80 ? 'bg-success' : barWidth >= 50 ? 'bg-warning' : 'bg-danger';
            return `
                <div class="flex items-center gap-3 py-1">
                    <span class="text-2xs text-[var(--text-tertiary)] w-6 text-right">#${i + 1}</span>
                    <span class="text-xs text-[var(--text-secondary)] flex-1 truncate font-mono">${esc(r.name || 'Unknown')}</span>
                    <div class="w-24 h-2 bg-[var(--zephyr-bg-input)] rounded-full overflow-hidden">
                        <div class="${barColor} h-full rounded-full transition-[width]" style="width: ${barWidth}%"></div>
                    </div>
                    <span class="text-xs font-bold text-[var(--text-primary)] w-10 text-right">${score}</span>
                </div>`;
        }).join('');
    } catch (e) {
        // eslint-disable-next-line no-unsanitized/property -- values escaped via esc()
    container.innerHTML = `<div class="text-red-400 text-xs text-center py-4">${esc(String(e))}</div>`;
    }
}

// ═══════════════════════════════════════════════════════════════════════
//  Helpers
// ═══════════════════════════════════════════════════════════════════════

/**
 * @param {string} str
 */
function esc(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
}

/**
 * @param {string} id
 * @param {string|number} value
 */
function setInputValue(id, value) {
    const el = document.getElementById(id);
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) el.value = String(value);
}

/**
 * @param {string} id
 * @returns {string}
 */
function getStringInput(id) {
    const el = document.getElementById(id);
    return (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) ? (el.value?.trim() || '') : '';
}

/**
 * @param {string} id
 * @param {number} fb
 * @returns {number}
 */
function getNumberInput(id, fb) {
    const el = document.getElementById(id);
    if (!(el instanceof HTMLInputElement)) return fb;
    const v = parseFloat(el.value);
    return isNaN(v) ? fb : v;
}

/**
 * @param {string} id
 * @returns {boolean}
 */
function getCheckboxValue(id) {
    const el = document.getElementById(id);
    return el instanceof HTMLInputElement ? el.checked : false;
}

/**
 * @param {string} id
 * @param {boolean} value
 */
function setCheckboxValue(id, value) {
    const el = document.getElementById(id);
    if (el instanceof HTMLInputElement) el.checked = !!value;
}
