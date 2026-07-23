// @ts-check
/**
 * Frontend log forwarding — sends log entries to the backend app log.
 *
 * Architecture:
 *   - Fire-and-forget: never blocks UI, never throws
 *   - Rate-limited: max 50 entries per 5 s window, deduped by content hash
 *   - Zero circular deps: accesses __TAURI_INTERNALS__ directly,
 *     bypassing api.js (which imports logger.js → would be circular)
 *
 * @module frontend-log
 */

import { COMMANDS } from '@zephyr/shared';

// ── Tauri IPC (raw — avoids circular dependency with api.js) ─────────────

/**
 * The raw Tauri internals object, injected into `window` by the runtime
 * regardless of `withGlobalTauri` config.  Same technique as `api.js`.
 * @type {{ invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> } | undefined}
 */
const _tauri =
    typeof window !== 'undefined'
        ? /** @type {any} */ (window).__TAURI_INTERNALS__
        : undefined;

// ── Rate Limiting ───────────────────────────────────────────────────────

/** @type {number} Dedup window in milliseconds */
const DEDUPE_WINDOW_MS = 5000;

/** @type {number} Maximum non-error entries forwarded per dedup window */
const MAX_PER_WINDOW = 50;

/** @type {number} Maximum error entries forwarded per dedup window (higher, but finite) */
const MAX_ERRORS_PER_WINDOW = 100;

/** @type {Map<string, number>} message-hash → last-sent timestamp */
const _dedupe = new Map();

/** @type {number} Non-error entries forwarded in the current window */
let _windowCount = 0;

/** @type {number} Error entries forwarded in the current window */
let _errorCount = 0;

/** @type {number} Current window start timestamp */
let _windowStart = Date.now();

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Forward a log entry to the backend app log file.
 *
 * The entry goes through `emit_backend_event` on the Rust side, so it
 * appears in stderr, the frontend logs page, and the app log file
 * (if `log_app_enabled` is active).
 *
 * This function is fire-and-forget — it never throws, never blocks,
 * and silently drops entries when the rate limit is exceeded.
 *
 * @param {'error'|'warn'|'info'|'debug'} level   - Log severity (debug maps to Info on the backend)
 * @param {'console'|'notification'|'uncaught'|'rejection'} source - Origin
 * @param {string} message               - Log message text
 * @returns {void}
 */
export function forwardToBackend(level, source, message) {
    // — Rate limit: reset window if expired —
    const now = Date.now();
    if (now - _windowStart > DEDUPE_WINDOW_MS) {
        _windowCount = 0;
        _errorCount = 0;
        _windowStart = now;
        _dedupe.clear();
    }

    // — Rate limit: severity-aware quotas —
    // Error-level entries get a separate, larger quota so critical frontend
    // failures are never silently dropped by a burst of lower-severity chatter.
    // Both quotas are finite to prevent unbounded IPC under error storms.
    const isError = level === 'error';
    if (isError) {
        if (_errorCount >= MAX_ERRORS_PER_WINDOW) return;
    } else if (_windowCount >= MAX_PER_WINDOW) return;

    // — Dedup: skip identical messages within the window —
    // Use the full message (not truncated) to avoid false dedup of
    // long stack traces that share a prefix but differ in the tail.
    const hash = `${level}:${source}:${message}`;
    const last = _dedupe.get(hash);
    if (last !== undefined && now - last < DEDUPE_WINDOW_MS) return;
    _dedupe.set(hash, now);
    if (isError) {
        _errorCount++;
    } else {
        _windowCount++;
    }

    // — Fire-and-forget: swallow both sync throws and async rejections —
    try {
        const promise = _tauri?.invoke?.(COMMANDS.WRITE_FRONTEND_LOG, {
            level,
            source,
            message,
        });
        // Catch the Promise rejection to prevent unhandledrejection
        // (which would itself trigger forwardToBackend → loop).
        if (promise && typeof promise.catch === 'function') {
            promise.catch(() => {});
        }
    } catch {
        // Silently ignore — logging must never throw
    }
}
