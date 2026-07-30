// @ts-check
/**
 * Node wheel component - visual node selector with wheel-like interaction.
 * Extracted from ui.js for modularity.
 */

import { getProxies, switchProxy, abortLatencyTests, closeAllConnections } from '../api.js';
import { nodeWheelLogger } from '../utils/logger.js';
import { translations, currentLang } from '../i18n.js';
import { fetchProxyGroups } from './proxy-groups.js';
import { sortProxiesByLatency, syncCoreConfig, renderProxies } from './proxies.js';
import { appStore } from './state.js';
import { invalidateProxiesCache, getSettingsCached } from './cache.js';
import { saveProxySelection } from './proxy-memory.js';

/** @type {ReturnType<typeof setTimeout> | null} */
let wheelHoverTimer = null;
let isWheelOpen = false;

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

/**
 * Handle proxy switch within the wheel, including UI updates and recovery.
 * @param {HTMLElement} trigger
 * @param {string} mainGroup
 * @param {string} name
 * @param {boolean} isSelected
 */
async function handleWheelProxySwitch(trigger, mainGroup, name, isSelected) {
    if (isSelected) {
        closeWheel();
        return;
    }
    const nameEl = trigger.querySelector('#current-node-name');
    if (nameEl) {
        const langKey = /** @type {'en'|'zh'|'ja'|'ko'} */(currentLang);
        const t = /** @type {Record<string, unknown>} */(translations[langKey]);
        nameEl.textContent = String(t.switching || "Switching...");
    }
    closeWheel();
    abortLatencyTests();

    // Use session counter to prevent race conditions on rapid switches
    // Increment BEFORE async operations to maintain click order
    const currentSession = ++_switchSessionCounter;

    // Use uiGroupName from appStore for accurate group targeting
    const targetGroup = appStore.get('uiGroupName') || mainGroup;
    const success = await switchProxy(targetGroup, name);
    if (success) {
        invalidateProxiesCache();
        await closeAllConnections();

        // Save proxy selection for restore after core restart
        try {
            const settings = await getSettingsCached();
            const profileName = settings?.last_config;
            if (profileName) {
                await saveProxySelection(profileName, { node: name, group: targetGroup });
            }
        } catch (e) {
            nodeWheelLogger.warn('Failed to save proxy selection', e);
        }

        // Wait for node switch to complete, then let syncCoreConfig() handle display
        // Run as non-blocking IIFE to prevent UI lag
        (async () => {
            try {
                await waitForCurrentNode(targetGroup, name);
                if (_switchSessionCounter !== currentSession) return;
                // Let syncCoreConfig() handle the display update with leaf node resolution
                await syncCoreConfig();
                if (_switchSessionCounter !== currentSession) return;
                const proxiesPage = document.querySelector('[data-page="proxies"]');
                if (proxiesPage && !proxiesPage.classList.contains('hidden')) {
                    await renderProxies();
                }
            } catch (error) {
                nodeWheelLogger.error('Failed to update UI after node switch:', error);
            }
        })();
    } else {
        syncCoreConfig().catch(() => {});
    }
}

/**
 * Populate the wheel dropdown with proxy items and show it.
 * @param {HTMLElement} trigger
 * @param {HTMLElement} dropdown
 * @param {HTMLElement} scrollContainer
 * @param {HTMLElement} list
 * @param {(item: Element, animate: boolean) => void} updateWheelVisualState
 * @param {() => void} resetToCenterFocus
 */
async function populateAndShowWheel(trigger, dropdown, scrollContainer, list, updateWheelVisualState, resetToCenterFocus) {
    if (isWheelOpen) return;
    isWheelOpen = true;

    if (scrollContainer) {
        scrollContainer.style.overflowY = 'auto';
    }

    try {
        const preferredGroupName = appStore.get('uiGroupName') || null;
        const proxyGroupsResult = await fetchProxyGroups({ preferredGroupName });
        if (!proxyGroupsResult) return;

        // Use the resolver's uiGroupName for wheel display
        const uiGroupName = proxyGroupsResult.uiGroupName
            || proxyGroupsResult.mainGroup || '';
        const { data, current } = proxyGroupsResult;
        /** @type {string[]} */
        const proxies = [...proxyGroupsResult.proxies];

        // Guard: if the group has no nodes (provider still loading), show
        // a brief loading hint instead of an empty dropdown.
        if (proxies.length === 0) {
            const langKey = /** @type {'en'|'zh'|'ja'|'ko'} */(currentLang);
            const tObj = /** @type {Record<string, unknown>} */(translations[langKey]);
            const hint = document.createElement('div');
            hint.className = 'px-3 py-2 text-xs text-[var(--text-muted)] text-center';
            hint.textContent = String(tObj?.loadingNodes || 'Loading nodes...');
            /** @type {any} */ (list)._virtObserver?.disconnect();
            list.replaceChildren();
            list.appendChild(hint);
            dropdown.classList.remove('opacity-0', 'pointer-events-none');
            /** @type {HTMLElement} */ (dropdown).style.transform = 'translateY(0) scale(1)';
            /** @type {HTMLElement} */ (trigger).style.opacity = '0';
            /** @type {HTMLElement} */ (trigger).style.pointerEvents = 'none';
            return;
        }

        sortProxiesByLatency(proxies, data);

        const fragment = document.createDocumentFragment();
        /** @type {Element | null} */
        let currentEl = null;

        /**
         * @param {string} idxStr
         * @param {Element} wrapper
         * @returns {HTMLElement}
         */
        const createWheelItem = (idxStr, wrapper) => {
            const index = parseInt(idxStr, 10);
            const name = proxies[index];
            /** @type {any} */
            const proxyData = data;
            const proxy = proxyData.proxies[name];
            const isSelected = name === current;

            const item = document.createElement('div');
            item.setAttribute('role', 'option');
            item.setAttribute('aria-selected', isSelected ? 'true' : 'false');
            item.className = `px-3 py-1.5 rounded-full border flex items-center justify-center gap-2 cursor-pointer transition-[color,border-color,box-shadow] duration-[var(--zephyr-time-micro)] w-full h-full
                ${isSelected ? 'bg-white/20 border-accent shadow-[0_0_15px_rgba(255,255,255,0.15)] text-[var(--text-primary)]' : 'bg-[var(--zephyr-bg-input)] border-[var(--zephyr-border-subtle)] text-[var(--text-secondary)] hover:bg-[var(--zephyr-bg-muted)] hover:text-[var(--text-primary)]'}`;

            const dot = document.createElement('div');
            let dotColor;
            if (isSelected) dotColor = 'bg-accent animate-pulse';
            else if (proxy.udp) dotColor = 'bg-success';
            else dotColor = 'bg-[var(--text-tertiary)]';
            dot.className = `w-1.5 h-1.5 rounded-full ${dotColor}`;

            const nameSpan = document.createElement('span');
            nameSpan.className = "text-xs font-semibold tracking-wide truncate max-w-[180px]";
            nameSpan.textContent = name;

            item.appendChild(dot);
            item.appendChild(nameSpan);

            item.addEventListener('mouseenter', () => {
                hoveredItem = wrapper;
                updateWheelVisualState(wrapper, false);
            });
            item.addEventListener('mouseleave', () => {
                hoveredItem = null;
                resetToCenterFocus();
            });

            item.onclick = () => handleWheelProxySwitch(trigger, uiGroupName, name, isSelected);
            return item;
        };

        proxies.forEach((name, index) => {
            const isSelected = name === current;
            const wrapper = document.createElement('div');
            wrapper.dataset.index = String(index);
            wrapper.className = 'w-full shrink-0 flex items-center justify-center';
            /** @type {HTMLElement} */ (wrapper).style.height = '32px';
            /** @type {HTMLElement} */ (wrapper).style.scrollSnapAlign = 'center';
            /** @type {HTMLElement} */ (wrapper).style.transformOrigin = 'center center';
            /** @type {HTMLElement} */ (wrapper).style.transition = 'transform 220ms cubic-bezier(0.23, 1, 0.32, 1), opacity 220ms ease, box-shadow 220ms ease';
            /** @type {HTMLElement} */ (wrapper).style.contentVisibility = 'auto';
            /** @type {HTMLElement} */ (wrapper).style.containIntrinsicSize = '32px';

            const item = createWheelItem(index.toString(), wrapper);
            wrapper.appendChild(item);

            fragment.appendChild(wrapper);
            if (isSelected) currentEl = wrapper;
        });

        /** @type {any} */ (list)._virtObserver?.disconnect();

        list.replaceChildren();
        list.appendChild(fragment);

        dropdown.classList.remove('opacity-0', 'pointer-events-none');
        /** @type {HTMLElement} */ (dropdown).style.transform = 'translateY(0) scale(1)';
        /** @type {HTMLElement} */ (trigger).style.opacity = '0';
        /** @type {HTMLElement} */ (trigger).style.pointerEvents = 'none';

        if (currentEl && scrollContainer) {
            /** @type {HTMLElement} */ (scrollContainer).offsetHeight;
            /** @type {HTMLElement} */ (scrollContainer).style.scrollBehavior = 'auto';
            /** @type {HTMLElement} */ (currentEl).scrollIntoView({ block: 'center' });
            setTimeout(() => { /** @type {HTMLElement} */ (scrollContainer).style.scrollBehavior = 'smooth'; }, 50);
        }
        defaultActiveItem = currentEl || list.firstElementChild;
        hoveredItem = null;
        if (defaultActiveItem) {
            updateWheelVisualState(defaultActiveItem, true);
        }
    } catch (err) {
        nodeWheelLogger.error('Failed to load wheel nodes', err);
    }
}

/** @type {Element | null} */
let defaultActiveItem = null;
/** @type {Element | null} */
let hoveredItem = null;

function closeWheel() {
    if (!isWheelOpen) return;
    isWheelOpen = false;
    const dropdown = document.getElementById('node-wheel-dropdown');
    const trigger = document.getElementById('node-wheel-trigger');
    const scrollContainer = document.getElementById('node-wheel-scroll');
    if (dropdown) {
        dropdown.classList.add('opacity-0', 'pointer-events-none');
        /** @type {HTMLElement} */ (dropdown).style.transform = 'translateY(0) scale(0.92)';
    }
    if (trigger) {
        /** @type {HTMLElement} */ (trigger).style.opacity = '1';
        /** @type {HTMLElement} */ (trigger).style.pointerEvents = 'auto';
    }
    if (scrollContainer) {
        scrollContainer.style.overflowY = 'hidden';
    }
    hoveredItem = null;
    if (wheelHoverTimer) clearTimeout(wheelHoverTimer);
}

export function initNodeWheel() {
    const trigger = document.getElementById('node-wheel-trigger');
    const dropdown = document.getElementById('node-wheel-dropdown');
    const scrollContainer = document.getElementById('node-wheel-scroll');
    const list = document.getElementById('node-wheel-list');
    const container = document.getElementById('node-wheel-container');

    if (!trigger || !dropdown || !list || !container || !scrollContainer) return;

    const getWheelItems = () => Array.from(list.children);

    const findCenterItem = () => {
        const items = getWheelItems();
        if (!items.length || !scrollContainer) return null;
        const rect = scrollContainer.getBoundingClientRect();
        const centerY = rect.top + (rect.height / 2);
        let nearest = items[0];
        let minDistance = Number.MAX_SAFE_INTEGER;
        items.forEach((item) => {
            const itemRect = item.getBoundingClientRect();
            const itemCenterY = itemRect.top + (itemRect.height / 2);
            const distance = Math.abs(itemCenterY - centerY);
            if (distance < minDistance) {
                minDistance = distance;
                nearest = item;
            }
        });
        return nearest;
    };

    /**
     * @param {Element} activeItem
     * @param {boolean} [animateFromCenter]
     */
    const updateWheelVisualState = (activeItem, animateFromCenter = false) => {
        const items = getWheelItems();
        if (!items.length || !activeItem) return;
        const activeIndex = Math.max(0, items.indexOf(activeItem));
        items.forEach((item, index) => {
            const distance = index - activeIndex;
            const absDistance = Math.abs(distance);
            const scale = absDistance === 0 ? 1.1 : Math.max(0.85, 0.98 - (absDistance * 0.05));
            const translateY = distance * 8;
            const opacity = absDistance > 4 ? 0.3 : 1 - Math.min(absDistance * 0.15, 0.6);
            /** @type {HTMLElement} */ (item).style.zIndex = `${100 - absDistance}`;
            if (animateFromCenter) {
                /** @type {HTMLElement} */ (item).style.transform = 'translateY(0px) scale(0.86)';
                /** @type {HTMLElement} */ (item).style.opacity = '0';
                requestAnimationFrame(() => {
                    setTimeout(() => {
                        /** @type {HTMLElement} */ (item).style.transform = `translateY(${translateY}px) scale(${scale})`;
                        /** @type {HTMLElement} */ (item).style.opacity = `${opacity}`;
                    }, absDistance * 12);
                });
                return;
            }
            /** @type {HTMLElement} */ (item).style.transform = `translateY(${translateY}px) scale(${scale})`;
            /** @type {HTMLElement} */ (item).style.opacity = `${opacity}`;
            const textSpan = item.querySelector('span');
            if (textSpan) {
                /** @type {HTMLElement} */ (textSpan).style.fontSize = `${12 / scale}px`;
            }
        });
    };

    const resetToCenterFocus = () => {
        defaultActiveItem = findCenterItem() || defaultActiveItem || list.firstElementChild;
        hoveredItem = null;
        if (defaultActiveItem) {
            updateWheelVisualState(defaultActiveItem, false);
        }
    };

    const openWheel = () => populateAndShowWheel(trigger, dropdown, scrollContainer, list, updateWheelVisualState, resetToCenterFocus);

    trigger.addEventListener('mouseenter', () => {
        if (wheelHoverTimer) clearTimeout(wheelHoverTimer);
        wheelHoverTimer = setTimeout(() => {
            openWheel();
        }, 300);
    });

    trigger.addEventListener('click', () => {
        if (wheelHoverTimer) clearTimeout(wheelHoverTimer);
        openWheel();
    });

    if (scrollContainer) {
        /** @type {ReturnType<typeof setTimeout> | null} */
        let scrollFocusTimer = null;
        scrollContainer.addEventListener('scroll', () => {
            if (hoveredItem) return;
            if (scrollFocusTimer) clearTimeout(scrollFocusTimer);
            scrollFocusTimer = setTimeout(() => {
                resetToCenterFocus();
            }, 60);
        }, { passive: true });
    }

    /** @type {any} */
    const win = window;
    if (!win._wheelListenerAdded) {
        if (scrollContainer) {
            scrollContainer.addEventListener('wheel', (e) => {
                if (isWheelOpen) {
                    e.stopPropagation();
                }
            }, { passive: true, capture: true });
        }

        document.addEventListener('wheel', (e) => {
            if (!isWheelOpen) return;
            e.preventDefault();
        }, { passive: false });
        win._wheelListenerAdded = true;
    }

    container.addEventListener('mouseleave', () => {
        if (wheelHoverTimer) clearTimeout(wheelHoverTimer);
        closeWheel();
    });
}
