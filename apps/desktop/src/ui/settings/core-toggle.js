// @ts-check
/**
 * A settings switch that changes the core config (unified delay, IPv6, allow
 * LAN): applied through `update_config`, then kept in settings.json, which
 * overrides every profile when the core starts.
 *
 * @module ui/settings/core-toggle
 */

/** The request chain of each switch, so its saves run in click order. */
const chains = new WeakMap();
/** Saves not finished yet, of every switch. */
const pending = new Set();
/**
 * While Restore Defaults runs: resolves when it is done. A click meanwhile
 * saves once it is, with the value the switch shows then.
 * @type {Promise<void>|null}
 */
let paused = null;

/**
 * @typedef {Object} CoreToggleDeps
 * @property {(patch: Record<string, any>) => Promise<boolean|'restart'|'partial'>} saveCore
 *   apply a patch to the core (shows its own notice for 'restart' / 'partial' / false)
 * @property {(value: boolean) => Promise<void>} persist write the choice to settings.json; rejects on failure
 * @property {(message: string, kind: 'error'|'info'|'success'|'warning') => void} notify
 * @property {() => Record<string, string>} texts the current translations
 */

/**
 * Save the value the switch shows now. Saves of one switch run one after
 * another in click order, so the core ends on the last click. A failed save
 * undoes only its own change: when the switch was clicked again meanwhile,
 * the newer value stays. When settings.json does not take the value, the core
 * runs it but the next start would bring the old one back, so the save is
 * reported as failed instead of applied.
 * @param {{ checked: boolean }} toggle
 * @param {string} coreKey the core config key (`ipv6`)
 * @param {CoreToggleDeps} deps
 * @returns {Promise<boolean|'restart'|'partial'|'unsaved'>} the outcome of this click
 */
export function applyCoreToggle(toggle, coreKey, deps) {
    const wanted = toggle.checked;
    const previous = chains.get(toggle) || Promise.resolve();
    const gate = paused;
    const run = previous.then(async () => {
        if (!gate) return saveCoreToggle(toggle, coreKey, wanted, deps);
        // Clicked during a reset: the reset may have set the switch since,
        // or the click came after it; either way what it shows now is newest.
        await gate;
        return saveCoreToggle(toggle, coreKey, toggle.checked, deps);
    });
    const settled = run.catch(() => {});
    chains.set(toggle, settled);
    pending.add(settled);
    void settled.then(() => pending.delete(settled));
    return run;
}

/**
 * Pause switch saves for Restore Defaults: resolves once every save started
 * so far has finished, so none lands on top of the reset, and holds the ones
 * clicked from now on until the returned release is called, so none races
 * the reset's own core update and settings save.
 * @returns {Promise<() => void>} release
 */
export async function pauseCoreToggles() {
    const started = [...pending];
    /** @type {() => void} */
    let open = () => {};
    const outer = paused;
    const gate = new Promise((resolve) => { open = () => resolve(undefined); });
    const current = outer ? outer.then(() => gate) : gate;
    paused = current;
    await Promise.all(started);
    return () => {
        open();
        if (paused === current) paused = null;
    };
}

/**
 * @param {{ checked: boolean }} toggle
 * @param {string} coreKey
 * @param {boolean} wanted
 * @param {CoreToggleDeps} deps
 * @returns {Promise<boolean|'restart'|'partial'|'unsaved'>}
 */
async function saveCoreToggle(toggle, coreKey, wanted, deps) {
    const ok = await deps.saveCore({ [coreKey]: wanted });
    const t = deps.texts() || {};
    if (!ok) {
        if (toggle.checked === wanted) toggle.checked = !wanted;
        deps.notify(t.saveFailed || 'Failed to save', 'error');
        return false;
    }
    try {
        await deps.persist(wanted);
    } catch {
        deps.notify(t.saveFailed || 'Failed to save', 'warning');
        return 'unsaved';
    }
    // 'restart' / 'partial': kept, with the notice saveCore already showed.
    if (ok === true) deps.notify(t.settingApplied || 'Applied', 'success');
    return ok;
}
