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
import { createVirtualScroll } from '../utils/virtual-scroll.js';
import { renderLogLineHtml, parseCoreLogLine, renderStructuredLogHtml } from './log-highlight.js';
import { getExtLogEvents, subscribeToEvents, unsubscribeFromEvents } from '../modules/backend-events.js';
import { appLogLabel, formatAppLogMessage, appLogLevel } from './app-log-format.js';

/** @typedef {import('./app-log-format.js').AppLogEntry} AppLogEntry */

// ── Constants ──────────────────────────────────────────────────────────────

const MAX_LINES       = 2000;   // Ring buffer capacity
const POLL_INTERVAL   = 1000;   // Backend poll period (ms)
const DEBOUNCE_MS     = 150;    // Search input debounce (ms)
const OVERSCAN_ROWS   = 40;     // Virtual scroll overscan buffer
const SCROLL_QUANTUM  = 20;     // Scroll quantization bin size (rows)
const MAX_MOUNTED     = 300;    // Hard cap on simultaneously mounted DOM nodes
const ROW_HEIGHT_EST  = 22;     // Estimated row height in px (12px mono + padding)
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

// mihomo format: level=info / level=warn / level=error / level=debug / level=fatal
const LEVEL_RE = /(?:\[|\blevel=)(DEBUG|INFO|WARN|WARNING|ERROR|FATAL)(?:\]|\b)/i;

/** @type {Map<string, 'debug'|'info'|'warn'|'error'|'fatal'>} Bounded cache for log level parsing to avoid repeated regex execution during filtering and rendering. */
const _logLevelCache = new Map();
const MAX_LOG_LEVEL_CACHE = 4000;

/**
 * Extract log level from a line.
 * Supports both mihomo format (`level=info`) and bracket format (`[INFO]`).
 *
 * Performance optimization: Memoized via bounded _logLevelCache to skip repeated
 * LEVEL_RE regex execution during high-frequency poll updates and virtual scroll rendering.
 * @param {string} line
 * @returns {'debug'|'info'|'warn'|'error'|'fatal'}
 */
function parseLogLevel(line) {
    // Only short lines are cached: the cache is bounded by entry count, so
    // caching a line also has to bound its size (a 64 KiB line times 4,000
    // entries would be a quarter gigabyte). Long lines just parse directly.
    const cacheable = line.length <= 512;
    if (cacheable) {
        const cached = _logLevelCache.get(line);
        if (cached !== undefined) return cached;
    }

    /** @type {'debug'|'info'|'warn'|'error'|'fatal'} */
    let level = 'info';
    // Fast path: if the line lacks both '[' and '=', it cannot contain level indicators
    if (line.includes('[') || line.includes('=')) {
        const m = LEVEL_RE.exec(line);
        if (m) {
            const lvl = m[1].toUpperCase();
            level = lvl === 'WARNING' ? 'warn' : /** @type {'debug'|'info'|'warn'|'error'|'fatal'} */ (lvl.toLowerCase());
        }
    }

    if (cacheable) {
        if (_logLevelCache.size >= MAX_LOG_LEVEL_CACHE) {
            const firstKey = _logLevelCache.keys().next().value;
            if (firstKey !== undefined) _logLevelCache.delete(firstKey);
        }
        _logLevelCache.set(line, level);
    }
    return level;
}

// ── State ──────────────────────────────────────────────────────────────────

/** @type {number|null} */
let _pollTimer = null;
/** @type {number} */
let _offset = 0;
/** @type {boolean} */
let _autoScroll = true;
/** Reading paused by the user (Pause button); new lines wait in the core log. */
let _logsPaused = false;
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
/** Matching lines that arrived while the user was scrolled up (shown on the jump pill). */
let _newWhileAway = 0;
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
/** App events cleared from this page (the shared buffer keeps them for the console page). */
const _extClearedEvents = new WeakSet();
/** @type {string} Search query for app logs */
let _extSearchQuery = '';
/** @type {number|null} */
let _extDebounceTimer = null;
/** @type {boolean} Auto scroll for app logs */
let _extAutoScroll = true;

// Virtual scroll instance (shared module)
/** @type {ReturnType<typeof createVirtualScroll>|null} */
let _vs = null;

/** @type {((entry: AppLogEntry) => void) | null} */
let _extLogCb = null;

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Initialize the logs page. Called once when user navigates to logs.
 * Resets all state, builds DOM, kicks off polling.
 */
export async function initLogsPage() {
    _container = document.querySelector('[data-page="logs"]');
    if (!_container) return;

    // If already initialized, just reset and restart — keeping the tab, level and search
    // the user had chosen, so leaving the page and coming back does not lose the filter.
    if (_initialized) {
        resetState({ keepFilters: true });
        // eslint-disable-next-line no-unsanitized/property -- static HTML template from buildPageHTML()
        _container.innerHTML = buildPageHTML(); // nosemgrep: js-innerhtml-assignment — verified safe, see eslint-disable above
        cacheDOMRefs();
        bindEvents();
        restoreFilterUI();
        createVirtualScrollInstance();
        await fetchLogs();
        startPolling();
        return;
    }

    _initialized = true;
    resetState();
    // eslint-disable-next-line no-unsanitized/property -- static HTML template from buildPageHTML()
    _container.innerHTML = buildPageHTML(); // nosemgrep: js-innerhtml-assignment — verified safe, see eslint-disable above
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
    if (_debounceTimer) {
        clearTimeout(_debounceTimer);
        _debounceTimer = null;
    }
    if (_extDebounceTimer) {
        clearTimeout(_extDebounceTimer);
        _extDebounceTimer = null;
    }
    _vs?.destroy();
    _vs = null;
    if (_extLogCb) {
        unsubscribeFromEvents(_extLogCb);
        _extLogCb = null;
    }
}

// ── State Management ───────────────────────────────────────────────────────

/**
 * @param {{keepFilters?: boolean}} [opts] - keepFilters: keep tab / level / search (page re-entry)
 */
function resetState(opts = {}) {
    const keep = !!opts.keepFilters;
    stopPolling();
    _fetchGen++;
    _offset = 0;
    _allLines = [];
    _filteredIndices = [];
    _logLevelCache.clear();
    _autoScroll = true;
    _newWhileAway = 0;
    _logsPaused = false;
    if (!keep) {
        _levelFilter = 'all';
        _searchQuery = '';
        _extLogTabActive = false;
        _extLevelFilter = 'all';
        _extSearchQuery = '';
    }
    _lastRenderedFilterHash = -1;
    _vs?.destroy();
    _vs = null;
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
    const langKey = /** @type {'en'|'zh'|'ja'|'ko'|'ru'|'es'|'fa'|'tk'|'my'|'ar'|'ur'|'sw'|'tr'|'vi'} */ (currentLang);
    const dict = /** @type {Record<string, unknown>} */ (translations[langKey]) || /** @type {Record<string, unknown>} */ (translations.en);
    const val = dict[key];
    return typeof val === 'string' && val ? val : key;
}

function buildPageHTML() {
    return `
        <header class="flex items-center justify-between relative z-10 shrink-0">
            <div class="flex items-center gap-4">
                <h2 class="text-2xl font-light text-[var(--text-primary)]" data-i18n="logsTitle">${t('logsTitle')}</h2>
                <!-- Tab buttons -->
                <div class="seg-tabs" role="tablist">
                    <button id="log-tab-core" type="button" role="tab" aria-selected="true" class="log-tab-btn seg-tab active" data-i18n="logTabCore">${t('logTabCore')}</button>
                    <button id="log-tab-ext" type="button" role="tab" aria-selected="false" class="log-tab-btn seg-tab" data-i18n="ruleLibraryLogTab">${t('ruleLibraryLogTab')}</button>
                </div>
            </div>
            <div class="flex items-center gap-3">
                <!-- Pause / clear / export. Following the newest line is automatic: scrolling up
                     stops it and a "jump to latest" pill brings it back. -->
                <button id="log-pause-btn" type="button" class="btn-ghost" aria-pressed="false">
                    <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>
                    <span id="log-pause-text" data-i18n="pause">${t('pause')}</span>
                </button>
                <button id="log-clear-btn" type="button" class="btn-ghost">
                    <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/></svg>
                    <span data-i18n="logClear">${t('logClear')}</span>
                </button>
                <button id="log-export-open-btn" type="button" class="btn-ghost">
                    <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg>
                    <span data-i18n="logExportShort">${t('logExportShort')}</span>
                </button>
            </div>
        </header>

        <!-- Core Logs Panel -->
        <div id="log-panel-core" class="flex-1 min-h-0 flex flex-col gap-4 relative z-10">
            <!-- Filter bar -->
            <div class="flex items-center gap-2 flex-wrap relative z-10">
                <!-- "Debug" was identical to "All" (filter = level and above): four honest steps instead. -->
                <div class="seg-tabs" role="radiogroup" aria-label="${t('logLevelAll')}">
                    <button type="button" class="log-level-seg seg-tab active" data-level="all" data-i18n="logLevelAll">${t('logLevelAll')}</button>
                    <button type="button" class="log-level-seg seg-tab" data-level="info" data-i18n="logLevelInfoUp">${t('logLevelInfoUp')}</button>
                    <button type="button" class="log-level-seg seg-tab" data-level="warn" data-i18n="logLevelWarnUp">${t('logLevelWarnUp')}</button>
                    <button type="button" class="log-level-seg seg-tab" data-level="error" data-i18n="logLevelErrorOnly">${t('logLevelErrorOnly')}</button>
                </div>
                <span id="log-line-count" class="ms-2 text-xs text-[var(--text-muted)] tabular-nums">0 ${t('logLines')}</span>
                <div class="flex-1"></div>
                <!-- Search Box -->
                <div class="relative group flex items-center">
                    <div class="absolute inset-y-0 start-0 ps-4 flex items-center pointer-events-none">
                        <svg class="h-4 w-4 text-[var(--text-secondary)] group-focus-within:text-[var(--text-primary)] transition-colors duration-[var(--zephyr-time-standard)]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                        </svg>
                    </div>
                    <input id="log-search" type="text" placeholder="${t('searchLogs')}" data-i18n-placeholder="searchLogs" class="bg-[var(--zephyr-bg-muted)] border border-[var(--zephyr-border-default)] rounded-full h-8 py-0 px-5 ps-11 text-[var(--text-primary)] text-xs w-52 transition-all duration-[var(--zephyr-time-standard)] focus:outline-none focus:border-[var(--zephyr-border-strong)] focus:bg-[var(--zephyr-bg-input)] focus:w-72 placeholder:text-[var(--text-secondary)] shadow-inner">
                </div>
            </div>

            <!-- Virtual scroll container -->
            <div id="log-content" class="flex-1 min-h-0 overflow-y-auto glass-card log-pane px-4 py-3 font-mono text-xs leading-relaxed tabular-nums relative z-10 custom-scrollbar">
                <div id="log-spacer-top" style="height:0"></div>
                <div id="log-lines-container"></div>
                <div id="log-spacer-bottom" style="height:0"></div>
            </div>
            <button id="log-jump-latest" type="button" class="log-jump-latest hidden">
                <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><path d="M12 5v14M5 12l7 7 7-7"/></svg>
                <span data-i18n="logJumpLatest">${t('logJumpLatest')}</span>
                <span id="log-jump-new" class="hidden"></span>
            </button>
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
                <span id="log-ext-line-count" class="ms-2 text-xs text-[var(--text-muted)] tabular-nums">0 ${t('logLines')}</span>
                <div class="flex-1"></div>
                <!-- Search Box -->
                <div class="relative group flex items-center">
                    <div class="absolute inset-y-0 start-0 ps-4 flex items-center pointer-events-none">
                        <svg class="h-4 w-4 text-[var(--text-secondary)] group-focus-within:text-[var(--text-primary)] transition-colors duration-[var(--zephyr-time-standard)]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                        </svg>
                    </div>
                    <input id="log-ext-search" type="text" placeholder="${t('searchLogs')}" data-i18n-placeholder="searchLogs" class="bg-[var(--zephyr-bg-muted)] border border-[var(--zephyr-border-default)] rounded-full h-8 py-0 px-5 ps-11 text-[var(--text-primary)] text-xs w-52 transition-all duration-[var(--zephyr-time-standard)] focus:outline-none focus:border-[var(--zephyr-border-strong)] focus:bg-[var(--zephyr-bg-input)] focus:w-72 placeholder:text-[var(--text-secondary)] shadow-inner">
                </div>
            </div>
            <div id="log-ext-content" class="flex-1 min-h-0 overflow-y-auto glass-card log-pane px-4 py-3 font-mono text-xs leading-relaxed tabular-nums custom-scrollbar">
                <div id="log-ext-empty" class="empty-state font-sans text-[var(--text-muted)]">
                    <svg class="w-10 h-10 text-[var(--text-tertiary)] opacity-60" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
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
        tabCore?.setAttribute('aria-selected', 'true');
        tabExt?.setAttribute('aria-selected', 'false');
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
        tabExt?.setAttribute('aria-selected', 'true');
        tabCore?.setAttribute('aria-selected', 'false');
        panelExt?.classList.remove('hidden');
        panelExt?.classList.add('flex', 'flex-col', 'gap-4');
        panelCore?.classList.add('hidden');
        panelCore?.classList.remove('flex', 'flex-col', 'gap-4');
        updateExtLineCount();
        // Entries that arrived while hidden could not scroll it: catch up when following.
        const extEl = _container?.querySelector('#log-ext-content');
        if (extEl && _extAutoScroll) extEl.scrollTop = extEl.scrollHeight;
    };

    tabCore?.addEventListener('click', switchToCoreTab);
    tabExt?.addEventListener('click', switchToExtTab);

    // Subscribe to new events from global listener
    if (_extLogCb) {
        unsubscribeFromEvents(_extLogCb);
    }
    _extLogCb = (entry) => {
        renderExtLogEntry(entry);
    };
    subscribeToEvents(_extLogCb);

    // Rebuild ext-log DOM from accumulated events (if any)
    rebuildExtLogDOM();

    // Pause / resume reading
    const pauseBtn = _container?.querySelector('#log-pause-btn');
    pauseBtn?.addEventListener('click', () => {
        _logsPaused = !_logsPaused;
        pauseBtn.setAttribute('aria-pressed', String(_logsPaused));
        const label = _container?.querySelector('#log-pause-text');
        if (label instanceof HTMLElement) {
            label.dataset.i18n = _logsPaused ? 'resume' : 'pause';
            label.textContent = t(_logsPaused ? 'resume' : 'pause');
        }
        if (!_logsPaused) {
            void fetchLogs();
            // App events kept arriving in the buffer while paused: show them now.
            rebuildExtLogDOM();
        }
    });
    // Clear the view (the log file itself is untouched)
    _container?.querySelector('#log-clear-btn')?.addEventListener('click', () => {
        if (_extLogTabActive) {
            // Hide them here only: the shared buffer also feeds the console page.
            for (const ev of getExtLogEvents()) _extClearedEvents.add(ev);
            rebuildExtLogDOM();
            return;
        }
        // A read already in flight holds lines from before the clear: drop its lines.
        _clearGen++;
        _allLines = [];
        _logLevelCache.clear();
        _filteredIndices = [];
        _vs?.clearHeightCache();
        invalidateFilter();
        updateLineCount();
        resetNewLineCount();
        render();
    });
    // Export: the same dialog as in Settings
    _container?.querySelector('#log-export-open-btn')?.addEventListener('click', () => {
        document.getElementById('log-export-btn')?.click();
    });
    // Back to the newest line and keep following
    _container?.querySelector('#log-jump-latest')?.addEventListener('click', () => {
        _autoScroll = true;
        updateJumpPill();
        if (_logContent) _logContent.scrollTop = _logContent.scrollHeight;
        render();
    });

    // App logs follow new events only while scrolled to the bottom, like the core panel.
    const extContent = _container?.querySelector('#log-ext-content');
    extContent?.addEventListener('scroll', () => {
        const el = /** @type {HTMLElement} */ (extContent);
        _extAutoScroll = el.scrollHeight - el.scrollTop - el.clientHeight < STICKY_THRESHOLD;
    }, { passive: true });

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
    _container.querySelectorAll('#log-panel-core .log-level-seg').forEach(btn => {
        btn.addEventListener('click', () => {
            if (!_container) return;
            _container.querySelectorAll('#log-panel-core .log-level-seg').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            _levelFilter = /** @type {'all'|'debug'|'info'|'warn'|'error'} */ (/** @type {HTMLElement} */ (btn).dataset.level) || 'all';
            invalidateFilter();
            updateLineCount();
            resetNewLineCount();
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
            updateLineCount();
            resetNewLineCount();
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

/** Reflect the kept filter state in a freshly built page (re-entry). */
function restoreFilterUI() {
    if (!_container) return;
    _container.querySelectorAll('#log-panel-core .log-level-seg').forEach((b) => {
        b.classList.toggle('active', /** @type {HTMLElement} */ (b).dataset.level === _levelFilter);
    });
    _container.querySelectorAll('#log-panel-ext .log-level-btn').forEach((b) => {
        b.classList.toggle('active', /** @type {HTMLElement} */ (b).dataset.level === _extLevelFilter);
    });
    const search = /** @type {HTMLInputElement|null} */ (_container.querySelector('#log-search'));
    if (search) search.value = _searchQuery;
    const extSearch = /** @type {HTMLInputElement|null} */ (_container.querySelector('#log-ext-search'));
    if (extSearch) extSearch.value = _extSearchQuery;
    if (_extLogTabActive) {
        /** @type {HTMLElement|null} */ (_container.querySelector('#log-tab-ext'))?.click();
    }
    rebuildExtLogDOM();
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
    } else if (atBottom && !_autoScroll) {
        _autoScroll = true;
    }
    updateJumpPill();
}

/** The count was taken under the old filter; it no longer describes what is shown. */
function resetNewLineCount() {
    _newWhileAway = 0;
    updateJumpPill();
}

/** Show the jump pill while scrolled up, with the count of lines that arrived meanwhile. */
function updateJumpPill() {
    if (_autoScroll) _newWhileAway = 0;
    _container?.querySelector('#log-jump-latest')?.classList.toggle('hidden', _autoScroll);
    const extra = _container?.querySelector('#log-jump-new');
    if (extra instanceof HTMLElement) {
        extra.classList.toggle('hidden', _newWhileAway === 0);
        extra.textContent = _newWhileAway > 0
            ? `· ${t('logNewLines').replace('{count}', String(_newWhileAway))}`
            : '';
    }
}

// ── Data Fetching ──────────────────────────────────────────────────────────

/** Bumped by resetState(); results of reads started before a reset are dropped. */
let _fetchGen = 0;
/** Generation of the read currently in flight, or -1 when idle. */
let _inFlightGen = -1;
/** Bumped by Clear: a read that was in flight keeps its offset but not its lines. */
let _clearGen = 0;

async function fetchLogs() {
    if (_logsPaused) return;
    // setInterval keeps firing while a slow read is pending; skip the tick
    // instead of stacking concurrent reads that would append out of order.
    const gen = _fetchGen;
    if (_inFlightGen === gen) return;
    _inFlightGen = gen;
    const clearGen = _clearGen;
    try {
        const result = await readCoreLog(_offset, 500);
        // The page was reset while this read was pending: its offset and
        // lines belong to the old state.
        if (gen !== _fetchGen) return;
        // Paused while the read was pending: keep the offset, read it again on resume.
        if (_logsPaused) return;
        if (!result || result.lines.length === 0) return;

        // Detect log rotation via backend signal or offset regression
        if (result.rotated || result.next_offset < _offset) {
            _offset = 0;
            _allLines = [];
            _logLevelCache.clear();
            _vs?.clearHeightCache();
            // invalidateFilter() will rebuild indices and call _vs.invalidate()
            invalidateFilter();
        } else {
            _offset = result.next_offset;
        }
        // Cleared while this read was pending: these lines are from before the clear.
        if (clearGen !== _clearGen) return;

        // Append new lines
        _allLines.push(...result.lines);
        if (!_autoScroll) {
            const lowerQuery = _searchQuery ? _searchQuery.toLowerCase() : '';
            _newWhileAway += result.lines.filter((l) => lineMatchesFilter(l, lowerQuery)).length;
            updateJumpPill();
        }

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
    } finally {
        if (_inFlightGen === gen) _inFlightGen = -1;
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

    const lowerQuery = _searchQuery ? _searchQuery.toLowerCase() : '';
    _filteredIndices = [];
    for (let i = 0; i < _allLines.length; i++) {
        if (lineMatchesFilter(_allLines[i], lowerQuery)) _filteredIndices.push(i);
    }
}

/**
 * Whether a line passes the level filter (selected level and above) and the search.
 * @param {string} line
 * @param {string} [lowerQuery] - Pre-lowercased search query to avoid repeated string allocation in loop
 */
function lineMatchesFilter(line, lowerQuery = _searchQuery.toLowerCase()) {
    if (_levelFilter !== 'all' && LEVEL_PRIORITY[parseLogLevel(line)] < LEVEL_PRIORITY[_levelFilter]) return false;
    return !lowerQuery || line.toLowerCase().includes(lowerQuery);
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

            const parsed = parseCoreLogLine(line);
            if (parsed) {
                // Structured row: local time / level badge / message; warn+error rows get a tint.
                const row = document.createElement('div');
                row.className = 'log-line log-row';
                row.dataset.lineIdx = String(idx);
                row.dataset.level = parsed.level;
                // eslint-disable-next-line no-unsanitized/property -- every text segment escaped via escapeHtml() in renderStructuredLogHtml()
                row.innerHTML = renderStructuredLogHtml(parsed, _searchQuery); // nosemgrep: js-innerhtml-assignment
                fragment.appendChild(row);
                return;
            }

            const isDark = document.documentElement.classList.contains('dark');
            const levelColors = isDark ? LEVEL_COLORS_DARK : LEVEL_COLORS_LIGHT;
            const level = parseLogLevel(line);
            const color = levelColors[level] || (isDark ? '#a1a1aa' : '#71717a');

            const pre = document.createElement('pre');
            pre.className = 'log-line log-raw whitespace-pre-wrap min-h-[1.4em]';
            pre.dataset.lineIdx = String(idx);
            pre.style.color = color;

            // Build inner HTML with level highlighting + optional search highlight.
            // Matching runs on the raw line; each segment is escaped separately.
            const html = renderLogLineHtml(line, _searchQuery, levelColors, color);

            // eslint-disable-next-line no-unsanitized/property -- every text segment escaped via escapeHtml() in renderLogLineHtml() // nosemgrep: js-innerhtml-assignment
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
        // While filtering, show how many of the lines are visible ("22 / 80 lines").
        // _filteredIndices is kept current by invalidateFilter() before every call.
        const filtering = _levelFilter !== 'all' || !!_searchQuery;
        _lineCountEl.textContent = filtering
            ? t('logShownOf').replace('{shown}', String(_filteredIndices.length)).replace('{total}', String(_allLines.length))
            : `${_allLines.length} ${t('logLines')}`;
    }
}

/** App events not cleared from this page. */
function visibleExtEvents() {
    return getExtLogEvents().filter((ev) => !_extClearedEvents.has(ev));
}

/**
 * The app events the level and search filters let through.
 * @param {AppLogEntry[]} events
 */
function filterExtEvents(events) {
    let out = events;
    if (_extLevelFilter !== 'all') {
        const minPriority = LEVEL_PRIORITY[_extLevelFilter];
        // Prism events have no level of their own: failures count as errors.
        out = out.filter(e => LEVEL_PRIORITY[appLogLevel(e)] >= minPriority);
    }
    if (_extSearchQuery) {
        const query = _extSearchQuery.toLowerCase();
        out = out.filter(e => extEntryMatches(e, query));
    }
    return out;
}

function updateExtLineCount() {
    const el = _container?.querySelector('#log-ext-line-count');
    if (!el) return;
    const all = visibleExtEvents();
    // While filtering, show how many are visible ("22 / 80 lines"), as the core panel does.
    el.textContent = (_extLevelFilter !== 'all' || !!_extSearchQuery)
        ? t('logShownOf').replace('{shown}', String(filterExtEvents(all).length)).replace('{total}', String(all.length))
        : `${all.length} ${t('logLines')}`;
}

// ── Extension Logs Rendering ────────────────────────────────────────────────

/** @type {Readonly<Record<string, string>>} 事件类型 → 颜色映射（覆盖全部 6 种 PrismEvent 类型） */
const EXT_EVENT_COLORS = Object.freeze({
    PatchApplied:   '#60a5fa',
    PatchFailed:    '#ef4444',
    ConfigReloaded: '#f59e0b',
    WatcherEvent:   '#22d3ee',
    WatcherStatus:  '#34d399',
    RulesChanged:   '#f472b6',
});

/** Current translation table (for the app-log formatter). */
function dict() {
    const langKey = /** @type {'en'|'zh'} */ (currentLang);
    return /** @type {Record<string, string>} */ (/** @type {any} */ (translations)[langKey] || translations.en);
}

/**
 * Whether an app-log entry matches the search query (localized text, raw message, type, time).
 * @param {AppLogEntry} entry
 * @param {string} query - lower-case
 */
function extEntryMatches(entry, query) {
    const tr = dict();
    return formatAppLogMessage(entry, tr).text.toLowerCase().includes(query)
        || entry.message.toLowerCase().includes(query)
        || appLogLabel(entry, tr).toLowerCase().includes(query)
        || entry.type.toLowerCase().includes(query)
        || entry.timestamp.toLowerCase().includes(query);
}

/**
 * 渲染单条扩展日志到 ext-log 列表。
* 支持 6 种 PrismEvent 类型的富文本渲染。
* @param {AppLogEntry} entry
*/
function renderExtLogEntry(entry) {
    // When the page is not mounted, skip DOM rendering — the event is
    // already collected and will be batch-rendered on the next initLogsPage().
    const listEl = _container?.querySelector('#log-ext-list');
    if (!listEl) return;
    // Update line count first (before pausing and filtering): while paused the
    // count still shows that events are waiting.
    if (_extLogTabActive) updateExtLineCount();

    // Paused: the entry stays in the buffer and is drawn on resume.
    if (_logsPaused) return;

    // Apply level filter (inclusive: selected level and above, same as core logs)
    if (_extLevelFilter !== 'all') {
        const minPriority = LEVEL_PRIORITY[_extLevelFilter];
        // Prism events have no level of their own: failures count as errors.
        if (LEVEL_PRIORITY[appLogLevel(entry)] < minPriority) return;
    }

    // Apply search filter
    if (_extSearchQuery && !extEntryMatches(entry, _extSearchQuery.toLowerCase())) return;

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
 * @param {AppLogEntry} entry
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
    badge.textContent = appLogLabel(entry, dict());

    const msg = document.createElement('span');
    msg.className = 'text-[var(--text-secondary)] [overflow-wrap:anywhere] min-w-0';
    // eslint-disable-next-line no-unsanitized/property -- values escaped via escapeHtml in formatAppLogMessage
    msg.innerHTML = formatAppLogMessage(entry, dict()).html; // nosemgrep: js-innerhtml-assignment — verified safe, see eslint-disable above

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
    if (!listEl) return;
    // Level (inclusive: selected level and above, same as core logs) and search filters
    const events = filterExtEvents(visibleExtEvents());

    // Clear existing content

    listEl.replaceChildren();

    if (events.length === 0) {
        const emptyEl = _container?.querySelector('#log-ext-empty');
        if (emptyEl instanceof HTMLElement) emptyEl.style.display = 'flex';
        if (_extLogTabActive) updateExtLineCount();
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

    // Scroll to bottom, unless the reader has scrolled up
    const extContent = _container?.querySelector('#log-ext-content');
    if (extContent && _extAutoScroll) {
        extContent.scrollTop = extContent.scrollHeight;
    }
}
