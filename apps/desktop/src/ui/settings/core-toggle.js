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
    const run = previous.then(() => saveCoreToggle(toggle, coreKey, wanted, deps));
    chains.set(toggle, run.catch(() => {}));
    return run;
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
