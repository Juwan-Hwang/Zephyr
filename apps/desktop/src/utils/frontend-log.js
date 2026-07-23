// @ts-check
/**
 * Frontend log forwarding — sends log entries to the backend app log.
 *
 * Architecture:
 *   - Fire-and-forget: never blocks UI, never throws
 *   - Rate-limited: 50 non-error + 100 error entries per 5 s window, deduped by content hash
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

/** @type {number} Cap message length on the frontend to prevent large memory
 *  allocations in the dedup Map and oversized IPC payloads. The backend
 *  also caps at 16 KiB with UTF-8-safe truncation. */
const MAX_MESSAGE_CHARS = 16384;

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

    // — Cap message length on the frontend to bound dedup Map memory and
    // IPC payload size. The backend also caps at 16 KiB with UTF-8-safe
    // truncation, but capping here prevents large strings from ever
    // entering the IPC serialization or the dedup Map.
    const SUFFIX = '\u2026 [truncated]';
    const payload = message.length > MAX_MESSAGE_CHARS
        ? (function () {
              // Reserve space for the suffix so total <= MAX_MESSAGE_CHARS
              let s = message.slice(0, MAX_MESSAGE_CHARS - SUFFIX.length);
              // Avoid splitting a UTF-16 surrogate pair at the boundary:
              // a trailing high surrogate (0xD800-0xDBFF) means the
              // corresponding low surrogate was cut off — remove it.
              if (s.length > 0) {
                  const code = s.codePointAt(s.length - 1) ?? 0;
                  if (code >= 0xD800 && code <= 0xDBFF) {
                      s = s.slice(0, -1);
                  }
              }
              return s + SUFFIX;
          })()
        : message;

    // — Dedup: skip identical messages within the window —
    const hash = `${level}:${source}:${payload}`;
    const last = _dedupe.get(hash);
    if (last !== undefined && now - last < DEDUPE_WINDOW_MS) return;
    _dedupe.set(hash, now);
    if (isError) {
        _errorCount++;
    } else {
        _windowCount++;
    }

    // — Fire-and-forget: optional chaining prevents sync throws when
    // __TAURI_INTERNALS__ is unavailable; .catch() swallows async
    // rejections to prevent unhandledrejection (which would trigger
    // forwardToBackend → loop). No try/catch needed — SonarCloud S4822.
    _tauri?.invoke?.(COMMANDS.WRITE_FRONTEND_LOG, {
        level,
        source,
        message: payload,
    })?.catch?.(() => {});
}
