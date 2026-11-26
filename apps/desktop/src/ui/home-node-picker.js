// @ts-check
/**
 * Minimal home: the node list that opens upward from the current-node bar.
 * One row per node of the main group; a click switches to it.
 */

import { getProxies, getProxiesMerged, switchProxyResult, SWITCH_BUSY, abortLatencyTests, closeAllConnections, isLatestSwitch, coreReplacements } from '../api.js';
import { noNetworkChangeSince } from './network-change.js';
import { homeNodePickerLogger } from '../utils/logger.js';
import { t } from '../i18n.js';
import { fetchProxyGroups } from './proxy-groups.js';
import { syncCoreConfig, renderProxies, notifySwitchFailed, resolveLeafNode } from './proxies.js';
import { appStore } from './state.js';
import { invalidateProxiesCache } from './cache.js';
import { readRunningProfile } from './running-profile.js';
import { saveProxySelection } from './proxy-memory.js';
import { resetObservedGroup } from './observed-group.js';
import { getDelayColorClass } from '../utils/format.js';
import { splitFlag } from './home-stats.js';
import { showNotification } from './notifications.js';
import { Bus, Events } from './events.js';

/**
 * The profile a node switch is filed under, read in the switch's turn and
 * again when its selection is saved: a failed read is no profile, and then
 * nothing is saved.
 * @returns {Promise<string>}
 */
async function profileForSwitch() {
    // Live: a cached read could still name the profile a switch replaced.
    return (await readRunningProfile()) ?? '';
}


/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {string} groupName
 * @returns {Promise<string | null>}
 */
const getCurrentNodeForGroup = async (groupName) => {
    const data = await getProxies();
    /** @type {any} */
    const d = data;
    return d?.proxies?.[groupName]?.now || null;
};

/**
 * @param {string} groupName
 * @param {string | null} expectedName
 * @param {number} [maxRetries]
 * @param {number} [intervalMs]
 * @returns {Promise<string | null>}
 */
const waitForCurrentNode = async (groupName, expectedName, maxRetries = 10, intervalMs = 250) => {
    for (let i = 0; i < maxRetries; i++) {
        const current = await getCurrentNodeForGroup(groupName);
        if (!expectedName) return current;
        if (current === expectedName) return current;
        await sleep(intervalMs);
    }
    const finalCurrent = await getCurrentNodeForGroup(groupName);
    return finalCurrent || expectedName;
};

/** @type {number} Session counter to prevent race conditions on rapid switches */
let _switchSessionCounter = 0;
/** Session of the newest switch the core accepted; drives which selection is saved. */
let _acceptedSession = 0;
/** Tail of the serialized proxy-selection saves. */
let _selectionSave = Promise.resolve();
/** Last node name the pill showed outside a pending switch (rollback target). */
let _lastSettledName = '';
/** The "switching…" text as last written, in the language of that moment. */
let _pendingLabel = '';

/**
 * Whether the pill shows the pending "switching…" label, even when the
 * language changed since it was written.
 * @param {string | null | undefined} text
 */
function isPendingLabel(text) {
    return !!text && (text === t('switching') || text === _pendingLabel);
}
/** Sessions whose switch request has not answered yet. */
const _pendingSessions = new Set();

/**
 * Whether an accepted switch may redraw the pill: it is the newest switch the core
 * accepted, and no newer click is still waiting for its answer.
 * @param {number} session
 */
function ownsDisplay(session) {
    if (_acceptedSession !== session) return false;
    for (const pending of _pendingSessions) if (pending > session) return false;
    return true;
}

/**
 * Handle a node switch picked in the list, including UI updates and recovery.
 * @param {HTMLElement} trigger
 * @param {string} mainGroup
 * @param {string} name
 * @param {boolean} skipIfCurrent a row of the list: a click on the node in use does nothing
 */
async function handlePickerSwitch(trigger, mainGroup, name, skipIfCurrent) {
    // A mode switch, TUN toggle or profile change may still carry the previous node over
    // when it finishes; a switch now would race it and could be undone.
    if (appStore.get('isNetworkUpdating')) {
        closePicker();
        showNotification(t('consoleSubUpdateBusy'), 'info');
        return;
    }
    const nameEl = trigger.querySelector('#current-node-name');
    const shownName = nameEl ? nameEl.textContent : '';
    // While an earlier switch is in flight the pill reads "switching…"; roll back to the
    // last real name instead of that transient label.
    const previousName = isPendingLabel(shownName) ? _lastSettledName : shownName;
    _lastSettledName = previousName;
    if (nameEl) {
        nameEl.textContent = t('switching');
        _pendingLabel = nameEl.textContent;
    }
    closePicker();

    // Use session counter to prevent race conditions on rapid switches
    // Increment BEFORE async operations to maintain click order
    const currentSession = ++_switchSessionCounter;
    _pendingSessions.add(currentSession);
    // The core the switch was made on: one that replaced it meanwhile runs
    // its own selection and keeps its connections.
    const coreAtClick = coreReplacements();

    // The group the row came from: a render that changed the store's group
    // since the list loaded must not send this node to another group.
    const targetGroup = mainGroup || appStore.get('uiGroupName');
    const networkUnchanged = noNetworkChangeSince();
    let success = false;
    let unchanged = false;
    /** @type {unknown} */
    let failure = null;
    /** The switch reached the core and went unanswered. */
    let maybeApplied = false;
    // The profile the click was made under, read in the switch's turn so a
    // later click cannot go out first: a profile switch while the request
    // runs must not file this node under the one that replaced it.
    let profileAtClick = '';
    /** @type {number | undefined} */
    let switchSeq;
    try {
        ({ ok: success, reason: failure, maybeApplied = false, prepared: profileAtClick = '', seq: switchSeq, unchanged = false } = await switchProxyResult(targetGroup, name, {
            prepare: profileForSwitch,
            // The queue reads the actual selection; the displayed label can lag it.
            skipIfCurrent,
            beforeSend: abortLatencyTests,
            // A change that began meanwhile could carry its own node over
            // this switch, or take it to the core that replaces this one.
            canSend: () => networkUnchanged() && (!appStore.get('uiGroupName') || appStore.get('uiGroupName') === targetGroup),
        }));
    } catch (error) {
        failure = error;
        homeNodePickerLogger.error('Node switch failed:', error);
    }
    if (failure === SWITCH_BUSY) {
        _pendingSessions.delete(currentSession);
        if (_switchSessionCounter === currentSession && nameEl && isPendingLabel(nameEl.textContent)) {
            nameEl.textContent = previousName;
        }
        showNotification(t('consoleSubUpdateBusy'), 'info');
        // An earlier click the core took may have left its redraw to this
        // one (it no longer owned the display): the label follows the core.
        syncCoreConfig(() => _pendingSessions.size === 0).catch(() => {});
        return;
    }
    _pendingSessions.delete(currentSession);
    if (unchanged) {
        if (_switchSessionCounter === currentSession && nameEl && isPendingLabel(nameEl.textContent)) {
            nameEl.textContent = previousName;
        }
        syncCoreConfig(() => _pendingSessions.size === 0).catch(() => {});
        return;
    }
    if (success) {
        // Responses can land out of order: only a newer accepted switch supersedes this one.
        if (currentSession > _acceptedSession) _acceptedSession = currentSession;
        if (coreReplacements() !== coreAtClick) {
            invalidateProxiesCache();
            if (_switchSessionCounter === currentSession && nameEl && isPendingLabel(nameEl.textContent)) {
                nameEl.textContent = previousName;
            }
            syncCoreConfig(() => _pendingSessions.size === 0).catch(() => {});
            return;
        }
        await afterPickerSwitch(targetGroup, name, currentSession, profileAtClick, switchSeq, coreAtClick);
        return;
    }
    // A GLOBAL selection is routed through the backend and reported as a
    // rejected request instead of a thrown error, so surface it here rather
    // than failing silently on a user-initiated switch.
    homeNodePickerLogger.warn('Node switch was not applied');
    // A newer switch owns the display now; restoring the pill, reporting this
    // one as failed or resyncing from it would describe the wrong selection.
    if (_switchSessionCounter !== currentSession) {
        const error = /** @type {any} */ (failure);
        if (maybeApplied || failure instanceof TypeError || (error?.name === 'ApiError' && error.status == null)) {
            // An unanswered older request may have landed after the newer
            // click's refresh. Read live state without replaying its notification.
            invalidateProxiesCache();
            syncCoreConfig(() => _pendingSessions.size === 0).catch(() => {});
        }
        return;
    }
    // Never leave the pill on "switching…": put the old name back, then resync.
    if (nameEl && isPendingLabel(nameEl.textContent)) nameEl.textContent = previousName;
    // The cards notifySwitchFailed may redraw read what the core runs.
    invalidateProxiesCache();
    // An unknown outcome is re-read by notifySwitchFailed itself.
    if (!notifySwitchFailed(failure, maybeApplied)) syncCoreConfig(() => _pendingSessions.size === 0).catch(() => {});
}

/**
 * Bookkeeping after an accepted switch from the node list: drop stale caches, save the
 * selection, then let syncCoreConfig() redraw once the core reports the node.
 * @param {string} targetGroup
 * @param {string} name
 * @param {number} currentSession
 * @param {string} profileAtClick the profile the switch was clicked under
 * @param {number} [switchSeq] the switch's number, for isLatestSwitch
 */
async function afterPickerSwitch(targetGroup, name, currentSession, profileAtClick, switchSeq, coreAtClick = coreReplacements()) {
    invalidateProxiesCache();
    // A later switch the core took (any group, any surface) already closed
    // the connections: closing them again would cut the ones opened on its
    // node. The display follows what the core runs instead.
    if (!isLatestSwitch(targetGroup, switchSeq)) {
        const pill = document.getElementById('current-node-name');
        if (_switchSessionCounter === currentSession && pill && isPendingLabel(pill.textContent)) {
            pill.textContent = _lastSettledName;
        }
        syncCoreConfig(() => _pendingSessions.size === 0).catch(() => {});
        return;
    }
    // The observed exit node described the old selection; drop it so the pill
    // and home figures follow the new node (the watcher re-confirms it if active).
    resetObservedGroup();
    // The core already took the switch: a failed cleanup must not stop the rest.
    try { await closeAllConnections(); } catch (e) { homeNodePickerLogger.warn('Failed to close connections after switch', e); }
    // Replaced while the connections closed: the core running now has its
    // own selection, so nothing of this switch is recorded or waited for.
    if (coreReplacements() !== coreAtClick) {
        invalidateProxiesCache();
        // Never left on "switching…": the label shows what the new core runs.
        const pill = document.getElementById('current-node-name');
        if (_switchSessionCounter === currentSession && pill && isPendingLabel(pill.textContent)) {
            pill.textContent = _lastSettledName;
        }
        syncCoreConfig(() => _pendingSessions.size === 0).catch(() => {});
        return;
    }

    // Save proxy selection for restore after core restart. Saves run one at a time and
    // only for the newest accepted switch, so an older selection can never be written last.
    _selectionSave = _selectionSave.then(async () => {
        // A later click that fails must not drop this save: the core still runs this
        // node. Only a newer switch the core also accepted makes it stale.
        if (_acceptedSession !== currentSession) return;
        const profileName = await profileForSwitch();
        // A later switch from another surface (a node card) stands over this one too.
        if (profileName && profileName === profileAtClick && _acceptedSession === currentSession
            && isLatestSwitch(targetGroup, switchSeq)) {
            await saveProxySelection(profileName, { node: name, group: targetGroup });
        }
    }).catch((e) => {
        homeNodePickerLogger.warn('Failed to save proxy selection', e);
    });
    await _selectionSave;

    // Wait for node switch to complete, then let syncCoreConfig() handle display
    // Run as non-blocking IIFE to prevent UI lag
    void (async () => {
        try {
            await waitForCurrentNode(targetGroup, name);
            // The newest accepted switch redraws, even when a newer click failed meanwhile
            // (its resync may have read the core before this switch landed).
            if (!ownsDisplay(currentSession)) return;
            // Let syncCoreConfig() handle the display update with leaf node resolution
            await syncCoreConfig(() => ownsDisplay(currentSession));
            if (!ownsDisplay(currentSession)) return;
            // Roll back to the label the pill shows for this node (group + leaf), not the raw name.
            const shown = document.getElementById('current-node-name')?.textContent || '';
            if (shown && !isPendingLabel(shown)) _lastSettledName = shown;
            // syncCoreConfig() can resolve without writing the pill (its node
            // read failed): never leave this switch's "switching…" behind.
            const pillNow = document.getElementById('current-node-name');
            if (pillNow && isPendingLabel(pillNow.textContent)) pillNow.textContent = _lastSettledName;
            const proxiesPage = document.querySelector('[data-page="proxies"]');
            if (proxiesPage && !proxiesPage.classList.contains('hidden')) {
                await renderProxies();
            }
        } catch (error) {
            homeNodePickerLogger.error('Failed to update UI after node switch:', error);
            // The confirmation read failed: read what the core runs anyway, and
            // never leave this switch's "switching…" behind.
            if (!ownsDisplay(currentSession)) return;
            // It can also resolve without writing the pill (its own read failed).
            try {
                await syncCoreConfig(() => ownsDisplay(currentSession));
            } catch { /* the fallback below */ }
            const pill = document.getElementById('current-node-name');
            if (ownsDisplay(currentSession) && pill && isPendingLabel(pill.textContent)) pill.textContent = _lastSettledName;
        }
    })();
}

/**
 * Switch the selected group to `name` from outside the list (the home
 * page's lower-latency nodes), with the same bookkeeping as a pick in it.
 * @param {string} name
 * @param {string} [fromGroup] the group the button was drawn for
 */
export function switchNodeFromHome(name, fromGroup = '') {
    const trigger = document.getElementById('home-node-trigger');
    const group = /** @type {string} */ (fromGroup || appStore.get('uiGroupName') || appStore.get('uiPrimaryGroupName') || '');
    if (!trigger || !group || !name) return;
    void handlePickerSwitch(trigger, group, name, true);
}

const CHECK_PATH = 'M20 6 9 17l-5-5';

/** True from the moment an open starts (including while nodes load) until closePicker(). */
let isOpen = false;
/**
 * Bumped by every closePicker(). An open that awaited the node list under an
 * older generation was cancelled meanwhile and must not show the list.
 */
let openGeneration = 0;
/** @type {(() => void) | null} Removes the listeners that only live while the list is shown. */
let teardownOpenGuards = null;
/** @type {(() => void) | null} Installs those listeners; set by initHomeNodePicker. */
let installOpenGuards = null;

/**
 * Last measured latency of a node. A group (Auto, Fallback) shows the node it
 * ends up on, following nested groups the way the proxy cards do; its own
 * figure is only a fallback.
 * @param {string} name
 * @param {any} proxies
 * @returns {number | null}
 */
function latencyOf(name, proxies) {
    const proxy = proxies?.[name];
    const own = proxy?.history;
    const leaf = proxy?.now ? resolveLeafNode(name, proxies) : null;
    const leafHistory = leaf ? proxies?.[leaf]?.history : null;
    let history = Array.isArray(leafHistory) && leafHistory.length > 0 ? leafHistory : null;
    if (!history && Array.isArray(own) && own.length > 0) history = own;
    const delay = history ? history.at(-1)?.delay : null;
    return typeof delay === 'number' && delay > 0 && delay < 999999 ? delay : null;
}

/**
 * One row of the list: flag, name, latency and a check on the current node.
 * @param {string} name
 * @param {boolean} selected
 * @param {number | null} delay
 * @returns {HTMLElement}
 */
function createRow(name, selected, delay) {
    const row = document.createElement('div');
    row.className = 'dz-picker-node home-picker-node' + (selected ? ' active' : '');
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', selected ? 'true' : 'false');
    row.tabIndex = -1;
    row.dataset.node = name;

    const { flag, label } = splitFlag(name);
    const flagEl = document.createElement('span');
    flagEl.className = 'home-picker-flag' + (flag ? '' : ' is-empty');
    flagEl.setAttribute('aria-hidden', 'true');
    flagEl.textContent = flag;

    const nameEl = document.createElement('span');
    nameEl.className = 'dz-picker-node-name home-picker-name';
    nameEl.textContent = label;
    nameEl.title = name;

    row.append(flagEl, nameEl);
    if (delay !== null) {
        const ms = document.createElement('span');
        ms.className = `home-picker-ms ${getDelayColorClass(delay)}`;
        ms.textContent = `${delay} ms`;
        row.append(ms);
    }

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'dz-picker-check');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2.5');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', CHECK_PATH);
    svg.appendChild(path);
    row.append(svg);
    return row;
}

/**
 * Show the (already populated) list under the trigger.
 * @param {HTMLElement} trigger
 * @param {HTMLElement} popup
 */
function showPopup(trigger, popup) {
    sizePopup(trigger, popup);
    popup.classList.remove('dz-hidden');
    trigger.setAttribute('aria-expanded', 'true');
    installOpenGuards?.();
}

/** @param {HTMLElement} trigger @param {HTMLElement} popup */
function sizePopup(trigger, popup) {
    const scale = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ui-scale')) || 1;
    const rect = trigger.getBoundingClientRect();
    const rtl = getComputedStyle(trigger).direction === 'rtl';
    const available = (rtl ? rect.right : window.innerWidth - rect.left) / scale - 8;
    popup.style.maxWidth = `${Math.max(0, available)}px`;
}

/**
 * Put the nodes in the list, fastest first.
 * @param {HTMLElement} trigger
 * @param {HTMLElement} list
 * @param {string} uiGroupName
 * @param {string[]} proxies
 * @param {any} data
 * @param {string} current
 */
function fillRows(trigger, list, uiGroupName, proxies, data, current) {
    /** @type {any} */
    const map = /** @type {any} */ (data)?.proxies || {};
    // Ordered by the figure each row shows (a group's is its node's);
    // unmeasured rows keep their order after the measured ones.
    const delays = new Map(proxies.map((n) => [n, latencyOf(n, map)]));
    const order = new Map(proxies.map((n, i) => [n, i]));
    const rank = (/** @type {string} */ n) => delays.get(n) ?? Number.POSITIVE_INFINITY;
    proxies.sort((a, b) => (rank(a) - rank(b)) || ((order.get(a) ?? 0) - (order.get(b) ?? 0)));
    const fragment = document.createDocumentFragment();
    for (const name of proxies) {
        const selected = name === current;
        const row = createRow(name, selected, delays.get(name) ?? null);
        row.addEventListener('click', () => { void handlePickerSwitch(trigger, uiGroupName, name, true); });
        fragment.appendChild(row);
    }
    list.replaceChildren(fragment);
}

/** @param {any} result */
async function mergePickerData(result) {
    if (!result?.data) return result;
    const data = await getProxiesMerged(result.data).catch(() => result.data);
    return { ...result, data };
}

/** Reads of a group whose provider is still loading, and the wait between them. */
const LOADING_RETRIES = 5;
const LOADING_RETRY_MS = 1500;

/**
 * The list opened while the provider had no nodes yet: read the group again
 * until they arrive, then show them; after a few tries say there are none.
 * @param {HTMLElement} trigger
 * @param {HTMLElement} list
 * @param {HTMLElement} hint
 * @param {string | undefined} preferredGroupName
 * @param {() => boolean} cancelled the list was closed (or opened again)
 * @param {any} initial first successful read, retained if retries fail
 */
async function refillWhileLoading(trigger, list, hint, preferredGroupName, cancelled, initial) {
    /** @param {any} result */
    const show = (result) => {
        const hadFocus = hint === document.activeElement;
        fillRows(trigger, list, result.uiGroupName || result.mainGroup || '', [...result.proxies], result.data, result.current);
        const sel = /** @type {HTMLElement | null} */ (list.querySelector('[aria-selected="true"]') || list.firstElementChild);
        sel?.scrollIntoView?.({ block: 'nearest' });
        if (hadFocus) sel?.focus({ preventScroll: true });
    };
    /** The last list read while the provider was still loading (DIRECT alone, say). @type {any} */
    let partial = initial?.proxies?.length ? initial : null;
    for (let i = 0; i < LOADING_RETRIES; i++) {
        await new Promise((r) => { setTimeout(r, LOADING_RETRY_MS); });
        if (cancelled() || !hint.isConnected) return;
        /** @type {any} */
        let result = null;
        try { result = await mergePickerData(await fetchProxyGroups({ preferredGroupName })); } catch { result = null; }
        if (cancelled() || !hint.isConnected) return;
        if (result && !result.providerLoading && !result.proxies?.length) {
            hint.textContent = t('noNodesYet');
            return;
        }
        if (result?.proxies?.length) {
            if (!result.providerLoading) {
                show(result);
                return;
            }
            partial = result;
        }
    }
    if (cancelled() || !hint.isConnected) return;
    // The provider never finished: what the group does have beats nothing.
    if (partial) show(partial);
    else hint.textContent = t('noNodesYet');
}

/**
 * Load the main group's nodes into the list and show it.
 * @param {HTMLElement} trigger
 * @param {HTMLElement} popup
 * @param {HTMLElement} list
 * @returns {Promise<boolean>} whether the list is now shown
 */
async function populateAndShow(trigger, popup, list) {
    if (isOpen) return false;
    isOpen = true;
    const generation = openGeneration;
    /** Closed (Escape, page switch…) while the nodes were loading: stay closed. */
    const cancelled = () => generation !== openGeneration || !isOpen;

    // Escape, blur and navigation must cancel an open that is still loading.
    installOpenGuards?.();

    try {
        const preferredGroupName = appStore.get('uiGroupName') || null;
        const result = await mergePickerData(await fetchProxyGroups({ preferredGroupName }));
        if (cancelled()) return false;
        if (trigger.closest('[data-page]')?.classList.contains('hidden')) {
            closePicker();
            return false;
        }
        if (!result) {
            // Nothing to show: release the open state so the next click can retry.
            isOpen = false;
            teardownOpenGuards?.();
            teardownOpenGuards = null;
            return false;
        }

        const uiGroupName = result.uiGroupName || result.mainGroup || '';
        const { data, current } = result;
        /** @type {string[]} */
        const proxies = [...result.proxies];

        list.replaceChildren();
        // Provider still loading (the group may list DIRECT alone until it does).
        if (proxies.length === 0 || result.providerLoading) {
            // Provider still loading: a short hint instead of an empty list.
            const hint = document.createElement('div');
            hint.className = 'home-picker-hint';
            hint.textContent = t(result.providerLoading ? 'loadingNodes' : 'noNodesYet');
            // Focusable so a keyboard open has somewhere to land.
            hint.tabIndex = -1;
            hint.dataset.pickerHint = '';
            hint.setAttribute('role', 'status');
            list.appendChild(hint);
            showPopup(trigger, popup);
            if (result.providerLoading) void refillWhileLoading(trigger, list, hint, preferredGroupName || undefined, cancelled, result);
            return true;
        }

        fillRows(trigger, list, uiGroupName, proxies, data, current || '');
        showPopup(trigger, popup);
        /** @type {HTMLElement | null} */ (list.querySelector('[aria-selected="true"]'))?.scrollIntoView?.({ block: 'nearest' });
        return true;
    } catch (err) {
        homeNodePickerLogger.error('Failed to load nodes', err);
        if (!cancelled()) closePicker();
        return false;
    }
}

/**
 * Close the list. Safe to call at any time and any number of times: it
 * invalidates an open that is still loading nodes and always puts the bar
 * back into the closed look.
 */
export function closePicker() {
    openGeneration++;
    const wasOpen = isOpen;
    isOpen = false;
    teardownOpenGuards?.();
    teardownOpenGuards = null;
    const popup = document.getElementById('home-node-picker');
    const trigger = document.getElementById('home-node-trigger');
    const shown = !!popup && !popup.classList.contains('dz-hidden');
    if (!wasOpen && !shown) return;
    // Don't leave keyboard focus on a row that is about to disappear.
    if (popup && trigger && popup.contains(document.activeElement)) {
        /** @type {HTMLElement} */ (trigger).focus({ preventScroll: true });
    }
    popup?.classList.add('dz-hidden');
    trigger?.setAttribute('aria-expanded', 'false');
}

/** @returns {boolean} */
export function isNodePickerOpen() {
    return isOpen;
}

export function initHomeNodePicker() {
    const trigger = document.getElementById('home-node-trigger');
    const popup = document.getElementById('home-node-picker');
    const list = document.getElementById('home-node-list');
    const container = document.getElementById('home-node-current');
    if (!trigger || !popup || !list || !container) return;

    // The static placeholder in index.html is English; localise it until the first node arrives.
    const nameEl = trigger.querySelector('#current-node-name');
    if (nameEl?.textContent === 'Loading...') nameEl.textContent = t('loading');

    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', t('consoleNodePicker'));
    trigger.setAttribute('aria-controls', list.id);
    trigger.setAttribute('aria-expanded', 'false');

    const rows = () => /** @type {HTMLElement[]} */ (Array.from(list.querySelectorAll('[role="option"]')));

    /** @param {HTMLElement | undefined} row */
    const focusRow = (row) => {
        if (!row) return;
        row.focus({ preventScroll: true });
        row.scrollIntoView?.({ block: 'nearest' });
    };

    installOpenGuards = () => {
        teardownOpenGuards?.();
        /** @param {MouseEvent} e */
        const onDocClick = (e) => {
            const target = /** @type {Node | null} */ (e.target);
            if (target && container.contains(target)) return;
            closePicker();
        };
        const onBlur = () => closePicker();
        const onVisibility = () => { if (document.visibilityState === 'hidden') closePicker(); };
        /** @param {KeyboardEvent} e */
        const onKeyDown = (e) => {
            if (e.key !== 'Escape') return;
            const hadFocus = container.contains(document.activeElement);
            closePicker();
            if (hadFocus) trigger.focus({ preventScroll: true });
        };
        // Close when navigation hides the home page.
        const page = container.closest('[data-page]');
        const observer = typeof MutationObserver === 'function' && page
            ? new MutationObserver(() => { if (page.classList.contains('hidden')) closePicker(); })
            : null;
        if (observer && page) observer.observe(page, { attributes: true, attributeFilter: ['class'] });

        // A reload (another profile) may bring a group of the same name:
        // the rows shown are not its nodes.
        const offReload = Bus.on(Events.CONFIG_UPDATED, (/** @type {any} */ data) => { if (data?.reloaded) closePicker(); });
        const offRestart = Bus.on(Events.CORE_RESTARTED, closePicker);
        const offDiagnostics = Bus.on(Events.DIAGNOSTICS_INVALIDATED, closePicker);
        const onResize = () => sizePopup(trigger, popup);
        document.addEventListener('click', onDocClick, true);
        document.addEventListener('keydown', onKeyDown, true);
        document.addEventListener('visibilitychange', onVisibility);
        window.addEventListener('blur', onBlur);
        window.addEventListener('resize', onResize);
        teardownOpenGuards = () => {
            offReload();
            offRestart();
            offDiagnostics();
            document.removeEventListener('click', onDocClick, true);
            document.removeEventListener('keydown', onKeyDown, true);
            document.removeEventListener('visibilitychange', onVisibility);
            window.removeEventListener('blur', onBlur);
            window.removeEventListener('resize', onResize);
            observer?.disconnect();
        };
    };

    trigger.addEventListener('click', (e) => {
        if (isOpen) {
            closePicker();
            return;
        }
        // No core running: there is no node list to show or switch.
        if (document.getElementById('app-main-container')?.classList.contains('core-down')) return;
        // detail === 0 means Enter/Space rather than a pointer click.
        const viaKeyboard = e.detail === 0;
        populateAndShow(trigger, popup, list).then((shown) => {
            if (!shown || !viaKeyboard || document.activeElement !== trigger) return;
            const current = /** @type {HTMLElement | undefined} */ (list.querySelector('[aria-selected="true"]') || rows()[0]);
            if (current) focusRow(current);
            else /** @type {HTMLElement | null} */ (list.querySelector('[data-picker-hint]'))?.focus({ preventScroll: true });
        }).catch((err) => homeNodePickerLogger.error('Failed to open the node list', err));
    });

    // Arrow keys from the bar open the list too, landing on the current node.
    trigger.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
        e.preventDefault();
        if (!isOpen) {
            trigger.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
            return;
        }
        // Opened with the pointer: focus stayed here, so step into the list.
        const current = /** @type {HTMLElement | undefined} */ (list.querySelector('[aria-selected="true"]') || rows()[0]);
        if (current) focusRow(current);
    });

    // Keyboard: arrows move through nodes, Enter/Space picks one, Tab leaves.
    list.addEventListener('keydown', (e) => {
        const items = rows();
        const active = /** @type {HTMLElement | null} */ (document.activeElement);
        const index = active ? items.indexOf(active) : -1;
        /** @type {HTMLElement | undefined} */
        let next;
        switch (e.key) {
            case 'ArrowDown': next = items[Math.min(items.length - 1, index + 1)]; break;
            case 'ArrowUp': next = items[Math.max(0, index - 1)]; break;
            case 'Home': next = items[0]; break;
            case 'End': next = items[items.length - 1]; break;
            case 'Enter':
            case ' ':
                if (active?.getAttribute('role') === 'option') {
                    e.preventDefault();
                    trigger.focus({ preventScroll: true });
                    active.click();
                }
                return;
            default: return;
        }
        e.preventDefault();
        focusRow(next);
    });

    // Focus leaving the bar and list entirely (Tab away) closes it.
    container.addEventListener('focusout', (e) => {
        if (!isOpen) return;
        const to = /** @type {Node | null} */ (e.relatedTarget);
        if (!to || container.contains(to)) return;
        closePicker();
    });
}
