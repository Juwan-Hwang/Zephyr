// @ts-check
/**
 * Proxy list rendering, latency testing, sorting, and proxy card management.
 * Extracted from ui.js - the largest extracted module.
 *
 * @module ui/proxies
 */

import { decideGroupMismatch } from './group-mismatch.js';
import { switchProxyResult, SWITCH_BUSY, testProxy, abortLatencyTests, closeAllConnections, getConfig, invoke, getLatencyTestSignal, resetLatencyTestController, restartCore, getProxies, getProxiesMerged, SPECIAL_PROXY_NAMES, proxySwitchMark, proxySwitchedSince, isLatestSwitch, coreReplacements, clearProviderCache, providerGeneration } from '../api.js';
import { noNetworkChangeSince, networkChangesBegun } from './network-change.js';
import { proxyLogger } from '../utils/logger.js';
import { getDelayColorClass } from '../utils/format.js';
import { buildLatencyPriorityQueue } from '../utils/array.js';
import { debounce } from '../utils/debounce.js';
import { translations, currentLang, t, t as tFmt, getDirection } from '../i18n.js';
import { showNotification, showConfirmModal } from './notifications.js';
import { SVG_ICONS } from './icons.js';
import { setup3DEffect } from './3d-effect.js';
import { createRovingTabindex, setItemTabStop } from '../utils/roving-tabindex.js';
import { COMMANDS } from '@zephyr/shared';
import { getConfigCached, getProxiesCached, getSettingsCached, invalidateProxiesCache } from './cache.js';
import { appStore } from './state.js';
import { smartScore, smartNextInterval, smartRank, smartConfig, failoverReport } from './prism.js';
import { fetchProxyGroups as fetchProxyGroupsShared, isWritableGroupType, isGroup as hasGroupMembers, isNonProxyExit, isRealOutboundNode, providerMembersPending, providerPageState } from './proxy-groups.js';
import { Bus, Events } from './events.js';
import { saveProxySelection, savePrimaryGroupPreference } from './proxy-memory.js';
import { knownSelectionRevision, knownSelectionChangedSince } from './known-selection.js';
import { invalidateRunConfigCache } from './run-config-cache.js';
import { queueSmartConfigWrite, syncSmartShown, readAutoTestEnabled } from './settings/auto-switch.js';
import { postRestartRecovery, restartedProfile, withPageBusy } from './lifecycle.js';
import { activeProfile, currentProfile } from './active-profile.js';
import { readRunningProfile } from './running-profile.js';
import { startObservedGroupWatcher, stopObservedGroupWatcher, resetObservedGroup } from './observed-group.js';
import { renderTunStatus } from './tun-status.js';
import { updateModeUI } from './modes.js';
import { onSpeedTestChange, speedOf, isSpeedTestRunning, isSpeedTestBusy, speedTestProgress, speedTestFraction, startSpeedTest, stopSpeedTest, sortBySpeed, readSpeedTestSettings, maxTrafficBytes } from './speed-test.js';

/**
 * The profile a node switch is filed under, read live when it is clicked
 * and when it is answered (a cached read could still name the profile a
 * switch replaced): a failed read is no profile, and then nothing is saved.
 * @returns {Promise<string>}
 */
async function profileForSwitch() {
    return (await readRunningProfile()) ?? '';
}


// Re-export switchPage for external consumers that import from this module

/**
 * Node switch failed: say what happened (title), that nothing changed, and the
 * core's reason when there is one, instead of a bare error string.
 * @param {unknown} [err]
 * @param {boolean} [maybeApplied] the switch reached the core and went unanswered
 * @param {() => boolean} [canWriteNode] whether reconciliation still owns the node label
 * @returns {boolean} whether it re-reads the core's selection itself (an
 *   unknown outcome), so the caller need not start another read
 */
export function notifySwitchFailed(err, maybeApplied = false, canWriteNode = () => true) {
    const tr = /** @type {any} */ (translations)[appStore.get('currentLang')] || translations.en;
    const title = tr.proxySwitchFailed || translations.en.proxySwitchFailed;
    const detail = err ? String(/** @type {any} */ (err)?.message ?? err).replace(/^Error:\s*/, '').trim() : '';
    // A transport failure (no HTTP status) may have reached the core anyway, so
    // don't claim the old node was kept; re-read the core's selection instead.
    const anyErr = /** @type {any} */ (err);
    const unknownOutcome = maybeApplied || err instanceof TypeError
        || (anyErr?.name === 'ApiError' && anyErr?.status == null);
    if (unknownOutcome) {
        showNotification(detail || title, 'error', title);
        // The core may run the new node: cached groups (the cards, the home
        // list, failover) would still show the old one.
        invalidateProxiesCache();
        void syncCoreConfig(canWriteNode)
            .then(() => {
                // The cards must follow the confirmed selection too, not just the node pill.
                const page = document.querySelector('[data-page="proxies"]');
                if (page && !page.classList.contains('hidden')) return renderProxies();
            })
            .catch((e) => proxyLogger.warn('Failed to resync after an unconfirmed switch', e));
        return true;
    }
    const kept = tr.proxySwitchKept || translations.en.proxySwitchKept;
    showNotification(detail ? `${kept}\n${detail}` : kept, 'error', title);
    return false;
}

export { switchPage } from './navigation.js';

/** Close open connections after a node switch so it applies at once. */
async function closeConnsAfterSwitch() {
    try {
        await closeAllConnections();
    } catch (err) {
        proxyLogger.warn('Failed to close connections after proxy switch', err);
    }
}

/**
 * Confirm a node switch. Closing the old connections is how a switch takes
 * effect, not news for the user, so the toast just names the node.
 * @param {string} node
 */
function notifySwitched(node) {
    showNotification(tFmt('switchedNode', { node }), 'success');
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
        /** @type {Array<{name: string, latencyMs: number, success: boolean, revision: number}>} */
        this._queue = [];
        this._running = 0;
        this._max = maxConcurrency;
        /** @type {Array<Function>} */
        this._waiters = [];
    }
    /** @param {string} name @param {number} latencyMs @param {boolean} success */
    push(name, latencyMs, success) {
        this._queue.push({ name, latencyMs, success, revision: _diagnosticConfigRevision });
        this._flush();
    }
    _flush() {
        while (this._running < this._max && this._queue.length > 0) {
            const item = this._queue.shift();
            if (!item) break;
            this._running++;
            void updateSmartScore(item.name, item.latencyMs, item.success, item.revision).finally(() => {
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
 *  @param {number} revision
 */
async function updateSmartScore(nodeName, latencyMs, success, revision) {
    try {
        if (revision !== _diagnosticConfigRevision) return;
        const score = await smartScore(nodeName, latencyMs, success);
        if (revision !== _diagnosticConfigRevision) return;
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
    const revision = _renderGeneration;
    const providers = providerGeneration();
    const current = () => container.isConnected && revision === _renderGeneration && providers === providerGeneration();
    try {
        // Check smart enabled state directly (CSS var may not be set yet due to async init)
        let smartEnabled = document.documentElement.style.getPropertyValue('--smart-enabled') === '1';
        if (!smartEnabled) {
            // Same path as a config reload: smart.toml without `enabled` uses the
            // fallback, the fallback follows the engine, scheduled tests left on
            // without a timer start, and the settings switches show it.
            try { smartEnabled = await syncSmartFromEngine(); } catch { /* not enabled */ }
        }
        if (!smartEnabled || !current()) return;

        const rankings = await smartRank();
        if (!current() || !Array.isArray(rankings) || rankings.length === 0) return;
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
    const renderAtStart = _renderGeneration;
    if (cards.length === 0) return;

    try {
        const rankings = await smartRank();
        if (appStore.get('currentSortMode') !== 'smart' || renderAtStart !== _renderGeneration
            || document.getElementById('proxies-list') !== container) return;
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
 * @param {() => boolean} [canWriteNode] whether this caller still owns the node label
 * @param {{ owningNetworkChange?: boolean }} [options] the active profile/restart operation owns this refresh
 */
export async function syncCoreConfig(canWriteNode = () => true, { owningNetworkChange = false } = {}) {
    const coreAtRead = coreReplacements();
    const providersAtRead = providerGeneration();
    const networkUnchanged = noNetworkChangeSince();
    const networkAtRead = networkChangesBegun();
    // A mode switch that lands while this GET is in flight owns the newer
    // value; writing this (older) response afterwards would roll the store
    // and the tray back to the previous mode.
    const modeBeforeFetch = appStore.get('currentOutboundMode');
    // Likewise a node switch made meanwhile: its own sync draws the pill.
    const switchMark = proxySwitchMark();
    const config = await getConfig();
    if (!config || coreReplacements() !== coreAtRead || providersAtRead !== providerGeneration()) return;

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
    if ((networkUnchanged() || (owningNetworkChange && networkChangesBegun() === networkAtRead))
        && tunToggle instanceof HTMLInputElement && typeof (/** @type {any} */ (config)).tun?.enable === 'boolean') {
        const tunEnable = (/** @type {any} */ (config)).tun.enable;
        appStore.set('isTunEnabled', tunEnable);
        tunToggle.checked = tunEnable;
        tunToggle.indeterminate = false;
        delete tunToggle.dataset.tunUnknown;
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
        const modeAtGroupFetch = appStore.get('currentOutboundMode');
        const configMode = String((/** @type {any} */ (config)).mode || '').toLowerCase();
        if (configMode && configMode !== modeAtGroupFetch) return;
        const proxyGroupsResult = await fetchProxyGroupsShared({ existingConfig: config, preferredGroupName });
        if (coreReplacements() !== coreAtRead || providersAtRead !== providerGeneration()
            || appStore.get('currentOutboundMode') !== modeAtGroupFetch
            || (appStore.get('uiGroupName') || null) !== preferredGroupName) return;
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
            if (currentNodeEl && canWriteNode() && !proxySwitchedSince(switchMark, 0, { landedOnly: true })) {
                // Store the group name in data attribute for robust observed node updates
                currentNodeEl.dataset.group = currentNode;
                currentNodeEl.textContent = formatNodeDisplayName(currentNode, leafNode);
            }
        } else {
            // Fallback to Direct when no proxy groups available
            const currentNodeEl = document.getElementById('current-node-name');
            if (currentNodeEl && canWriteNode() && !proxySwitchedSince(switchMark, 0, { landedOnly: true })) {
                delete currentNodeEl.dataset.group;
                currentNodeEl.textContent = 'Direct';
            }
        }
    } catch (e) {
        proxyLogger.warn('Failed to sync current node display', e);
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
        if (document.getElementById('app-main-container')?.classList.contains('core-down')) {
            statusText.dataset.i18n = 'coreNotRunning';
            statusText.textContent = t('coreNotRunning');
            statusText.classList.remove('text-accent');
            statusText.classList.add('text-[var(--text-muted)]');
            return;
        }

        // data-i18n follows the state, so a language switch keeps it (as ui/sysproxy.js does).
        const key = isActive ? 'stateOn' : (appStore.get('noSubscription') ? 'sysProxyNeedsSubscription' : 'stateOff');
        statusText.dataset.i18n = key;
        if (isActive) {
            statusText.textContent = t('stateOn');
            statusText.classList.remove('text-[var(--text-muted)]');
            statusText.classList.add('text-accent');
        } else {
            statusText.textContent = appStore.get('noSubscription') ? t('sysProxyNeedsSubscription') : t('stateOff');
            statusText.classList.remove('text-accent');
            statusText.classList.add('text-[var(--text-muted)]');
        }
    } catch (err) {
        proxyLogger.error('Failed to update sys proxy UI', err);
    }
}

/** @type {{ signal: AbortSignal, finish: () => Promise<void> } | null} */
let activeLatencyPass = null;

/**
 * Restore the latency controls and cards after a completed, stopped or invalidated pass.
 * Keeping cleanup separate also avoids an ESLint code-path recursion limit.
 * @param {{ testBtn: HTMLElement, icon: HTMLElement|null, iconMarkup: string, testLabel: HTMLElement|null, testLabelKey?: string, testBtnTitleKey?: string, hideTimeoutEnabled: boolean, passSignal: AbortSignal }} context
 */
async function finishLatencyPass({ testBtn, icon, iconMarkup, testLabel, testLabelKey, testBtnTitleKey, hideTimeoutEnabled, passSignal: finishedSignal }) {
    if (activeLatencyPass?.signal !== finishedSignal) return;
    activeLatencyPass = null;
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
    if (testLabel && testLabelKey) testLabel.dataset.i18n = testLabelKey;
    testBtn.title = /** @type {any} */ (translations)[currentLang]?.testLatency || 'Test Latency';
    if (testBtnTitleKey) testBtn.dataset.i18nTitle = testBtnTitleKey;
    if (finishedSignal !== getLatencyTestSignal()) return;
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
    if (finishedSignal !== getLatencyTestSignal() || appStore.get('isTestingLatency')) return;
    // Sort is best-effort — failures here must not affect cleanup
    try {
        if (appStore.get('currentSortMode') === 'smart') {
            await _smartBatcher.wait();
            if (finishedSignal !== getLatencyTestSignal() || appStore.get('isTestingLatency')) return;
            await applySmartSortToDom();
        } else {
            applyLatencySortToDom(true);
        }
    } catch (e) {
        proxyLogger.warn('post-latency sort failed', e);
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
        const labels = { default: t.sortDefault, name: t.sortName, latency: t.sortLatency, smart: t.sortSmart, speed: t.sortSpeed };
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

        initSpeedTestButton();

        testBtn.onclick = async () => {
            // While a test runs the button reads "Stop · 8/19": a second click stops it.
            if (appStore.get('isTestingLatency')) {
                abortLatencyTests();
                return;
            }
            // One test at a time: a download test shares the nodes and the bandwidth.
            if (isSpeedTestBusy()) return;
            resetLatencyTestController();  // Reset controller before starting
            const passSignal = getLatencyTestSignal();
            const passInvalidated = () => getLatencyTestSignal() !== passSignal;
            appStore.set('isTestingLatency', true);
            appStore.set('latencyTestStartTime', Date.now());

            const icon = document.getElementById('test-icon');
            const _t = /** @type {any} */ (translations)[currentLang];

            // While testing, the button is a Stop button: show a stop square instead of the pulse.
            const iconMarkup = icon?.innerHTML ?? '';
            if (icon) icon.innerHTML = '<rect x="6" y="6" width="12" height="12" rx="2.5" fill="currentColor" stroke="none"/>'; // nosemgrep: js-innerhtml-assignment — static markup
            const testLabel = testBtn.querySelector('span');
            // The label shows live progress while testing: keep a language change from
            // putting the static "Test Latency" back over it (restored in finally).
            const testLabelKey = testLabel?.dataset.i18n;
            if (testLabel && testLabelKey) delete testLabel.dataset.i18n;
            // The tooltip must describe the Stop action while testing: keep a
            // language change from putting "Test Latency" back over it
            // (restored in finally).
            const testBtnTitleKey = testBtn.dataset.i18nTitle;
            if (testBtnTitleKey) delete testBtn.dataset.i18nTitle;
            testBtn.title = _t.latencyStop || 'Stop';
            let testedCount = 0;
            _testRunResults.clear();
            let totalCount = 0;
            const showProgress = () => {
                const tr = /** @type {any} */ (translations)[currentLang] || {};
                if (testLabel) testLabel.textContent = totalCount > 0 ? `${tr.latencyStop || 'Stop'} · ${testedCount}/${totalCount}` : (tr.latencyStop || 'Stop');
                // Keep the tooltip in sync with language changes during the test.
                testBtn.title = tr.latencyStop || 'Stop';
                testBtn.style.setProperty('--test-progress', totalCount > 0 ? `${Math.round((testedCount / totalCount) * 100)}%` : '0%');
            };
            testBtn.classList.add('is-testing');
            testBtn.setAttribute('aria-busy', 'true');
            showProgress();

            let hideTimeoutEnabled = false;
            activeLatencyPass = {
                signal: passSignal,
                finish: () => finishLatencyPass({ testBtn, icon, iconMarkup, testLabel, testLabelKey, testBtnTitleKey, hideTimeoutEnabled, passSignal }),
            };

            try {
                showLatencyLoadingForAllCards();
                await renderProxies();
                if (passSignal.aborted || passInvalidated()) return;

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
                if (passSignal.aborted || passInvalidated()) return;
                hideTimeoutEnabled = !!settings?.hide_timeout_nodes;
                // The "switch to fastest" action belongs to this profile only.
                const testedProfile = activeProfile(settings, 'config.yaml');

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
                    if (passSignal.aborted || passInvalidated()) return;
                    // testProxy already handles abort internally and returns -1 on cancellation
                    const gen = beginNodeTest(name);
                    const testSignal = passSignal;
                    const delay = await testProxy(name);
                    // Cut short by Stop: no result, so neither a timeout on the card nor a
                    // failure for the smart score (the cleanup redraws pending cards).
                    if (testSignal.aborted || getLatencyTestSignal() !== testSignal) return;
                    // A single-node re-test started after this one owns the card, and
                    // its newer figure is the one that counts.
                    const isLatest = isLatestNodeTest(name, gen);
                    if (!passSignal.aborted) {
                        testedCount += 1;
                        showProgress();
                    }

                    if (isLatest) {
                        applyNodeLatency(name, delay);
                        _testRunResults.set(name, delay);
                        recordShownResult(name, delay);
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
                    if (isLatest && appStore.get('failoverEnabled') && !passSignal.aborted) {
                        const failoverSuccess = delay > 0 && delay < 999999;
                        // A single-node re-test started meanwhile owns the node's result.
                        void reportFailover(name, failoverSuccess, testSignal, () => isLatestNodeTest(name, gen));
                    }
                };

                const priorityQueue = buildLatencyPriorityQueue(data, validProxiesToTest);
                /** The nodes this run covers; the summary only counts their figures. */
                const runNodes = new Set(priorityQueue);
                totalCount = priorityQueue.length;
                showProgress();
                let queueIndex = 0;
                const concurrency = Math.min(12, priorityQueue.length);
                const workers = Array.from({ length: concurrency }, async () => {
                    while (queueIndex < priorityQueue.length) {
                        if (passSignal.aborted || passInvalidated()) break;
                        const currentIndex = queueIndex;
                        queueIndex += 1;
                        await testProxyAndUpdate(priorityQueue[currentIndex]);
                    }
                });
                await Promise.all(workers);
                // A single-node re-test started during the run owns its node's figure:
                // wait for it, so the summary and the fastest pick read what the card shows.
                // One started while waiting counts too, so wait until none is left.
                while (_retestsInFlight.size > 0 && !passInvalidated()) {
                    await Promise.allSettled(_retestsInFlight);
                }

                if (passInvalidated()) return;

                // One summary instead of making the user scan every card.
                const tr = /** @type {any} */ (translations)[currentLang] || {};
                const stopped = passSignal.aborted;
                // The summary and the fastest pick read the run's figures (_testRunResults),
                // the same ones the cards show: a re-test during the run replaces its node's
                // figure, and one that lands after Stop for a node the run never reached
                // counts too. A node whose run result was superseded by a re-test that Stop
                // then cut short has no figure: it is neither available nor timed out.
                /** @type {Array<[string, number]>} */
                const runFigures = [..._testRunResults].filter(([name]) => runNodes.has(name));
                let available = 0;
                let timedOut = 0;
                for (const [, delay] of runFigures) {
                    if (delay > 0 && delay < 999999) available += 1;
                    else timedOut += 1;
                }
                const parts = [
                    stopped ? (tr.latencyTestStopped || 'Test stopped') : (tr.latencyTestDone || 'Test complete'),
                    `${available} ${tr.latencyAvailable || 'available'}`,
                ];
                if (timedOut > 0) parts.push(`${timedOut} ${tr.latencyTimedOut || 'timed out'}`);
                // Read the latest figure per node: a re-test during the run (even a timeout) replaces it.
                /** @type {{ name: string, delay: number } | null} */
                let best = null;
                for (const [name, delay] of runFigures) {
                    // "Fastest" means a real outbound node: direct/reject and groups
                    // (whose delay is just one of their members') never win it.
                    if (!isRealOutboundNode(name, /** @type {any} */ (data).proxies?.[name])) continue;
                    if (delay > 0 && delay < 999999 && (!best || delay < best.delay)) best = { name, delay };
                }
                if (best) {
                    const label = tr.latencyFastest || 'fastest:';
                    // A full-width colon (zh, ja) already carries its own spacing.
                    parts.push(`${label}${label.endsWith('：') ? '' : ' '}${best.name} ${best.delay}ms`);
                }
                showLatencyResult(parts.join(' · '), available > 0 ? 'ok' : 'warn', best, testedGroup || null, testedProfile);
            } catch (err) {
                if (passInvalidated()) return;
                proxyLogger.error('Latency test error', err);
                const _err = err instanceof Error ? err : new Error(String(err));
                showNotification(
                    `${/** @type {any} */ (translations)[currentLang].latencyTestFailed || 'Latency test failed'}: ${_err.message || err}`,
                    'error'
                );
            } finally {
                await finishLatencyPass({ testBtn, icon, iconMarkup, testLabel, testLabelKey, testBtnTitleKey, hideTimeoutEnabled, passSignal });
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
 * Whether a test run under `signal` no longer counts: aborted, or replaced
 * by a newer run (a new controller is made when one starts).
 * @param {AbortSignal|undefined} signal
 * @returns {boolean}
 */
function latencyRunStale(signal) {
    return !!signal && (signal.aborted || signal !== getLatencyTestSignal());
}

/**
 * Report a proxy test result to the failover engine if the tested node
 * is the currently active node (or its resolved leaf).
 * Only active-node results are reported to avoid stale failure counts.
 * @param {string} name - Tested proxy name
 * @param {boolean} success - Whether the test succeeded
 * @param {AbortSignal} [testSignal] the latency-test signal the test ran under
 * @param {() => boolean} [isFresh] false once a newer test of the node replaced this one
 */
async function reportFailover(name, success, testSignal = getLatencyTestSignal(), isFresh = () => true) {
    if (!appStore.get('failoverEnabled')) return;
    // Taken before the first await: a node the user picks, a network change
    // or a core replacement while the groups and the profile are read below
    // also drops the failover's switch.
    const marks = takeFailoverMarks();
    const uiGroupName = appStore.get('uiGroupName');
    const proxyMap = await getProxiesCached().then(getProxiesMerged).then(d => d?.proxies).catch(() => null);
    const currentNode = proxyMap?.[uiGroupName]?.now;
    const activeLeaf = currentNode ? resolveLeafNode(currentNode, proxyMap) : null;
    const activeNode = activeLeaf || currentNode;
    if (!activeNode || (name !== activeNode && name !== currentNode)) return;
    // The profile the result belongs to: an action for it does nothing once
    // another profile runs (its same-named group is another group).
    const testedProfile = await readRunningProfile();
    // A profile switch since the test started aborts tests, and a profile,
    // mode or TUN change under way sets the flag: the result may belong to
    // the core before it, so it is not reported.
    if (latencyRunStale(testSignal) || !isFresh() || appStore.get('isNetworkUpdating')) return;
    try {
        const action = await failoverReport(name, success);
        // A change that starts and ends while the groups are read or the
        // report is awaited leaves the flag clear: the marker still sees it.
        if (action && marks.networkUnchanged()) {
            void (async () => {
                try { await handleFailoverAction(action, testedProfile, testSignal, isFresh, marks); }
                catch { /* ignore failover action errors */ }
            })();
        }
    } catch { /* ignore failover IPC errors */ }
}

/**
 * @typedef {{ revisionBefore: number, switchMark: number,
 *   networkUnchanged: () => boolean, coreAtSend: number }} FailoverMarks
 */

/**
 * What a failover's switch is checked against: the choices recorded, the
 * node switches started, network changes and core replacements up to now.
 * @returns {FailoverMarks}
 */
function takeFailoverMarks() {
    return {
        revisionBefore: knownSelectionRevision(),
        switchMark: proxySwitchMark(),
        networkUnchanged: noNetworkChangeSince(),
        coreAtSend: coreReplacements(),
    };
}

/** Node card clicks, numbered in click order. */
let _cardSwitchCounter = 0;
/** The newest card click whose switch the core took. */
let _acceptedCardSwitch = 0;
/** Card selection saves, chained so they are written in order. @type {Promise<void>} */
let _cardSelectionSave = Promise.resolve();

/** @type {boolean} */
let _isFailovering = false;

/**
 * Outbound types failover never switches to: none of them is a proxy. DIRECT
 * would send the traffic out unproxied, the others drop it or hand it back to
 * the rules (PASS, PASS-RULE, Rematch). Compared lowercased without
 * separators (`Reject-Drop` = `rejectdrop`, `PassRule` = `passrule`).
 */
const NOT_FAILOVER_TARGETS = new Set(['direct', 'reject', 'rejectdrop', 'compatible', 'pass', 'passrule', 'rematch', 'dns']);

/**
 * Whether the proxy entry is one of the outbounds failover never picks.
 * @param {any} entry
 * @returns {boolean}
 */
function isNotFailoverTarget(entry) {
    const type = String(entry?.type ?? '').toLowerCase().replace(/[^a-z]/g, '');
    return NOT_FAILOVER_TARGETS.has(type);
}

/**
 * Group types that pick their member themselves: url-test and fallback move
 * to another member on their own (their `now` is only the current one).
 * Compared lowercased without separators.
 */
const SELF_CHOOSING_GROUPS = new Set(['urltest', 'fallback']);

/**
 * Group types that pick a member for each connection: a load balancer and a
 * Smart group may send traffic to any member, whatever `now` they report.
 * Compared lowercased without separators.
 */
const PER_CONNECTION_GROUPS = new Set(['loadbalance', 'smart']);

/**
 * Whether traffic sent to `name` may end at an outbound that `isBad` names:
 * a group with a selection follows it (a selector sitting on DIRECT); a load
 * balancer or a Smart group uses every member, so any such member counts,
 * even when it reports a `now`.
 * With `anyMember`, a url-test or fallback group counts any member too: it
 * may move there on its own later (url-test to a faster DIRECT, fallback
 * to DIRECT once the members before it fail).
 * @param {string} name
 * @param {Record<string, any>} proxyMap
 * @param {(name: string, entry: any) => boolean} isBad
 * @param {{ anyMember?: boolean }} [options]
 * @param {Set<string>} [visited]
 * @returns {boolean}
 */
function mayReach(name, proxyMap, isBad, options = {}, visited = new Set()) {
    if (visited.has(name)) return false;
    visited.add(name);
    const entry = proxyMap[name];
    if (isBad(name, entry)) return true;
    if (!entry || !Array.isArray(entry.all) || entry.all.length === 0) return false;
    const type = String(entry.type ?? '').toLowerCase().replace(/[^a-z]/g, '');
    // A load balancer or a Smart group spreads traffic over every member,
    // whatever `now` it reports: each member counts.
    const followsSelection = !PER_CONNECTION_GROUPS.has(type)
        && (!options.anyMember || !SELF_CHOOSING_GROUPS.has(type));
    if (entry.now && followsSelection) return mayReach(entry.now, proxyMap, isBad, options, visited);
    return entry.all.some((/** @type {string} */ member) => mayReach(member, proxyMap, isBad, options, visited));
}

/**
 * Whether the outbound is not a proxy. A built-in one the core does not
 * list (DIRECT missing from `/proxies`) is read by its name.
 * @param {string} name
 * @param {any} entry
 * @returns {boolean}
 */
function isNonProxy(name, entry) {
    return isNotFailoverTarget(entry ?? { type: name });
}

/**
 * The nodes failover may switch the group to: not the failed node, nor one
 * that leads to it or may use it (a load balancer listing it), nor an
 * outbound that is not a proxy, nor a nested group that may send traffic
 * to one (a selector sitting on DIRECT, a load balancer, url-test or
 * fallback group with DIRECT among its members).
 * @param {{ all: string[] }} group
 * @param {Record<string, any>} proxyMap
 * @param {string} failedNode
 * @returns {string[]}
 */
function failoverCandidates(group, proxyMap, failedNode) {
    // The failed node may be a nested group: what failed is the node it
    // leads to, and a member leading there too fails the same way.
    const failedLeaf = resolveLeafNode(failedNode, proxyMap) || failedNode;
    const isFailed = (/** @type {string | null} */ name) => name === failedNode || name === failedLeaf;
    return group.all.filter((n) => {
        if (isFailed(n)) return false;
        const entry = proxyMap[n];
        if (!entry || isNotFailoverTarget(entry)) return false;
        const leaf = resolveLeafNode(n, proxyMap);
        if (leaf && leaf !== n && isNonProxy(leaf, proxyMap[leaf])) return false;
        // A url-test or fallback group listing DIRECT may move to it later
        // on its own. One listing the failed node is still a candidate when
        // it has moved off it: its own health checks keep it off a dead node.
        if (mayReach(n, proxyMap, isNonProxy, { anyMember: true })) return false;
        if (mayReach(n, proxyMap, isFailed)) return false;
        return !isFailed(leaf);
    });
}

/**
 * The last measured delay of a candidate (of the node it leads to), or
 * Infinity when it has none usable.
 * @param {string} name
 * @param {Record<string, any>} proxyMap
 * @returns {number}
 */
function lastDelayOf(name, proxyMap) {
    const leaf = resolveLeafNode(name, proxyMap);
    const history = (leaf ? proxyMap[leaf] : proxyMap[name])?.history;
    const lastDelay = history?.length ? history[history.length - 1]?.delay : undefined;
    return isInvalidDelay(lastDelay) ? Infinity : lastDelay;
}

/**
 * The node to switch to: the engine's own target when it is a candidate,
 * otherwise the candidate with the lowest last delay (the first when none
 * has one).
 * @param {string[]} candidates non-empty
 * @param {Record<string, any>} proxyMap
 * @param {string} target
 * @returns {string}
 */
function pickFailoverTarget(candidates, proxyMap, target) {
    if (target !== 'next' && candidates.includes(target)) return target;
    let bestNode = null;
    let bestDelay = Infinity;
    for (const name of candidates) {
        const delay = lastDelayOf(name, proxyMap);
        if (delay < bestDelay) {
            bestDelay = delay;
            bestNode = name;
        }
    }
    return bestNode || candidates[0];
}

/**
 * Whether the switch still makes sense by the core's live state: the group
 * still sits on the failed node (or on a group leading to it), and the
 * target is still one failover may pick (a nested group the core has moved
 * to DIRECT since the cached read is not).
 * @param {string} groupName
 * @param {string} failedNode
 * @param {string} targetNode
 * @returns {Promise<boolean>}
 */
async function liveStillCallsForSwitch(groupName, failedNode, targetNode) {
    const live = /** @type {Record<string, any>|null} */ (await getProxies()
        .then(getProxiesMerged)
        .then((/** @type {any} */ d) => d?.proxies)
        .catch(() => null));
    if (!live) return false;
    const group = live[groupName];
    const now = group?.now;
    if (!now || !Array.isArray(group.all)) return false;
    if (now !== failedNode && resolveLeafNode(now, live) !== failedNode) return false;
    return failoverCandidates(group, live, failedNode).includes(targetNode);
}

/**
 * Handle a failover action returned by the failover engine.
 * Switches to the best available node (lowest latency) in the current group,
 * and saves it as the profile's choice: a restart then restores it rather
 * than the failed node, and a profile switch whose read of the live
 * selection times out saves it too. Saved only when the same profile runs
 * before and after the switch (a profile switch that finished meanwhile
 * would otherwise file the new profile's node under the old one) and no
 * other choice was recorded meanwhile (a node the user picked during the
 * switch is newer). Nothing is switched when the running profile cannot be
 * read or changed, or when a node switch was sent meanwhile or is still on
 * its way (the user's pick could land after this one), nor when the test
 * that called for it ran under another profile.
 * Exported for tests.
 * @param {{failedNode: string, failureCount: number, target: string}} action
 * @param {string|null} [testedProfile] the running profile when the failed
 *   test was reported (null: unreadable then); omitted: not checked
 * @param {AbortSignal} [testSignal] the latency-test signal the failed test
 *   ran under: once Stop or a profile switch aborts it (also while the
 *   engine was asked), nothing is switched
 * @param {() => boolean} [isFresh] false once a newer test of the failed
 *   node replaced the one that failed (a single-node re-test that may have
 *   found it working again): nothing is switched then
 * @param {FailoverMarks} [marks] taken when the failed test was reported,
 *   before its first await: a choice, a node switch, a network change or a
 *   core replacement since then drops the switch too; omitted: taken here
 */
export async function handleFailoverAction(action, testedProfile, testSignal, isFresh = () => true, marks = undefined) {
    if (_isFailovering) return;
    _isFailovering = true;
    try {
        const uiGroupName = appStore.get('uiGroupName');
        if (!uiGroupName) return;

        // The profile the switch applies to, read before the groups and
        // again after the switch. A choice recorded after this (the user
        // picking a node meanwhile) is newer than the failover's and stays.
        const { revisionBefore, switchMark, networkUnchanged, coreAtSend } = marks ?? takeFailoverMarks();
        // A switch already on its way is not counted after the mark: it
        // could land during the reads below and still be replaced.
        if (proxySwitchedSince(switchMark)) return;
        const runningProfile = await readRunningProfile();
        if (runningProfile === null) return;
        if (testedProfile !== undefined && testedProfile !== runningProfile) {
            proxyLogger.info('Failover skipped: the failed test ran under another profile');
            return;
        }

        const targetNode = await failoverTargetFor(action, uiGroupName);
        if (!targetNode) return;
        if (latencyRunStale(testSignal) || !isFresh()) return;
        if (!await stillCallsForFailover(uiGroupName, action.failedNode, targetNode, runningProfile, switchMark)) return;
        if (latencyRunStale(testSignal) || !isFresh()) return;

        // Checked again when the switch's turn comes, against the mark the
        // checks above were made with: a node switch started since (the
        // user's pick, which may go out first, also one started while the
        // checks were finishing), a network change begun since, or failover
        // turned off meanwhile drops it unsent, as does a latency run that
        // replaced the one it acts on. Its own switch is the one
        // started and in flight it allows.
        const result = await switchProxyResult(uiGroupName, targetNode, {
            canSend: () => !latencyRunStale(testSignal) && isFresh()
                && networkUnchanged() && Boolean(appStore.get('failoverEnabled'))
                && coreReplacements() === coreAtSend
                && !proxySwitchedSince(switchMark, 1, { ownInFlight: 1 })
                && !knownSelectionChangedSince(revisionBefore, runningProfile),
        });
        if (result.reason === SWITCH_BUSY) {
            proxyLogger.info('Failover skipped: a node switch or network change started before it was sent');
            return;
        }
        if (result.error) {
            proxyLogger.warn(`Failover switch to '${targetNode}' was refused:`, result.error);
            void syncCoreConfig().catch((error) => proxyLogger.warn('Sync after refused failover failed', error));
            return;
        }
        const success = result.ok;
        if (success) {
            await afterFailoverSwitch(action, uiGroupName, targetNode, runningProfile, revisionBefore, result.seq, coreAtSend);
        } else {
            // Automatic failover: log the rejected switch rather than raising a
            // notification, so a failing failover does not spam the user.
            proxyLogger.warn('Failover switch was not applied');
            // Sent and unanswered: the core may run the node now, so the page
            // reads what it runs. Nothing is saved for a switch not confirmed.
            if (result.maybeApplied) resyncAfterUnknownFailover('an unconfirmed failover switch');
            else void syncCoreConfig().catch((error) => proxyLogger.warn('Sync after refused failover failed', error));
        }
    } catch (err) {
        // A transport failure after the switch went out leaves its outcome
        // unknown: the page reads what the core runs, nothing is saved.
        proxyLogger.warn('Failover switch failed', err);
        resyncAfterUnknownFailover('a failed failover switch');
    } finally {
        _isFailovering = false;
    }
}

/**
 * After a failover switch whose outcome is unknown: the cache is dropped and
 * the core read again, and the cards follow what it runs when the page is
 * open, not only the node pill.
 * @param {string} what
 */
function resyncAfterUnknownFailover(what) {
    invalidateProxiesCache();
    void syncCoreConfig()
        .then(() => {
            const page = document.querySelector('[data-page="proxies"]');
            if (page && !page.classList.contains('hidden')) return renderProxies();
        })
        .catch((e) => proxyLogger.warn(`Failed to resync after ${what}`, e));
}

/**
 * The node failover switches `uiGroupName` to, read from the current groups:
 * null when the failed node is no longer the group's selection or nothing
 * qualifies.
 * @param {{failedNode: string, target: string}} action
 * @param {string} uiGroupName
 * @returns {Promise<string|null>}
 */
async function failoverTargetFor(action, uiGroupName) {
    const proxyMap = /** @type {Record<string, any>} */ (await getProxiesCached().then(getProxiesMerged).then(d => d?.proxies).catch(() => null));
    const group = proxyMap?.[uiGroupName];
    if (!group?.all?.length) return null;

    const activeLeaf = resolveLeafNode(group.now, proxyMap);
    if (action.failedNode !== group.now && action.failedNode !== activeLeaf) return null;

    const candidates = failoverCandidates(group, proxyMap, action.failedNode);
    if (candidates.length === 0) return null;
    return pickFailoverTarget(candidates, proxyMap, action.target);
}

/**
 * The checks right before the failover switch. A profile, mode or TUN change
 * under way would have the switch land on a core that is changing (and
 * replace the node it carries over). The selection is read live: a node the
 * user picked while this ran is not replaced, and a target that no longer
 * qualifies is not taken. The node was picked from this profile's groups:
 * when another profile came up while they loaded (or which one runs cannot be
 * read), its same-named group may not be the one that failed. A user pick
 * still on its way could land after a check of the live selection; one made
 * from here on is sent after this switch (the switches of a group go out in
 * order), so the core ends on it.
 * @param {string} uiGroupName
 * @param {string} failedNode
 * @param {string} targetNode
 * @param {string} runningProfile
 * @param {number} switchMark
 * @returns {Promise<boolean>}
 */
async function stillCallsForFailover(uiGroupName, failedNode, targetNode, runningProfile, switchMark) {
    if (appStore.get('isNetworkUpdating')) return false;
    if (!await liveStillCallsForSwitch(uiGroupName, failedNode, targetNode)) return false;
    if (await readRunningProfile() !== runningProfile) return false;
    // Turned off while the checks above ran: no automatic switch any more.
    if (appStore.get('isNetworkUpdating') || !appStore.get('failoverEnabled')) return false;
    return !proxySwitchedSince(switchMark);
}

/**
 * After a failover switch the core took: save it as the profile's choice
 * when the same profile still runs and no newer choice was recorded, tell
 * the user, and refresh.
 * @param {{failedNode: string}} action
 * @param {string} uiGroupName
 * @param {string} targetNode
 * @param {string} runningProfile
 * @param {number} revisionBefore
 * @param {number} [switchSeq] the failover switch's number (isLatestSwitch)
 */
async function afterFailoverSwitch(action, uiGroupName, targetNode, runningProfile, revisionBefore, switchSeq, coreAtSend = coreReplacements()) {
    // Another profile runs now: the switch landed on the core it replaced,
    // so there is nothing to save, tell, or close in the one running now.
    // When which one runs cannot be read, the choice is not saved, but the
    // connections still move to the new node.
    const profileNow = await readRunningProfile();
    if (profileNow !== null && profileNow !== runningProfile) return;
    // Likewise a core replaced since the switch went out (a restart of the
    // same profile): it runs its own selection, and the connections open
    // now are its own.
    if (coreReplacements() !== coreAtSend) return;
    // A later switch the core took (the user's pick) is what it runs now:
    // that switch tells and closes the connections itself, so this one says
    // nothing of its node and leaves them alone.
    if (!isLatestSwitch(uiGroupName, switchSeq)) return;
    if (profileNow !== null && runningProfile && !knownSelectionChangedSince(revisionBefore, runningProfile)) {
        await saveProxySelection(runningProfile, { group: uiGroupName, node: targetNode });
        // Changed while the choice was saved: the connections now are the
        // new profile's, or a later switch the core took is its own. A read
        // that fails says neither, so the connections still move, as above.
        const profileAfter = await readRunningProfile();
        if ((profileAfter !== null && profileAfter !== runningProfile) || coreReplacements() !== coreAtSend
            || !isLatestSwitch(uiGroupName, switchSeq)) return;
    }
    showNotification(
        t('failoverSwitched', { failed: action.failedNode, target: targetNode }),
        'success'
    );
    void (async () => {
        try {
            // Dropped before the close is awaited: latency reports meanwhile
            // read the switched node, not the cached failed one.
            invalidateProxiesCache();
            // A failed close still leaves the page to follow the switch.
            await closeAllConnections().catch((err) => proxyLogger.warn('Failed to close connections after failover', err));
            await syncCoreConfig();
            await renderProxies();
        } catch { /* ignore post-failover errors */ }
    })();
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
/** Arrow into a tray: download speed. */
const SPEED_ICON = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v12"/><path d="m7 11 5 5 5-5"/><path d="M5 20h14"/></svg>';

/**
 * Show a node's download speed (or its place in a running test) where the
 * card shows its protocol; put the protocol back when there is no result.
 * @param {HTMLElement} card
 * @param {string} name
 */
function paintCardSpeed(card, name) {
    const latencyAction = /** @type {HTMLButtonElement | null} */ (card.querySelector('.node-retest-btn:not(.node-speed-btn)'));
    if (latencyAction) latencyAction.disabled = isSpeedTestBusy() || latencyAction.classList.contains('is-spinning');
    const action = /** @type {HTMLButtonElement|null} */ (card.querySelector('.node-speed-btn'));
    if (action) action.disabled = isSpeedTestRunning() || !!appStore.get('isTestingLatency') || _retestsInFlight.size > 0;
    const meta = /** @type {HTMLElement|null} */ (card.querySelector('.proxy-meta'));
    if (!meta || meta.dataset.groupNow === '1') return;
    const e = speedOf(name);
    const testing = e?.state === 'testing';
    card.classList.toggle('is-speed-testing', testing);
    let bar = /** @type {HTMLElement|null} */ (card.querySelector('.proxy-speed-progress'));
    if (testing) {
        if (!bar) {
            bar = document.createElement('div');
            bar.className = 'proxy-speed-progress';
            bar.setAttribute('role', 'progressbar');
            bar.dataset.i18nAriaLabel = 'speedTesting';
            bar.setAttribute('aria-label', t('speedTesting'));
            bar.setAttribute('aria-valuemin', '0');
            bar.setAttribute('aria-valuemax', '100');
            bar.appendChild(document.createElement('span'));
            card.appendChild(bar);
        }
        const pct = Math.round(speedTestFraction(name) * 100);
        bar.setAttribute('aria-valuenow', String(pct));
        /** @type {HTMLElement} */ (bar.firstElementChild).style.width = `${pct}%`;
    } else {
        bar?.remove();
    }
    if (!e) {
        if (meta.dataset.speed) {
            meta.textContent = meta.dataset.label || '';
            delete meta.dataset.speed;
        }
        return;
    }
    const key = `${e.state}:${e.mbps ?? ''}`;
    if (meta.dataset.speed === key) return;
    meta.dataset.speed = key;
    const span = document.createElement('span');
    if (e.state === 'done' || (testing && typeof e.mbps === 'number')) {
        span.className = testing ? 'proxy-speed is-live' : 'proxy-speed';
        // eslint-disable-next-line no-unsanitized/property -- static SVG constant
        span.innerHTML = SPEED_ICON; // nosemgrep: js-innerhtml-assignment — static markup
        span.append(`${(e.mbps ?? 0).toFixed(1)} MB/s`);
    } else {
        span.className = testing ? 'proxy-speed is-live' : 'proxy-speed is-muted';
        const labelKey = { waiting: 'speedWaiting', testing: 'speedTesting', skipped: 'speedSkipped', failed: 'speedFailed', done: '' }[e.state];
        span.textContent = t(labelKey);
        // A language switch retranslates it in place.
        if (labelKey) span.dataset.i18n = labelKey;
    }
    meta.replaceChildren(span);
}

/** Repaint every card on screen and the header button. */
function paintSpeedTest() {
    paintFocusedSpeedAction();
    document.querySelectorAll('#proxies-list [data-name]').forEach((w) => {
        const wrapper = /** @type {HTMLElement} */ (w);
        const card = /** @type {HTMLElement|null} */ (wrapper.querySelector('.proxy-card'));
        if (card && wrapper.dataset.name) paintCardSpeed(card, wrapper.dataset.name);
    });
    const btn = document.getElementById('speed-test-btn');
    const label = document.getElementById('speed-test-label');
    const testBtn = /** @type {HTMLButtonElement|null} */ (document.getElementById('test-all-btn'));
    const p = speedTestProgress();
    if (btn && label) {
        btn.classList.toggle('is-running', !!p);
        btn.classList.toggle('hidden', _proxyToolsHidden && !p);
        if (p) {
            delete label.dataset.i18n;
            delete btn.dataset.i18nTitle;
            const text = `${t('speedTestStop')} ${p.done}/${p.total}`;
            // Unchanged on most ticks: rewriting it would only re-run the header fit.
            if (label.textContent !== text) label.textContent = text;
            if (btn.title !== text) btn.title = text;
            btn.setAttribute('aria-keyshortcuts', 'Escape');
        } else {
            label.dataset.i18n = 'speedTestAll';
            btn.dataset.i18nTitle = 'speedTestAll';
            label.textContent = t('speedTestAll');
            btn.title = t('speedTestAll');
            btn.removeAttribute('aria-keyshortcuts');
        }
        btn.toggleAttribute('disabled', !p && (_groupSpeedTestPending || !currentSpeedTestCandidates()?.names.length || !!appStore.get('isTestingLatency') || _retestsInFlight.size > 0));
    }
    // One test at a time: latency and download share the nodes and the bandwidth.
    if (testBtn) testBtn.toggleAttribute('disabled', isSpeedTestBusy());
}

let _groupSpeedTestPending = false;

/**
 * Test the download speed of `names`; `confirmFirst` asks before a run over a
 * whole group, saying how much traffic it may use.
 * @param {string[]} names
 * @param {boolean} confirmFirst
 */
async function runSpeedTest(names, confirmFirst) {
    if (confirmFirst && _groupSpeedTestPending) return;
    if (confirmFirst) { _groupSpeedTestPending = true; paintSpeedTest(); }
    try {
        await runSpeedTestChecked(names, confirmFirst);
    } catch (error) {
        showNotification(error instanceof Error ? error.message : String(error), 'error');
    } finally {
        if (confirmFirst) { _groupSpeedTestPending = false; paintSpeedTest(); }
    }
}

/** @param {string[]} names @param {boolean} confirmFirst */
async function runSpeedTestChecked(names, confirmFirst) {
    if (!names.length) {
        showNotification(t('notifNoNodesForSelection'), 'info');
        return;
    }
    // A profile, mode or TUN change is under way: the core is about to change.
    if (appStore.get('isNetworkUpdating')) {
        showNotification(t('consoleSubUpdateBusy'), 'info');
        return;
    }
    // The core these names were read from; another one (a profile switch,
    // even with the same group and node names) runs other nodes.
    const coreAtStart = coreReplacements();
    const configAtStart = _diagnosticConfigRevision;
    /** @type {Awaited<ReturnType<typeof readSpeedTestSettings>> | undefined} */
    let confirmed;
    if (confirmFirst) {
        // The group the names came from (the list's own state, not the
        // header, which a render updates first): the prompt names that group.
        const listGroup = () => currentSpeedTestCandidates()?.group || '';
        const group = listGroup();
        // The header may already name a group picked since (its list not drawn yet).
        const label = group || document.getElementById('proxy-group-label')?.textContent?.trim() || '';
        // The run uses exactly the settings the prompt shows.
        confirmed = await readSpeedTestSettings();
        const currentGroup = appStore.get('uiGroupName');
        if (listGroup() !== group || (currentGroup && currentGroup !== group)
            || coreReplacements() !== coreAtStart || configAtStart !== _diagnosticConfigRevision
            || appStore.get('isNetworkUpdating')) return;
        const { maxSecs, file } = confirmed;
        const bytes = maxTrafficBytes(names.length, file);
        const vars = { count: String(names.length), group: label, secs: String(maxSecs) };
        let msg = t('speedTestConfirmBody', vars);
        msg += ` ${t(file ? 'speedTestConfirmTraffic' : 'speedTestConfirmTrafficMax', { size: formatTraffic(bytes) })}`;
        const ok = await showConfirmModal(t('speedTestConfirmTitle', vars), msg, { confirmText: t('speedTestStart') });
        // Another group or another core (profile) now: these are not its nodes.
        // A group picked from the menu meanwhile (its list not drawn yet) is not this one either.
        const picked = appStore.get('uiGroupName');
        if (!ok || listGroup() !== group || (picked && picked !== group) || coreReplacements() !== coreAtStart
            || configAtStart !== _diagnosticConfigRevision || appStore.get('isNetworkUpdating')) return;
        const currentNames = currentSpeedTestCandidates()?.names || [];
        const confirmedNames = new Set(names);
        if (currentNames.length !== names.length || currentNames.some((name) => !confirmedNames.has(name))) return;
        if (isSpeedTestRunning() || appStore.get('isTestingLatency') || _retestsInFlight.size > 0) return;
    }
    const out = await startSpeedTest(names, confirmed);
    if (out === 'unavailable') showNotification(t('speedTestUnavailable'), 'warning');
    if (appStore.get('currentSortMode') === 'speed') await refreshProxies();
}

/** @param {number} bytes */
function formatTraffic(bytes) {
    const gb = bytes / (1024 ** 3);
    // Rounded up: the confirmation must not understate the data used.
    return gb >= 1 ? `${(Math.ceil(gb * 10) / 10).toFixed(1)} GiB` : `${Math.ceil(bytes / (1024 ** 2))} MiB`;
}

let _speedWired = false;
/** The whole resolved group, before search and timeout filters. */
/** @type {{ group: string, names: string[], core: number } | null} */
let _speedTestCandidates = null;
let _diagnosticConfigRevision = 0;
function currentSpeedTestCandidates() {
    const picked = appStore.get('uiGroupName');
    const candidate = _speedTestCandidates;
    if (!candidate || candidate.core !== coreReplacements() || (picked || '') !== candidate.group) return null;
    return candidate;
}
let _focusedSpeedNode = '';
function focusedSpeedCardPresent() {
    return [...document.querySelectorAll('#proxies-list [data-name]')].some((node) =>
        /** @type {HTMLElement} */ (node).dataset.name === _focusedSpeedNode);
}
function paintFocusedSpeedAction() {
    const button = /** @type {HTMLButtonElement|null} */ (document.getElementById('focused-node-speed-test'));
    if (!button) return;
    const valid = focusedSpeedCardPresent() && !!currentSpeedTestCandidates()?.names.includes(_focusedSpeedNode);
    button.hidden = !valid;
    button.disabled = isSpeedTestRunning() || !!appStore.get('isTestingLatency') || !!appStore.get('isNetworkUpdating') || _retestsInFlight.size > 0;
    const label = `${t('speedTestNode')}: ${_focusedSpeedNode}`;
    if (button.textContent !== label) button.textContent = label;
}
function clearSpeedTestCandidates() {
    _speedTestCandidates = null;
    paintSpeedTest();
}

/** A separate action remains discoverable outside the listbox's options. */
function initFocusedSpeedAction() {
    const list = document.getElementById('proxies-list');
    if (!list || document.getElementById('focused-node-speed-test')) return;
    const button = document.createElement('button');
    button.id = 'focused-node-speed-test';
    button.type = 'button';
    button.className = 'btn-ghost proxy-focused-speed-action';
    button.hidden = true;
    list.insertAdjacentElement('afterend', button);
    list.addEventListener('focusin', (event) => {
        const node = event.target instanceof Element ? /** @type {HTMLElement|null} */ (event.target.closest('[data-name]')) : null;
        _focusedSpeedNode = node?.dataset.name || '';
        paintFocusedSpeedAction();
    });
    button.addEventListener('click', () => {
        if (button.disabled || _retestsInFlight.size || !focusedSpeedCardPresent() || !currentSpeedTestCandidates()?.names.includes(_focusedSpeedNode)) return;
        void runSpeedTest([_focusedSpeedNode], false);
    });
}
function initSpeedTestButton() {
    const btn = document.getElementById('speed-test-btn');
    if (!btn || _speedWired) return;
    _speedWired = true;
    initFocusedSpeedAction();
    btn.addEventListener('click', () => {
        if (isSpeedTestRunning()) { void stopSpeedTest(); return; }
        if (appStore.get('isTestingLatency') || _retestsInFlight.size > 0) return;
        const candidate = currentSpeedTestCandidates();
        if (!candidate) return; // the current group has not finished loading
        const names = [...candidate.names];
        void runSpeedTest(names, true);
    });
    // Esc stops a run, unless something else (a dialog, a field) wants it.
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape' || e.defaultPrevented || !isSpeedTestRunning()) return;
        // Only on the Nodes page: an Esc elsewhere closes that page's own things.
        const list = document.getElementById('proxies-list');
        if (!list || list.closest('.hidden, [hidden]')) return;
        const target = /** @type {Element|null} */ (e.target instanceof Element ? e.target : null);
        if (target?.closest('input, textarea, [contenteditable]:not([contenteditable="false"])')) return;
        if ([...document.querySelectorAll('[aria-modal="true"]')].some((el) => !el.closest('.hidden, [hidden]'))) return;
        e.preventDefault();
        void stopSpeedTest();
    });
    onSpeedTestChange(paintSpeedTest);
    Bus.on(Events.I18N_APPLIED, () => {
        document.querySelectorAll('#proxies-list [data-name] .node-retest-btn').forEach((el) => {
            const button = /** @type {HTMLButtonElement} */ (el);
            const name = /** @type {HTMLElement|null} */ (button.closest('[data-name]'))?.dataset.name || '';
            const label = t(button.classList.contains('node-speed-btn') ? 'speedTestNode' : 'retestNode');
            button.title = label;
            button.setAttribute('aria-label', `${label}: ${name}`);
        });
        paintSpeedTest();
    });
    appStore.subscribe('isTestingLatency', paintSpeedTest);
    appStore.subscribe('isNetworkUpdating', paintFocusedSpeedAction);
    appStore.subscribe('uiGroupName', paintSpeedTest);
    paintSpeedTest();
}


/** Results of the running full test, so a re-render mid-test (search, sort) keeps them instead of re-pending. */
const _testRunResults = new Map();

/**
 * Latest measurement shown per node, numbered in the order they landed. A render fetches the
 * core's history first and writes cards later: results that landed in between are newer than
 * that history, so the render puts them back (see replayResultsSince).
 * @type {Map<string, { delay: number, seq: number }>}
 */
const _shownResults = new Map();
let _shownResultSeq = 0;
/** @param {string} name @param {number} delay */
function recordShownResult(name, delay) {
    _shownResults.set(name, { delay, seq: ++_shownResultSeq });
}
/**
 * Re-apply results that landed after `mark` (taken when a render started).
 * @param {number} mark
 * @returns {boolean} whether any card changed
 */
function replayResultsSince(mark) {
    let changed = false;
    for (const [name, r] of _shownResults) {
        if (r.seq > mark) { applyNodeLatency(name, r.delay); changed = true; }
    }
    return changed;
}

/** Single-node re-test requests still in flight; a full test's summary waits for them. */
const _retestsInFlight = new Set();

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
    // A download test is measuring through these nodes: a latency request now would skew it.
    if (btn.disabled || isSpeedTestBusy()) return;
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
        const pending = testProxy(name);
        _retestsInFlight.add(pending);
        paintSpeedTest();
        /** @type {number} */
        let delay = -1;
        try {
            delay = await pending;
        } finally {
            _retestsInFlight.delete(pending);
            paintSpeedTest();
        }
        // A replacement controller belongs to a new configuration/pass.
        if (signal !== getLatencyTestSignal()) return;
        // Cut short by Stop: no measurement, so leave the card as it was.
        if (signal.aborted && !(delay > 0)) return;
        // A newer test of this node (the full list) owns the result.
        if (!isLatestNodeTest(name, gen)) return;
        applyNodeLatency(name, delay);
        recordShownResult(name, delay);
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
            if (signal !== getLatencyTestSignal() || signal.aborted || !isLatestNodeTest(name, gen)) return;
            flashHiddenChip();
            await renderProxies();
        }
    } catch (err) {
        proxyLogger.warn('Single node test failed', err);
    } finally {
        btn.classList.remove('is-spinning');
        btn.disabled = isSpeedTestBusy();
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
 * @param {string|null} [testedProfile] - the profile the test ran on; the switch only applies there
 */
function showLatencyResult(text, tone, fastest, testedGroup = null, testedProfile = null) {
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
            // Busy (profile change, mode switch, TUN toggle): keep the action for later.
            if (appStore.get('isNetworkUpdating')) {
                showNotification(t('consoleSubUpdateBusy'), 'info');
                return;
            }
            bar.remove();
            void switchToFastest(testedGroup, fastest.name, testedProfile);
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
 * @param {string|null} [testedProfile] - the profile the test ran on
 */
async function switchToFastest(testedGroup, node, testedProfile = null) {
    const tr = /** @type {any} */ (translations)[appStore.get('currentLang')] || {};
    // A profile change, mode switch or TUN toggle holds this guard and may still
    // restore a saved node when it finishes: same rule as a card click.
    if (appStore.get('isNetworkUpdating')) {
        showNotification(t('consoleSubUpdateBusy'), 'info');
        return;
    }
    // Taken before any await: a change that begins while the profile, the
    // groups or the core's selection are read is caught when the switch
    // goes out, and stops the save of an already-selected node too.
    const networkUnchanged = noNetworkChangeSince();
    // Also before any await: a pick on another surface, or a core replaced,
    // while the profile, the groups or the core's selection are read is
    // newer than this switch.
    const switchMarkAtRead = proxySwitchMark();
    const coreAtRead = coreReplacements();
    try {
        // The profile changed since the test: its group and node may exist here too,
        // but the result says nothing about this profile, so neither switch nor save.
        // Read it uncached, as a cached name can lag just after a profile change.
        const runningProfile = activeProfile(await invoke(COMMANDS.GET_SETTINGS), 'config.yaml');
        if (testedProfile != null && runningProfile !== testedProfile) {
            showNotification(tr.latencyResultOtherProfile || 'The test was run on a different subscription', 'info');
            return;
        }
        const group = testedGroup || (await fetchProxyGroupsShared({ preferredGroupName: appStore.get('uiGroupName') || undefined }))?.uiGroupName;
        // The selected card may be filtered out of view: ask the core (uncached, as a
        // stale selection would skip a switch still needed), and do not re-select (and
        // close every connection for) the node already in use.
        const proxyMap = group
            ? await getProxies().then(getProxiesMerged).then(d => d?.proxies).catch(() => null)
            : null;
        // Saved for the profile verified above, the one the switch applies to.
        const saveSelection = async (/** @type {string} */ savedGroup) => {
            // The minimal config runs: no profile to save the choice under.
            if (!runningProfile) return;
            try {
                await saveProxySelection(runningProfile, { node, group: savedGroup });
            } catch (e) {
                proxyLogger.warn('Failed to save proxy selection', e);
            }
        };
        // A profile change may have started during the awaits above: check again right
        // before switching or saving, so neither lands on the wrong profile.
        if (appStore.get('isNetworkUpdating')) {
            showNotification(t('consoleSubUpdateBusy'), 'info');
            return;
        }
        if (activeProfile(await invoke(COMMANDS.GET_SETTINGS), 'config.yaml') !== runningProfile) {
            showNotification(tr.latencyResultOtherProfile || 'The test was run on a different subscription', 'info');
            return;
        }
        if (group && proxyMap?.[group]?.now === node) {
            if (!networkUnchanged()) {
                showNotification(t('consoleSubUpdateBusy'), 'info');
                return;
            }
            // Already in use, but the saved choice for the profile may still
            // differ. Not when another switch the core took, or a core
            // replaced, came after the read: the node read may no longer be
            // the one in use.
            // Neither is it announced as the one in use then.
            if (!proxySwitchedSince(switchMarkAtRead, 0, { landedOnly: true })
                && coreReplacements() === coreAtRead) {
                await saveSelection(group);
                // Not when a later switch landed while the choice was saved.
                if (!proxySwitchedSince(switchMarkAtRead, 0, { landedOnly: true })
                    && coreReplacements() === coreAtRead) notifySwitched(node);
            }
            return;
        }
        if (!group) {
            showNotification(tr.proxySwitchFailed || 'Failed to switch proxy', 'error');
            return;
        }
        // A pick made on another surface while the reads above ran is newer
        // than this one: this switch is not sent over it.
        const result = await switchProxyResult(group, node, {
            canSend: () => networkUnchanged() && !proxySwitchedSince(switchMarkAtRead, 1, { ownInFlight: 1 })
                // The node was picked from the latencies of the core read
                // then: a core that replaced it does not get this switch.
                && coreReplacements() === coreAtRead,
        });
        if (result.reason === SWITCH_BUSY) {
            showNotification(t('consoleSubUpdateBusy'), 'info');
            return;
        }
        if (!result.ok) {
            // Sent and unanswered: the core may run the node, so the pages
            // re-read what it runs, as the card and wheel paths do.
            if (result.maybeApplied) invalidateProxiesCache();
            if (!notifySwitchFailed(result.reason, result.maybeApplied)) {
                void syncCoreConfig().catch((e) => proxyLogger.warn('Config sync after refused switch failed', e));
            }
            return;
        }
        invalidateProxiesCache();
        // A later pick the core took (from any surface) is the choice kept.
        if (isLatestSwitch(group, result.seq)) await saveSelection(group);
        // A core that replaced the one switched (a restart meanwhile) runs
        // its own selection: its connections stay, and this node is not
        // announced as the one in use.
        // A later pick the core took while the choice was saved closes the
        // connections and announces its own node.
        if (coreReplacements() !== coreAtRead || !isLatestSwitch(group, result.seq)) {
            await renderProxies().catch((e) => proxyLogger.warn('Re-render after switch failed', e));
            return;
        }
        await closeConnsAfterSwitch();
        // A later switch or a restart during the close owns what is announced.
        if (coreReplacements() !== coreAtRead || !isLatestSwitch(group, result.seq)) {
            await renderProxies().catch((e) => proxyLogger.warn('Re-render after switch failed', e));
            return;
        }
        notifySwitched(node);
        // The switch already happened: a failed refresh afterwards is not a failed switch.
        await syncCoreConfig().catch((e) => proxyLogger.warn('Config sync after switch failed', e));
        await renderProxies().catch((e) => proxyLogger.warn('Re-render after switch failed', e));
    } catch (err) {
        proxyLogger.warn('Switch to fastest node failed', err);
        // A transport failure may have reached the core: notifySwitchFailed
        // reads what it runs instead of claiming the old node was kept.
        invalidateProxiesCache();
        notifySwitchFailed(err);
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
    if (e.key === 'Tab') {
        // Close and continue the Tab from the sort button, so focus moves past the menu.
        if (!_sortMenu.contains(/** @type {Node|null} */ (document.activeElement))) return;
        closeSortMenu();
        document.getElementById('sort-btn')?.focus();
        return;
    }
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
    const modes = smartEnabled ? ['default', 'name', 'latency', 'speed', 'smart'] : ['default', 'name', 'latency', 'speed'];
    /** @type {Record<string, [string, string]>} */
    const text = {
        default: [tr.sortDefault, tr.sortDefaultDesc],
        name: [tr.sortName, tr.sortNameDesc],
        latency: [tr.sortLatency, tr.sortLatencyDesc],
        smart: [tr.sortSmart, tr.sortSmartDesc],
        speed: [tr.sortSpeed, tr.sortSpeedDesc],
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
        // Arrow keys move between options; Tab leaves the menu (see onSortMenuKey).
        item.tabIndex = -1;
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
/** No node list to act on (direct mode, no nodes): the list tools are hidden. */
let _proxyToolsHidden = false;

function setProxyToolsHidden(/** @type {boolean} */ hidden) {
    if (hidden) clearSpeedTestCandidates();
    _proxyToolsHidden = hidden;
    for (const id of ['sort-btn', 'test-all-btn']) {
        document.getElementById(id)?.classList.toggle('hidden', hidden);
    }
    // A run still going keeps its Stop.
    document.getElementById('speed-test-btn')?.classList.toggle('hidden', hidden && !speedTestProgress());
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

/** @param {string} uiGroupName @param {string|null} effectiveGroupName @param {string|null} observedGroupName @param {string|null} observedNodeName @param {Record<string, any>} proxyMap @param {string} profile - the active profile; a dismissal belongs to it */
function renderGroupExplanationBar(uiGroupName, effectiveGroupName, observedGroupName, observedNodeName, proxyMap, profile) {
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
    // One key per profile and group pair; a dismissed pair stays quiet across sessions,
    // but only in its own profile (another profile can route the same names differently).
    const mismatchKey = `${profile}|${uiGroupName}|${decision.target}`;
    if (_dismissedMismatchKey === mismatchKey || isMismatchDismissed(mismatchKey)) {
        hideGroupExplanationBar();
        return;
    }
    // Same message already showing: leave the live region alone so it is not re-announced.
    // The headline depends on the kind too, so it is part of the rendered key.
    // The language is part of the key: the bar's spans carry no data-i18n, so a
    // language change must rebuild them.
    const targetGroup = decision.target;
    const targetType = proxyMap?.[targetGroup]?.type || '';
    // A hidden selector cannot be opened in the group menu, so it is not switchable here either.
    // Part of the key: a config reload can hide the target or change its type while the
    // pair stays the same, and the button must follow.
    const targetIsWritable = isWritableGroupType(targetType) && !proxyMap?.[targetGroup]?.hidden;
    const renderedKey = `${mismatchKey}|${decision.kind}|${currentLang}|${targetIsWritable ? 'w' : 'ro'}`;
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

    if (targetIsWritable) {
        btn.className = 'group-mismatch-action';
        btn.textContent = t('openMismatchGroup');
        btn.onclick = async () => {
            try {
                appStore.set('uiGroupName', targetGroup);
                _renderGeneration++;
                invalidateProxiesCache();
                invalidateRunConfigCache();
                // Persist group preference for restore after restart
                const settings = await getSettingsCached();
                // No profile (no subscription, the minimal config): nothing to save under.
                const profileName = activeProfile(settings);
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

    // Hide if no groups available (and close a menu left over from a
    // previous render, which would otherwise stay visible and focused)
    if (!groups || groups.length === 0) {
        // If focus was in the menu, it cannot go back to the trigger (also
        // being hidden): land it on the search input instead of <body>.
        const menuHadFocus = !!_groupMenuElement?.contains(document.activeElement);
        selector.classList.add('hidden');
        if (_groupMenuElement) {
            _groupMenuElement.classList.add('hidden');
            trigger.setAttribute('aria-expanded', 'false');
            trigger.querySelector('.dropdown-arrow')?.classList.remove('rotate-180');
        }
        if (menuHadFocus) {
            const search = document.getElementById('proxy-search');
            // The empty state can hide the search box too; only use it
            // as the landing spot while it is actually visible.
            if (search && search.getClientRects().length > 0) search.focus();
        }
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
        _groupMenuElement.setAttribute('role', 'menu');
        _groupMenuElement.className = 'proxy-group-menu hidden fixed border border-[var(--zephyr-border-default)] rounded-lg shadow-2xl';
        _groupMenuElement.style.zIndex = '99999';
        const scrollDiv = document.createElement('div');
        scrollDiv.className = 'menu-scroll max-h-[300px]';
        _groupMenuElement.appendChild(scrollDiv);
        document.body.appendChild(_groupMenuElement);
    }
    const menu = _groupMenuElement;
    const menuScroll = /** @type {HTMLElement} */ (menu.querySelector('.menu-scroll'));

    // Close the menu; when focus was inside it, return focus to the trigger
    // instead of dropping it to <body> as the menu becomes display:none.
    const hideGroupMenu = (plainFocusRestore = true) => {
        if (menu.classList.contains('hidden')) return;
        const hadFocus = menu.contains(document.activeElement);
        menu.classList.add('hidden');
        trigger.setAttribute('aria-expanded', 'false');
        trigger.querySelector('.dropdown-arrow')?.classList.remove('rotate-180');
        // Scroll/resize closes restore focus with preventScroll: leaving
        // focus on a hidden item strands keyboard users, but a plain
        // focus() would scroll the trigger back into view and undo the
        // user's scroll.
        if (hadFocus) trigger.focus(plainFocusRestore ? undefined : { preventScroll: true });
    };

    // Menu keyboard pattern (mirrors the sort menu): arrows move between
    // options, Escape closes, Tab closes and continues from the trigger.
    if (!menu.dataset.keyboardBound) {
        menu.dataset.keyboardBound = '1';
        menu.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                hideGroupMenu();
                return;
            }
            if (e.key === 'Tab') {
                // Same Shift+Tab rule as the override menu: land on the
                // trigger instead of skipping backward past it.
                if (e.shiftKey) e.preventDefault();
                hideGroupMenu();
                return;
            }
            const items = /** @type {HTMLElement[]} */ (Array.from(menu.querySelectorAll('[role="menuitemradio"]')));
            const at = items.indexOf(/** @type {HTMLElement} */ (document.activeElement));
            /** @type {Record<string, number>} */
            const moves = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: items.length - 1 };
            if (!(e.key in moves) || items.length === 0) return;
            e.preventDefault();
            e.stopPropagation();
            items[(moves[e.key] + items.length) % items.length].focus();
        });
    }

    // Build menu items. A re-render while the menu is open must not strand
    // keyboard focus on a detached item: remember which group had focus
    // and restore it to the rebuilt item below.
    const hadMenuFocus = !menu.classList.contains('hidden') && menu.contains(document.activeElement);
    const focusedGroup = hadMenuFocus ? /** @type {HTMLElement|null} */ (document.activeElement)?.dataset.group : undefined;

    menuScroll.replaceChildren();
    groups.forEach(groupName => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'proxy-group-option w-full text-start px-3 py-2 rounded-[var(--radius-dropdown-option)] text-xs text-[var(--text-secondary)] hover:bg-[var(--zephyr-bg-muted)] transition-colors';
        btn.dataset.group = groupName;
        const isCurrent = groupName === currentGroup;
        btn.setAttribute('role', 'menuitemradio');
        btn.setAttribute('aria-checked', isCurrent ? 'true' : 'false');
        btn.tabIndex = -1;
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
            // Close menu (restores focus to the trigger if it was inside)
            hideGroupMenu();

            // Switch group
            try {
                appStore.set('uiGroupName', groupName);
                _renderGeneration++;
                invalidateProxiesCache();
                invalidateRunConfigCache();

                // Persist preference
                const settings = await getSettingsCached();
                // No profile (no subscription, the minimal config): nothing to save under.
                const profileName = activeProfile(settings);
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

    if (hadMenuFocus) {
        // If the focused group vanished in this render, fall back to the
        // current group (or the first option) rather than dropping focus.
        const restored = (focusedGroup
            ? menuScroll.querySelector(`[data-group="${CSS.escape(focusedGroup)}"]`)
            : null)
            || menuScroll.querySelector('[role="menuitemradio"][aria-checked="true"]')
            || menuScroll.querySelector('[role="menuitemradio"]');
        if (restored instanceof HTMLElement) restored.focus();
    }

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
                trigger.setAttribute('aria-expanded', 'true');
                trigger.querySelector('.dropdown-arrow')?.classList.add('rotate-180');
                // Menus move focus into themselves when opened.
                const startItem = menuScroll.querySelector('[role="menuitemradio"][aria-checked="true"]') || menuScroll.querySelector('[role="menuitemradio"]');
                if (startItem instanceof HTMLElement) startItem.focus();

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
                hideGroupMenu();
            }
        });

        // Close on outside click
        document.addEventListener('click', (e) => {
            if (!selector.contains(/** @type {Node} */ (e.target)) && !menu.contains(/** @type {Node} */ (e.target))) {
                hideGroupMenu();
            }
        });

        // Close on Escape
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && !menu.classList.contains('hidden')) {
                hideGroupMenu();
            }
        });

        // Close on scroll or resize to prevent menu misalignment
        const closeMenu = () => {
            hideGroupMenu(false);
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
        // Any group record, even an empty one, is not a node.
        if (Array.isArray(node?.all)) return false;
        return !isNonProxyExit(name, node);
    });
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
        const recovery = await withPageBusy(async () => {
            // Read under the lock, uncached: a profile switch finishing just
            // before this restart is the profile it restarts, and one whose
            // save failed is still the one the core runs.
            /** @type {any} */
            const settings = await invoke(COMMANDS.GET_SETTINGS);
            const configPath = currentProfile(settings, 'config.yaml');
            const customArgs = settings?.custom_args || [];
            const coreResult = await restartCore(configPath, customArgs);
            // A fallback is said and saved, as after the other restarts.
            const { keepFallbackProfile } = await import('./settings/subscriptions.js');
            await keepFallbackProfile(coreResult, configPath);
            return postRestartRecovery(restartedProfile(coreResult, configPath));
        });
        // Re-read after awaits: user may have switched language during restart.
        const tSuccess = /** @type {any} */ (translations)[currentLang] || {};
        if (recovery?.failed) {
            showNotification(tSuccess.restartRecoveryWarn || 'The core restarted, but some proxy choices, patches or overrides couldn’t be restored.', 'warning');
        } else {
            showNotification(tSuccess.coreRestarted || 'Core restarted', 'success');
        }
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
 * After 8s, a "Taking longer than usual" hint and a "Restart Core" button appear below the spinner.
 * @param {HTMLElement} container
 * @param {string} loadingText
 */
function renderProxiesLoading(container, loadingText) {
    clearSpeedTestCandidates();
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
        // The accent inline style would override .btn-ghost.
        btn.style.cssText = '';
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
    clearSpeedTestCandidates();
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
                && providerMembersPending(result.proxies || [], data?.proxies);
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
            if (gen === _providerPollGeneration) _providerPollInFlight = false;
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
    // A same-named entry that changed between node and group (or DIRECT-like)
    // gains or loses its download button and speed line: draw it anew.
    const sameKinds = existingWrappers.every((w) => {
        const name = /** @type {string} */ ((/** @type {HTMLElement} */ (w)).dataset.name);
        const node = (/** @type {any} */ (data)).proxies?.[name];
        return !!w.querySelector('.node-speed-btn') === (!!node?.type && isRealOutboundNode(name, node));
    });
    const canUpdateInPlace = existingWrappers.length > 0 &&
        existingWrappers.length === proxies.length &&
        [...existingNames].every(name => newNames.has(/** @type {string} */ (name))) &&
        sameKinds;

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
                meta.dataset.label = meta.textContent;
                delete meta.dataset.speed;
                meta.title = proxy?.type || '';
                if (groupNow) meta.dataset.groupNow = '1';
                else delete meta.dataset.groupNow;
                paintCardSpeed(/** @type {HTMLElement} */ (card), name);
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
    // Tab into the list lands on the selected node, not the first card. While focus
    // is already on a card (or its re-test button), that card keeps the tab stop.
    const focusedOption = document.activeElement instanceof HTMLElement && container.contains(document.activeElement)
        ? document.activeElement.closest('[role="option"]')
        : null;
    const tabStop = focusedOption instanceof HTMLElement && container.contains(focusedOption)
        ? focusedOption
        : currentWrapper;
    if (tabStop instanceof HTMLElement && tabStop.matches('[role="option"]')) {
        container.querySelectorAll('[role="option"]').forEach((el) => {
            if (el instanceof HTMLElement) setItemTabStop(el, el === tabStop);
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
        metaText.dataset.label = metaText.textContent;
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
        retest.disabled = isSpeedTestBusy();
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
        // Test this node's download speed (leaf nodes only: a group has no speed of its own).
        if (proxy?.type && isRealOutboundNode(name, proxy)) {
            const speedBtn = document.createElement('button');
            speedBtn.type = 'button';
            speedBtn.className = 'node-retest-btn node-speed-btn';
            speedBtn.tabIndex = -1;
            speedBtn.disabled = isSpeedTestRunning() || !!appStore.get('isTestingLatency') || _retestsInFlight.size > 0;
            speedBtn.title = t('speedTestNode');
            speedBtn.setAttribute('aria-label', `${t('speedTestNode')}: ${name}`);
            // eslint-disable-next-line no-unsanitized/property -- static SVG constant
            speedBtn.innerHTML = SPEED_ICON; // nosemgrep: js-innerhtml-assignment — static markup
            speedBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (isSpeedTestRunning() || appStore.get('isTestingLatency') || _retestsInFlight.size > 0) return;
                const candidates = currentSpeedTestCandidates();
                if (!card.isConnected || candidates?.group !== mainGroup || !candidates.names.includes(name)) return;
                void runSpeedTest([name], false);
            });
            right.appendChild(speedBtn);
        }
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
        paintCardSpeed(card, name);

        // --- Click handler: switch proxy ---
        card.onclick = async () => {
            // A mode switch, TUN toggle or profile change holds this guard
            // and may still carry the previous node over when it finishes;
            // a click now would race it and could be undone.
            if (appStore.get('isNetworkUpdating')) {
                showNotification(t('consoleSubUpdateBusy'), 'info');
                return;
            }
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

            const cardSwitch = ++_cardSwitchCounter;
            const coreAtClick = coreReplacements();
            try {
                // The profile the click was made under, read in the switch's
                // turn so a later click cannot go out first: a profile switch
                // while the request runs must not file this node under the
                // one that replaced it.
                const { ok: success, reason: switchRejection, maybeApplied: switchMaybeApplied, prepared: profileAtClick = '', seq: switchSeq } = await switchProxyResult(mainGroup, name, {
                    prepare: profileForSwitch,
                    // A change that began meanwhile could carry its own node
                    // over this switch, or take it to the core that replaces this one.
                    canSend: noNetworkChangeSince(),
                });
                invalidateProxiesCache();

                card.classList.remove('opacity-50', 'pointer-events-none');
                restoreLatency();
                if (switchRejection === SWITCH_BUSY) {
                    showNotification(t('consoleSubUpdateBusy'), 'info');
                    void syncCoreConfig().catch((err) => proxyLogger.warn('Failed to sync after a deferred switch', err));
                    return;
                }

                if (success) {
                    // Not on a core that replaced the one the click went to:
                    // the cards may show the new core's node already.
                    // Nor for a switch a later one replaced, nor on a card a redraw
                    // took off the page.
                    if (coreReplacements() === coreAtClick && isLatestSwitch(mainGroup, switchSeq)
                        && card.isConnected) setActiveNode(card, container);

                    // Save the selection for the profile it was clicked under.
                    // Saves run one at a time and only for the newest switch the
                    // core took, so an older choice is never written last.
                    if (cardSwitch > _acceptedCardSwitch) _acceptedCardSwitch = cardSwitch;
                    _cardSelectionSave = _cardSelectionSave.then(async () => {
                        if (_acceptedCardSwitch !== cardSwitch) return;
                        const currentProfile = await profileForSwitch();
                        // A later switch from another surface (the wheel) stands over this one too.
                        if (currentProfile && currentProfile === profileAtClick && _acceptedCardSwitch === cardSwitch
                            && isLatestSwitch(mainGroup, switchSeq)) {
                            await saveProxySelection(currentProfile, { node: name, group: mainGroup });
                        }
                    }).catch(() => { /* ignore */ });
                    await _cardSelectionSave;
                    // Replaced since the click (a restart or another
                    // profile): the connections open now are the new core's,
                    // and the cards follow what that core runs.
                    if (coreReplacements() !== coreAtClick) {
                        void syncCoreConfig().catch((err) => proxyLogger.warn('Failed to sync core after proxy switch', err));
                        return;
                    }
                    // A later switch the core took (from another surface) is
                    // what runs now: this node is neither announced nor its
                    // connections closed for it; the page follows the core.
                    if (!isLatestSwitch(mainGroup, switchSeq)) {
                        void syncCoreConfig().catch((err) => proxyLogger.warn('Failed to sync core after proxy switch', err));
                        return;
                    }

                    if (appStore.get('currentSortMode') === 'smart') {
                        await applySmartSortToDom();
                        // The sort waited: a restart or a later switch that
                        // landed meanwhile is what runs now, as above.
                        if (coreReplacements() !== coreAtClick || !isLatestSwitch(mainGroup, switchSeq)) {
                            void syncCoreConfig().catch((err) => proxyLogger.warn('Failed to sync core after proxy switch', err));
                            return;
                        }
                    } else if (typeof applyLatencySortToDom === 'function') {
                        applyLatencySortToDom();
                    }

                    // Open connections are closed so the new node applies at once.
                    await closeConnsAfterSwitch();
                    // A later switch or a restart during the close owns what is
                    // announced.
                    if (coreReplacements() !== coreAtClick || !isLatestSwitch(mainGroup, switchSeq)) {
                        void syncCoreConfig().catch((err) => proxyLogger.warn('Failed to sync core after proxy switch', err));
                        return;
                    }
                    notifySwitched(name);
                    void syncCoreConfig().catch((err) => proxyLogger.warn('Failed to sync core after proxy switch', err));
                } else {
                    if (!notifySwitchFailed(switchRejection, switchMaybeApplied)) {
                        void syncCoreConfig().catch((err) => proxyLogger.warn('Failed to sync after a refused switch', err));
                    }
                }
            } catch (err) {
                card.classList.remove('opacity-50', 'pointer-events-none');
                restoreLatency();
                notifySwitchFailed(err);
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
    const coreAtRender = coreReplacements();
    const container = document.getElementById('proxies-list');
    if (!container) { clearSpeedTestCandidates(); return; }

    // Render generation token — must be incremented before any async work
    // so that early-return paths (no data, direct mode, no groups) also
    // invalidate stale renders from older invocations.
    const _renderGen = ++_renderGeneration;
    // Results landing after this point are newer than the history this render fetches.
    const resultMark = _shownResultSeq;

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
    if (_renderGen !== _renderGeneration || coreAtRender !== coreReplacements()) return;

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
    if (_renderGen !== _renderGeneration || coreAtRender !== coreReplacements()) return;
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
    // After the bounded poll gave up on this group, show the DIRECT/REJECT members it has.
    const providerPollGaveUp = _providerPollExhaustedGroup !== undefined && _providerPollExhaustedGroup === uiGroupName;
    const providerState = providerPageState({
        resolverLoading: !!proxyGroupsResult.providerLoading,
        usesProviders: !!proxyGroupsResult.uiGroupUsesProviders,
        members: proxies,
        proxyMap: data?.proxies,
        pollExhausted: providerPollGaveUp,
    });
    const showMembersAfterPoll = providerState.showMembersAfterPoll;
    proxyGroupsResult.providerLoading = providerState.loading;

    // Only DIRECT / REJECT in the group and no real node anywhere: no subscription (or one
    // without nodes) yet. A DIRECT/REJECT selector (an ad-block group) in a config that has
    // nodes still renders, so either member can be picked.
    // (An include-all group waiting for its provider looks the same: the poller below handles it.
    // Once that poll gave up, the members it has are shown so one can still be picked.)
    if (!proxyGroupsResult.providerLoading && onlySpecialMembers && !showMembersAfterPoll) {
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
    // Provider loaded successfully — clear exhausted state and stop any lingering poller.
    // A group shown with only its DIRECT/REJECT members after the poll gave up keeps the
    // mark, so the next refresh does not drop back to the loading screen.
    stopProviderPoll();
    if (showMembersAfterPoll && uiGroupName) _providerPollExhaustedGroup = uiGroupName;

    // Render the group explanation bar (observed/effective vs ui group mismatch indicator)
    const observedGroupName = appStore.get('observedGroupName');
    const observedNodeName = appStore.get('observedNodeName');
    // Membership is already resolved. Publish it before the settings read so
    // a confirmation cannot compare itself with an older provider snapshot.
    _speedTestCandidates = {
        group: uiGroupName || '',
        names: [...new Set(proxies)].filter((name) => data?.proxies?.[name]?.type && isRealOutboundNode(name, data.proxies[name])),
        core: coreAtRender,
    };
    // Settings name the active profile (the explanation bar's dismissals belong to it)
    // and whether timeouts are hidden.
    const settings = await getSettingsCached();
    // Guard: if a newer render started while fetching, abort.
    if (_renderGen !== _renderGeneration || coreAtRender !== coreReplacements()) return;
    _barSuppressed = false;
    renderGroupExplanationBar(uiGroupName || '', effectiveGroupName, observedGroupName, observedNodeName, /** @type {Record<string, any>} */ (data?.proxies), settings?.last_config || 'config.yaml');

    // Filter out unavailable (timeout) proxies if setting is enabled
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
    paintSpeedTest();
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
        paintFocusedSpeedAction();
        return;
    }

    if (appStore.get('currentSortMode') === 'name') {
        proxies.sort((/** @type {string} */ a, /** @type {string} */ b) => a.localeCompare(b));
    } else if (appStore.get('currentSortMode') === 'latency') {
        sortProxiesByLatency(proxies, data);
    } else if (appStore.get('currentSortMode') === 'speed') {
        sortBySpeed(proxies);
    }

    // Sync sort label with current mode (may be reset by applyTranslations)
    const sortLabelEl = document.getElementById('sort-label');
    if (sortLabelEl) {
        const sortLabels = { default: t.sortDefault, name: t.sortName, latency: t.sortLatency, smart: t.sortSmart, speed: t.sortSpeed };
        sortLabelEl.textContent = (/** @type {any} */ (sortLabels))[appStore.get('currentSortMode')] || sortLabels['default'];
    }

    // Store virtual data for lazy card creation
    _virtState.set(container, { proxies, data, current, isTestingLatency: appStore.get('isTestingLatency'), mainGroup: uiGroupName });

    // --- In-place update path ---
    const updatedInPlace = container.dataset.proxyGroup === uiGroupName && await updateProxiesInPlace(container, proxies, data, current);
    if (_renderGen !== _renderGeneration || coreAtRender !== coreReplacements()) return;
    if (updatedInPlace) {
        // Guard: if a newer render started while updating, abort.
        if (_renderGen !== _renderGeneration) return;
        paintFocusedSpeedAction();
        // The in-place path rewrites cards from the core's history; mid-test, keep
        // what this run already measured.
        if (appStore.get('isTestingLatency')) {
            for (const [name, delay] of _testRunResults) applyNodeLatency(name, delay);
            replayResultsSince(resultMark);
            // The order was computed from older history: sort by these figures again.
            applyLatencySortToDom(false);
        } else if (replayResultsSince(resultMark) && appStore.get('currentSortMode') === 'latency') {
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
    container.dataset.proxyGroup = uiGroupName || '';
    paintFocusedSpeedAction();
    // Re-rendered mid-test: nodes already measured in this run show their result, not a spinner.
    if (appStore.get('isTestingLatency')) {
        for (const [name, delay] of _testRunResults) applyNodeLatency(name, delay);
        replayResultsSince(resultMark);
        applyLatencySortToDom(false);
    } else if (replayResultsSince(resultMark) && appStore.get('currentSortMode') === 'latency') {
        applyLatencySortToDom(false);
    }

    // Sync _activeCard with the actual current node
    const currentWrapper = container.querySelector('[data-selected="1"]');
    _activeCard = currentWrapper ? /** @type {HTMLElement|null} */ (currentWrapper.firstElementChild) : null;
    // The rebuilt cards carry no Tab stop yet: mark the selected node so Tab into the
    // list lands on it (the roving controller adopts it), not on the old index.
    if (currentWrapper instanceof HTMLElement) setItemTabStop(currentWrapper, true);

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

/**
 * Show scoring as the engine has it, in the switches' write queue (a read taken
 * before a switch's save can't undo it), and tell the settings switches.
 * @returns {Promise<boolean>} whether scoring shows on
 */
function syncSmartFromEngine() {
    return queueSmartConfigWrite(async () => {
        const { on, fromEngine } = await syncSmartShown({
            getSmartConfig: smartConfig,
            startAutoTest: () => _autoTest.start(),
            stopAutoTest: () => _autoTest.stop(),
        });
        // The settings switches show what the engine has; a localStorage guess
        // after a failed read is not passed on.
        if (fromEngine) Bus.emit(Events.SMART_ENABLED_SYNCED, { enabled: on });
        return on;
    });
}

/**
 * Sync the --smart-enabled CSS var with backend config. Runs in the switches'
 * write queue, so a read taken before a switch's save can't undo it.
 */
async function syncSmartUiVisibility() {
    const enabled = await syncSmartFromEngine();

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

function clearLatencyResults() {
    _diagnosticConfigRevision++;
    stopProviderPoll();
    abortLatencyTests();
    resetLatencyTestController();
    // Release the invalidated pass before rendering a new list. Its eventual
    // finally can no longer reset controls owned by a newer pass.
    void activeLatencyPass?.finish();
    const container = document.getElementById('proxies-list');
    if (container) {
        container.querySelectorAll('[data-pending="1"]').forEach((entry) => {
            /** @type {HTMLElement} */ (entry).dataset.pending = '0';
        });
        // In-place updates preserve latency markup, so rebuild once after
        // invalidation to remove spinners from the retired generation.
        delete container.dataset.proxyGroup;
    }
    _testRunResults.clear();
    _shownResults.clear();
    document.querySelector('[data-page="proxies"] .latency-result')?.remove();
}

Bus.on(Events.CONFIG_UPDATED, async (/** @type {any} */ data) => {
    if (data?.reloaded || data?.restoreRuntime) {
        clearLatencyResults();
        clearSpeedTestCandidates();
        _renderGeneration += 1;
    }
    // A reload can move a node to another provider under the same name.
    if (data?.reloaded || data?.restoreRuntime) clearProviderCache();
    invalidateRunConfigCache();
    await syncSmartUiVisibility();
    void refreshProxies();
});

Bus.on(Events.CORE_RESTARTED, () => {
    clearLatencyResults();
    clearSpeedTestCandidates();
    _renderGeneration += 1;
    invalidateRunConfigCache();
    invalidateProxiesCache();
    // Do NOT reset uiGroupName here — restoreProxySelection depends on it
    // to restore the correct group after core restart. The resolver will
    // re-validate uiGroupName against the new proxyMap on next render.
    void refreshProxies();
});

Bus.on(Events.DIAGNOSTICS_INVALIDATED, () => {
    clearLatencyResults();
    clearSpeedTestCandidates();
    _renderGeneration += 1;
    invalidateRunConfigCache();
    invalidateProxiesCache();
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
            const [data, settings] = await Promise.all([getProxiesCached().then(getProxiesMerged), getSettingsCached()]);
            const uiGroupName = appStore.get('uiGroupName');
            const effectiveGroupName = appStore.get('effectiveGroupName');
            const observedGroupName = appStore.get('observedGroupName');
            const observedNodeName = appStore.get('observedNodeName');
            renderGroupExplanationBar(uiGroupName, effectiveGroupName, observedGroupName, observedNodeName, data?.proxies, settings?.last_config || 'config.yaml');
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

/** Retry delay for a scheduled pass that found a full test running. */
const AUTO_TEST_BUSY_RETRY_MS = 60_000;
/** Shortest gap between automatic latency passes (each one measures every node). */
const AUTO_TEST_MIN_INTERVAL_SECS = 60;

/**
 * Seconds until the next automatic pass: adaptive between the engine's bounds,
 * by the average score of the nodes just tested.
 * @returns {Promise<number>}
 */
async function nextAutoTestSecs() {
    const config = /** @type {any} */ (await smartConfig().catch(() => null));
    // smart.toml keeps the intervals under [scheduler]. A pass measures every node,
    // so never start one more often than once a minute (the old plugin page saved
    // a 10 s minimum that was never read before).
    const minInterval = Math.max(AUTO_TEST_MIN_INTERVAL_SECS, Number(config?.scheduler?.min_interval_secs ?? config?.min_interval_secs ?? 60) || 60);
    const maxInterval = Math.max(minInterval, Number(config?.scheduler?.max_interval_secs ?? config?.max_interval_secs ?? 600) || 600);
    // Use average score of all tested nodes as network quality
    const ranked = await smartRank().catch(() => []);
    const rankings = Array.isArray(ranked) ? ranked : [];
    const avgScore = rankings.length > 0
        ? rankings.reduce((sum, r) => sum + (r.score || 0), 0) / rankings.length
        : 50;
    return smartNextInterval(avgScore / 100, minInterval, maxInterval).catch(() => maxInterval);
}

/**
 * One node of a scheduled test pass: feeds the score batcher and failover.
 * @param {string} name
 * @param {() => boolean} stopped  the pass was stopped (scoring or scheduled tests turned off)
 * @param {AbortSignal} passSignal  the signal the pass started under
 * @returns {Promise<boolean>} false when the pass was stopped or aborted meanwhile and its result dropped
 */
async function autoTestProbe(name, stopped, passSignal) {
    try {
        // A test of this node started from here on (a single-node retest) is
        // newer than this one: its result, not this one, decides failover.
        // Read, not bumped: the retest's own result must still show.
        const testsBefore = _nodeTestGen.get(name) || 0;
        // testProxy already handles abort internally and returns -1 on cancellation.
        const delay = await testProxy(name);
        const success = delay > 0 && delay < 999999;
        // An aborted test (-1: a manual test or a switch took over) measured
        // nothing: it must not count as a failure against the node. A test
        // that replaced the shared controller without aborting this one
        // (resetLatencyTestController) supersedes the pass just the same.
        if (stopped() || passSignal.aborted || getLatencyTestSignal() !== passSignal) return false;
        if (document.documentElement.style.getPropertyValue('--smart-enabled') === '1') {
            _smartBatcher.push(name, success ? delay : 999999, success);
        }
        // Report to failover engine if enabled
        if (appStore.get('failoverEnabled')) {
            void reportFailover(name, success, passSignal, () => (_nodeTestGen.get(name) || 0) === testsBefore);
        }
    } catch { /* skip individual failures */ }
    return true;
}

const _autoTest = {
    /** @type {number|null} */
    _timer: null,
    _running: false,
    /** Bumped by stop(): a pass already running ends at its next node. */
    _gen: 0,

    /** Check whether auto-test is enabled (setting + smart enabled). */
    _isEnabled() {
        const cssEnabled = document.documentElement.style.getPropertyValue('--smart-enabled');
        return readAutoTestEnabled() && cssEnabled === '1';
    },

    /** Run a single auto-test cycle for all nodes in the current proxy group. */
    async _runOnce() {
        if (!this._isEnabled() || this._running) return;
        // A full test or a download test is running: try again later instead
        // of ending the schedule (probes would share the download's bandwidth).
        if (appStore.get('isTestingLatency') || isSpeedTestBusy() || _retestsInFlight.size > 0) {
            this._scheduleNext(AUTO_TEST_BUSY_RETRY_MS);
            return;
        }
        resetLatencyTestController();  // Reset controller before starting
        // This pass's signal, taken before any await: a manual test that
        // replaces the controller while the groups load supersedes the pass.
        const passSignal = getLatencyTestSignal();
        this._running = true;
        const gen = this._gen;
        const stopped = () => gen !== this._gen;
        try {
            // Pass the user's currently-viewed group (same fix as test button handler)
            const proxyGroupsResult = await fetchProxyGroupsShared({
                preferredGroupName: appStore.get('uiGroupName') || undefined,
            });
            // Nothing to test right now (core not answering, an empty group):
            // keep the schedule, as after an error.
            // A pass stopped meanwhile leaves the schedule to whoever restarted it.
            if (!proxyGroupsResult) {
                if (!stopped()) this._scheduleNext(300_000);
                return;
            }
            const { data, proxies } = proxyGroupsResult;

            const validProxies = proxies.filter((/** @type {string} */ name) => {
                const node = (/** @type {any} */ (data)).proxies[name];
                const type = node?.type?.toLowerCase() || '';
                return type !== 'reject' && type !== 'compatible' && type !== 'pass';
            });
            if (validProxies.length === 0) {
                if (!stopped()) this._scheduleNext(300_000);
                return;
            }

            // Test all nodes concurrently (respecting mihomo's internal concurrency)
            const concurrency = Math.min(12, validProxies.length);
            let idx = 0;
            const workers = Array.from({ length: concurrency }, async () => {
                while (idx < validProxies.length) {
                    // A download test started meanwhile: leave the rest to the next pass.
                    if (passSignal.aborted || getLatencyTestSignal() !== passSignal || stopped() || isSpeedTestBusy()) break;
                    const name = validProxies[idx++];
                    if (!(await autoTestProbe(name, stopped, passSignal))) break;
                }
            });
            await Promise.all(workers);
            if (stopped()) return;

            // Wait for all pending smart score IPC updates before ranking
            if (document.documentElement.style.getPropertyValue('--smart-enabled') === '1') {
                await _smartBatcher.wait();
            }

            // Schedule next cycle using adaptive interval
            const nextSecs = await nextAutoTestSecs();
            // Stopped (and maybe restarted) during the reads above: the timer is not ours to set.
            if (stopped()) return;
            this._scheduleNext(nextSecs * 1000);
        } catch {
            // On error, retry after a longer delay
            if (!stopped()) this._scheduleNext(300_000);
        } finally {
            // A stopped pass leaves the flag to the one that may have started since.
            if (!stopped()) this._running = false;
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
        this._gen++;
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
