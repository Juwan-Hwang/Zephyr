// @ts-check
/**
 * Proxy list rendering, latency testing, sorting, and proxy card management.
 * Extracted from ui.js - the largest extracted module.
 *
 * @module ui/proxies
 */

import { switchProxy, testProxy, abortLatencyTests, closeAllConnections, getConfig, invoke, getLatencyTestSignal, resetLatencyTestController, restartCore, getProxies, getProxiesMerged, SPECIAL_PROXY_NAMES } from '../api.js';
import { proxyLogger } from '../utils/logger.js';
import { escapeHtml } from '../utils/sanitize.js';
import { getDelayColorClass } from '../utils/format.js';
import { buildLatencyPriorityQueue } from '../utils/array.js';
import { debounce } from '../utils/debounce.js';
import { translations, currentLang, t } from '../i18n.js';
import { showNotification } from './notifications.js';
import { SVG_ICONS } from './icons.js';
import { setup3DEffect } from './3d-effect.js';
import { createRovingTabindex } from '../utils/roving-tabindex.js';
import { COMMANDS } from '@zephyr/shared';
import { getConfigCached, getProxiesCached, getSettingsCached, invalidateProxiesCache } from './cache.js';
import { appStore } from './state.js';
import { smartScore, smartNextInterval, smartSelectBest, smartRank, smartConfig, failoverReport } from './prism.js';
import { fetchProxyGroups as fetchProxyGroupsShared, isWritableGroupType } from './proxy-groups.js';
import { Bus, Events } from './events.js';
import { saveProxySelection, savePrimaryGroupPreference } from './proxy-memory.js';
import { invalidateRunConfigCache } from './run-config-cache.js';
import { postRestartRecovery } from './lifecycle.js';
import { startObservedGroupWatcher, stopObservedGroupWatcher, resetObservedGroup } from './observed-group.js';

// Re-export switchPage for external consumers that import from this module
export { switchPage } from './navigation.js';

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
    'PASS': '-',
    'COMPATIBLE': '-',
    'SELECTOR': '-',
    'URLTEST': '-',
    'LOADBALANCE': '-',
    'FALLBACK': '-',
    'RELAY': '-'
});

// --- State ---

/** @type {number|null} */
let latencySortTimer = null;

/** @type {ReturnType<typeof createRovingTabindex>|null} */
let _rovingInstance = null;

// --- Virtual state (decoupled from DOM) ---

/** Maps container elements to their virtual proxy data (replaces container._virtData) */
const _virtState = new Map();

/** Maps container elements to their MutationObserver (replaces container._virtObserver) */
const _virtObservers = new Map();

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
            const lat = (p && p.history && p.history.length > 0) ? p.history[p.history.length - 1].delay : 0;
            return isInvalidDelay(lat) ? DELAY_INFINITE : lat;
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
            updateSmartScore(item.name, item.latencyMs, item.success).finally(() => {
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

        const latVal = card.querySelector('[id^="latency-"]');
        if (latVal) {
            latVal.className = 'text-xs tabular-nums font-semibold text-accent/60';
            // eslint-disable-next-line no-unsanitized/property -- static SVG constant
            latVal.innerHTML = latencyLoadingIcon; // nosemgrep: js-innerhtml-assignment — verified safe, see eslint-disable above
        }
    });
}

// --- Active Node Styling ---

const ACTIVE_CARD_CLASSES = [
    'bg-white/15', 'border-accent/40', 'shadow-accent/20', 'ring-1', 'ring-accent/30',
];
const INACTIVE_HOVER_CLASS = 'hover:bg-[var(--zephyr-bg-muted)]';

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
        const activeDot = document.createElement('div');
        activeDot.className = 'active-dot absolute top-2 right-2 w-2.5 h-2.5 bg-accent rounded-full border-2 border-[var(--zephyr-bg-elevated)] shadow-lg animate-pulse';
        card.appendChild(activeDot);
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
    const config = await getConfig();
    if (!config) return;

    // Sync Mode
    if ((/** @type {any} */ (config)).mode) {
        updateModeUI((/** @type {any} */ (config)).mode);
    }

    // Sync TUN
    const tunToggle = document.getElementById('tun-proxy-toggle');
    if (tunToggle instanceof HTMLInputElement && (/** @type {any} */ (config)).tun) {
        const tunEnable = (/** @type {any} */ (config)).tun.enable;
        appStore.set('isTunEnabled', tunEnable);
        tunToggle.checked = tunEnable;
        const statusText = document.getElementById('tun-status-text');
        if (statusText) {
            const t = /** @type {any} */ (translations)[currentLang];
            statusText.textContent = tunEnable ? t.proxyActive : (t.proxyInactive || 'Virtual Adapter');
        }
        // updateTrayStatus is handled by the main ui.js module
        try {
            const { updateTrayStatus } = await import('./tray.js');
            updateTrayStatus();
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
        slider.style.transform = `translateX(${idx * 100}%)`;
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

        testBtn.onclick = async () => {
            if (appStore.get('isTestingLatency')) return;
            resetLatencyTestController();  // Reset controller before starting
            appStore.set('isTestingLatency', true);
            appStore.set('latencyTestStartTime', Date.now());

            const icon = document.getElementById('test-icon');
            const _t = /** @type {any} */ (translations)[currentLang];

            icon?.classList.add('animate-spin', 'text-accent');
            testBtn.classList.add('opacity-50', 'cursor-not-allowed');

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
                const { data, mainGroup: _mainGroup, proxies, current: _currentNode } = proxyGroupsResult;
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
                    const delay = await testProxy(name);

                    // Update wrapper dataset
                    const container = document.getElementById('proxies-list');
                    if (container) {
                        const wrapper = container.querySelector(`[data-name="${CSS.escape(name)}"]`);
                        if (wrapper) {
                            (/** @type {HTMLElement} */ (wrapper)).dataset.latency = String(delay > 0 ? delay : DELAY_INFINITE);
                            setProxyPendingState(/** @type {HTMLElement} */ (wrapper.firstElementChild), false);
                        }
                    }

                    // Update latency display
                    const updatedLatVal = document.getElementById(`latency-${CSS.escape(name)}`);
                    if (updatedLatVal) {
                        const card = updatedLatVal.closest('.glass-card');
                        if (delay > 0) {
                            updatedLatVal.textContent = `${delay}ms`;
                            updatedLatVal.className = `text-xs tabular-nums font-semibold ${getDelayColorClass(delay)}`;
                            if (card) {
                                (/** @type {HTMLElement} */ (card)).dataset.latency = String(delay);
                                setProxyPendingState(/** @type {HTMLElement} */ (card), false);
                            }
                        } else {
                            updatedLatVal.textContent = /** @type {any} */ (translations)[currentLang].timeout || 'Timeout';
                            updatedLatVal.className = 'text-xs tabular-nums font-semibold text-[var(--text-tertiary)]';
                            if (card) {
                                (/** @type {HTMLElement} */ (card)).dataset.latency = String(DELAY_INFINITE);
                                setProxyPendingState(/** @type {HTMLElement} */ (card), false);
                            }
                        }
                    }

                    // Hide timeout nodes immediately if setting is enabled
                    if (hideTimeoutEnabled && isInvalidDelay(delay)) {
                        // Don't hide if this is the currently active node
                        // Use _activeCard to get real-time active node (prevents mis-hiding during node switch)
                        const activeWrapper = _activeCard?.closest('[data-name]');
                        const activeName = activeWrapper instanceof HTMLElement ? activeWrapper.dataset.name : undefined;
                        if (name !== activeName) {
                            const container = document.getElementById('proxies-list');
                            const wrapper = container?.querySelector(`[data-name="${CSS.escape(name)}"]`);
                            if (wrapper) {
                                wrapper.remove();
                            }
                        }
                    }
                    queueLatencySort();

                    // Update smart score via concurrency-limited batcher (max 2 IPC calls)
                    if (document.documentElement.style.getPropertyValue('--smart-enabled') === '1') {
                        const success = delay > 0 && delay < 999999;
                        _smartBatcher.push(name, success ? delay : 999999, success);
                    }

                    // Report to failover engine if enabled
                    if (appStore.get('failoverEnabled') && !getLatencyTestSignal().aborted) {
                        const failoverSuccess = delay > 0 && delay < 999999;
                        reportFailover(name, failoverSuccess);
                    }
                };

                const priorityQueue = buildLatencyPriorityQueue(data, validProxiesToTest);
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
                icon?.classList.remove('animate-spin', 'text-accent');
                testBtn.classList.remove('opacity-50', 'cursor-not-allowed');
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
        sortBtn.onclick = async () => {
            const smartEnabled = document.documentElement.style.getPropertyValue('--smart-enabled') === '1';
            const modes = smartEnabled
                ? ['default', 'name', 'latency', 'smart']
                : ['default', 'name', 'latency'];
            const currentMode = appStore.get('currentSortMode');
            // If current mode is 'smart' but smart is now disabled, reset to default
            if (!smartEnabled && currentMode === 'smart') {
                appStore.set('currentSortMode', 'default');
            }
            const idx = (modes.indexOf(appStore.get('currentSortMode')) + 1) % modes.length;
            appStore.set('currentSortMode', modes[idx]);

            const t = /** @type {any} */ (translations)[currentLang];
            const labels = { default: t.sortDefault, name: t.sortName, latency: t.sortLatency, smart: t.sortSmart };
            if (sortLabel) sortLabel.textContent = (/** @type {any} */ (labels))[appStore.get('currentSortMode')];
            renderProxies();
            if (appStore.get('currentSortMode') === 'smart') {
                await applySmartSortToDom();
            }
        };
    }

    // Smart Select Best: one-click switch to the best-scoring node
    const selectBestBtn = document.getElementById('select-best-btn');
    if (selectBestBtn) {
        syncSmartUiVisibility();
        selectBestBtn.onclick = async () => {
            try {
                const best = await smartSelectBest();
                if (!best || !best.name) {
                    showNotification(
                        /** @type {any} */ (translations)[currentLang].noProxiesToTest || 'No proxy history available',
                        'info'
                    );
                    return;
                }

                // Use smartRank to get the canonical score (same source as badge display)
                let displayScore = Math.round(best.score);
                try {
                    const rankings = await smartRank();
                    const match = rankings?.find((r) => r.name === best.name);
                    if (match) displayScore = Math.round(match.score);
                } catch { /* fallback to selectBest score */ }

                const proxyGroupsResult = await fetchProxyGroupsShared({
                    preferredGroupName: appStore.get('uiGroupName') || undefined,
                });
                if (!proxyGroupsResult) return;
                const { uiGroupName: targetGroup } = proxyGroupsResult;
                if (!targetGroup) return;
                const success = await switchProxy(targetGroup, best.name);
                if (success) {
                    showNotification(t('notifSwitchedBest', { name: best.name, score: displayScore }), 'success');
                    await syncCoreConfig();
                    await renderProxies();
                }
            } catch (err) {
                proxyLogger.error('Smart select best failed', err);
            }
        };
    }

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
            (async () => {
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
            (async () => {
                try {
                    await closeAllConnections();
                    invalidateProxiesCache();
                    await syncCoreConfig();
                    await renderProxies();
                } catch { /* ignore post-failover errors */ }
            })();
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
function resolveLeafNode(name, proxyMap, visited = new Set()) {
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

/** @param {string} uiGroupName @param {string|null} effectiveGroupName @param {string|null} observedGroupName @param {string|null} observedNodeName @param {Record<string, any>} proxyMap */
function renderGroupExplanationBar(uiGroupName, effectiveGroupName, observedGroupName, observedNodeName, proxyMap) {
    const bar = document.getElementById('group-explanation-bar');
    if (!bar) return;

    // Get the currently selected node in the UI group, resolving nested groups
    const uiSelectedNode = resolveLeafNode(uiGroupName, proxyMap);

    // Check if node names match (user's main concern)
    // If observed node matches UI selected node, don't show mismatch even if group names differ
    const nodeMatch = observedNodeName && uiSelectedNode && observedNodeName === uiSelectedNode;

    // Determine what to show: observedGroup mismatch takes priority over effectiveGroup mismatch
    // But skip if node names match (the actual traffic goes to the same node user selected)
    const showObserved = observedGroupName && observedGroupName !== uiGroupName && !nodeMatch;
    const showEffective = !showObserved && effectiveGroupName && uiGroupName !== effectiveGroupName && !nodeMatch;

    if (!showObserved && !showEffective) {
        bar.classList.add('hidden');
        bar.classList.remove('flex');
        _dismissedMismatchKey = null;
        return;
    }

    // Build a key for this specific mismatch
    const mismatchKey = showObserved
        ? `observed:${uiGroupName}|${observedGroupName}`
        : `${uiGroupName}|${effectiveGroupName}`;

    if (_dismissedMismatchKey === mismatchKey) {
        return;
    }

    bar.classList.remove('hidden');
    bar.classList.add('flex');
    bar.replaceChildren();

    // Info icon
    const icon = document.createElement('span');
    icon.className = 'text-amber-400 text-sm flex-shrink-0';
     
    icon.textContent = '\u26A0';

    // Explanation text — use t() for fallback chain support
    const text = document.createElement('span');
    text.className = 'text-2xs text-[var(--text-secondary)] flex-1';

    if (showObserved) {
        text.textContent = t('observedGroupMismatch', { observedGroup: observedGroupName, uiGroup: uiGroupName });
    } else {
        text.textContent = t('groupMismatchExplanation', { uiGroup: uiGroupName, effectiveGroup: effectiveGroupName });
    }

    // Quick-switch button
    const btn = document.createElement('button');
    const targetGroup = (showObserved ? observedGroupName : effectiveGroupName) || '';
    const targetType = proxyMap?.[targetGroup]?.type || '';
    const targetIsWritable = isWritableGroupType(targetType);

    if (targetIsWritable) {
        btn.className = 'text-2xs text-accent hover:text-accent/80 underline whitespace-nowrap flex-shrink-0';
        btn.textContent = showObserved
            ? t('switchToObservedGroup')
            : t('switchToEffectiveGroup');
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
        btn.className = 'text-2xs text-[var(--text-tertiary)] cursor-not-allowed whitespace-nowrap flex-shrink-0';
        btn.textContent = showObserved
            ? t('observedGroupNotSwitchable')
            : t('effectiveGroupNotSwitchable');
        btn.disabled = true;
    }

    // Dismiss button
    const dismiss = document.createElement('button');
    dismiss.className = 'text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] ml-2 flex-shrink-0';
     
    dismiss.textContent = '\u00D7';
    dismiss.title = t('dismiss');
    dismiss.onclick = () => {
        _dismissedMismatchKey = mismatchKey;
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
function renderGroupSelector(groups, currentGroup) {
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
        _groupMenuElement.className = 'hidden fixed bg-[var(--zephyr-bg-elevated)] border border-[var(--zephyr-border-default)] rounded-lg shadow-2xl';
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
        btn.className = 'proxy-group-option w-full text-left px-3 py-2 rounded-[var(--radius-dropdown-option)] text-xs text-[var(--text-secondary)] hover:bg-[var(--zephyr-bg-muted)] transition-colors';
        if (groupName === currentGroup) {
            btn.classList.add('active');
        }
        btn.textContent = groupName;
        // Attach hover highlight directly during creation
        btn.addEventListener('mouseenter', () => {
            menuScroll.querySelectorAll('.proxy-group-option').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
        });
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
                b.classList.toggle('active', b.textContent === current);
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
                menu.style.left = (rect.left / uiScale) + 'px';
                menu.style.top = ((rect.bottom + 6) / uiScale) + 'px';
                menu.style.width = (Math.max(rect.width, 160) / uiScale) + 'px';
                menu.classList.remove('hidden');
                trigger.querySelector('.dropdown-arrow')?.classList.add('rotate-180');
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
 * @returns {HTMLButtonElement}
 */
function createAccentButton(text, onClick, id) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = ACCENT_BTN_CLASS;
    btn.style.cssText = ACCENT_BTN_CSS;
    btn.textContent = text;
    if (id) btn.id = id;
    btn.addEventListener('click', () => onClick(btn));
    return btn;
}

/**
 * Handle core restart from a button element.
 * @param {HTMLButtonElement} btn - The button that triggered the restart
 * @param {any} tObj - i18n translations object
 * @param {string} context - Logging context (e.g. 'loading state', 'error state')
 */
async function handleCoreRestart(btn, tObj, context) {
    btn.disabled = true;
    btn.textContent = tObj.restartingCore || 'Restarting...';
    try {
        const settings = await getSettingsCached();
        const configPath = settings?.last_config || 'config.yaml';
        const customArgs = settings?.custom_args || [];
        await restartCore(configPath, customArgs);
        await postRestartRecovery(configPath);
        showNotification(tObj.coreRestarted || 'Core restarted', 'success');
    } catch (err) {
        proxyLogger.error(`Failed to restart core from ${context}`, err);
        showNotification(String(err), 'error');
        btn.disabled = false;
        btn.textContent = tObj.restartCore || 'Restart Core';
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
    span.textContent = loadingText;
    const spinner = document.createElement('div');
    spinner.className = 'w-6 h-6 border-2 border-[var(--zephyr-border-default)] border-t-transparent rounded-full animate-spin';
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
            (b) => handleCoreRestart(b, tObj, 'loading state'),
            'restart-core-btn'
        );
        btn.className = 'mt-2 ' + ACCENT_BTN_CLASS;
        existing.appendChild(btn);
    }, 2500);
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
    msg.textContent = tObj.providerPollExhausted || 'No nodes available from provider yet. The provider may still be downloading or failed to load.';
    wrap.appendChild(msg);
    const retryBtn = createAccentButton(
        tObj.retry || 'Retry',
        () => {
            _providerPollExhaustedGroup = undefined;
            renderProxies().catch(() => {});
        }
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
        renderProxies().catch(() => {});
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
            if (result && !result.providerLoading && !_hasMissingDetails) {
                // Nodes have arrived — invalidate cache + re-render
                invalidateProxiesCache();
                renderProxies().catch(() => {});
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
            (/** @type {HTMLElement} */ (wrapper)).dataset.latency = String(isInvalidDelay(lastDelay) ? DELAY_INFINITE : lastDelay);
            (/** @type {HTMLElement} */ (wrapper)).dataset.estimate = (/** @type {HTMLElement} */ (wrapper)).dataset.latency;
        }

        const card = wrapper.firstElementChild;
        if (card) {
            (/** @type {HTMLElement} */ (card)).dataset.baseOrder = `${index}`;
            (/** @type {HTMLElement} */ (card)).dataset.selected = isSelected ? '1' : '0';

            const delayColor = getDelayColorClass(lastDelay);
            const latVal = card.querySelector('[id^="latency-"]');
            if (latVal && wrapper.dataset.pending !== '1') {
                latVal.className = `text-xs tabular-nums font-semibold ${delayColor}`;
                latVal.textContent = !isInvalidDelay(lastDelay) ? `${lastDelay}ms` : (lastDelay === null ? '--' : (/** @type {any} */ (translations)[currentLang].timeout || 'Timeout'));
            }

            if (isSelected) {
                ACTIVE_CARD_CLASSES.forEach(cls => card.classList.add(cls));
                card.classList.remove(INACTIVE_HOVER_CLASS);
                if (!card.querySelector('.active-dot')) {
                    const activeDot = document.createElement('div');
                    activeDot.className = 'active-dot absolute top-2 right-2 w-2.5 h-2.5 bg-accent rounded-full border-2 border-[var(--zephyr-bg-elevated)] shadow-lg animate-pulse';
                    card.appendChild(activeDot);
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
        const { proxies: virtProxies, data: virtData, current: virtCurrent, isTestingLatency: _isTestingLatency, mainGroup: _virtMainGroup, nodeScroll: isScrollingEnabled } = /** @type {any} */ (_virtState.get(container));
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
        const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

        let latFromWrapper = null;
        if ((/** @type {HTMLElement} */ (wrapper)).dataset.latency) latFromWrapper = parseInt((/** @type {HTMLElement} */ (wrapper)).dataset.latency, 10);

        const isPending = (/** @type {HTMLElement} */ (wrapper)).dataset.pending === '1';

        const card = document.createElement('div');
        card.dataset.baseOrder = `${index}`;
        card.dataset.selected = isSelected ? '1' : '0';
        // Use h-full to maintain 96px height, use absolute positioning for badge
        card.className = `p-4 glass-card movie-card-base cursor-pointer flex flex-col gap-3 relative transition-[color,border-color,box-shadow] duration-[var(--zephyr-time-standard)] group h-full w-full
            ${isSelected ? 'bg-white/15 border-accent/40 shadow-accent/20 ring-1 ring-accent/30' : 'hover:bg-[var(--zephyr-bg-muted)]'}`;

        let lastDelay = (proxy.history && proxy.history.length > 0) ? proxy.history[proxy.history.length - 1].delay : null;
        // Only use latFromWrapper if proxy has no history AND latFromWrapper is valid (not DELAY_INFINITE)
        if (lastDelay === null && latFromWrapper !== null && latFromWrapper !== DELAY_INFINITE) {
            lastDelay = latFromWrapper;
        }

        const delayColor = getDelayColorClass(lastDelay);

        (/** @type {HTMLElement} */ (card)).dataset.latency = String(isInvalidDelay(lastDelay) ? DELAY_INFINITE : lastDelay);
        (/** @type {HTMLElement} */ (card)).dataset.estimate = (/** @type {HTMLElement} */ (card)).dataset.latency;

        // --- Top row: name + type badge ---
        const top = document.createElement('div');
        top.className = 'flex items-center justify-between pointer-events-none w-full gap-2';

        const nameContainer = document.createElement('div');
        const isScrolling = isScrollingEnabled && name.length > 12;
        nameContainer.className = `flex-1 text-sm font-semibold text-[var(--text-primary)] tracking-tight transition-colors duration-[var(--zephyr-time-standard)] ${isScrolling ? 'scrolling-text-container pointer-events-auto' : 'overflow-hidden'}`;
        if (isScrolling && prefersReducedMotion) {
            nameContainer.setAttribute('tabindex', '0');
            nameContainer.setAttribute('role', 'region');
            nameContainer.setAttribute('aria-label', name);
        }

        const nameSpan = document.createElement('span');
        if (isScrollingEnabled && name.length > 12) {
            nameSpan.classList.add('scrolling-text');
        } else {
            nameSpan.classList.add('truncate', 'block');
        }
        nameSpan.textContent = name;
        nameContainer.appendChild(nameSpan);

        const typeSpan = document.createElement('span');
        typeSpan.className = 'type-badge';
        typeSpan.textContent = proxy.type;

        top.appendChild(nameContainer);
        top.appendChild(typeSpan);

        // --- Bottom row: Transport protocol indicator + latency ---
        const transport = TRANSPORT_MAP[(proxy.type || '').toUpperCase()] || 'TCP';

        const bottom = document.createElement('div');
        bottom.className = 'flex items-end justify-between mt-auto pointer-events-none';
        const left = document.createElement('div');
        left.className = 'flex items-center gap-2';
        const dot = document.createElement('div');
        // All indicators use green color as requested
        const dotColor = 'bg-green-500';
        dot.className = `w-1.5 h-1.5 rounded-full ${dotColor}`;
dot.style.boxShadow = "0 0 8px color-mix(in srgb, var(--zephyr-color-success) 40%, transparent)";
        const transportText = document.createElement('span');
        transportText.className = 'text-2xs text-[var(--text-muted)] font-medium';
        transportText.textContent = transport;
        left.appendChild(dot);
        left.appendChild(transportText);

        const right = document.createElement('div');
        right.className = 'flex flex-col items-end';
        const latLabel = document.createElement('span');
        latLabel.className = 'text-2xs text-[var(--text-muted)] font-medium uppercase tracking-wider mb-0.5';
        latLabel.setAttribute('data-latency-label', 'true');
        latLabel.textContent = /** @type {any} */ (translations)[currentLang].latency || 'Latency';

        const latVal = document.createElement('span');
        latVal.id = `latency-${CSS.escape(name)}`;
        if (isPending) {
            latVal.className = 'text-xs tabular-nums font-semibold text-accent/60';
            // eslint-disable-next-line no-unsanitized/property -- static SVG constant
            latVal.innerHTML = latencyLoadingIcon; // nosemgrep: js-innerhtml-assignment — verified safe, see eslint-disable above
            (/** @type {HTMLElement} */ (card)).dataset.latency = String(DELAY_INFINITE);
        } else {
            latVal.className = `text-xs tabular-nums font-semibold ${delayColor}`;
            latVal.textContent = !isInvalidDelay(lastDelay) ? `${lastDelay}ms` : (lastDelay === null ? '--' : (/** @type {any} */ (translations)[currentLang].timeout || 'Timeout'));
        }
        right.appendChild(latLabel);
        right.appendChild(latVal);

        bottom.appendChild(left);
        bottom.appendChild(right);

        if (isSelected) {
            const activeDot = document.createElement('div');
            activeDot.className = 'active-dot absolute top-2 right-2 w-2.5 h-2.5 bg-accent rounded-full border-2 border-[var(--zephyr-bg-elevated)] shadow-lg animate-pulse';
            card.appendChild(activeDot);
        }

        card.appendChild(top);

        // Smart score badge (between title and UDP rows, only visible when smart mode is enabled)
        // Use absolute positioning with fixed pixel value for consistent cross-system placement
        const scoreBadge = document.createElement('div');
        scoreBadge.className = 'score-badge absolute left-4 top-[40px] text-center text-2xs tabular-nums font-bold';
        scoreBadge.setAttribute('data-score-badge', 'true');
        scoreBadge.textContent = '--';
        card.appendChild(scoreBadge);

        card.appendChild(bottom);

        // --- Click handler: switch proxy ---
        card.onclick = async () => {
            abortLatencyTests();

            card.classList.add('opacity-50', 'pointer-events-none');
            const originalLatContent = latVal ? latVal.innerHTML : '';
            if (latVal) {
                // eslint-disable-next-line no-unsanitized/property -- static SVG constant
                latVal.innerHTML = SVG_ICONS.loadingSmall; // nosemgrep: js-innerhtml-assignment — verified safe, see eslint-disable above
            }

            try {
                const success = await switchProxy(mainGroup, name);
                invalidateProxiesCache();

                card.classList.remove('opacity-50', 'pointer-events-none');
                if (latVal) {
                    // eslint-disable-next-line no-unsanitized/property -- restoring saved innerHTML (same DOM element)
                    latVal.innerHTML = originalLatContent; // nosemgrep: js-innerhtml-assignment — verified safe, see eslint-disable above
                }

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

                    closeAllConnections().then(() => {
                        syncCoreConfig();
                    });
                } else {
                    const t = /** @type {any} */ (translations)[appStore.get('currentLang')] || {};
                    showNotification(t.proxySwitchFailed || 'Failed to switch proxy', 'error');
                }
            } catch (err) {
                card.classList.remove('opacity-50', 'pointer-events-none');
                if (latVal) {
                    // eslint-disable-next-line no-unsanitized/property -- restoring saved innerHTML (same DOM element)
                    latVal.innerHTML = originalLatContent; // nosemgrep: js-innerhtml-assignment — verified safe, see eslint-disable above
                }
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
        (/** @type {HTMLElement} */ (wrapper)).dataset.latency = String(isInvalidDelay(lastDelay) ? DELAY_INFINITE : lastDelay);
        (/** @type {HTMLElement} */ (wrapper)).dataset.estimate = (/** @type {HTMLElement} */ (wrapper)).dataset.latency;

        wrapper.style.height = 'auto';
        wrapper.className = 'w-full proxy-wrapper';
        wrapper.style.minHeight = '96px';

        const card = createCard(wrapper);
        setProxyPendingState(card, appStore.get('isTestingLatency'));
        wrapper.appendChild(card);
        setup3DEffect(card);

        fragment.appendChild(wrapper);
    });

    return fragment;
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

    const t = /** @type {any} */ (translations)[currentLang];

    // Show loading state if empty
    if (container.children.length === 0) {
        renderProxiesLoading(container, t.loadingNodes);
    }

    // Fetch proxies (merged with provider data) and config in parallel
    const [data, config] = await Promise.all([
        getProxiesCached().then(getProxiesMerged),
        getConfigCached(),
    ]);

    // Guard: if a newer render started while fetching, abort — the newer render takes precedence.
    if (_renderGen !== _renderGeneration) return;

    // Clear loading timeout — data fetch completed (success or failure)
    clearLoadingTimeout();

    if (!data || !data.proxies) {
        container.replaceChildren();
        const errWrap = document.createElement('div');
        errWrap.className = 'col-span-full text-center py-10 text-rose-400 bg-rose-400/5 rounded-lg border border-rose-400/20 flex flex-col items-center gap-4';
        const errText = document.createElement('span');
        errText.textContent = t.failedToConnect;
        errWrap.appendChild(errText);
        // Add restart core button on connection failure
        const restartBtn = createAccentButton(
            t.restartCore || 'Restart Core',
            (b) => handleCoreRestart(b, t, 'error state')
        );
        errWrap.appendChild(restartBtn);
        container.appendChild(errWrap);
        return;
    }

    if (config?.mode?.toLowerCase() === 'direct') {
        container.replaceChildren();
        const prompt = document.createElement('div');
        prompt.className = 'col-span-full text-center py-20 text-[var(--text-muted)] bg-[var(--zephyr-bg-muted)] rounded-lg border border-[var(--zephyr-border-subtle)] flex flex-col items-center gap-4';
        // eslint-disable-next-line no-unsanitized/property -- values escaped via escapeHtml() // nosemgrep: js-innerhtml-assignment — verified safe, see eslint-disable above
        prompt.innerHTML = `
            ${SVG_ICONS.externalLink}
            <span class="text-sm font-light tracking-wider uppercase opacity-60">${escapeHtml(t.directModePrompt)}</span>
        `;
        container.appendChild(prompt);
        return;
    }

    // Use the user's explicit group selection or fall back to the resolver
    const preferredGroupName = appStore.get('uiGroupName') || null;

    const proxyGroupsResult = await fetchProxyGroupsShared({
        existingData: data,
        existingConfig: config,
        preferredGroupName,
    });
    if (!proxyGroupsResult) {
 
    container.replaceChildren();
    const empty = document.createElement('div');
    empty.className = 'col-span-full text-center py-10 text-[var(--text-muted)]';
    empty.textContent = t.noGroupsFound;
        container.appendChild(empty);
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
    renderGroupSelector(proxyGroupsResult.groups || [], uiGroupName || '');

    // If no writable group was found, show a clean empty state instead of
    // rendering actionable buttons that would fail on PUT /proxies/{group}
    if (!proxyGroupsResult.uiGroupName) {
 
    container.replaceChildren();
    const empty = document.createElement('div');
    empty.className = 'col-span-full text-center py-10 text-[var(--text-muted)]';
    empty.textContent = t.noGroupsFound || 'No switchable proxy groups found';
        container.appendChild(empty);
        return;
    }

    let proxies = [...proxyGroupsResult.proxies]; // Mutable copy

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
    renderGroupExplanationBar(uiGroupName || '', effectiveGroupName, observedGroupName, observedNodeName, /** @type {Record<string, any>} */ (data?.proxies));

    // Filter out unavailable (timeout) proxies if setting is enabled
    const settings = await getSettingsCached();
    if (settings?.hide_timeout_nodes) {
        const preFilterCount = proxies.length;
        proxies = proxies.filter((/** @type {string} */ name) => {
            // Always keep the currently active node, even if it's timed out
            if (name === current) return true;
            const proxy = (/** @type {any} */ (data)).proxies[name];
            // Keep proxy if no history (not tested yet) or last delay is valid
            if (!proxy?.history || proxy.history.length === 0) {
                return true;
            }
            const lastDelay = proxy.history[proxy.history.length - 1].delay;
            // Use helper to catch all timeout/invalid states (0, 999999, etc.)
            return !isInvalidDelay(lastDelay);
        });
        // Safety valve: if hide_timeout_nodes filtered out EVERY node, keep the
        // original unfiltered list so the user can still see and interact with
        // nodes (rather than facing a confusing blank page).
        if (proxies.length === 0 && preFilterCount > 0) {
            proxies = [...proxyGroupsResult.proxies];
        }
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
    _virtState.set(container, { proxies, data, current, isTestingLatency: appStore.get('isTestingLatency'), mainGroup: uiGroupName, nodeScroll: !!settings?.node_scroll });

    // --- In-place update path ---
    if (await updateProxiesInPlace(container, proxies, data, current)) {
        // Still backfill scores even on in-place updates (badges may not exist yet on first render)
        backfillSmartScores(container);
        return;
    }

    // --- Full render path ---
    const existingObserver = _virtObservers.get(container);
    if (existingObserver) {
        existingObserver.disconnect();
    }

    const fragment = buildProxyWrappers(container, proxies, data, current, uiGroupName || '');
     
    container.replaceChildren();
    container.appendChild(fragment);

    // Sync _activeCard with the actual current node
    const currentWrapper = container.querySelector('[data-selected="1"]');
    _activeCard = currentWrapper ? /** @type {HTMLElement|null} */ (currentWrapper.firstElementChild) : null;

    // Backfill existing smart scores from backend (avoids showing '--' when scores exist)
    await backfillSmartScores(container);

    // Apply smart sort on initial render if mode is 'smart' (e.g. restored from localStorage)
    if (appStore.get('currentSortMode') === 'smart') {
        await applySmartSortToDom();
    }
}

// --- Smart UI visibility sync ---

/** Sync Best button visibility and --smart-enabled CSS var with backend config. */
async function syncSmartUiVisibility() {
    const selectBestBtn = document.getElementById('select-best-btn');
    if (!selectBestBtn) return;

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
    selectBestBtn.style.display = enabled ? '' : 'none';

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
    renderProxies();
});

Bus.on(Events.CORE_RESTARTED, () => {
    invalidateRunConfigCache();
    // Do NOT reset uiGroupName here — restoreProxySelection depends on it
    // to restore the correct group after core restart. The resolver will
    // re-validate uiGroupName against the new proxyMap on next render.
    renderProxies();
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
            renderProxies().catch(() => {});
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
            const data = await getProxiesCached();
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

    getProxiesCached().then(data => {
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
                            reportFailover(name, success);
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
