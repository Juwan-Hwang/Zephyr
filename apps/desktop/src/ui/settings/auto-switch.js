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
    try {
        const cfg = await getSmartConfig();
        if (cfg && typeof cfg.enabled === 'boolean') smart = cfg.enabled;
    } catch { /* keep the localStorage value */ }
    return { failover: !!failoverEnabled, smart, autoTest: storage.getItem('smartAutoTest') === 'true' };
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

    // Scheduled tests (need scoring, so after it)
    storage.setItem('smartAutoTest', String(on));
    if (on) deps.startAutoTest(); else deps.stopAutoTest();

    deps.onChanged?.();
    if (firstError) throw firstError;
}
