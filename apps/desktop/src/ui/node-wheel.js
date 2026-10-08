// @ts-check
/**
 * Node wheel component - visual node selector with wheel-like interaction.
 * Extracted from ui.js for modularity.
 */

import { getProxies, switchProxy, abortLatencyTests, closeAllConnections } from '../api.js';
import { nodeWheelLogger } from '../utils/logger.js';
import { t } from '../i18n.js';
import { showNotification } from './notifications.js';
import { fetchProxyGroups } from './proxy-groups.js';
import { sortProxiesByLatency, syncCoreConfig, renderProxies } from './proxies.js';
import { appStore } from './state.js';
import { invalidateProxiesCache, getSettingsCached } from './cache.js';
import { saveProxySelection } from './proxy-memory.js';
import { resetObservedGroup } from './observed-group.js';

/** Hover dwell before the wheel opens (ms). */
export const WHEEL_HOVER_OPEN_DELAY = 300;

/** @type {ReturnType<typeof setTimeout> | null} The one pending hover-open timer. */
let wheelHoverTimer = null;
/** True from the moment an open starts (including while nodes load) until closeWheel(). */
let isWheelOpen = false;
/**
 * Bumped by every closeWheel(). An open that awaited the node list under an
 * older generation was cancelled meanwhile and must not show the dropdown.
 */
let wheelGeneration = 0;
/** Removes the document/window listeners that only live while the wheel is shown. */
/** @type {(() => void) | null} */
let teardownOpenGuards = null;
/** @type {(() => void) | null} Installs those listeners; set by initNodeWheel. */
let installOpenGuards = null;
/** Last pointer position seen anywhere in the document. */
/** @type {{ x: number, y: number } | null} */
let lastPointer = null;
/**
 * Where the pointer was when the wheel was closed by something other than the
 * pointer leaving (a pick, Escape, window blur, page switch). The pill comes
 * back under a pointer that never moved and the browser reports a fresh
 * pointerenter for it; without this the wheel would pop open again 300ms
 * later on its own. Any real pointer movement clears it.
 * @type {{ x: number, y: number } | null}
 */
let suppressHoverAt = null;

/**
 * @param {{ clientX: number, clientY: number }} e
 * @returns {boolean} true when hover-open is still suppressed for this position
 */
function hoverSuppressedAt(e) {
    if (!suppressHoverAt) return false;
    if (Math.abs(e.clientX - suppressHoverAt.x) < 1 && Math.abs(e.clientY - suppressHoverAt.y) < 1) return true;
    suppressHoverAt = null;
    return false;
}

function cancelPendingOpen() {
    if (wheelHoverTimer) {
        clearTimeout(wheelHoverTimer);
        wheelHoverTimer = null;
    }
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
        nameEl.textContent = t('switching');
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
        // The observed exit node described the old selection; drop it so the pill
        // and home figures follow the new node (the watcher re-confirms it if active).
        resetObservedGroup();
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
        // A GLOBAL selection is routed through the backend and reported as a
        // rejected request instead of a thrown error, so surface it here rather
        // than failing silently on a user-initiated switch.
        // A newer switch owns the display now; reporting this one as failed
        // would describe the wrong selection.
        nodeWheelLogger.warn('Node switch was not applied');
        if (_switchSessionCounter !== currentSession) return;
        showNotification(t('notifSwitchFailed'), 'error');
        syncCoreConfig().catch(() => {});
    }
}

/**
 * Make the (already populated) dropdown visible and hide the pill under it.
 * @param {HTMLElement} trigger
 * @param {HTMLElement} dropdown
 */
function showDropdown(trigger, dropdown) {
    dropdown.classList.remove('opacity-0', 'pointer-events-none');
    dropdown.style.transform = 'translateY(0) scale(1)';
    trigger.style.opacity = '0';
    trigger.style.pointerEvents = 'none';
    trigger.setAttribute('aria-expanded', 'true');
    installOpenGuards?.();
}

/**
 * Populate the wheel dropdown with proxy items and show it.
 * @param {HTMLElement} trigger
 * @param {HTMLElement} dropdown
 * @param {HTMLElement} scrollContainer
 * @param {HTMLElement} list
 * @param {(item: Element, animate: boolean) => void} updateWheelVisualState
 * @param {() => void} resetToCenterFocus
 * @returns {Promise<boolean>} whether the dropdown is now shown
 */
async function populateAndShowWheel(trigger, dropdown, scrollContainer, list, updateWheelVisualState, resetToCenterFocus) {
    if (isWheelOpen) return false;
    isWheelOpen = true;
    const generation = wheelGeneration;
    /** The pointer left / the page changed while we were loading: stay closed. */
    const cancelled = () => generation !== wheelGeneration || !isWheelOpen;

    // Escape, blur and navigation must cancel an open that is still loading.
    installOpenGuards?.();

    try {
        const preferredGroupName = appStore.get('uiGroupName') || null;
        const proxyGroupsResult = await fetchProxyGroups({ preferredGroupName });
        if (cancelled()) return false;
        if (trigger.closest('[data-page]')?.classList.contains('hidden')) {
            closeWheel();
            return false;
        }
        if (!proxyGroupsResult) {
            // Nothing to show: release the open state so the next hover can retry
            // (and so the page-level wheel guard stops swallowing scrolls).
            isWheelOpen = false;
            teardownOpenGuards?.();
            teardownOpenGuards = null;
            return false;
        }

        if (scrollContainer) {
            scrollContainer.style.overflowY = 'auto';
        }

        // Use the resolver's uiGroupName for wheel display
        const uiGroupName = proxyGroupsResult.uiGroupName
            || proxyGroupsResult.mainGroup || '';
        const { data, current } = proxyGroupsResult;
        /** @type {string[]} */
        const proxies = [...proxyGroupsResult.proxies];

        // Guard: if the group has no nodes (provider still loading), show
        // a brief loading hint instead of an empty dropdown.
        if (proxies.length === 0) {
            const hint = document.createElement('div');
            hint.className = 'px-3 py-2 text-xs text-[var(--text-muted)] text-center';
            hint.textContent = t('loadingNodes');
            // Focusable so a keyboard open has somewhere to land while the pill is hidden.
            hint.tabIndex = -1;
            hint.dataset.wheelHint = '';
            hint.setAttribute('role', 'status');
            /** @type {any} */ (list)._virtObserver?.disconnect();
            list.replaceChildren();
            list.appendChild(hint);
            defaultActiveItem = null;
            showDropdown(trigger, dropdown);
            return true;
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
            item.tabIndex = -1;
            item.className = `px-3 py-1.5 rounded-full border flex items-center justify-center gap-2 cursor-pointer transition-[color,border-color,box-shadow] duration-[var(--zephyr-time-micro)] w-full h-full
                ${isSelected ? 'bg-white/20 border-accent shadow-[0_0_15px_rgba(255,255,255,0.15)] text-[var(--text-primary)]' : 'bg-[var(--zephyr-bg-input)] border-[var(--zephyr-border-subtle)] text-[var(--text-secondary)] hover:bg-[var(--zephyr-bg-muted)] hover:text-[var(--text-primary)]'}`;

            const dot = document.createElement('div');
            let dotColor;
            if (isSelected) dotColor = 'bg-accent animate-pulse';
            else if (proxy?.udp) dotColor = 'bg-success';
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

        showDropdown(trigger, dropdown);

        if (currentEl && scrollContainer) {
            /** @type {HTMLElement} */ (scrollContainer).offsetHeight;
            /** @type {HTMLElement} */ (scrollContainer).style.scrollBehavior = 'auto';
            /** @type {HTMLElement} */ (currentEl).scrollIntoView?.({ block: 'center' });
            setTimeout(() => { /** @type {HTMLElement} */ (scrollContainer).style.scrollBehavior = 'smooth'; }, 50);
        }
        defaultActiveItem = currentEl || list.firstElementChild;
        hoveredItem = null;
        if (defaultActiveItem) {
            updateWheelVisualState(defaultActiveItem, true);
        }
        return true;
    } catch (err) {
        nodeWheelLogger.error('Failed to load wheel nodes', err);
        if (!cancelled()) closeWheel();
        return false;
    }
}

/** @type {Element | null} */
let defaultActiveItem = null;
/** @type {Element | null} */
let hoveredItem = null;

/**
 * Collapse the wheel. Safe to call at any time and any number of times: it
 * cancels a pending hover-open, invalidates an open that is still loading
 * nodes, and always puts the pill/dropdown back into the closed look even if
 * the internal flag was already cleared.
 * @param {{ fromPointerLeave?: boolean }} [opts] - true when the pointer left
 *   the wheel; any other close keeps hover from reopening it until it does.
 */
export function closeWheel({ fromPointerLeave = false } = {}) {
    cancelPendingOpen();
    if (!fromPointerLeave) suppressHoverAt = lastPointer;
    wheelGeneration++;
    const wasOpen = isWheelOpen;
    isWheelOpen = false;
    teardownOpenGuards?.();
    teardownOpenGuards = null;
    const dropdown = document.getElementById('node-wheel-dropdown');
    const trigger = document.getElementById('node-wheel-trigger');
    const scrollContainer = document.getElementById('node-wheel-scroll');
    const shown = !!dropdown && !dropdown.classList.contains('opacity-0');
    if (!wasOpen && !shown) return;
    // Don't leave keyboard focus on an option that is about to become invisible.
    if (dropdown && trigger && dropdown.contains(document.activeElement)) {
        /** @type {HTMLElement} */ (trigger).focus({ preventScroll: true });
    }
    if (dropdown) {
        dropdown.classList.add('opacity-0', 'pointer-events-none');
        /** @type {HTMLElement} */ (dropdown).style.transform = 'translateY(0) scale(0.92)';
    }
    if (trigger) {
        /** @type {HTMLElement} */ (trigger).style.opacity = '1';
        /** @type {HTMLElement} */ (trigger).style.pointerEvents = 'auto';
        trigger.setAttribute('aria-expanded', 'false');
    }
    if (scrollContainer) {
        scrollContainer.style.overflowY = 'hidden';
    }
    hoveredItem = null;
}

/** @returns {boolean} */
export function isNodeWheelOpen() {
    return isWheelOpen;
}

export function initNodeWheel() {
    const trigger = document.getElementById('node-wheel-trigger');
    const dropdown = document.getElementById('node-wheel-dropdown');
    const scrollContainer = document.getElementById('node-wheel-scroll');
    const list = document.getElementById('node-wheel-list');
    const container = document.getElementById('node-wheel-container');

    if (!trigger || !dropdown || !list || !container || !scrollContainer) return;

    if (!list.id) list.id = 'node-wheel-list';
    list.setAttribute('role', 'listbox');
    trigger.setAttribute('aria-controls', list.id);
    trigger.setAttribute('aria-expanded', 'false');

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

    /**
     * The hover region is the pill plus the open dropdown — not the
     * full-width strip that positions them.
     * @param {EventTarget | null | undefined} node
     */
    const isInsideWheel = (node) => node instanceof Node
        && (trigger.contains(node) || (isWheelOpen && dropdown.contains(node)));

    /** Whether the pointer has been seen over the wheel since it opened. */
    let pointerInside = false;

    /** @param {Element | null | undefined} wrapper */
    const focusWheelItem = (wrapper) => {
        const option = wrapper?.querySelector('[role="option"]');
        if (!(option instanceof HTMLElement)) return;
        hoveredItem = wrapper || null;
        option.focus({ preventScroll: true });
        /** @type {HTMLElement} */ (wrapper).scrollIntoView?.({ block: 'center' });
        if (wrapper) updateWheelVisualState(wrapper, false);
    };

    installOpenGuards = () => {
        teardownOpenGuards?.();
        /** @param {PointerEvent} e */
        const onPointerMove = (e) => {
            // Safety net for a missed pointerleave (fast flicks, the element under
            // the pointer changing, leaving through the window edge).
            if (isInsideWheel(/** @type {Node} */ (e.target))) {
                pointerInside = true;
            } else if (pointerInside) {
                closeWheel({ fromPointerLeave: true });
            }
        };
        const onBlur = () => closeWheel();
        const onVisibility = () => { if (document.visibilityState === 'hidden') closeWheel(); };
        /** @param {KeyboardEvent} e */
        const onKeyDown = (e) => {
            if (e.key !== 'Escape') return;
            const hadFocus = container.contains(document.activeElement);
            closeWheel();
            if (hadFocus) trigger.focus({ preventScroll: true });
        };
        // Close when the home page (or the wheel itself) gets hidden by navigation.
        const page = container.closest('[data-page]');
        const observer = typeof MutationObserver === 'function' && page
            ? new MutationObserver(() => { if (page.classList.contains('hidden')) closeWheel(); })
            : null;
        if (observer && page) observer.observe(page, { attributes: true, attributeFilter: ['class'] });

        document.addEventListener('pointermove', onPointerMove, { capture: true, passive: true });
        document.addEventListener('keydown', onKeyDown, true);
        document.addEventListener('visibilitychange', onVisibility);
        window.addEventListener('blur', onBlur);
        teardownOpenGuards = () => {
            document.removeEventListener('pointermove', onPointerMove, { capture: true });
            document.removeEventListener('keydown', onKeyDown, true);
            document.removeEventListener('visibilitychange', onVisibility);
            window.removeEventListener('blur', onBlur);
            observer?.disconnect();
        };
    };

    /** @param {{ viaKeyboard?: boolean, viaHover?: boolean }} [opts] */
    const openWheel = async (opts = {}) => {
        cancelPendingOpen();
        pointerInside = !opts.viaKeyboard; // hover and mouse clicks start over the pill
        const shown = await populateAndShowWheel(trigger, dropdown, scrollContainer, list, updateWheelVisualState, resetToCenterFocus);
        if (shown && opts.viaKeyboard) {
            if (defaultActiveItem) focusWheelItem(defaultActiveItem);
            else /** @type {HTMLElement | null} */ (list.querySelector('[data-wheel-hint]'))?.focus({ preventScroll: true });
        }
    };

    /** @param {PointerEvent} e */
    const armHoverOpen = (e) => {
        if (isWheelOpen || wheelHoverTimer || hoverSuppressedAt(e)) return;
        wheelHoverTimer = setTimeout(() => {
            wheelHoverTimer = null;
            openWheel({ viaHover: true }).catch(err => nodeWheelLogger.error('Failed to open wheel', err));
        }, WHEEL_HOVER_OPEN_DELAY);
    };
    trigger.addEventListener('pointerenter', armHoverOpen);
    // A pointerenter swallowed by the suppression above still opens the wheel
    // once the pointer really moves over the pill.
    trigger.addEventListener('pointermove', armHoverOpen);

    // Leaving the pill or the dropdown for anything outside both: cancel a
    // pending open and collapse. relatedTarget is null when leaving the window.
    container.addEventListener('pointerout', (e) => {
        if (isInsideWheel(/** @type {Node | null} */ (e.relatedTarget))) return;
        closeWheel({ fromPointerLeave: true });
    });

    trigger.addEventListener('click', (e) => {
        cancelPendingOpen();
        if (isWheelOpen) {
            // A hover-started open is still loading its nodes: let it finish
            // instead of cancelling it (the click meant "open").
            if (dropdown.classList.contains('opacity-0')) return;
            closeWheel();
            return;
        }
        // detail === 0 means Enter/Space rather than a pointer click.
        openWheel({ viaKeyboard: e.detail === 0 }).catch(err => nodeWheelLogger.error('Failed to open wheel', err));
    });

    // Keyboard: arrows move through nodes, Enter/Space picks one, Tab leaves.
    list.addEventListener('keydown', (e) => {
        const items = getWheelItems();
        const current = /** @type {Element | null} */ (document.activeElement)?.closest?.('#node-wheel-list > *') || null;
        const index = current ? items.indexOf(current) : -1;
        /** @type {Element | undefined} */
        let next;
        switch (e.key) {
            case 'ArrowDown': next = items[Math.min(items.length - 1, index + 1)]; break;
            case 'ArrowUp': next = items[Math.max(0, index - 1)]; break;
            case 'Home': next = items[0]; break;
            case 'End': next = items[items.length - 1]; break;
            case 'Enter':
            case ' ': {
                const option = /** @type {HTMLElement | null} */ (document.activeElement);
                if (option?.getAttribute('role') === 'option') {
                    e.preventDefault();
                    trigger.focus({ preventScroll: true });
                    option.click();
                }
                return;
            }
            default: return;
        }
        e.preventDefault();
        if (next) focusWheelItem(next);
    });

    // Focus leaving the wheel entirely (Tab, click elsewhere) collapses it.
    container.addEventListener('focusout', (e) => {
        if (!isWheelOpen) return;
        const to = /** @type {Node | null} */ (e.relatedTarget);
        if (to && container.contains(to)) return;
        if (!to && pointerInside) return; // focus dropped to body while the mouse is on the wheel
        closeWheel();
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
    if (!win._wheelPointerTracked) {
        document.addEventListener('pointermove', (e) => {
            lastPointer = { x: e.clientX, y: e.clientY };
            // Any real movement away from where the wheel closed re-enables hover-open.
            if (suppressHoverAt && (Math.abs(e.clientX - suppressHoverAt.x) >= 1 || Math.abs(e.clientY - suppressHoverAt.y) >= 1)) {
                suppressHoverAt = null;
            }
        }, { capture: true, passive: true });
        win._wheelPointerTracked = true;
    }
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
}
