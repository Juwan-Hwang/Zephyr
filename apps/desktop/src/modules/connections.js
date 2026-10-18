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
import { translations, currentLang, applyTranslations, t as tFmt } from '../i18n.js';
import { escapeHtml } from '../utils/sanitize.js';
import { formatBytes, formatSpeed } from '../utils/format.js';
import { connectionsLogger } from '../utils/logger.js';
import { Bus, Events } from '../ui/events.js';
import { reconcileKeyedList, resetKeyedList } from '../utils/keyed-list.js';

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

/**
 * Connections closed (and archived) by the user. A poll that was already in
 * flight still lists them; drop them from it so they are not shown as active
 * again and archived twice. An id leaves the set once the core stops listing it.
 * @type {Set<string>}
 */
const userClosedIds = new Set();

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

/** Refresh paused by the user (Pause button). */
let _connPaused = false;

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
            <div class="absolute inset-y-0 start-0 ps-4 flex items-center pointer-events-none">
                <svg class="h-4 w-4 text-[var(--text-secondary)] group-focus-within:text-[var(--text-primary)] transition-colors duration-[var(--zephyr-time-standard)]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
            </div>
            <input type="text" id="connections-search-input" placeholder="Search connections..." data-i18n-placeholder="searchConnections" class="bg-[var(--zephyr-bg-muted)] border border-[var(--zephyr-border-default)] rounded-full h-8 py-0 px-5 ps-11 text-[var(--text-primary)] text-xs w-52 transition-all duration-[var(--zephyr-time-standard)] focus:outline-none focus:border-[var(--zephyr-border-strong)] focus:bg-[var(--zephyr-bg-input)] focus:w-72 placeholder:text-[var(--text-secondary)] shadow-inner pe-9">
            <button id="connections-search-clear" type="button" class="conn-search-clear hidden" data-i18n-title="clearSearch" data-i18n-aria-label="clearSearch" title="Clear search" aria-label="Clear search">
                <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
        </div>
        <!-- Close All / Clear All Button -->
        <button id="close-all-conns-btn" class="btn-danger">
            <svg id="action-btn-icon" class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            <span id="action-btn-text" data-i18n="closeAll">Close All</span>
        </button>
        <!-- Pause / resume the 2 s refresh (rows stop moving so one can be clicked) -->
        <button id="pause-conns-btn" type="button" class="btn-ghost" aria-pressed="false">
            <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>
            <span id="pause-conns-text" data-i18n="pause">Pause</span>
        </button>
    </div>
</header>

<!-- Connection List Container with Tabs -->
<div id="connections-list-container" data-conn-page="1" class="glass-card flex-1 overflow-hidden relative z-10 flex flex-col min-h-0">
    <!-- Tab Bar + Table Header -->
    <div class="shrink-0">
        <!-- Tabs -->
        <div class="flex items-center px-4 pt-4 pb-1 gap-2">
            <div class="seg-tabs" role="tablist">
                <button type="button" id="conn-tab-active" role="tab" aria-selected="true" class="conn-tab seg-tab active" data-i18n="activeTab">Active</button>
                <button type="button" id="conn-tab-closed" role="tab" aria-selected="false" class="conn-tab seg-tab" data-i18n="closedTab">Closed</button>
            </div>
            <div class="flex-1"></div>
            <!-- One quiet line instead of the old 4-card stats bar: count · ↓ total · ↑ total -->
            <span id="conn-summary" class="conn-summary tabular-nums">
                <span id="stat-total">0</span>
                <span class="conn-summary-num text-download">↓ <span id="stat-dl-total">0 B</span></span>
                <span class="conn-summary-num text-upload">↑ <span id="stat-ul-total">0 B</span></span>
            </span>
        </div>
        <!-- Table Header (clickable for sort). Two lines per column mirror the two-line rows. -->
        <div class="conn-grid conn-head" id="conn-table-header">
            <div class="conn-head-cell">
                <span class="sortable" role="button" tabindex="0" aria-pressed="false" data-sort="host" data-i18n="hostCol">Host</span>
            </div>
            <div class="conn-head-cell">
                <span class="sortable" role="button" tabindex="0" aria-pressed="false" data-sort="rule" data-i18n="ruleCol">Rule</span>
                <span class="sortable conn-head-sub" role="button" tabindex="0" aria-pressed="false" data-sort="chains" data-i18n="chainsCol">Chains</span>
            </div>
            <div class="conn-head-cell conn-num">
                <span class="sortable" id="conn-head-dl" role="button" tabindex="0" aria-pressed="false" data-sort="dlSpeed" data-i18n="dlSpeedCol">↓ Speed</span>
                <span class="sortable conn-head-sub" role="button" tabindex="0" aria-pressed="false" data-sort="dlTotal" data-i18n="dlTotalCol">↓ Total</span>
            </div>
            <div class="conn-head-cell conn-num">
                <span class="sortable" id="conn-head-ul" role="button" tabindex="0" aria-pressed="false" data-sort="ulSpeed" data-i18n="ulSpeedCol">↑ Speed</span>
                <span class="sortable conn-head-sub" role="button" tabindex="0" aria-pressed="false" data-sort="ulTotal" data-i18n="ulTotalCol">↑ Total</span>
            </div>
        </div>
    </div>
    <!-- List Body -->
    <div id="connections-list" class="flex-1 overflow-y-auto custom-scrollbar py-1 pb-1 space-y-0.5 px-2">
        <!-- Empty State (Active) -->
        <div id="connections-empty" class="empty-state">
            <svg class="w-12 h-12 text-[var(--text-tertiary)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="17" r="4"/><path d="M4 17l6-6-6-6"/><path d="M13 11h8"/></svg>
            <p class="text-sm font-medium text-[var(--text-secondary)]" data-i18n="noConnections">No active connections</p>
            <p class="text-xs text-[var(--text-muted)] max-w-xs" data-i18n="noConnectionsHint">Connections will appear here as traffic flows through the proxy</p>
        </div>
        <!-- Empty State (Closed) -->
        <div id="connections-closed-empty" class="empty-state hidden">
            <svg class="w-12 h-12 text-[var(--text-tertiary)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
            <p class="text-sm font-medium text-[var(--text-secondary)]" data-i18n="noClosedConns">No closed connections yet</p>
            <p class="text-xs text-[var(--text-muted)] max-w-xs" data-i18n="noClosedConnsHint">Closed connections will appear here after you close them</p>
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
    if (!document.querySelector('[data-conn-page]')) {
        // eslint-disable-next-line no-unsanitized/property -- static HTML template (PAGE_HTML is a hardcoded string)
        container.innerHTML = PAGE_HTML; // nosemgrep: js-innerhtml-assignment — verified safe, see eslint-disable above
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
    void fetchAndRenderConnections();

    // Re-apply sort arrows when i18n/theme changes wipe header text.
    // initConnectionsPage() runs on every visit, so drop the previous
    // subscriptions first instead of stacking a new pair each time.
    if (_unsubI18n) { _unsubI18n(); _unsubI18n = null; }
    if (_unsubTheme) { _unsubTheme(); _unsubTheme = null; }
    _unsubI18n = Bus.on(Events.I18N_APPLIED, () => updateSortIndicators());
    _unsubTheme = Bus.on(Events.THEME_MODE_CHANGED, () => updateSortIndicators());

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
                if (!_connPaused) await fetchAndRenderConnections();
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
            if (!_connPaused) void fetchAndRenderConnections();
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
    updateConnStats(cachedConnections);
    // Closed tab: the speed columns become "Duration" / "Closed at".
    const tt = /** @type {any} */ (translations)[currentLang] ?? {};
    const headDl = document.getElementById('conn-head-dl');
    const headUl = document.getElementById('conn-head-ul');
    if (headDl) { headDl.dataset.i18n = tab === 'closed' ? 'connDurationCol' : 'dlSpeedCol'; headDl.textContent = tab === 'closed' ? (tt.connDurationCol || 'Duration') : (tt.dlSpeedCol || '↓ Speed'); }
    if (headUl) { headUl.dataset.i18n = tab === 'closed' ? 'connClosedAtCol' : 'ulSpeedCol'; headUl.textContent = tab === 'closed' ? (tt.connClosedAtCol || 'Closed at') : (tt.ulSpeedCol || '↑ Speed'); }
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
        activeTab?.classList.add('active');
        closedTab?.classList.remove('active');
        activeTab?.setAttribute('aria-selected', 'true');
        closedTab?.setAttribute('aria-selected', 'false');

        if (actionBtn instanceof HTMLButtonElement) {
            actionBtn.className = 'btn-danger';
            actionBtn.disabled = false;
            if (actionIcon) { actionIcon.classList.remove('animate-spin'); actionIcon.innerHTML = '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>'; }
            if (actionText) { actionText.textContent = t.closeAll || 'Close All'; actionText.setAttribute('data-i18n', 'closeAll'); }
        }
    } else {
        closedTab?.classList.add('active');
        activeTab?.classList.remove('active');
        closedTab?.setAttribute('aria-selected', 'true');
        activeTab?.setAttribute('aria-selected', 'false');

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
            document.getElementById('connections-search-clear')?.classList.toggle('hidden', target.value === '');
            renderConnectionList(
                currentConnTab === 'active' ? cachedConnections : closedConnections,
                currentConnTab
            );
        });
    }

    const searchClearClone = bindOnce(document.getElementById('connections-search-clear'));
    if (searchClearClone) searchClearClone.addEventListener('click', clearConnectionsSearch);

    if (closeAllClone) {
        closeAllClone.addEventListener('click', () => {
            if (currentConnTab === 'closed') void handleClearClosedConnections();
            else void handleCloseAllConnections();
        });
    }

    if (refreshClone) {
        refreshClone.addEventListener('click', () => { void fetchAndRenderConnections(); });
    }

    const pauseBtn = bindOnce(document.getElementById('pause-conns-btn'));
    if (pauseBtn) {
        const syncPauseButton = () => {
            const t = /** @type {any} */ (translations)[currentLang] ?? {};
            pauseBtn.setAttribute('aria-pressed', String(_connPaused));
            const label = document.getElementById('pause-conns-text');
            if (label) {
                label.dataset.i18n = _connPaused ? 'resume' : 'pause';
                label.textContent = _connPaused ? (t.resume || 'Resume') : (t.pause || 'Pause');
            }
        };
        // Re-entering the page starts live again; the kept button must say so too.
        _connPaused = false;
        syncPauseButton();
        pauseBtn.addEventListener('click', () => {
            _connPaused = !_connPaused;
            syncPauseButton();
            if (!_connPaused) void fetchAndRenderConnections();
        });
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
        const rawConns = (/** @type {any} */ (data)).connections || [];
        if (userClosedIds.size > 0) {
            const listed = new Set(rawConns.map(/** @param {any} c */ (c) => c.id));
            for (const id of userClosedIds) if (!listed.has(id)) userClosedIds.delete(id);
        }
        const incomingConns = userClosedIds.size > 0
            ? rawConns.filter(/** @param {any} c */ (c) => !userClosedIds.has(c.id))
            : rawConns;

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
                // Totals start from the core's own cumulative counters (they used to start at 0
                // when the page opened); speed still comes from the delta between polls.
                connAccumulators[id] = { dl: curDl, ul: curUl, prevDl: curDl, prevUl: curUl, seenAt: now, prevTs: now, dlSpeed: 0, ulSpeed: 0 };
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
        const d = /** @type {any} */ (data);
        _coreTotals = Number.isFinite(Number(d?.downloadTotal)) && Number.isFinite(Number(d?.uploadTotal))
            ? { dl: Number(d.downloadTotal), ul: Number(d.uploadTotal) }
            : null;
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

/** Core-wide totals from /connections (downloadTotal/uploadTotal), when the core reports them. */
/** @type {{ dl: number, ul: number } | null} */
let _coreTotals = null;

/** @param {any[]} conns */
function updateConnStats(conns) {
    const totalEl = document.getElementById('stat-total');
    const dlTotalEl = document.getElementById('stat-dl-total');
    const ulTotalEl = document.getElementById('stat-ul-total');

    const t = /** @type {any} */ (translations)[currentLang] ?? {};
    // The Closed tab counts its history, not the live connections.
    const total = currentConnTab === 'closed' ? closedConnections.length : conns.length;

    let grandDl = 0, grandUl = 0;
    for (const acc of Object.values(connAccumulators)) {
        grandDl += acc.dl;
        grandUl += acc.ul;
    }
    for (const c of closedConnections) {
        grandDl += c.dlTotal ?? 0;
        grandUl += c.ulTotal ?? 0;
    }

    // Same totals as the home page: the core's counters since it started.
    if (_coreTotals) {
        grandDl = _coreTotals.dl;
        grandUl = _coreTotals.ul;
    }

    _totalDownloaded = grandDl;
    _totalUploaded = grandUl;

    if (totalEl) {
        // The count is bold, the unit words are not: "**12** connections".
        const [pre = '', post = ''] = (t.connCountLabel || '@@count@@ connections').split('@@count@@');
        const num = document.createElement('strong');
        num.className = 'conn-summary-count';
        num.textContent = String(total);
        totalEl.replaceChildren(pre, num, post);
    }
    if (dlTotalEl) dlTotalEl.textContent = formatBytes(grandDl);
    if (ulTotalEl) ulTotalEl.textContent = formatBytes(grandUl);
}

// ============================================
// Sorting
// ============================================

/** Keys that sort as strings (lexicographic) rather than numerically */
const SORT_TEXT_KEYS = new Set(['host', 'rule', 'chains']);

// ============================================
// Rendering
// ============================================

/** @type {{ active: HTMLElement | null, closed: HTMLElement | null }} */
const emptyTemplates = { active: null, closed: null };

/**
 * Connections matching the search box (host, IP, port, rule, chain, process).
 * @param {any[]} connections
 * @returns {any[]}
 */
function filterConnsBySearch(connections) {
    if (!connectionsSearchQuery) return connections;
    const q = connectionsSearchQuery;
    return connections.filter(/** @param {any} c */ (c) => {
        const m = c.metadata ?? {};
        return (m.host ?? '').toLowerCase().includes(q)
            || (m.destinationIP ?? '').toLowerCase().includes(q)
            || String(m.destinationPort ?? '').toLowerCase().includes(q)
            || (c.rule ?? '').toLowerCase().includes(q)
            || (c.chains ?? []).join(' ').toLowerCase().includes(q)
            || (m.process ?? '').toLowerCase().includes(q);
    });
}

/** While searching, "Close all" only closes what the search shows — and says so. */
/** A bulk close is running: polls must not re-enable or relabel its button. */
let _bulkCloseInFlight = false;

function syncCloseMatchingButton(/** @type {number} */ count) {
    const btn = /** @type {HTMLButtonElement|null} */ (document.getElementById('close-all-conns-btn'));
    const text = document.getElementById('action-btn-text');
    if (!btn || !text || currentConnTab !== 'active' || _bulkCloseInFlight) return;
    const t = /** @type {any} */ (translations)[currentLang] ?? {};
    if (connectionsSearchQuery) {
        text.textContent = (t.closeMatchingConns || 'Close @@count@@ matching').replace('@@count@@', String(count));
        btn.disabled = count === 0;
    } else {
        text.textContent = t.closeAll || 'Close All';
        btn.disabled = false;
    }
}

/** Empty the search box and show every connection again. */
function clearConnectionsSearch() {
    const input = /** @type {HTMLInputElement|null} */ (document.getElementById('connections-search-input'));
    if (input) { input.value = ''; input.dispatchEvent(new Event('input')); input.focus(); }
}

/** Empty state for a search with no matches, with a "clear search" action. */
function buildSearchEmptyState() {
    const t = /** @type {any} */ (translations)[currentLang] ?? {};
    const wrap = document.createElement('div');
    wrap.className = 'empty-state conn-search-empty';
    wrap.insertAdjacentHTML('beforeend', '<svg class="w-12 h-12 text-[var(--text-tertiary)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>');
    const title = document.createElement('p');
    title.className = 'conn-search-empty-title';
    title.textContent = (t.connSearchNoMatch || 'No connections match “@@query@@”').replace('@@query@@', connectionsSearchQuery);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn-ghost';
    btn.textContent = t.clearSearch || 'Clear search';
    btn.addEventListener('click', clearConnectionsSearch);
    wrap.append(title, btn);
    return wrap;
}

/**
 * @param {any[]} connections
 * @param {string} mode
 */
function renderConnectionList(connections, mode) {
    const container = document.getElementById('connections-list');
    // The empty-state templates live inside the list and are wiped by the first
    // render that has rows; keep detached copies so either tab can show its
    // empty state later (the closed tab used to stay blank).
    const liveActive = document.getElementById('connections-empty');
    const liveClosed = document.getElementById('connections-closed-empty');
    if (liveActive) emptyTemplates.active = /** @type {HTMLElement} */ (liveActive.cloneNode(true));
    if (liveClosed) emptyTemplates.closed = /** @type {HTMLElement} */ (liveClosed.cloneNode(true));
    const emptyState = emptyTemplates.active;
    const closedEmptyState = emptyTemplates.closed;
    if (!container) return;

    const filtered = filterConnsBySearch(connections);
    if (mode === 'active') syncCloseMatchingButton(filtered.length);

    if (filtered.length === 0 && connectionsSearchQuery && connections.length > 0) {
        // Nothing matches the search — say that, not "no active connections".
        container.replaceChildren();
        resetKeyedList(container);
        container.appendChild(buildSearchEmptyState());
        return;
    }

    if (filtered.length === 0) {
        container.replaceChildren();
        resetKeyedList(container);
        const tpl = mode === 'active' ? emptyState : closedEmptyState;
        if (tpl) {
            const clone = /** @type {HTMLElement} */ (tpl.cloneNode(true));
            clone.classList.remove('hidden');
            // The template was copied before any later language switch: translate it now.
            const t = /** @type {any} */ (translations)[currentLang] ?? {};
            clone.querySelectorAll('[data-i18n]').forEach(el => {
                const key = /** @type {HTMLElement} */ (el).dataset.i18n;
                if (key && typeof t[key] === 'string') el.textContent = t[key];
            });
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

    // Keyed by connection id: rows that are still present keep their DOM
    // node and only get their speed/total text patched; rows are inserted,
    // removed or moved only when the visible list itself changed. The
    // resulting markup is identical to a full innerHTML rebuild.
    // Moving or re-creating the focused row drops keyboard focus to <body>;
    // put it back on the same connection's row.
    const focusedRow = /** @type {HTMLElement | null} */ (document.activeElement?.closest?.('.conn-row') ?? null);
    const focusedId = focusedRow && container.contains(focusedRow) ? focusedRow.dataset.connId : undefined;

    reconcileKeyedList(container, filtered, {
        getKey: (/** @type {any} */ conn) => String(conn.id ?? ''),
        getSignature: (/** @type {any} */ conn) => buildConnectionRow(conn, mode, EMPTY_ROW_STATS, false),
        create: (/** @type {any} */ conn) => createConnectionRowElement(conn, mode),
        update: (el, /** @type {any} */ conn) => patchConnectionRowStats(el, resolveConnStats(conn, mode), isConnIdle(conn, mode)),
    });

    // One delegated listener per list element instead of one per row per render
    // (click and keyboard activation of the role=button rows).
    bindRowClickDelegate(container);

    if (focusedId !== undefined && !document.activeElement?.closest?.('.conn-row')) {
        const row = Array.from(container.querySelectorAll('.conn-row'))
            .find(el => /** @type {HTMLElement} */ (el).dataset.connId === focusedId);
        /** @type {HTMLElement | undefined} */ (row)?.focus({ preventScroll: true });
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
        case 'dlSpeed': return mode === 'closed' ? Math.max(0, (conn.closedAt ?? 0) - connStartMs(conn)) : (connAccumulators[conn.id]?.dlSpeed ?? 0);
        case 'dlTotal': return mode === 'closed' ? (conn.dlTotal ?? 0) : (connAccumulators[conn.id]?.dl ?? 0);
        case 'ulSpeed': return mode === 'closed' ? (conn.closedAt ?? 0) : (connAccumulators[conn.id]?.ulSpeed ?? 0);
        case 'ulTotal': return mode === 'closed' ? (conn.ulTotal ?? 0) : (connAccumulators[conn.id]?.ul ?? 0);
        default: return 0;
    }
}

/**
 * Assign textContent only when it differs, so the per-poll header refresh
 * does not replace identical text nodes.
 * @param {Element} el
 * @param {string} text
 */
function setTextIfChanged(el, text) {
    if (el.textContent !== text) el.textContent = text;
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
            setTextIfChanged(cell, `${base} ${isAsc ? '\u25B2' : '\u25BC'}`);
            // aria-sort only applies to column headers; these are buttons, so expose
            // the active sort as pressed (the ▲/▼ in the label gives the direction).
            if (cell.getAttribute('aria-pressed') !== 'true') cell.setAttribute('aria-pressed', 'true');
            // Active color: BRIGHT highlight, unmistakable in both modes
            if (SORT_TEXT_KEYS.has(sortKey)) {
                (/** @type {HTMLElement} */ (cell)).style.color = 'var(--text-primary)';
            } else if (sortKey.startsWith('dl')) {
                (/** @type {HTMLElement} */ (cell)).style.color = 'var(--zephyr-color-download)';  /* fixed blue download colour */
            } else {
                (/** @type {HTMLElement} */ (cell)).style.color = 'var(--zephyr-color-upload)';  /* fixed coral upload colour */
            }
        } else {
            // Inactive: colour comes from CSS (.conn-head); drop the inline active colour and clean text
            (/** @type {HTMLElement} */ (cell)).style.color = '';
            if (cell.getAttribute('aria-pressed') !== 'false') cell.setAttribute('aria-pressed', 'false');
            const i18nKey = /** @type {HTMLElement} */ (cell).getAttribute('data-i18n');
            if (i18nKey) {
                const t = /** @type {any} */ (translations)[currentLang] ?? {};
                if (t[i18nKey]) setTextIfChanged(cell, t[i18nKey]);
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
        cell.addEventListener('keydown', (/** @type {Event} */ e) => {
            const key = /** @type {KeyboardEvent} */ (e).key;
            if (key === 'Enter' || key === ' ') {
                e.preventDefault();
                /** @type {HTMLElement} */ (cell).click();
            }
        });
        cell.addEventListener('click', () => {
            const key = /** @type {HTMLElement} */ (cell).dataset.sort;
            // Text columns start A→Z, number columns start largest first; a second click flips,
            // a third turns sorting off.
            const first = SORT_TEXT_KEYS.has(/** @type {string} */ (key)) ? 'asc' : 'desc';
            const second = first === 'asc' ? 'desc' : 'asc';
            if (!connSortState || connSortState.key !== key) {
                connSortState = { key: /** @type {string} */ (key), dir: first };
            } else if (connSortState.dir === first) {
                connSortState.dir = second;
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

/** Class that dims an active row with no traffic right now. */
const IDLE_ROW_CLASS = 'conn-row--idle';

/**
 * An active connection is idle when it moved no bytes since the last poll.
 * @param {any} conn
 * @param {string} mode
 */
function isConnIdle(conn, mode) {
    if (mode === 'closed') return false;
    const acc = connAccumulators[conn.id];
    return !acc || (!(acc.dlSpeed > 0) && !(acc.ulSpeed > 0));
}

/** Stats placeholder used to compute a row's structural signature. */
const EMPTY_ROW_STATS = Object.freeze({ dlSpeed: '', ulSpeed: '', dlTotal: '', ulTotal: '' });

/**
 * @param {any} conn
 * @param {string} mode
 * @param {{ dlSpeed: string, ulSpeed: string, dlTotal: string, ulTotal: string }} [stats]
 *   Display values for the four traffic cells; resolved from the connection when omitted.
 * @param {boolean} [idle] Dim an active row with no traffic right now; resolved when omitted.
 */
function buildConnectionRow(conn, mode, stats = resolveConnStats(conn, mode), idle = isConnIdle(conn, mode)) {
    const id = _esc(conn.id ?? '');
    const meta = conn.metadata ?? {};
    const host = _esc(meta.host ?? '-');
    const process = _esc(meta.process ?? '');
    const destIP = _esc(meta.destinationIP ?? '-');
    const destPort = _esc(String(meta.destinationPort ?? '-'));
    const rule = _esc(conn.rule || 'Match');
    const chains = (conn.chains ?? []).map(_esc).join(' → ');

    const ruleColorClass = getRuleColorClass(rule);
    const ruleShort = _esc(shortRuleName(conn.rule || 'Match'));
    const rulePayload = _esc(conn.rulePayload || '');
    const ruleTitle = rulePayload ? `${rule}: ${rulePayload}` : rule;

    const { dlSpeed, ulSpeed, dlTotal, ulTotal } = stats;

    // Closed rows and active rows with no traffic right now are dimmed so busy rows stand out.
    // The idle class is patched in place on existing rows (see patchConnectionRowStats).
    const rowClass = ['conn-row', 'conn-grid', 'group'];
    if (mode === 'closed') rowClass.push('conn-row--closed');
    else if (idle) rowClass.push(IDLE_ROW_CLASS);

    const subParts = [];
    if (process) subParts.push(`<span class="conn-proc">${process}</span>`);
    if (destIP && destIP !== '-') subParts.push(`<span class="conn-dest">${destIP}:${destPort}</span>`);
    const subtitleHtml = subParts.length ? `<span class="conn-sub">${subParts.join('<span class="conn-sep" aria-hidden="true"> · </span>')}</span>` : '';

    return `
    <div class="${rowClass.join(' ')}" role="button" tabindex="0" data-conn-id="${id}" data-mode="${mode}">
        <div class="conn-cell">
            <span class="conn-main conn-host">${host}</span>
            ${subtitleHtml}
        </div>
        <div class="conn-cell">
            <span class="conn-rule ${ruleColorClass}" title="${ruleTitle}">${ruleShort}</span>
            <span class="conn-sub" title="${chains || '-'}">→ ${chains || '-'}</span>
        </div>
        <div class="conn-cell conn-num">
            <span class="conn-main conn-rate conn-rate--down">${dlSpeed}</span>
            <span class="conn-sub">${dlTotal}</span>
        </div>
        <div class="conn-cell conn-num">
            <span class="conn-main conn-rate conn-rate--up">${ulSpeed}</span>
            <span class="conn-sub">${ulTotal}</span>
        </div>
        ${mode === 'active' ? `<button type="button" class="conn-row-close" data-close-conn="${id}" title="${_esc(closeOneLabel())}" aria-label="${_esc(closeOneLabel())}: ${host}"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>` : ''}
    </div>`;
}

/** Short display names for long mihomo rule types; the full name stays in the badge title. */
const RULE_SHORT_NAMES = Object.freeze(/** @type {Record<string, string>} */ ({
    domainsuffix: 'Suffix',
    domainkeyword: 'Keyword',
    domainregex: 'Regex',
    domainwildcard: 'Wildcard',
    ipcidr: 'CIDR',
    ipcidr6: 'CIDR6',
    'ip-cidr': 'CIDR',
    'ip-cidr6': 'CIDR6',
    ipsuffix: 'IP Suffix',
    srcipcidr: 'Src CIDR',
    processname: 'Process',
    processpath: 'Path',
    processnameregex: 'Process',
    processpathregex: 'Path',
    dstport: 'Port',
    srcport: 'Src Port',
    ruleset: 'RuleSet',
}));

/** @param {string} rule */
export function shortRuleName(rule) {
    const key = String(rule ?? '').toLowerCase().replace(/[-_]/g, '');
    return RULE_SHORT_NAMES[key] || String(rule ?? '');
}

/** Selectors for the ↓speed, ↓total, ↑speed, ↑total cells of a row. */
const STAT_SELECTORS = Object.freeze([
    '.conn-rate--down',
    '.conn-rate--down + .conn-sub',
    '.conn-rate--up',
    '.conn-rate--up + .conn-sub',
]);

/** @type {WeakMap<Element, Element[]>} Cached stat <span>s per row element. */
const _rowStatCells = new WeakMap();

/**
 * Parse one row's markup into an element (same markup as the former
 * innerHTML rebuild, so the DOM is identical).
 * @param {any} conn
 * @param {string} mode
 * @returns {Element}
 */
function createConnectionRowElement(conn, mode) {
    const tpl = document.createElement('template');
    // eslint-disable-next-line no-unsanitized/property -- values escaped via _esc() in buildConnectionRow
    tpl.innerHTML = buildConnectionRow(conn, mode).trim(); // nosemgrep: js-innerhtml-assignment — verified safe, see eslint-disable above
    return /** @type {Element} */ (tpl.content.firstElementChild);
}

/**
 * @param {Element} row
 * @returns {Element[]}
 */
function getRowStatCells(row) {
    let cells = _rowStatCells.get(row);
    if (!cells) {
        cells = [];
        for (const sel of STAT_SELECTORS) {
            const span = row.querySelector(sel);
            if (span) cells.push(span);
        }
        _rowStatCells.set(row, cells);
    }
    return cells;
}

/**
 * Patch the four traffic cells and the idle dimming of an existing row in place.
 * @param {Element} row
 * @param {{ dlSpeed: string, ulSpeed: string, dlTotal: string, ulTotal: string }} stats
 * @param {boolean} [idle]
 */
function patchConnectionRowStats(row, stats, idle) {
    const cells = getRowStatCells(row);
    const values = [stats.dlSpeed, stats.dlTotal, stats.ulSpeed, stats.ulTotal];
    for (let i = 0; i < cells.length; i++) setTextIfChanged(cells[i], values[i]);
    if (idle !== undefined && row.classList.contains(IDLE_ROW_CLASS) !== idle) {
        row.classList.toggle(IDLE_ROW_CLASS, idle);
    }
}

/** @type {WeakSet<Element>} List elements that already carry the delegated row click listener. */
const _rowClickBound = new WeakSet();

/**
 * @param {Element} container
 * @param {EventTarget|null} target
 * @returns {HTMLElement|null}
 */
function rowFromEvent(container, target) {
    const el = target instanceof Element ? target : null;
    const row = /** @type {HTMLElement|null} */ (el?.closest('.conn-row') ?? null);
    return row && container.contains(row) ? row : null;
}

/** Label for the per-row close button. */
function closeOneLabel() {
    const t = /** @type {any} */ (translations)[currentLang] ?? {};
    return t.closeThisConn || 'Close this connection';
}

/**
 * Close one connection from its row.
 * @param {string} id
 * @param {HTMLElement} btn
 */
async function closeSingleConnection(id, btn) {
    if (!id) return;
    const t = /** @type {any} */ (translations)[currentLang] ?? {};
    btn.setAttribute('disabled', '');
    try {
        await closeConnection(id);
        // A poll already in flight may still list it: keep it out of the active list.
        userClosedIds.add(id);
        showNotification(t.connClosedOne || 'Connection closed', 'success');
        await fetchAndRenderConnections();
    } catch {
        btn.removeAttribute('disabled');
        showNotification(t.closeConnsFailed || 'Failed to close connections', 'error');
    }
}

/** @param {HTMLElement} row */
function openRowDetail(row) {
    const connId = row.dataset.connId;
    const connMode = row.dataset.mode;
    const sourceList = connMode === 'closed' ? closedConnections : cachedConnections;
    const conn = sourceList.find(c => c.id === connId);
    if (conn) showConnDetail(conn, /** @type {string} */ (connMode), row);
}

/**
 * Open the detail panel for a clicked row (or a focused row on Enter/Space)
 * via single listeners on the list.
 * @param {Element} container
 */
function bindRowClickDelegate(container) {
    if (_rowClickBound.has(container)) return;
    _rowClickBound.add(container);
    container.addEventListener('click', (e) => {
        // Hover ✕ on a row closes that one connection directly (no detour through the details).
        const closeBtn = e.target instanceof Element ? e.target.closest('[data-close-conn]') : null;
        if (closeBtn instanceof HTMLElement) {
            e.stopPropagation();
            void closeSingleConnection(closeBtn.dataset.closeConn || '', closeBtn);
            return;
        }
        const row = rowFromEvent(container, e.target);
        if (row) openRowDetail(row);
    });
    container.addEventListener('keydown', (e) => {
        const key = /** @type {KeyboardEvent} */ (e).key;
        if (key !== 'Enter' && key !== ' ') return;
        // Only the row itself, not a focusable control inside it.
        const row = rowFromEvent(container, e.target);
        if (!row || row !== e.target) return;
        e.preventDefault();
        openRowDetail(row);
    });
}

/** @param {string} rule */
function getRuleColorClass(rule) {
    const r = (rule ?? '').toLowerCase();
    if (r.includes('direct') || r === 'direct') return 'bg-emerald-500/15 text-emerald-400';
    if (r.includes('reject') || r === 'reject') return 'bg-rose-500/15 text-rose-400';
    if (r.includes('match')) return 'bg-[var(--zephyr-bg-muted)] text-[var(--text-secondary)]';
    return 'bg-accent/15 text-accent';
}

// ============================================
// Connection Detail Panel
// ============================================

/**
 * Return focus to the row (or control) that opened the detail dialog. Rows can be
 * re-rendered while it is open, so fall back to the row with the same id.
 * @param {HTMLElement|null} opener @param {string} connId
 */
function restoreDetailFocus(opener, connId) {
    let target = opener && opener.isConnected ? opener : null;
    if (!target && connId) {
        target = /** @type {HTMLElement|null} */ (Array.from(document.querySelectorAll('.conn-row'))
            .find((r) => /** @type {HTMLElement} */ (r).dataset.connId === connId) ?? null);
    }
    // The row may be gone (connection closed while the dialog was open): land on the
    // selected list tab so focus never stays inside the closing dialog.
    if (!target) {
        target = /** @type {HTMLElement|null} */ (document.querySelector('.conn-tab[aria-selected="true"]'));
    }
    target?.focus({ preventScroll: true });
}

/** Pending hide of the detail backdrop after its close animation. */
/** @type {ReturnType<typeof setTimeout>|undefined} */
let connDetailHideTimer;
/** Document-level key handler of the open detail dialog (catches keys even when focus slipped out). */
/** @type {((e: KeyboardEvent) => void)|null} */
let connDetailKeyHandler = null;

/**
 * Show a detail overlay panel for a single connection.
 * Reuses glass-card styling from the app's design system.
 * For active connections, includes a Close button.
 * @param {any} conn
 * @param {string} mode
 * @param {HTMLElement|null} [openerRow] row that opened it (a mouse click may not focus it)
 */
function showConnDetail(conn, mode, openerRow = null) {
    const t = /** @type {any} */ (translations)[currentLang] ?? {};
    const meta = conn.metadata ?? {};
    const id = _esc(conn.id ?? '');
    const host = _esc(meta.host ?? '-');
    const process = _esc(meta.process ?? '-');
    const destIP = _esc(meta.destinationIP ?? '-');
    const destPort = _esc(String(meta.destinationPort ?? '-'));
    const rule = _esc(conn.rule || 'Match');
    const chains = (conn.chains ?? []).map(_esc).join(' → ') || '-';
    const ruleColorClass = getRuleColorClass(rule);

    // Resolve stats (speed + total) via shared resolver
    const { dlSpeed, ulSpeed, dlTotal, ulTotal } = resolveConnStats(conn, mode);
    // The connection's real start is `conn.start` (ISO string), not when this page first saw it.
    const startMs = connStartMs(conn);
    let duration = '-';
    if (mode === 'closed' && conn.closedAt) {
        duration = startMs ? fmtDuration(Math.max(0, conn.closedAt - startMs)) : '-';
    } else if (mode === 'active') {
        const acc = connAccumulators[conn.id];
        const from = startMs || acc?.seenAt;
        duration = from ? fmtDuration(Date.now() - from) : '-';
    }

    // Network info
    // NOTE: These values use String() coercion (NOT _esc()) because they are
    // only ever rendered through renderDetailRow(), which already calls _esc()
    // on both label and value.  Pre-escaping here would cause double-escaping
    // (e.g., "&" → "&amp;" → "&amp;amp;").  String() only ensures type safety
    // so that undefined/null become '-' instead of "undefined".
    const networkVal = String(meta.network || meta.interface || '-');
    const typeVal = String(meta.type || conn.type || '-');
    const srcIp = String(meta.sourceIP || '-');
    const srcPort = String(meta.sourcePort || '-');

    // Build close button HTML (only for active connections)
    const closeBtnHtml = mode === 'active'
        ? `<button id="detail-close-btn" type="button" class="btn-danger mt-5 w-full justify-center">
             <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
             <span>${t.closeConn || 'Close Connection'}</span>
           </button>`
        : '';

    const panelHtml = `
    <div class="glass-card w-full max-w-lg p-6 relative" id="conn-detail-panel" role="dialog" aria-modal="true" aria-labelledby="conn-detail-title">
        <!-- Header -->
        <div class="flex items-start justify-between mb-5">
            <div class="min-w-0 flex-1 pe-4">
                <h3 class="dialog-title truncate" id="conn-detail-title">${host}</h3>
            </div>
            <button id="detail-dismiss-btn" aria-label="${escapeHtml(t.dismiss || 'Close')}" class="shrink-0 w-8 h-8 rounded-full bg-[var(--zephyr-bg-muted)] border border-[var(--zephyr-border-default)] flex items-center justify-center text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--zephyr-bg-input)] transition-colors">
                <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
        </div>

        <!-- Rule & Chains -->
        <div class="flex items-center gap-3 mb-5">
            <span class="inline-flex px-2.5 py-1 rounded-full text-xs font-semibold ${ruleColorClass}">${rule}</span>
            ${conn.rulePayload ? `<span class="text-xs font-mono text-[var(--text-primary)] truncate">${_esc(conn.rulePayload)}</span>` : ''}
            <span class="text-xs text-[var(--text-secondary)] truncate">→ ${chains}</span>
        </div>

        <!-- Stats Grid -->
        <div class="grid grid-cols-2 gap-3 mb-5">
            <div class="bg-[var(--zephyr-bg-muted)] rounded-[var(--radius-md)] p-3 border border-[var(--zephyr-border-subtle)]">
                <div class="flex items-center justify-between mb-1">
                    <span class="text-xs text-[var(--text-muted)] font-medium">${t.dlSpeedLabel || 'Download Speed'}</span>
                </div>
                <span class="text-sm font-semibold text-download tabular-nums block" id="detail-dl-speed">${dlSpeed}</span>
                <div class="flex items-center justify-between mt-1.5 pt-1.5 border-t border-[var(--zephyr-border-subtle)]">
                    <span class="text-xs text-[var(--text-muted)]">${t.totalLabel || 'Total'}</span>
                    <span class="text-xs text-[var(--text-secondary)] tabular-nums" id="detail-dl-total">${dlTotal}</span>
                </div>
            </div>
            <div class="bg-[var(--zephyr-bg-muted)] rounded-[var(--radius-md)] p-3 border border-[var(--zephyr-border-subtle)]">
                <div class="flex items-center justify-between mb-1">
                    <span class="text-xs text-[var(--text-muted)] font-medium">${t.ulSpeedLabel || 'Upload Speed'}</span>
                </div>
                <span class="text-sm font-semibold text-upload tabular-nums block" id="detail-ul-speed">${ulSpeed}</span>
                <div class="flex items-center justify-between mt-1.5 pt-1.5 border-t border-[var(--zephyr-border-subtle)]">
                    <span class="text-xs text-[var(--text-muted)]">${t.totalLabel || 'Total'}</span>
                    <span class="text-xs text-[var(--text-secondary)] tabular-nums" id="detail-ul-total">${ulTotal}</span>
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
        bg.className = 'fixed inset-0 z-[105] hidden items-center justify-center bg-[var(--zephyr-bg-overlay)] backdrop-blur-md transition-all duration-[var(--zephyr-time-micro)] opacity-0';
        document.body.appendChild(bg);
    }

    // Remember who opened the dialog so focus can return there on close.
    const opener = openerRow ?? (document.activeElement instanceof HTMLElement && !bg.contains(document.activeElement)
        ? document.activeElement : null);

    // A reopen inside the close animation must not be hidden by the old timer.
    clearTimeout(connDetailHideTimer);
    connDetailHideTimer = undefined;
    if (connDetailKeyHandler) document.removeEventListener('keydown', connDetailKeyHandler);
    connDetailKeyHandler = null;
    // eslint-disable-next-line no-unsanitized/property -- values escaped via _esc() in showConnDetail
    bg.innerHTML = panelHtml; // nosemgrep: js-innerhtml-assignment — verified safe, see eslint-disable above
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
        clearTimeout(connDetailHideTimer);
        connDetailHideTimer = setTimeout(() => {
            connDetailHideTimer = undefined;
            bg.classList.add('hidden');
            bg.classList.remove('flex');
        }, 150);
        if (connDetailKeyHandler) document.removeEventListener('keydown', connDetailKeyHandler);
        connDetailKeyHandler = null;
        bg.onclick = null;
        restoreDetailFocus(opener, conn.id);
    };

    // Keyboard: Escape closes, Tab stays inside the dialog. Listen on the document so a Tab
    // pressed after focus slipped out (e.g. a click on the panel's text) is still caught.
    const panelBg = bg;
    connDetailKeyHandler = (e) => {
        if (e.key === 'Escape') {
            e.preventDefault();
            dismiss();
            return;
        }
        if (e.key !== 'Tab') return;
        const items = /** @type {HTMLElement[]} */ (Array.from(panelBg.querySelectorAll('button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])')));
        if (items.length === 0) return;
        const first = items[0];
        const last = items.at(-1) ?? first;
        if (!panelBg.contains(document.activeElement)) {
            e.preventDefault();
            (e.shiftKey ? last : first).focus();
        } else if (e.shiftKey && document.activeElement === first) {
            e.preventDefault();
            last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first.focus();
        }
    };
    document.addEventListener('keydown', connDetailKeyHandler);
    document.getElementById('detail-dismiss-btn')?.focus({ preventScroll: true });

    document.getElementById('detail-dismiss-btn')?.addEventListener('click', dismiss);
    bg.onclick = (e) => { if (e.target === bg) dismiss(); };

    // Close connection button (only active)
    const closeBtn = document.getElementById('detail-close-btn');
    if (closeBtn && mode === 'active') {
        closeBtn.addEventListener('click', async () => {
            setButtonLoading(closeBtn, t, 'closing');

            try {
                await closeConnection(id);
                closedConnections.unshift(archiveConnection(conn, Date.now()));
                delete connAccumulators[conn.id];
                // Already archived: the refresh below must not archive it a second time.
                userClosedIds.add(conn.id);
                cachedConnections = cachedConnections.filter((/** @type {any} */ c) => c.id !== conn.id);
                showNotification(t.connClosed || 'Connection closed', 'success');
                dismiss();
                await fetchAndRenderConnections();
                // The refresh removes the closed row that just took focus back; land on the tab instead.
                const active = document.activeElement;
                if (!active || active === document.body || !active.isConnected) restoreDetailFocus(null, conn.id);
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
        if (!acc) {
            // The connection ended while its details were open: freeze the numbers, mark it
            // closed and drop the "close connection" button.
            markDetailDisconnected();
            activeDetailMode = 'closed';
            return;
        }
        dlSpeedEl.textContent = formatSpeed(acc.dlSpeed ?? 0);
        dlTotalEl.textContent = formatBytes(acc.dl);
        ulSpeedEl.textContent = formatSpeed(acc.ulSpeed ?? 0);
        ulTotalEl.textContent = formatBytes(acc.ul);
        const durEl = document.getElementById('detail-duration');
        const live = cachedConnections.find((/** @type {any} */ c) => c.id === connId);
        const from = (live && connStartMs(live)) || acc.seenAt;
        if (durEl) durEl.textContent = fmtDuration(Date.now() - from);
    }
    // Closed connections: values are static, no update needed
}

/**
 * Start time of a connection in ms, from mihomo's `start` (ISO string); 0 if unknown.
 * @param {any} conn
 */
function connStartMs(conn) {
    const raw = conn?.start ?? conn?.metadata?.start;
    if (typeof raw === 'number') return raw;
    const ms = typeof raw === 'string' ? Date.parse(raw) : Number.NaN;
    return Number.isFinite(ms) ? ms : 0;
}

/** Detail panel: the connection is gone. */
function markDetailDisconnected() {
    document.getElementById('detail-close-btn')?.remove();
    const title = document.getElementById('conn-detail-title');
    if (title && !document.getElementById('detail-disconnected')) {
        const t = /** @type {any} */ (translations)[currentLang] ?? {};
        const tag = document.createElement('span');
        tag.id = 'detail-disconnected';
        tag.className = 'conn-detail-closed-tag';
        tag.textContent = t.connDisconnected || 'Closed';
        title.after(tag);
    }
    for (const id of ['detail-dl-speed', 'detail-ul-speed']) {
        const el = document.getElementById(id);
        if (el) el.textContent = '—';
    }
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
    <span class="text-[var(--text-muted)] shrink-0 me-4">${_esc(label)}</span>
    <span${idAttr} class="text-[var(--text-secondary)] font-mono text-end truncate min-w-0 tabular-nums">${_esc(value)}</span>
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

    if (_bulkCloseInFlight) return;
    const t = /** @type {any} */ (translations)[currentLang] ?? {};
    _bulkCloseInFlight = true;
    setButtonLoading(btn, t, 'closing');

    try {
        const now = Date.now();
        let failed = 0;
        let closedMatching = 0;
        if (connectionsSearchQuery) {
            // Searching: close only the connections the list is showing, and archive
            // only those the core actually closed.
            const matching = filterConnsBySearch(cachedConnections);
            const results = await Promise.allSettled(matching.map((/** @type {any} */ c) => closeConnection(c.id)));
            /** @type {Set<string>} */
            const closedIds = new Set();
            results.forEach((r, i) => {
                if (r.status !== 'fulfilled') { failed += 1; return; }
                const conn = matching[i];
                closedIds.add(conn.id);
                userClosedIds.add(conn.id);
                closedConnections.unshift(archiveConnection(conn, now));
                delete connAccumulators[conn.id];
            });
            closedMatching = closedIds.size;
            // Already archived: the refresh below must not archive them a second time.
            cachedConnections = cachedConnections.filter((/** @type {any} */ c) => !closedIds.has(c.id));
        } else {
            // Archive what the core holds right now, not the last poll's snapshot
            // (connections opened since, or already gone, would be wrong).
            let live = cachedConnections;
            try {
                const data = /** @type {any} */ (await getConnections());
                if (Array.isArray(data?.connections)) live = data.connections.filter((/** @type {any} */ c) => !userClosedIds.has(c.id));
            } catch { /* fall back to the last poll */ }
            await closeAllConnections();
            for (const conn of live) {
                userClosedIds.add(conn.id);
                closedConnections.unshift(archiveConnection(conn, now));
            }
            connAccumulators = {};
            cachedConnections = [];
        }
        if (closedConnections.length > MAX_CLOSED_CONNS) closedConnections.length = MAX_CLOSED_CONNS;
        if (failed > 0) showNotification(t.closeConnsFailed || 'Failed to close connections', 'error');
        else if (connectionsSearchQuery) showNotification(tFmt('matchingConnsClosed', { count: closedMatching }), 'success');
        else showNotification(t.connsClosed || 'All connections closed', 'success');
        await fetchAndRenderConnections();
    } catch {
        showNotification(t.closeConnsFailed || 'Failed to close connections', 'error');
    } finally {
        _bulkCloseInFlight = false;
        switchConnTab(currentConnTab);
    }
}

async function handleClearClosedConnections() {
    const btn = document.getElementById('close-all-conns-btn');
    if (!btn) return;

    const t = /** @type {any} */ (translations)[currentLang] ?? {};
    setButtonLoading(btn, t, 'clearing');

    try {
        // While searching, clear only what the search shows (as "Close N matching" does).
        if (connectionsSearchQuery) {
            const shown = new Set(filterConnsBySearch(closedConnections));
            closedConnections = closedConnections.filter((/** @type {any} */ c) => !shown.has(c));
        } else {
            closedConnections = [];
        }
        showNotification(t.connsCleared || 'Closed history cleared', 'success');
        renderConnectionList(connectionsSearchQuery ? filterConnsBySearch(closedConnections) : [], 'closed');

        updateClosedBadge();
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
    // The count rides on the tab itself: "Closed · 3".
    const tab = document.getElementById('conn-tab-closed');
    if (!tab) return;
    const t = /** @type {any} */ (translations)[currentLang] ?? {};
    const base = t.closedTab || 'Closed';
    tab.textContent = `${base} · ${closedConnections.length}`;
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
        icon.innerHTML = '<path d="M21 12a9 9 0 1 1-6.219-8.56"/>'; // nosemgrep: js-innerhtml-assignment — static HTML
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
    // eslint-disable-next-line no-unsanitized/property -- caller-validated: iconSvg/text are hardcoded SVG + i18n // nosemgrep: js-innerhtml-assignment — verified safe, see eslint-disable above
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
        // A closed connection has no speed: show how long it lasted and when it closed.
        const start = connStartMs(conn);
        return {
            dlSpeed: start && conn.closedAt ? fmtDuration(Math.max(0, conn.closedAt - start)) : '—',
            ulSpeed: conn.closedAt ? new Date(conn.closedAt).toLocaleTimeString(currentLang || undefined, { hour12: false }) : '—',
            dlTotal: formatBytes(conn.dlTotal ?? 0),
            ulTotal: formatBytes(conn.ulTotal ?? 0),
        };
    }
    const acc = connAccumulators[conn.id] ?? { dl: 0, ul: 0, dlSpeed: 0, ulSpeed: 0 };
    const speed = (/** @type {number} */ v) => formatSpeed(Math.max(0, v));
    return {
        dlSpeed: speed(acc.dlSpeed ?? 0),
        ulSpeed: speed(acc.ulSpeed ?? 0),
        dlTotal: formatBytes(acc.dl),
        ulTotal: formatBytes(acc.ul),
    };
}


