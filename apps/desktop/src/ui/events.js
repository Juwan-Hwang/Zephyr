// @ts-check
/**
 * Lightweight event bus for decoupled module communication.
 * Replaces window.dispatchEvent / window.addEventListener patterns.
 *
 * Features:
 *   - Map<string, Set<Function>> internal storage for O(1) add/remove
 *   - Wildcard '*' listeners receive ALL events
 *   - maxListeners warning (default 50, mirrors Node.js EventEmitter)
 *   - offAll(event) bulk removal
 *   - listenerCount(event) introspection
 *   - Error isolation per handler to prevent cascade failures
 */

const WILDCARD = '*';

import { uiLogger } from '../utils/logger.js';

class EventBus {
    /**
     * @param {number} [maxListeners=50] - Default max listeners per event before warning.
     */
    constructor(maxListeners = 50) {
        /** @type {Map<string, Set<Function>>} */
        this._handlers = new Map();

        /** @type {Set<Function>} */
        this._wildcards = new Set();

        /** @type {number} */
        this._maxListeners = maxListeners;

        /**
         * Tracks which events have already emitted a maxListeners warning,
         * so the warning fires at most once per event (like Node.js).
         * @type {Set<string>}
         * @private
         */
        this._maxListenersWarned = new Set();
    }

    // -----------------------------------------------------------------------
    // Static helpers
    // -----------------------------------------------------------------------

    /**
     * Change the default maxListeners for this instance.
     * Setting to 0 disables the warning entirely.
     * @param {number} n
     */
    setMaxListeners(n) {
        if (typeof n !== 'number' || n < 0) {
            throw new RangeError('maxListeners must be a non-negative number');
        }
        this._maxListeners = n;
        // Reset warning state so new limit takes effect immediately
        this._maxListenersWarned.clear();
    }

    // -----------------------------------------------------------------------
    // Core API
    // -----------------------------------------------------------------------

    /**
     * Subscribe to an event.
     * @param {string} event - Event name, or '*' for wildcard.
     * @param {Function} fn - Handler function
     * @returns {Function} Unsubscribe function
     */
    on(event, fn) {
        if (typeof fn !== 'function') {
            throw new TypeError('Listener must be a function');
        }

        if (event === WILDCARD) {
            this._wildcards.add(fn);
            return () => this._wildcards.delete(fn);
        }

        if (!this._handlers.has(event)) {
            this._handlers.set(event, new Set());
        }
        const handlers = this._handlers.get(event);
        if (!handlers) return () => {};
        handlers.add(fn);

        // maxListeners warning (mirrors Node.js EventEmitter behavior)
        if (
            this._maxListeners > 0 &&
            handlers.size === this._maxListeners + 1 &&
            !this._maxListenersWarned.has(event)
        ) {
            this._maxListenersWarned.add(event);
            uiLogger.warn(
                `Possible EventBus memory leak detected. ` +
                `"${event}" has ${handlers.size} listeners. ` +
                `Use Bus.setMaxListeners() to increase the limit.`
            );
        }

        return () => this.off(event, fn);
    }

    /**
     * Subscribe to an event, but only fire once.
     * @param {string} event
     * @param {Function} fn
     * @returns {Function} Unsubscribe function
     */
    once(event, fn) {
        const wrapper = (/** @type {...*} */ ...args) => {
            this.off(event, wrapper);
            fn(...args);
        };
        return this.on(event, wrapper);
    }

    /**
     * Unsubscribe a specific handler from an event.
     * @param {string} event
     * @param {Function} fn
     */
    off(event, fn) {
        if (event === WILDCARD) {
            this._wildcards.delete(fn);
            return;
        }
        this._handlers.get(event)?.delete(fn);
    }

    /**
     * Remove ALL listeners for a given event.
     * @param {string} event - Event name, or '*' to clear all wildcards.
     */
    offAll(event) {
        if (event === WILDCARD) {
            this._wildcards.clear();
            return;
        }
        this._handlers.delete(event);
        // Allow future warnings if listeners are re-added past the limit
        this._maxListenersWarned.delete(event);
    }

    /**
     * Emit an event to all subscribers (including wildcard listeners).
     * Errors in handlers are caught and logged to prevent cascade failures.
     * @param {string} event
     * @param {*} [data]
     */
    emit(event, data) {
        // Named handlers
        const handlers = this._handlers.get(event);
        if (handlers) {
            for (const fn of handlers) {
                try { fn(data); }
                catch (e) { uiLogger.error(`Error in "${event}" handler`, e); }
            }
        }

        // Wildcard handlers (receive event name as first arg, data as second)
        if (this._wildcards.size > 0) {
            for (const fn of this._wildcards) {
                try { fn(event, data); }
                catch (e) { uiLogger.error(`Error in wildcard handler for "${event}"`, e); }
            }
        }
    }

    // -----------------------------------------------------------------------
    // Introspection
    // -----------------------------------------------------------------------

    /**
     * Check if an event has any subscribers.
     * @param {string} event
     * @returns {boolean}
     */
    hasListeners(event) {
        return (this._handlers.get(event)?.size ?? 0) > 0;
    }

    /**
     * Return the number of active listeners for a given event.
     * Does NOT count wildcard listeners (they are event-agnostic).
     * @param {string} event
     * @returns {number}
     */
    listenerCount(event) {
        return this._handlers.get(event)?.size ?? 0;
    }
}

/** Global event bus singleton */
export const Bus = new EventBus();

// Pre-defined event names for type safety and discoverability
export const Events = Object.freeze({
    THEME_CHANGED: 'theme-changed',
    THEME_MODE_CHANGED: 'theme-mode-changed',
    LANGUAGE_CHANGED: 'language-changed',
    I18N_APPLIED: 'i18n-applied',
    PROXY_SELECTED: 'proxy-selected',
    PROXY_SWITCHED: 'proxy-switched',
    MODE_CHANGED: 'mode-changed',
    TUN_CHANGED: 'tun-changed',
    SYS_PROXY_CHANGED: 'sys-proxy-changed',
    CONFIG_SYNCED: 'config-synced',
    CONFIG_UPDATED: 'config-updated',
    CORE_RESTARTED: 'core-restarted',
    RULES_CHANGED: 'rules-changed',
    TRAFFIC_UPDATE: 'traffic-update',
    CONNECTIONS_FLUSHED: 'connections-flushed',
    TRAY_MENU_UPDATE: 'tray-menu-update',
    NOTIFICATION: 'notification',
    PRISM_EVENT: 'prism-event',
    PRISM_APPLIED: 'prism-applied',
    PRISM_FAILED: 'prism-failed',
});
