// @ts-check
/**
 * Proxy list rendering, latency testing, sorting, and proxy card management.
 * Extracted from ui.js - the largest extracted module.
 *
 * @module ui/proxies
 */

import { decideGroupMismatch } from './group-mismatch.js';
import { switchProxy, testProxy, abortLatencyTests, closeAllConnections, getConfig, invoke, getLatencyTestSignal, resetLatencyTestController, restartCore, getProxies, getProxiesMerged, SPECIAL_PROXY_NAMES } from '../api.js';
import { proxyLogger } from '../utils/logger.js';
import { getDelayColorClass } from '../utils/format.js';
import { buildLatencyPriorityQueue } from '../utils/array.js';
import { debounce } from '../utils/debounce.js';
import { translations, currentLang, t, t as tFmt, getDirection } from '../i18n.js';
import { showNotification } from './notifications.js';
import { SVG_ICONS } from './icons.js';
import { setup3DEffect } from './3d-effect.js';
import { createRovingTabindex, setItemTabStop } from '../utils/roving-tabindex.js';
import { COMMANDS } from '@zephyr/shared';
import { getConfigCached, getProxiesCached, getSettingsCached, invalidateProxiesCache } from './cache.js';
import { appStore } from './state.js';
import { smartScore, smartNextInterval, smartRank, smartConfig, failoverReport } from './prism.js';
import { fetchProxyGroups as fetchProxyGroupsShared, isWritableGroupType, isGroup as hasGroupMembers } from './proxy-groups.js';
import { Bus, Events } from './events.js';
import { saveProxySelection, savePrimaryGroupPreference } from './proxy-memory.js';
import { invalidateRunConfigCache } from './run-config-cache.js';
import { postRestartRecovery } from './lifecycle.js';
import { startObservedGroupWatcher, stopObservedGroupWatcher, resetObservedGroup } from './observed-group.js';
import { renderTunStatus } from './tun-status.js';

// Re-export switchPage for external consumers that import from this module
export { switchPage } from './navigation.js';

/** Close open connections after a node switch; false when that failed. */
async function closeConnsAfterSwitch() {
    try {
        await closeAllConnections();
        return true;
    } catch (err) {
        proxyLogger.warn('Failed to close connections after proxy switch', err);
        return false;
    }
}

/**
 * Confirm a node switch, mentioning the closed connections only when they were.
 * @param {string} node
 * @param {boolean} closedConns
 */
function notifySwitched(node, closedConns) {
    showNotification(tFmt(closedConns ? 'switchedNodeClosedConns' : 'switchedNode', { node }), 'success');
}

// --- Constants ---

/** Represents "infinite" or "timeout" latency */
export const DELAY_INFINITE = 1000000;

/** Returns true if the given delay value means "not tested" or "timeout". Catches -1 (API failure), 0, and >= 999999. */
/** @param {number|null|undefined} d */
function isInvalidDelay(d) { return d == null || d <= 0 || d >= 999999; }

const latencyLoadingIcon = SVG_ICONS.loading;

/** Maps proxy type (uppercase) to its transport layer protocol.
 * @type {Record<string, string>}
 */
const TRANSPORT_MAP = Object.freeze({
    // QUIC-based protocols (UDP at transport layer)
    'TUIC': 'QUIC',
    'HYSTERIA': 'QUIC',
    'HYSTERIA2': 'QUIC',
    'JUICITY': 'QUIC',
    'MASQUE': 'QUIC',
    // UDP-based protocols
    'WIREGUARD': 'UDP',
    'KCP': 'UDP',
    'KCPTUN': 'UDP',
    // TCP-based protocols (including those using TLS on top of TCP)
    'ANYTLS': 'TCP',
    'TROJAN': 'TCP',
    'VLESS': 'TCP',
    'VMESS': 'TCP',
    'SHADOWSOCKS': 'TCP',
    'SHADOWSOCKSR': 'TCP',
    'SNELL': 'TCP',
    'HTTP': 'TCP',
    'SOCKS5': 'TCP',
    'SOCKS': 'TCP',
    'SSH': 'TCP',
    'MIERU': 'TCP',
    'TRUSTTUNNEL': 'TCP',
    'SUDOKU': 'TCP',
    // Special/no transport
    'DIRECT': '-',
    'REJECT': '-',
    'REJECTDROP': '-',
    'DNS': '-',
    'PASS': '-',
    'COMPATIBLE': '-',
    'SELECTOR': '-',
    'URLTEST': '-',
    'LOADBALANCE': '-',
    'FALLBACK': '-',
    'RELAY': '-',
    'SMART': '-'
});

/** Short, human-friendly protocol labels shown in the card's bottom row.
 * @type {Record<string, string>}
 */
const PROTOCOL_ABBR = Object.freeze({
    'SHADOWSOCKS': 'SS',
    'SHADOWSOCKSR': 'SSR',
    'TROJAN': 'Trojan',
    'VMESS': 'VMess',
    'VLESS': 'VLESS',
    'HYSTERIA': 'Hy',
    'HYSTERIA2': 'Hy2',
    'TUIC': 'TUIC',
    'JUICITY': 'Juicity',
    'WIREGUARD': 'WG',
    'SNELL': 'Snell',
    'ANYTLS': 'AnyTLS',
    'SOCKS5': 'SOCKS5',
    'HTTP': 'HTTP',
    'SSH': 'SSH',
    'SOCKS': 'SOCKS',
    'MIERU': 'Mieru',
    'MASQUE': 'MASQUE',
    'SUDOKU': 'Sudoku',
    'TRUSTTUNNEL': 'TrustTunnel',
    'KCP': 'KCP',
    'KCPTUN': 'KCPTun',
    'DIRECT': 'Direct',
    'REJECT': 'Reject',
    'REJECTDROP': 'Reject',
    'DNS': 'DNS',
    'PASS': 'Pass',
    'COMPATIBLE': 'Compatible',
});

/** Proxy types that are groups (their card shows the group's current node). */
const GROUP_TYPES = new Set(['SELECTOR', 'URLTEST', 'FALLBACK', 'LOADBALANCE', 'RELAY', 'SMART']);

/**
 * Whether a proxy entry is a group: any entry with members (`all`), plus the
 * known group types, so new mihomo group types are handled too.
 * @param {any} p
 * @returns {boolean}
 */
function isProxyGroup(p) {
    return hasGroupMembers(p) || GROUP_TYPES.has(String(p?.type || '').toUpperCase());
}

/**
 * The bottom-row label of a card: "→ node" for a group, otherwise the
 * protocol and its transport ("SS · TCP"; protocol only when unknown).
 * @param {any} proxy
 * @param {{ node: string|null } | null} groupNow
 * @returns {string}
 */
function proxyMetaLabel(proxy, groupNow) {
    const upperType = String(proxy?.type || '').toUpperCase();
    const abbr = PROTOCOL_ABBR[upperType] || proxy?.type || '';
    if (isProxyGroup(proxy)) {
        // Say what kind of group it is ("Auto → HK 02"): names like "♻️ 优选" don't.
        const kindKey = /** @type {Record<string, string>} */ ({ URLTEST: 'groupKindAuto', FALLBACK: 'groupKindFallback', LOADBALANCE: 'groupKindLoadBalance' })[upperType.replace(/[-_ ]/g, '')];
        const kind = kindKey ? t(kindKey) : '';
        if (groupNow?.node) return kind ? `${kind} → ${groupNow.node}` : `→ ${groupNow.node}`;
        return kind || abbr;
    }
    const transport = TRANSPORT_MAP[upperType] || '-';
    return transport === '-' ? abbr : `${abbr} · ${transport}`;
}

/**
 * Bucket a latency value into a status tier used by the card's status dot.
 * Thresholds mirror getDelayColorClass(): <200 good, <500 ok, otherwise bad.
 * @param {number|null|undefined} delay
 * @returns {'good'|'ok'|'bad'|'none'}
 */
export function getDelayTier(delay) {
    if (delay == null) return 'none';
    if (isInvalidDelay(delay)) return 'bad';
    if (delay < 200) return 'good';
    if (delay < 500) return 'ok';
    return 'bad';
}

/**
 * Update a card's status dot to match its latest latency.
 * @param {Element|null|undefined} card
 * @param {number|null|undefined} delay - null means "not tested yet"
 */
function setCardDelayTier(card, delay) {
    const dot = card?.querySelector('.delay-dot');
    if (dot instanceof HTMLElement) dot.dataset.tier = getDelayTier(delay);
}

/**
 * Resolve the node a group currently routes to (following nested groups) and its latest delay.
 * @param {any} data - proxies payload
 * @param {string} groupName
 * @returns {{ node: string|null, delay: number|null }}
 */
function resolveGroupNow(data, groupName) {
    let name = data?.proxies?.[groupName]?.now || null;
    const seen = new Set([groupName]);
    while (name && !seen.has(name)) {
        seen.add(name);
        const p = data?.proxies?.[name];
        if (!p || !isProxyGroup(p) || !p.now) break;
        name = p.now;
    }
    const leaf = name ? data?.proxies?.[name] : null;
    const hist = leaf?.history;
    const delay = (hist && hist.length > 0) ? hist[hist.length - 1].delay : null;
    return { node: name, delay };
}

/**
 * The delay a card is sorted by: its own last delay, or — for a group with no
 * delay of its own — the delay of the node it routes to (the one its card shows).
 * @param {any} data @param {string} name @param {any} proxy @param {number|null} lastDelay
 * @returns {number|null}
 */
function groupSortDelay(data, name, proxy, lastDelay) {
    if (lastDelay !== null || !isProxyGroup(proxy)) return lastDelay;
    return resolveGroupNow(data, name).delay;
}

/** Lazily measured hover marquee for long node names (always on; reduced motion keeps the ellipsis). */
/** @param {HTMLElement} card */
function startNameMarquee(card) {
    const box = card.querySelector('.node-name');
    const text = box?.firstElementChild;
    if (!(box instanceof HTMLElement) || !(text instanceof HTMLElement)) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const overflow = text.scrollWidth - text.clientWidth;
    if (overflow <= 1) return;
    box.style.setProperty('--marquee-shift', `${overflow + 12}px`);
    box.style.setProperty('--marquee-duration', `${Math.max(2.4, (overflow + 12) / 28).toFixed(2)}s`);
    box.classList.add('is-marquee');
}
/** @param {HTMLElement} card */
function stopNameMarquee(card) {
    card.querySelector('.node-name')?.classList.remove('is-marquee');
}

// --- State ---

/** @type {number|null} */
let latencySortTimer = null;

/** @type {ReturnType<typeof createRovingTabindex>|null} */
let _rovingInstance = null;

// --- Virtual state (decoupled from DOM) ---

/** Maps container elements to their virtual proxy data (replaces container._virtData) */
const _virtState = new Map();

// --- Sorting ---

/**
 * Sort an array of proxy names by their latency (ascending).
 * Proxies with no history or timeout delay are placed last.
 *
 * @param {string[]} proxies - Proxy name array (mutated in-place)
 * @param {Object} data - Full proxy data from API
 */
export function sortProxiesByLatency(proxies, data) {
    proxies.sort((a, b) => {
        const getLat = (/** @type {string} */ name) => {
            const p = (/** @type {any} */ (data)).proxies[name];
            const own = (p && p.history && p.history.length > 0) ? p.history[p.history.length - 1].delay : null;
            // Groups without their own history sort by the node they route to (what their card shows).
            const lat = groupSortDelay(data, name, p, own);
            return (lat == null || isInvalidDelay(lat)) ? DELAY_INFINITE : lat;
        };
        return getLat(a) - getLat(b);
    });
}

/**
 * Reorder DOM cards in the proxies-list container based on latency data attributes.
 * Selected cards always come first, then pending cards (during testing), then by latency.
 *
 * @param {boolean} [finalPass=false] - If true, ignore pending/estimate and sort by actual latency
 */
function applyLatencySortToDom(finalPass = false) {
    if (appStore.get('currentSortMode') !== 'latency') return;
    const container = document.getElementById('proxies-list');
    if (!container) return;
    const cards = Array.from(container.children);
    if (cards.length === 0) return;

    cards.sort((a, b) => {
        const baseA = parseInt((/** @type {HTMLElement} */ (a)).dataset.baseOrder || '0', 10);
        const baseB = parseInt((/** @type {HTMLElement} */ (b)).dataset.baseOrder || '0', 10);

        // Selected cards always first
        const selectedA = (/** @type {HTMLElement} */ (a)).dataset.selected === '1' ? 1 : 0;
        const selectedB = (/** @type {HTMLElement} */ (b)).dataset.selected === '1' ? 1 : 0;
        if (selectedA !== selectedB) return selectedB - selectedA;

        const pendingA = (/** @type {HTMLElement} */ (a)).dataset.pending === '1' ? 1 : 0;
        const pendingB = (/** @type {HTMLElement} */ (b)).dataset.pending === '1' ? 1 : 0;

        if (!finalPass) {
            if (pendingA !== pendingB) return pendingA - pendingB;
            if (pendingA === 1 && pendingB === 1) {
                const estimateA = parseInt((/** @type {HTMLElement} */ (a)).dataset.estimate || String(DELAY_INFINITE), 10);
                const estimateB = parseInt((/** @type {HTMLElement} */ (b)).dataset.estimate || String(DELAY_INFINITE), 10);
                if (estimateA !== estimateB) return estimateA - estimateB;
                return baseA - baseB;
            }
        }

        const latA = parseInt((/** @type {HTMLElement} */ (a)).dataset.latency || String(DELAY_INFINITE), 10);
        const latB = parseInt((/** @type {HTMLElement} */ (b)).dataset.latency || String(DELAY_INFINITE), 10);
        if (latA !== latB) return latA - latB;
        return baseA - baseB;
    });

    cards.forEach((card, idx) => {
        (/** @type {HTMLElement} */ (card)).style.order = String(idx);
    });
}

/** Debounced version of applyLatencySortToDom for frequent updates during testing. */
const queueLatencySort = debounce(() => {
    applyLatencySortToDom(false);
}, 220);

/** Concurrency-limited smart score updater: max N concurrent IPC calls. */
class SmartScoreBatcher {
    /** @param {number} maxConcurrency */
    constructor(maxConcurrency) {
        /** @type {Array<{name: string, latencyMs: number, success: boolean}>} */
        this._queue = [];
        this._running = 0;
        this._max = maxConcurrency;
        /** @type {Array<Function>} */
        this._waiters = [];
    }
    /** @param {string} name @param {number} latencyMs @param {boolean} success */
    push(name, latencyMs, success) {
        this._queue.push({ name, latencyMs, success });
        this._flush();
    }
    _flush() {
        while (this._running < this._max && this._queue.length > 0) {
            const item = this._queue.shift();
            if (!item) break;
            this._running++;
            void updateSmartScore(item.name, item.latencyMs, item.success).finally(() => {
                this._running--;
                this._flush();
                if (this._running === 0 && this._queue.length === 0) {
                    const waiters = this._waiters;
                    this._waiters = [];
                    waiters.forEach(resolve => resolve());
                }
            });
        }
    }
    /** Wait until all queued tasks have completed. */
    async wait() {
        if (this._running === 0 && this._queue.length === 0) return;
        return new Promise(resolve => { this._waiters.push(resolve); });
    }
}
const _smartBatcher = new SmartScoreBatcher(2);

/** Update a node's smart score badge in the DOM.
 *  @param {string} nodeName
 *  @param {number} latencyMs
 *  @param {boolean} success
 */
async function updateSmartScore(nodeName, latencyMs, success) {
    try {
        const score = await smartScore(nodeName, latencyMs, success);
        const rounded = Math.round(score);
        if (rounded === 0) return; // No meaningful score yet

        // Update the badge in the DOM
        const card = document.querySelector(`[data-name="${CSS.escape(nodeName)}"]`);
        if (!card) return;
        const badge = card.querySelector('[data-score-badge]');
        if (!badge) return;

        badge.textContent = String(rounded);
        badge.classList.remove('score-medium', 'score-low');
        if (rounded >= 70) { /* default green */ }
        else if (rounded >= 40) badge.classList.add('score-medium');
        else badge.classList.add('score-low');
    } catch {
        // Silently ignore score calculation errors
    }
}

/** Backfill smart score badges from backend after render.
 * @param {HTMLElement} container
 */
async function backfillSmartScores(container) {
    try {
        // Check smart enabled state directly (CSS var may not be set yet due to async init)
        let smartEnabled = document.documentElement.style.getPropertyValue('--smart-enabled') === '1';
        if (!smartEnabled) {
            try {
                const config = await smartConfig();
                smartEnabled = !!(/** @type {any} */ (config)).enabled;
                // Sync CSS variable so badge visibility stays consistent
                if (smartEnabled) {
                    document.documentElement.style.setProperty('--smart-enabled', '1');
                }
            } catch { /* not enabled */ }
        }
        if (!smartEnabled) return;

        const rankings = await smartRank();
        if (!Array.isArray(rankings) || rankings.length === 0) return;
        const scoreMap = new Map(rankings.map((r) => [r.name, Math.round(r.score)]));
        container.querySelectorAll('[data-name]').forEach((wrapper) => {
            if (!(wrapper instanceof HTMLElement)) return;
            const name = wrapper.dataset.name;
            const score = scoreMap.get(name || '');
            if (score === undefined || score === 0) return;
            const badge = wrapper.querySelector('[data-score-badge]');
            if (!badge) return;
            badge.textContent = String(score);
            badge.classList.remove('score-medium', 'score-low');
            if (score >= 70) { /* default green */ }
            else if (score >= 40) badge.classList.add('score-medium');
            else badge.classList.add('score-low');
        });
    } catch {
        // Silently ignore — scores are non-critical
    }
}

/** Sort DOM cards by smart score (descending), using backend rank data. */
export async function applySmartSortToDom() {
    if (appStore.get('currentSortMode') !== 'smart') return;
    const container = document.getElementById('proxies-list');
    if (!container) return;
    const cards = Array.from(container.children);
    if (cards.length === 0) return;

    try {
        const rankings = await smartRank();
        if (!rankings || rankings.length === 0) return;

        // Build name -> rank map from backend results
        const rankMap = new Map();
        for (const item of rankings) {
            rankMap.set(item.name, item.rank);
        }

        cards.sort((a, b) => {
            const baseA = parseInt((/** @type {HTMLElement} */ (a)).dataset.baseOrder || '0', 10);
            const baseB = parseInt((/** @type {HTMLElement} */ (b)).dataset.baseOrder || '0', 10);

            const selectedA = (/** @type {HTMLElement} */ (a)).dataset.selected === '1' ? 1 : 0;
            const selectedB = (/** @type {HTMLElement} */ (b)).dataset.selected === '1' ? 1 : 0;
            if (selectedA !== selectedB) return selectedB - selectedA;

            const nameA = (/** @type {HTMLElement} */ (a)).dataset.name || '';
            const nameB = (/** @type {HTMLElement} */ (b)).dataset.name || '';
            const rankA = rankMap.get(nameA) ?? Number.MAX_SAFE_INTEGER;
            const rankB = rankMap.get(nameB) ?? Number.MAX_SAFE_INTEGER;

            if (rankA !== rankB) return rankA - rankB; // Lower rank number = higher score
            return baseA - baseB;
        });

        cards.forEach((card, idx) => {
            (/** @type {HTMLElement} */ (card)).style.order = String(idx);
        });
    } catch {
        // Fallback: if smartRank fails, keep current order
    }
}

// --- Pending State ---

/**
 * Set pending state for a proxy card and its wrapper.
 * Ensures card.dataset.pending and wrapper.dataset.pending stay synchronized.
 *
 * @param {HTMLElement|null} card - The proxy card element (safe if null)
 * @param {boolean} isPending - Whether the card is in pending (testing) state
 */
function setProxyPendingState(card, isPending) {
    if (!card) return;

    const pendingValue = isPending ? '1' : '0';
    card.dataset.pending = pendingValue;

    const wrapper = card.closest('[data-name]');
    if (wrapper) {
        (/** @type {HTMLElement} */ (wrapper)).dataset.pending = pendingValue;
    }
}

// --- Latency Loading ---

/**
 * Show the loading spinner on all proxy cards in the list.
 * Saves current latency as estimate, sets pending state, and replaces
 * latency text with a spinning icon.
 */
function showLatencyLoadingForAllCards() {
    const container = document.getElementById('proxies-list');
    if (!container) return;
    const cards = Array.from(container.children);
    cards.forEach((card, index) => {
        const order = parseInt((/** @type {HTMLElement} */ (card)).style.order || `${index}`, 10);
        (/** @type {HTMLElement} */ (card)).dataset.baseOrder = `${Number.isNaN(order) ? index : order}`;
        (/** @type {HTMLElement} */ (card)).dataset.estimate = (/** @type {HTMLElement} */ (card)).dataset.latency || String(DELAY_INFINITE);
        (/** @type {HTMLElement} */ (card)).dataset.latency = String(DELAY_INFINITE);
        setProxyPendingState(/** @type {HTMLElement} */ (card), true);
        setCardDelayTier(/** @type {HTMLElement} */ (card), null);

        const latVal = card.querySelector('[id^="latency-"]');
        if (latVal) {
            latVal.className = 'text-xs tabular-nums font-semibold text-accent';
            // eslint-disable-next-line no-unsanitized/property -- static SVG constant
            latVal.innerHTML = latencyLoadingIcon; // nosemgrep: js-innerhtml-assignment — verified safe, see eslint-disable above
        }
    });
}

// --- Active Node Styling ---

const ACTIVE_CARD_CLASSES = ['proxy-card--selected'];
const INACTIVE_HOVER_CLASS = 'hover:bg-[var(--zephyr-bg-muted)]';

/** Small accent check badge marking the selected card (decorative; selection is exposed via aria-selected). */
function createActiveCheck() {
    const badge = document.createElement('span');
    badge.className = 'active-dot proxy-check';
    badge.setAttribute('aria-hidden', 'true');
    badge.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3.8 8.4l2.8 2.8 5.6-6.2"/></svg>'; // nosemgrep: js-innerhtml-assignment — static markup
    return badge;
}

/** @type {HTMLElement|null} Cached reference to the currently active card */
let _activeCard = null;

/**
 * Apply active-node styling to a card and remove it from all others in the same container.
 *
 * @param {HTMLElement} card - The card to mark as active
 * @param {HTMLElement} _container - The parent container holding all cards
 */
function setActiveNode(card, _container) {
    // Fast path: same card already active
    if (_activeCard === card) return;

    // Remove active styling from previous card only
    if (_activeCard && _activeCard.isConnected) {
        const prevCard = _activeCard;
        ACTIVE_CARD_CLASSES.forEach(cls => prevCard.classList.remove(cls));
        prevCard.classList.add(INACTIVE_HOVER_CLASS);
        const dot = prevCard.querySelector('.active-dot');
        if (dot) dot.remove();
    }

    // Update wrapper selected state for previous card
    if (_activeCard) {
        const oldWrapper = _activeCard.closest('div[data-name]');
        if (oldWrapper instanceof HTMLElement) oldWrapper.dataset.selected = '0';
    }

    // Apply active styling to target card
    ACTIVE_CARD_CLASSES.forEach(cls => card.classList.add(cls));
    card.classList.remove(INACTIVE_HOVER_CLASS);

    if (!card.querySelector('.active-dot')) {
        card.appendChild(createActiveCheck());
    }

    // Update new wrapper
    const newWrapper = card.closest('div[data-name]');
    if (newWrapper instanceof HTMLElement) newWrapper.dataset.selected = '1';

    _activeCard = card;
}

// --- Sync ---

/**
 * Sync core config state to UI (mode, TUN, current node).
 * Re-exported for use by other modules.
 */
export async function syncCoreConfig() {
    // A mode switch that lands while this GET is in flight owns the newer
    // value; writing this (older) response afterwards would roll the store
    // and the tray back to the previous mode.
    const modeBeforeFetch = appStore.get('currentOutboundMode');
    const config = await getConfig();
    if (!config) return;

    // Sync Mode
    if ((/** @type {any} */ (config)).mode && appStore.get('currentOutboundMode') === modeBeforeFetch) {
        const liveMode = String((/** @type {any} */ (config)).mode).toLowerCase();
        updateModeUI(liveMode);
        // The store drives the tray menu's mode indicator; reconciling only
        // the buttons would leave the tray on a stale mode after a switch
        // that the core applied but the backend then reported as failed.
        appStore.set('currentOutboundMode', liveMode);
    }

    // Sync TUN
    const tunToggle = document.getElementById('tun-proxy-toggle');
    if (tunToggle instanceof HTMLInputElement && (/** @type {any} */ (config)).tun) {
        const tunEnable = (/** @type {any} */ (config)).tun.enable;
        appStore.set('isTunEnabled', tunEnable);
        tunToggle.checked = tunEnable;
        renderTunStatus(document.getElementById('tun-status-text'), Boolean(tunEnable));
        // updateTrayStatus is handled by the main ui.js module
        try {
            const { updateTrayStatus } = await import('./tray.js');
            void updateTrayStatus();
        } catch (_) {}
    }

    // Update current node display
    try {
        const preferredGroupName = appStore.get('uiGroupName') || null;
        const proxyGroupsResult = await fetchProxyGroupsShared({ existingConfig: config, preferredGroupName });
        let currentNode = 'Direct';
        if (proxyGroupsResult) {
            // Use the resolved uiGroupName for accurate current node display
            const uiGroupName = proxyGroupsResult.uiGroupName || proxyGroupsResult.mainGroup;
            const proxyMap = /** @type {Record<string, any>} */ (/** @type {any} */ (proxyGroupsResult.data)?.proxies);
            if (proxyMap && uiGroupName && proxyMap[uiGroupName]) {
                currentNode = proxyMap[uiGroupName].now || 'Direct';
            } else {
                currentNode = proxyGroupsResult.current || 'Direct';
            }

            // Sync resolver state to appStore
            appStore.set('uiPrimaryGroupName', proxyGroupsResult.uiPrimaryGroupName || null);
            appStore.set('effectiveGroupName', proxyGroupsResult.effectiveGroupName || null);

            // Validate uiGroupName: if the stored group no longer exists in proxyMap
            // (e.g. config changed), reset it so the resolver's primary takes over.
            // Actual initialization is handled by renderProxies to avoid redundant writes.
            const currentUiGroup = appStore.get('uiGroupName');
            if (currentUiGroup && proxyMap && !proxyMap[currentUiGroup]) {
                appStore.set('uiGroupName', null);
            }

            // Resolve to leaf node and display with suffix if needed
            const leafNode = resolveLeafNode(currentNode, proxyMap);
            const currentNodeEl = document.getElementById('current-node-name');
            if (currentNodeEl) {
                // Store the group name in data attribute for robust observed node updates
                currentNodeEl.dataset.group = currentNode;
                currentNodeEl.textContent = formatNodeDisplayName(currentNode, leafNode);
            }
        } else {
            // Fallback to Direct when no proxy groups available
            const currentNodeEl = document.getElementById('current-node-name');
            if (currentNodeEl) {
                delete currentNodeEl.dataset.group;
                currentNodeEl.textContent = 'Direct';
            }
        }
    } catch (e) {
        proxyLogger.warn('Failed to sync current node display', e);
    }
}

// --- Mode UI ---

/** @param {string} mode */
function updateModeUI(mode) {
    const buttons = document.querySelectorAll('[data-mode]');
    const slider = document.getElementById('mode-slider');
    const modes = ['rule', 'global', 'direct'];
    const idx = modes.indexOf(mode.toLowerCase());

    if (idx !== -1 && slider) {
        slider.style.transform = `translateX(calc(var(--rtl-sign, 1) * ${idx * 100}%))`;
        buttons.forEach((b, i) => {
            if (i === idx) {
                b.classList.add('text-[var(--text-primary)]');
                b.classList.remove('text-[var(--text-secondary)]');
            } else {
                b.classList.remove('text-[var(--text-primary)]');
                b.classList.add('text-[var(--text-secondary)]');
            }
        });
    }
}

// --- System Proxy UI ---

/**
 * Update the system proxy status text and toggle state from the backend.
 */
export async function updateSysProxyUI() {
    const statusText = document.getElementById('proxy-status-text');
    const toggle = document.getElementById('sys-proxy-toggle');

    try {
        const isActive = await invoke(COMMANDS.GET_SYS_PROXY);

        if (toggle && (/** @type {HTMLInputElement} */ (toggle)).checked !== isActive) {
            (/** @type {HTMLInputElement} */ (toggle)).checked = isActive;
        }

        if (!statusText) return;

        if (isActive) {
            statusText.textContent = /** @type {any} */ (translations)[currentLang].proxyStatusActive || 'Proxy Active';
            statusText.classList.remove('text-[var(--text-muted)]');
            statusText.classList.add('text-accent');
        } else {
            statusText.textContent = /** @type {any} */ (translations)[currentLang].proxyStatusReady || 'Ready to protect your traffic';
            statusText.classList.remove('text-accent');
            statusText.classList.add('text-[var(--text-muted)]');
        }
    } catch (err) {
        proxyLogger.error('Failed to update sys proxy UI', err);
    }
}

// --- Proxy Controls ---

/**
 * Initialize proxy control buttons (test latency, sort mode).
 */
export function initProxyControls() {
    const testBtn = document.getElementById('test-all-btn');
    const sortBtn = document.getElementById('sort-btn');
    const sortLabel = document.getElementById('sort-label');

    // Init sort label
    if (sortLabel) {
        const t = /** @type {any} */ (translations)[currentLang];
        const labels = { default: t.sortDefault, name: t.sortName, latency: t.sortLatency, smart: t.sortSmart };
        sortLabel.textContent = (/** @type {any} */ (labels))[appStore.get('currentSortMode')] || labels['default'];
    }

    if (testBtn) {
        // Safety: reset stale lock from previous session / old version
        if (appStore.get('isTestingLatency')) {
            const startTime = appStore.get('latencyTestStartTime');
            if (!startTime) {
                appStore.set('isTestingLatency', false);
            } else {
                const elapsed = Date.now() - startTime;
                if (elapsed > 120_000) {
                    proxyLogger.warn(`[LATENCY-TEST] Lock stuck for ${Math.round(elapsed / 1000)}s, force-resetting`);
                    appStore.set('isTestingLatency', false);
                }
            }
        }

        const searchInput = /** @type {HTMLInputElement|null} */ (document.getElementById('proxy-search'));
        if (searchInput && !searchInput.dataset.wired) {
            searchInput.dataset.wired = '1';
            /** @type {ReturnType<typeof setTimeout> | undefined} */
            let searchTimer;
            searchInput.addEventListener('input', () => {
                clearTimeout(searchTimer);
                searchTimer = setTimeout(() => { renderProxies().catch(() => {}); }, 120);
            });
            searchInput.addEventListener('keydown', (e) => {
                if (e.key === 'Escape' && searchInput.value) {
                    e.stopPropagation();
                    searchInput.value = '';
                    renderProxies().catch(() => {});
                }
            });
        }

        testBtn.onclick = async () => {
            // While a test runs the button reads "Stop · 8/19": a second click stops it.
            if (appStore.get('isTestingLatency')) {
                abortLatencyTests();
                return;
            }
            resetLatencyTestController();  // Reset controller before starting
            appStore.set('isTestingLatency', true);
            appStore.set('latencyTestStartTime', Date.now());

            const icon = document.getElementById('test-icon');
            const _t = /** @type {any} */ (translations)[currentLang];

            // While testing, the button is a Stop button: show a stop square instead of the pulse.
            const iconMarkup = icon?.innerHTML ?? '';
            if (icon) icon.innerHTML = '<rect x="6" y="6" width="12" height="12" rx="2.5" fill="currentColor" stroke="none"/>'; // nosemgrep: js-innerhtml-assignment — static markup
            const testLabel = testBtn.querySelector('span');
            let testedCount = 0;
            _testRunResults.clear();
            let totalCount = 0;
            /** Real outbound nodes this run measured; the fastest is picked from their latest figures. */
            const realNodesTested = new Set();
            /** Every node this run finished; the summary counts their latest figures. */
            const nodesFinished = new Set();
            const showProgress = () => {
                const tr = /** @type {any} */ (translations)[currentLang] || {};
                if (testLabel) testLabel.textContent = totalCount > 0 ? `${tr.latencyStop || 'Stop'} · ${testedCount}/${totalCount}` : (tr.latencyStop || 'Stop');
                testBtn.style.setProperty('--test-progress', totalCount > 0 ? `${Math.round((testedCount / totalCount) * 100)}%` : '0%');
            };
            testBtn.classList.add('is-testing');
            testBtn.setAttribute('aria-busy', 'true');
            showProgress();

            let hideTimeoutEnabled = false;

            try {
                showLatencyLoadingForAllCards();
                await renderProxies();

                // CRITICAL: Pass the user's currently-viewed group so the resolver
                // returns that group's proxies (individual node names), not the
                // effective group's proxies (which may be group-name references).
                // Without this, testProxyAndUpdate can't find DOM elements and
                // cards stay spinning forever.
                const proxyGroupsResult = await fetchProxyGroupsShared({
                    preferredGroupName: appStore.get('uiGroupName') || undefined,
                });
                if (!proxyGroupsResult) {
                    throw new Error('No valid proxy group found for testing');
                }
                const { data, proxies, uiGroupName: testedGroup } = proxyGroupsResult;
                const settings = await getSettingsCached();
                hideTimeoutEnabled = !!settings?.hide_timeout_nodes;

                // Filter out REJECT, COMPATIBLE, and PASS nodes
                const validProxiesToTest = proxies.filter((/** @type {string} */ name) => {
                    const node = (/** @type {any} */ (data)).proxies[name];
                    const type = node?.type?.toLowerCase() || '';
                    return type !== 'reject' && type !== 'compatible' && type !== 'pass';
                });

                if (validProxiesToTest.length === 0) {
                    showNotification(/** @type {any} */ (translations)[currentLang].noProxiesToTest || 'No proxies to test in current group', 'info');
                    return;
                }

                // Test a single proxy and update UI immediately
                const testProxyAndUpdate = async (/** @type {string} */ name) => {
                    // testProxy already handles abort internally and returns -1 on cancellation
                    const gen = beginNodeTest(name);
                    const delay = await testProxy(name);
                    // Cut short by Stop: no result, so neither a timeout on the card nor a
                    // failure for the smart score (the cleanup redraws pending cards).
                    if (getLatencyTestSignal().aborted && !(delay > 0)) return;
                    // A single-node re-test started after this one owns the card, and
                    // its newer figure is the one that counts.
                    const isLatest = isLatestNodeTest(name, gen);
                    if (!getLatencyTestSignal().aborted) {
                        testedCount += 1;
                        nodesFinished.add(name);
                        // "Fastest" means a real outbound node: direct/reject and groups
                        // (whose delay is just one of their members') never win it. The pick
                        // reads each node's latest figure, so a re-test can still qualify it.
                        const node = (/** @type {any} */ (data)).proxies?.[name];
                        const kind = String(node?.type || '').toLowerCase();
                        const isRealNode = !SPECIAL_PROXY_NAMES.has(name) && kind !== 'direct' && kind !== 'reject'
                            && !(Array.isArray(node?.all) && node.all.length > 0);
                        if (isRealNode) realNodesTested.add(name);
                        showProgress();
                    }

                    if (isLatest) {
                        applyNodeLatency(name, delay);
                        _testRunResults.set(name, delay);
                    }

                    // Timed-out nodes are hidden once the whole test finishes (the final
                    // re-render applies the filter), so cards don't vanish mid-test.
                    queueLatencySort();

                    // Update smart score via concurrency-limited batcher (max 2 IPC calls)
                    if (isLatest && document.documentElement.style.getPropertyValue('--smart-enabled') === '1') {
                        const success = delay > 0 && delay < 999999;
                        _smartBatcher.push(name, success ? delay : 999999, success);
                    }

                    // Report to failover engine if enabled
                    if (isLatest && appStore.get('failoverEnabled') && !getLatencyTestSignal().aborted) {
                        const failoverSuccess = delay > 0 && delay < 999999;
                        void reportFailover(name, failoverSuccess);
                    }
                };

                const priorityQueue = buildLatencyPriorityQueue(data, validProxiesToTest);
                totalCount = priorityQueue.length;
                showProgress();
                let queueIndex = 0;
                const concurrency = Math.min(12, priorityQueue.length);
                const workers = Array.from({ length: concurrency }, async () => {
                    while (queueIndex < priorityQueue.length) {
                        if (getLatencyTestSignal().aborted) break;
                        const currentIndex = queueIndex;
                        queueIndex += 1;
                        await testProxyAndUpdate(priorityQueue[currentIndex]);
                    }
                });
                await Promise.all(workers);

                // One summary instead of making the user scan every card.
                const tr = /** @type {any} */ (translations)[currentLang] || {};
                const stopped = getLatencyTestSignal().aborted;
                // Count each node's latest figure, so a re-test during the run (the one the
                // card shows) is what the summary reports too.
                let available = 0;
                for (const name of nodesFinished) {
                    const delay = _testRunResults.get(name) ?? -1;
                    if (delay > 0 && delay < 999999) available += 1;
                }
                const timedOut = nodesFinished.size - available;
                const parts = [
                    stopped ? (tr.latencyTestStopped || 'Test stopped') : (tr.latencyTestDone || 'Test complete'),
                    `${available} ${tr.latencyAvailable || 'available'}`,
                ];
                if (timedOut > 0) parts.push(`${timedOut} ${tr.latencyTimedOut || 'timed out'}`);
                // Read the latest figure per node: a re-test during the run (even a timeout) replaces it.
                /** @type {{ name: string, delay: number } | null} */
                let best = null;
                for (const name of realNodesTested) {
                    const delay = _testRunResults.get(name);
                    if (typeof delay === 'number' && delay > 0 && delay < 999999 && (!best || delay < best.delay)) best = { name, delay };
                }
                if (best) parts.push(`${tr.latencyFastest || 'fastest:'}${currentLang === 'zh' ? '' : ' '}${best.name} ${best.delay}ms`);
                showLatencyResult(parts.join(' · '), available > 0 ? 'ok' : 'warn', best, testedGroup || null);
            } catch (err) {
                proxyLogger.error('Latency test error', err);
                const _err = err instanceof Error ? err : new Error(String(err));
                showNotification(
                    `${/** @type {any} */ (translations)[currentLang].latencyTestFailed || 'Latency test failed'}: ${_err.message || err}`,
                    'error'
                );
            } finally {
                appStore.set('isTestingLatency', false);
                appStore.set('latencyTestStartTime', null);
                if (latencySortTimer) clearTimeout(latencySortTimer);
                // Restore UI controls first — must never be skipped by render failures
                // eslint-disable-next-line no-unsanitized/property -- restores the original static markup
                if (icon) icon.innerHTML = iconMarkup; // nosemgrep: js-innerhtml-assignment — static markup
                testBtn.classList.remove('is-testing');
                testBtn.removeAttribute('aria-busy');
                testBtn.style.removeProperty('--test-progress');
                if (testLabel) testLabel.textContent = /** @type {any} */ (translations)[currentLang]?.testLatency || 'Test Latency';
                // Safety net: clear stuck pending state and re-render BEFORE
                // sorting — the sort must not gate or block this cleanup.
                let hadStuckPending = false;
                try {
                    const container = document.getElementById('proxies-list');
                    if (container) {
                        const stuck = container.querySelectorAll('[data-pending="1"]');
                        hadStuckPending = stuck.length > 0;
                        stuck.forEach(el => {
                            (/** @type {HTMLElement} */ (el)).dataset.pending = '0';
                        });
                    }
                    invalidateProxiesCache();
                    if (hideTimeoutEnabled) flashHiddenChip();
                    if (hideTimeoutEnabled || hadStuckPending) {
                        await renderProxies();
                    }
                } catch (e) {
                    proxyLogger.warn('post-latency render failed', e);
                }
                // Sort is best-effort — failures here must not affect cleanup
                try {
                    if (appStore.get('currentSortMode') === 'smart') {
                        await _smartBatcher.wait();
                        await applySmartSortToDom();
                    } else {
                        applyLatencySortToDom(true);
                    }
                } catch (e) {
                    proxyLogger.warn('post-latency sort failed', e);
                }
            }
        };
    }

    if (sortBtn) {
        // A menu instead of "click to cycle": every option is visible, the current one ticked.
        sortBtn.setAttribute('aria-haspopup', 'menu');
        sortBtn.setAttribute('aria-expanded', 'false');
        sortBtn.onclick = (e) => {
            e.stopPropagation();
            toggleSortMenu(sortBtn, sortLabel);
        };
    }

    // Keeps --smart-enabled (score badges, smart sort) in step with the backend.
    void syncSmartUiVisibility();

    // Keyboard navigation for proxy list
    const proxyList = document.getElementById('proxies-list');
    if (proxyList) {
        _rovingInstance?.destroy();
        _rovingInstance = createRovingTabindex(proxyList, {
            itemSelector: '[role="option"]',
            onActivate: (item) => {
                const card = item.querySelector('.glass-card');
                if (card instanceof HTMLElement) card.click();
            },
            // The cards are a grid: ←/→ move one card, ↑/↓ one row.
            getColumns: () => getComputedStyle(proxyList).gridTemplateColumns.split(' ').filter(Boolean).length || 1,
            // Sorting reorders the cards with CSS order only.
            visualOrder: true,
        });
    }
}

// --- Render Proxies ---

// --- Group Explanation Bar ---

/**
 * Render the group explanation bar that shows when the uiGroup differs from
 * the effectiveGroup (the group that rules actually route traffic to).
 * This helps users understand why their selected node may not match the
 * connection page display.
 *
 * @param {string} uiGroupName - The group the user is currently operating on
 * @param {string|null} effectiveGroupName - The group inferred from rules
 * @param {Object} proxyMap - The proxy map from /proxies response (for writability check)
 */
// Track dismissed explanation bar by group pair key — prevents the bar from
// reappearing on every re-render when the user has already dismissed it.
// Resets automatically when the group pair changes.
/** @type {string|null} */
let _dismissedMismatchKey = null;

const MISMATCH_DISMISSED_KEY = 'zephyr.groupMismatchDismissed';

/** @param {string} key */
function isMismatchDismissed(key) {
    try {
        const list = JSON.parse(localStorage.getItem(MISMATCH_DISMISSED_KEY) || '[]');
        return Array.isArray(list) && list.includes(key);
    } catch { return false; }
}

/** @param {string} key */
function rememberMismatchDismissed(key) {
    try {
        const raw = JSON.parse(localStorage.getItem(MISMATCH_DISMISSED_KEY) || '[]');
        const list = Array.isArray(raw) ? raw.filter((k) => k !== key) : [];
        list.push(key);
        localStorage.setItem(MISMATCH_DISMISSED_KEY, JSON.stringify(list.slice(-50)));
    } catch { /* storage unavailable: the in-memory key still hides it this session */ }
}

/**
 * Report a proxy test result to the failover engine if the tested node
 * is the currently active node (or its resolved leaf).
 * Only active-node results are reported to avoid stale failure counts.
 * @param {string} name - Tested proxy name
 * @param {boolean} success - Whether the test succeeded
 */
async function reportFailover(name, success) {
    if (!appStore.get('failoverEnabled')) return;
    const uiGroupName = appStore.get('uiGroupName');
    const proxyMap = await getProxiesCached().then(getProxiesMerged).then(d => d?.proxies).catch(() => null);
    const currentNode = proxyMap?.[uiGroupName]?.now;
    const activeLeaf = currentNode ? resolveLeafNode(currentNode, proxyMap) : null;
    const activeNode = activeLeaf || currentNode;
    if (!activeNode || (name !== activeNode && name !== currentNode)) return;
    try {
        const action = await failoverReport(name, success);
        if (action) {
            void (async () => {
                try { await handleFailoverAction(action); }
                catch { /* ignore failover action errors */ }
            })();
        }
    } catch { /* ignore failover IPC errors */ }
}

/** @type {boolean} */
let _isFailovering = false;

/**
 * Handle a failover action returned by the failover engine.
 * Switches to the best available node (lowest latency) in the current group.
 * @param {{failedNode: string, failureCount: number, target: string}} action
 */
async function handleFailoverAction(action) {
    if (_isFailovering) return;
    _isFailovering = true;
    try {
        const uiGroupName = appStore.get('uiGroupName');
        if (!uiGroupName) return;

        const proxyMap = /** @type {Record<string, any>} */ (await getProxiesCached().then(getProxiesMerged).then(d => d?.proxies).catch(() => null));
        if (!proxyMap) return;

        const group = proxyMap[uiGroupName];
        if (!group?.all?.length) return;

        const currentNode = group.now;
        const activeLeaf = resolveLeafNode(currentNode, proxyMap);
        if (action.failedNode !== currentNode && action.failedNode !== activeLeaf) return;

        const candidates = group.all.filter(/** @param {string} n */ n => {
            if (n === action.failedNode) return false;
            const entry = proxyMap[n];
            if (!entry) return false;
            const nodeType = entry.type?.toLowerCase() || '';
            if (nodeType === 'reject' || nodeType === 'compatible' || nodeType === 'pass') return false;
            const leaf = resolveLeafNode(n, proxyMap);
            if (leaf === action.failedNode) return false;
            return true;
        });

        if (candidates.length === 0) return;

        let targetNode;
        if (action.target !== 'next' && candidates.includes(action.target)) {
            targetNode = action.target;
        } else {
            let bestNode = null;
            let bestDelay = Infinity;
            for (const name of candidates) {
                const leaf = resolveLeafNode(name, proxyMap);
                const lookupEntry = leaf ? proxyMap[leaf] : proxyMap[name];
                const history = lookupEntry?.history;
                if (history && history.length > 0) {
                    const lastDelay = history[history.length - 1]?.delay;
                    if (!isInvalidDelay(lastDelay) && lastDelay < bestDelay) {
                        bestDelay = lastDelay;
                        bestNode = name;
                    }
                }
            }
            targetNode = bestNode || candidates[0];
        }

        const success = await switchProxy(uiGroupName, targetNode);
        if (success) {
            showNotification(
                t('failoverSwitched', { failed: action.failedNode, target: targetNode }),
                'success'
            );
            void (async () => {
                try {
                    await closeAllConnections();
                    invalidateProxiesCache();
                    await syncCoreConfig();
                    await renderProxies();
                } catch { /* ignore post-failover errors */ }
            })();
        } else {
            // Automatic failover: log the rejected switch rather than raising a
            // notification, so a failing failover does not spam the user.
            proxyLogger.warn('Failover switch was not applied');
        }
    } finally {
        _isFailovering = false;
    }
}

/**
 * Resolve a proxy entry to its leaf node name.
 * If the entry is a group, recursively follow its `now` selection.
 * @param {string} name - Proxy or group name
 * @param {Record<string, any>} proxyMap - Full proxy map
 * @param {Set<string>} [visited] - Internal set to detect cycles
 * @returns {string|null} - Leaf node name or null
 */
export function resolveLeafNode(name, proxyMap, visited = new Set()) {
    if (!name || !proxyMap) return null;
    if (visited.has(name)) return null; // Cycle detected
    visited.add(name);

    const entry = proxyMap[name];
    if (!entry) return name;

    // If it's a group with a 'now' selection, recurse if the selection is in proxyMap,
    // otherwise the selection itself is the leaf/special node (e.g., DIRECT, REJECT)
    if (entry.now) {
        if (proxyMap[entry.now]) {
            return resolveLeafNode(entry.now, proxyMap, visited);
        }
        return entry.now;
    }

    // Leaf node (or group without 'now')
    return name;
}

/** Straight arrow: traffic goes out directly. */
const DIRECT_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="12" x2="20" y2="12"/><polyline points="14 6 20 12 14 18"/></svg>';

/** Circular arrow: re-test one node. */
const RETEST_ICON = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><polyline points="21 3 21 9 15 9"/></svg>';

/** Results of the running full test, so a re-render mid-test (search, sort) keeps them instead of re-pending. */
const _testRunResults = new Map();

/** Latest latency request per node: an older request finishing late must not win. */
const _nodeTestGen = new Map();
/** @param {string} name @returns {number} */
function beginNodeTest(name) {
    const gen = (_nodeTestGen.get(name) || 0) + 1;
    _nodeTestGen.set(name, gen);
    return gen;
}
/** @param {string} name @param {number} gen */
function isLatestNodeTest(name, gen) {
    return _nodeTestGen.get(name) === gen;
}

/**
 * Write a measured delay (or a timeout) to a node's wrapper and card, so the shown
 * figure and the latency sort agree.
 * @param {string} name
 * @param {number} delay - ms, or <= 0 for a timeout / failure
 */
function applyNodeLatency(name, delay) {
    const ok = delay > 0 && delay < 999999;
    const value = ok ? delay : DELAY_INFINITE;
    const wrapper = document.getElementById('proxies-list')?.querySelector(`[data-name="${CSS.escape(name)}"]`);
    if (wrapper instanceof HTMLElement) {
        wrapper.dataset.latency = String(value);
        setProxyPendingState(/** @type {HTMLElement} */ (wrapper.firstElementChild), false);
    }
    const latVal = document.getElementById(`latency-${CSS.escape(name)}`);
    if (!latVal) return;
    const card = latVal.closest('.glass-card');
    if (ok) {
        latVal.textContent = `${delay}ms`;
        latVal.className = `text-xs tabular-nums font-semibold ${getDelayColorClass(delay)}`;
    } else {
        latVal.textContent = /** @type {any} */ (translations)[currentLang]?.timeout || 'Timeout';
        latVal.className = 'text-xs tabular-nums font-semibold text-[var(--text-tertiary)]';
    }
    setCardDelayTier(card, value);
    if (card instanceof HTMLElement) {
        card.dataset.latency = String(value);
        setProxyPendingState(card, false);
    }
}

/**
 * Test one node's latency and update its card in place (no node switch).
 * @param {string} name
 * @param {HTMLElement} latVal
 * @param {HTMLButtonElement} btn
 */
async function retestSingleNode(name, latVal, btn) {
    if (btn.disabled) return;
    btn.disabled = true;
    btn.classList.add('is-spinning');
    try {
        // A Stop pressed earlier leaves the shared signal aborted, which would cancel
        // this request at once; with no full test running, start from a fresh one.
        if (getLatencyTestSignal().aborted && !appStore.get('isTestingLatency')) resetLatencyTestController();
        const signal = getLatencyTestSignal();
        // A stopped full test is still winding down: this request would be cancelled
        // at once and read as a timeout, so leave the card alone.
        if (signal.aborted) return;
        const gen = beginNodeTest(name);
        const delay = await testProxy(name);
        // Cut short by Stop: no measurement, so leave the card as it was.
        if (signal.aborted && !(delay > 0)) return;
        // A newer test of this node (the full list) owns the result.
        if (!isLatestNodeTest(name, gen)) return;
        applyNodeLatency(name, delay);
        // Mid-test re-renders replay the run's results; keep this newer figure there.
        if (appStore.get('isTestingLatency') || _testRunResults.has(name)) _testRunResults.set(name, delay);
        // Feed the smart score like a full test does, so the badge and smart order follow.
        if (document.documentElement.style.getPropertyValue('--smart-enabled') === '1') {
            const success = delay > 0 && delay < 999999;
            _smartBatcher.push(name, success ? delay : 999999, success);
        }
        // Keep the latency / smart sort in step with the new figure.
        if (appStore.get('currentSortMode') === 'latency') applyLatencySortToDom();
        else if (appStore.get('currentSortMode') === 'smart') {
            await _smartBatcher.wait();
            await applySmartSortToDom();
        }
        invalidateProxiesCache();
        // A node that just timed out drops out of the list when timeouts are hidden.
        if (!(delay > 0 && delay < 999999) && (await getSettingsCached())?.hide_timeout_nodes) {
            flashHiddenChip();
            await renderProxies();
        }
    } catch (err) {
        proxyLogger.warn('Single node test failed', err);
    } finally {
        btn.disabled = false;
        btn.classList.remove('is-spinning');
    }
}

/** @type {ReturnType<typeof setTimeout>|null} */
let _latencyResultTimer = null;

/**
 * One-line test result pinned to the bottom of the proxies page, with a one-tap switch
 * to the fastest node when it isn't the one in use.
 * @param {string} text
 * @param {'ok'|'warn'} tone
 * @param {{ name: string, delay: number } | null} fastest
 * @param {string|null} [testedGroup] - the group the test ran on; the switch goes there
 */
function showLatencyResult(text, tone, fastest, testedGroup = null) {
    const page = document.querySelector('[data-page="proxies"]');
    if (!page) { showNotification(text, tone === 'ok' ? 'success' : 'warning'); return; }
    page.querySelector('.latency-result')?.remove();
    if (_latencyResultTimer) clearTimeout(_latencyResultTimer);
    const bar = document.createElement('div');
    bar.className = 'latency-result';
    bar.dataset.tone = tone;
    bar.setAttribute('role', 'status');
    const dot = document.createElement('span');
    dot.className = 'latency-result-dot';
    dot.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    label.className = 'latency-result-text';
    bar.append(dot, label);
    // The list shows the tested group's selection only while that group is still open.
    const showsTestedGroup = !testedGroup || testedGroup === appStore.get('uiGroupName');
    const current = showsTestedGroup ? document.querySelector('#proxies-list .proxy-card--selected')?.closest('[data-name]') : null;
    const currentName = current instanceof HTMLElement ? current.dataset.name : null;
    if (fastest && fastest.name !== currentName) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'latency-result-action';
        btn.textContent = t('latencySwitchFastest');
        btn.addEventListener('click', () => {
            bar.remove();
            void switchToFastest(testedGroup, fastest.name);
        });
        bar.appendChild(btn);
    }
    page.appendChild(bar);
    // Text goes in after the live region is in the page, so screen readers announce it.
    requestAnimationFrame(() => {
        label.textContent = text;
        bar.classList.add('is-shown');
    });
    _latencyResultTimer = setTimeout(() => {
        bar.classList.remove('is-shown');
        setTimeout(() => bar.remove(), 300);
    }, 8000);
}

/**
 * Switch the tested group to its fastest node, the same way a card click does:
 * save the choice for the profile, close open connections, report a failure.
 * @param {string|null} testedGroup
 * @param {string} node
 */
async function switchToFastest(testedGroup, node) {
    const tr = /** @type {any} */ (translations)[appStore.get('currentLang')] || {};
    try {
        const group = testedGroup || (await fetchProxyGroupsShared({ preferredGroupName: appStore.get('uiGroupName') || undefined }))?.uiGroupName;
        // The selected card may be filtered out of view: ask the core (uncached, as a
        // stale selection would skip a switch still needed), and do not re-select (and
        // close every connection for) the node already in use.
        const proxyMap = group
            ? await getProxies().then(getProxiesMerged).then(d => d?.proxies).catch(() => null)
            : null;
        if (group && proxyMap?.[group]?.now === node) {
            notifySwitched(node, false);
            return;
        }
        if (!group || !(await switchProxy(group, node))) {
            showNotification(tr.proxySwitchFailed || 'Failed to switch proxy', 'error');
            return;
        }
        invalidateProxiesCache();
        try {
            const settings = await getSettingsCached();
            await saveProxySelection(settings?.last_config || 'config.yaml', { node, group });
        } catch (e) {
            proxyLogger.warn('Failed to save proxy selection', e);
        }
        notifySwitched(node, await closeConnsAfterSwitch());
        // The switch already happened: a failed refresh afterwards is not a failed switch.
        await syncCoreConfig().catch((e) => proxyLogger.warn('Config sync after switch failed', e));
        await renderProxies().catch((e) => proxyLogger.warn('Re-render after switch failed', e));
    } catch (err) {
        proxyLogger.warn('Switch to fastest node failed', err);
        showNotification(`${tr.proxySwitchFailed || 'Failed to switch proxy'}: ${String(/** @type {any} */ (err)?.message ?? err)}`, 'error');
    }
}

/** Bold check marking the active sort option. */
const CHECK_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 8.5l3 3 6-7"/></svg>';

/** @type {HTMLElement|null} */
let _sortMenu = null;

/** Close the sort menu if open. */
function closeSortMenu() {
    if (!_sortMenu) return;
    _sortMenu.remove();
    _sortMenu = null;
    document.getElementById('sort-btn')?.setAttribute('aria-expanded', 'false');
    document.removeEventListener('click', closeSortMenu);
    document.removeEventListener('keydown', onSortMenuKey, true);
    document.removeEventListener('focusin', onSortMenuFocusIn);
}

/** Focus moved outside the menu and its button (Tab): close it. @param {FocusEvent} e */
function onSortMenuFocusIn(e) {
    const target = /** @type {Node|null} */ (e.target);
    if (!_sortMenu || !target) return;
    if (_sortMenu.contains(target) || document.getElementById('sort-btn')?.contains(target)) return;
    closeSortMenu();
}

/** @param {KeyboardEvent} e */
function onSortMenuKey(e) {
    if (e.key === 'Escape') {
        e.stopPropagation();
        closeSortMenu();
        document.getElementById('sort-btn')?.focus();
        return;
    }
    if (!_sortMenu) return;
    const items = /** @type {HTMLElement[]} */ (Array.from(_sortMenu.querySelectorAll('[role="menuitemradio"]')));
    if (items.length === 0) return;
    const at = items.indexOf(/** @type {HTMLElement} */ (document.activeElement));
    /** @type {Record<string, number>} */
    const moves = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: items.length - 1 };
    if (!(e.key in moves)) return;
    e.preventDefault();
    e.stopPropagation();
    items[(moves[e.key] + items.length) % items.length].focus();
}

/**
 * @param {HTMLElement} sortBtn
 * @param {HTMLElement|null} sortLabel
 */
function toggleSortMenu(sortBtn, sortLabel) {
    if (_sortMenu) { closeSortMenu(); return; }
    const tr = /** @type {any} */ (translations)[currentLang] || {};
    const smartEnabled = document.documentElement.style.getPropertyValue('--smart-enabled') === '1';
    if (!smartEnabled && appStore.get('currentSortMode') === 'smart') appStore.set('currentSortMode', 'default');
    const modes = smartEnabled ? ['default', 'name', 'latency', 'smart'] : ['default', 'name', 'latency'];
    /** @type {Record<string, [string, string]>} */
    const text = {
        default: [tr.sortDefault, tr.sortDefaultDesc],
        name: [tr.sortName, tr.sortNameDesc],
        latency: [tr.sortLatency, tr.sortLatencyDesc],
        smart: [tr.sortSmart, tr.sortSmartDesc],
    };
    const menu = document.createElement('div');
    menu.className = 'proxy-group-menu proxy-sort-menu rounded-lg shadow-2xl border border-[var(--zephyr-border-default)]';
    menu.setAttribute('role', 'menu');
    const current = appStore.get('currentSortMode') || 'default';
    for (const mode of modes) {
        const item = document.createElement('button');
        item.type = 'button';
        item.setAttribute('role', 'menuitemradio');
        item.setAttribute('aria-checked', mode === current ? 'true' : 'false');
        item.className = 'proxy-sort-option';
        const check = document.createElement('span');
        check.className = 'proxy-group-check';
        check.setAttribute('aria-hidden', 'true');
        // eslint-disable-next-line no-unsanitized/property -- static SVG constant
        if (mode === current) check.innerHTML = CHECK_ICON; // nosemgrep: js-innerhtml-assignment — static markup
        const body = document.createElement('span');
        body.className = 'proxy-sort-body';
        const title = document.createElement('span');
        title.className = 'proxy-sort-title';
        title.textContent = text[mode][0] || mode;
        body.appendChild(title);
        if (text[mode][1]) {
            const desc = document.createElement('span');
            desc.className = 'proxy-sort-desc';
            desc.textContent = text[mode][1];
            body.appendChild(desc);
        }
        item.append(body, check);
        item.addEventListener('click', async (e) => {
            e.stopPropagation();
            const hadFocus = item === document.activeElement;
            closeSortMenu();
            if (hadFocus) sortBtn.focus();
            appStore.set('currentSortMode', mode);
            if (sortLabel) sortLabel.textContent = text[mode][0] || mode;
            await refreshProxies();
            if (mode === 'smart') await applySmartSortToDom().catch((err) => proxyLogger.warn('Smart sort failed', err));
        });
        menu.appendChild(item);
    }
    sortBtn.parentElement?.appendChild(menu);
    // Open under the button; flip to its end edge when that would leave the window.
    const box = menu.getBoundingClientRect();
    if (box.right > window.innerWidth - 8 || box.left < 8) menu.classList.add('is-end');
    _sortMenu = menu;
    sortBtn.setAttribute('aria-expanded', 'true');
    /** @type {HTMLElement|null} */ (menu.querySelector('[aria-checked="true"]'))?.focus();
    setTimeout(() => {
        document.addEventListener('click', closeSortMenu);
        document.addEventListener('keydown', onSortMenuKey, true);
        document.addEventListener('focusin', onSortMenuFocusIn);
    }, 0);
}

/** Magnifier: no search matches. */
const SEARCH_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>';
/** Stack of cards: no nodes. */
const NODES_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="6" rx="2"/><rect x="3" y="14" width="18" height="6" rx="2"/></svg>';

/** The search box and "show hidden" only apply to the group they were used in. */
let _searchGroup = /** @type {string|null} */ (null);
/** Temporarily show nodes that "hide timed-out nodes" filtered (setting unchanged). */
let _showHiddenTimeouts = false;
/** The hidden-timeout chip only flashes for a few seconds after a latency test, so the header stays calm. */
const HIDDEN_CHIP_MS = 5000;
let _hiddenChipUntil = 0;
/** @type {ReturnType<typeof setTimeout> | null} */
let _hiddenChipTimer = null;
/** @type {Parameters<typeof setProxyHeaderMeta>[0]} */
let _lastHeaderMeta = null;

function flashHiddenChip() {
    _hiddenChipUntil = Date.now() + HIDDEN_CHIP_MS;
    if (_hiddenChipTimer) clearTimeout(_hiddenChipTimer);
    _hiddenChipTimer = setTimeout(() => {
        _hiddenChipTimer = null;
        setProxyHeaderMeta(_lastHeaderMeta);
    }, HIDDEN_CHIP_MS + 50);
}

/** @param {string} title */
function buildNoNodesState(title) {
    const tr = /** @type {any} */ (translations)[currentLang] || {};
    return buildProxiesEmptyState({
        icon: NODES_ICON,
        title,
        actionLabel: tr.addSubscription || 'Add Subscription',
        onAction: () => {
            import('./navigation.js').then((m) => {
                m.navigateTo('subscriptions');
                requestAnimationFrame(() => document.getElementById('add-sub-btn')?.click());
            }).catch(() => {});
        },
    });
}

/**
 * Header read-outs next to the group button: hidden-timeout chip and search count.
 * (No standing node count: the header was too crowded and the cards show the list anyway.)
 * @param {{ total: number, matched: number|null, searchedFrom: number, hidden: number, hideEnabled: boolean } | null} meta
 */
function setProxyHeaderMeta(meta) {
    _lastHeaderMeta = meta;
    const chip = document.getElementById('proxy-hidden-chip');
    const searchCount = document.getElementById('proxy-search-count');
    if (searchCount) searchCount.textContent = meta?.matched != null ? `${meta.matched}/${meta.searchedFrom}` : '';
    if (!chip) return;
    const flashing = Date.now() < _hiddenChipUntil;
    const showChip = !!meta && meta.hideEnabled && (_showHiddenTimeouts || (flashing && meta.hidden > 0));
    chip.classList.toggle('hidden', !showChip);
    if (!showChip || !meta) return;
    chip.replaceChildren();
    const label = document.createElement('span');
    label.textContent = _showHiddenTimeouts ? '' : tFmt('hiddenTimeoutNodes', { count: String(meta.hidden) });
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = _showHiddenTimeouts ? t('hideTimedOutAgain') : t('showHiddenNodes');
    btn.addEventListener('click', () => {
        _showHiddenTimeouts = !_showHiddenTimeouts;
        renderProxies().catch(() => {});
    });
    if (label.textContent) chip.append(label, '·', btn); else chip.append(btn);
}

/** Circle with exclamation mark: the core could not be reached. */
const ALERT_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>';

/** Sort / test-all mean nothing when no node is used (direct mode). */
function setProxyToolsHidden(/** @type {boolean} */ hidden) {
    for (const id of ['sort-btn', 'test-all-btn']) {
        document.getElementById(id)?.classList.toggle('hidden', hidden);
    }
    // Search means nothing without a node list (direct mode / no nodes).
    const search = /** @type {HTMLElement|null} */ (document.querySelector('label.proxy-search'));
    if (search) search.style.display = hidden ? 'none' : '';
}

/**
 * Empty state for the node list: centred in the list's full height, icon, title,
 * one muted line and one primary action.
 * `card` puts it on a panel at the top of the list (a mode, not a missing list) with a soft action.
 * @param {{ icon: string, title: string, detail?: string, tone?: 'danger', card?: boolean, actionLabel?: string, onAction?: (btn: HTMLButtonElement) => void }} opts
 * @returns {HTMLElement}
 */
function buildProxiesEmptyState({ icon, title, detail, tone, card, actionLabel, onAction }) {
    const wrap = document.createElement('div');
    wrap.className = tone === 'danger' ? 'proxies-empty-state is-danger' : 'proxies-empty-state';
    if (card) wrap.classList.add('is-card');
    const ic = document.createElement('div');
    ic.className = 'proxies-empty-icon';
    ic.setAttribute('aria-hidden', 'true');
    // eslint-disable-next-line no-unsanitized/property -- static icon markup from SVG_ICONS // nosemgrep: js-innerhtml-assignment
    ic.innerHTML = icon;
    const h = document.createElement('h3');
    h.className = 'proxies-empty-title';
    h.textContent = title;
    wrap.append(ic, h);
    if (detail && detail !== title) {
        const p = document.createElement('p');
        p.className = 'proxies-empty-detail';
        p.textContent = detail;
        wrap.appendChild(p);
    }
    if (actionLabel && onAction) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = card ? 'btn-accent proxies-empty-action' : 'btn-primary proxies-empty-action';
        btn.textContent = actionLabel;
        btn.addEventListener('click', () => onAction(btn));
        wrap.appendChild(btn);
    }
    return wrap;
}

/** Pair the bar shows now; the live region is rebuilt only when it changes. @type {string|null} */
let _renderedMismatchKey = null;
/**
 * The list shows no group (direct mode, loading, an empty or error state), so no
 * group explanation applies, even when observed traffic changes meanwhile.
 */
let _barSuppressed = false;

function hideGroupExplanationBar() {
    _renderedMismatchKey = null;
    const bar = document.getElementById('group-explanation-bar');
    bar?.classList.add('hidden');
    bar?.classList.remove('flex');
}

/** Hide the bar for a list state that shows no group, until a group list renders again. */
function suppressGroupExplanationBar() {
    _barSuppressed = true;
    hideGroupExplanationBar();
}

/** @param {string} uiGroupName @param {string|null} effectiveGroupName @param {string|null} observedGroupName @param {string|null} observedNodeName @param {Record<string, any>} proxyMap */
function renderGroupExplanationBar(uiGroupName, effectiveGroupName, observedGroupName, observedNodeName, proxyMap) {
    const bar = document.getElementById('group-explanation-bar');
    if (!bar) return;
    if (_barSuppressed) { hideGroupExplanationBar(); return; }

    const decision = decideGroupMismatch({
        uiGroupName,
        effectiveGroupName,
        observedGroupName,
        observedNodeName,
        uiLeafNode: resolveLeafNode(uiGroupName, proxyMap),
        proxyMap,
    });

    if (!decision) {
        hideGroupExplanationBar();
        _dismissedMismatchKey = null;
        return;
    }

    const showObserved = decision.kind === 'observed';
    // One key per group pair; a dismissed pair stays quiet across sessions.
    const mismatchKey = `${uiGroupName}|${decision.target}`;
    if (_dismissedMismatchKey === mismatchKey || isMismatchDismissed(mismatchKey)) {
        hideGroupExplanationBar();
        return;
    }
    // Same message already showing: leave the live region alone so it is not re-announced.
    // The headline depends on the kind too, so it is part of the rendered key.
    // The language is part of the key: the bar's spans carry no data-i18n, so a
    // language change must rebuild them.
    const renderedKey = `${mismatchKey}|${decision.kind}|${currentLang}`;
    if (_renderedMismatchKey === renderedKey && !bar.classList.contains('hidden')) return;
    _renderedMismatchKey = renderedKey;

    bar.classList.remove('hidden');
    bar.classList.add('flex');
    bar.replaceChildren();

    const icon = document.createElement('span');
    icon.className = 'group-mismatch-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>';

    // Blue explanation, not a warning: a title saying which group is in charge, then what to do.
    const text = document.createElement('span');
    text.className = 'group-mismatch-text';
    const title = document.createElement('span');
    title.className = 'group-mismatch-title';
    title.textContent = t(showObserved ? 'groupMismatchTrafficTitle' : 'groupMismatchRulesTitle', { target: decision.target });
    const hint = document.createElement('span');
    hint.className = 'group-mismatch-hint';
    hint.textContent = t('groupMismatchHint');
    text.append(title, hint);

    // Quick-switch button
    const btn = document.createElement('button');
    btn.type = 'button';
    const targetGroup = decision.target;
    const targetType = proxyMap?.[targetGroup]?.type || '';
    // A hidden selector cannot be opened in the group menu, so it is not switchable here either.
    const targetIsWritable = isWritableGroupType(targetType) && !proxyMap?.[targetGroup]?.hidden;

    if (targetIsWritable) {
        btn.className = 'group-mismatch-action';
        btn.textContent = t('openMismatchGroup');
        btn.onclick = async () => {
            try {
                appStore.set('uiGroupName', targetGroup);
                invalidateProxiesCache();
                invalidateRunConfigCache();
                // Persist group preference for restore after restart
                const settings = await getSettingsCached();
                const profileName = settings?.last_config;
                if (profileName) {
                    savePrimaryGroupPreference(profileName, targetGroup).catch(() => {});
                }
                await renderProxies();
            } catch (e) {
                proxyLogger.warn('Failed to switch group', e);
            }
        };
    } else {
        btn.className = 'group-mismatch-action is-disabled';
        btn.textContent = showObserved
            ? t('observedGroupNotSwitchable')
            : t('effectiveGroupNotSwitchable');
        btn.disabled = true;
    }

    // Dismiss button
    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'group-mismatch-close';
    dismiss.textContent = '\u00D7';
    dismiss.title = t('dismiss');
    dismiss.setAttribute('aria-label', t('dismiss'));
    dismiss.onclick = () => {
        _dismissedMismatchKey = mismatchKey;
        rememberMismatchDismissed(mismatchKey);
        bar.classList.add('hidden');
        bar.classList.remove('flex');
    };

    bar.appendChild(icon);
    bar.appendChild(text);
    bar.appendChild(btn);
    bar.appendChild(dismiss);
}

// --- Group Selector Dropdown ---

/** @type {boolean} */
let _groupSelectorInitialized = false;

/** @type {HTMLElement|null} */
let _groupMenuElement = null;

/**
 * Render the group selector dropdown with available groups.
 * @param {string[]} groups - List of available group names
 * @param {string} currentGroup - Currently selected group name
 */
function renderGroupSelector(groups, currentGroup, proxyMap = {}) {
    const selector = document.getElementById('proxy-group-selector');
    const trigger = document.getElementById('proxy-group-trigger');
    const label = document.getElementById('proxy-group-label');

    if (!selector || !trigger || !label) return;

    // Hide if no groups available
    if (!groups || groups.length === 0) {
        selector.classList.add('hidden');
        return;
    }

    // Show selector
    selector.classList.remove('hidden');

    // Update label
    label.textContent = currentGroup || 'Auto';

    // Create or get menu element (attached to body to avoid overflow clipping)
    if (!_groupMenuElement) {
        _groupMenuElement = document.createElement('div');
        _groupMenuElement.id = 'proxy-group-menu';
        _groupMenuElement.className = 'proxy-group-menu hidden fixed border border-[var(--zephyr-border-default)] rounded-lg shadow-2xl';
        _groupMenuElement.style.zIndex = '99999';
        const scrollDiv = document.createElement('div');
        scrollDiv.className = 'menu-scroll max-h-[300px]';
        _groupMenuElement.appendChild(scrollDiv);
        document.body.appendChild(_groupMenuElement);
    }
    const menu = _groupMenuElement;
    const menuScroll = /** @type {HTMLElement} */ (menu.querySelector('.menu-scroll'));

    // Build menu items

    menuScroll.replaceChildren();
    groups.forEach(groupName => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'proxy-group-option w-full text-start px-3 py-2 rounded-[var(--radius-dropdown-option)] text-xs text-[var(--text-secondary)] hover:bg-[var(--zephyr-bg-muted)] transition-colors';
        btn.dataset.group = groupName;
        const isCurrent = groupName === currentGroup;
        if (isCurrent) {
            btn.classList.add('active');
            btn.setAttribute('aria-current', 'true');
        }
        // Check mark stays on the current group (hover no longer moves the highlight);
        // the muted right-hand text says which node each group uses right now.
        const check = document.createElement('span');
        check.className = 'proxy-group-check';
        check.setAttribute('aria-hidden', 'true');
        // eslint-disable-next-line no-unsanitized/property -- static SVG constant
        if (isCurrent) check.innerHTML = CHECK_ICON; // nosemgrep: js-innerhtml-assignment — static markup
        const nameEl = document.createElement('span');
        nameEl.className = 'proxy-group-name';
        nameEl.textContent = groupName;
        const route = document.createElement('span');
        route.className = 'proxy-group-route';
        const leaf = resolveLeafNode(groupName, proxyMap);
        // Show the hop when a group points at another group ("节点选择 → 🇭🇰 香港-01"),
        // and say 直连 rather than DIRECT.
        const via = /** @type {any} */ (proxyMap)?.[groupName]?.now;
        const label = (/** @type {string} */ n) => (n === 'DIRECT' ? t('modeDirect') : n);
        if (!leaf || leaf === groupName) route.textContent = '';
        else if (via && via !== leaf) route.textContent = `${label(via)} → ${label(leaf)}`;
        else route.textContent = label(leaf);
        route.title = route.textContent;
        btn.append(check, nameEl, route);
        btn.onclick = async () => {
            // Close menu
            menu.classList.add('hidden');
            trigger.querySelector('.dropdown-arrow')?.classList.remove('rotate-180');

            // Switch group
            try {
                appStore.set('uiGroupName', groupName);
                invalidateProxiesCache();
                invalidateRunConfigCache();

                // Persist preference
                const settings = await getSettingsCached();
                const profileName = settings?.last_config;
                if (profileName) {
                    savePrimaryGroupPreference(profileName, groupName).catch(() => {});
                }

                // Re-render
                await renderProxies();
            } catch (e) {
                proxyLogger.warn('Failed to switch group', e);
                showNotification(String(e), 'error');
            }
        };
        menuScroll.appendChild(btn);
    });

    // Store current group for mouseleave restore
    menuScroll.dataset.currentGroup = currentGroup;

    // Initialize event listeners once
    if (!_groupSelectorInitialized) {
        _groupSelectorInitialized = true;

        // mouseleave restores active on the current group (registered once)
        menuScroll.addEventListener('mouseleave', () => {
            const current = menuScroll.dataset.currentGroup;
            menuScroll.querySelectorAll('.proxy-group-option').forEach(b => {
                b.classList.toggle('active', /** @type {HTMLElement} */ (b).dataset.group === current);
            });
        });

        // Toggle menu
        trigger.addEventListener('click', (e) => {
            e.stopPropagation();
            const isHidden = menu.classList.contains('hidden');
            if (isHidden) {
                // Position the fixed menu below the trigger
                const rect = trigger.getBoundingClientRect();
                const uiScale = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ui-scale')) || 1;
                const isRTL = getDirection() === 'rtl';
                const inlineStart = isRTL ? (window.innerWidth - rect.right) : rect.left;
                menu.style.insetInlineStart = (inlineStart / uiScale) + 'px';
                menu.style.insetInlineEnd = 'auto';
                menu.style.top = ((rect.bottom + 6) / uiScale) + 'px';
                menu.style.width = (Math.max(rect.width, 160) / uiScale) + 'px';
                menu.classList.remove('hidden');
                trigger.querySelector('.dropdown-arrow')?.classList.add('rotate-180');

                // Viewport overflow correction (mirrors context-menu.js logic)
                requestAnimationFrame(() => {
                    const menuRect = menu.getBoundingClientRect();
                    if (isRTL ? menuRect.left < 0 : menuRect.right > window.innerWidth) {
                        menu.style.insetInlineStart = 'auto';
                        menu.style.insetInlineEnd = (8 / uiScale) + 'px';
                    }
                    if (menuRect.bottom > window.innerHeight) {
                        menu.style.top = ((window.innerHeight - menuRect.height - 8) / uiScale) + 'px';
                    }
                });
            } else {
                menu.classList.add('hidden');
                trigger.querySelector('.dropdown-arrow')?.classList.remove('rotate-180');
            }
        });

        // Close on outside click
        document.addEventListener('click', (e) => {
            if (!selector.contains(/** @type {Node} */ (e.target)) && !menu.contains(/** @type {Node} */ (e.target))) {
                menu.classList.add('hidden');
                trigger.querySelector('.dropdown-arrow')?.classList.remove('rotate-180');
            }
        });

        // Close on Escape
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && !menu.classList.contains('hidden')) {
                menu.classList.add('hidden');
                trigger.querySelector('.dropdown-arrow')?.classList.remove('rotate-180');
            }
        });

        // Close on scroll or resize to prevent menu misalignment
        const closeMenu = () => {
            if (!menu.classList.contains('hidden')) {
                menu.classList.add('hidden');
                trigger.querySelector('.dropdown-arrow')?.classList.remove('rotate-180');
            }
        };
        window.addEventListener('scroll', closeMenu, { passive: true });
        window.addEventListener('resize', closeMenu, { passive: true });
    }
}

/** @type {ReturnType<typeof setTimeout> | null} */
let _loadingTimeout = null;

/** Provider-loading poller handle (retry when include-all group has empty all[]). */
/** @type {ReturnType<typeof setTimeout> | null} */
let _providerPollTimer = null;

/** True while the poll's async fetch/resolve cycle is in-flight. */
let _providerPollInFlight = false;

/** Maximum provider-loading retries (≈30 s at 1.5 s interval). */
const PROVIDER_POLL_MAX = 20;

/** Special proxy names that never have detail records in /proxies. */
/**
 * Whether the proxy map holds at least one real outbound node (not DIRECT/REJECT-like, not a group).
 * @param {Record<string, any>} proxyMap
 * @returns {boolean}
 */
function hasAnyRealNode(proxyMap) {
    return Object.entries(proxyMap).some(([name, node]) => {
        if (SPECIAL_PROXY_NAMES.has(name.toUpperCase())) return false;
        // Any group record, even an empty one, is not a node.
        if (Array.isArray(node?.all)) return false;
        const kind = String(node?.type || '').toLowerCase();
        return !['direct', 'reject', 'reject-drop', 'compatible', 'pass'].includes(kind);
    });
}

/**
 * A provider-fed (`use:` / include-all) group whose own members are still only
 * DIRECT/REJECT-style entries (or nothing): its provider's nodes have not arrived,
 * whatever other groups hold. The provider poll is bounded, so this cannot spin forever.
 * @param {unknown[]} members
 */
function providerMembersPending(members) {
    return members.every((n) => SPECIAL_PROXY_NAMES.has(String(n).toUpperCase()));
}

/**
 * Only DIRECT / REJECT in the group and no real node anywhere in the config.
 * @param {string[]} members
 * @param {Record<string, any> | undefined} proxyMap
 */
function hasOnlySpecialMembers(members, proxyMap) {
    return members.length > 0
        && members.every((n) => SPECIAL_PROXY_NAMES.has(String(n).toUpperCase()))
        && !hasAnyRealNode(proxyMap || {});
}

// SPECIAL_PROXY_NAMES imported from api.js (single source of truth)

/**
 * Check whether any proxy name in `names` is missing from `proxiesMap`.
 * Special entries (DIRECT, REJECT, PASS, COMPATIBLE) are excluded because
 * they never appear as detail records in the /proxies API response.
 * @param {string[]} names - Proxy names from group.all[]
 * @param {Record<string, any>|undefined} proxiesMap - The proxies map from /proxies
 * @returns {boolean}
 */
function hasMissingProxyDetails(names, proxiesMap) {
    return names.some(name =>
        typeof name === 'string'
        && !SPECIAL_PROXY_NAMES.has(name.toUpperCase())
        && !Object.prototype.hasOwnProperty.call(proxiesMap ?? {}, name)
    );
}

/** Generation token: incremented on stop to cancel in-flight poll callbacks. */
let _providerPollGeneration = 0;

/** Render generation token: prevents stale renderProxies() invocations from
 *  overwriting a newer render after an async fetch completes. */
let _renderGeneration = 0;

/**
 * Group name for which provider polling was exhausted (undefined = not exhausted).
 * Prevents re-entering the poll loop for the same group after max retries.
 * Uses `undefined` (not `null`) as the sentinel because `null` is a valid
 * value for `preferredGroupName` on first load, which would cause a false
 * exhaustion match.
 * @type {string|undefined}
 */
let _providerPollExhaustedGroup = undefined;

/**
 * The group currently targeted by the poller.  When the user switches to a
 * different still-loading group, the guard in renderProxies() uses this to
 * restart polling for the new group instead of waiting for the old poll to
 * finish.
 * @type {string|undefined}
 */
let _providerPollTargetGroup = undefined;

/** Shared CSS for accent-style buttons (Restart Core, Retry, etc.). */
const ACCENT_BTN_CSS = 'background: color-mix(in srgb, var(--accent-primary) 15%, transparent); border: 1px solid color-mix(in srgb, var(--accent-primary) 25%, transparent); color: var(--accent-primary);';

/** Shared class for accent-style buttons. */
const ACCENT_BTN_CLASS = 'px-4 py-1.5 rounded-lg text-sm font-medium transition-all';

/**
 * Create an accent-styled button with consistent appearance.
 * @param {string} text - Button label text
 * @param {(btn: HTMLButtonElement) => void} onClick - Click handler
 * @param {string} [id] - Optional element ID
 * @param {string} [i18nKey] - Optional data-i18n key for live language switching
 * @returns {HTMLButtonElement}
 */
function createAccentButton(text, onClick, id, i18nKey) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = ACCENT_BTN_CLASS;
    btn.style.cssText = ACCENT_BTN_CSS;
    btn.textContent = text;
    if (i18nKey) btn.dataset.i18n = i18nKey;
    if (id) btn.id = id;
    btn.addEventListener('click', () => onClick(btn));
    return btn;
}

/**
 * Handle core restart from a button element.
 * Reads translations live from currentLang so labels stay correct even if
 * the user changed language between render time and button click.
 * @param {HTMLButtonElement} btn - The button that triggered the restart
 * @param {string} context - Logging context (e.g. 'loading state', 'error state')
 */
async function handleCoreRestart(btn, context) {
    const t = /** @type {any} */ (translations)[currentLang] || {};
    btn.disabled = true;
    btn.dataset.i18n = 'restartingCore';
    btn.textContent = t.restartingCore || 'Restarting...';
    try {
        const settings = await getSettingsCached();
        const configPath = settings?.last_config || 'config.yaml';
        const customArgs = settings?.custom_args || [];
        await restartCore(configPath, customArgs);
        await postRestartRecovery(configPath);
        // Re-read after awaits: user may have switched language during restart.
        const tSuccess = /** @type {any} */ (translations)[currentLang] || {};
        showNotification(tSuccess.coreRestarted || 'Core restarted', 'success');
    } catch (err) {
        proxyLogger.error(`Failed to restart core from ${context}`, err);
        showNotification(String(err), 'error');
        const t = /** @type {any} */ (translations)[currentLang] || {};
        btn.disabled = false;
        btn.dataset.i18n = 'restartCore';
        btn.textContent = t.restartCore || 'Restart Core';
    }
}

/**
 * Show loading state in the proxy container.
 * After 2.5s, a "Restart Core" button appears below the spinner.
 * @param {HTMLElement} container
 * @param {string} loadingText
 */
function renderProxiesLoading(container, loadingText) {
    clearLoadingTimeout();
    container.replaceChildren();
    const loading = document.createElement('div');
    loading.className = 'col-span-full text-center py-10 text-[var(--text-muted)] flex flex-col items-center gap-4';
    loading.id = 'proxies-loading-state';
    const span = document.createElement('span');
    span.dataset.i18n = 'loadingNodes';
    span.textContent = loadingText;
    const spinner = document.createElement('div');
    spinner.className = 'w-6 h-6 border-2 border-[var(--zephyr-border-default)] border-t-accent rounded-full animate-spin';
    loading.appendChild(span);
    loading.appendChild(spinner);
    container.appendChild(loading);

    _loadingTimeout = setTimeout(() => {
        const existing = document.getElementById('proxies-loading-state');
        if (!existing) return;
        // Don't add button if it already exists
        if (document.getElementById('restart-core-btn')) return;
        const tObj = /** @type {any} */ (translations)[currentLang] || {};
        const btn = createAccentButton(
            tObj.restartCore || 'Restart Core',
            (b) => handleCoreRestart(b, 'loading state'),
            'restart-core-btn',
            'restartCore'
        );
        btn.className = 'mt-1 btn-ghost';
        // Large subscriptions often need a few seconds: offer the restart only after a real wait.
        const slow = document.createElement('span');
        slow.className = 'text-xs text-[var(--text-tertiary)]';
        slow.textContent = tObj.loadingSlow || 'Taking longer than usual';
        existing.appendChild(slow);
        existing.appendChild(btn);
    }, 8000);
}

/**
 * Render the provider-poll-exhausted state with a retry button.
 * Shown when startProviderPoll() exhausts all retries without receiving nodes.
 * @param {HTMLElement} container
 * @param {any} tObj - i18n translations object
 */
function renderProviderPollExhausted(container, tObj) {
    clearLoadingTimeout();
    container.replaceChildren();
    const wrap = document.createElement('div');
    wrap.className = 'col-span-full text-center py-10 text-[var(--text-muted)] flex flex-col items-center gap-4';
    const msg = document.createElement('span');
    msg.dataset.i18n = 'providerPollExhausted';
    msg.textContent = tObj.providerPollExhausted || 'No nodes available from provider yet. The provider may still be downloading or failed to load.';
    wrap.appendChild(msg);
    const retryBtn = createAccentButton(
        tObj.retry || 'Retry',
        () => {
            _providerPollExhaustedGroup = undefined;
            void refreshProxies();
        },
        undefined,
        'retry'
    );
    wrap.appendChild(retryBtn);
    container.appendChild(wrap);
}

/** Clear the loading timeout timer if active. */
function clearLoadingTimeout() {
    if (_loadingTimeout) {
        clearTimeout(_loadingTimeout);
        _loadingTimeout = null;
    }
}

// ─── Provider-loading poller ───────────────────────────────────────────
// When a group uses `include-all: true`, its `all[]` array is empty until
// the proxy-provider finishes its HTTP download.  The poller re-fetches
// /proxies at a short interval and re-renders once nodes appear.

/**
 * Start polling for provider-loaded nodes.
 * @param {string|null} preferredGroupName - The group name to pass to the resolver.
 * @param {string|null|undefined} [exhaustionKey] - The resolved uiGroupName used as the exhaustion key.
 *   Falls back to preferredGroupName if not provided.
 * @param {number} [attempt] - Current attempt count (internal).
 */
function startProviderPoll(preferredGroupName, exhaustionKey, attempt = 0) {
    stopProviderPoll();
    _providerPollTargetGroup = exhaustionKey ?? preferredGroupName ?? undefined;
    if (attempt >= PROVIDER_POLL_MAX) {
        // Polling exhausted — mark this group and re-render to show a terminal state
        // with a retry button instead of leaving the user stuck on a loading spinner.
        _providerPollExhaustedGroup = exhaustionKey ?? preferredGroupName ?? undefined;
        void refreshProxies();
        return;
    }

    const gen = _providerPollGeneration;
    _providerPollTimer = setTimeout(async () => {
        _providerPollTimer = null;
        _providerPollInFlight = true;
        try {
            // Cancelled while waiting
            if (gen !== _providerPollGeneration) return;
            // Use non-cached fetch to avoid invalidating the global cache
            // (which would force other UI components to re-fetch too).
            // Merge with provider data so missing-detail checks include provider nodes.
            const rawProxies = /** @type {any} */ (await getProxies());
            if (gen !== _providerPollGeneration) return;  // Cancelled during await
            if (!rawProxies?.proxies) {
                // Malformed response — treat as retryable
                startProviderPoll(preferredGroupName, exhaustionKey, attempt + 1);
                return;
            }
            const data = await getProxiesMerged(rawProxies);
            if (gen !== _providerPollGeneration) return;  // Cancelled during await

            // Pass cached config to avoid an extra /configs HTTP request
            const cachedConfig = await getConfigCached();
            if (gen !== _providerPollGeneration) return;  // Cancelled during await
            const result = await fetchProxyGroupsShared({
                existingData: data,
                existingConfig: cachedConfig,
                preferredGroupName: preferredGroupName || undefined,
            });
            if (gen !== _providerPollGeneration) return;  // Cancelled during await
            // Check both providerLoading AND that all proxy names exist in
            // data.proxies — mihomo can update group.all[] before node details
            // appear in /proxies, causing buildProxyWrappers to skip nodes.
            const _hasMissingDetails = result && !result.providerLoading
                && hasMissingProxyDetails(result.proxies || [], data.proxies);
            // The same wait the page applies: a `use:` group still holding only
            // DIRECT/REJECT has not got its provider's nodes yet.
            const _stillWaiting = result && result.uiGroupUsesProviders
                && providerMembersPending(result.proxies || []);
            if (result && !result.providerLoading && !_hasMissingDetails && !_stillWaiting) {
                // Nodes have arrived — invalidate cache + re-render
                invalidateProxiesCache();
                void refreshProxies();
            } else {
                // Still loading — keep polling
                startProviderPoll(preferredGroupName, exhaustionKey, attempt + 1);
            }
        } catch (err) {
            if (gen !== _providerPollGeneration) return;  // Cancelled during await
            // Log the error for troubleshooting (e.g., network failures, resolver
            // errors) — but only for non-cancelled callbacks to avoid noise.
            proxyLogger.warn(`provider poll error (group=${exhaustionKey ?? preferredGroupName}, attempt=${attempt + 1})`, err);
            // Network error — keep polling
            startProviderPoll(preferredGroupName, exhaustionKey, attempt + 1);
        } finally {
            _providerPollInFlight = false;
        }
    }, 1500);
}

/** Stop the provider-loading poller if active. */
function stopProviderPoll() {
    _providerPollGeneration++;  // Cancel any in-flight callbacks
    if (_providerPollTimer) {
        clearTimeout(_providerPollTimer);
        _providerPollTimer = null;
    }
    // Clear in-flight flag so that a subsequent renderProxies() can start a
    // fresh poll.  Without this, if stopProviderPoll() is called while the
    // async fetch is awaiting, _providerPollInFlight stays true until the
    // stale callback's finally block runs — but by then no one triggers
    // another render, leaving the UI stuck on loading.
    _providerPollInFlight = false;
    // Clear exhaustion state so that re-entering the page (navigation, tab
    // visibility) attempts a fresh poll instead of immediately showing the
    // exhausted UI from a previous session.
    _providerPollExhaustedGroup = undefined;
    _providerPollTargetGroup = undefined;
}

// Export for lifecycle cleanup (called when leaving the proxies page)
// and for unit-testing the poller state machine.
export { stopProviderPoll, startProviderPoll };

/**
 * Update existing proxy wrappers in-place when the proxy list hasn't changed.
 * @param {HTMLElement} container
 * @param {string[]} proxies
 * @param {any} data
 * @param {string|null} current
 * @returns {Promise<boolean>} true if in-place update was performed
 */
async function updateProxiesInPlace(container, proxies, data, current) {
    const existingWrappers = Array.from(container.children);
    const existingNames = new Set(existingWrappers.map(w => (/** @type {HTMLElement} */ (w)).dataset.name));
    const newNames = new Set(proxies);
    const canUpdateInPlace = existingWrappers.length > 0 &&
        existingWrappers.length === proxies.length &&
        [...existingNames].every(name => newNames.has(/** @type {string} */ (name)));

    if (!canUpdateInPlace) return false;

    const wrapperMap = new Map();
    existingWrappers.forEach(w => { wrapperMap.set((/** @type {HTMLElement} */ (w)).dataset.name, w); });

    proxies.forEach((/** @type {string} */ name, /** @type {number} */ index) => {
        const wrapper = /** @type {HTMLElement} */ (wrapperMap.get(name));
        if (!wrapper) return;
        const proxy = (/** @type {any} */ (data)).proxies[name];
        const isSelected = name === current;

        (/** @type {HTMLElement} */ (wrapper)).dataset.index = String(index);
        (/** @type {HTMLElement} */ (wrapper)).dataset.baseOrder = `${index}`;
        (/** @type {HTMLElement} */ (wrapper)).style.order = String(index);
        (/** @type {HTMLElement} */ (wrapper)).dataset.selected = isSelected ? '1' : '0';
        (/** @type {HTMLElement} */ (wrapper)).setAttribute('aria-selected', isSelected ? 'true' : 'false');
        const lastDelay = (proxy.history && proxy.history.length > 0) ? proxy.history[proxy.history.length - 1].delay : null;
        if ((/** @type {HTMLElement} */ (wrapper)).dataset.pending !== '1') {
            const sortDelay = groupSortDelay(data, name, proxy, lastDelay);
            (/** @type {HTMLElement} */ (wrapper)).dataset.latency = String(isInvalidDelay(sortDelay) ? DELAY_INFINITE : sortDelay);
            (/** @type {HTMLElement} */ (wrapper)).dataset.estimate = (/** @type {HTMLElement} */ (wrapper)).dataset.latency;
        }

        const card = wrapper.firstElementChild;
        if (card) {
            (/** @type {HTMLElement} */ (card)).dataset.baseOrder = `${index}`;
            (/** @type {HTMLElement} */ (card)).dataset.selected = isSelected ? '1' : '0';

            let shownDelay = lastDelay;
            const groupNow = isProxyGroup(proxy) ? resolveGroupNow(data, name) : null;
            if (groupNow && shownDelay === null) shownDelay = groupNow.delay;
            // Refresh the label too: a same-name proxy may have changed type.
            const meta = /** @type {HTMLElement | null} */ (card.querySelector('.proxy-meta'));
            if (meta) {
                meta.textContent = proxyMetaLabel(proxy, groupNow);
                meta.title = proxy?.type || '';
                if (groupNow) meta.dataset.groupNow = '1';
                else delete meta.dataset.groupNow;
            }
            const delayColor = getDelayColorClass(shownDelay);
            const latVal = card.querySelector('[id^="latency-"]');
            if (latVal && wrapper.dataset.pending !== '1') {
                latVal.className = `text-xs tabular-nums font-semibold ${delayColor}`;
                latVal.textContent = !isInvalidDelay(shownDelay) ? `${shownDelay}ms` : (shownDelay === null ? '--' : (/** @type {any} */ (translations)[currentLang].timeout || 'Timeout'));
                setCardDelayTier(card, shownDelay);
            }

            if (isSelected) {
                ACTIVE_CARD_CLASSES.forEach(cls => card.classList.add(cls));
                card.classList.remove(INACTIVE_HOVER_CLASS);
                if (!card.querySelector('.active-dot')) {
                    card.appendChild(createActiveCheck());
                }
            } else {
                ACTIVE_CARD_CLASSES.forEach(cls => card.classList.remove(cls));
                card.classList.add(INACTIVE_HOVER_CLASS);
                const activeDot = card.querySelector('.active-dot');
                if (activeDot) activeDot.remove();
            }
        }
    });

    if (appStore.get('currentSortMode') === 'smart') {
        await applySmartSortToDom();
    } else {
        applyLatencySortToDom(true);
    }

    // Sync _activeCard with the actual current node
    const currentWrapper = container.querySelector('[data-selected="1"]');
    // Tab into the list lands on the selected node, not the first card.
    if (currentWrapper instanceof HTMLElement && currentWrapper.matches('[role="option"]')) {
        container.querySelectorAll('[role="option"]').forEach((el) => {
            if (el instanceof HTMLElement) setItemTabStop(el, el === currentWrapper);
        });
    }
    if (currentWrapper) {
        _activeCard = /** @type {HTMLElement|null} */ (currentWrapper.firstElementChild);
    } else {
        _activeCard = null;
    }

    return true;
}

/**
 * Build all proxy wrappers and cards for the full render path.
 * @param {HTMLElement} container
 * @param {string[]} proxies
 * @param {any} data
 * @param {string|null} current
 * @param {string} mainGroup
 * @returns {DocumentFragment}
 */
function buildProxyWrappers(container, proxies, data, current, mainGroup) {
    const fragment = document.createDocumentFragment();

    const createCard = (/** @type {HTMLElement} */ wrapper) => {
        const { proxies: virtProxies, data: virtData, current: virtCurrent, isTestingLatency: _isTestingLatency, mainGroup: _virtMainGroup } = /** @type {any} */ (_virtState.get(container));
        const index = parseInt((/** @type {HTMLElement} */ (wrapper)).dataset.index || '0', 10);
        const name = virtProxies[index];
        const proxy = (/** @type {any} */ (virtData)).proxies[name];
        // Defensive: if proxy data is missing, show placeholder
        if (!proxy) {
            const placeholder = document.createElement('div');
            placeholder.className = 'p-4 glass-card text-[var(--text-muted)] text-sm';
            placeholder.textContent = 'Loading...';
            return placeholder;
        }
        const isSelected = name === virtCurrent;

        let latFromWrapper = null;
        const _latency = (/** @type {HTMLElement} */ (wrapper)).dataset.latency;
        if (_latency) latFromWrapper = Number.parseInt(_latency, 10);

        const isPending = (/** @type {HTMLElement} */ (wrapper)).dataset.pending === '1';

        const card = document.createElement('div');
        card.dataset.baseOrder = `${index}`;
        card.dataset.selected = isSelected ? '1' : '0';
        // Use h-full to maintain 96px height, use absolute positioning for badge
        card.className = `proxy-card p-4 glass-card movie-card-base cursor-pointer flex flex-col gap-3 relative group h-full w-full
            ${isSelected ? 'proxy-card--selected' : INACTIVE_HOVER_CLASS}`;

        let lastDelay = (proxy.history && proxy.history.length > 0) ? proxy.history[proxy.history.length - 1].delay : null;

        const isGroup = isProxyGroup(proxy);
        // Group cards show where the group routes to right now; use that node's current delay when the
        // group has none of its own (before the wrapper's value, which can be from an earlier render).
        const groupNow = isGroup ? resolveGroupNow(virtData, name) : null;
        if (isGroup && lastDelay === null && groupNow && groupNow.delay !== null) {
            lastDelay = groupNow.delay;
        }
        // Only use latFromWrapper if proxy has no history AND latFromWrapper is valid (not DELAY_INFINITE)
        if (lastDelay === null && latFromWrapper !== null && latFromWrapper !== DELAY_INFINITE) {
            lastDelay = latFromWrapper;
        }

        const delayColor = getDelayColorClass(lastDelay);

        (/** @type {HTMLElement} */ (card)).dataset.latency = String(isInvalidDelay(lastDelay) ? DELAY_INFINITE : lastDelay);
        (/** @type {HTMLElement} */ (card)).dataset.estimate = (/** @type {HTMLElement} */ (card)).dataset.latency;

        // --- Top row: the node name owns the whole row ---
        const top = document.createElement('div');
        top.className = 'node-top flex items-center pointer-events-none w-full min-w-0';

        const nameContainer = document.createElement('div');
        nameContainer.className = 'node-name flex-1 min-w-0 text-sm font-semibold text-[var(--text-primary)] tracking-tight';
        const nameSpan = document.createElement('span');
        nameSpan.className = 'node-name-text';
        nameSpan.textContent = name;
        nameContainer.title = name;
        nameContainer.appendChild(nameSpan);
        top.appendChild(nameContainer);
        // Smart score at the end of the name row (the selected check keeps its own corner);
        // stays hidden until there is a real score.
        const scoreBadge = document.createElement('span');
        scoreBadge.className = 'score-badge tabular-nums';
        scoreBadge.setAttribute('data-score-badge', 'true');
        scoreBadge.title = t('sortSmartDesc');
        top.appendChild(scoreBadge);

        // --- Bottom row: status dot + protocol (or group target) + latency ---
        const bottom = document.createElement('div');
        bottom.className = 'flex items-end justify-between gap-2 mt-auto pointer-events-none min-w-0';
        const left = document.createElement('div');
        left.className = 'flex items-center gap-2 min-w-0';
        const dot = document.createElement('span');
        dot.className = 'delay-dot';
        dot.setAttribute('aria-hidden', 'true');
        dot.dataset.tier = isPending ? 'none' : getDelayTier(lastDelay);
        const metaText = document.createElement('span');
        metaText.className = 'proxy-meta text-2xs text-[var(--text-muted)] font-medium truncate';
        // Group: "→ node". Otherwise protocol + transport, e.g. "SS · TCP", "Hy2 · QUIC";
        // types without a known transport (DIRECT/REJECT, future types) show the protocol only.
        metaText.textContent = proxyMetaLabel(proxy, groupNow);
        if (isGroup) metaText.dataset.groupNow = '1';
        metaText.title = proxy.type || '';
        left.appendChild(dot);
        left.appendChild(metaText);

        const right = document.createElement('div');
        right.className = 'flex items-end shrink-0';

        const latVal = document.createElement('span');
        latVal.id = `latency-${CSS.escape(name)}`;
        if (isPending) {
            latVal.className = 'text-xs tabular-nums font-semibold text-accent';
            // eslint-disable-next-line no-unsanitized/property -- static SVG constant
            latVal.innerHTML = latencyLoadingIcon; // nosemgrep: js-innerhtml-assignment — verified safe, see eslint-disable above
            (/** @type {HTMLElement} */ (card)).dataset.latency = String(DELAY_INFINITE);
        } else {
            latVal.className = `text-xs tabular-nums font-semibold ${delayColor}`;
            latVal.textContent = !isInvalidDelay(lastDelay) ? `${lastDelay}ms` : (lastDelay === null ? '--' : (/** @type {any} */ (translations)[currentLang].timeout || 'Timeout'));
        }
        // Re-test just this node (hover/focus reveals it); never switches the node.
        const retest = document.createElement('button');
        retest.type = 'button';
        retest.className = 'node-retest-btn';
        retest.tabIndex = -1;
        retest.title = t('retestNode');
        retest.setAttribute('aria-label', `${t('retestNode')}: ${name}`);
        // eslint-disable-next-line no-unsanitized/property -- static SVG constant
        retest.innerHTML = RETEST_ICON; // nosemgrep: js-innerhtml-assignment — static markup
        retest.addEventListener('click', (e) => {
            e.stopPropagation();
            void retestSingleNode(name, latVal, retest);
        });
        right.appendChild(retest);
        right.appendChild(latVal);

        bottom.appendChild(left);
        bottom.appendChild(right);

        card.addEventListener('pointerenter', () => startNameMarquee(card));
        card.addEventListener('pointerleave', () => stopNameMarquee(card));

        if (isSelected) {
            card.appendChild(createActiveCheck());
        }

        card.appendChild(top);


        card.appendChild(bottom);

        // --- Click handler: switch proxy ---
        card.onclick = async () => {
            // Switching a node and a running latency test are independent: the test keeps going.

            card.classList.add('opacity-50', 'pointer-events-none');
            const originalLatContent = latVal ? latVal.innerHTML : '';
            if (latVal) {
                // eslint-disable-next-line no-unsanitized/property -- static SVG constant
                latVal.innerHTML = SVG_ICONS.loadingSmall; // nosemgrep: js-innerhtml-assignment — verified safe, see eslint-disable above
            }
            // A latency result can land while the switch is in flight; it replaces the
            // spinner, and must not then be overwritten by the old content.
            const switchSpinner = latVal?.firstChild ?? null;
            const restoreLatency = () => {
                if (!latVal || latVal.firstChild !== switchSpinner) return;
                // eslint-disable-next-line no-unsanitized/property -- restoring saved innerHTML (same DOM element)
                latVal.innerHTML = originalLatContent; // nosemgrep: js-innerhtml-assignment — verified safe, see eslint-disable above
            };

            try {
                const success = await switchProxy(mainGroup, name);
                invalidateProxiesCache();

                card.classList.remove('opacity-50', 'pointer-events-none');
                restoreLatency();

                if (success) {
                    setActiveNode(card, container);

                    // Save proxy selection for current profile (use cached settings)
                    try {
                        const settings = await getSettingsCached();
                        const currentProfile = settings.last_config || 'config.yaml';
                        await saveProxySelection(currentProfile, { node: name, group: mainGroup });
                    } catch (_e) { /* ignore */ }

                    if (appStore.get('currentSortMode') === 'smart') {
                        await applySmartSortToDom();
                    } else if (typeof applyLatencySortToDom === 'function') {
                        applyLatencySortToDom();
                    }

                    // Open connections are closed so the new node applies at once; only
                    // say so once that actually happened.
                    const closed = await closeConnsAfterSwitch();
                    notifySwitched(name, closed);
                    void syncCoreConfig().catch((err) => proxyLogger.warn('Failed to sync core after proxy switch', err));
                } else {
                    const t = /** @type {any} */ (translations)[appStore.get('currentLang')] || {};
                    showNotification(t.proxySwitchFailed || 'Failed to switch proxy', 'error');
                }
            } catch (err) {
                card.classList.remove('opacity-50', 'pointer-events-none');
                restoreLatency();
                showNotification(String(err), 'error');
            }
        };

        return card;
    };

    // Build all wrappers and cards
    const testingLatency = appStore.get('isTestingLatency');
    proxies.forEach((/** @type {string} */ name, /** @type {number} */ index) => {
        const wrapper = document.createElement('div');
        (/** @type {HTMLElement} */ (wrapper)).style.order = String(index);
        (/** @type {HTMLElement} */ (wrapper)).dataset.baseOrder = `${index}`;
        (/** @type {HTMLElement} */ (wrapper)).dataset.index = String(index);
        wrapper.dataset.name = name;
        if (testingLatency) wrapper.dataset.pending = '1';

        const proxy = (/** @type {any} */ (data)).proxies[name];
        // Defensive: skip if proxy data is missing
        if (!proxy) return;
        const isSelected = name === current;
        wrapper.dataset.selected = isSelected ? '1' : '0';
        wrapper.setAttribute('role', 'option');
        wrapper.setAttribute('aria-selected', isSelected ? 'true' : 'false');
        const lastDelay = (proxy?.history && proxy.history.length > 0) ? proxy.history[proxy.history.length - 1].delay : null;
        const sortDelay = groupSortDelay(data, name, proxy, lastDelay);
        (/** @type {HTMLElement} */ (wrapper)).dataset.latency = String(isInvalidDelay(sortDelay) ? DELAY_INFINITE : sortDelay);
        (/** @type {HTMLElement} */ (wrapper)).dataset.estimate = (/** @type {HTMLElement} */ (wrapper)).dataset.latency;

        wrapper.style.height = 'auto';
        wrapper.className = 'proxy-wrapper';
        wrapper.style.minHeight = '104px'; // 96px card + 8px room for the selected check

        const card = createCard(wrapper);
        setProxyPendingState(card, appStore.get('isTestingLatency'));
        wrapper.appendChild(card);
        wrapper.addEventListener('focus', () => startNameMarquee(card));
        wrapper.addEventListener('blur', () => stopNameMarquee(card));
        setup3DEffect(card);

        fragment.appendChild(wrapper);
    });

    return fragment;
}

/**
 * Fire-and-forget variant of renderProxies(): never rejects, logs failures.
 * Use it wherever the caller does not await the render.
 * @returns {Promise<void>}
 */
export function refreshProxies() {
    return renderProxies().catch((err) => {
        proxyLogger.warn('renderProxies failed', err);
    });
}

/**
 * Render the proxy node list. Supports in-place updates when the list
 * hasn't changed (for smooth latency re-testing) and full re-renders.
 */
export async function renderProxies() {
    const container = document.getElementById('proxies-list');
    if (!container) return;

    // Render generation token — must be incremented before any async work
    // so that early-return paths (no data, direct mode, no groups) also
    // invalidate stale renders from older invocations.
    const _renderGen = ++_renderGeneration;

    // Start observed-group watcher only when proxies page is visible and app is foregrounded
    if (!document.hidden) {
        const proxiesPage = document.querySelector('[data-page="proxies"]');
        if (proxiesPage && !proxiesPage.classList.contains('hidden')) {
            startObservedGroupWatcher();
        }
    }

    let t = /** @type {any} */ (translations)[currentLang];

    // Show loading state if empty
    if (container.children.length === 0) {
        renderProxiesLoading(container, t.loadingNodes);
    }

    // Fetch proxies (merged with provider data) and config in parallel
    // A failing core API must reach the error state below, not leave "Loading nodes…" up forever.
    /** @type {any} */
    let data = null;
    /** @type {any} */
    let config = null;
    try {
        [data, config] = await Promise.all([
            getProxiesCached().then(getProxiesMerged),
            getConfigCached(),
        ]);
    } catch (err) {
        proxyLogger.warn('Failed to load proxies', err);
    }

    // Guard: if a newer render started while fetching, abort — the newer render takes precedence.
    if (_renderGen !== _renderGeneration) return;

    // Clear loading timeout — data fetch completed (success or failure)
    clearLoadingTimeout();

    // Re-read after await: user may have switched language during fetch.
    t = /** @type {any} */ (translations)[currentLang] || {};

    if (!data || !data.proxies) {
        setProxyToolsHidden(true);
        suppressGroupExplanationBar();
        setProxyHeaderMeta(null);
        container.replaceChildren();
        container.appendChild(buildProxiesEmptyState({
            icon: ALERT_ICON,
            tone: 'danger',
            title: t.failedToConnect,
            actionLabel: t.restartCore || 'Restart Core',
            onAction: (b) => handleCoreRestart(b, 'error state'),
        }));
        return;
    }

    const isDirect = config?.mode?.toLowerCase() === 'direct';
    setProxyToolsHidden(isDirect);
    if (isDirect) {
        suppressGroupExplanationBar();
        setProxyHeaderMeta(null);
        container.replaceChildren();
        container.appendChild(buildProxiesEmptyState({
            icon: DIRECT_ICON,
            title: t.directModeTitle || t.directModePrompt,
            detail: t.directModeDetail || t.directModePrompt,
            card: true,
            actionLabel: t.switchToRuleMode || 'Rule',
            onAction: () => /** @type {HTMLElement|null} */ (document.querySelector('[data-mode="rule"]'))?.click(),
        }));
        return;
    }

    // Use the user's explicit group selection or fall back to the resolver
    const preferredGroupName = appStore.get('uiGroupName') || null;

    const proxyGroupsResult = await fetchProxyGroupsShared({
        existingData: data,
        existingConfig: config,
        preferredGroupName,
    });
    // Guard: if a newer render started while fetching, abort.
    if (_renderGen !== _renderGeneration) return;
    // Re-read after await: user may have switched language during fetch.
    t = /** @type {any} */ (translations)[currentLang] || {};
    if (!proxyGroupsResult) {
        setProxyToolsHidden(true);
        suppressGroupExplanationBar();
        setProxyHeaderMeta(null);
        container.replaceChildren();
        container.appendChild(buildNoNodesState(t.noGroupsFound || 'No switchable proxy groups found'));
        return;
    }

    // Sync resolver state to appStore
    appStore.set('uiPrimaryGroupName', proxyGroupsResult.uiPrimaryGroupName || null);
    appStore.set('effectiveGroupName', proxyGroupsResult.effectiveGroupName || null);
    appStore.set('uiGroupName', proxyGroupsResult.uiGroupName || null);

    const { mainGroup, current } = proxyGroupsResult;
    // Use the resolved uiGroupName for node list rendering
    const uiGroupName = proxyGroupsResult.uiGroupName || mainGroup;
    const effectiveGroupName = proxyGroupsResult.effectiveGroupName;

    // Render group selector dropdown
    renderGroupSelector(proxyGroupsResult.groups || [], uiGroupName || '', /** @type {Record<string, any>} */ (data?.proxies || {}));

    // If no writable group was found, show a clean empty state instead of
    // rendering actionable buttons that would fail on PUT /proxies/{group}
    if (!proxyGroupsResult.uiGroupName) {
        setProxyToolsHidden(true);
        suppressGroupExplanationBar();
        setProxyHeaderMeta(null);
        container.replaceChildren();
        container.appendChild(buildNoNodesState(t.noGroupsFound || 'No switchable proxy groups found'));
        return;
    }

    let proxies = [...proxyGroupsResult.proxies]; // Mutable copy

    const onlySpecialMembers = hasOnlySpecialMembers(proxies, data?.proxies);
    // A group fed by a proxy provider (`use:` or include-all) that has not downloaded yet
    // looks empty too: wait for the provider instead of offering to add a subscription.
    if (proxyGroupsResult.uiGroupUsesProviders && providerMembersPending(proxies)) {
        proxyGroupsResult.providerLoading = true;
    }

    // Only DIRECT / REJECT in the group and no real node anywhere: no subscription (or one
    // without nodes) yet. A DIRECT/REJECT selector (an ad-block group) in a config that has
    // nodes still renders, so either member can be picked.
    // (An include-all group waiting for its provider looks the same: the poller below handles it.)
    if (!proxyGroupsResult.providerLoading && onlySpecialMembers) {
        setProxyToolsHidden(true);
        setProxyHeaderMeta(null);
        suppressGroupExplanationBar();
        container.replaceChildren();
        container.appendChild(buildNoNodesState(t.noNodesYet || 'No nodes yet'));
        return;
    }

    // Provider nodes are now merged by getProxiesMerged() at the top of this
    // function (combines /proxies + /providers/proxies). If nodes are still
    // missing (provider not yet downloaded or /providers/proxies failed),
    // force providerLoading so the poller starts.
    if (data?.proxies && hasMissingProxyDetails(proxies, data.proxies)) {
        proxyGroupsResult.providerLoading = true;
    }

// --- Provider-loading guard ---
// If the uiGroup uses include-all/include-all-providers and its all[] has
// no real proxy nodes (empty or only special entries like COMPATIBLE),
// the proxy-provider hasn't finished downloading nodes yet.  Clear any
// stale cards from a previous group, then start a silent poller to
// re-render once nodes arrive.
    if (proxyGroupsResult.providerLoading) {
        // The bar explains the previous group; this one has no nodes to explain yet.
        suppressGroupExplanationBar();
        // If polling was already exhausted for this group, show a terminal state
        // with a retry button instead of restarting the poll loop.
        // Use the resolved uiGroupName (not preferredGroupName) as the key —
        // preferredGroupName can be null on first load, which would collide
        // with the undefined sentinel and cause a false exhaustion match.
        if (_providerPollExhaustedGroup !== undefined && _providerPollExhaustedGroup === uiGroupName) {
            renderProviderPollExhausted(container, t);
            return;
        }
        renderProxiesLoading(container, t.loadingNodes);
        // Gate poll startup on the Proxies page being active and the document
        // being visible — a stale renderProxies() callback may resume after the
        // user navigated away or the tab was hidden, which would restart polling
        // that was explicitly stopped via stopProviderPoll().
        if (!document.hidden) {
            const proxiesPage = document.querySelector('[data-page="proxies"]');
            // Don't restart a poll that's already in-flight — external events
            // (CONFIG_UPDATED, CORE_RESTARTED, tray/mode/plugin changes) can
            // trigger renderProxies() repeatedly, and each call to
            // startProviderPoll() resets the attempt counter to 0 via
            // stopProviderPoll(), causing an infinite loading loop that never
            // reaches PROVIDER_POLL_MAX.
            //
            // Exception: if the user switched to a *different* still-loading
            // group while a poll is in-flight for the old group, restart so
            // the new group gets its own poll instead of waiting up to ~30s.
            if (proxiesPage && !proxiesPage.classList.contains('hidden')
                && (!_providerPollTimer && !_providerPollInFlight
                    || _providerPollTargetGroup !== uiGroupName)) {
                startProviderPoll(preferredGroupName, uiGroupName);
            }
        }
        return;
    }
    // Provider loaded successfully — clear exhausted state and stop any lingering poller
    _providerPollExhaustedGroup = undefined;
    stopProviderPoll();

    // Render the group explanation bar (observed/effective vs ui group mismatch indicator)
    const observedGroupName = appStore.get('observedGroupName');
    const observedNodeName = appStore.get('observedNodeName');
    _barSuppressed = false;
    renderGroupExplanationBar(uiGroupName || '', effectiveGroupName, observedGroupName, observedNodeName, /** @type {Record<string, any>} */ (data?.proxies));

    // Filter out unavailable (timeout) proxies if setting is enabled
    const settings = await getSettingsCached();
    // Guard: if a newer render started while fetching, abort.
    if (_renderGen !== _renderGeneration) return;
    // Re-read after await: user may have switched language during settings fetch.
    t = /** @type {any} */ (translations)[currentLang] || {};
    // Group switched: the search and a temporary "show hidden" apply to one group only.
    if (_searchGroup !== uiGroupName) {
        _searchGroup = uiGroupName;
        _showHiddenTimeouts = false;
        const searchEl = /** @type {HTMLInputElement|null} */ (document.getElementById('proxy-search'));
        if (searchEl) searchEl.value = '';
    }
    const groupTotal = proxies.length;
    let hiddenTimeoutCount = 0;
    if (settings?.hide_timeout_nodes && !_showHiddenTimeouts) {
        const preFilterCount = proxies.length;
        proxies = proxies.filter((/** @type {string} */ name) => {
            // Always keep the currently active node, even if it's timed out
            if (name === current) return true;
            const proxy = (/** @type {any} */ (data)).proxies[name];
            const own = proxy?.history?.length ? proxy.history[proxy.history.length - 1].delay : null;
            // Keep proxy if not tested yet. A nested group without its own result stays
            // selectable even when its current route timed out: it reaches its other routes.
            if (own == null) return true;
            return !isInvalidDelay(own);
        });
        // Safety valve: if hide_timeout_nodes filtered out EVERY node, keep the
        // original unfiltered list so the user can still see and interact with
        // nodes (rather than facing a confusing blank page).
        if (proxies.length === 0 && preFilterCount > 0) {
            proxies = [...proxyGroupsResult.proxies];
        }
        hiddenTimeoutCount = preFilterCount - proxies.length;
    }

    const query = (/** @type {HTMLInputElement|null} */ (document.getElementById('proxy-search'))?.value || '').trim().toLowerCase();
    const beforeSearch = proxies.length;
    if (query) proxies = proxies.filter((/** @type {string} */ name) => name.toLowerCase().includes(query));
    setProxyHeaderMeta({
        total: groupTotal,
        matched: query ? proxies.length : null,
        searchedFrom: beforeSearch,
        hidden: hiddenTimeoutCount,
        hideEnabled: !!settings?.hide_timeout_nodes,
    });
    if (query && proxies.length === 0) {
        container.replaceChildren();
        container.appendChild(buildProxiesEmptyState({ icon: SEARCH_ICON, title: t.noSearchMatches || 'No matching nodes' }));
        return;
    }

    if (appStore.get('currentSortMode') === 'name') {
        proxies.sort((/** @type {string} */ a, /** @type {string} */ b) => a.localeCompare(b));
    } else if (appStore.get('currentSortMode') === 'latency') {
        sortProxiesByLatency(proxies, data);
    }

    // Sync sort label with current mode (may be reset by applyTranslations)
    const sortLabelEl = document.getElementById('sort-label');
    if (sortLabelEl) {
        const sortLabels = { default: t.sortDefault, name: t.sortName, latency: t.sortLatency, smart: t.sortSmart };
        sortLabelEl.textContent = (/** @type {any} */ (sortLabels))[appStore.get('currentSortMode')] || sortLabels['default'];
    }

    // Store virtual data for lazy card creation
    _virtState.set(container, { proxies, data, current, isTestingLatency: appStore.get('isTestingLatency'), mainGroup: uiGroupName });

    // --- In-place update path ---
    if (await updateProxiesInPlace(container, proxies, data, current)) {
        // Guard: if a newer render started while updating, abort.
        if (_renderGen !== _renderGeneration) return;
        // The in-place path rewrites cards from the core's history; mid-test, keep
        // what this run already measured.
        if (appStore.get('isTestingLatency')) {
            for (const [name, delay] of _testRunResults) applyNodeLatency(name, delay);
            // The order was computed from older history: sort by these figures again.
            applyLatencySortToDom(false);
        }
        // Still backfill scores even on in-place updates (badges may not exist yet on first render)
        void backfillSmartScores(container);
        return;
    }

    // --- Full render path ---
    const fragment = buildProxyWrappers(container, proxies, data, current, uiGroupName || '');

    container.replaceChildren();
    container.appendChild(fragment);
    // Re-rendered mid-test: nodes already measured in this run show their result, not a spinner.
    if (appStore.get('isTestingLatency')) {
        for (const [name, delay] of _testRunResults) applyNodeLatency(name, delay);
        applyLatencySortToDom(false);
    }

    // Sync _activeCard with the actual current node
    const currentWrapper = container.querySelector('[data-selected="1"]');
    _activeCard = currentWrapper ? /** @type {HTMLElement|null} */ (currentWrapper.firstElementChild) : null;

    // Backfill existing smart scores from backend (avoids showing '--' when scores exist)
    await backfillSmartScores(container);
    // Guard: if a newer render started while backfilling, abort.
    if (_renderGen !== _renderGeneration) return;

    // Apply smart sort on initial render if mode is 'smart' (e.g. restored from localStorage)
    if (appStore.get('currentSortMode') === 'smart') {
        await applySmartSortToDom();
    }
}

// --- Smart UI visibility sync ---

/** Sync the --smart-enabled CSS var with backend config. */
async function syncSmartUiVisibility() {
    let enabled;
    try {
        const config = await smartConfig();
        // Backend only returns `enabled` if smart.toml has the key.
        // Fallback to localStorage for migration scenarios.
        enabled = (/** @type {any} */ (config)).enabled ?? localStorage.getItem('smartEnabled') === 'true';
    } catch {
        // Fallback to localStorage on error
        enabled = localStorage.getItem('smartEnabled') === 'true';
    }

    document.documentElement.style.setProperty('--smart-enabled', enabled ? '1' : '0');

    // Reset sort mode to default if smart is disabled but current mode is smart
    if (!enabled && appStore.get('currentSortMode') === 'smart') {
        appStore.set('currentSortMode', 'default');
        const sortLabel = document.getElementById('sort-label');
        if (sortLabel) {
            const t = /** @type {any} */ (translations)[currentLang];
            sortLabel.textContent = t.sortDefault;
        }
    }
}

// --- Event Bus: react to config updates from other modules (e.g. settings.js) ---

Bus.on(Events.CONFIG_UPDATED, async () => {
    invalidateRunConfigCache();
    await syncSmartUiVisibility();
    void refreshProxies();
});

Bus.on(Events.CORE_RESTARTED, () => {
    invalidateRunConfigCache();
    invalidateProxiesCache();
    // Do NOT reset uiGroupName here — restoreProxySelection depends on it
    // to restore the correct group after core restart. The resolver will
    // re-validate uiGroupName against the new proxyMap on next render.
    void refreshProxies();
});

// --- Observed Group Watcher: start/stop with page visibility ---

document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        stopObservedGroupWatcher();
        stopProviderPoll();
    } else {
        // Only start if proxies page is visible
        const proxiesPage = document.querySelector('[data-page="proxies"]');
        if (proxiesPage && !proxiesPage.classList.contains('hidden')) {
            startObservedGroupWatcher();
            // Re-render to restart provider polling if the group is still
            // loading — stopProviderPoll() cleared the timer and exhaustion
            // state on hide, so renderProxies() will start a fresh poll.
            void refreshProxies();
        }
    }
});

// Also reset on config/core changes
Bus.on(Events.CONFIG_UPDATED, () => { resetObservedGroup(); });
Bus.on(Events.CORE_RESTARTED, () => { resetObservedGroup(); });

// Re-render explanation bar when observedGroupName or observedNodeName changes (avoid full renderProxies)
// Debounced to batch sequential updates and prevent redundant DOM operations
const _renderExplanationBarFromStore = debounce(async () => {
    const proxiesPage = document.querySelector('[data-page="proxies"]');
    if (proxiesPage && !proxiesPage.classList.contains('hidden')) {
        try {
            const data = await getProxiesCached().then(getProxiesMerged);
            const uiGroupName = appStore.get('uiGroupName');
            const effectiveGroupName = appStore.get('effectiveGroupName');
            const observedGroupName = appStore.get('observedGroupName');
            const observedNodeName = appStore.get('observedNodeName');
            renderGroupExplanationBar(uiGroupName, effectiveGroupName, observedGroupName, observedNodeName, data?.proxies);
        } catch { /* ignore */ }
    }
    // Removed syncCoreConfig() from here - it's already called on proxy switch events and config updates
    // Calling it here would trigger unnecessary API requests every 2s when observed node changes
}, 50);
appStore.subscribe('observedGroupName', _renderExplanationBarFromStore);
appStore.subscribe('observedNodeName', _renderExplanationBarFromStore);

// Helper to format the display name with an optional suffix
/** @param {string} group @param {string|null} leaf */
function formatNodeDisplayName(group, leaf) {
    return (leaf && leaf !== group) ? `${group} - ${leaf}` : (leaf || group);
}

// Check if observed node is in the current group (supports nested groups)
/** @param {string} node @param {string} group @param {Record<string, any>} proxyMap @param {Set<string>} [visited] */
const isNodeInGroup = (node, group, proxyMap, visited = new Set()) => {
    if (!group || !proxyMap || visited.has(group)) return false;
    visited.add(group);
    const entry = proxyMap[group];
    if (!entry || !entry.all) return false;
    if (entry.all.includes(node)) return true;
    return entry.all.some(/** @param {string} member */ member => isNodeInGroup(node, member, proxyMap, visited));
};

// Update capsule display when observed node or group changes (avoid full syncCoreConfig API calls)
const updateCapsuleDisplay = () => {
    const currentNodeEl = document.getElementById('current-node-name');
    if (!currentNodeEl) return;

    const currentGroupName = currentNodeEl.dataset.group;
    if (!currentGroupName) return;

    getProxiesCached().then(getProxiesMerged).then(data => {
        // Verify the group hasn't changed during the async API call to prevent race conditions
        if (currentNodeEl.dataset.group !== currentGroupName) return;

        const proxyMap = data?.proxies;
        // Read latest values inside the callback to prevent stale closures
        const observedNodeName = appStore.get('observedNodeName');
        const observedGroupName = appStore.get('observedGroupName');

        // If no observed node or group, revert to default leaf node display
        if (!observedNodeName || !observedGroupName) {
            const leafNode = resolveLeafNode(currentGroupName, proxyMap);
            currentNodeEl.textContent = formatNodeDisplayName(currentGroupName, leafNode);
            return;
        }

        // Check if observed node is related to current group
        // Only use exact group match or membership check
        const isRelated = currentGroupName === observedGroupName ||
            (proxyMap && isNodeInGroup(observedNodeName, currentGroupName, proxyMap));

        if (isRelated) {
            // Dynamically append observed node name when it differs from group name
            currentNodeEl.textContent = formatNodeDisplayName(currentGroupName, observedNodeName);
        } else {
            // Revert to default leaf node display if not related
            const leafNode = resolveLeafNode(currentGroupName, proxyMap);
            currentNodeEl.textContent = formatNodeDisplayName(currentGroupName, leafNode);
        }
    }).catch(() => {});
};

appStore.subscribe('observedNodeName', updateCapsuleDisplay);
appStore.subscribe('observedGroupName', updateCapsuleDisplay);

// ═══════════════════════════════════════════════════════════════════════
//  Smart Auto-Test Scheduler
// ═══════════════════════════════════════════════════════════════════════

const _autoTest = {
    /** @type {number|null} */
    _timer: null,
    _running: false,

    /** Check whether auto-test is enabled (setting + smart enabled). */
    _isEnabled() {
        const autoTest = localStorage.getItem('smartAutoTest');
        const cssEnabled = document.documentElement.style.getPropertyValue('--smart-enabled');
        const enabled = autoTest === 'true' && cssEnabled === '1';
        return enabled;
    },

    /** Run a single auto-test cycle for all nodes in the current proxy group. */
    async _runOnce() {
        if (!this._isEnabled() || this._running || appStore.get('isTestingLatency')) return;
        resetLatencyTestController();  // Reset controller before starting
        this._running = true;
        try {
            // Pass the user's currently-viewed group (same fix as test button handler)
            const proxyGroupsResult = await fetchProxyGroupsShared({
                preferredGroupName: appStore.get('uiGroupName') || undefined,
            });
            if (!proxyGroupsResult) return;
            const { data, proxies } = proxyGroupsResult;

            const validProxies = proxies.filter((/** @type {string} */ name) => {
                const node = (/** @type {any} */ (data)).proxies[name];
                const type = node?.type?.toLowerCase() || '';
                return type !== 'reject' && type !== 'compatible' && type !== 'pass';
            });
            if (validProxies.length === 0) return;

            // Test all nodes concurrently (respecting mihomo's internal concurrency)
            const concurrency = Math.min(12, validProxies.length);
            let idx = 0;
            const workers = Array.from({ length: concurrency }, async () => {
                while (idx < validProxies.length) {
                    if (getLatencyTestSignal().aborted) break;
                    const name = validProxies[idx++];
                    try {
                        // testProxy already handles abort internally and returns -1 on cancellation
                        const delay = await testProxy(name);
                        const success = delay > 0 && delay < 999999;
                        if (document.documentElement.style.getPropertyValue('--smart-enabled') === '1') {
                            _smartBatcher.push(name, success ? delay : 999999, success);
                        }
                        // Report to failover engine if enabled
                        if (appStore.get('failoverEnabled') && !getLatencyTestSignal().aborted) {
                            void reportFailover(name, success);
                        }
                    } catch { /* skip individual failures */ }
                }
            });
            await Promise.all(workers);

            // Wait for all pending smart score IPC updates before ranking
            if (document.documentElement.style.getPropertyValue('--smart-enabled') === '1') {
                await _smartBatcher.wait();
            }

            // Schedule next cycle using adaptive interval
            const config = /** @type {any} */ (await smartConfig().catch(() => null));
            const minInterval = config?.min_interval_secs ?? 60;
            const maxInterval = config?.max_interval_secs ?? 600;
            // Use average score of all tested nodes as network quality
            const rankings = await smartRank().catch(() => []);
            const avgScore = rankings.length > 0
                ? rankings.reduce((sum, r) => sum + (r.score || 0), 0) / rankings.length
                : 50;
            const nextSecs = await smartNextInterval(avgScore / 100, minInterval, maxInterval).catch(() => maxInterval);
            this._scheduleNext(nextSecs * 1000);
        } catch {
            // On error, retry after a longer delay
            this._scheduleNext(300_000);
        } finally {
            this._running = false;
        }
    },

    /** Schedule the next auto-test.
     * @param {number} ms */
    _scheduleNext(ms) {
        this._stop();
        if (!this._isEnabled()) {
            return;
        }
        this._timer = setTimeout(() => this._runOnce(), ms);
    },

    /** Stop any pending auto-test. */
    _stop() {
        if (this._timer !== null) {
            clearTimeout(this._timer);
            this._timer = null;
        }
    },

    /** Start the auto-test scheduler (called on app init or setting change). */
    start() {
        this._stop();
        if (!this._isEnabled()) {
            return;
        }
        // Delay first auto-test by 30s to let the app settle
        this._scheduleNext(30_000);
    },

    /** Stop and disable the auto-test scheduler. */
    stop() {
        this._stop();
        this._running = false;
    },
};

/** Start the smart auto-test scheduler. */
export function startSmartAutoTest() {
    _autoTest.start();
}

/** Stop the smart auto-test scheduler. */
export function stopSmartAutoTest() {
    _autoTest.stop();
}
