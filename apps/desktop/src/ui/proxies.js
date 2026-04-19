// @ts-check
/**
 * Proxy list rendering, latency testing, sorting, and proxy card management.
 * Extracted from ui.js - the largest extracted module.
 *
 * @module ui/proxies
 */

import { getProxies, switchProxy, testProxy, abortLatencyTests, closeAllConnections, getConfig, invoke } from '../api.js';
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
import { getConfigCached, getProxiesCached, invalidateProxiesCache } from './cache.js';
import { appStore } from './state.js';

// Re-export switchPage for external consumers that import from this module
export { switchPage } from './navigation.js';

// --- Constants ---

/** Represents "infinite" or "timeout" latency */
export const DELAY_INFINITE = 1000000;

const latencyLoadingIcon = SVG_ICONS.loading;

// --- State ---

/** @type {number|null} */
let latencySortTimer = null;

/** @type {ReturnType<typeof createRovingTabindex>|null} */
let _rovingInstance = null;

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
            return (lat === 0 || lat >= 999999) ? DELAY_INFINITE : lat;
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

/**
 * Apply active-node styling to a card and remove it from all others in the same container.
 *
 * @param {HTMLElement} card - The card to mark as active
 * @param {HTMLElement} container - The parent container holding all cards
 */
function setActiveNode(card, container) {
    // Remove active styling from all cards
    container.querySelectorAll('.glass-card').forEach(c => {
        ACTIVE_CARD_CLASSES.forEach(cls => c.classList.remove(cls));
        c.classList.add(INACTIVE_HOVER_CLASS);
        const dot = c.querySelector('.active-dot');
        if (dot) dot.remove();
    });

    // Update wrapper selected state
    container.querySelectorAll('div[data-name]').forEach(w => {
        (/** @type {HTMLElement} */ (w)).dataset.selected = '0';
    });

    // Apply active styling to target card
    ACTIVE_CARD_CLASSES.forEach(cls => card.classList.add(cls));
    card.classList.remove(INACTIVE_HOVER_CLASS);

    if (!card.querySelector('.active-dot')) {
        const activeDot = document.createElement('div');
        activeDot.className = 'active-dot absolute top-2 right-2 w-2.5 h-2.5 bg-accent rounded-full border-2 border-zinc-900 shadow-lg animate-pulse';
        card.appendChild(activeDot);
    }
}

// --- Proxy Groups Fetch ---

/**
 * Fetch proxy groups data and determine the main group based on config mode.
 *
 * @param {Object} [options={}] - Optional configuration
 * @param {Object} [options.existingData] - Pre-fetched proxies data to avoid duplicate API calls
 * @param {Object} [options.existingConfig] - Pre-fetched config to avoid duplicate API calls
 * @returns {Promise<Object|null>} Proxy groups result or null on failure
 */
async function fetchProxyGroups(options = {}) {
    const data = options.existingData || await getProxies();
    if (!data || !(/** @type {any} */ (data)).proxies) return null;

    const config = options.existingConfig || await getConfig();

    const groups = Object.keys((/** @type {any} */ (data)).proxies).filter((/** @type {string} */ name) => {
        const type = (/** @type {any} */ (data)).proxies[name].type?.toLowerCase() || '';
        return type === 'selector' || type === 'select';
    });

    let mainGroup = 'GLOBAL';
    const mode = (/** @type {any} */ (config))?.mode?.toLowerCase();

    if (mode === 'direct') {
        mainGroup = 'DIRECT';
    } else if (mode !== 'global') {
        mainGroup = groups.find(g => g.toLowerCase().includes('proxy')) || groups[0];
    }

    if (!(/** @type {any} */ (data)).proxies[mainGroup]) {
        mainGroup = groups.find((/** @type {string} */ g) => g.toLowerCase().includes('proxy')) || groups[0];
    }
    if (!(/** @type {any} */ (data)).proxies[mainGroup]) {
        mainGroup = groups[0];
    }
    if (!mainGroup || !(/** @type {any} */ (data)).proxies[mainGroup]) return null;

    const proxies = (/** @type {any} */ (data)).proxies[mainGroup]?.all || [];
    const current = (/** @type {any} */ (data)).proxies[mainGroup]?.now || null;

    return { data, config, groups, mainGroup, proxies, current };
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
        (/** @type {HTMLInputElement} */ (tunToggle)).checked = (/** @type {any} */ (config)).tun.enable;
        const statusText = document.getElementById('tun-status-text');
        if (statusText) {
            const t = /** @type {any} */ (translations)[currentLang];
            statusText.textContent = (/** @type {any} */ (config)).tun.enable ? t.proxyActive : (t.proxyInactive || 'Virtual Adapter');
        }
        // updateTrayStatus is handled by the main ui.js module
        try {
            const { updateTrayStatus } = await import('./tray.js');
            updateTrayStatus();
        } catch (_) {}
    }

    // Update current node display
    try {
        const proxyGroupsResult = await fetchProxyGroups({ existingConfig: config });
        let currentNode = 'Direct';
        if (proxyGroupsResult) {
            currentNode = (/** @type {any} */ (proxyGroupsResult)).current || 'Direct';
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
        const labels = { default: t.sortDefault, name: t.sortName, latency: t.sortLatency };
        sortLabel.textContent = (/** @type {any} */ (labels))[appStore.get('currentSortMode')] || labels['default'];
    }

    if (testBtn) {
        testBtn.onclick = async () => {
            if (appStore.get('isTestingLatency')) return;
            appStore.set('isTestingLatency', true);

            const icon = document.getElementById('test-icon');
            const t = /** @type {any} */ (translations)[currentLang];

            icon?.classList.add('animate-spin', 'text-purple-400');
            testBtn.classList.add('opacity-50', 'cursor-not-allowed');

            try {
                showLatencyLoadingForAllCards();
                await renderProxies();

                const proxyGroupsResult = await fetchProxyGroups();
                if (!proxyGroupsResult) {
                    throw new Error('No valid proxy group found for testing');
                }
                const { data, mainGroup, proxies } = /** @type {any} */ (proxyGroupsResult);

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
                            updatedLatVal.textContent = delay + 'ms';
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
                    queueLatencySort();
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
                if (latencySortTimer) clearTimeout(latencySortTimer);
                applyLatencySortToDom(true);
                icon?.classList.remove('animate-spin', 'text-purple-400');
                testBtn.classList.remove('opacity-50', 'cursor-not-allowed');
            }
        };
    }

    if (sortBtn) {
        sortBtn.onclick = () => {
            const modes = ['default', 'name', 'latency'];
            const idx = (modes.indexOf(appStore.get('currentSortMode')) + 1) % modes.length;
            appStore.set('currentSortMode', modes[idx]);

            const t = /** @type {any} */ (translations)[currentLang];
            const labels = { default: t.sortDefault, name: t.sortName, latency: t.sortLatency };
            if (sortLabel) sortLabel.textContent = (/** @type {any} */ (labels))[appStore.get('currentSortMode')];
            renderProxies();
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

/**
 * Render the proxy node list. Supports in-place updates when the list
 * hasn't changed (for smooth latency re-testing) and full re-renders.
 */
export async function renderProxies() {
    const container = document.getElementById('proxies-list');
    if (!container) return;

    const t = /** @type {any} */ (translations)[currentLang];

    // Show loading state if empty
    if (container.children.length === 0) {
        container.innerHTML = '';
        const loading = document.createElement('div');
        loading.className = 'col-span-full text-center py-10 text-zinc-500 flex flex-col items-center gap-4';
        const span = document.createElement('span');
        span.textContent = t.loadingNodes;
        const spinner = document.createElement('div');
        spinner.className = 'w-6 h-6 border-2 border-zinc-500 border-t-transparent rounded-full animate-spin';
        loading.appendChild(span);
        loading.appendChild(spinner);
        container.appendChild(loading);
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
            <svg class="w-12 h-12 opacity-20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
            <span class="text-sm font-light tracking-wider uppercase opacity-60">${escapeHtml(t.directModePrompt)}</span>
        `;
        container.appendChild(prompt);
        return;
    }

    const proxyGroupsResult = await fetchProxyGroups({ existingData: data, existingConfig: config });
    if (!proxyGroupsResult) {
        container.innerHTML = '';
        const empty = document.createElement('div');
        empty.className = 'col-span-full text-center py-10 text-zinc-500';
        empty.textContent = t.noGroupsFound;
        container.appendChild(empty);
        return;
    }

    let { mainGroup, proxies, current } = /** @type {any} */ (proxyGroupsResult);
    proxies = [...proxies]; // Mutable copy

    if (appStore.get('currentSortMode') === 'name') {
        proxies.sort((/** @type {string} */ a, /** @type {string} */ b) => a.localeCompare(b));
    } else if (appStore.get('currentSortMode') === 'latency') {
        sortProxiesByLatency(proxies, data);
    }

    // Sync sort label with current mode (may be reset by applyTranslations)
    const sortLabelEl = document.getElementById('sort-label');
    if (sortLabelEl) {
        const sortLabels = { default: t.sortDefault, name: t.sortName, latency: t.sortLatency };
        sortLabelEl.textContent = (/** @type {any} */ (sortLabels))[appStore.get('currentSortMode')] || sortLabels['default'];
    }

    // Store virtual data for lazy card creation
    /** @type {any} */ (container)._virtData = { proxies, data, current, isTestingLatency: appStore.get('isTestingLatency'), mainGroup };

    // --- In-place update path (same proxies, just refresh data) ---
    const existingWrappers = Array.from(container.children);
    const existingNames = new Set(existingWrappers.map(w => (/** @type {HTMLElement} */ (w)).dataset.name));
    const newNames = new Set(proxies);
    const canUpdateInPlace = existingWrappers.length > 0 &&
        existingWrappers.length === proxies.length &&
        [...existingNames].every(name => newNames.has(/** @type {string} */ (name)));

    if (canUpdateInPlace) {
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
                (/** @type {HTMLElement} */ (wrapper)).dataset.latency = String((lastDelay === null || lastDelay === 0 || lastDelay >= 999999) ? DELAY_INFINITE : lastDelay);
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
                    latVal.textContent = (lastDelay && lastDelay > 0 && lastDelay < 999999) ? lastDelay + 'ms' : 'Timeout';
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

        applyLatencySortToDom(true);
        return;
    }

    // --- Full render path ---
    const fragment = document.createDocumentFragment();

    const createCard = (/** @type {HTMLElement} */ wrapper) => {
        const { proxies, data, current, isTestingLatency, mainGroup } = /** @type {any} */ (container)._virtData;
        const index = parseInt((/** @type {HTMLElement} */ (wrapper)).dataset.index || '0', 10);
        const name = proxies[index];
        const proxy = (/** @type {any} */ (data)).proxies[name];
        const isSelected = name === current;

        let latFromWrapper = null;
        if ((/** @type {HTMLElement} */ (wrapper)).dataset.latency) latFromWrapper = parseInt((/** @type {HTMLElement} */ (wrapper)).dataset.latency, 10);

        const isPending = (/** @type {HTMLElement} */ (wrapper)).dataset.pending === '1';

        const card = document.createElement('div');
        card.dataset.baseOrder = `${index}`;
        card.dataset.selected = isSelected ? '1' : '0';
        card.className = `p-4 glass-card movie-card-base cursor-pointer flex flex-col gap-3 relative transition-all duration-300 group h-full w-full
            ${isSelected ? 'bg-white/15 border-accent/40 shadow-accent/20 ring-1 ring-accent/30' : 'hover:bg-white/5'}`;

        let lastDelay = (proxy.history && proxy.history.length > 0) ? proxy.history[proxy.history.length - 1].delay : null;
        if (latFromWrapper !== null) {
            lastDelay = latFromWrapper === DELAY_INFINITE ? 0 : latFromWrapper;
        }

        const delayColor = getDelayColorClass(lastDelay);

        (/** @type {HTMLElement} */ (card)).dataset.latency = String((lastDelay === null || lastDelay === 0 || lastDelay >= 999999) ? DELAY_INFINITE : lastDelay);
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
            latVal.textContent = (lastDelay && lastDelay > 0 && lastDelay < 999999) ? lastDelay + 'ms' : (/** @type {any} */ (translations)[currentLang].timeout || 'Timeout');
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
        card.appendChild(bottom);

        // --- Click handler: switch proxy ---
        card.onclick = async () => {
            abortLatencyTests();

            card.classList.add('opacity-50', 'pointer-events-none');
            const originalLatContent = latVal ? latVal.innerHTML : '';
            if (latVal) {
                latVal.innerHTML = SVG_ICONS.loadingSmall;
            }

            const success = await switchProxy(mainGroup, name);
            invalidateProxiesCache();

            card.classList.remove('opacity-50', 'pointer-events-none');
            if (latVal) {
                latVal.innerHTML = originalLatContent;
            }

            if (success) {
                setActiveNode(card, container);

                if (typeof applyLatencySortToDom === 'function') {
                    applyLatencySortToDom();
                }

                closeAllConnections().then(() => {
                    syncCoreConfig();
                });
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
        const isSelected = name === current;
        wrapper.dataset.selected = isSelected ? '1' : '0';
        wrapper.setAttribute('role', 'option');
        wrapper.setAttribute('aria-selected', isSelected ? 'true' : 'false');
        const lastDelay = (proxy.history && proxy.history.length > 0) ? proxy.history[proxy.history.length - 1].delay : null;
        (/** @type {HTMLElement} */ (wrapper)).dataset.latency = String((lastDelay === null || lastDelay === 0 || lastDelay >= 999999) ? DELAY_INFINITE : lastDelay);
        (/** @type {HTMLElement} */ (wrapper)).dataset.estimate = (/** @type {HTMLElement} */ (wrapper)).dataset.latency;

        wrapper.style.height = '96px';
        wrapper.style.contentVisibility = 'auto';
        wrapper.style.containIntrinsicSize = '96px';
        wrapper.className = 'w-full';

        const card = createCard(wrapper);
        setProxyPendingState(card, appStore.get('isTestingLatency'));
        wrapper.appendChild(card);
        setup3DEffect(card);

        // Prevent clipping by disabling content-visibility on hover
        /** @type {number|undefined} */
        let leaveTimeout;
        wrapper.addEventListener('mouseenter', () => {
            clearTimeout(leaveTimeout);
            wrapper.style.contentVisibility = 'visible';
            wrapper.style.zIndex = '10';
            wrapper.style.position = 'relative';
        });
        wrapper.addEventListener('mouseleave', () => {
            leaveTimeout = setTimeout(() => {
                wrapper.style.contentVisibility = 'auto';
                wrapper.style.zIndex = '';
                wrapper.style.position = '';
            }, 300);
        });

        fragment.appendChild(wrapper);
    });

    if ((/** @type {any} */ (container))._virtObserver) {
        (/** @type {any} */ (container))._virtObserver.disconnect();
    }

    container.innerHTML = '';
    container.appendChild(fragment);
}
