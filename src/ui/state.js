// @ts-check
/**
 * Proxy-based reactive store system.
 * Microtask-batched notifications, localStorage persistence,
 * freeze mode for testing, and wildcard subscriptions.
 *
 * @module state
 */

import { detectSystemLanguage } from '../i18n.js';

// ---------------------------------------------------------------------------
// Store Factory
// ---------------------------------------------------------------------------

const PERSIST_DEBOUNCE_MS = 100;

/**
 * @typedef {Object} Store
 * @property {(key?: string) => *} get - Get a single key or shallow copy of state
 * @property {(keyOrPartial: string|Object, value?: *) => void} set - Set one or more keys
 * @property {(key: string, callback: Function) => Function} subscribe - Subscribe to changes
 * @property {(key: string, callback: Function) => void} unsubscribe - Unsubscribe a callback
 * @property {() => void} freeze - Freeze the store
 * @property {() => void} unfreeze - Unfreeze the store
 * @property {boolean} isFrozen - Whether the store is frozen
 */

/**
 * Create a reactive store backed by a Proxy.
 *
 * @param {string}   storeName          - localStorage key prefix
 * @param {Record<string, any>}   initialState       - Default state values
 * @param {Object}   [options]
 * @param {boolean}  [options.persist=true]  - Auto-persist to localStorage
 * @returns {Store}
 */
export function createStore(storeName, initialState, { persist = true } = {}) {
    // Hydrate from localStorage
    let state = hydrate(storeName, initialState);

    /** @type {Map<string, Set<Function>>} key -> callbacks */
    const keySubs = new Map();

    /** @type {Set<Function>} wildcard subscribers */
    const globalSubs = new Set();

    /** Batch tracking */
    let pendingKeys = new Set();
    let microtaskScheduled = false;
    let frozen = false;

    // --- Persistence (debounced) ---
    /** @type {number|null} */
    let persistTimer = null;

    function schedulePersist() {
        if (!persist) return;
        if (persistTimer) clearTimeout(persistTimer);
        persistTimer = setTimeout(() => {
            try {
                localStorage.setItem(storeName, JSON.stringify(state));
            } catch { /* quota exceeded — silently ignore */ }
            persistTimer = null;
        }, PERSIST_DEBOUNCE_MS);
    }

    // --- Microtask-batched notification ---
    function flush() {
        microtaskScheduled = false;
        const keys = pendingKeys;
        pendingKeys = new Set();

        for (const key of keys) {
            const subs = keySubs.get(key);
            if (subs) {
                for (const cb of subs) {
                    try { cb(state[key], key, state); } catch { /* swallow */ }
                }
            }
        }

        // Global subscribers
        if (globalSubs.size > 0) {
            const snapshot = { ...state };
            for (const cb of globalSubs) {
                try { cb(snapshot, keys); } catch { /* swallow */ }
            }
        }
    }

    /** @param {string} key */
    function scheduleNotify(key) {
        pendingKeys.add(key);
        if (!microtaskScheduled) {
            microtaskScheduled = true;
            queueMicrotask(flush);
        }
    }

    // --- Public API ---
    const store = {
        /**
         * Get a single key, or a shallow copy of entire state.
         * @param {string} [key]
         * @returns {*}
         */
        get(key) {
            if (key === undefined) return { ...state };
            return state[key];
        },

        /**
         * Set one or more keys. Triggers subscribers (batched via microtask).
         * Skips notification when the new value is identical (Object.is) to
         * the current value, unless the key is '*' (batch update).
         *
         * @param {string|Record<string, any>} keyOrPartial
         * @param {*} [value]
         */
        set(keyOrPartial, value) {
            if (frozen) return;

            if (typeof keyOrPartial === 'object' && keyOrPartial !== null) {
                // Batch update — '*' key, always notify
                for (const k of Object.keys(keyOrPartial)) {
                    if (k in state) {
                        state[k] = keyOrPartial[k];
                        scheduleNotify(k);
                    }
                }
            } else {
                const key = keyOrPartial;
                if (key in state) {
                    // Skip notification when value is unchanged
                    if (!Object.is(state[key], value)) {
                        state[key] = value;
                        scheduleNotify(key);
                    }
                }
            }

            schedulePersist();
        },

        /**
         * Subscribe to changes on a specific key.
         * Use '*' to subscribe to all changes.
         *
         * @param {string}   key
         * @param {Function} callback - (newValue, key, fullState)
         * @returns {Function} Unsubscribe function
         */
        subscribe(key, callback) {
            if (key === '*') {
                globalSubs.add(callback);
                return () => globalSubs.delete(callback);
            }

            let subs = keySubs.get(key);
            if (!subs) {
                subs = new Set();
                keySubs.set(key, subs);
            }
            subs.add(callback);

            return () => {
                subs.delete(callback);
                if (subs.size === 0) keySubs.delete(key);
            };
        },

        /**
         * Unsubscribe a specific callback from a key.
         * @param {string}   key
         * @param {Function} callback
         */
        unsubscribe(key, callback) {
            if (key === '*') {
                globalSubs.delete(callback);
                return;
            }
            const subs = keySubs.get(key);
            if (subs) {
                subs.delete(callback);
                if (subs.size === 0) keySubs.delete(key);
            }
        },

        /**
         * Freeze the store — all .set() calls become no-ops.
         * Useful for testing snapshots.
         */
        freeze() {
            frozen = true;
        },

        /**
         * Unfreeze the store — re-enable .set().
         */
        unfreeze() {
            frozen = false;
        },

        /** @returns {boolean} Whether the store is currently frozen */
        get isFrozen() {
            return frozen;
        },
    };

    return store;
}

// ---------------------------------------------------------------------------
// Hydration helper
// ---------------------------------------------------------------------------

/**
 * @param {string} storeName
 * @param {Record<string, any>} defaults
 * @returns {Record<string, any>}
 */
function hydrate(storeName, defaults) {
    try {
        const raw = localStorage.getItem(storeName);
        if (raw) {
            const saved = JSON.parse(raw);
            // Merge saved values over defaults (don't add new keys)
            const state = { ...defaults };
            for (const key of Object.keys(defaults)) {
                if (key in saved) {
                    state[key] = saved[key];
                }
            }
            return state;
        }
    } catch { /* corrupt JSON — fall through */ }
    return { ...defaults };
}

// ---------------------------------------------------------------------------
// Convenience: useStore
// ---------------------------------------------------------------------------

/**
 * Subscribe to a store key and return an unsubscribe function.
 *
 * @param {Store} store
 * @param {string}                  key
 * @param {Function}                callback
 * @returns {Function} Unsubscribe function
 */
export function useStore(store, key, callback) {
    return store.subscribe(key, callback);
}

// ---------------------------------------------------------------------------
// Pre-built stores
// ---------------------------------------------------------------------------

/** Application-wide state (replaces the old sealed AppState) */
export const appStore = createStore('zephyr.app', {
    // Network state
    isNetworkUpdating: false,
    isTestingLatency: false,

    // UI state
    currentTheme: localStorage.getItem('appTheme') || 'purple',
    currentLang: localStorage.getItem('lang') || detectSystemLanguage(),
    currentPage: 'home',
    currentThemeMode: (() => {
        const saved = localStorage.getItem('themeMode');
        if (saved && ['light', 'auto', 'dark'].includes(saved)) return saved;
        const legacy = localStorage.getItem('darkMode');
        if (legacy === 'true') return 'dark';
        if (legacy === 'false') return 'light';
        return 'auto';
    })(),

    // Proxy state
    currentSortMode: localStorage.getItem('sortMode') || 'default',
    currentOutboundMode: 'rule',

    // System state
    isSysProxyEnabled: false,
    isTunEnabled: false,
    isCoreRunning: false,
    isDnsRewriteEnabled: (() => {
        const saved = localStorage.getItem('dnsRewrite');
        return saved === null ? true : saved === 'true';
    })(),

    // Config
    currentConfigName: null,
    currentCoreVersion: '',
});

/** Tray state (replaces the old sealed TrayState) */
export const trayStore = createStore('zephyr.tray', {
    sysProxyEnabled: false,
    tunEnabled: false,
});

/** Rules state (replaces the old sealed RulesState) */
export const rulesStore = createStore('zephyr.rules', {
    currentRules: [],
    originalRules: [],
});

// ---------------------------------------------------------------------------
// Backward-compatible sealed objects
// ---------------------------------------------------------------------------
// These Proxy-wrapped objects expose the same surface as the old
// Object.seal exports so that existing code (e.g. settings.js) continues
// to work without modification.  Reads go through the store; writes go
// through the store (and trigger subscribers + persistence).

/**
 * @param {Store} store
 * @returns {any} Proxy wrapper that reads/writes through the store
 */
function createBackwardCompatProxy(store) {
    return new Proxy(store, {
        get(target, prop) {
            if (typeof prop === 'string' && prop in target) return /** @type {any} */ (target)[prop];
            if (typeof prop === 'string') return target.get(prop);
            return undefined;
        },
        set(_target, prop, value) {
            if (typeof prop === 'string') {
                store.set(prop, value);
                return true;
            }
            return false;
        },
    });
}

/**
 * @deprecated Use `appStore` instead. Kept for backward compatibility.
 */
export const AppState = createBackwardCompatProxy(appStore);

/**
 * @deprecated Use `trayStore` instead. Kept for backward compatibility.
 */
export const TrayState = createBackwardCompatProxy(trayStore);

/**
 * @deprecated Use `rulesStore` instead. Kept for backward compatibility.
 */
export const RulesState = createBackwardCompatProxy(rulesStore);
