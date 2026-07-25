// @ts-check
// ═══════════════════════════════════════════════════════════════════════════════
//  backend-events.js — Global Backend Event Listener
// ═══════════════════════════════════════════════════════════════════════════════
//  Registers backend-event and prism-event listeners at app startup.
//  Events are accumulated in _extLogEvents for the logs page to render.
//  Fatal/Error events trigger immediate Toast notifications.
// ═══════════════════════════════════════════════════════════════════════════════

import { listen } from '../api.js';
import { showNotification } from '../ui/notifications.js';

// ── State ─────────────────────────────────────────────────────────────────────

/** @type {Array<{ type: string, message: string, timestamp: string, source?: string }>} */
let _extLogEvents = [];

/** @type {Set<string>} */
const _recentErrors = new Set();

/** @type {(() => void) | null} */
let _prismEventUnlisten = null;

/** @type {(() => void) | null} */
let _backendEventUnlisten = null;

/** @type {((entry: { type: string, message: string, timestamp: string, source?: string }) => void) | null} */
let _onNewEvent = null;

// ── Internal Helpers ─────────────────────────────────────────────────────────

/**
 * Format a timestamp for log display.
 * Uses the provided epoch-ms timestamp, or falls back to current time.
 * @param {number} [timestampMs]
 * @returns {string}
 */
function _formatTimestamp(timestampMs) {
    return (timestampMs && timestampMs > 0)
        ? new Date(timestampMs).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
        : new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/**
 * Push an event into the accumulated buffer and notify the logs page subscriber.
 * Shared by both the backend-event and prism-event handlers.
 * @param {{ type: string, message: string, timestamp: string, source?: string }} entry
 */
function _pushEvent(entry) {
    _extLogEvents.push(entry);
    if (_extLogEvents.length > 500) {
        _extLogEvents = _extLogEvents.slice(-500);
    }
    _onNewEvent?.(entry);
}

// ── Event Handlers ───────────────────────────────────────────────────────────

/** PrismEvent variant names for tagged-enum payload detection. */
const PRISM_VARIANTS = ['ConfigReloaded', 'PatchFailed', 'PatchApplied', 'WatcherEvent', 'WatcherStatus', 'RulesChanged'];

/**
 * Normalize a PrismEvent payload into { type, data }.
 * Handles both flattened and tagged-enum formats.
 * @param {any} payload
 * @returns {{ type: string, data: any }}
 */
function _normalizePrismPayload(payload) {
    if (payload.type && typeof payload.type === 'string') {
        // Flattened format: { "type": "ConfigReloaded", ... }
        return { type: payload.type, data: payload };
    }
    // Tagged enum format: { "ConfigReloaded": { ... } }
    for (const v of PRISM_VARIANTS) {
        if (payload[v] !== undefined) {
            return { type: v, data: payload[v] };
        }
    }
    return { type: 'Unknown', data: payload };
}

/**
 * Extract added/removed/modified counts from a PrismEvent data object.
 * @param {any} data
 * @returns {{ added: number, removed: number, modified: number }}
 */
function _extractChanges(data) {
    return {
        added: data.added || data.added_count || 0,
        removed: data.removed || data.removed_count || 0,
        modified: data.modified || data.modified_count || 0,
    };
}

/**
 * Format added/removed/modified stat parts from a PrismEvent data object.
 * @param {any} data
 * @param {boolean} [labels=false] - when true, include descriptive labels
 *   (e.g. `+3 added` instead of `+3`).
 * @returns {string[]}
 */
function _formatStatParts(data, labels = false) {
    const { added, removed, modified } = _extractChanges(data);
    const parts = [];
    if (added) parts.push(labels ? `+${added} added` : `+${added}`);
    if (removed) parts.push(labels ? `-${removed} removed` : `-${removed}`);
    if (modified) parts.push(labels ? `~${modified} modified` : `~${modified}`);
    return parts;
}

/**
 * Type-to-formatter map for PrismEvent types.
 * Each formatter receives the `data` object and returns a display string.
 * @type {Record<string, (data: any) => string>}
 */
const PRISM_FORMATTERS = {
    WatcherStatus: (d) => (d.running ? `Watching ${d.watching_count} dir(s)` : 'Watch stopped'),

    PatchApplied: (d) => {
        const stats = _formatStatParts(d);
        const pid = d.patch_id || d.id || '';
        const statsStr = stats.length ? ` [${stats.join(' ')}]` : '';
        const elapsed = d.duration || d.elapsed;
        const dur = elapsed ? ` in ${elapsed}` : '';
        return `${pid}${statsStr}${dur}`.trim() || 'patch applied';
    },

    RulesChanged: (d) => {
        const parts = _formatStatParts(d, true);
        return parts.length ? parts.join(', ') : 'no changes';
    },
};

/**
 * Format a human-readable message for a PrismEvent.
 * @param {string} type
 * @param {any} data
 * @returns {string}
 */
function _formatPrismMessage(type, data) {
    if (typeof data !== 'object' || data === null) {
        return String(data);
    }

    if (data.message) return data.message;
    if (data.error) return data.error;
    if (data.file) return `${data.change_type || 'changed'}: ${data.file}`;

    const formatter = Object.hasOwn(PRISM_FORMATTERS, type) ? PRISM_FORMATTERS[type] : null;
    return (formatter ?? JSON.stringify)(data);
}

/**
 * Handler for `backend-event` — structured log events from the Rust backend.
 * Covers all BackendModule variants (Core, Prism, Frontend, …).
 * Fatal/Error events from non-frontend modules trigger Toast notifications.
 * @param {{ payload: any }} event
 */
function _handleBackendEvent(event) {
    const payload = event?.payload;
    if (!payload || typeof payload !== 'object') return;
    const { level, module, code, message, timestamp } = payload;
    if (!level || !module) return;

    // Normalize code/message — defensive against malformed payloads.
    const text = message ?? '';
    const codePart = (code !== undefined && code !== null) ? `#${code} ` : '';
    const formatted = `[${module}] ${codePart}${text}`.trimEnd();

    _pushEvent({
        type: level,
        message: formatted,
        timestamp: _formatTimestamp(timestamp),
        source: 'backend',
    });

    // Fatal/Error → Toast notification (dedup by module:code, 10s window)
    // Skip frontend-originated events to prevent feedback loops:
    // frontend error → backend → frontend toast → backend log → …
    if ((level === 'fatal' || level === 'error') && module !== 'frontend') {
        const key = (code !== undefined && code !== null)
            ? `${module}:${code}`
            : `${module}:${text}`;
        if (_recentErrors.has(key)) return;
        _recentErrors.add(key);
        setTimeout(() => _recentErrors.delete(key), 10_000);
        showNotification(
            `[${module}] ${text}`,
            level === 'fatal' ? 'error' : 'warning',
            null,
            { log: false }, // Already logged via emit_backend_event
        );
    }
}

/**
 * Handler for `prism-event` — Prism engine lifecycle events.
 * Supports both flattened and tagged-enum payload formats.
 * @param {{ payload: any }} event
 */
function _handlePrismEvent(event) {
    const payload = event?.payload;
    if (!payload || payload.__diag) return;

    const { type, data } = _normalizePrismPayload(payload);
    const message = _formatPrismMessage(type, data);

    _pushEvent({
        type,
        message,
        timestamp: _formatTimestamp(),
    });
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Subscribe to new events. Called by logs page when it mounts.
 * @param {(entry: { type: string, message: string, timestamp: string, source?: string }) => void} callback
 */
export function subscribeToEvents(callback) {
    _onNewEvent = callback;
}

/**
 * Unsubscribe from new events. Called by logs page when it unmounts.
 */
export function unsubscribeFromEvents() {
    _onNewEvent = null;
}

/**
 * Get accumulated events (for logs page to render).
 * @returns {Array<{ type: string, message: string, timestamp: string, source?: string }>}
 */
export function getExtLogEvents() {
    return _extLogEvents;
}

/**
 * Clear all accumulated events.
 */
export function clearExtLogEvents() {
    _extLogEvents = [];
}

/**
 * Register global backend-event and prism-event listeners.
 *
 * The `backend-event` listener is registered first and its failure
 * **propagates** to the caller — without it, all frontend log forwarding
 * is silently lost (the backend dispatches via `eval()` with zero
 * buffering). The caller's `.catch()` handler will fire if this fails,
 * allowing a fallback to console-only logging.
 *
 * The `prism-event` listener is registered second; its failure is
 * silently swallowed (non-critical — Prism events are informational).
 *
 * **Must be awaited before any `forwardToBackend()` calls** to guarantee no
 * events are lost.
 *
 * Call once at app startup.
 * @returns {Promise<void>}
 * @throws {Error} If the `backend-event` listener cannot be registered
 *   (e.g. Tauri IPC unavailable in browser dev mode).
 */
export async function initBackendEventListeners() {
    // Already initialized
    if (_backendEventUnlisten && _prismEventUnlisten) return;

    // backend-event listener — registered FIRST and awaited directly.
    //
    // This is the critical path: without it, all frontend logs forwarded
    // via forwardToBackend() are permanently lost (emit_to_main() dispatches
    // via eval() with zero buffering). If this fails, the caller must know
    // so it can fall back to console-only logging.
    //
    // We do NOT swallow this error — let it propagate so the caller's
    // .catch() handler actually fires.
    if (!_backendEventUnlisten) {
        _backendEventUnlisten = await listen('backend-event', _handleBackendEvent);
    }

    // prism-event listener — non-critical, failure is silently ignored.
    // Prism events (rule changes, watcher status) are informational; the
    // app functions normally without them.
    if (!_prismEventUnlisten) {
        try {
            _prismEventUnlisten = await listen('prism-event', _handlePrismEvent);
        } catch {
            // Tauri event API not available (e.g. browser dev mode)
        }
    }
}

/**
 * Cleanup function for app shutdown.
 * @returns {void}
 */
export function cleanupBackendEventListeners() {
    _prismEventUnlisten?.();
    _backendEventUnlisten?.();
    _prismEventUnlisten = null;
    _backendEventUnlisten = null;
}
