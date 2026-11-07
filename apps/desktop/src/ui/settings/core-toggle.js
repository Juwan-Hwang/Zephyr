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
/** The number of the latest click of each switch. */
const clicks = new WeakMap();
/** Saves not finished yet, of every switch. */
const pending = new Set();
/** Saves not finished yet, per switch. */
const pendingOf = new WeakMap();
/** The value the core last took for each switch. */
const applied = new WeakMap();
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
 * puts the switch back only when it was the last click: a newer one decides
 * what the switch ends on (on, off, on again with the first save failing
 * leaves it on, as the last save sets). It goes back to the value the core
 * last took, which after queued clicks need not be the opposite of the
 * failed one. When settings.json does not take the value, the core
 * runs it but the next start would bring the old one back, so the save is
 * reported as failed instead of applied.
 * @param {{ checked: boolean }} toggle
 * @param {string} coreKey the core config key (`ipv6`)
 * @param {CoreToggleDeps} deps
 * @returns {Promise<boolean|'restart'|'partial'|'unsaved'>} the outcome of this click
 */
export function applyCoreToggle(toggle, coreKey, deps) {
    const wanted = toggle.checked;
    // With no save of this switch running, it showed what the core runs
    // before this click.
    if (!pendingOf.get(toggle)) applied.set(toggle, !wanted);
    pendingOf.set(toggle, (pendingOf.get(toggle) ?? 0) + 1);
    const click = (clicks.get(toggle) ?? 0) + 1;
    clicks.set(toggle, click);
    const isLatest = () => clicks.get(toggle) === click;
    const previous = chains.get(toggle) || Promise.resolve();
    const gate = paused;
    const run = previous.then(async () => {
        if (gate === null) return saveCoreToggle(toggle, coreKey, wanted, deps, isLatest);
        // Clicked during a reset: the reset may have set the switch since,
        // or the click came after it; either way what it shows now is newest.
        await gate;
        return saveCoreToggle(toggle, coreKey, toggle.checked, deps, isLatest);
    });
    const settled = run.catch(() => {});
    chains.set(toggle, settled);
    pending.add(settled);
    void settled.then(() => {
        pending.delete(settled);
        pendingOf.set(toggle, (pendingOf.get(toggle) ?? 1) - 1);
    });
    return run;
}

/**
 * A mark for {@link coreToggleChangedSince}: the switch's clicks so far.
 * @param {{ checked: boolean }} toggle
 * @returns {number}
 */
export function coreToggleMark(toggle) {
    return clicks.get(toggle) ?? 0;
}

/**
 * Whether the switch was clicked after `mark` was taken, or a save of it is
 * still running: a value read before (the settings page loading) is older
 * than what it shows, so it must not be put on it.
 * @param {{ checked: boolean }} toggle
 * @param {number} mark coreToggleMark(toggle) from before the read
 * @returns {boolean}
 */
export function coreToggleChangedSince(toggle, mark) {
    return (clicks.get(toggle) ?? 0) !== mark || (pendingOf.get(toggle) ?? 0) > 0;
}

/**
 * Record the value the core took for the switch outside its own saves
 * (Restore Defaults sends its defaults in one core update): a click whose
 * save fails afterwards puts the switch back to this value.
 * @param {{ checked: boolean }} toggle
 * @param {boolean} value
 */
export function noteCoreToggleApplied(toggle, value) {
    applied.set(toggle, value);
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
    const current = outer === null ? gate : outer.then(() => gate);
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
 * @param {() => boolean} isLatest whether no click came after this one
 * @returns {Promise<boolean|'restart'|'partial'|'unsaved'>}
 */
async function saveCoreToggle(toggle, coreKey, wanted, deps, isLatest) {
    const ok = await deps.saveCore({ [coreKey]: wanted });
    const t = deps.texts() || {};
    if (!ok) {
        if (isLatest()) toggle.checked = applied.get(toggle) ?? !wanted;
        deps.notify(t.saveFailed || 'Failed to save', 'error');
        return false;
    }
    applied.set(toggle, wanted);
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
