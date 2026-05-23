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
 * Call once at app startup.
 * @returns {Promise<void>}
 */
export async function initBackendEventListeners() {
    // Already initialized
    if (_backendEventUnlisten && _prismEventUnlisten) return;

    // Listen for prism events (variable updates, etc.)
    if (!_prismEventUnlisten) {
        try {
            _prismEventUnlisten = await listen('prism-event', (/** @type {{ payload: any }} */ event) => {
                const payload = event.payload;
                if (!payload || payload.__diag) return;

                // PrismEvent payload format:
                //   Flattened: { "type": "ConfigReloaded", "success": true, "message": "..." }
                //   Tagged:    { "ConfigReloaded": { "success": true, "message": "..." } }
                let type = 'Unknown';
                let message = '';
                let data = payload;

                if (payload.type && typeof payload.type === 'string') {
                    // Flattened format
                    type = payload.type;
                    data = payload;
                } else {
                    // Tagged enum format
                    const variants = ['ConfigReloaded', 'PatchFailed', 'PatchApplied', 'WatcherEvent', 'WatcherStatus', 'RulesChanged'];
                    for (const v of variants) {
                        if (payload[v] !== undefined) {
                            type = v;
                            data = payload[v];
                            break;
                        }
                    }
                }

                if (typeof data === 'object' && data !== null) {
                    if (data.message) message = data.message;
                    else if (data.error) message = data.error;
                    else if (data.file) message = `${data.change_type || 'changed'}: ${data.file}`;
                    else if (type === 'WatcherStatus') message = data.running ? `Watching ${data.watching_count} dir(s)` : 'Watch stopped';
                    else if (type === 'PatchApplied') {
                        const pid = data.patch_id || data.id || '';
                        const parts = [];
                        const a = data.added || data.added_count || 0;
                        const r = data.removed || data.removed_count || 0;
                        const m = data.modified || data.modified_count || 0;
                        if (a) parts.push(`+${a}`);
                        if (r) parts.push(`-${r}`);
                        if (m) parts.push(`~${m}`);
                        const stats = parts.length ? ` [${parts.join(' ')}]` : '';
                        const dur = data.duration || data.elapsed ? ` in ${data.duration || data.elapsed}` : '';
                        message = `${pid}${stats}${dur}`;
                    }
                    else if (type === 'RulesChanged') {
                        const parts = [];
                        const a = data.added || data.added_count || 0;
                        const r = data.removed || data.removed_count || 0;
                        const m = data.modified || data.modified_count || 0;
                        if (a) parts.push(`+${a} added`);
                        if (r) parts.push(`-${r} removed`);
                        if (m) parts.push(`~${m} modified`);
                        message = parts.length ? parts.join(', ') : 'no changes';
                    }
                    else message = JSON.stringify(data);
                } else {
                    message = String(data);
                }

                const entry = {
                    type,
                    message,
                    timestamp: new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }),
                };
                _extLogEvents.push(entry);
                if (_extLogEvents.length > 500) {
                    _extLogEvents = _extLogEvents.slice(-500);
                }
                _onNewEvent?.(entry);
            });
        } catch {
            // Tauri event API not available (e.g. in browser dev mode)
        }
    }

    // Listen for backend structured events
    if (!_backendEventUnlisten) {
        try {
            _backendEventUnlisten = await listen('backend-event', (/** @type {{ payload: any }} */ event) => {
                const { level, module, code, message, timestamp } = event.payload;
                if (!level || !module) return;

                const entry = {
                    type: level,
                    message: `[${module}] #${code} ${message}`,
                    timestamp: timestamp
                        ? new Date(timestamp).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
                        : new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }),
                    source: 'backend',
                };
                _extLogEvents.push(entry);
                if (_extLogEvents.length > 500) {
                    _extLogEvents = _extLogEvents.slice(-500);
                }
                _onNewEvent?.(entry);

                // Fatal/Error → Toast notification (dedup by module:code, 10s window)
                if (level === 'fatal' || level === 'error') {
                    const key = `${module}:${code}`;
                    if (_recentErrors.has(key)) return;
                    _recentErrors.add(key);
                    setTimeout(() => _recentErrors.delete(key), 10_000);
                    showNotification(
                        `[${module}] ${message}`,
                        level === 'fatal' ? 'error' : 'warning',
                    );
                }
            });
        } catch {
            // Tauri event API not available
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
