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
 * @property {(name: string, deps: string[], compute: Function) => Function} selector - Register derived state, returns reader
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
export function createStore(storeName, initialState, { persist = true, transientKeys = [] } = {}) {
    /** @type {Set<string>} Keys that are never persisted to localStorage */
    const _transient = new Set(transientKeys);

    // Hydrate from localStorage
    const state = hydrate(storeName, initialState, _transient);

    /** @type {Map<string, Set<Function>>} key -> callbacks */
    const keySubs = new Map();

    /** @type {Set<Function>} wildcard subscribers */
    const globalSubs = new Set();

    /** @type {Map<string, Set<string>>} key -> Set<selectorName> */
    const depGraph = new Map();

    /** @type {Map<string, { dirty: boolean, value: any, compute: Function }>} */
    const selectorCache = new Map();

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
                // Strip transient keys before persisting
                const toSave = { ...state };
                for (const key of _transient) {
                    delete toSave[key];
                }
                localStorage.setItem(storeName, JSON.stringify(toSave));
            } catch { /* quota exceeded — silently ignore */ }
            persistTimer = null;
        }, PERSIST_DEBOUNCE_MS);
    }

    // --- Microtask-batched notification ---
    function flush() {
        microtaskScheduled = false;
        const keys = pendingKeys;
        pendingKeys = new Set();

        // Mark dependent selectors as dirty (O(1) per key)
        for (const key of keys) {
            const dependents = depGraph.get(key);
            if (dependents) {
                for (const name of dependents) {
                    const entry = selectorCache.get(name);
                    if (entry) entry.dirty = true;
                }
            }
        }

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
         * Functional update — compute new value from previous value atomically.
         * Eliminates race conditions when multiple async operations derive
         * state from the same key. Skips notification when updater returns
         * the same reference (Object.is identity check).
         *
         * @param {string} key
         * @param {(prev: any) => any} updater - Pure function: (prev) => next
         */
        update(key, updater) {
            if (frozen) return;
            if (!(key in state)) return;

            const prev = state[key];
            const next = updater(prev);

            if (Object.is(next, prev)) return;

            state[key] = next;
            scheduleNotify(key);
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

        /**
         * Register a derived state selector.
         * Returns a reader function that lazily recomputes when dirty.
         *
         * @param {string} name - Selector name (unique identifier)
         * @param {string[]} deps - Store keys this selector depends on
         * @param {Function} compute - Pure function: () => derivedValue
         * @returns {Function} Reader: () => derivedValue
         */
        selector(name, deps, compute) {
            selectorCache.set(name, { dirty: true, value: undefined, compute });
            for (const dep of deps) {
                let depSet = depGraph.get(dep);
                if (!depSet) {
                    depSet = new Set();
                    depGraph.set(dep, depSet);
                }
                depSet.add(name);
            }
            return () => {
                const entry = selectorCache.get(name);
                if (!entry) return undefined;
                if (entry.dirty) {
                    entry.value = entry.compute();
                    entry.dirty = false;
                }
                return entry.value;
            };
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
function hydrate(storeName, defaults, transientKeys) {
    try {
        const raw = localStorage.getItem(storeName);
        if (raw) {
            const saved = JSON.parse(raw);
            // Merge saved values over defaults (don't add new keys)
            // Skip transient keys — they must always be computed fresh
            const state = { ...defaults };
            for (const key of Object.keys(defaults)) {
                if (transientKeys?.has(key)) continue;
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
    currentThemeMode: 'auto', // Actual value synced from settings.json in initSettings()

    // Proxy state
    currentSortMode: localStorage.getItem('sortMode') || 'default',
    currentOutboundMode: 'rule',

    // Proxy group resolver state
    // All resolver state is transient — re-resolved each session.
    // User's explicit group choice is tracked via saveProxySelection (profile+group+node).
    uiGroupName: null,
    uiPrimaryGroupName: null,
    effectiveGroupName: null,
    observedGroupName: null,
    observedNodeName: null,

    // System state
    isSysProxyEnabled: false,
    isTunEnabled: false,
    isCoreRunning: false,
    isDnsRewriteEnabled: true, // Actual value synced from settings.json in initDnsRewriteToggle()

    // Config
    currentConfigName: null,
    currentCoreVersion: '',
}, {
    transientKeys: ['uiGroupName', 'uiPrimaryGroupName', 'effectiveGroupName', 'observedGroupName', 'observedNodeName'],
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
