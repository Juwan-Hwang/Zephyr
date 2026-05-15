// @ts-check
/**
 * Proxy list rendering, latency testing, sorting, and proxy card management.
 * Extracted from ui.js - the largest extracted module.
 *
 * @module ui/proxies
 */

import { switchProxy, testProxy, abortLatencyTests, closeAllConnections, getConfig, invoke } from '../api.js';
import { proxyLogger } from '../utils/logger.js';
import { escapeHtml } from '../utils/sanitize.js';
import { getDelayColorClass } from '../utils/format.js';
import { buildLatencyPriorityQueue } from '../utils/array.js';
import { debounce } from '../utils/debounce.js';
import { translations, currentLang } from '../i18n.js';
import { showNotification } from './notifications.js';
import { SVG_ICONS } from './icons.js';
import { setup3DEffect } from './3d-effect.js';
import { createRovingTabindex } from '../utils/roving-tabindex.js';
import { COMMANDS } from '@zephyr/shared';
import { getConfigCached, getProxiesCached, getSettingsCached, invalidateProxiesCache } from './cache.js';
import { appStore } from './state.js';
import { smartScore, smartNextInterval, smartSelectBest, smartRank, smartConfig } from './prism.js';
import { fetchProxyGroups as fetchProxyGroupsShared, isWritableGroupType } from './proxy-groups.js';
import { Bus, Events } from './events.js';
import { saveProxySelection } from './proxy-memory.js';
import { invalidateRunConfigCache } from './run-config-cache.js';
import { startObservedGroupWatcher, stopObservedGroupWatcher, resetObservedGroup } from './observed-group.js';

// Re-export switchPage for external consumers that import from this module
export { switchPage } from './navigation.js';

// --- Constants ---

/** Represents "infinite" or "timeout" latency */
export const DELAY_INFINITE = 1000000;

/** Returns true if the given delay value means "not tested" or "timeout". Catches -1 (API failure), 0, and >= 999999. */
function isInvalidDelay(d) { return d == null || d <= 0 || d >= 999999; }

const latencyLoadingIcon = SVG_ICONS.loading;

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

        // Adaptive scheduling: calculate next test interval based on score
        const quality = rounded / 100;
        try {
            await smartNextInterval(quality, 10, 3600);
        } catch { /* ignore scheduling errors */ }

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

/** Backfill smart score badges from backend after render. */
async function backfillSmartScores(container) {
    try {
        // Check smart enabled state directly (CSS var may not be set yet due to async init)
        let smartEnabled = document.documentElement.style.getPropertyValue('--smart-enabled') === '1';
        if (!smartEnabled) {
            try {
                const config = await smartConfig();
                smartEnabled = config.enabled ?? false;
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
            const name = wrapper.dataset.name;
            const score = scoreMap.get(name);
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
            latVal.innerHTML = latencyLoadingIcon;
        }
    });
}

// --- Active Node Styling ---

const ACTIVE_CARD_CLASSES = [
    'bg-white/15', 'border-accent/40', 'shadow-accent/20', 'ring-1', 'ring-accent/30',
];
const INACTIVE_HOVER_CLASS = 'hover:bg-white/5';

/** @type {HTMLElement|null} Cached reference to the currently active card */
let _activeCard = null;

/**
 * Apply active-node styling to a card and remove it from all others in the same container.
 *
 * @param {HTMLElement} card - The card to mark as active
 * @param {HTMLElement} container - The parent container holding all cards
 */
function setActiveNode(card, _container) {
    // Fast path: same card already active
    if (_activeCard === card) return;

    // Remove active styling from previous card only
    if (_activeCard && _activeCard.isConnected) {
        ACTIVE_CARD_CLASSES.forEach(cls => _activeCard.classList.remove(cls));
        _activeCard.classList.add(INACTIVE_HOVER_CLASS);
        const dot = _activeCard.querySelector('.active-dot');
        if (dot) dot.remove();
    }

    // Update wrapper selected state for previous card
    if (_activeCard) {
        const oldWrapper = _activeCard.closest('div[data-name]');
        if (oldWrapper) oldWrapper.dataset.selected = '0';
    }

    // Apply active styling to target card
    ACTIVE_CARD_CLASSES.forEach(cls => card.classList.add(cls));
    card.classList.remove(INACTIVE_HOVER_CLASS);

    if (!card.querySelector('.active-dot')) {
        const activeDot = document.createElement('div');
        activeDot.className = 'active-dot absolute top-2 right-2 w-2.5 h-2.5 bg-accent rounded-full border-2 border-zinc-900 shadow-lg animate-pulse';
        card.appendChild(activeDot);
    }

    // Update new wrapper
    const newWrapper = card.closest('div[data-name]');
    if (newWrapper) newWrapper.dataset.selected = '1';

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
    if (tunToggle && (/** @type {any} */ (config)).tun) {
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
            const proxyMap = proxyGroupsResult.data?.proxies;
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
        }
        const currentNodeEl = document.getElementById('current-node-name');
        if (currentNodeEl) {
            currentNodeEl.textContent = currentNode;
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
                b.classList.add('text-zinc-100');
                b.classList.remove('text-zinc-400');
            } else {
                b.classList.remove('text-zinc-100');
                b.classList.add('text-zinc-400');
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
            statusText.classList.remove('text-zinc-500');
            statusText.classList.add('text-accent');
        } else {
            statusText.textContent = /** @type {any} */ (translations)[currentLang].proxyStatusReady || 'Ready to protect your traffic';
            statusText.classList.remove('text-accent');
            statusText.classList.add('text-zinc-500');
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

                const proxyGroupsResult = await fetchProxyGroupsShared();
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
                            updatedLatVal.className = 'text-xs tabular-nums font-semibold text-zinc-600';
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
                        const activeName = _activeCard?.closest('[data-name]')?.dataset.name;
                        if (name !== activeName) {
                            const container = document.getElementById('proxies-list');
                            const wrapper = container?.querySelector(`[data-name="${CSS.escape(name)}"]`);
                            if (wrapper) {
                                wrapper.remove();
                            }
                        }
                    }
                    queueLatencySort();

                    // Update smart score if enabled
                    if (document.documentElement.style.getPropertyValue('--smart-enabled') === '1') {
                        const success = delay > 0 && delay < 999999;
                        updateSmartScore(name, success ? delay : 999999, success);
                    }
                };

                const priorityQueue = buildLatencyPriorityQueue(data, validProxiesToTest);
                let queueIndex = 0;
                const concurrency = Math.min(12, priorityQueue.length);
                const workers = Array.from({ length: concurrency }, async () => {
                    while (queueIndex < priorityQueue.length) {
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
                if (appStore.get('currentSortMode') === 'smart') {
                    await applySmartSortToDom();
                } else {
                    applyLatencySortToDom(true);
                }
                // Re-render to restore nodes that may need to be visible again after testing
                invalidateProxiesCache();
                if (hideTimeoutEnabled) {
                    await renderProxies();
                }
                icon?.classList.remove('animate-spin', 'text-accent');
                testBtn.classList.remove('opacity-50', 'cursor-not-allowed');
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

                const proxyGroupsResult = await fetchProxyGroupsShared();
                if (!proxyGroupsResult) return;
                const { mainGroup } = proxyGroupsResult;
                const targetGroup = appStore.get('uiGroupName') || mainGroup;
                const success = await switchProxy(targetGroup, best.name);
                if (success) {
                    showNotification(`Switched to best node: ${best.name} (score: ${displayScore})`, 'success');
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

function renderGroupExplanationBar(uiGroupName, effectiveGroupName, observedGroupName, proxyMap) {
    const bar = document.getElementById('group-explanation-bar');
    if (!bar) return;

    const t = /** @type {any} */ (translations)[currentLang];

    // Determine what to show: observedGroup mismatch takes priority over effectiveGroup mismatch
    const showObserved = observedGroupName && observedGroupName !== uiGroupName;
    const showEffective = !showObserved && effectiveGroupName && uiGroupName !== effectiveGroupName;

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
    icon.innerHTML = '&#9888;';

    // Explanation text
    const text = document.createElement('span');
    text.className = 'text-2xs text-zinc-400 flex-1';

    if (showObserved) {
        const template = t.observedGroupMismatch
            || 'Actual traffic uses: {observedGroup} — differs from current group {uiGroup}.';
        text.textContent = template
            .replace(/{observedGroup}/g, () => observedGroupName)
            .replace(/{uiGroup}/g, () => uiGroupName);
    } else {
        const template = t.groupMismatchExplanation
            || 'Current group: {uiGroup} — Rules default to: {effectiveGroup}.';
        text.textContent = template
            .replace(/{uiGroup}/g, () => uiGroupName)
            .replace(/{effectiveGroup}/g, () => effectiveGroupName);
    }

    // Quick-switch button
    const btn = document.createElement('button');
    const targetGroup = showObserved ? observedGroupName : effectiveGroupName;
    const targetType = proxyMap?.[targetGroup]?.type || '';
    const targetIsWritable = isWritableGroupType(targetType);

    if (targetIsWritable) {
        btn.className = 'text-2xs text-accent hover:text-accent/80 underline whitespace-nowrap flex-shrink-0';
        btn.textContent = showObserved
            ? (t.switchToObservedGroup || 'Switch to traffic group')
            : (t.switchToEffectiveGroup || 'Switch to rules default');
        btn.onclick = async () => {
            try {
                appStore.set('uiGroupName', targetGroup);
                invalidateProxiesCache();
                invalidateRunConfigCache();
                await renderProxies();
            } catch (e) {
                proxyLogger.warn('Failed to switch group', e);
            }
        };
    } else {
        btn.className = 'text-2xs text-zinc-600 cursor-not-allowed whitespace-nowrap flex-shrink-0';
        btn.textContent = showObserved
            ? (t.observedGroupNotSwitchable || 'Target group is not switchable')
            : (t.effectiveGroupNotSwitchable || 'Target group is not switchable');
        btn.disabled = true;
    }

    // Dismiss button
    const dismiss = document.createElement('button');
    dismiss.className = 'text-zinc-600 hover:text-zinc-400 ml-2 flex-shrink-0';
    dismiss.innerHTML = '&times;';
    dismiss.title = t.dismiss || 'Dismiss';
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

/**
 * Show loading state in the proxy container.
 * @param {HTMLElement} container
 * @param {string} loadingText
 */
function renderProxiesLoading(container, loadingText) {
    container.innerHTML = '';
    const loading = document.createElement('div');
    loading.className = 'col-span-full text-center py-10 text-zinc-500 flex flex-col items-center gap-4';
    const span = document.createElement('span');
    span.textContent = loadingText;
    const spinner = document.createElement('div');
    spinner.className = 'w-6 h-6 border-2 border-zinc-500 border-t-transparent rounded-full animate-spin';
    loading.appendChild(span);
    loading.appendChild(spinner);
    container.appendChild(loading);
}

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
                    activeDot.className = 'active-dot absolute top-2 right-2 w-2.5 h-2.5 bg-accent rounded-full border-2 border-zinc-900 shadow-lg animate-pulse';
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
        _activeCard = currentWrapper.firstElementChild || null;
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
            placeholder.className = 'p-4 glass-card text-zinc-500 text-sm';
            placeholder.textContent = 'Loading...';
            return placeholder;
        }
        const isSelected = name === virtCurrent;

        let latFromWrapper = null;
        if ((/** @type {HTMLElement} */ (wrapper)).dataset.latency) latFromWrapper = parseInt((/** @type {HTMLElement} */ (wrapper)).dataset.latency, 10);

        const isPending = (/** @type {HTMLElement} */ (wrapper)).dataset.pending === '1';

        const card = document.createElement('div');
        card.dataset.baseOrder = `${index}`;
        card.dataset.selected = isSelected ? '1' : '0';
        // Use h-full to maintain 96px height, use absolute positioning for badge
        card.className = `p-4 glass-card movie-card-base cursor-pointer flex flex-col gap-3 relative transition-all duration-300 group h-full w-full
            ${isSelected ? 'bg-white/15 border-accent/40 shadow-accent/20 ring-1 ring-accent/30' : 'hover:bg-white/5'}`;

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
        const isScrollingEnabled = localStorage.getItem('nodeScroll') === 'true';
        nameContainer.className = `flex-1 text-sm font-semibold text-zinc-100 tracking-tight transition-all duration-300 ${isScrollingEnabled && name.length > 12 ? 'scrolling-text-container' : 'overflow-hidden'}`;

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

        // --- Bottom row: UDP indicator + latency ---
        const bottom = document.createElement('div');
        bottom.className = 'flex items-end justify-between mt-auto pointer-events-none';
        const left = document.createElement('div');
        left.className = 'flex items-center gap-2';
        const dot = document.createElement('div');
        dot.className = `w-1.5 h-1.5 rounded-full shadow-[0_0_8px_rgba(34,197,94,0.4)] ${proxy.udp ? 'bg-green-500' : 'bg-zinc-600'}`;
        const udpText = document.createElement('span');
        udpText.className = 'text-2xs text-zinc-500 font-medium';
        udpText.textContent = 'UDP';
        left.appendChild(dot);
        left.appendChild(udpText);

        const right = document.createElement('div');
        right.className = 'flex flex-col items-end';
        const latLabel = document.createElement('span');
        latLabel.className = 'text-2xs text-zinc-500 font-medium uppercase tracking-wider mb-0.5';
        latLabel.setAttribute('data-latency-label', 'true');
        latLabel.textContent = /** @type {any} */ (translations)[currentLang].latency || 'Latency';

        const latVal = document.createElement('span');
        latVal.id = `latency-${CSS.escape(name)}`;
        if (isPending) {
            latVal.className = 'text-xs tabular-nums font-semibold text-accent/60';
            latVal.innerHTML = latencyLoadingIcon;
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
            activeDot.className = 'active-dot absolute top-2 right-2 w-2.5 h-2.5 bg-accent rounded-full border-2 border-zinc-900 shadow-lg animate-pulse';
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
                latVal.innerHTML = SVG_ICONS.loadingSmall;
            }

            try {
                const success = await switchProxy(mainGroup, name);
                invalidateProxiesCache();

                card.classList.remove('opacity-50', 'pointer-events-none');
                if (latVal) {
                    latVal.innerHTML = originalLatContent;
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
                    const t = translations[appStore.get('currentLang')] || {};
                    showNotification(t.proxySwitchFailed || 'Failed to switch proxy', 'error');
                }
            } catch (err) {
                card.classList.remove('opacity-50', 'pointer-events-none');
                if (latVal) {
                    latVal.innerHTML = originalLatContent;
                }
                showNotification(String(err), 'error');
            }
        };

        return card;
    };

    // Build all wrappers and cards
    proxies.forEach((/** @type {string} */ name, /** @type {number} */ index) => {
        const wrapper = document.createElement('div');
        (/** @type {HTMLElement} */ (wrapper)).style.order = String(index);
        (/** @type {HTMLElement} */ (wrapper)).dataset.baseOrder = `${index}`;
        (/** @type {HTMLElement} */ (wrapper)).dataset.index = String(index);
        wrapper.dataset.name = name;

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

    // Start observed-group watcher when proxies page renders
    startObservedGroupWatcher();

    const t = /** @type {any} */ (translations)[currentLang];

    // Show loading state if empty
    if (container.children.length === 0) {
        renderProxiesLoading(container, t.loadingNodes);
    }

    // Fetch proxies and config in parallel using cached versions
    const [data, config] = await Promise.all([
        getProxiesCached(),
        getConfigCached(),
    ]);

    if (!data || !data.proxies) {
        container.innerHTML = '';
        const err = document.createElement('div');
        err.className = 'col-span-full text-center py-10 text-rose-400 bg-rose-400/5 rounded-2xl border border-rose-400/20';
        err.textContent = t.failedToConnect;
        container.appendChild(err);
        return;
    }

    if (config?.mode?.toLowerCase() === 'direct') {
        container.innerHTML = '';
        const prompt = document.createElement('div');
        prompt.className = 'col-span-full text-center py-20 text-zinc-500 bg-white/5 rounded-3xl border border-white/5 flex flex-col items-center gap-4';
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
        container.innerHTML = '';
        const empty = document.createElement('div');
        empty.className = 'col-span-full text-center py-10 text-zinc-500';
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

    // If no writable group was found, show a clean empty state instead of
    // rendering actionable buttons that would fail on PUT /proxies/{group}
    if (!proxyGroupsResult.uiGroupName) {
        container.innerHTML = '';
        const empty = document.createElement('div');
        empty.className = 'col-span-full text-center py-10 text-zinc-500';
        empty.textContent = t.noGroupsFound || 'No switchable proxy groups found';
        container.appendChild(empty);
        return;
    }

    let proxies = [...proxyGroupsResult.proxies]; // Mutable copy

    // Render the group explanation bar (observed/effective vs ui group mismatch indicator)
    const observedGroupName = appStore.get('observedGroupName');
    renderGroupExplanationBar(uiGroupName, effectiveGroupName, observedGroupName, data?.proxies);

    // Filter out unavailable (timeout) proxies if setting is enabled
    const settings = await getSettingsCached();
    if (settings?.hide_timeout_nodes) {
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
        // Still backfill scores even on in-place updates (badges may not exist yet on first render)
        backfillSmartScores(container);
        return;
    }

    // --- Full render path ---
    const existingObserver = _virtObservers.get(container);
    if (existingObserver) {
        existingObserver.disconnect();
    }

    const fragment = buildProxyWrappers(container, proxies, data, current, uiGroupName);
    container.innerHTML = '';
    container.appendChild(fragment);

    // Sync _activeCard with the actual current node
    const currentWrapper = container.querySelector('[data-selected="1"]');
    _activeCard = currentWrapper ? (currentWrapper.firstElementChild || null) : null;

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
        enabled = config.enabled ?? localStorage.getItem('smartEnabled') === 'true';
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
    } else {
        // Only start if proxies page is visible
        const proxiesPage = document.getElementById('proxies-page');
        if (proxiesPage && !proxiesPage.classList.contains('hidden')) {
            startObservedGroupWatcher();
        }
    }
});

// Also reset on config/core changes
Bus.on(Events.CONFIG_UPDATED, () => { resetObservedGroup(); });
Bus.on(Events.CORE_RESTARTED, () => { resetObservedGroup(); });

// Re-render explanation bar when observedGroupName changes
appStore.subscribe('observedGroupName', () => {
    const proxiesPage = document.getElementById('proxies-page');
    if (proxiesPage && !proxiesPage.classList.contains('hidden')) {
        renderProxies();
    }
});

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
        this._running = true;
        try {
            const proxyGroupsResult = await fetchProxyGroupsShared();
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
                    const name = validProxies[idx++];
                    try {
                        const delay = await testProxy(name);
                        const success = delay > 0 && delay < 999999;
                        if (document.documentElement.style.getPropertyValue('--smart-enabled') === '1') {
                            await updateSmartScore(name, success ? delay : 999999, success);
                        }
                    } catch { /* skip individual failures */ }
                }
            });
            await Promise.all(workers);

            // Schedule next cycle using adaptive interval
            const config = await smartConfig().catch(() => null);
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

    /** Schedule the next auto-test. */
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
