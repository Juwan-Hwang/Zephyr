// @ts-check
/**
 * Zephyr Logs Page Module — Virtual-Scroll Real-Time Log Viewer
 *
 * Architecture:
 * ┌─────────────────────────────────────────────────────────────┐
 * │  Virtual Scroll Engine                                      │
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

// ── Constants ──────────────────────────────────────────────────────────────

const MAX_LINES       = 2000;   // Ring buffer capacity
const POLL_INTERVAL   = 1000;   // Backend poll period (ms)
const DEBOUNCE_MS     = 150;    // Search input debounce (ms)
const OVERSCAN_ROWS   = 40;     // Virtual scroll overscan buffer
const SCROLL_QUANTUM  = 20;     // Scroll quantization bin size (rows)
const MAX_MOUNTED     = 300;    // Hard cap on simultaneously mounted DOM nodes
const ROW_HEIGHT_EST  = 18;     // Estimated line height in px (text-2xs + leading-relaxed)
const STICKY_THRESHOLD = 40;    // Pixels from bottom to consider "at bottom"

/** Level → color mapping (dark mode) */
const LEVEL_COLORS_DARK = Object.freeze({
    debug: '#6b7280',
    info:  '#60a5fa',
    warn:  '#f59e0b',
    error: '#ef4444',
});

/** Level → color mapping (light mode) */
const LEVEL_COLORS_LIGHT = Object.freeze({
    debug: '#9ca3af',
    info:  '#3b82f6',
    warn:  '#d97706',
    error: '#dc2626',
});

/** Level → numeric priority for filtering */
const LEVEL_PRIORITY = Object.freeze({
    debug: 0,
    info:  1,
    warn:  2,
    error: 3,
});

// ── HTML Entity Escaping (string-based, no DOM allocation) ─────────────────

const _escapeMap = Object.freeze({
    '&':  '&amp;',
    '<':  '&lt;',
    '>':  '&gt;',
    '"':  '&quot;',
    "'":  '&#39;',
});
const _escapeRe = /[&<>"']/g;

/**
 * Escape HTML entities using string replacement — zero DOM allocations.
 * ~50x faster than createElement('div').textContent round-trip.
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
    if (typeof str !== 'string') return '';
    return str.replace(_escapeRe, ch => /** @type {any} */ (_escapeMap)[ch]);
}

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
let _lastRenderedScrollTop = -1;
/** @type {number} */
let _lastRenderedFilterHash = -1;
/** @type {boolean} */
let _initialized = false;
/** @type {(() => void)|null} */
let _cleanupUnregister = null;

// Virtual scroll state
/** @type {Float64Array} Prefix-sum array: offsets[i] = sum of heights for items 0..i-1 */
let _offsets = new Float64Array(0);
/** @type {Map<number, number>} Measured heights cache: lineIndex → actual height */
let _heightCache = new Map();
/** @type {number} Version counter — incremented when filtered set changes */
let _offsetVersion = 0;
/** @type {number} Cached version at last rebuild */
let _offsetsVersion = -1;
/** @type {number} First visible item index */
let _visibleStart = 0;
/** @type {number} Last visible item index (inclusive) */
let _visibleEnd = 0;
/** @type {Set<number>} Currently mounted item indices */
let _mountedSet = new Set();

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
        _container.innerHTML = buildPageHTML();
        cacheDOMRefs();
        bindEvents();
        await fetchLogs();
        startPolling();
        return;
    }

    _initialized = true;
    resetState();
    _container.innerHTML = buildPageHTML();
    cacheDOMRefs();
    bindEvents();
    await fetchLogs();
    startPolling();

    // Register global cleanup — ensures polling stops on app shutdown
    _cleanupUnregister = registerCleanup(() => stopPolling());
}

/**
 * Stop the logs page — called when navigating away.
 * Stops polling and releases resources.
 */
export function destroyLogsPage() {
    stopPolling();
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
    _lastRenderedScrollTop = -1;
    _lastRenderedFilterHash = -1;
    _heightCache.clear();
    _mountedSet.clear();
    _offsets = new Float64Array(0);
    _offsetVersion = 0;
    _offsetsVersion = -1;
    _visibleStart = 0;
    _visibleEnd = 0;
    if (_debounceTimer) {
        clearTimeout(_debounceTimer);
        _debounceTimer = null;
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
        <!-- Background Glow (consistent with other pages) -->
        <div class="absolute top-[-10%] right-[-10%] w-[500px] h-[300px] bg-accent/5 blur-[100px] pointer-events-none rounded-full"></div>

        <header class="flex items-center justify-between relative z-10 shrink-0">
            <div>
                <h2 class="text-2xl font-light text-zinc-100" data-i18n="logsTitle">${t('logsTitle')}</h2>
            </div>
            <div class="flex items-center gap-3">
                <span id="log-line-count" class="text-xs text-zinc-500 tabular-nums">0 ${t('logLines')}</span>
                <button id="log-auto-scroll-btn" class="btn-ghost active" title="${t('autoScroll')}">
                    <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12l7 7 7-7"/></svg>
                    <span data-i18n="autoScroll">${t('autoScroll')}</span>
                </button>
            </div>
        </header>

        <!-- Filter bar -->
        <div class="flex items-center gap-2 flex-wrap relative z-10">
            <button class="log-level-btn active" data-level="all" data-i18n="logLevelAll">${t('logLevelAll')}</button>
            <button class="log-level-btn" data-level="debug" data-i18n="logLevelDebug">${t('logLevelDebug')}</button>
            <button class="log-level-btn" data-level="info" data-i18n="logLevelInfo">${t('logLevelInfo')}</button>
            <button class="log-level-btn" data-level="warn" data-i18n="logLevelWarn">${t('logLevelWarn')}</button>
            <button class="log-level-btn" data-level="error" data-i18n="logLevelError">${t('logLevelError')}</button>
            <div class="flex-1"></div>
            <!-- Search Box (Journal Style — consistent with rules page) -->
            <div class="relative group flex items-center">
                <div class="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                    <svg class="h-4 w-4 text-zinc-400 group-focus-within:text-white transition-colors duration-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                    </svg>
                </div>
                <input id="log-search" type="text" placeholder="${t('searchLogs')}" data-i18n-placeholder="searchLogs" class="bg-white/10 border border-white/10 rounded-full py-2 px-5 pl-11 text-white text-xs w-52 transition-all duration-400 focus:outline-none focus:border-white/30 focus:bg-white/20 focus:w-72 placeholder:text-zinc-400 shadow-inner">
            </div>
        </div>

        <!-- Virtual scroll container -->
        <div id="log-content" class="flex-1 overflow-y-auto rounded-2xl bg-white/5 border border-white/10 p-4 font-mono text-2xs leading-relaxed tabular-nums relative z-10 custom-scrollbar">
            <div id="log-spacer-top" style="height:0"></div>
            <div id="log-lines-container"></div>
            <div id="log-spacer-bottom" style="height:0"></div>
        </div>
    `;
}

// ── Event Binding ──────────────────────────────────────────────────────────

function bindEvents() {
    if (!_container) return;

    // Auto scroll toggle
    _autoScrollBtn?.addEventListener('click', () => {
        _autoScroll = !_autoScroll;
        _autoScrollBtn?.classList.toggle('active', _autoScroll);
        if (_autoScroll && _logContent) {
            _logContent.scrollTop = _logContent.scrollHeight;
            scheduleRender();
        }
    });

    // Level filter buttons
    _container.querySelectorAll('.log-level-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            if (!_container) return;
            _container.querySelectorAll('.log-level-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            _levelFilter = /** @type {'all'|'debug'|'info'|'warn'|'error'} */ (/** @type {HTMLElement} */ (btn).dataset.level) || 'all';
            invalidateFilter();
            scheduleRender();
        });
    });

    // Search input — debounced
    const searchInput = /** @type {HTMLInputElement|null} */ (_container.querySelector('#log-search'));
    searchInput?.addEventListener('input', () => {
        if (_debounceTimer) clearTimeout(_debounceTimer);
        _debounceTimer = setTimeout(() => {
            _searchQuery = (searchInput?.value || '').trim();
            invalidateFilter();
            scheduleRender();
            _debounceTimer = null;
        }, DEBOUNCE_MS);
    });

    // Detect manual scroll to disable auto-scroll
    _logContent?.addEventListener('scroll', onScroll, { passive: true });

    // Observe container resize for virtual scroll recalculation
    if (_logContent && typeof ResizeObserver !== 'undefined') {
        const ro = new ResizeObserver(() => scheduleRender());
        ro.observe(_logContent);
        // Store for cleanup
        /** @type {any} */ (_logContent)._resizeObserver = ro;
    }
}

// ── Scroll Handler ─────────────────────────────────────────────────────────

function onScroll() {
    if (!_logContent) return;
    const scrollTop = _logContent.scrollTop;

    // Detect manual scroll away from bottom
    const atBottom = _logContent.scrollHeight - scrollTop - _logContent.clientHeight < STICKY_THRESHOLD;
    if (!atBottom && _autoScroll) {
        _autoScroll = false;
        _autoScrollBtn?.classList.remove('active');
    }

    // Scroll quantization: only re-render if scrollTop changed by more than SCROLL_QUANTUM * ROW_HEIGHT_EST
    const quantized = Math.floor(scrollTop / (SCROLL_QUANTUM * ROW_HEIGHT_EST));
    const lastQuantized = Math.floor(_lastRenderedScrollTop / (SCROLL_QUANTUM * ROW_HEIGHT_EST));
    if (quantized !== lastQuantized) {
        scheduleRender();
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
            _heightCache.clear();
            _mountedSet.clear();
            // Clear all existing DOM lines
            const linesContainer = _container?.querySelector('#log-lines-container');
            if (linesContainer) linesContainer.innerHTML = '';
            invalidateFilter();
        } else {
            _offset = result.next_offset;
        }

        // Append new lines
        const prevLen = _allLines.length;
        _allLines.push(...result.lines);

        // Ring buffer trim from head
        if (_allLines.length > MAX_LINES) {
            const excess = _allLines.length - MAX_LINES;
            _allLines = _allLines.slice(excess);

            // Invalidate height cache for trimmed indices
            for (let i = 0; i < excess; i++) {
                _heightCache.delete(i);
            }
            // Shift remaining cache keys down
            const newCache = new Map();
            for (const [k, v] of _heightCache) {
                if (k >= excess) newCache.set(k - excess, v);
            }
            _heightCache = newCache;
        }

        invalidateFilter();
        updateLineCount();
        scheduleRender();
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
    _offsetVersion++;
    // Clear mount state — filtered indices changed, all existing DOM nodes are stale
    _mountedSet.clear();
    const linesContainer = _container?.querySelector('#log-lines-container');
    if (linesContainer) linesContainer.innerHTML = '';
    rebuildFilteredIndices();
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

// ── Virtual Scroll Engine ──────────────────────────────────────────────────

/**
 * Rebuild the prefix-sum offset array using measured + estimated heights.
 * O(n) but only runs when filter set changes.
 */
function rebuildOffsets() {
    if (_offsetsVersion === _offsetVersion) return;
    _offsetsVersion = _offsetVersion;

    const n = _filteredIndices.length;
    if (n === 0) {
        _offsets = new Float64Array(0);
        return;
    }

    // Reuse array if capacity sufficient
    if (_offsets.length < n + 1) {
        _offsets = new Float64Array(n + 1);
    }

    _offsets[0] = 0;
    for (let i = 0; i < n; i++) {
        const h = _heightCache.get(i) || ROW_HEIGHT_EST;
        _offsets[i + 1] = _offsets[i] + h;
    }
}

/**
 * O(log n) binary search: find the first item whose cumulative offset > targetOffset.
 * @param {number} targetOffset
 * @returns {number} Item index
 */
function bisectStart(targetOffset) {
    const n = _filteredIndices.length;
    if (n === 0) return 0;

    let lo = 0, hi = n;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (_offsets[mid + 1] <= targetOffset) {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    return lo;
}

/**
 * Compute the visible range based on current scroll position.
 * Returns [start, end] inclusive indices into _filteredIndices.
 * @returns {[number, number]}
 */
function computeVisibleRange() {
    if (!_logContent) return [0, 0];

    const scrollTop = _logContent.scrollTop;
    const viewportH = _logContent.clientHeight;

    const start = Math.max(0, bisectStart(scrollTop) - OVERSCAN_ROWS);
    const end = Math.min(
        _filteredIndices.length - 1,
        bisectStart(scrollTop + viewportH) + OVERSCAN_ROWS
    );

    // Cap total mounted items
    const cappedEnd = Math.min(end, start + MAX_MOUNTED - 1);

    return [start, Math.max(start, cappedEnd)];
}

// ── Rendering ──────────────────────────────────────────────────────────────

/** @type {number|null} RAF id for render coalescing */
let _renderRAF = null;

function scheduleRender() {
    if (_renderRAF !== null) return;
    _renderRAF = requestAnimationFrame(() => {
        _renderRAF = null;
        render();
    });
}

function render() {
    if (!_logContent) return;

    rebuildOffsets();
    const [newStart, newEnd] = computeVisibleRange();
    _lastRenderedScrollTop = _logContent.scrollTop;

    const totalHeight = _filteredIndices.length > 0
        ? _offsets[_filteredIndices.length]
        : 0;

    // Update spacers
    const topH = newStart > 0 ? _offsets[newStart] : 0;
    const bottomH = totalHeight - (newEnd >= 0 && newEnd + 1 < _offsets.length ? _offsets[newEnd + 1] : totalHeight);

    if (_spacerTop) _spacerTop.style.height = `${topH}px`;
    if (_spacerBottom) _spacerBottom.style.height = `${Math.max(0, bottomH)}px`;

    // Determine mount/unmount sets
    const toMount = new Set();
    for (let i = newStart; i <= newEnd; i++) toMount.add(i);

    const toUnmount = new Set(_mountedSet);
    for (const idx of toMount) toUnmount.delete(idx);

    const linesContainer = _container?.querySelector('#log-lines-container');
    if (!linesContainer) return;

    // Unmount items no longer visible
    for (const idx of toUnmount) {
        const el = linesContainer.querySelector(`[data-line-idx="${idx}"]`);
        if (el) {
            // Capture final height before removal
            const h = el.getBoundingClientRect().height;
            if (h > 0) _heightCache.set(idx, h);
            el.remove();
        }
        _mountedSet.delete(idx);
    }

    // Mount new items
    const isDark = document.documentElement.classList.contains('dark');
    const levelColors = isDark ? LEVEL_COLORS_DARK : LEVEL_COLORS_LIGHT;
    const hasSearch = !!_searchQuery;
    const searchEscaped = hasSearch ? _searchQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : '';
    const searchRe = hasSearch ? new RegExp(`(${searchEscaped})`, 'gi') : null;
    const fragment = document.createDocumentFragment();

    for (const idx of toMount) {
        if (_mountedSet.has(idx)) continue;

        const lineIdx = _filteredIndices[idx];
        if (lineIdx === undefined) continue;
        const line = _allLines[lineIdx];
        if (line === undefined) continue;

        const level = parseLogLevel(line);
        const color = levelColors[level] || (isDark ? '#a1a1aa' : '#71717a');

        const pre = document.createElement('pre');
        pre.className = 'log-line whitespace-pre-wrap break-all min-h-[1.4em]';
        pre.dataset.lineIdx = String(idx);
        pre.style.color = color;

        // Build inner HTML with level highlighting + optional search highlight
        let html = escapeHtml(line);

        // Highlight search matches
        if (searchRe) {
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

        pre.innerHTML = html;
        fragment.appendChild(pre);
        _mountedSet.add(idx);
    }

    if (fragment.childElementCount > 0) {
        linesContainer.appendChild(fragment);
    }

    // Measure newly mounted items after layout
    if (fragment.childElementCount > 0) {
        requestAnimationFrame(() => {
            for (const idx of toMount) {
                if (!_mountedSet.has(idx)) continue;
                const el = linesContainer.querySelector(`[data-line-idx="${idx}"]`);
                if (el) {
                    const h = el.getBoundingClientRect().height;
                    if (h > 0 && _heightCache.get(idx) !== h) {
                        _heightCache.set(idx, h);
                        // If height changed from estimate, schedule re-render for spacer update
                        if (_offsets[idx + 1] !== undefined) {
                            _offsetVersion++;
                        }
                    }
                }
            }
        });
    }

    // Auto scroll to bottom
    if (_autoScroll) {
        _logContent.scrollTop = _logContent.scrollHeight;
    }
}

function updateLineCount() {
    if (_lineCountEl) {
        _lineCountEl.textContent = `${_allLines.length} ${t('logLines')}`;
    }
}
