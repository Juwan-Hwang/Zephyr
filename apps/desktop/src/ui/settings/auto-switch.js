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
 * Like readSmartEnabled, plus whether the engine's config was read (`known`). A guess
 * from localStorage after a failed read must not be written back anywhere.
 * @param {{ getSmartConfig: () => Promise<any>, storage?: Storage }} opts
 * @returns {Promise<{ enabled: boolean, known: boolean }>}
 */
export async function readSmartState({ getSmartConfig, storage = localStorage }) {
    try {
        return { enabled: smartEnabledOf(await getSmartConfig(), storage), known: true };
    } catch {
        return { enabled: storage.getItem('smartEnabled') === 'true', known: false };
    }
}

/**
 * Show node scoring as the engine has it (a config reload, or a read that
 * failed at startup). Call it inside queueSmartConfigWrite.
 *
 * Coming on starts scheduled tests that were left on without a timer. Going
 * off, when the engine said so, turns scheduled tests off as the switch would,
 * so they don't come back by themselves later; a localStorage guess never does.
 * @param {{ getSmartConfig: () => Promise<any>, startAutoTest: () => void, stopAutoTest: () => void,
 *   storage?: Storage, root?: HTMLElement }} opts
 * @returns {Promise<{ on: boolean, changed: boolean }>}
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
        on = storage.getItem('smartEnabled') === 'true';
    }
    if (fromEngine) {
        // Keep the fallback in step for a later failed read; storage that can't be
        // written must not change what the engine said.
        try { storage.setItem('smartEnabled', String(on)); } catch { /* cache only */ }
    }
    const wasOn = root.style.getPropertyValue('--smart-enabled') === '1';
    root.style.setProperty('--smart-enabled', on ? '1' : '0');
    const changed = on !== wasOn;
    if (changed && on && readAutoTestEnabled(storage)) startAutoTest();
    if (changed && !on && fromEngine) {
        stopAutoTest();
        try { storage.setItem('smartAutoTest', 'false'); } catch { /* stopped anyway */ }
    }
    return { on, changed };
}

/**
 * Whether scheduled speed tests are on (they also need scoring on).
 * @param {Storage} [storage]
 */
export function readAutoTestEnabled(storage = localStorage) {
    return storage.getItem('smartAutoTest') === 'true';
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
        deps.setStore('failoverEnabled', on);
        try {
            await deps.saveSetting('failover_enabled', on);
        } catch (err) {
            deps.setStore('failoverEnabled', previous);
            throw err;
        }
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
        let wasOn = shownBefore;
        let engineRead = false;
        const setShown = (/** @type {boolean} */ v) => root.style.setProperty('--smart-enabled', v ? '1' : '0');
        setShown(on);
        storage.setItem('smartEnabled', String(on));
        if (!on) writeAutoTest(false, deps);
        try {
            const cfg = (await deps.getSmartConfig()) || {};
            if (typeof cfg.enabled === 'boolean') {
                wasOn = cfg.enabled;
                engineRead = true;
            }
            await deps.saveSmartConfig({ ...cfg, enabled: on });
        } catch (err) {
            // The fallback follows the engine when it was read, so a later failed
            // read doesn't bring back a value the engine never had.
            if (engineRead) storage.setItem('smartEnabled', String(wasOn));
            else if (previous === null) storage.removeItem('smartEnabled');
            else storage.setItem('smartEnabled', previous);
            setShown(wasOn);
            if (!on && hadAutoTest && wasOn) writeAutoTest(true, deps);
            deps.onChanged?.();
            throw err;
        }
        // Scheduled tests kept on while scoring showed off (its config couldn't be
        // read at startup, though the engine had it on) never got a timer: start
        // them now that they can run.
        if (on && (!wasOn || !shownBefore) && readAutoTestEnabled(storage)) deps.startAutoTest();
        deps.onChanged?.();
    });
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
        writeAutoTest(on && root.style.getPropertyValue('--smart-enabled') === '1', deps);
    });
}

/**
 * @param {boolean} on
 * @param {SwitchDeps} deps
 */
function writeAutoTest(on, deps) {
    const storage = deps.storage ?? localStorage;
    storage.setItem('smartAutoTest', String(on));
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
