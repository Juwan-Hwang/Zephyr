/**
 * Minimal home: the figures around the traffic card (totals under the two
 * speeds, the connection count link) and the current-node bar with the
 * lower-latency nodes beside it.
 *
 * Reads only data the app already has (mihomo `/connections` and the cached
 * `/proxies` snapshot) and polls only while the minimal home is on screen and
 * the window is visible.
 */

import { getConnections, getProxiesMerged } from '../api.js';
import { getProxiesCached } from './cache.js';
import { isRealOutboundNode } from './proxy-groups.js';
import { exitIpFor, onExitIpRefreshed, retryFailedExitIp } from './exit-ip.js';
import { isSpeedTestBusy, onSpeedTestChange } from './speed-test.js';
import { exitIpSummary, openNodeDetails, closeNodeDetails, adoptNodeDetails, dropOrphanedNodeDetails } from './node-details.js';
import { formatBytes } from '../utils/format.js';
import { createLogger } from '../utils/logger.js';
import { appStore } from './state.js';
import { t, currentLang, translations } from '../i18n.js';
import { Bus, Events } from './events.js';

const logger = createLogger('HomeStats');
const POLL_MS = 2000;
/** @type {ReturnType<typeof setInterval> | null} */
let timer = null;
/** @type {symbol | null} */
let activeInstance = null;
/** @type {symbol | null} */
let inFlight = null;
/** @type {{ down: number, up: number, count: number } | null} */
let connectionStats = null;

/** @param {string} id @param {string} text */
function setText(id, text) {
    const el = document.getElementById(id);
    if (el && el.textContent !== text) el.textContent = text;
}

/**
 * Split "10.12 MB" into a figure and a unit so the unit can be set smaller.
 * @param {number} bytes
 * @returns {[string, string]}
 */
export function splitBytes(bytes) {
    const s = formatBytes(Math.max(0, Number(bytes) || 0));
    const i = s.lastIndexOf(' ');
    return i > 0 ? [s.slice(0, i), s.slice(i + 1)] : [s, ''];
}

/**
 * Follow a group's `now` chain down to the leaf node.
 * @param {Record<string, any>} proxies
 * @param {string} name
 * @returns {any}
 */
export function resolveLeaf(proxies, name) {
    let p = proxies?.[name];
    // Follow any depth of nesting; stop on a cycle instead of a fixed depth.
    const seen = new Set([name]);
    while (p && Array.isArray(p.all) && p.now && !seen.has(p.now)) {
        seen.add(p.now);
        p = proxies[p.now];
    }
    return p;
}

function homeVisible() {
    const page = document.querySelector('[data-page="home"]');
    return !!page && !page.classList.contains('hidden') && !document.hidden;
}

/**
 * Whether `node` is reachable from `group` (directly or through nested groups).
 * @param {Record<string, any>} proxies @param {string} group @param {string} node
 * @returns {boolean}
 */
export function groupContains(proxies, group, node) {
    const seen = new Set();
    const stack = [group];
    while (stack.length) {
        const g = /** @type {string} */ (stack.pop());
        if (seen.has(g)) continue;
        seen.add(g);
        const all = proxies?.[g]?.all;
        if (!Array.isArray(all)) continue;
        if (all.includes(node)) return true;
        stack.push(...all);
    }
    return false;
}

/**
 * The observed exit of this group or its selected direct parent, otherwise its current leaf.
 * @param {Record<string, any>} proxies @param {string} group
 * @returns {any}
 */
export function displayedLeaf(proxies, group) {
    const observed = appStore.get('observedNodeName');
    const observedGroup = appStore.get('observedGroupName');
    const selectedGroup = appStore.get('uiGroupName') || appStore.get('uiPrimaryGroupName');
    const ownsObservation = observedGroup === group || (!!observedGroup && observedGroup === selectedGroup
        && proxies?.[observedGroup]?.now === group);
    if (observed && ownsObservation && proxies?.[observed]
        && (observed === group || groupContains(proxies, group, observed))) {
        return resolveLeaf(proxies, observed);
    }
    return resolveLeaf(proxies, group);
}

/** Most lower-latency nodes the bar offers; CSS hides the ones that do not fit. */
export const MAX_ALTS = 5;
const FLAG_RE = /^\s*((?:[\u{1F1E6}-\u{1F1FF}]{2})|(?:\u{1F3F4}[\u{E0061}-\u{E007A}]+\u{E007F}))\s*/u;

/**
 * Split a leading flag emoji off a node name.
 * @param {string} name
 * @returns {{ flag: string, label: string }}
 */
export function splitFlag(name) {
    const s = String(name || '');
    const m = s.match(FLAG_RE);
    return m ? { flag: m[1], label: s.slice(m[0].length) || s } : { flag: '', label: s };
}

/**
 * The newest measured delay of a proxy, or null for none / timeout.
 * @param {any} proxy
 * @returns {number | null}
 */
export function lastDelay(proxy) {
    const hist = Array.isArray(proxy?.history) ? proxy.history : [];
    const d = hist.length ? Number(hist[hist.length - 1]?.delay) || 0 : 0;
    return d > 0 && d < 999999 ? d : null;
}

/**
 * The nodes of `group` with a lower measured delay than `current` (any
 * measured one while `current` has none), fastest first.
 * Only direct members that are real nodes (not groups, DIRECT or REJECT).
 * @param {Record<string, any>} proxies @param {string} group @param {string} current
 * @param {number} [max]
 * @returns {Array<{ name: string, delay: number }>}
 */
export function lowerLatencyNodes(proxies, group, current, max = MAX_ALTS) {
    const all = proxies?.[group]?.all;
    if (!Array.isArray(all)) return [];
    /** @type {Array<{ name: string, delay: number }>} */
    const out = [];
    // Listed as "lower latency": with the current node measured, only faster
    // ones; with no figure for it yet, the fastest measured ones.
    const mine = lastDelay(proxies?.[current]);
    for (const name of all) {
        const p = proxies[name];
        // Never DIRECT/REJECT/DNS-style outbounds or groups: only real nodes.
        if (!p || name === current || !isRealOutboundNode(name, p)) continue;
        const delay = lastDelay(p);
        if (delay !== null && (mine === null || delay < mine)) out.push({ name, delay });
    }
    out.sort((a, b) => a.delay - b.delay);
    return out.slice(0, max);
}

/**
 * A country code as the user's language names it ("HK" → "香港").
 * @param {string} code
 * @returns {string}
 */
export function regionName(code) {
    if (!code) return '';
    try {
        return new Intl.DisplayNames([currentLang || 'en'], { type: 'region' }).of(code) || code;
    } catch {
        return code;
    }
}

/** @param {symbol} instance */
async function pollConnections(instance) {
    const generation = coreGen;
    const data = /** @type {any} */ (await getConnections());
    if (activeInstance !== instance || generation !== coreGen) return;
    const down = Number(data?.downloadTotal) || 0;
    const up = Number(data?.uploadTotal) || 0;
    const conns = Array.isArray(data?.connections) ? data.connections : [];
    connectionStats = { down, up, count: conns.length };
    paintConnectionStats();
}

function paintConnectionStats() {
    if (!connectionStats) return;
    const { down, up, count: n } = connectionStats;
    setText('home-total-down', t('homeDownloaded', { size: formatBytes(down) }));
    setText('home-total-up', t('homeUploaded', { size: formatBytes(up) }));
    const link = document.getElementById('home-conn-text');
    if (link) {
        // Until a poll succeeds it reads "Connections"; from now on, the count.
        link.removeAttribute('data-i18n');
        const next = t('homeConnections', n);
        if (link.textContent !== next) link.innerHTML = '';
        if (!link.textContent) {
            // The count is set heavier than the words around it.
            const parts = next.split(String(n));
            if (parts.length === 2) {
                const b = document.createElement('b');
                b.textContent = String(n);
                link.append(parts[0], b, parts[1]);
            } else {
                link.textContent = next;
            }
        }
    }
}

/** @type {(import('./exit-ip.js').ExitIpInfo & { leaf: string }) | null} */
let exitIp = null;
let exitIpLeaf = '';
/** Bumped by every lookup and by forgetExitIp: only the newest one may draw. */
let exitIpAsk = 0;
/** When a lookup that found nothing may be tried again (0: not due). */
let exitIpRetryAt = 0;
/** A lookup that found nothing (a network hiccup) is tried again once, after this. */
const EXIT_IP_RETRY_MS = 30_000;
/** Whether this node's one later try was used: after it, only a node switch or "Look up again". */
let exitIpRetried = false;
let exitIpDisplayStale = false;

/**
 * Look the exit address up again when the node changes (once per node; the
 * lookup itself waits for the node to settle).
 * @param {string} leaf
 * @param {boolean} [force] the same node, looked up again
 */
function nodeIpRequest(leaf, force) {
    if (!homeVisible()) {
        if (force && leaf === exitIpLeaf) { exitIpDisplayStale = true; nodeCountdown = 0; }
        return null;
    }
    if (isSpeedTestBusy()) {
        exitIpDisplayStale = exitIpDisplayStale || !!force;
        return null;
    }
    force = force || exitIpDisplayStale;
    exitIpDisplayStale = false;
    const retry = leaf === exitIpLeaf && !exitIp && exitIpRetryAt > 0 && Date.now() >= exitIpRetryAt;
    if (!leaf || (leaf === exitIpLeaf && !force && !retry)) return null;
    return { force, retry };
}

/** @param {string} leaf @param {boolean} [force] */
async function refreshNodeExitIp(leaf, force = false) {
    const request = nodeIpRequest(leaf, force);
    if (!request) return;
    const retry = request.retry;
    force = request.force;
    // Details open for the previous node would fill in with its address.
    if (exitIpLeaf && exitIpLeaf !== leaf) closeNodeDetails();
    exitIpLeaf = leaf;
    // Not again while this one runs.
    exitIpRetryAt = 0;
    exitIpRetried = retry && !force;
    // The one later try: the miss kept for this node gives way. A forced
    // redraw (a "look up again" that just finished) keeps its result.
    if (retry && !force) retryFailedExitIp(leaf);
    const ask = ++exitIpAsk;
    const instance = activeInstance;
    const r = await exitIpFor(leaf);
    // A later lookup, or a reset (setting off, core restarted), wins.
    if (activeInstance !== instance || ask !== exitIpAsk || exitIpLeaf !== leaf) return;
    if (!r && isSpeedTestBusy()) {
        // The lookup was paused after it started; keep the next poll eligible.
        exitIpLeaf = '';
        exitIpRetried = false;
        return;
    }
    exitIp = r ? { leaf, ...r } : null;
    // Nothing found (off, not a node, or a failure): look once more later.
    if (!r && !exitIpRetried) exitIpRetryAt = Date.now() + EXIT_IP_RETRY_MS;
    paintNode();
}

/** Drop the shown address with the looked-up ones (setting changed, core restarted). */
function forgetExitIp() {
    // The shared cache is not reset here: exit-ip.js and the settings page
    // already did before these events, and a reset now would drop a lookup
    // the console started for the same event.
    const focusedDetails = homeVisible() && (!!document.querySelector('.nd-pop')?.contains(document.activeElement)
        || !!document.querySelector('#home-node .home-ip-btn')?.contains(document.activeElement));
    closeNodeDetails();
    if (focusedDetails) document.getElementById('home-node-trigger')?.focus({ preventScroll: true });
    exitIpAsk++;
    exitIp = null;
    exitIpLeaf = '';
    exitIpRetryAt = 0;
    exitIpRetried = false;
    exitIpDisplayStale = false;
}

/** @type {{ key: string, group: string, leaf: string, delay: number | null, alts: Array<{ name: string, delay: number }> } | null} */
let nodeState = null;

/** The group whose node the home bar shows. */
const groupNow = () => /** @type {string} */ (appStore.get('uiGroupName') || appStore.get('uiPrimaryGroupName') || '');

/**
 * The pill's group and label together: a switch inside one group keeps
 * data-group but changes the label.
 * @param {HTMLElement | null} pill
 */
function pillKey(pill) {
    const label = (pill?.textContent || '').trim();
    return `${(pill?.dataset.group || label).trim()}\u0000${label}`;
}

/** Bumped when the core restarts: a node read begun before belongs to the old core. */
let coreGen = 0;

/** @param {HTMLElement} el @param {string} text */
function span(el, text, cls = '') {
    const s = document.createElement('span');
    if (cls) s.className = cls;
    s.textContent = text;
    el.append(s);
    return s;
}

/** Draw the node bar from the last poll. */
function paintNode() {
    const pill = document.getElementById('current-node-name');
    const flagEl = document.getElementById('home-node-flag');
    const nameEl = document.getElementById('home-node-name');
    const subEl = document.getElementById('home-node-sub');
    const bar = document.getElementById('home-node');
    if (!pill || !nameEl || !subEl) return;
    const stopped = document.getElementById('app-main-container')?.classList.contains('core-down') ?? false;
    bar?.classList.toggle('is-stopped', stopped);
    const pillText = (pill.textContent || '').trim();
    // The last poll read another node than the pill names now (a switch from
    // elsewhere): none of its name, address or alternatives until the next read.
    // Another group naming the same node: its alternatives would switch the old group.
    let state = nodeState && nodeState.key === pillKey(pill) && (!nodeState.group || nodeState.group === groupNow()) ? nodeState : null;
    const switching = pillText === t('switching') || Object.values(translations).some((locale) => locale.switching === pillText);
    if (switching) state = null;
    const leafName = switching ? '' : (state ? state.leaf : (pill.dataset.group || pillText));
    const { flag, label } = splitFlag(leafName);
    if (flagEl && flagEl.textContent !== flag) flagEl.textContent = flag;
    flagEl?.classList.toggle('is-empty', !flag);
    const shownName = switching ? pillText : (state && !state.leaf ? '—' : (label || pillText));
    if (nameEl.textContent !== shownName) nameEl.textContent = shownName;
    nameEl.title = leafName;

    const ip = !stopped && !switching && exitIp && exitIp.leaf === state?.leaf ? exitIp : null;
    const summary = ip ? exitIpSummary(ip) : null;
    const delayText = state?.delay ? `${state.delay} ms` : '—';
    const subKey = JSON.stringify([stopped, summary, ip?.leaf ?? '', ip ? '' : state?.group || '', t('homeStopped')]);
    // Rebuilt only when it changes, so the IP button keeps focus across polls.
    if (subEl.dataset.key === subKey) {
        const ipButton = /** @type {HTMLElement | null} */ (subEl.querySelector('.home-ip-btn'));
        if (ipButton && ip) setExitIpButtonInfo(ipButton, ip);
        if (ipButton && summary) ipButton.title = [summary.title, t('nodeDetailsView')].filter(Boolean).join('\n');
        const delay = subEl.querySelector('.home-ms-value');
        if (delay && delay.textContent !== delayText) delay.textContent = delayText;
        paintAlts(stopped, switching ? null : state);
        return;
    }
    subEl.dataset.key = subKey;
    if (subEl.dataset.coreErrorLabel) {
        delete subEl.dataset.coreErrorLabel;
        delete subEl.dataset.i18n;
    }
    const previousIpButton = /** @type {HTMLElement | null} */ (subEl.querySelector('.home-ip-btn'));
    const hadIpFocus = !!previousIpButton?.contains(document.activeElement);
    const restoreIpFocus = !!ip && previousIpButton?.dataset.leaf === ip.leaf && hadIpFocus;
    subEl.replaceChildren();
    if (stopped) {
        span(subEl, t('homeStopped'), 'home-ms is-off');
    } else {
        const ms = document.createElement('span');
        ms.className = 'home-ms';
        const dot = document.createElement('i');
        dot.className = 'home-dot';
        dot.setAttribute('aria-hidden', 'true');
        ms.append(dot);
        span(ms, delayText, 'home-ms-value');
        subEl.append(ms);
        if (ip && summary) {
            span(subEl, '·', 'home-sep').setAttribute('aria-hidden', 'true');
            const btn = exitIpButton(summary, ip.leaf, ip);
            subEl.append(btn);
            // Only once the old line is gone does the open card move to the new one.
            adoptNodeDetails(btn, ip.leaf);
            if (restoreIpFocus) btn.focus({ preventScroll: true });
        } else if (state?.group) {
            span(subEl, '·', 'home-sep').setAttribute('aria-hidden', 'true');
            span(subEl, state.group);
        }
    }
    dropOrphanedNodeDetails();
    if (hadIpFocus && !subEl.querySelector('.home-ip-btn') && !document.querySelector('.nd-pop')) {
        document.getElementById('home-node-trigger')?.focus({ preventScroll: true });
    }
    paintAlts(stopped, switching ? null : state);
}

/**
 * What an IP button shows, as one string: the same key, the same button.
 * @param {{ ip: string, place: string, title: string }} summary
 */
export function exitIpKey(summary) {
    return [summary.ip, summary.place, summary.title].join('\u0000');
}

/**
 * The IP line as a button that opens the node details (both home pages).
 * @param {{ ip: string, place: string, title: string }} summary
 * @param {string} leaf
 * @param {import('./exit-ip.js').ExitIpInfo|null} [info]
 * @returns {HTMLButtonElement}
 */
export function exitIpButton(summary, leaf, info = null) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'home-ip-btn';
    btn.setAttribute('aria-haspopup', 'dialog');
    btn.setAttribute('aria-expanded', 'false');
    btn.dataset.leaf = leaf;
    btn.dataset.key = exitIpKey(summary);
    setExitIpButtonInfo(btn, info);
    btn.title = [summary.title, t('nodeDetailsView')].filter(Boolean).join('\n');
    span(btn, summary.ip, 'home-ip');
    if (summary.place) {
        span(btn, '·', 'home-sep').setAttribute('aria-hidden', 'true');
        span(btn, summary.place, 'home-ip-place');
    }
    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        void openNodeDetails(btn, leaf, exitIpButtonInfo.get(btn) || null);
    });
    return btn;
}

/** @type {WeakMap<HTMLElement, import('./exit-ip.js').ExitIpInfo|null>} */
const exitIpButtonInfo = new WeakMap();

/** @param {HTMLElement} button @param {import('./exit-ip.js').ExitIpInfo|null} info */
export function setExitIpButtonInfo(button, info) {
    exitIpButtonInfo.set(button, info);
}

/**
 * @param {boolean} stopped
 * @param {typeof nodeState} state the poll that matches the pill, if any
 */
function paintAlts(stopped, state) {
    const wrap = document.getElementById('home-alts');
    const list = document.getElementById('home-alts-list');
    if (!wrap || !list) return;
    const alts = state?.alts || [];
    wrap.classList.toggle('hidden', alts.length === 0);
    wrap.classList.toggle('is-disabled', stopped);
    const key = JSON.stringify([stopped, state?.group || '', alts.map((alt) => alt.name)]);
    if (list.dataset.key === key) {
        // Same buttons: only the language may have changed, so keep focus.
        list.querySelectorAll('button.home-alt').forEach((b, i) => {
            /** @type {HTMLElement} */ (b).title = t('homeSwitchTo', { name: /** @type {HTMLElement} */ (b).dataset.node || '' });
            b.setAttribute('aria-label', `${alts[i].name}, ${alts[i].delay} ms`);
            const delay = b.querySelector('.home-alt-ms');
            if (delay) delay.textContent = `${alts[i].delay} ms`;
        });
        fitAlts();
        return;
    }
    const focused = list.contains(document.activeElement) ? /** @type {HTMLElement} */ (document.activeElement)?.dataset.node : undefined;
    list.dataset.key = key;
    list.replaceChildren();
    for (const alt of alts) {
        const { flag, label } = splitFlag(alt.name);
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'home-alt';
        btn.dataset.node = alt.name;
        // The group these came from: a click switches that one, even if
        // another group was picked since they were drawn.
        if (state?.group) btn.dataset.group = state.group;
        btn.disabled = stopped;
        btn.title = t('homeSwitchTo', { name: alt.name });
        btn.setAttribute('aria-label', `${alt.name}, ${alt.delay} ms`);
        if (flag) span(btn, flag, 'home-alt-flag').setAttribute('aria-hidden', 'true');
        span(btn, label, 'home-alt-name');
        span(btn, `${alt.delay} ms`, 'home-alt-ms');
        list.append(btn);
    }
    fitAlts();
    if (focused) {
        const replacement = [...list.querySelectorAll('button.home-alt')].find((btn) =>
            /** @type {HTMLElement} */ (btn).dataset.node === focused
            && !/** @type {HTMLButtonElement} */ (btn).hidden && !/** @type {HTMLButtonElement} */ (btn).disabled);
        (/** @type {HTMLElement|undefined} */ (replacement) || document.getElementById('home-node-trigger'))?.focus({ preventScroll: true });
    }
}

/** Alternatives that wrapped out of the one visible row are hidden, so Tab never lands on them. */
function fitAlts() {
    const list = document.getElementById('home-alts-list');
    if (!list) return;
    const btns = /** @type {HTMLElement[]} */ (Array.from(list.children));
    btns.forEach((b) => { b.hidden = false; });
    const top = btns[0]?.offsetTop ?? 0;
    const wrapped = btns.map((b) => b.offsetTop > top);
    if (btns.some((btn, i) => wrapped[i] && btn.contains(document.activeElement))) {
        (btns.find((_, i) => !wrapped[i]) || document.getElementById('home-node-trigger'))?.focus({ preventScroll: true });
    }
    btns.forEach((b, i) => { b.hidden = wrapped[i]; });
}

/** Read the proxy map only every Nth tick (or when the pill names another
 * group) so the home poll does not re-request /proxies every 2 s. */
const NODE_EVERY = 5;
let nodeCountdown = 0;
/** @type {string | null} */
let lastNodeKey = null;

/** @param {symbol} instance */
async function pollNode(instance) {
    // The pill holds a display label ("Auto - HK"); the real proxy-map key
    // of the selected member lives in data-group.
    const nodeEl = document.getElementById('current-node-name');
    const nodeName = (nodeEl?.dataset.group || nodeEl?.textContent || '').trim();
    // A switch inside the same group keeps data-group but changes the pill's
    // label, so key the throttle on both.
    const nodeKey = pillKey(nodeEl);
    // Another group with the same label (its alternatives differ) reads again too.
    const group = groupNow();
    const throttleKey = `${nodeKey}\u0000${group}`;
    if (throttleKey === lastNodeKey && nodeCountdown > 0) {
        nodeCountdown--;
        return;
    }
    lastNodeKey = throttleKey;
    nodeCountdown = NODE_EVERY - 1;
    const gen = coreGen;
    const raw = /** @type {any} */ (await getProxiesCached());
    if (activeInstance !== instance) return;
    if (!homeVisible()) { nodeCountdown = 0; return; }
    // Provider-downloaded nodes are missing from the raw /proxies map.
    const res = /** @type {any} */ (raw?.proxies ? await getProxiesMerged(raw) : raw);
    if (activeInstance !== instance) return;
    if (!homeVisible()) { nodeCountdown = 0; return; }
    const proxies = res?.proxies || res || {};
    const leaf = nodeName ? displayedLeaf(proxies, nodeName) : null;
    // The user switched while the map loaded: this is the old node's data.
    // Drop it and read again on the next tick (the pill observer's run is
    // skipped while this poll is in flight).
    // A core restart meanwhile: the old core's delays and alternatives.
    if (pillKey(document.getElementById('current-node-name')) !== nodeKey || groupNow() !== group || gen !== coreGen) {
        nodeCountdown = 0;
        return;
    }
    const shownLabel = document.getElementById('current-node-name')?.textContent || '';
    if (shownLabel === t('switching') || Object.values(translations).some((locale) => locale.switching === shownLabel)) {
        nodeCountdown = 0;
        return;
    }
    // Only a read that still owns this view can clear the old selection.
    const currentGroup = group ? proxies[group] : null;
    if (currentGroup && !currentGroup.now) {
        // A known group without a selection cannot describe the old pill's node.
        // Keep the normal poll cadence until the core selects a member.
        nodeState = { key: nodeKey, group, leaf: '', delay: null, alts: [] };
        forgetExitIp();
        paintNode();
        return;
    }
    if (currentGroup?.now && currentGroup.now !== nodeName) {
        nodeCountdown = 0;
        nodeState = null;
        forgetExitIp();
        paintNode();
        void import('./proxies.js').then((m) => {
            const canWriteNode = () => activeInstance === instance && homeVisible() && groupNow() === group
                && coreGen === gen && pillKey(document.getElementById('current-node-name')) === nodeKey;
            if (canWriteNode()) return m.syncCoreConfig(canWriteNode);
        }).catch((e) => logger.debug('current group sync failed', e));
        return;
    }
    nodeState = {
        key: nodeKey,
        group: group && proxies[group] ? group : '',
        leaf: leaf?.name || nodeName,
        delay: lastDelay(leaf),
        alts: group ? lowerLatencyNodes(proxies, group, leaf?.name || nodeName) : [],
    };
    paintNode();
    void refreshNodeExitIp(nodeState.leaf);
}

/** @param {symbol} instance */
async function tick(instance) {
    if (activeInstance !== instance || inFlight === instance || !homeVisible()) return;
    inFlight = instance;
    try {
        await pollConnections(instance).catch(e => logger.debug('connections poll failed', e));
        if (activeInstance !== instance) return;
        await pollNode(instance).catch(e => {
            if (activeInstance === instance) nodeCountdown = 0; // retry on the next tick
            logger.debug('node read failed', e);
        });
    } finally {
        if (inFlight === instance) inFlight = null;
    }
}

/** Keep chart geometry and resize observers together. @returns {() => void} */
function observeHomeChart() {
    // The chart starts 16 px under the big figures (styles.css reads --home-chart-top).
    const hero = document.getElementById('home-hero');
    const speeds = hero?.querySelector('.home-hero-speeds');
    const placeChart = () => {
        if (!hero || !speeds || !hero.clientHeight) return;
        // Rectangles are in screen pixels; <body> is scaled by --ui-scale.
        const scale = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ui-scale')) || 1;
        const top = (speeds.getBoundingClientRect().bottom - hero.getBoundingClientRect().top) / scale + 16;
        hero.style.setProperty('--home-chart-top', `${Math.round(top)}px`);
    };
    const ro = hero && typeof ResizeObserver === 'function' ? new ResizeObserver(placeChart) : null;
    if (hero && ro) ro.observe(hero);
    if (speeds && ro) ro.observe(speeds);
    const altsList = document.getElementById('home-alts-list');
    const altsRo = altsList && typeof ResizeObserver === 'function' ? new ResizeObserver(() => fitAlts()) : null;
    if (altsList && altsRo) altsRo.observe(altsList);
    placeChart();
    return () => { ro?.disconnect(); altsRo?.disconnect(); };
}

/**
 * Start polling. Returns a cleanup function.
 * @param {{ switchNode?: (name: string, group?: string) => void, openConnections?: () => void }} [actions]
 * @returns {() => void}
 */
export function initHomeStats(actions = {}) {
    if (!document.getElementById('home-node') || timer) return () => {};
    const instance = Symbol('home-stats');
    activeInstance = instance;
    connectionStats = null;
    nodeCountdown = 0;
    const run = () => { tick(instance).catch(e => logger.debug('home stats tick failed', e)); };
    timer = setInterval(run, POLL_MS);
    const onVis = () => { if (!document.hidden) { nodeCountdown = 0; run(); } };
    document.addEventListener('visibilitychange', onVis);

    const list = document.getElementById('home-alts-list');
    /** @param {Event} e */
    const onAlt = (e) => {
        const btn = /** @type {HTMLElement | null} */ ((/** @type {HTMLElement} */ (e.target)).closest?.('.home-alt'));
        if (!btn || /** @type {HTMLButtonElement} */ (btn).disabled || !btn.dataset.node) return;
        actions.switchNode?.(btn.dataset.node, btn.dataset.group);
        nodeCountdown = 0;
    };
    list?.addEventListener('click', onAlt);

    const link = document.getElementById('home-conn-link');
    const onLink = () => actions.openConnections?.();
    link?.addEventListener('click', onLink);

    // The pill changes on a switch or a resync: redraw the bar right away.
    const pill = document.getElementById('current-node-name');
    const mo = pill ? new MutationObserver(() => { nodeCountdown = 0; paintNode(); run(); }) : null;
    if (pill && mo) mo.observe(pill, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['data-group'] });
    const main = document.getElementById('app-main-container');
    const mo2 = main ? new MutationObserver(() => paintNode()) : null;
    if (main && mo2) mo2.observe(main, { attributes: true, attributeFilter: ['class'] });

    const offIp = Bus.on(Events.EXIT_IP_SETTING_CHANGED, () => { forgetExitIp(); nodeCountdown = 0; paintNode(); run(); });
    const offMode = appStore.subscribe('currentOutboundMode', () => { forgetExitIp(); nodeCountdown = 0; paintNode(); run(); });
    const offLanguage = Bus.on(Events.I18N_APPLIED, () => { paintConnectionStats(); paintNode(); });
    // The old core's node, delay and alternatives go too (another profile can
    // name a node the same); the next poll draws the new core's.
    const offRestart = Bus.on(Events.CORE_RESTARTED, () => {
        coreGen++;
        connectionStats = null;
        for (const id of ['home-total-down', 'home-total-up']) setText(id, '—');
        const connections = document.getElementById('home-conn-text');
        if (connections) { connections.dataset.i18n = 'navConnections'; connections.textContent = t('navConnections'); }
        forgetExitIp(); nodeState = null; nodeCountdown = 0; paintNode();
    });
    // A reload without a restart (an override can re-point a node under the
    // same name): the looked-up addresses, delay and alternatives go, and a
    // poll begun before it is dropped; the next poll asks again.
    const offReloaded = Bus.on(Events.CONFIG_UPDATED, (/** @type {any} */ data) => { if (data?.reloaded || data?.restoreRuntime) { coreGen++; forgetExitIp(); nodeState = null; nodeCountdown = 0; paintNode(); } });
    const offDiagnostics = Bus.on(Events.DIAGNOSTICS_INVALIDATED, () => {
        coreGen++;
        forgetExitIp();
        nodeState = null;
        nodeCountdown = 0;
        paintNode();
        if (homeVisible()) {
            const nodeKey = pillKey(document.getElementById('current-node-name'));
            const group = groupNow();
            const gen = coreGen;
            const canWriteNode = () => activeInstance === instance && homeVisible() && coreGen === gen
                && groupNow() === group && pillKey(document.getElementById('current-node-name')) === nodeKey;
            void import('./proxies.js').then((m) => canWriteNode() ? m.syncCoreConfig(canWriteNode) : undefined).then(run)
                .catch((e) => logger.debug('node sync after diagnostics change failed', e));
        }
    });
    const offRefreshed = onExitIpRefreshed((leaf) => { if (leaf === nodeState?.leaf) void refreshNodeExitIp(leaf, true); });
    const offSpeed = onSpeedTestChange(() => {
        if (!isSpeedTestBusy()) { nodeCountdown = 0; run(); }
    });

    const stopObservingChart = observeHomeChart();

    run();
    return () => {
        if (activeInstance !== instance) return;
        activeInstance = null;
        if (inFlight === instance) inFlight = null;
        forgetExitIp();
        nodeState = null;
        stopObservingChart();
        offIp();
        offMode();
        offLanguage();
        offRestart();
        offReloaded();
        offDiagnostics();
        offRefreshed();
        offSpeed();
        if (timer) clearInterval(timer);
        timer = null;
        document.removeEventListener('visibilitychange', onVis);
        list?.removeEventListener('click', onAlt);
        link?.removeEventListener('click', onLink);
        mo?.disconnect();
        mo2?.disconnect();
    };
}
