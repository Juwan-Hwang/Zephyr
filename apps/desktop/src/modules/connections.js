// @ts-check
/**
 * Connections Module
 * 
 * Manages the active/closed connections view with real-time polling,
 * delta-based cumulative tracking, tab switching, search, and bulk actions.
 * 
 * Dependencies (imported):
 *   - getConnections, closeConnection, closeAllConnections from ./api.js
 *   - showNotification from ../ui/notifications.js
 *   - translations, currentLang, applyTranslations from ../i18n.js
 *   - escapeHtml from ../utils/sanitize.js
 *   - formatBytes, formatSpeed from ../utils/format.js
 *   - connectionsLogger from ../utils/logger.js
 * 
 * Exports:
 *   - initConnectionsPage()
 *   - destroyConnectionsPage()
 */

import { getConnections, closeConnection, closeAllConnections, isCoreReachable } from '../api.js';
import { showNotification } from '../ui/notifications.js';
import { translations, currentLang, applyTranslations } from '../i18n.js';
import { escapeHtml } from '../utils/sanitize.js';
import { formatBytes, formatSpeed } from '../utils/format.js';
import { connectionsLogger } from '../utils/logger.js';
import { Bus, Events } from '../ui/events.js';

// ============================================
// State
// ============================================

/** @type {number|null} */
let connectionsPollTimer = null;
let connectionsSearchQuery = '';
/** @type {any[]} */
let cachedConnections = [];
/** @type {any[]} */
let closedConnections = [];
let currentConnTab = 'active'; // 'active' | 'closed'
const MAX_CLOSED_CONNS = 200;

/** Sort state: { key: string, dir: 'asc'|'desc' } or null */
/** @type {{ key: string, dir: string } | null} */
let connSortState = null;

/** @type {Record<string, {dl: number, ul: number, prevDl: number, prevUl: number, seenAt: number, prevTs: number, dlSpeed: number, ulSpeed: number}>} */
let connAccumulators = {};

/** Currently viewed connection in detail panel (for live refresh) */
/** @type {string|null} */
let activeDetailConnId = null;
/** @type {string|null} */
let activeDetailMode = null;

/** Debounce flag to prevent overlapping fetches */
let isFetching = false;

/** Grand totals (kept for future use) */
let _totalDownloaded = 0;
let _totalUploaded = 0;

/** @type {Function|null} */
let _unsubI18n = null;
/** @type {Function|null} */
let _unsubTheme = null;
/** Generation counter to invalidate stale poll callbacks on re-init */
let _pollGeneration = 0;
/** @type {(() => void) | null} Visibility change handler, cleaned up on destroy. */
let _visibilityHandler = null;

// HTML template for the connections page (injected into DOM on init)
const PAGE_HTML = `
<header class="flex items-center justify-between relative z-10 shrink-0">
    <div>
        <h2 class="text-2xl font-light text-[var(--text-primary)]" data-i18n="connectionsTitle">Connections</h2>
    </div>
    <div class="flex items-center gap-3">
        <!-- Search -->
        <div class="relative group flex items-center">
            <div class="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                <svg class="h-4 w-4 text-[var(--text-secondary)] group-focus-within:text-[var(--text-primary)] transition-colors duration-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
            </div>
            <input type="text" id="connections-search-input" placeholder="Search connections..." data-i18n-placeholder="searchConnections" class="bg-[var(--zephyr-bg-muted)] border border-[var(--zephyr-border-default)] rounded-full py-2 px-5 pl-11 text-[var(--text-primary)] text-xs w-52 transition-all duration-400 focus:outline-none focus:border-[var(--zephyr-border-strong)] focus:bg-[var(--zephyr-bg-input)] focus:w-72 placeholder:text-[var(--text-secondary)] shadow-inner">
        </div>
        <!-- Close All / Clear All Button -->
        <button id="close-all-conns-btn" class="btn-danger">
            <svg id="action-btn-icon" class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            <span id="action-btn-text" data-i18n="closeAll">Close All</span>
        </button>
        <!-- Refresh Button -->
        <button id="refresh-conns-btn" class="btn-ghost">
            <svg id="conns-refresh-icon" class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg>
            <span data-i18n="refresh">Refresh</span>
        </button>
    </div>
</header>

<!-- Stats Bar - 4 columns: Total | ↓Total | ↑Total | Active -->
<div id="conn-stats-bar" class="glass-card p-4 relative z-10 shrink-0 grid grid-cols-4 gap-4">
    <div class="flex flex-col items-center justify-center">
        <span id="stat-total" class="text-xl font-extralight text-[var(--text-primary)] tabular-nums">0</span>
        <span class="text-2xs text-[var(--text-muted)] uppercase tracking-wider" data-i18n="totalConn">Total</span>
    </div>
    <div class="flex flex-col items-center justify-center">
        <span id="stat-dl-total" class="text-lg font-semibold text-download tabular-nums">0 B</span>
        <span class="text-2xs text-[var(--text-muted)] uppercase tracking-wider" data-i18n="dlTotal">↓ Total</span>
    </div>
    <div class="flex flex-col items-center justify-center">
        <span id="stat-ul-total" class="text-lg font-semibold text-upload tabular-nums">0 B</span>
        <span class="text-2xs text-[var(--text-muted)] uppercase tracking-wider" data-i18n="ulTotal">↑ Total</span>
    </div>
    <div class="flex flex-col items-center justify-center">
        <span id="stat-active" class="text-lg font-semibold text-success tabular-nums">0</span>
        <span class="text-2xs text-[var(--text-muted)] uppercase tracking-wider" data-i18n="activeConn">Active</span>
    </div>
</div>

<!-- Connection List Container with Tabs -->
<div id="connections-list-container" class="glass-card flex-1 overflow-hidden relative z-10 flex flex-col min-h-0">
    <!-- Tab Bar + Table Header -->
    <div class="shrink-0">
        <!-- Tabs -->
        <div class="flex items-center px-4 pt-3 pb-0 gap-1">
            <button id="conn-tab-active" class="conn-tab active px-4 py-2 text-xs font-bold uppercase tracking-wider rounded-t-lg transition-colors duration-200 text-accent border-b-2 border-accent" data-i18n="activeTab">Active</button>
            <button id="conn-tab-closed" class="conn-tab px-4 py-2 text-xs font-normal uppercase tracking-wider rounded-t-lg transition-colors duration-200 text-[var(--text-muted)] hover:text-[var(--text-secondary)] border-b-2 border-transparent" data-i18n="closedTab">Closed</button>
            <div class="flex-1"></div>
            <span id="closed-count-badge" class="hidden text-2xs text-[var(--text-tertiary)] tabular-nums"></span>
        </div>
        <!-- Table Header (clickable for sort) -->
        <div style="display:grid; grid-template-columns: 4fr 2fr 2fr 2fr 2fr 2fr 2fr; gap:0.5rem; padding:0.625rem 1rem; user-select:none;" id="conn-table-header">
            <div style="padding-left:0.25rem; font-size:9px; font-weight:700; color:#71717a; text-transform:uppercase; letter-spacing:0.1em; cursor:pointer;" class="sortable" data-sort="host" data-i18n="hostCol">Host</div>
            <div style="font-size:9px; font-weight:700; color:#71717a; text-transform:uppercase; letter-spacing:0.1em; cursor:pointer;" class="sortable" data-sort="rule" data-i18n="ruleCol">Rule</div>
            <div style="text-align:right; padding-right:0.5rem; font-size:9px; font-weight:700; color:#71717a; text-transform:uppercase; letter-spacing:0.1em; cursor:pointer;" class="sortable" data-sort="chains" data-i18n="chainsCol">Chains</div>
            <div style="text-align:right; padding-right:0.25rem; font-size:9px; font-weight:700; color:var(--zephyr-color-download); text-transform:uppercase; letter-spacing:0.1em; cursor:pointer;" class="sortable hover:text-download transition-colors" data-sort="dlSpeed" data-i18n="dlSpeedCol">↓ Speed</div>
            <div style="text-align:right; padding-right:0.25rem; font-size:9px; font-weight:700; color:color-mix(in srgb, var(--zephyr-color-download) 50%, transparent); text-transform:uppercase; letter-spacing:0.1em; cursor:pointer;" class="sortable hover:text-download/70 transition-colors" data-sort="dlTotal" data-i18n="dlTotalCol">↓ Total</div>
            <div style="text-align:right; padding-right:0.25rem; font-size:9px; font-weight:700; color:var(--zephyr-color-upload); text-transform:uppercase; letter-spacing:0.1em; cursor:pointer;" class="sortable hover:text-upload transition-colors" data-sort="ulSpeed" data-i18n="ulSpeedCol">↑ Speed</div>
            <div style="text-align:right; padding-right:0.5rem; font-size:9px; font-weight:700; color:color-mix(in srgb, var(--zephyr-color-upload) 50%, transparent); text-transform:uppercase; letter-spacing:0.1em; cursor:pointer;" class="sortable hover:text-upload/70 transition-colors" data-sort="ulTotal" data-i18n="ulTotalCol">↑ Total</div>
        </div>
    </div>
    <!-- List Body -->
    <div id="connections-list" class="flex-1 overflow-y-auto custom-scrollbar py-1 pb-1 space-y-0.5 px-2">
        <!-- Empty State (Active) -->
        <div id="connections-empty" class="flex flex-col items-center justify-center h-full py-16 gap-3">
            <svg class="w-12 h-12 text-[var(--text-tertiary)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="17" r="4"/><path d="M4 17l6-6-6-6"/><path d="M13 11h8"/></svg>
            <p class="text-sm text-[var(--text-tertiary)]" data-i18n="noConnections">No active connections</p>
            <p class="text-2xs text-[var(--text-tertiary)]" data-i18n="noConnectionsHint">Connections will appear here as traffic flows through the proxy</p>
        </div>
        <!-- Empty State (Closed) -->
        <div id="connections-closed-empty" class="hidden flex flex-col items-center justify-center h-full py-16 gap-3">
            <svg class="w-12 h-12 text-[var(--text-tertiary)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
            <p class="text-sm text-[var(--text-tertiary)]" data-i18n="noClosedConns">No closed connections yet</p>
            <p class="text-2xs text-[var(--text-tertiary)]" data-i18n="noClosedConnsHint">Closed connections will appear here after you close them</p>
        </div>
    </div>
</div>
`;

// ============================================
// Public API
// ============================================

/**
 * Initialize the Connections page.
 * Injects HTML template into container, binds events, starts polling.
 */
export function initConnectionsPage() {
    const container = document.querySelector('[data-page="connections"]');
    if (!container) return;

    // Inject template if not already present
    if (!document.getElementById('conn-stats-bar')) {
        // eslint-disable-next-line no-unsanitized/property -- static HTML template (PAGE_HTML is a hardcoded string)
        container.innerHTML = PAGE_HTML;
        // Apply i18n translations to newly injected DOM elements
        applyTranslations();
    }

    // Clear any existing poll
    if (connectionsPollTimer != null) {
        clearTimeout(connectionsPollTimer);
        connectionsPollTimer = null;
    }
    _pollGeneration++;

    bindConnectionsEvents();
    bindConnTabEvents();
    fetchAndRenderConnections();

// Re-apply sort arrows when i18n/theme changes wipe header text
const _onI18nApplied = () => updateSortIndicators();
const _onThemeChanged = () => updateSortIndicators();
_unsubI18n = Bus.on(Events.I18N_APPLIED, _onI18nApplied);
_unsubTheme = Bus.on(Events.THEME_MODE_CHANGED, _onThemeChanged);

    // Auto-refresh: 2s when core is reachable, 15s when unreachable
    // Using recursive setTimeout to dynamically adjust interval
    const generation = _pollGeneration;
    function schedulePoll() {
        const interval = isCoreReachable() ? 2000 : 15000;
        connectionsPollTimer = setTimeout(async () => {
            // Skip if a new init invalidated this generation
            if (generation !== _pollGeneration) return;
            const pageEl = document.querySelector('[data-page="connections"]');
            if (pageEl && !pageEl.classList.contains('hidden') && !document.hidden) {
                await fetchAndRenderConnections();
            } else {
                // Window or page is hidden — pause the poll loop entirely.
                // The visibilitychange handler will restart it when appropriate.
                connectionsPollTimer = null;
                return;
            }
            // Only schedule next poll if not destroyed during await
            if (connectionsPollTimer != null && generation === _pollGeneration) {
                schedulePoll();
            }
        }, interval);
    }
    schedulePoll();

    // Restart polling when the window becomes visible again
    if (_visibilityHandler) {
        document.removeEventListener('visibilitychange', _visibilityHandler);
    }
    _visibilityHandler = () => {
        const pageEl = document.querySelector('[data-page="connections"]');
        const isPageActive = pageEl && !pageEl.classList.contains('hidden');
        if (!document.hidden && isPageActive && connectionsPollTimer == null && generation === _pollGeneration) {
            fetchAndRenderConnections();
            schedulePoll();
        }
    };
    document.addEventListener('visibilitychange', _visibilityHandler);
}


/**
 * Clean up resources when navigating away.
 */
export function destroyConnectionsPage() {
    if (connectionsPollTimer != null) {
        clearTimeout(connectionsPollTimer);
        connectionsPollTimer = null;
    }
    if (_visibilityHandler) {
        document.removeEventListener('visibilitychange', _visibilityHandler);
        _visibilityHandler = null;
    }
    if (_unsubI18n) { _unsubI18n(); _unsubI18n = null; }
    if (_unsubTheme) { _unsubTheme(); _unsubTheme = null; }
}

// ============================================
// Tab Switching
// ============================================

function bindConnTabEvents() {
    const activeClone = bindOnce(document.getElementById('conn-tab-active'));
    const closedClone = bindOnce(document.getElementById('conn-tab-closed'));

    if (activeClone) activeClone.addEventListener('click', () => switchConnTab('active'));
    if (closedClone) closedClone.addEventListener('click', () => switchConnTab('closed'));
}

/** @param {string} tab */
function switchConnTab(tab) {
    currentConnTab = tab;
    const activeTab = document.getElementById('conn-tab-active');
    const closedTab = document.getElementById('conn-tab-closed');
    const actionBtn = document.querySelector('button#close-all-conns-btn');
    const actionIcon = document.getElementById('action-btn-icon');
    const actionText = document.getElementById('action-btn-text');
    const t = /** @type {any} */ (translations)[currentLang] ?? {};

    // Control nav icon animation: play on active, pause on closed
    const navEl = document.querySelector('[data-nav="connections"]');
    if (navEl) {
        navEl.classList.toggle('conn-nav-paused', tab !== 'active');
    }

    if (tab === 'active') {
        activeTab?.classList.add('text-accent', 'border-accent', 'font-bold', 'active');
        activeTab?.classList.remove('text-[var(--text-muted)]', 'border-transparent', 'font-normal');
        closedTab?.classList.remove('text-accent', 'border-accent', 'font-bold', 'active');
        closedTab?.classList.add('text-[var(--text-muted)]', 'border-transparent', 'font-normal');

        if (actionBtn instanceof HTMLButtonElement) {
            actionBtn.className = 'btn-danger';
            actionBtn.disabled = false;
            if (actionIcon) { actionIcon.classList.remove('animate-spin'); actionIcon.innerHTML = '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>'; }
            if (actionText) { actionText.textContent = t.closeAll || 'Close All'; actionText.setAttribute('data-i18n', 'closeAll'); }
        }
    } else {
        closedTab?.classList.add('text-accent', 'border-accent', 'font-bold', 'active');
        closedTab?.classList.remove('text-[var(--text-muted)]', 'border-transparent', 'font-normal');
        activeTab?.classList.remove('text-accent', 'border-accent', 'font-bold', 'active');
        activeTab?.classList.add('text-[var(--text-muted)]', 'border-transparent', 'font-normal');

        if (actionBtn instanceof HTMLButtonElement) {
            actionBtn.className = 'btn-warning';
            actionBtn.disabled = false;
            if (actionIcon) { actionIcon.classList.remove('animate-spin'); actionIcon.innerHTML = '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/>'; }
            if (actionText) { actionText.textContent = t.clearAll || 'Clear All'; actionText.setAttribute('data-i18n', 'clearAll'); }
        }
    }

    renderConnectionList(
        tab === 'active' ? cachedConnections : closedConnections,
        tab === 'active' ? 'active' : 'closed'
    );
}

// ============================================
// Event Bindings
// ============================================

function bindConnectionsEvents() {
    const searchClone = bindOnce(document.getElementById('connections-search-input'));
    const closeAllClone = bindOnce(document.getElementById('close-all-conns-btn'));
    const refreshClone = bindOnce(document.getElementById('refresh-conns-btn'));

    if (searchClone) {
        searchClone.addEventListener('input', (e) => {
            const target = /** @type {HTMLInputElement} */ (e.target);
            connectionsSearchQuery = target.value.trim().toLowerCase();
            renderConnectionList(
                currentConnTab === 'active' ? cachedConnections : closedConnections,
                currentConnTab
            );
        });
    }

    if (closeAllClone) {
        closeAllClone.addEventListener('click', () => {
            if (currentConnTab === 'closed') handleClearClosedConnections();
            else handleCloseAllConnections();
        });
    }

    if (refreshClone) {
        refreshClone.addEventListener('click', () => fetchAndRenderConnections());
    }

    // Bind sortable header clicks
    bindHeaderSortEvents();
}

// ============================================
// Core Data Pipeline
// ============================================

async function fetchAndRenderConnections() {
    if (isFetching) return;
    isFetching = true;

    try {
        const data = await getConnections();
        const incomingConns = (/** @type {any} */ (data)).connections || [];

        // ── Phase 1: Detect dead connections & archive them ──
        const aliveIds = new Set(incomingConns.map(/** @param {any} c */ (c) => c.id));
        const now = Date.now();

        for (const oldConn of cachedConnections) {
            if (!aliveIds.has(oldConn.id)) {
                closedConnections.unshift(archiveConnection(oldConn, now));
                delete connAccumulators[oldConn.id];
            }
        }

        if (closedConnections.length > MAX_CLOSED_CONNS) {
            closedConnections.length = MAX_CLOSED_CONNS;
        }

        // ── Phase 2: Update accumulators (delta-based total + speed tracking) ──
        // Mihomo reports download/upload as cumulative bytes per connection.
        // Speed = deltaBytes / deltaTime (bytes per second)
        for (const conn of incomingConns) {
            const id = conn.id;
            const curDl = conn.download ?? 0;
            const curUl = conn.upload ?? 0;

            if (!connAccumulators[id]) {
                // First time seeing this connection — baseline, speed starts at 0
                connAccumulators[id] = { dl: 0, ul: 0, prevDl: curDl, prevUl: curUl, seenAt: now, prevTs: now, dlSpeed: 0, ulSpeed: 0 };
            } else {
                const acc = connAccumulators[id];
                const dt = (now - acc.prevTs) / 1000; // seconds since last poll

                // Positive-only delta guards against counter resets or API quirks
                const dlDelta = Math.max(0, curDl - acc.prevDl);
                const ulDelta = Math.max(0, curUl - acc.prevUl);

                acc.dl += dlDelta;
                acc.ul += ulDelta;

                // Compute instantaneous speed (bytes/sec), with smoothing for dt < 100ms edge case
                if (dt > 0.05) {
                    acc.dlSpeed = dlDelta / dt;
                    acc.ulSpeed = ulDelta / dt;
                }
                // else: keep previous speed (poll too fast or duplicate)

                acc.prevDl = curDl;
                acc.prevUl = curUl;
                acc.prevTs = now;
            }
        }

        cachedConnections = incomingConns;

        // ── Phase 3: Update UI ──
        updateConnStats(incomingConns);

        renderConnectionList(
            currentConnTab === 'active' ? incomingConns : closedConnections,
            currentConnTab
        );

        updateClosedBadge();

        // ── Phase 3.5: Live-refresh detail panel if open ──
        if (activeDetailConnId) {
            refreshDetailPanel(activeDetailConnId, /** @type {string} */ (activeDetailMode));
        }

    } catch (err) {
        const metaEl = document.getElementById('connections-meta');
        const t = /** @type {any} */ (translations)[currentLang] ?? {};
        if (metaEl) {
            metaEl.textContent = t.loadFailed || 'Failed to load connections';
        }
        const _err = err instanceof Error ? err : new Error(String(err));
        if (!_err.message?.includes('Failed to fetch') && !_err.message?.includes('NetworkError')) {
            connectionsLogger.warn('Fetch error', err);
        }
    } finally {
        isFetching = false;
    }
}

// ============================================
// Stats Computation
// ============================================

/** @param {any[]} conns */
function updateConnStats(conns) {
    const totalEl = document.getElementById('stat-total');
    const dlTotalEl = document.getElementById('stat-dl-total');
    const ulTotalEl = document.getElementById('stat-ul-total');
    const activeEl = document.getElementById('stat-active');

    const total = conns.length + closedConnections.length;
    const active = conns.filter(/** @param {any} c */ (c) => (c.download ?? 0) > 0 || (c.upload ?? 0) > 0).length;

    let grandDl = 0, grandUl = 0;
    for (const acc of Object.values(connAccumulators)) {
        grandDl += acc.dl;
        grandUl += acc.ul;
    }
    for (const c of closedConnections) {
        grandDl += c.dlTotal ?? 0;
        grandUl += c.ulTotal ?? 0;
    }

    _totalDownloaded = grandDl;
    _totalUploaded = grandUl;

    if (totalEl) totalEl.textContent = String(total);
    if (dlTotalEl) dlTotalEl.textContent = formatBytes(grandDl);
    if (ulTotalEl) ulTotalEl.textContent = formatBytes(grandUl);
    if (activeEl) activeEl.textContent = String(active);
}

// ============================================
// Sorting
// ============================================

/** Keys that sort as strings (lexicographic) rather than numerically */
const SORT_TEXT_KEYS = new Set(['host', 'rule', 'chains']);

// ============================================
// Rendering
// ============================================

/**
 * @param {any[]} connections
 * @param {string} mode
 */
function renderConnectionList(connections, mode) {
    const container = document.getElementById('connections-list');
    const emptyState = document.getElementById('connections-empty');
    const closedEmptyState = document.getElementById('connections-closed-empty');
    if (!container) return;

    let filtered = connections;
    if (connectionsSearchQuery) {
        const q = connectionsSearchQuery;
        filtered = connections.filter(/** @param {any} c */ (c) => {
            const m = c.metadata ?? {};
            return (m.host ?? '').toLowerCase().includes(q)
                || (m.destinationIP ?? '').toLowerCase().includes(q)
                || String(m.destinationPort ?? '').toLowerCase().includes(q)
                || (c.rule ?? '').toLowerCase().includes(q)
                || (c.chains ?? []).join(' ').toLowerCase().includes(q)
                || (m.process ?? '').toLowerCase().includes(q);
        });
    }

    if (filtered.length === 0) {
        container.innerHTML = '';
        const tpl = mode === 'active' ? emptyState : closedEmptyState;
        if (tpl) {
            const clone = /** @type {HTMLElement} */ (tpl.cloneNode(true));
            clone.classList.remove('hidden');
            container.appendChild(clone);
        }
        return;
    }

    // Apply sort if active
    if (connSortState) {
        const { key, dir } = connSortState;
        const mul = dir === 'desc' ? -1 : 1;
        const isText = SORT_TEXT_KEYS.has(key);
        filtered.sort((/** @type {any} */ a, /** @type {any} */ b) => {
            const va = getConnSortValue(a, key, mode);
            const vb = getConnSortValue(b, key, mode);
            if (isText) {
                // Lexicographic comparison for text columns
                return va.localeCompare(vb) * mul;
            }
            // Numeric comparison for speed/total columns
            let cmp;
            if (va < vb) cmp = -1;
            else if (va > vb) cmp = 1;
            else cmp = 0;
            return cmp * mul;
        });
    }

    // eslint-disable-next-line no-unsanitized/property -- values escaped via _esc() in buildConnectionRow
    container.innerHTML = filtered.map((/** @type {any} */ conn) => buildConnectionRow(conn, mode)).join('');

    // Bind row click → open detail panel
    for (const row of container.querySelectorAll('.conn-row')) {
        /** @type {HTMLElement} */ (row).addEventListener('click', () => {
            const connId = /** @type {HTMLElement} */ (row).dataset.connId;
            const connMode = /** @type {HTMLElement} */ (row).dataset.mode;
            const sourceList = connMode === 'closed' ? closedConnections : cachedConnections;
            const conn = sourceList.find(c => c.id === connId);
            if (conn) showConnDetail(conn, /** @type {string} */ (connMode));
        });
    }

    // Re-apply sort arrows (in case i18n or other code reset header text)
    updateSortIndicators();
}

// ============================================
// Sorting
// ============================================

/**
 * Extract a numeric sort value from a connection for the given sort key.
 * Returns raw numbers for correct ordering.
 */
/**
 * @param {any} conn
 * @param {string} key
 * @param {string} mode
 */
function getConnSortValue(conn, key, mode) {
    switch (key) {
        case 'host': return (conn.metadata?.host ?? '').toLowerCase();
        case 'rule': return (conn.rule ?? '').toLowerCase();
        case 'chains': return (conn.chains ?? []).join(' → ').toLowerCase();
        case 'dlSpeed': return mode === 'closed' ? (conn.dlSpeed ?? 0) : (connAccumulators[conn.id]?.dlSpeed ?? 0);
        case 'dlTotal': return mode === 'closed' ? (conn.dlTotal ?? 0) : (connAccumulators[conn.id]?.dl ?? 0);
        case 'ulSpeed': return mode === 'closed' ? (conn.ulSpeed ?? 0) : (connAccumulators[conn.id]?.ulSpeed ?? 0);
        case 'ulTotal': return mode === 'closed' ? (conn.ulTotal ?? 0) : (connAccumulators[conn.id]?.ul ?? 0);
        default: return 0;
    }
}

/**
 * Update sort arrow indicators in the table header.
 * Shows ▲/▼ next to the active sort column.
 */
function updateSortIndicators() {
    const header = document.getElementById('conn-table-header');
    if (!header) return;
    for (const cell of header.querySelectorAll('.sortable')) {
        const sortKey = /** @type {HTMLElement} */ (cell).dataset.sort;

        // Each column's original color (matches the inline style in PAGE_HTML)
        const originalColors = {
            host:   '#71717a', rule: '#71717a', chains: '#71717a',
            dlSpeed: 'rgba(168,85,247,0.7)', dlTotal: 'rgba(168,85,247,0.5)',
            ulSpeed: 'rgba(59,130,246,0.7)',  ulTotal: 'rgba(59,130,246,0.5)',
        };
        const origColor = (/** @type {Record<string, string>} */ (originalColors))[/** @type {string} */ (sortKey)] || '';

        if (connSortState && sortKey === connSortState.key) {
            // Active column: show text + arrow
            // CRITICAL: always derive base from i18n dict, NEVER from cell.textContent
            // (which may contain a stale arrow from previous render)
            const isAsc = connSortState.dir === 'asc';
            const i18nKey = /** @type {HTMLElement} */ (cell).getAttribute('data-i18n');
            const t = /** @type {any} */ (translations)[currentLang] ?? {};
            let base = '';
            if (i18nKey && t[i18nKey]) {
                base = t[i18nKey];
            } else {
                // Fallback: strip any existing arrow from current text
                base = (/** @type {HTMLElement} */ (cell)).textContent.replace(/\s*[\u25B2\u25BC]\s*$/, '').trim();
            }
            (/** @type {HTMLElement} */ (cell)).textContent = `${base} ${isAsc ? '\u25B2' : '\u25BC'}`;
            // Active color: BRIGHT highlight, unmistakable in both modes
            if (SORT_TEXT_KEYS.has(sortKey)) {
                (/** @type {HTMLElement} */ (cell)).style.color = '#facc15';  /* yellow-400: bright gold */
            } else if (sortKey.startsWith('dl')) {
                (/** @type {HTMLElement} */ (cell)).style.color = '#c084fc';  /* purple-400: vivid violet */
            } else {
                (/** @type {HTMLElement} */ (cell)).style.color = '#60a5fa';  /* blue-400: vivid sky-blue */
            }
        } else {
            // Inactive: restore original color and clean text
            (/** @type {HTMLElement} */ (cell)).style.color = origColor;
            const i18nKey = /** @type {HTMLElement} */ (cell).getAttribute('data-i18n');
            if (i18nKey) {
                const t = /** @type {any} */ (translations)[currentLang] ?? {};
                if (t[i18nKey]) (/** @type {HTMLElement} */ (cell)).textContent = t[i18nKey];
            }
        }
    }
}

/**
 * Bind click handlers to sortable table header cells.
 * Click same column → toggle asc/desc; click different → set new column desc.
 */
/** Guard flag: prevent duplicate header sort event bindings */
let _headerSortBound = false;

function bindHeaderSortEvents() {
    // Prevent duplicate listeners — bindOnce on the entire header
    if (_headerSortBound) return;
    _headerSortBound = true;

    const header = document.getElementById('conn-table-header');
    if (!header) return;

    // Clone the entire header to wipe any stale listeners, then rebind fresh
    const freshHeader = bindOnce(header);
    if (!freshHeader) return;
    for (const cell of freshHeader.querySelectorAll('.sortable')) {
        cell.addEventListener('click', () => {
            const key = /** @type {HTMLElement} */ (cell).dataset.sort;
            if (!connSortState) {
                // No active sort → set this column, default descending
                connSortState = { key: /** @type {string} */ (key), dir: 'desc' };
            } else if (connSortState.key !== key) {
                // Different column → switch to new column, default descending
                connSortState = { key: /** @type {string} */ (key), dir: 'desc' };
            } else if (connSortState.dir === 'desc') {
                // Same column → cycle: desc → asc → null (off)
                connSortState.dir = 'asc';
            } else {
                connSortState = null; // turn off sorting
            }
            updateSortIndicators();
            // Re-render current tab with new sort
            renderConnectionList(
                currentConnTab === 'active' ? cachedConnections : closedConnections,
                currentConnTab
            );
        });
    }
}

// ============================================
// Row Builder
// ============================================

/** Use escapeHtml from ../utils/sanitize.js */
const _esc = /** @param {string} str */ (str) => escapeHtml(str);

/**
 * @param {any} conn
 * @param {string} mode
 */
function buildConnectionRow(conn, mode) {
    const id = _esc(conn.id ?? '');
    const meta = conn.metadata ?? {};
    const host = _esc(meta.host ?? '-');
    const process = _esc(meta.process ?? '');
    const destIP = _esc(meta.destinationIP ?? '-');
    const destPort = _esc(meta.destinationPort ?? '-');
    const rule = _esc(conn.rule || 'Match');
    const chains = (conn.chains ?? []).map(_esc).join(' → ');

    const ruleColorClass = getRuleColorClass(rule);
    const processHtml = process
        ? `<span class="text-xs text-[var(--text-muted)] truncate max-w-[120px] block">${process}</span>`
        : '';

    const { dlSpeed, ulSpeed, dlTotal, ulTotal } = resolveConnStats(conn, mode);

    const dimClass = mode === 'closed' ? 'opacity-60' : '';
    // No inline close button — click row to open detail panel

    // Subtitle: destination + process info under host
    const destHtml = (destIP && destIP !== '-')
        ? `<span class="text-2xs text-[var(--text-muted)] truncate block">→ ${destIP}:${destPort}</span>`
        : '';
    const subtitleHtml = process || destHtml
        ? `<div class="flex items-center gap-2 mt-0.5">
            ${processHtml}
            ${destHtml}
           </div>`
        : '';

    return `
    <div class="conn-row group hover:bg-[var(--zephyr-bg-muted)] transition-[color,border-color] duration-200 items-center cursor-pointer border border-transparent hover:border-[var(--zephyr-border-subtle)] ${dimClass}" style="display:grid; grid-template-columns: 4fr 2fr 2fr 2fr 2fr 2fr 2fr; gap:0.5rem; padding:0.5rem 0.75rem; border-radius:0.75rem; align-items:center;" data-conn-id="${id}" data-mode="${mode}">
        <!-- Host + Destination subtitle -->
        <div style="display:flex; flex-direction:column; justify-content:center; min-width:0; padding-left:0.25rem;">
            <span class="text-xs text-[var(--text-primary)] font-medium truncate" style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${host}</span>
            ${subtitleHtml}
        </div>
        <!-- Rule -->
        <div style="min-width:0; display:flex; justify-content:center;">
            <span class="inline-flex items-center justify-center px-2 py-0.5 rounded-md text-2xs font-semibold ${ruleColorClass} truncate max-w-full">${rule}</span>
        </div>
        <!-- Chains -->
        <div style="text-align:right; min-width:0;">
            <span style="font-size:10px; color:var(--text-muted); display:block; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; margin-left:auto; max-width:100%;">${chains || '-'}</span>
        </div>
        <!-- Download Speed -->
        <div style="text-align:right; min-width:0; padding-right:0.25rem;">
            <span style="font-size:10px; color:#c084fc; font-variant-numeric:tabular-nums; line-height:1;">${dlSpeed}</span>
        </div>
        <!-- Download Total -->
        <div style="text-align:right; min-width:0; padding-right:0.25rem;">
            <span style="font-size:9px; color:rgba(192,132,252,0.5); font-variant-numeric:tabular-nums; line-height:1;">${dlTotal}</span>
        </div>
        <!-- Upload Speed -->
        <div style="text-align:right; min-width:0; padding-right:0.25rem;">
            <span style="font-size:10px; color:#60a5fa; font-variant-numeric:tabular-nums; line-height:1;">${ulSpeed}</span>
        </div>
        <!-- Upload Total -->
        <div style="text-align:right; min-width:0; padding-right:0.5rem;">
            <span style="font-size:9px; color:rgba(96,165,250,0.5); font-variant-numeric:tabular-nums; line-height:1;">${ulTotal}</span>
        </div>
    </div>`;
}

/** @param {string} rule */
function getRuleColorClass(rule) {
    const r = (rule ?? '').toLowerCase();
    if (r.includes('direct') || r === 'direct') return 'bg-success/15 text-success';
    if (r.includes('reject') || r === 'reject') return 'bg-danger/15 text-danger';
    if (r.includes('match')) return 'bg-[var(--zephyr-bg-muted)] text-[var(--text-secondary)]';
    return 'bg-accent/15 text-accent';
}

// ============================================
// Connection Detail Panel
// ============================================

/**
 * Show a detail overlay panel for a single connection.
 * Reuses glass-card styling from the app's design system.
 * For active connections, includes a Close button.
 */
/**
 * @param {any} conn
 * @param {string} mode
 */
function showConnDetail(conn, mode) {
    const t = /** @type {any} */ (translations)[currentLang] ?? {};
    const meta = conn.metadata ?? {};
    const id = _esc(conn.id ?? '');
    const host = _esc(meta.host ?? '-');
    const process = _esc(meta.process ?? '-');
    const destIP = _esc(meta.destinationIP ?? '-');
    const destPort = _esc(meta.destinationPort ?? '-');
    const rule = _esc(conn.rule || 'Match');
    const chains = (conn.chains ?? []).map(_esc).join(' → ') || '-';
    const ruleColorClass = getRuleColorClass(rule);

    // Resolve stats (speed + total) via shared resolver
    const { dlSpeed, ulSpeed, dlTotal, ulTotal } = resolveConnStats(conn, mode);
    let duration = '-';
    if (mode === 'closed' && conn.closedAt && conn.metadata?.start) {
        const ms = conn.closedAt - (typeof conn.metadata.start === 'number' ? conn.metadata.start : Date.now());
        duration = fmtDuration(ms > 0 ? ms : 0);
    } else if (mode === 'closed' && conn.closedAt) {
        duration = fmtDuration(0);
    } else if (mode === 'active') {
        const acc = connAccumulators[conn.id];
        duration = acc ? fmtDuration(Date.now() - acc.seenAt) : '-';
    }

    // Network info
    const networkVal = meta.network || meta.interface || '-';
    const typeVal = meta.type || conn.type || '-';
    const srcIp = meta.sourceIP || '-';
    const srcPort = meta.sourcePort || '-';

    // Build close button HTML (only for active connections)
    const closeBtnHtml = mode === 'active'
        ? `<button id="detail-close-btn" class="mt-6 w-full flex items-center justify-center gap-2 px-4 py-3 rounded-sm bg-danger/10 border border-danger/20 text-2xs font-bold text-danger hover:bg-danger/20 transition-colors uppercase tracking-wider">
             <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
             <span>${t.closeConn || 'Close Connection'}</span>
           </button>`
        : '';

    const panelHtml = `
    <div class="glass-card w-full max-w-lg p-6 relative" id="conn-detail-panel">
        <!-- Header -->
        <div class="flex items-start justify-between mb-5">
            <div class="min-w-0 flex-1 pr-4">
                <h3 class="text-lg font-light text-[var(--text-primary)] truncate">${host}</h3>
                <p class="text-xs text-[var(--text-secondary)] mt-1 font-mono truncate">${id}</p>
            </div>
            <button id="detail-dismiss-btn" class="shrink-0 w-8 h-8 rounded-sm bg-[var(--zephyr-bg-muted)] border border-[var(--zephyr-border-default)] flex items-center justify-center text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--zephyr-bg-input)] transition-colors">
                <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
        </div>

        <!-- Rule & Chains -->
        <div class="flex items-center gap-3 mb-5">
            <span class="inline-flex px-2.5 py-1 rounded-sm text-xs font-semibold ${ruleColorClass}">${rule}</span>
            <span class="text-xs text-[var(--text-secondary)] truncate">${chains}</span>
        </div>

        <!-- Stats Grid -->
        <div class="grid grid-cols-2 gap-3 mb-5">
            <div class="bg-[var(--zephyr-bg-muted)] rounded-lg p-3 border border-[var(--zephyr-border-subtle)]">
                <div class="flex items-center justify-between mb-1.5">
                    <span class="text-2xs text-download/70 font-medium uppercase tracking-wider">${t.dlSpeedLabel || 'Download Speed'}</span>
                    <span class="text-[8px] text-[var(--text-secondary)]">${t.totalLabel || 'Total'}</span>
                </div>
                <span class="text-sm font-semibold text-download tabular-nums block" id="detail-dl-speed">${dlSpeed}</span>
                <div class="flex items-center justify-between mt-1.5 pt-1.5 border-t border-[var(--zephyr-border-subtle)]">
                    <span class="text-[8px] text-[var(--text-secondary)]">${t.totalLabel || 'Total'}</span>
                    <span class="text-2xs text-[var(--text-muted)] tabular-nums" id="detail-dl-total">${dlTotal}</span>
                </div>
            </div>
            <div class="bg-[var(--zephyr-bg-muted)] rounded-lg p-3 border border-[var(--zephyr-border-subtle)]">
                <div class="flex items-center justify-between mb-1.5">
                    <span class="text-2xs text-upload/70 font-medium uppercase tracking-wider">${t.ulSpeedLabel || 'Upload Speed'}</span>
                    <span class="text-[8px] text-[var(--text-secondary)]">${t.totalLabel || 'Total'}</span>
                </div>
                <span class="text-sm font-semibold text-upload tabular-nums block" id="detail-ul-speed">${ulSpeed}</span>
                <div class="flex items-center justify-between mt-1.5 pt-1.5 border-t border-[var(--zephyr-border-subtle)]">
                    <span class="text-[8px] text-[var(--text-secondary)]">${t.totalLabel || 'Total'}</span>
                    <span class="text-2xs text-[var(--text-muted)] tabular-nums" id="detail-ul-total">${ulTotal}</span>
                </div>
            </div>
        </div>

        <!-- Details List -->
        <div class="space-y-2.5 text-xs">
            ${renderDetailRow(t.destCol || 'Destination', `${destIP}:${destPort}`)}
            ${process !== '-' ? renderDetailRow(t.processLabel || 'Process', process) : ''}
            ${renderDetailRow(t.typeLabel || 'Type', typeVal)}
            ${renderDetailRow(t.sourceLabel || 'Source', `${srcIp}:${srcPort}`)}
            ${renderDetailRow(t.networkLabel || 'Network', networkVal)}
            ${renderDetailRow(t.durationLabel || 'Duration', duration, 'detail-duration')}
            ${mode === 'closed' && conn.closedAt ? renderDetailRow(t.closedAtLabel || 'Closed at', new Date(conn.closedAt).toLocaleTimeString()) : ''}
        </div>

        ${closeBtnHtml}
    </div>`;

    // Create backdrop overlay (reuse modal z-index pattern)
    let bg = document.getElementById('conn-detail-bg');
    if (!bg) {
        bg = document.createElement('div');
        bg.id = 'conn-detail-bg';
        bg.className = 'fixed inset-0 z-[105] hidden items-center justify-center bg-[var(--zephyr-bg-overlay)] backdrop-blur-md transition-all duration-200 opacity-0';
        document.body.appendChild(bg);
    }

    // eslint-disable-next-line no-unsanitized/property -- values escaped via _esc() in showConnDetail
    bg.innerHTML = panelHtml;
    bg.classList.remove('hidden');
    bg.classList.add('flex');

    // Register active detail view for live refresh
    activeDetailConnId = conn.id;
    activeDetailMode = mode;

    // Animate in
    requestAnimationFrame(() => {
        bg.classList.remove('opacity-0');
        const panel = document.getElementById('conn-detail-panel');
        if (panel) {
            panel.style.transform = 'scale(0.96)';
            panel.style.opacity = '0';
            requestAnimationFrame(() => {
                panel.style.transition = 'all 0.25s cubic-bezier(0.16, 1, 0.3, 1)';
                panel.style.transform = 'scale(1)';
                panel.style.opacity = '1';
            });
        }
    });

    // Dismiss handler
    const dismiss = () => {
        activeDetailConnId = null;
        activeDetailMode = null;
        bg.classList.add('opacity-0');
        const panel = document.getElementById('conn-detail-panel');
        if (panel) {
            panel.style.transition = 'all 0.15s ease-in';
            panel.style.transform = 'scale(0.96)';
            panel.style.opacity = '0';
        }
        setTimeout(() => { bg.classList.add('hidden'); bg.classList.remove('flex'); }, 150);
    };

    document.getElementById('detail-dismiss-btn')?.addEventListener('click', dismiss);
    bg.addEventListener('click', (e) => { if (e.target === bg) dismiss(); }, { once: true });

    // Close connection button (only active)
    const closeBtn = document.getElementById('detail-close-btn');
    if (closeBtn && mode === 'active') {
        closeBtn.addEventListener('click', async () => {
            setButtonLoading(closeBtn, t, 'closing');

            try {
                await closeConnection(id);
                closedConnections.unshift(archiveConnection(conn, Date.now()));
                delete connAccumulators[conn.id];
                showNotification(t.connClosed || 'Connection closed', 'success');
                dismiss();
                await fetchAndRenderConnections();
            } catch {
                showNotification(t.closeConnFailed || 'Failed to close connection', 'error');
                resetButton(closeBtn, '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>', t.closeConn || 'Close Connection');
            }
        });
    }
}

/**
 * Live-refresh the detail panel's speed & total values on each poll cycle.
 * Only updates the numeric spans — does not re-render the entire panel.
 */
/**
 * @param {string} connId
 * @param {string} mode
 */
function refreshDetailPanel(connId, mode) {
    const dlSpeedEl = document.getElementById('detail-dl-speed');
    const dlTotalEl = document.getElementById('detail-dl-total');
    const ulSpeedEl = document.getElementById('detail-ul-speed');
    const ulTotalEl = document.getElementById('detail-ul-total');

    // Panel was closed or DOM cleaned up
    if (!dlSpeedEl || !dlTotalEl || !ulSpeedEl || !ulTotalEl) {
        activeDetailConnId = null;
        activeDetailMode = null;
        return;
    }

    if (mode === 'active') {
        const acc = connAccumulators[connId];
        if (acc) {
            dlSpeedEl.textContent = formatSpeed(acc.dlSpeed ?? 0);
            dlTotalEl.textContent = formatBytes(acc.dl);
            ulSpeedEl.textContent = formatSpeed(acc.ulSpeed ?? 0);
            ulTotalEl.textContent = formatBytes(acc.ul);
        }
        // Update duration
        const durEl = document.getElementById('detail-duration');
        if (durEl) durEl.textContent = fmtDuration(Date.now() - acc.seenAt);
    }
    // Closed connections: values are static, no update needed
}

/** Helper: render a key-value detail row */
/**
 * @param {string} label
 * @param {string} value
 * @param {string} [rowId]
 */
function renderDetailRow(label, value, rowId) {
    const idAttr = rowId ? ` id="${rowId}"` : '';
    return `
  <div class="flex items-center justify-between py-1.5 border-b border-[var(--zephyr-border-subtle)] last:border-0">
    <span class="text-[var(--text-muted)] shrink-0 mr-4">${_esc(label)}</span>
    <span${idAttr} class="text-[var(--text-secondary)] font-mono text-right truncate min-w-0 tabular-nums">${_esc(value)}</span>
  </div>`;
}

/** Format milliseconds to human-readable duration */
/** @param {number} ms */
function fmtDuration(ms) {
    if (!ms || ms <= 0) return '< 1s';
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${Math.floor(ms / 1000)}s`;
    const m = Math.floor(ms / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

// ============================================
// Bulk Actions
// ============================================

async function handleCloseAllConnections() {
    const btn = document.getElementById('close-all-conns-btn');
    if (!btn) return;

    const t = /** @type {any} */ (translations)[currentLang] ?? {};
    setButtonLoading(btn, t, 'closing');

    try {
        await closeAllConnections();
        const now = Date.now();
        for (const conn of cachedConnections) {
            closedConnections.unshift(archiveConnection(conn, now));
        }
        connAccumulators = {};
        showNotification(t.connsClosed || 'All connections closed', 'success');
        await fetchAndRenderConnections();
    } catch {
        showNotification(t.closeConnsFailed || 'Failed to close connections', 'error');
    } finally {
        switchConnTab(currentConnTab);
    }
}

async function handleClearClosedConnections() {
    const btn = document.getElementById('close-all-conns-btn');
    if (!btn) return;

    const t = /** @type {any} */ (translations)[currentLang] ?? {};
    setButtonLoading(btn, t, 'clearing');

    try {
        closedConnections = [];
        showNotification(t.connsCleared || 'Closed history cleared', 'success');
        renderConnectionList([], 'closed');

        const badge = document.getElementById('closed-count-badge');
        if (badge) badge.classList.add('hidden');
    } catch {
        showNotification(t.clearConnsFailed || 'Failed to clear history', 'error');
    } finally {
        switchConnTab(currentConnTab);
    }
}

// ============================================
// UI Helpers
// ============================================

function updateClosedBadge() {
    const badge = document.getElementById('closed-count-badge');
    if (!badge) return;
    const t = /** @type {any} */ (translations)[currentLang] ?? {};
    if (closedConnections.length > 0) {
        badge.textContent = `${closedConnections.length} ${t.closedItems ?? ''}`;
        badge.classList.remove('hidden');
    } else {
        badge.classList.add('hidden');
    }
}

// Removed: updateMetaLine — connections-meta line deleted from UI

// ============================================
// Shared Utilities
// ============================================

/**
 * Clone a DOM node and replace the original — prevents duplicate event listeners.
 * Returns the new clone for binding.
 */
/**
 * @param {Element|null} el
 * @returns {Element|null}
 */
function bindOnce(el) {
    if (!el) return null;
    const clone = /** @type {Element} */ (el.cloneNode(true));
    el.parentNode?.replaceChild(clone, el);
    return clone;
}

/**
 * Set a button into loading state with spinner.
 * @param {HTMLElement} btn
 * @param {object} t - i18n translations
 * @param {string} loadingText - translation key or fallback text
 */
/**
 * @param {HTMLElement} btn
 * @param {any} t
 * @param {string} loadingText
 */
function setButtonLoading(btn, t, loadingText) {
    if (!btn) return;
    /** @type {HTMLButtonElement} */ (btn).disabled = true;
    const icon = btn.querySelector('#action-btn-icon');
    const text = btn.querySelector('#action-btn-text');
    if (icon) {
        icon.classList.add('animate-spin');
        icon.innerHTML = '<path d="M21 12a9 9 0 1 1-6.219-8.56"/>';
    }
    if (text) text.textContent = t[loadingText] || loadingText;
}

/**
 * Reset a disabled button back to enabled state with original icon/text.
 * @param {HTMLElement} btn
 * @param {string} iconSvg - innerHTML for the <svg> element
 * @param {string} text - button label text
 */
/**
 * @param {HTMLElement} btn
 * @param {string} iconSvg
 * @param {string} text
 */
function resetButton(btn, iconSvg, text) {
    if (!btn) return;
    /** @type {HTMLButtonElement} */ (btn).disabled = false;
    // eslint-disable-next-line no-unsanitized/property -- caller-validated: iconSvg/text are hardcoded SVG + i18n
    btn.innerHTML = `<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">${iconSvg}</svg><span>${text}</span>`;
}

/**
 * Create an archived (closed) snapshot of a connection for history.
 * Centralizes the shape so all callers produce identical objects.
 * @param {object} conn - raw connection object
 * @param {number} closedAt - timestamp
 * @returns {object} archived connection with dlTotal/ulTotal/dlSpeed/ulSpeed/isClosed
 */
/**
 * @param {any} conn
 * @param {number} closedAt
 */
function archiveConnection(conn, closedAt) {
    const acc = connAccumulators[conn.id] ?? { dl: 0, ul: 0, dlSpeed: 0, ulSpeed: 0 };
    return {
        ...conn,
        closedAt,
        dlTotal: acc.dl,
        ulTotal: acc.ul,
        dlSpeed: acc.dlSpeed ?? 0,
        ulSpeed: acc.ulSpeed ?? 0,
        download: conn.download ?? 0,
        upload: conn.upload ?? 0,
        isClosed: true,
    };
}

/**
 * Resolve speed + total display values for a connection.
 * Used by buildConnectionRow, showConnDetail, and refreshDetailPanel.
 * @param {object} conn - connection object
 * @param {string} mode - 'active' | 'closed'
 * @returns {{ dlSpeed: string, ulSpeed: string, dlTotal: string, ulTotal: string }}
 */
/**
 * @param {any} conn
 * @param {string} mode
 */
function resolveConnStats(conn, mode) {
    if (mode === 'closed') {
        return {
            dlSpeed: formatSpeed(conn.dlSpeed ?? 0),
            ulSpeed: formatSpeed(conn.ulSpeed ?? 0),
            dlTotal: formatBytes(conn.dlTotal ?? 0),
            ulTotal: formatBytes(conn.ulTotal ?? 0),
        };
    }
    const acc = connAccumulators[conn.id] ?? { dl: 0, ul: 0, dlSpeed: 0, ulSpeed: 0 };
    return {
        dlSpeed: formatSpeed(acc.dlSpeed ?? 0),
        ulSpeed: formatSpeed(acc.ulSpeed ?? 0),
        dlTotal: formatBytes(acc.dl),
        ulTotal: formatBytes(acc.ul),
    };
}


