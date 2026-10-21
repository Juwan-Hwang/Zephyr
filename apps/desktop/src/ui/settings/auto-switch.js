// @ts-check
/**
 * Proxy behaviour switches on the settings page, each with its own setting:
 *
 *   - Auto-switch nodes (failover)  settings.failover_enabled (Rust settings)
 *   - Node scoring                  smart config `enabled` (prism smart engine),
 *                                   localStorage 'smartEnabled' as its fallback
 *   - Scheduled speed tests         localStorage 'smartAutoTest'
 *
 * Failover and scoring are independent. Scheduled tests only feed the scores, so
 * they need scoring on: turning scoring off also stops them (as before the
 * switches were briefly merged into one).
 *
 * Every write goes through one queue, so a slow change never lands after a
 * later one, and other read-modify-writes of the smart config (the parameters
 * dialog, the Prism page, a full settings save) never overwrite a switch.
 *
 * @module ui/settings/auto-switch
 */

/**
 * @typedef {Object} SwitchDeps
 * @property {() => Promise<any>} getSmartConfig
 * @property {(config: any) => Promise<any>} saveSmartConfig
 * @property {(key: string, value: any) => Promise<any>} saveSetting   rejects on failure
 * @property {(key: string, value: any) => void} setStore
 * @property {(key: string) => any} [getStore]
 * @property {() => void} startAutoTest
 * @property {() => void} stopAutoTest
 * @property {() => void} [onChanged]
 * @property {() => Promise<any>} [getFailoverPolicy]  the failover tracker's policy (in memory, on by default)
 * @property {(policy: any) => Promise<any>} [setFailoverPolicy]
 * @property {(err: unknown) => void} [onRollbackFailed]  undoing a saved failover setting failed
 * @property {Storage} [storage]
 * @property {HTMLElement} [root]  element carrying the --smart-enabled CSS variable
 */

/** @type {Promise<void>} */
let _queue = Promise.resolve();

/**
 * Run `fn` after every change already queued.
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
function enqueue(fn) {
    const run = _queue.then(fn);
    _queue = run.then(() => undefined, () => undefined);
    return run;
}

/**
 * Run another read-modify-write of the smart config (or a full settings save) in
 * the same queue, so it and the switches never overwrite each other's change.
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export function queueSmartConfigWrite(fn) {
    return enqueue(fn);
}

/**
 * The engine's `enabled` from a smart config read. smart.toml without an `enabled` line
 * is a supported legacy state where the switch follows localStorage, so a save from a
 * read without it must keep that value instead of writing enabled = false.
 * @param {Record<string, any>|null|undefined} config
 * @param {Storage} [storage]
 * @returns {boolean}
 */
export function smartEnabledOf(config, storage = localStorage) {
    if (typeof config?.enabled === 'boolean') return config.enabled;
    return storage.getItem('smartEnabled') === 'true';
}

/**
 * Whether node scoring is on: the smart engine's config, else the localStorage fallback.
 * @param {{ getSmartConfig: () => Promise<any>, storage?: Storage }} opts
 * @returns {Promise<boolean>}
 */
export async function readSmartEnabled({ getSmartConfig, storage = localStorage }) {
    return (await readSmartState({ getSmartConfig, storage })).enabled;
}

/**
 * Like readSmartEnabled, plus whether the engine gave the value (`known`). A guess from
 * localStorage (a failed read, or a config without `enabled`) must not be written back anywhere.
 * @param {{ getSmartConfig: () => Promise<any>, storage?: Storage }} opts
 * @returns {Promise<{ enabled: boolean, known: boolean }>}
 */
export async function readSmartState({ getSmartConfig, storage = localStorage }) {
    try {
        // smart.toml without an `enabled` line: the value is the localStorage guess.
        const config = await getSmartConfig();
        return { enabled: smartEnabledOf(config, storage), known: typeof config?.enabled === 'boolean' };
    } catch {
        return { enabled: storage.getItem('smartEnabled') === 'true', known: false };
    }
}

/**
 * What the engine last said about scoring, per storage, for a read that fails.
 * @type {WeakMap<Storage, boolean>}
 */
const lastEngineSmart = new WeakMap();

/**
 * Show node scoring as the engine has it (a config reload, or a read that
 * failed at startup). Call it inside queueSmartConfigWrite.
 *
 * Coming on starts scheduled tests that were left on without a timer. Off, when
 * the engine says so, turns scheduled tests off as the switch would (also when a
 * failed read had already shown it off), so they don't come back by themselves
 * later; a localStorage guess never does.
 * @param {{ getSmartConfig: () => Promise<any>, startAutoTest: () => void, stopAutoTest: () => void,
 *   storage?: Storage, root?: HTMLElement }} opts
 * @returns {Promise<{ on: boolean, changed: boolean, fromEngine: boolean }>}
 */
export async function syncSmartShown({ getSmartConfig, startAutoTest, stopAutoTest, storage = localStorage, root = document.documentElement }) {
    /** @type {boolean} */
    let on;
    let fromEngine = false;
    try {
        const config = await getSmartConfig();
        // `enabled` is only there when smart.toml has the key (else the fallback).
        fromEngine = typeof config?.enabled === 'boolean';
        on = fromEngine ? config.enabled : storage.getItem('smartEnabled') === 'true';
    } catch {
        // The engine's last answer beats a stored guess that may not have
        // been updated (storage that rejects writes keeps an old value).
        on = lastEngineSmart.get(storage) ?? storage.getItem('smartEnabled') === 'true';
    }
    if (fromEngine) {
        lastEngineSmart.set(storage, on);
        // Keep the fallback in step for a later failed read; storage that can't be
        // written must not change what the engine said.
        try { storage.setItem('smartEnabled', String(on)); } catch { /* cache only */ }
    }
    const wasOn = root.style.getPropertyValue('--smart-enabled') === '1';
    root.style.setProperty('--smart-enabled', on ? '1' : '0');
    const changed = on !== wasOn;
    if (changed && on && readAutoTestEnabled(storage)) startAutoTest();
    if (!on && fromEngine && (changed || readAutoTestEnabled(storage))) {
        stopAutoTest();
        storeAutoTest(false, storage);
    }
    return { on, changed, fromEngine };
}

/**
 * Whether scheduled speed tests are on (they also need scoring on).
 * @param {Storage} [storage]
 */
export function readAutoTestEnabled(storage = localStorage) {
    if (unstoredAutoTest.has(storage)) return /** @type {boolean} */ (unstoredAutoTest.get(storage));
    return storage.getItem('smartAutoTest') === 'true';
}

/**
 * Scheduled-test preferences that storage refused to keep: the switch and the
 * scheduler go by this value for the rest of the session.
 * @type {WeakMap<Storage, boolean>}
 */
const unstoredAutoTest = new WeakMap();

/**
 * Store the scheduled-test preference; when storage refuses it, keep it in memory.
 * @param {boolean} on
 * @param {Storage} storage
 */
function storeAutoTest(on, storage) {
    try {
        storage.setItem('smartAutoTest', String(on));
        unstoredAutoTest.delete(storage);
    } catch {
        unstoredAutoTest.set(storage, on);
    }
}

/**
 * Whether the auto-switch (failover) switch shows on. The failover tracker's policy
 * is separate (in memory, on by default; the Prism page can turn it off): while it
 * is off nothing switches nodes, so the switch shows off even with the setting on.
 * Turning it on then turns the policy back on. A policy that could not be read
 * (null) does not change what the setting says.
 * @param {boolean} stored  settings.failover_enabled
 * @param {any} policy  the failover policy, or null when unknown
 * @returns {boolean}
 */
export function shownFailover(stored, policy) {
    return !!stored && policy?.enabled !== false;
}

/**
 * Turn automatic node switching (failover) on or off. On also turns the failover
 * tracker's policy back on if the Prism page had turned it off (keeping its threshold,
 * cooldown and fallback group). A failed save puts the store and the policy back and
 * rejects.
 * @param {boolean} on
 * @param {SwitchDeps} deps
 * @param {{ reenablePolicy?: boolean }} [opts]
 * @returns {Promise<void>}
 */
export function applyFailover(on, deps, { reenablePolicy = true } = {}) {
    return enqueue(async () => {
        const previous = deps.getStore ? !!deps.getStore('failoverEnabled') : !on;
        // Off stops reports at once; on only once saved, so no latency result
        // switches nodes on a setting that then fails to save.
        if (!on) deps.setStore('failoverEnabled', false);
        try {
            await deps.saveSetting('failover_enabled', on);
        } catch (err) {
            deps.setStore('failoverEnabled', previous);
            throw err;
        }
        if (on) deps.setStore('failoverEnabled', true);
        // Off is left alone: the setting above already stops failures from being reported.
        if (on && reenablePolicy && deps.getFailoverPolicy && deps.setFailoverPolicy) {
            const { getFailoverPolicy, setFailoverPolicy } = deps;
            try {
                // A policy that can't be read may be off, and then nothing would switch.
                const policy = await getFailoverPolicy();
                if (policy?.enabled === false) await setFailoverPolicy({ ...policyFields(policy), enabled: true });
            } catch (err) {
                // Without the policy nothing would switch: undo the setting too.
                // If that undo fails the setting stays saved as on, so the store
                // keeps it, and the switch shows on unless the policy reads as off.
                try {
                    await deps.saveSetting('failover_enabled', previous);
                    deps.setStore('failoverEnabled', previous);
                } catch (undoErr) {
                    deps.onRollbackFailed?.(undoErr);
                }
                throw err;
            }
        }
        deps.onChanged?.();
    });
}

/**
 * Turn node scoring on or off. Off also stops scheduled speed tests, which only
 * feed the scores. A failed save of the smart config puts scoring (and scheduled
 * tests, if this stopped them) back as they were and rejects.
 * @param {boolean} on
 * @param {SwitchDeps} deps
 * @returns {Promise<void>}
 */
export function applySmart(on, deps) {
    return enqueue(async () => {
        const storage = deps.storage ?? localStorage;
        const root = deps.root ?? document.documentElement;
        const previous = storage.getItem('smartEnabled');
        const hadAutoTest = readAutoTestEnabled(storage);
        // Whether scoring was on before this change: the engine's config when it can be
        // read, else what was shown (the engine's last known value, which localStorage
        // may not match when smart.toml has its own `enabled`).
        const shownBefore = root.style.getPropertyValue('--smart-enabled') === '1';
        const engine = { read: false, wasOn: shownBefore };
        const setShown = (/** @type {boolean} */ v) => root.style.setProperty('--smart-enabled', v ? '1' : '0');
        setShown(on);
        try {
            // The fallback cache; unwritable storage must not stop the engine save.
            try { storage.setItem('smartEnabled', String(on)); } catch { /* cache only */ }
            if (!on) writeAutoTest(false, deps);
            const cfg = (await deps.getSmartConfig()) || {};
            if (typeof cfg.enabled === 'boolean') {
                engine.wasOn = cfg.enabled;
                engine.read = true;
            }
            await deps.saveSmartConfig({ ...cfg, enabled: on });
            // The engine now has it: a later failed read must not bring back
            // the value it had before.
            lastEngineSmart.set(storage, on);
        } catch (err) {
            // Read before the save failed: that is the engine's current value.
            if (engine.read) lastEngineSmart.set(storage, engine.wasOn);
            restoreSmartCache(storage, engine, previous);
            setShown(engine.wasOn);
            if (!on && hadAutoTest && engine.wasOn) writeAutoTest(true, deps);
            // Scoring shown off from a guess and the engine unread: keep the
            // preference (no timer while scoring shows off); only the engine
            // saying off clears it.
            else if (!on && hadAutoTest && !engine.read) storeAutoTest(true, storage);
            else startIfNowShown(engine.wasOn, shownBefore, storage, deps);
            deps.onChanged?.();
            throw err;
        }
        // The engine had scoring off, so scheduled tests had no timer: start them.
        if (on && !engine.wasOn && readAutoTestEnabled(storage)) deps.startAutoTest();
        else startIfNowShown(on, shownBefore, storage, deps);
        deps.onChanged?.();
    });
}

/**
 * After a failed scoring save, the fallback follows the engine when it was read,
 * so a later failed read doesn't bring back a value the engine never had.
 * @param {Storage} storage
 * @param {{ read: boolean, wasOn: boolean }} engine
 * @param {string | null} previous  the fallback before the change
 */
function restoreSmartCache(storage, engine, previous) {
    try {
        if (engine.read) storage.setItem('smartEnabled', String(engine.wasOn));
        else if (previous === null) storage.removeItem('smartEnabled');
        else storage.setItem('smartEnabled', previous);
    } catch { /* cache only */ }
}

/**
 * Scheduled tests kept on while scoring showed off (its config couldn't be read
 * at startup, though the engine had it on) never got a timer: start them once
 * scoring shows on, whether this change saved or its rollback put scoring on.
 * @param {boolean} nowOn @param {boolean} shownBefore
 * @param {Storage} storage @param {SwitchDeps} deps
 */
function startIfNowShown(nowOn, shownBefore, storage, deps) {
    if (nowOn && !shownBefore && readAutoTestEnabled(storage)) deps.startAutoTest();
}

/**
 * Turn scheduled speed tests on or off (localStorage only, never fails). They need
 * scoring: while it is off (say a queued "scoring on" failed first) this turns them
 * off instead, so they never run behind a switch that shows off.
 * @param {boolean} on
 * @param {SwitchDeps} deps
 * @returns {Promise<void>}
 */
export function applyAutoTest(on, deps) {
    return enqueue(async () => {
        const root = deps.root ?? document.documentElement;
        // Not set yet: scoring hasn't been read (a click right at startup). The
        // choice is kept; the startup check clears it if scoring turns out off,
        // and the scheduler never runs while scoring shows off.
        writeAutoTest(on && root.style.getPropertyValue('--smart-enabled') !== '0', deps);
    });
}

/**
 * @param {boolean} on
 * @param {SwitchDeps} deps
 */
function writeAutoTest(on, deps) {
    const storage = deps.storage ?? localStorage;
    // Unwritable storage keeps the preference in memory, which the scheduler reads.
    storeAutoTest(on, storage);
    if (on) deps.startAutoTest(); else deps.stopAutoTest();
}

/**
 * The failover policy's own values, kept as they are when only `enabled` changes.
 * @param {any} policy
 */
function policyFields(policy) {
    return {
        threshold: policy.threshold,
        cooldownSecs: policy.cooldownSecs,
        fallbackGroup: policy.fallbackGroup || undefined,
    };
}
