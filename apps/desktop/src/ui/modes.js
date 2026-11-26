// @ts-check
/**
 * Mode selector logic - switch between Rule/Global/Direct modes.
 * Extracted from ui.js for modularity.
 */

import { invoke, closeAllConnections, switchProxyResult, SWITCH_BUSY, getProxies, SPECIAL_PROXY_NAMES, proxySwitchMark, proxySwitchedSince, settleProxySwitches, coreReplacements } from '../api.js';
import { fetchProxyGroups } from './proxy-groups.js';
import { showNotification } from './notifications.js';
import { translations, currentLang } from '../i18n.js';
import { invalidateSettingsCache } from './cache.js';
import { Bus, Events } from './events.js';
import { modesLogger } from '../utils/logger.js';
import { toError } from '../types/guards.js';
import { appStore } from './state.js';
import { COMMANDS } from '@zephyr/shared';
import { readRunningProfile } from './running-profile.js';
import { knownSelectionRevision, knownSelectionChangedSince, knownSelection } from './known-selection.js';

export function initModeSelector() {
    const buttons = document.querySelectorAll('[data-mode]');
    buttons.forEach((btn) => {
        /** @type {HTMLElement} */ (btn).onclick = () => {
            const mode = /** @type {string} */ (btn.getAttribute('data-mode'));
            applyMode(mode).catch((err) => {
                showNotification(toError(err).toString(), 'error');
            });
        };
    });
}

/**
 * Switch the core to `mode` and bring every surface along (mode buttons, proxies page,
 * tray via MODE_CHANGED). Shared by the mode buttons and the global shortcut so both
 * paths behave identically. The selected node is carried over when the target mode
 * still offers it; when it cannot be, a warning says so.
 * @param {string} mode
 * @param {{ silent?: boolean }} [opts] silent: the caller reports the outcome itself
 * @returns {Promise<false | 'ok' | 'partial'>} false when another network change is in
 *   progress; 'partial' when the mode changed but the selected node could not carry over
 * @throws when the backend rejects the mode change (the UI is reconciled with the
 *   live core before the error propagates)
 */
export async function applyMode(mode, { silent = false } = {}) {
    if (appStore.get('isNetworkUpdating')) return false;
    const container = document.getElementById('mode-selector-container');
    /** @type {Record<string, string>} */
    const t = /** @type {Record<string, string>} */ (/** @type {any} */ (translations)[currentLang] || /** @type {any} */ (translations).en);
    appStore.set('isNetworkUpdating', true);
    if (container) container.classList.add('opacity-50', 'cursor-not-allowed');

    try {
        // A choice recorded from here on (the user picking a node while the
        // node is read, the mode switches or the groups load) is newer than
        // the carried node and stays.
        const revisionBefore = knownSelectionRevision();
        // Likewise a node switch sent from here on, or one still on its way.
        const switchMark = proxySwitchMark();
        // The group the node is read from: the carry targets it, and one the
        // user opens from here on stays open.
        const groupBefore = appStore.get('uiGroupName');
        // The profile the node belongs to, read before the node: the carry
        // does nothing once another one runs (a resume restart that loaded
        // a fallback profile, say). null: unreadable, nothing is carried.
        const profileBefore = await readRunningProfile();
        // The core the node is read from: one replaced from here on (a
        // restart after resume, also of the same profile) runs its own
        // selection, and the node is not carried to it.
        const coreBefore = coreReplacements();
        // 1. Capture current node for inheritance
        let nodeToInherit = null;
        try {
            const preferredGroupName = groupBefore || null;
            const resultBefore = await fetchProxyGroups({ preferredGroupName });
            if (resultBefore) {
                nodeToInherit = resultBefore.current;
            }
        } catch (e) { modesLogger.warn("Failed to capture node for inheritance", e); }

        // 2. Switch mode (hot-reload via REST API — instant)
        // Routed through the backend so the user-mode generation bump
        // happens under the restore lock; otherwise an in-flight
        // fallback restore could overwrite the user's choice. The
        // backend persists the accepted mode to settings.json itself.
        try {
            await invoke(COMMANDS.SWITCH_MODE, { mode });
        } catch (err) {
            // The backend can apply the mode to the core and still fail
            // (e.g. the settings write failed after the core PUT), so
            // reconcile the buttons with the live core instead of leaving
            // the previous mode highlighted. Awaited while the switch guard
            // is still held, so a later switch cannot be overwritten by
            // this older snapshot.
            try {
                const m = await import('./proxies.js');
                await m.syncCoreConfig();
            } catch (e) {
                modesLogger.warn('Failed to reconcile mode after switch failure', e);
            }
            throw err;
        }
        // Publish the new mode before any further await, so a
        // syncCoreConfig() already in flight sees the switch and does
        // not roll the UI and tray back to the old mode.
        appStore.set('currentOutboundMode', mode);
        // The backend writes settings.json, so drop the cached snapshot:
        // other readers take the mode from `getSettingsCached()`.
        invalidateSettingsCache();
        updateModeUI(mode);

        // 3. Close existing connections (fire-and-forget). The mode change has
        // already been applied and persisted; when the core is stopped this
        // rejects, which must not report the switch as failed.
        closeAllConnections().catch((e) =>
            modesLogger.warn("Failed to close connections", e)
        );

        // 4. Inherit node in target mode. The mode switch already succeeded,
        // so a failed inheritance must not fail the whole action.
        const inherited = await carryNodeOver(nodeToInherit, mode, { revisionBefore, switchMark, groupBefore, profileBefore, coreBefore });

        import('./proxies.js').then(m => m.refreshProxies()).catch(() => {});
        if (!inherited && !silent) {
            // Part success is not full success: tell the user the node did not
            // carry over instead of booking it as applied.
            showNotification(`${t.configSuccess} — ${t.notifSwitchFailed}`, 'warning');
        }
        // Reactive: subscribe() in initReactiveBindings() handles tray menu update
        Bus.emit(Events.MODE_CHANGED, mode);
        return inherited ? 'ok' : 'partial';
    } finally {
        appStore.set('isNetworkUpdating', false);
        if (container) container.classList.remove('opacity-50', 'cursor-not-allowed');
    }
}

/**
 * Carry the previously selected node into the group the new mode exposes.
 * @param {string|null} nodeToInherit
 * @param {string} mode
 * @param {{ revisionBefore: number, switchMark: number, groupBefore: any, profileBefore: string|null, coreBefore: number }} marks
 *   knownSelectionRevision(), proxySwitchMark(), the open group and the
 *   running profile, all taken before the node was read
 * @returns {Promise<boolean>} false when the node could not be carried over
 */
async function carryNodeOver(nodeToInherit, mode, { revisionBefore, switchMark, groupBefore, profileBefore, coreBefore }) {
    // A built-in selection (GLOBAL's default DIRECT, say) is not a node the
    // user picked, so there is nothing to carry over or to report as lost.
    if (!nodeToInherit || mode === 'direct'
        || SPECIAL_PROXY_NAMES.has(String(nodeToInherit).toUpperCase())) {
        if (mode === 'global' && appStore.get('currentOutboundMode') === mode
            && appStore.get('uiGroupName') === groupBefore && coreReplacements() === coreBefore) {
            appStore.set('uiGroupName', 'GLOBAL');
        }
        return true;
    }
    try {
        const preferredGroupName = groupBefore || null;
        const resultAfter = await fetchProxyGroups({ preferredGroupName });
        // No group could be read, so the node was not carried over.
        if (!resultAfter) return false;
        if (resultAfter.proxies.includes(nodeToInherit)) {
            // Use uiGroupName from resolver for accurate group targeting
            const targetGroup = resultAfter.uiGroupName || resultAfter.mainGroup;
            if (!targetGroup) return true;
            return await switchCarriedNode(targetGroup, nodeToInherit, { groupBefore, revisionBefore, switchMark, profileBefore, coreBefore });
        }
        // The previous node is not present in the target group, so it cannot
        // carry over and the group keeps its default selection. (When the group
        // already routes to the same node through a nested group, nothing changed.)
        if (await activeLeafMatches(resultAfter.current, nodeToInherit)) return true;
        modesLogger.warn('Node to inherit is not available in the target group');
        return false;
    } catch (e) {
        modesLogger.warn("Failed to carry the node over", e);
        return false;
    }
}

/**
 * Whether a choice other than `node` was recorded for `profile` since
 * `revisionBefore`. A late record of `node` itself (a card switch to it that
 * landed before the mode change and saved during it) is no newer choice:
 * that node is still the one to carry.
 * @param {number} revisionBefore
 * @param {string} profile
 * @param {string} node
 * @returns {boolean}
 */
function newerChoiceSince(revisionBefore, profile, node) {
    if (!knownSelectionChangedSince(revisionBefore, profile)) return false;
    return knownSelection(profile)?.node !== node;
}

/**
 * Switch the target group to the carried node, open that group unless the
 * user opened another one since `groupBefore`, and save the node as the
 * profile's choice (a restart then restores it). Nothing is switched when a
 * newer choice was recorded for the profile, when a node switch was sent
 * meanwhile or is still on its way (it may be the user's, and land after
 * this one), when the running profile cannot be read (whether the user
 * picked a node meanwhile cannot be told), or when another profile runs
 * than the one the node was read from.
 * @param {string} targetGroup
 * @param {string} node
 * @param {{ groupBefore: any, revisionBefore: number, switchMark: number, profileBefore: string|null, coreBefore: number }} before
 *   what was open, known and running when the carry started
 * @returns {Promise<boolean>} whether the node is carried over (or a newer choice stands)
 */
async function switchCarriedNode(targetGroup, node, { groupBefore, revisionBefore, switchMark, profileBefore, coreBefore }) {
    if (profileBefore === null) return false;
    if (coreReplacements() !== coreBefore) return true;
    const profile = await readRunningProfile();
    if (profile === null) return false;
    // Another profile came up since the node was read: the node is not one
    // of its choices, and its same-named group is another group.
    if (profile !== profileBefore) {
        modesLogger.info('Node not carried over: another profile runs now');
        return true;
    }
    // The user picked a node since the carried one was read: theirs stays,
    // and nothing was lost.
    if (profile && newerChoiceSince(revisionBefore, profile, node)) return true;
    // A switch still on its way gets its answer first (at most 3 s), so
    // one the core refuses no longer stands in for this carry. One that
    // landed may be the user's: it stays. One the core refused changed
    // nothing: the node is still carried.
    await settleProxySwitches(3000);
    if (proxySwitchedSince(switchMark, 0, { landedOnly: true })) return true;
    // Checked again after that wait: the core may have been replaced, or
    // another profile brought up, or a choice recorded, while it ran.
    if (coreReplacements() !== coreBefore) {
        modesLogger.info('Node not carried over: the core changed while switches settled');
        return true;
    }
    const profileAfterSettle = await readRunningProfile();
    // Unreadable now: whether the user picked a node meanwhile cannot be
    // told, the same as when it is unreadable before.
    if (profileAfterSettle === null) return false;
    if (profileAfterSettle !== profile) {
        modesLogger.info('Node not carried over: another profile runs now');
        return true;
    }
    if (profile && newerChoiceSince(revisionBefore, profile, node)) return true;
    if (coreReplacements() !== coreBefore) return true;
    // Checked again when its turn comes: a node switch started since the
    // checks above (the user's pick, made while the profile was read, goes
    // out first) and taken by the core stays, as before. A core restart
    // begun meanwhile drops it in switchProxyResult itself.
    const result = await switchProxyResult(targetGroup, node, {
        // A choice recorded since (a delayed save of a switch the core took
        // before switchMark) is newer than the carried node too.
        canSend: () => !proxySwitchedSince(switchMark, 1, { landedOnly: true, ownInFlight: 1 })
            && !(profile && newerChoiceSince(revisionBefore, profile, node)),
    });
    if (result.reason === SWITCH_BUSY) {
        modesLogger.info('Node not carried over: a node switch or core restart came first');
        return true;
    }
    // An HTTP refusal of a plain group PUT is thrown, as before; a `false`
    // result is the reserved GLOBAL selection rejected by the backend.
    if (result.error) throw result.error;
    // Sent with no answer (an unconfirmed GLOBAL switch): it may run now, so
    // it is kept and saved like an applied one, and an older saved node is
    // not restored over it later.
    if (!result.ok && !result.maybeApplied) {
        modesLogger.warn('Node inheritance switch was not applied');
        return false;
    }
    // A group the user opened since the carry started stays open, and a
    // core that replaced this one meanwhile (whose profile may not have the
    // group) leaves the page to follow it.
    if (appStore.get('uiGroupName') === groupBefore && coreReplacements() === coreBefore) {
        appStore.set('uiGroupName', targetGroup);
    }
    // Saved like any other choice: a restart restores it, and a profile
    // switch whose read of the live selection times out saves it. Only when
    // the same profile still runs and no newer choice came in for it.
    // A core replaced during the switch runs its own selection, whatever
    // profile it loaded.
    if (profile && await readRunningProfile() === profile && coreReplacements() === coreBefore) {
        const { saveProxySelection } = await import('./proxy-memory.js');
        // Checked after the import, right before the save (it records
        // first): a choice recorded while the module loaded is newer, and a
        // core that replaced this one meanwhile runs its own selection.
        if (!newerChoiceSince(revisionBefore, profile, node) && coreReplacements() === coreBefore) {
            await saveProxySelection(profile, { group: targetGroup, node });
        }
    }
    return true;
}

/** Outbound modes in selector order. */
const MODES = ['rule', 'global', 'direct'];

/**
 * Reflect `mode` on the home mode selector (slider, highlight, aria-pressed).
 * @param {string} mode
 */
export function updateModeUI(mode) {
    const target = String(mode ?? '').toLowerCase();
    const idx = MODES.indexOf(target);
    if (idx === -1) return;

    const slider = document.getElementById('mode-slider');
    if (slider) slider.style.transform = `translateX(calc(var(--rtl-sign, 1) * ${idx * 100}%))`;

    // Only the home mode selector: other [data-mode] elements (connection rows,
    // the console's own selector) must not pick up these classes.
    document.querySelectorAll('#mode-selector-container button[data-mode]').forEach((b) => {
        const active = b.getAttribute('data-mode') === target;
        b.classList.toggle('text-[var(--text-primary)]', active);
        b.classList.toggle('text-[var(--text-secondary)]', !active);
        b.setAttribute('aria-pressed', String(active));
    });
}

/**
 * Whether the target group's selection already routes to the same node as the
 * previous selection, resolving nested groups down to their active leaf.
 * @param {string|null|undefined} current
 * @param {string|null|undefined} previous
 * @returns {Promise<boolean>}
 */
async function activeLeafMatches(current, previous) {
    if (!current || !previous) return false;
    try {
        const [{ resolveLeafNode }, data] = await Promise.all([import('./proxies.js'), getProxies()]);
        const proxyMap = /** @type {{proxies?: Record<string, any>}} */ (data)?.proxies;
        if (!proxyMap) return false;
        return resolveLeafNode(current, proxyMap) === resolveLeafNode(previous, proxyMap);
    } catch (e) {
        modesLogger.warn('Failed to resolve active node for inheritance check', e);
        return false;
    }
}
