// @ts-check
/**
 * Zephyr Logs Page Module — Virtual-Scroll Real-Time Log Viewer
 *
 * Architecture:
 * ┌─────────────────────────────────────────────────────────────┐
 * │  Virtual Scroll Engine (shared module)                      │
 * │  ├─ createVirtualScroll() from utils/virtual-scroll.js     │
 * │  ├─ O(log n) binary search (Float64Array prefix-sum)        │
 * │  ├─ Scroll quantization (SCROLL_QUANTUM bins)               │
 * │  ├─ Overscan buffer (OVERSCAN_ROWS top/bottom)              │
 * │  └─ Adaptive mount cap (MAX_MOUNTED_ITEMS)                  │
 * ├─────────────────────────────────────────────────────────────┤
 * │  Incremental DOM Engine                                     │
 * │  ├─ Keyed diffing (line index as key)                       │
 * │  ├─ Append-only fast path (new logs at tail)                │
 * │  ├─ Search debounce (150ms trailing)                        │
 * │  └─ Sticky scroll with manual override detection            │
 * ├─────────────────────────────────────────────────────────────┤
 * │  Data Layer                                                 │
 * │  ├─ Byte-offset incremental polling (1s interval)           │
 * │  ├─ 2000-line ring buffer with trim-from-head               │
 * │  ├─ 5-level filtering (all/debug/info/warn/error)           │
 * │  └─ Regex search with <mark> highlighting                   │
 * ├─────────────────────────────────────────────────────────────┤
 * │  Lifecycle                                                  │
 * │  ├─ registerCleanup() on init                               │
 * │  ├─ stopPolling() on page leave                             │
 * │  └─ Full state reset on re-enter                            │
 * └─────────────────────────────────────────────────────────────┘
 *
 * @module ui/logs
 */

import { readCoreLog } from '../api.js';
import { translations, currentLang } from '../i18n.js';
import { registerCleanup } from '../utils/cleanup-registry.js';
import { escapeHtml } from '../utils/sanitize.js';
import { createVirtualScroll } from '../utils/virtual-scroll.js';
import { getExtLogEvents, subscribeToEvents, unsubscribeFromEvents } from '../modules/backend-events.js';

// ── Constants ──────────────────────────────────────────────────────────────

const MAX_LINES       = 2000;   // Ring buffer capacity
const POLL_INTERVAL   = 1000;   // Backend poll period (ms)
const DEBOUNCE_MS     = 150;    // Search input debounce (ms)
const OVERSCAN_ROWS   = 40;     // Virtual scroll overscan buffer
const SCROLL_QUANTUM  = 20;     // Scroll quantization bin size (rows)
const MAX_MOUNTED     = 300;    // Hard cap on simultaneously mounted DOM nodes
const ROW_HEIGHT_EST  = 18;     // Estimated line height in px (text-2xs + leading-relaxed)
const STICKY_THRESHOLD = 40;    // Pixels from bottom to consider "at bottom"

/** @type {Readonly<Record<string, string>>} Level → color mapping (dark mode) */
const LEVEL_COLORS_DARK = Object.freeze({
    debug: '#6b7280',
    info:  '#60a5fa',
    warn:  '#f59e0b',
    error: '#ef4444',
    fatal: '#dc2626',
});

/** @type {Readonly<Record<string, string>>} Level → color mapping (light mode) */
const LEVEL_COLORS_LIGHT = Object.freeze({
    debug: '#9ca3af',
    info:  '#3b82f6',
    warn:  '#d97706',
    error: '#dc2626',
    fatal: '#991b1b',
});

/** @type {Readonly<Record<string, number>>} Level → numeric priority for filtering */
const LEVEL_PRIORITY = Object.freeze({
    debug: 0,
    info:  1,
    warn:  2,
    error: 3,
    fatal: 4,
});

// ── Log Level Parser (regex compiled once, reused) ────────────────────────

// mihomo format: level=info / level=warn / level=error / level=debug
const LEVEL_RE = /(?:\[|\blevel=)(DEBUG|INFO|WARN|WARNING|ERROR)(?:\]|\b)/i;

/**
 * Extract log level from a line.
 * Supports both mihomo format (`level=info`) and bracket format (`[INFO]`).
 * @param {string} line
 * @returns {'debug'|'info'|'warn'|'error'}
 */
function parseLogLevel(line) {
    const m = LEVEL_RE.exec(line);
    if (!m) return 'info';
    const lvl = m[1].toUpperCase();
    return lvl === 'WARNING' ? 'warn' : /** @type {'debug'|'info'|'warn'|'error'} */ (lvl.toLowerCase());
}

// ── State ──────────────────────────────────────────────────────────────────

/** @type {number|null} */
let _pollTimer = null;
/** @type {number} */
let _offset = 0;
/** @type {boolean} */
let _autoScroll = true;
/** @type {'all'|'debug'|'info'|'warn'|'error'} */
let _levelFilter = 'all';
/** @type {string} */
let _searchQuery = '';
/** @type {string[]} All raw log lines (ring-buffered) */
let _allLines = [];
/** @type {number[]} Filtered indices into _allLines */
let _filteredIndices = [];
/** @type {HTMLElement|null} */
let _container = null;
/** @type {HTMLElement|null} */
let _logContent = null;
/** @type {HTMLElement|null} */
let _spacerTop = null;
/** @type {HTMLElement|null} */
let _spacerBottom = null;
/** @type {HTMLElement|null} */
let _lineCountEl = null;
/** @type {HTMLElement|null} */
let _autoScrollBtn = null;
/** @type {number|null} */
let _debounceTimer = null;
/** @type {number} */
let _lastRenderedFilterHash = -1;
/** @type {boolean} */
let _initialized = false;
/** @type {(() => void)|null} */
let _cleanupUnregister = null;

// App logs state
/** @type {boolean} Whether the App Logs tab is currently active */
let _extLogTabActive = false;
/** @type {'all'|'info'|'warn'|'error'} Level filter for app logs */
let _extLevelFilter = 'all';
/** @type {string} Search query for app logs */
let _extSearchQuery = '';
/** @type {number|null} */
let _extDebounceTimer = null;
/** @type {boolean} Auto scroll for app logs */
let _extAutoScroll = true;

// Virtual scroll instance (shared module)
/** @type {ReturnType<typeof createVirtualScroll>|null} */
let _vs = null;

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Initialize the logs page. Called once when user navigates to logs.
 * Resets all state, builds DOM, kicks off polling.
 */
export async function initLogsPage() {
    _container = document.querySelector('[data-page="logs"]');
    if (!_container) return;

    // If already initialized, just reset and restart
    if (_initialized) {
        resetState();
        // eslint-disable-next-line no-unsanitized/property -- static HTML template from buildPageHTML()
        _container.innerHTML = buildPageHTML();
        cacheDOMRefs();
        bindEvents();
        createVirtualScrollInstance();
        await fetchLogs();
        startPolling();
        return;
    }

    _initialized = true;
    resetState();
    // eslint-disable-next-line no-unsanitized/property -- static HTML template from buildPageHTML()
    _container.innerHTML = buildPageHTML();
    cacheDOMRefs();
    bindEvents();
    createVirtualScrollInstance();
    await fetchLogs();
    startPolling();

    // Register global cleanup — ensures polling stops on app shutdown
    _cleanupUnregister = registerCleanup(() => stopPolling());
}

/**
 * Destroy logs page. Called when user navigates away.
 * Stops polling and cleans up virtual scroll, but keeps event history.
 */
export function destroyLogsPage() {
    stopPolling();
    _vs?.destroy();
    _vs = null;
    unsubscribeFromEvents();
}

// ── State Management ───────────────────────────────────────────────────────

function resetState() {
    stopPolling();
    _offset = 0;
    _allLines = [];
    _filteredIndices = [];
    _autoScroll = true;
    _levelFilter = 'all';
    _searchQuery = '';
    _lastRenderedFilterHash = -1;
    _vs?.destroy();
    _vs = null;
    _extLogTabActive = false;
    _extLevelFilter = 'all';
    _extSearchQuery = '';
    _extAutoScroll = true;
    if (_debounceTimer) {
        clearTimeout(_debounceTimer);
        _debounceTimer = null;
    }
    if (_extDebounceTimer) {
        clearTimeout(_extDebounceTimer);
        _extDebounceTimer = null;
    }
}

// ── DOM Caching ────────────────────────────────────────────────────────────

function cacheDOMRefs() {
    _logContent    = _container?.querySelector('#log-content') ?? null;
    _spacerTop     = _container?.querySelector('#log-spacer-top') ?? null;
    _spacerBottom  = _container?.querySelector('#log-spacer-bottom') ?? null;
    _lineCountEl   = _container?.querySelector('#log-line-count') ?? null;
    _autoScrollBtn = _container?.querySelector('#log-auto-scroll-btn') ?? null;
}

// ── Polling ────────────────────────────────────────────────────────────────

function stopPolling() {
    if (_pollTimer !== null) {
        clearInterval(_pollTimer);
        _pollTimer = null;
    }
}

function startPolling() {
    stopPolling();
    _pollTimer = setInterval(fetchLogs, POLL_INTERVAL);
}

// ── HTML Builder ───────────────────────────────────────────────────────────

/** @param {string} key */
function t(key) {
    const langKey = /** @type {'en'|'zh'|'ja'|'ko'} */ (currentLang);
    const dict = /** @type {Record<string, string>} */ (translations[langKey]) || /** @type {Record<string, string>} */ (translations.en);
    return dict[key] || key;
}

function buildPageHTML() {
    return `
        <header class="flex items-center justify-between relative z-10 shrink-0">
            <div class="flex items-center gap-4">
                <h2 class="text-2xl font-light text-[var(--text-primary)]" data-i18n="logsTitle">${t('logsTitle')}</h2>
                <!-- Tab buttons -->
                <div class="flex items-center gap-1 bg-[var(--zephyr-bg-muted)] rounded-lg p-0.5">
                    <button id="log-tab-core" class="log-tab-btn active text-xs px-3 py-1 rounded-md transition-colors" data-i18n="logTabCore">${t('logTabCore')}</button>
                    <button id="log-tab-ext" class="log-tab-btn text-xs px-3 py-1 rounded-md transition-colors" data-i18n="ruleLibraryLogTab">${t('ruleLibraryLogTab')}</button>
                </div>
            </div>
            <div class="flex items-center gap-3">
                <span id="log-line-count" class="text-xs text-[var(--text-muted)] tabular-nums">0 ${t('logLines')}</span>
                <button id="log-auto-scroll-btn" class="btn-ghost active" title="${t('autoScroll')}">
                    <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12l7 7 7-7"/></svg>
                    <span data-i18n="autoScroll">${t('autoScroll')}</span>
                </button>
            </div>
        </header>

        <!-- Core Logs Panel -->
        <div id="log-panel-core" class="flex-1 min-h-0 flex flex-col gap-4 relative z-10">
            <!-- Filter bar -->
            <div class="flex items-center gap-2 flex-wrap relative z-10">
                <button class="log-level-btn active" data-level="all" data-i18n="logLevelAll">${t('logLevelAll')}</button>
                <button class="log-level-btn" data-level="debug" data-i18n="logLevelDebug">${t('logLevelDebug')}</button>
                <button class="log-level-btn" data-level="info" data-i18n="logLevelInfo">${t('logLevelInfo')}</button>
                <button class="log-level-btn" data-level="warn" data-i18n="logLevelWarn">${t('logLevelWarn')}</button>
                <button class="log-level-btn" data-level="error" data-i18n="logLevelError">${t('logLevelError')}</button>
                <div class="flex-1"></div>
                <!-- Search Box -->
                <div class="relative group flex items-center">
                    <div class="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                        <svg class="h-4 w-4 text-[var(--text-secondary)] group-focus-within:text-[var(--text-primary)] transition-colors duration-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                        </svg>
                    </div>
                    <input id="log-search" type="text" placeholder="${t('searchLogs')}" data-i18n-placeholder="searchLogs" class="bg-[var(--zephyr-bg-muted)] border border-[var(--zephyr-border-default)] rounded-full py-2 px-5 pl-11 text-[var(--text-primary)] text-xs w-52 transition-all duration-400 focus:outline-none focus:border-[var(--zephyr-border-strong)] focus:bg-[var(--zephyr-bg-input)] focus:w-72 placeholder:text-[var(--text-secondary)] shadow-inner">
                </div>
            </div>

            <!-- Virtual scroll container -->
            <div id="log-content" class="flex-1 min-h-0 overflow-y-auto rounded-lg bg-[var(--zephyr-bg-muted)] border border-[var(--zephyr-border-default)] p-4 font-mono text-2xs leading-relaxed tabular-nums relative z-10 custom-scrollbar">
                <div id="log-spacer-top" style="height:0"></div>
                <div id="log-lines-container"></div>
                <div id="log-spacer-bottom" style="height:0"></div>
            </div>
        </div>

        <!-- App Logs Panel -->
        <div id="log-panel-ext" class="hidden flex-1 min-h-0 flex flex-col gap-4 relative z-10">
            <!-- Filter bar (no Debug — app logs have no debug level) -->
            <div class="flex items-center gap-2 flex-wrap relative z-10">
                <button class="log-level-btn active" data-level="all" data-i18n="logLevelAll">${t('logLevelAll')}</button>
                <button class="log-level-btn" data-level="info" data-i18n="logLevelInfo">${t('logLevelInfo')}</button>
                <button class="log-level-btn" data-level="warn" data-i18n="logLevelWarn">${t('logLevelWarn')}</button>
                <button class="log-level-btn" data-level="error" data-i18n="logLevelError">${t('logLevelError')}</button>
                <button class="log-level-btn" data-level="fatal" data-i18n="logLevelFatal">${t('logLevelFatal')}</button>
                <div class="flex-1"></div>
                <!-- Search Box -->
                <div class="relative group flex items-center">
                    <div class="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                        <svg class="h-4 w-4 text-[var(--text-secondary)] group-focus-within:text-[var(--text-primary)] transition-colors duration-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                        </svg>
                    </div>
                    <input id="log-ext-search" type="text" placeholder="${t('searchLogs')}" data-i18n-placeholder="searchLogs" class="bg-[var(--zephyr-bg-muted)] border border-[var(--zephyr-border-default)] rounded-full py-2 px-5 pl-11 text-[var(--text-primary)] text-xs w-52 transition-all duration-400 focus:outline-none focus:border-[var(--zephyr-border-strong)] focus:bg-[var(--zephyr-bg-input)] focus:w-72 placeholder:text-[var(--text-secondary)] shadow-inner">
                </div>
            </div>
            <div id="log-ext-content" class="flex-1 min-h-0 overflow-y-auto rounded-lg bg-[var(--zephyr-bg-muted)] border border-[var(--zephyr-border-default)] p-4 font-mono text-2xs leading-relaxed tabular-nums custom-scrollbar">
                <div id="log-ext-empty" class="flex flex-col items-center justify-center h-full text-[var(--text-tertiary)]">
                    <svg class="w-8 h-8 mb-3 opacity-30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
                    <span data-i18n="ruleLibraryLogEmpty">${t('ruleLibraryLogEmpty')}</span>
                </div>
                <div id="log-ext-list" class="space-y-1"></div>
            </div>
        </div>
    `;
}

// ── Event Binding ──────────────────────────────────────────────────────────

function bindEvents() {
    if (!_container) {
        return;
    }

    // Tab switching
    const tabCore = _container.querySelector('#log-tab-core');
    const tabExt = _container.querySelector('#log-tab-ext');
    const panelCore = _container.querySelector('#log-panel-core');
    const panelExt = _container.querySelector('#log-panel-ext');

    const switchToCoreTab = () => {
        _extLogTabActive = false;
        tabCore?.classList.add('active');
        tabExt?.classList.remove('active');
        panelCore?.classList.remove('hidden');
        panelCore?.classList.add('flex', 'flex-col', 'gap-4');
        panelExt?.classList.add('hidden');
        panelExt?.classList.remove('flex', 'flex-col', 'gap-4');
        invalidateFilter();
        updateLineCount();
    };

    const switchToExtTab = () => {
        _extLogTabActive = true;
        tabExt?.classList.add('active');
        tabCore?.classList.remove('active');
        panelExt?.classList.remove('hidden');
        panelExt?.classList.add('flex', 'flex-col', 'gap-4');
        panelCore?.classList.add('hidden');
        panelCore?.classList.remove('flex', 'flex-col', 'gap-4');
        updateExtLineCount();
    };

    tabCore?.addEventListener('click', switchToCoreTab);
    tabExt?.addEventListener('click', switchToExtTab);

    // Subscribe to new events from global listener
    subscribeToEvents((entry) => {
        renderExtLogEntry(entry);
    });

    // Rebuild ext-log DOM from accumulated events (if any)
    rebuildExtLogDOM();

    // Auto scroll toggle (shared by both tabs)
    _autoScrollBtn?.addEventListener('click', () => {
        _autoScroll = !_autoScroll;
        _extAutoScroll = _autoScroll;
        _autoScrollBtn?.classList.toggle('active', _autoScroll);
        if (_extLogTabActive) {
            if (_autoScroll) {
                const extContent = _container?.querySelector('#log-ext-content');
                if (extContent) extContent.scrollTop = extContent.scrollHeight;
            }
        } else {
            if (_autoScroll && _logContent) {
                _logContent.scrollTop = _logContent.scrollHeight;
                render();
            }
        }
    });

    // Level filter buttons (core panel)
    _container.querySelectorAll('#log-panel-core .log-level-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            if (!_container) return;
            _container.querySelectorAll('#log-panel-core .log-level-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            _levelFilter = /** @type {'all'|'debug'|'info'|'warn'|'error'} */ (/** @type {HTMLElement} */ (btn).dataset.level) || 'all';
            invalidateFilter();
            render();
        });
    });

    // Search input — debounced
    const searchInput = /** @type {HTMLInputElement|null} */ (_container.querySelector('#log-search'));
    searchInput?.addEventListener('input', () => {
        if (_debounceTimer) clearTimeout(_debounceTimer);
        _debounceTimer = setTimeout(() => {
            _searchQuery = (searchInput?.value || '').trim();
            invalidateFilter();
            render();
            _debounceTimer = null;
        }, DEBOUNCE_MS);
    });

    // App logs: Level filter buttons (ext panel)
    _container.querySelectorAll('#log-panel-ext .log-level-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            if (!_container) return;
            _container.querySelectorAll('#log-panel-ext .log-level-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            _extLevelFilter = /** @type {'all'|'info'|'warn'|'error'} */ (/** @type {HTMLElement} */ (btn).dataset.level) || 'all';
            rebuildExtLogDOM();
        });
    });

    // App logs: Search input — debounced
    const extSearchInput = /** @type {HTMLInputElement|null} */ (_container.querySelector('#log-ext-search'));
    extSearchInput?.addEventListener('input', () => {
        if (_extDebounceTimer) clearTimeout(_extDebounceTimer);
        _extDebounceTimer = setTimeout(() => {
            _extSearchQuery = (extSearchInput?.value || '').trim();
            rebuildExtLogDOM();
            _extDebounceTimer = null;
        }, DEBOUNCE_MS);
    });

}

// ── Scroll Handler (auto-scroll detection only; quantization handled by shared module) ──

function onScroll() {
    if (!_logContent) return;
    const scrollTop = _logContent.scrollTop;

    // Detect manual scroll away from bottom
    const atBottom = _logContent.scrollHeight - scrollTop - _logContent.clientHeight < STICKY_THRESHOLD;
    if (!atBottom && _autoScroll) {
        _autoScroll = false;
        _autoScrollBtn?.classList.remove('active');
    }
}

// ── Data Fetching ──────────────────────────────────────────────────────────

async function fetchLogs() {
    try {
        const result = await readCoreLog(_offset, 500);
        if (!result || result.lines.length === 0) return;

        // Detect log rotation via backend signal or offset regression
        if (result.rotated || result.next_offset < _offset) {
            _offset = 0;
            _allLines = [];
            _vs?.clearHeightCache();
            // invalidateFilter() will rebuild indices and call _vs.invalidate()
            invalidateFilter();
        } else {
            _offset = result.next_offset;
        }

        // Append new lines
        _allLines.push(...result.lines);

        // Ring buffer trim from head
        if (_allLines.length > MAX_LINES) {
            const excess = _allLines.length - MAX_LINES;
            _allLines = _allLines.slice(excess);
            // Height cache indices shifted — invalidate to trigger full re-render
            _vs?.clearHeightCache();
        }

        // Skip rendering when extension tab is active to avoid virtual scroll clearing DOM
        if (!_extLogTabActive) {
            invalidateFilter();
            updateLineCount();
            render();
        }
    } catch {
        // Core not started yet or log file unavailable — ignore silently
    }
}

// ── Filtering ──────────────────────────────────────────────────────────────

/** Compute filter hash for change detection */
function computeFilterHash() {
    // Simple hash: combine filter level + search query length + first char
    return (_levelFilter.charCodeAt(0) << 16) | (_searchQuery.length << 8) | (_searchQuery.charCodeAt(0) || 0);
}

function invalidateFilter() {
    _lastRenderedFilterHash = -1;
    rebuildFilteredIndices();
    _vs?.invalidate();
}

function rebuildFilteredIndices() {
    const filterChanged = computeFilterHash() !== _lastRenderedFilterHash;
    if (!filterChanged && _filteredIndices.length > 0) return;

    _lastRenderedFilterHash = computeFilterHash();

    if (_levelFilter === 'all' && !_searchQuery) {
        // Fast path: no filtering needed
        _filteredIndices = _allLines.map((_, i) => i);
        return;
    }

    const minPriority = _levelFilter === 'all' ? -1 : LEVEL_PRIORITY[_levelFilter];
    const query = _searchQuery ? _searchQuery.toLowerCase() : '';

    _filteredIndices = [];
    for (let i = 0; i < _allLines.length; i++) {
        const line = _allLines[i];

        // Level filter — inclusive: selected level and above (industry standard)
        if (minPriority >= 0) {
            const level = parseLogLevel(line);
            if (LEVEL_PRIORITY[level] < minPriority) continue;
        }

        // Search filter
        if (query && !line.toLowerCase().includes(query)) continue;

        _filteredIndices.push(i);
    }
}

// ── Virtual Scroll Instance ─────────────────────────────────────────────────

function createVirtualScrollInstance() {
    if (!_logContent || !_spacerTop || !_spacerBottom || !_container) return;
    const linesContainer = _container.querySelector('#log-lines-container');
    if (!(linesContainer instanceof HTMLElement)) return;

    _vs = createVirtualScroll({
        container: _logContent,
        spacerTop: _spacerTop,
        spacerBottom: _spacerBottom,
        linesContainer,
        itemCount: () => _filteredIndices.length,
        renderItem: (idx, fragment) => {
            const lineIdx = _filteredIndices[idx];
            if (lineIdx === undefined) return;
            const line = _allLines[lineIdx];
            if (line === undefined) return;

            const isDark = document.documentElement.classList.contains('dark');
            const levelColors = isDark ? LEVEL_COLORS_DARK : LEVEL_COLORS_LIGHT;
            const level = parseLogLevel(line);
            const color = levelColors[level] || (isDark ? '#a1a1aa' : '#71717a');

            const pre = document.createElement('pre');
            pre.className = 'log-line whitespace-pre-wrap break-all min-h-[1.4em]';
            pre.dataset.lineIdx = String(idx);
            pre.style.color = color;

            // Build inner HTML with level highlighting + optional search highlight
            let html = escapeHtml(line);

            // Highlight search matches
            const hasSearch = !!_searchQuery;
            if (hasSearch) {
                const searchEscaped = _searchQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const searchRe = new RegExp(`(${searchEscaped})`, 'gi');
                html = html.replace(searchRe, '<mark class="bg-accent/30 text-accent rounded px-0.5">$1</mark>');
            }

            // Highlight level tag with color (supports both [INFO] and level=info formats)
            html = html.replace(
                /(\[(?:DEBUG|INFO|WARN|WARNING|ERROR)\]|level=(?:debug|info|warn|warning|error))/gi,
                (match) => {
                    const m = match.match(/(?:DEBUG|INFO|WARN|WARNING|ERROR)/i);
                    if (!m) return match;
                    const key = m[0].toUpperCase() === 'WARNING' ? 'warn' : m[0].toLowerCase();
                    const c = levelColors[/** @type {keyof typeof levelColors} */ (key)] || color;
                    return `<span style="color:${c};font-weight:600">${match}</span>`;
                }
            );

            // eslint-disable-next-line no-unsanitized/property -- values escaped via escapeHtml in formatExtLogMessage
            pre.innerHTML = html;
            fragment.appendChild(pre);
        },
        dataAttr: 'data-line-idx',
        rowHeightEst: ROW_HEIGHT_EST,
        overscanPx: OVERSCAN_ROWS * ROW_HEIGHT_EST,
        scrollQuantumPx: SCROLL_QUANTUM * ROW_HEIGHT_EST,
        maxMounted: MAX_MOUNTED,
        onAutoScroll: () => {
            if (_autoScroll && _logContent) {
                _logContent.scrollTop = _logContent.scrollHeight;
            }
        },
        onScroll: onScroll,
    });
}

// ── Rendering ──────────────────────────────────────────────────────────────

function render() {
    if (_vs) _vs.scheduleRender();
}

function updateLineCount() {
    if (_lineCountEl) {
        _lineCountEl.textContent = `${_allLines.length} ${t('logLines')}`;
    }
}

function updateExtLineCount() {
    if (_lineCountEl) {
        _lineCountEl.textContent = `${getExtLogEvents().length} ${t('logLines')}`;
    }
}

// ── Extension Logs Rendering ────────────────────────────────────────────────

/** @type {Readonly<Record<string, string>>} 事件类型 → 颜色映射（覆盖全部 6 种 PrismEvent 类型） */
const EXT_EVENT_COLORS = Object.freeze({
    PatchApplied:   '#60a5fa',
    PatchFailed:    '#ef4444',
    ConfigReloaded: '#f59e0b',
    WatcherEvent:   '#a78bfa',
    WatcherStatus:  '#34d399',
    RulesChanged:   '#f472b6',
});

/**
 * 根据事件类型和 payload 生成富文本消息 HTML。
 * 对 6 种 PrismEvent 类型分别做特殊渲染：
 *   - WatcherStatus: 显示 "Watcher started/stopped, watching N files"
 *   - RulesChanged:   显示 "+N added, -M removed, ~K modified"
 *   - PatchApplied:   显示 patch_id + 统计（added/removed/modified/duration）
 *   - PatchFailed:    显示 patch_id + error
 *   - ConfigReloaded: 显示 success/fail + message
 *   - WatcherEvent:   显示 file + change_type
 *
 * @param {{ type: string, message: string, timestamp: string, source?: string }} entry
 * @returns {string} 安全的 HTML 片段
 */
function formatExtLogMessage(entry) {
    // Backend events: render with level-colored dot
    if (entry.source === 'backend') {
        /** @type {Record<string, string>} */
        const levelColor = {
            error: 'var(--color-red-400, #ef4444)',
            fatal: 'var(--color-red-400, #ef4444)',
            warn: 'var(--color-amber-400, #f59e0b)',
            info: 'var(--color-blue-400, #60a5fa)',
        };
        const color = levelColor[entry.type] || 'var(--color-gray-400, #a1a1aa)';
        return `<span style="color:${color}">&#9679;</span> ${escapeHtml(entry.message)}`;
    }

    // 尝试从 message 中解析出 JSON payload（后端可能将 payload 序列化在 message 字段中）
    let payload = null;
    try {
        // message 可能是 JSON 字符串，也可能是纯文本
        const parsed = JSON.parse(entry.message);
        if (parsed && typeof parsed === 'object') payload = parsed;
    } catch {
        // 不是 JSON，使用原始 message
    }

    switch (entry.type) {
        // ── WatcherStatus: Watcher 启停状态 ──
        case 'WatcherStatus': {
            if (payload) {
                const running = payload.running ?? payload.status === 'running';
                const fileCount = payload.file_count ?? payload.files ?? 0;
                const statusText = running ? 'started' : 'stopped';
                const icon = running
                    ? '<span style="color:#34d399">&#9679;</span>'
                    : '<span style="color:#ef4444">&#9679;</span>';
                return `${icon} Watcher ${statusText}, watching <b>${escapeHtml(String(fileCount))}</b> files`;
            }
            return escapeHtml(entry.message);
        }

        // ── RulesChanged: 规则变更统计 ──
        case 'RulesChanged': {
            if (payload) {
                const added = payload.added ?? payload.added_count ?? 0;
                const removed = payload.removed ?? payload.removed_count ?? 0;
                const modified = payload.modified ?? payload.modified_count ?? 0;
                const parts = [];
                if (added > 0) parts.push(`<span style="color:#34d399">+${added} added</span>`);
                if (removed > 0) parts.push(`<span style="color:#ef4444">-${removed} removed</span>`);
                if (modified > 0) parts.push(`<span style="color:#f59e0b">~${modified} modified</span>`);
                if (parts.length === 0) parts.push('<span style="color:#a1a1aa">no changes</span>');
                return parts.join(', ');
            }
            return escapeHtml(entry.message);
        }

        // ── PatchApplied: 补丁应用成功 ──
        case 'PatchApplied': {
            if (payload) {
                const patchId = payload.patch_id ?? payload.id ?? '';
                const added = payload.added ?? payload.added_count ?? 0;
                const removed = payload.removed ?? payload.removed_count ?? 0;
                const modified = payload.modified ?? payload.modified_count ?? 0;
                const duration = payload.duration ?? payload.elapsed ?? '';
                const durationStr = duration ? ` in ${escapeHtml(String(duration))}` : '';
                const parts = [];
                if (added > 0) parts.push(`<span style="color:#34d399">+${added}</span>`);
                if (removed > 0) parts.push(`<span style="color:#ef4444">-${removed}</span>`);
                if (modified > 0) parts.push(`<span style="color:#f59e0b">~${modified}</span>`);
                const statsStr = parts.length > 0 ? ` [${parts.join(' ')}]` : '';
                return `<b>${escapeHtml(String(patchId))}</b>${statsStr}${durationStr}`;
            }
            return escapeHtml(entry.message);
        }

        // ── PatchFailed: 补丁应用失败 ──
        case 'PatchFailed': {
            if (payload) {
                const patchId = payload.patch_id ?? payload.id ?? '';
                const error = payload.error ?? payload.message ?? entry.message;
                return `<b>${escapeHtml(String(patchId))}</b> — <span style="color:#ef4444">${escapeHtml(String(error))}</span>`;
            }
            return escapeHtml(entry.message);
        }

        // ── ConfigReloaded: 配置重载结果 ──
        case 'ConfigReloaded': {
            if (payload) {
                const success = payload.success ?? payload.ok ?? true;
                const msg = payload.message ?? payload.detail ?? '';
                const icon = success
                    ? '<span style="color:#34d399">&#10003;</span>'
                    : '<span style="color:#ef4444">&#10007;</span>';
                const label = success ? 'success' : 'failed';
                const msgStr = msg ? ` — ${escapeHtml(String(msg))}` : '';
                return `${icon} ${label}${msgStr}`;
            }
            return escapeHtml(entry.message);
        }

        // ── WatcherEvent: 文件变更事件 ──
        case 'WatcherEvent': {
            if (payload) {
                const file = payload.file ?? payload.path ?? '';
                const changeType = payload.change_type ?? payload.kind ?? payload.event ?? 'unknown';
                // 变更类型颜色映射
                /** @type {Record<string, string>} */
                const changeColors = {
                    create: '#34d399', created: '#34d399', add: '#34d399',
                    modify: '#f59e0b', modified: '#f59e0b', change: '#f59e0b',
                    remove: '#ef4444', removed: '#ef4444', delete: '#ef4444',
                };
                const ctColor = changeColors[String(changeType).toLowerCase()] || '#a78bfa';
                return `<span style="color:${ctColor}">${escapeHtml(String(changeType))}</span> <span class="font-mono">${escapeHtml(String(file))}</span>`;
            }
            return escapeHtml(entry.message);
        }

        // ── 未知类型：原始消息 ──
        default:
            return escapeHtml(entry.message);
    }
}

/**
 * 渲染单条扩展日志到 ext-log 列表。
* 支持 6 种 PrismEvent 类型的富文本渲染。
* @param {{ type: string, message: string, timestamp: string, source?: string }} entry
*/
function renderExtLogEntry(entry) {
    // When the page is not mounted, skip DOM rendering — the event is
    // already collected and will be batch-rendered on the next initLogsPage().
    const listEl = _container?.querySelector('#log-ext-list');
    if (!listEl) return;

    // Update line count first (before filtering) to keep total count consistent
    if (_extLogTabActive) updateExtLineCount();

    // Apply level filter (inclusive: selected level and above, same as core logs)
    if (_extLevelFilter !== 'all') {
        const minPriority = LEVEL_PRIORITY[_extLevelFilter];
        const type = entry.type.toLowerCase();
        const priority = LEVEL_PRIORITY[type];
        // Events without a log level (e.g. PrismEvent types) default to info priority
        if ((priority ?? 1) < minPriority) return;
    }

    // Apply search filter
    if (_extSearchQuery) {
        const query = _extSearchQuery.toLowerCase();
        if (!entry.message.toLowerCase().includes(query) &&
            !entry.type.toLowerCase().includes(query) &&
            !entry.timestamp.toLowerCase().includes(query)) {
            return;
        }
    }

    // Hide empty placeholder
    const emptyEl = _container?.querySelector('#log-ext-empty');
    if (emptyEl instanceof HTMLElement) emptyEl.style.display = 'none';

    listEl.appendChild(createExtLogRow(entry));

    // Auto scroll to bottom (respect _extAutoScroll)
    const extContent = _container?.querySelector('#log-ext-content');
    if (extContent && _extAutoScroll) {
        extContent.scrollTop = extContent.scrollHeight;
    }
}

/**
 * Create a DOM row element for an extension log entry.
 * Shared by both incremental `renderExtLogEntry` and batch `rebuildExtLogDOM`.
 * @param {{ type: string, message: string, timestamp: string, source?: string }} entry
 * @returns {HTMLDivElement}
 */
function createExtLogRow(entry) {
    const isDark = document.documentElement.classList.contains('dark');
    const levelColors = isDark ? LEVEL_COLORS_DARK : LEVEL_COLORS_LIGHT;
    const color = entry.source === 'backend'
        ? (levelColors[entry.type] || (isDark ? '#a1a1aa' : '#71717a'))
        : (EXT_EVENT_COLORS[entry.type] || '#a1a1aa');

    const row = document.createElement('div');
    row.className = 'flex items-start gap-3 py-1 border-b border-[var(--zephyr-border-subtle)] last:border-0';

    const ts = document.createElement('span');
    ts.className = 'text-[var(--text-tertiary)] shrink-0 select-none';
    ts.textContent = entry.timestamp;

    const badge = document.createElement('span');
    badge.className = 'shrink-0 px-1.5 py-0.5 rounded-sm text-2xs font-bold';
    badge.style.color = color;
    badge.style.backgroundColor = `${color}15`;
    badge.textContent = entry.source === 'backend'
        ? entry.type.toUpperCase()
        : entry.type;

    const msg = document.createElement('span');
    msg.className = 'text-[var(--text-secondary)] break-all';
    // eslint-disable-next-line no-unsanitized/property -- values escaped via escapeHtml in formatExtLogMessage
    msg.innerHTML = formatExtLogMessage(entry);

    row.appendChild(ts);
    row.appendChild(badge);
    row.appendChild(msg);
    return row;
}

/**
 * Rebuild the extension log list DOM from accumulated events.
 * Called on each `initLogsPage()` to restore previously collected events.
 * Uses a DocumentFragment for a single reflow, then scrolls to bottom.
 */
function rebuildExtLogDOM() {
    const listEl = _container?.querySelector('#log-ext-list');
    let events = getExtLogEvents();
    if (!listEl) return;

    // Apply level filter (inclusive: selected level and above, same as core logs)
    if (_extLevelFilter !== 'all') {
        const minPriority = LEVEL_PRIORITY[_extLevelFilter];
        events = events.filter(e => {
            const type = e.type.toLowerCase();
            const priority = LEVEL_PRIORITY[type];
            // Events without a log level (e.g. PrismEvent types) default to info priority
            return (priority ?? 1) >= minPriority;
        });
    }

    // Apply search filter
    if (_extSearchQuery) {
        const query = _extSearchQuery.toLowerCase();
        events = events.filter(e =>
            e.message.toLowerCase().includes(query) ||
            e.type.toLowerCase().includes(query) ||
            e.timestamp.toLowerCase().includes(query)
        );
    }

    // Clear existing content
     
    listEl.innerHTML = '';

    if (events.length === 0) {
        const emptyEl = _container?.querySelector('#log-ext-empty');
        if (emptyEl instanceof HTMLElement) emptyEl.style.display = 'flex';
        return;
    }

    const emptyEl2 = _container?.querySelector('#log-ext-empty');
    if (emptyEl2 instanceof HTMLElement) emptyEl2.style.display = 'none';

    const frag = document.createDocumentFragment();
    for (const entry of events) {
        frag.appendChild(createExtLogRow(entry));
    }
    listEl.appendChild(frag);

    // Update line count if on Extension tab
    if (_extLogTabActive) updateExtLineCount();

    // Scroll to bottom
    const extContent = _container?.querySelector('#log-ext-content');
    if (extContent) {
        extContent.scrollTop = extContent.scrollHeight;
    }
}
