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
    const run = _applyQueue.then(() => writeAutoSwitch(on, deps));
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
 * @param {boolean} on
 * @param {AutoSwitchDeps} deps
 */
async function writeAutoSwitch(on, deps) {
    const storage = deps.storage ?? localStorage;
    const root = deps.root ?? document.documentElement;
    /** @type {unknown} */
    let firstError = null;

    // Scoring
    root.style.setProperty('--smart-enabled', on ? '1' : '0');
    storage.setItem('smartEnabled', String(on));
    try {
        const cfg = (await deps.getSmartConfig()) || {};
        cfg.enabled = on;
        await deps.saveSmartConfig(cfg);
    } catch (err) { firstError = firstError ?? err; }

    // Failover
    deps.setStore('failoverEnabled', on);
    try { await deps.saveSetting('failover_enabled', on); } catch (err) { firstError = firstError ?? err; }
    // The tracker that turns failed tests into a switch has its own policy switch (the
    // Prism page can turn it off): turning failover on must turn that back on too, keeping
    // its threshold, cooldown and fallback group. Off is left alone: the setting above
    // already stops failures from being reported.
    if (on && deps.getFailoverPolicy && deps.setFailoverPolicy) {
        try {
            const policy = await deps.getFailoverPolicy();
            if (policy && policy.enabled === false) {
                await deps.setFailoverPolicy({
                    enabled: true,
                    threshold: policy.threshold,
                    cooldownSecs: policy.cooldownSecs,
                    fallbackGroup: policy.fallbackGroup || undefined,
                });
            }
        } catch (err) { firstError = firstError ?? err; }
    }

    // Scheduled tests (need scoring, so after it)
    storage.setItem('smartAutoTest', String(on));
    if (on) deps.startAutoTest(); else deps.stopAutoTest();

    deps.onChanged?.();
    if (firstError) throw firstError;
}
