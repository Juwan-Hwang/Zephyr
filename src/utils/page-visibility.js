// @ts-check
/**
 * Page visibility guard — pauses timers/RAF when a page is hidden,
 * resumes them when it becomes visible again.
 *
 * Integrates with Zephyr's `data-page` + `hidden` class mechanism.
 * Timer cleanup is idempotent: calling pause/resume multiple times is safe.
 *
 * @module utils/page-visibility
 */

/** @type {Map<string, { timers: Set<number>, rafs: Set<number>, callbacks: Set<Function> }>} */
const _registry = new Map();

/** @type {boolean} */
let _listening = false;

/**
 * Check whether a specific page is currently visible.
 * @param {string} pageId - data-page attribute value
 * @returns {boolean}
 */
export function isPageVisible(pageId) {
    const el = document.querySelector(`[data-page="${pageId}"]`);
    return el !== null && !el.classList.contains('hidden');
}

/**
 * Register a setInterval timer under a page.
 * Cleared automatically when the page becomes hidden.
 * @param {string} pageId
 * @param {number} timerId - return value of setInterval
 * @returns {number}
 */
export function registerPageTimer(pageId, timerId) {
    _ensureListening();
    const entry = _getOrCreate(pageId);
    entry.timers.add(timerId);
    return timerId;
}

/**
 * Register a requestAnimationFrame id under a page.
 * Cancelled automatically when the page becomes hidden.
 * @param {string} pageId
 * @param {number} rafId
 * @returns {number}
 */
export function registerPageRAF(pageId, rafId) {
    _ensureListening();
    const entry = _getOrCreate(pageId);
    entry.rafts.add(rafId);
    return rafId;
}

/**
 * Register a callback to run when a page becomes visible.
 * @param {string} pageId
 * @param {Function} cb
 * @returns {Function} Unsubscribe function
 */
export function onPageVisible(pageId, cb) {
    _ensureListening();
    const entry = _getOrCreate(pageId);
    entry.callbacks.add(cb);
    return () => entry.callbacks.delete(cb);
}

/**
 * Unregister a timer (e.g. after manual clearInterval).
 * @param {string} pageId
 * @param {number} timerId
 */
export function unregisterPageTimer(pageId, timerId) {
    const entry = _registry.get(pageId);
    if (entry) entry.timers.delete(timerId);
}

/**
 * Unregister a RAF id (e.g. after manual cancelAnimationFrame).
 * @param {string} pageId
 * @param {number} rafId
 */
export function unregisterPageRAF(pageId, rafId) {
    const entry = _registry.get(pageId);
    if (entry) entry.rafts.delete(rafId);
}

/**
 * Destroy all state for a page. Call from destroy functions.
 * @param {string} pageId
 */
export function destroyPageVisibility(pageId) {
    const entry = _registry.get(pageId);
    if (entry) {
        for (const id of entry.timers) clearInterval(id);
        for (const id of entry.rafts) cancelAnimationFrame(id);
        entry.timers.clear();
        entry.rafts.clear();
        entry.callbacks.clear();
        _registry.delete(pageId);
    }
}

// --- Internal ---

function _ensureListening() {
    if (_listening) return;
    _listening = true;
    document.addEventListener('visibilitychange', _onVisibilityChange);
}

function _onVisibilityChange() {
    if (document.visibilityState !== 'visible') return;
    for (const [pageId, entry] of _registry) {
        if (isPageVisible(pageId)) {
            for (const cb of entry.callbacks) {
                try { cb(); } catch { /* swallow */ }
            }
        }
    }
}

/**
 * @param {string} pageId
 * @returns {{ timers: Set<number>, rafs: Set<number>, callbacks: Set<Function> }}
 */
function _getOrCreate(pageId) {
    let entry = _registry.get(pageId);
    if (!entry) {
        entry = { timers: new Set(), rafs: new Set(), callbacks: new Set() };
        _registry.set(pageId, entry);
    }
    return entry;
}
