// @ts-check
/**
 * "Auto-switch nodes" — one setting in place of the three switches it replaced
 * (failover, node scoring, scheduled speed tests). They only ever made sense
 * together: failover acts on test results, scoring is fed by the same tests,
 * and the scheduled tests did nothing while scoring was off.
 *
 * The stored keys stay as they were so older settings files, the proxies page
 * and the tray keep working:
 *   - settings.failover_enabled        (Rust settings)
 *   - smart config `enabled`           (prism smart engine)
 *   - localStorage 'smartEnabled'      (fallback for the smart engine)
 *   - localStorage 'smartAutoTest'     (scheduled tests)
 *
 * On = all three on. Off = all three off. A file written by an older build with
 * only some of them on reads as on when failover or the scheduled tests were
 * running, i.e. when Zephyr was already switching or testing by itself.
 *
 * @module ui/settings/auto-switch
 */

/**
 * @typedef {Object} AutoSwitchState
 * @property {boolean} failover   settings.failover_enabled
 * @property {boolean} smart      smart engine enabled
 * @property {boolean} autoTest   scheduled tests (localStorage 'smartAutoTest')
 * @property {boolean} [smartUnknown]  the smart config could not be read; `smart` is only the localStorage fallback
 */

/**
 * Whether the merged switch reads as on for a (possibly legacy) combination.
 * @param {AutoSwitchState} s
 * @returns {boolean}
 */
export function deriveAutoSwitch(s) {
    return !!s.failover || (!!s.smart && !!s.autoTest);
}

/**
 * The underlying values the merged switch writes.
 * @param {boolean} on
 * @returns {AutoSwitchState}
 */
export function autoSwitchTargets(on) {
    return { failover: on, smart: on, autoTest: on };
}

/**
 * @typedef {Object} AutoSwitchDeps
 * @property {() => Promise<any>} getSmartConfig
 * @property {(config: any) => Promise<any>} saveSmartConfig
 * @property {(key: string, value: any) => Promise<any>} saveSetting
 * @property {(key: string, value: any) => void} setStore
 * @property {() => void} startAutoTest
 * @property {() => void} stopAutoTest
 * @property {() => void} [onChanged]
 * @property {() => Promise<any>} [getFailoverPolicy]  the failover tracker's policy (in memory, on by default)
 * @property {(policy: any) => Promise<any>} [setFailoverPolicy]
 * @property {Storage} [storage]
 * @property {HTMLElement} [root]  element carrying the --smart-enabled CSS variable
 */

/**
 * Read the current state from the stored keys.
 * @param {{ failoverEnabled: boolean, getSmartConfig: () => Promise<any>, storage?: Storage }} opts
 * @returns {Promise<AutoSwitchState>}
 */
export async function readAutoSwitchState({ failoverEnabled, getSmartConfig, storage = localStorage }) {
    let smart = storage.getItem('smartEnabled') === 'true';
    let smartUnknown = false;
    try {
        const cfg = await getSmartConfig();
        if (cfg && typeof cfg.enabled === 'boolean') smart = cfg.enabled;
    } catch {
        // Keep the localStorage value for display, but it is a guess: never write it back.
        smartUnknown = true;
    }
    const state = { failover: !!failoverEnabled, smart, autoTest: storage.getItem('smartAutoTest') === 'true' };
    return smartUnknown ? { ...state, smartUnknown } : state;
}

/**
 * Write all three keys for the merged switch. Every key is attempted even if
 * one fails; the first error is rethrown afterwards.
 * @param {boolean} on
 * @param {AutoSwitchDeps} deps
 */
export function applyAutoSwitch(on, deps) {
    // One change at a time, in order: a slow enable must not finish after a later disable.
    const run = _applyQueue.then(() => writeAutoSwitch(autoSwitchTargets(on), deps));
    _applyQueue = run.then(() => undefined, () => undefined);
    return run;
}

/**
 * Put the three keys back to an earlier (possibly mixed, legacy) state, in the same
 * queue: the rollback of a failed switch change restores what was there instead of
 * forcing all three to one value.
 * @param {AutoSwitchState} state
 * @param {AutoSwitchDeps} deps
 */
export function restoreAutoSwitch(state, deps) {
    const target = { failover: !!state.failover, smart: !!state.smart, autoTest: !!state.autoTest };
    // A restore never touches the failover policy: it puts back what was there.
    const run = _applyQueue.then(() => writeAutoSwitch(target, deps, false));
    _applyQueue = run.then(() => undefined, () => undefined);
    return run;
}

/** @type {Promise<void>} */
let _applyQueue = Promise.resolve();

/**
 * The engine's `enabled` from a smart config read. smart.toml without an `enabled` line
 * is a supported legacy state where the switch follows localStorage, so a save from a
 * read without it must keep that value instead of writing enabled = false.
 * @param {Record<string, any>|null|undefined} config
 * @returns {boolean}
 */
export function smartEnabledOf(config) {
    if (typeof config?.enabled === 'boolean') return config.enabled;
    return localStorage.getItem('smartEnabled') === 'true';
}

/**
 * Run another read-modify-write of the smart config in the same queue, so it
 * and the switch never overwrite each other's change.
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export function queueSmartConfigWrite(fn) {
    const run = _applyQueue.then(fn);
    _applyQueue = run.then(() => undefined, () => undefined);
    return run;
}

/**
 * @param {AutoSwitchState} target
 * @param {AutoSwitchDeps} deps
 * @param {boolean} [reenablePolicy] turning failover on also turns the policy back on
 */
async function writeAutoSwitch(target, deps, reenablePolicy = true) {
    const { smart, failover, autoTest } = target;
    const storage = deps.storage ?? localStorage;
    const root = deps.root ?? document.documentElement;
    /** @type {unknown} */
    let firstError = null;

    // Scoring
    root.style.setProperty('--smart-enabled', smart ? '1' : '0');
    storage.setItem('smartEnabled', String(smart));
    try {
        const cfg = (await deps.getSmartConfig()) || {};
        cfg.enabled = smart;
        await deps.saveSmartConfig(cfg);
    } catch (err) { firstError = firstError ?? err; }

    // Failover
    deps.setStore('failoverEnabled', failover);
    try { await deps.saveSetting('failover_enabled', failover); } catch (err) { firstError = firstError ?? err; }
    // The tracker that turns failed tests into a switch has its own policy switch (the
    // Prism page can turn it off): turning failover on must turn that back on too, keeping
    // its threshold, cooldown and fallback group. Off is left alone: the setting above
    // already stops failures from being reported.
    /** @type {any} */
    let reenabledPolicy = null;
    if (failover && reenablePolicy && deps.getFailoverPolicy && deps.setFailoverPolicy) {
        try {
            const policy = await deps.getFailoverPolicy();
            if (policy?.enabled === false) {
                await deps.setFailoverPolicy({ ...policyFields(policy), enabled: true });
                reenabledPolicy = policy;
            }
        } catch (err) { firstError = firstError ?? err; }
    }

    // Scheduled tests (need scoring, so after it)
    storage.setItem('smartAutoTest', String(autoTest));
    if (autoTest) deps.startAutoTest(); else deps.stopAutoTest();

    // The change failed and the switch goes back: the policy it turned on goes back
    // off too. This runs in the queue, so a later choice to turn on still re-enables it.
    if (firstError && reenabledPolicy && deps.setFailoverPolicy) {
        try {
            await deps.setFailoverPolicy({ ...policyFields(reenabledPolicy), enabled: false });
        } catch { /* the first error is the one reported */ }
    }

    deps.onChanged?.();
    if (firstError) throw firstError;
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

/**
 * Whether the merged switch shows on. The failover tracker's policy is separate
 * (in memory, on by default; the Prism page can turn it off): while it is off,
 * nothing switches nodes, so the switch shows off even with the three keys on.
 * Turning it on then turns the policy back on. A policy that could not be read
 * (null) does not change what the stored keys say.
 * @param {boolean} derived  what the three stored keys say
 * @param {any} policy  the failover policy, or null when unknown
 * @returns {boolean}
 */
export function shownAutoSwitch(derived, policy) {
    return derived && policy?.enabled !== false;
}
