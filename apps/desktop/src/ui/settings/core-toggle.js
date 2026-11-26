// @ts-check
/**
 * A settings switch that changes the core config (unified delay, IPv6, allow
 * LAN): applied through `update_config`, then kept in settings.json, which
 * overrides every profile when the core starts.
 *
 * @module ui/settings/core-toggle
 */

import { coreReplacements } from '../../api.js';

/** The request chain of each switch, so its saves run in click order. */
const chains = new WeakMap();
/** The number of the latest click of each switch. */
const clicks = new WeakMap();
/** Saves not finished yet, of every switch. */
const pending = new Set();
/** Saves not finished yet, per switch. */
const pendingOf = new WeakMap();
/**
 * The value the core last took for each switch, with the core replacement
 * count it was recorded under. A save that needs a core restart, or Restore
 * Defaults that does, leaves it as it was: the core still runs it while the
 * switch shows the new value. Once the core was replaced it starts with the
 * values settings.json holds, which the switch shows, so the record no
 * longer says what it runs.
 * @type {WeakMap<object, { value: boolean|undefined, generation: number }>}
 */
const applied = new WeakMap();

/**
 * @param {object} toggle
 * @param {boolean} value
 */
function recordApplied(toggle, value, generation = coreReplacements()) {
    applied.set(toggle, { value, generation });
    if ('indeterminate' in toggle) toggle.indeterminate = false;
}

/** Keep a generation-tagged unknown record so the next click cannot infer
 * the old running value from the checkbox after an unconfirmed reload.
 * @param {object} toggle @param {number} generation
 */
function recordUnconfirmed(toggle, generation) {
    applied.set(toggle, { value: undefined, generation });
    if ('indeterminate' in toggle) toggle.indeterminate = true;
}

/**
 * The value recorded for the core running now; none once the core was
 * replaced since (the new one started with what settings.json holds).
 * @param {object} toggle
 * @returns {boolean|undefined}
 */
function appliedValue(toggle) {
    const recorded = applied.get(toggle);
    return recorded && recorded.generation === coreReplacements() ? recorded.value : undefined;
}
/**
 * While Restore Defaults runs: resolves when it is done. A click meanwhile
 * saves once it is, with the value the switch shows then.
 * @type {Promise<void>|null}
 */
let paused = null;
/** Restore Defaults runs not released yet: the switches stay paused until none is left. */
let pauses = 0;
/** Restore Defaults runs started so far. */
let resets = 0;
/**
 * What each switch showed before its first click held by a reset: clicks
 * held do not reach the core, so this is still what it runs.
 */
let shownBeforeHeld = new WeakMap();

/**
 * The value settings.json last took for each switch: what a core started
 * after the record of the running one went stale (a restart) runs.
 * @type {WeakMap<object, boolean>}
 */
const persistedValue = new WeakMap();

/**
 * @typedef {Object} CoreToggleDeps
 * @property {(patch: Record<string, any>) => Promise<boolean|'restart'|'partial'|'unconfirmed'>} saveCore
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
 * @returns {Promise<boolean|'restart'|'partial'|'unconfirmed'|'unsaved'>} the outcome of this click
 */
export function applyCoreToggle(toggle, coreKey, deps) {
    const wanted = toggle.checked;
    // With no save of this switch running and nothing recorded for the core
    // running now, it showed what the core runs before this click. A value
    // recorded for this core wins: the page may show the saved preference
    // while the core runs another, or a save or reset that needs a restart
    // left the core on the old value. Not while Restore Defaults runs: the
    // switch then shows the default it is setting, and the reset noted what
    // the core runs before changing it (noteCoreToggleApplied). A value
    // recorded for a core since replaced says the new core started from
    // settings.json: it runs the value saved there, which the switch may not
    // show (a save that the core took and settings.json did not).
    const recorded = applied.get(toggle);
    if (!pendingOf.get(toggle) && paused === null && recorded?.generation !== coreReplacements()) {
        recordApplied(toggle, recorded && persistedValue.has(toggle) ? Boolean(persistedValue.get(toggle)) : !wanted);
    }
    // Before its first click the switch shows the saved value.
    if (!pendingOf.get(toggle) && paused === null && !persistedValue.has(toggle)) persistedValue.set(toggle, !wanted);
    pendingOf.set(toggle, (pendingOf.get(toggle) ?? 0) + 1);
    const click = (clicks.get(toggle) ?? 0) + 1;
    clicks.set(toggle, click);
    const isLatest = () => clicks.get(toggle) === click;
    const previous = chains.get(toggle) || Promise.resolve();
    const gate = paused;
    if (gate !== null && !shownBeforeHeld.has(toggle)) shownBeforeHeld.set(toggle, !wanted);
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
 * @typedef {Object} CoreToggleMark
 * @property {number} clicks the switch's clicks so far
 * @property {number} resets Restore Defaults runs started so far
 * @property {boolean} busy a save of the switch, or a reset, was running
 */

/**
 * A mark for {@link coreToggleChangedSince}: where a read of the switch's
 * value starts.
 * @param {{ checked: boolean }} toggle
 * @returns {CoreToggleMark}
 */
export function coreToggleMark(toggle) {
    return {
        clicks: clicks.get(toggle) ?? 0,
        resets,
        busy: (pendingOf.get(toggle) ?? 0) > 0 || paused !== null,
    };
}

/**
 * Whether the switch may show something newer than a value read since
 * `mark` was taken (the settings page loading), so that value must not be
 * put on it: the switch was clicked, Restore Defaults ran or is running, a
 * save of it is still running, or one was running when the mark was taken
 * (the read may hold the value from before that save, also once it has
 * finished).
 * @param {{ checked: boolean }} toggle
 * @param {CoreToggleMark} mark coreToggleMark(toggle) from before the read
 * @returns {boolean}
 */
export function coreToggleChangedSince(toggle, mark) {
    return mark.busy
        || mark.resets !== resets
        || (clicks.get(toggle) ?? 0) !== mark.clicks
        || (pendingOf.get(toggle) ?? 0) > 0
        || paused !== null;
}

/**
 * Record the value the core took for the switch outside its own saves
 * (Restore Defaults sends its defaults in one core update): a click whose
 * save fails afterwards puts the switch back to this value.
 * @param {{ checked: boolean }} toggle
 * @param {boolean} value
 */
export function noteCoreToggleApplied(toggle, value) {
    recordApplied(toggle, value);
}

/** A reset may have changed this running value without confirming it. @param {{ checked: boolean }} toggle */
export function noteCoreToggleUnconfirmed(toggle) {
    recordUnconfirmed(toggle, coreReplacements());
}

/**
 * Record the value settings.json holds for the switch after a write outside
 * its own saves (Restore Defaults clears the preference): a core started
 * later runs it. `undefined` when it is not known.
 * @param {{ checked: boolean }} toggle
 * @param {boolean|undefined} value
 */
export function noteCoreTogglePersisted(toggle, value) {
    if (value === undefined) persistedValue.delete(toggle);
    else persistedValue.set(toggle, value);
}

/**
 * The value the core last took for the switch, when one is recorded.
 * @param {{ checked: boolean }} toggle
 * @returns {boolean|undefined}
 */
export function coreToggleApplied(toggle) {
    return appliedValue(toggle);
}

/**
 * The value the core runs for the switch once its saves have finished (the
 * reset's pause waits for them): the value the core last accepted, which a
 * click held by the reset has not changed. Without a record for the core
 * running now (it restarted and read settings.json), the value last saved
 * there; without either, what the switch showed before such a click.
 * @param {{ checked: boolean }} toggle
 * @returns {boolean}
 */
export function coreToggleShownBeforeHeld(toggle) {
    const value = appliedValue(toggle);
    if (value !== undefined) return value;
    if (persistedValue.has(toggle)) return Boolean(persistedValue.get(toggle));
    return shownBeforeHeld.has(toggle) ? Boolean(shownBeforeHeld.get(toggle)) : toggle.checked;
}

/**
 * Whether the switch was clicked since the running reset paused the saves:
 * that click is held, and the switch keeps showing what the user chose.
 * @param {{ checked: boolean }} toggle
 * @returns {boolean}
 */
export function coreToggleClickedDuringReset(toggle) {
    return shownBeforeHeld.has(toggle);
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
    resets += 1;
    pauses += 1;
    /** @type {() => void} */
    let open = () => {};
    const outer = paused;
    const gate = new Promise((resolve) => { open = () => resolve(undefined); });
    // Clicks held now wait for every reset still running, this one too.
    paused = outer === null ? gate : Promise.all([outer, gate]).then(() => undefined);
    await Promise.all(started);
    let released = false;
    return () => {
        if (released) return;
        released = true;
        open();
        pauses -= 1;
        if (pauses === 0) {
            paused = null;
            shownBeforeHeld = new WeakMap();
        }
    };
}

/**
 * @param {{ checked: boolean }} toggle
 * @param {string} coreKey
 * @param {boolean} wanted
 * @param {CoreToggleDeps} deps
 * @param {() => boolean} isLatest whether no click came after this one
 * @returns {Promise<boolean|'restart'|'partial'|'unconfirmed'|'unsaved'>}
 */
async function saveCoreToggle(toggle, coreKey, wanted, deps, isLatest) {
    // The core the save goes to: what it takes is recorded for it, not for
    // a core that replaced it while the save ran.
    const generationAtSave = coreReplacements();
    const ok = await deps.saveCore({ [coreKey]: wanted });
    const t = deps.texts() || {};
    if (!ok) {
        // saveCore has told the user why already: no second error toast.
        // With no record for the core running now (it restarted during the
        // saves), it runs the value last saved, not this click's opposite.
        const recorded = applied.get(toggle);
        const unknown = recorded?.generation === coreReplacements() && recorded.value === undefined;
        if (isLatest() && !unknown) toggle.checked = appliedValue(toggle) ?? persistedValue.get(toggle) ?? !wanted;
        if (isLatest() && unknown && 'indeterminate' in toggle) toggle.indeterminate = true;
        return false;
    }
    // 'restart': the files hold the value, the core runs the old one until
    // it restarts, so the record of what it runs stays as it was.
    if (ok === true || ok === 'partial') recordApplied(toggle, wanted, generationAtSave);
    else if (ok === 'unconfirmed') recordUnconfirmed(toggle, generationAtSave);
    else if (ok === 'restart' && isLatest()) {
        const recorded = applied.get(toggle);
        if (recorded?.generation === coreReplacements() && recorded.value === undefined) {
            recordUnconfirmed(toggle, recorded.generation);
        }
    }
    try {
        await deps.persist(wanted);
        persistedValue.set(toggle, wanted);
    } catch {
        deps.notify(t.saveFailed || 'Failed to save', 'warning');
        // A core started meanwhile read settings.json, which still holds the
        // value saved before: that is what it runs, so the switch shows it.
        if (coreReplacements() !== generationAtSave && isLatest() && persistedValue.has(toggle)) {
            toggle.checked = Boolean(persistedValue.get(toggle));
        }
        return 'unsaved';
    }
    // A core started between the two writes read settings.json from before
    // them (it overrides every profile), so it may run the old value: the
    // value goes to it as well (the save waits for that start to finish).
    // Also when a newer click is queued: its save may fail, and the switch
    // then goes back to the value recorded here, which the core must run.
    let outcome = ok;
    if (ok !== 'restart' && coreReplacements() !== generationAtSave) {
        const generationAgain = coreReplacements();
        const again = await deps.saveCore({ [coreKey]: wanted });
        // Not taken: settings.json holds the value for the next start, and
        // saveCore has told the user why.
        if (!again) return 'partial';
        if (again === true || again === 'partial') recordApplied(toggle, wanted, generationAgain);
        else if (again === 'unconfirmed') recordUnconfirmed(toggle, generationAgain);
        // The replacement core decides what this click achieved: 'restart'
        // there means it does not run the value yet.
        outcome = again;
    }
    // 'restart' / 'partial': kept, with the notice saveCore already showed.
    if (outcome === true) deps.notify(t.settingApplied || 'Applied', 'success');
    return outcome;
}
