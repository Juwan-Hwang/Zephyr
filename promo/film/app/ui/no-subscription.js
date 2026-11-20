// @ts-check
/**
 * First launch / no subscription: the core runs on a minimal config, so nothing is
 * proxied. The home hero (minimal mode) and the traffic card (console mode) say so
 * and offer "Add subscription"; either system-proxy switch opens the same dialog
 * instead of silently enabling a direct-only proxy.
 *
 * @module ui/no-subscription
 */

import { t } from '../i18n.js';
import { appStore } from './state.js';
import { navigateTo } from './navigation.js';
import { Bus, Events } from './events.js';

/** Hosts that get the empty state: [host element id, empty-state element id]. */
const HOSTS = /** @type {const} */ ([
    ['home-hero', 'home-empty-state'],
    ['dz-traffic-card', 'console-empty-state'],
]);

/** System-proxy switches that open Add subscription instead while nothing is subscribed. */
const SYS_PROXY_TOGGLES = new Set(['sys-proxy-toggle', 'dz-sys-toggle']);

/** Go to Subscriptions and open its Add dialog. */
export function openAddSubscription() {
    navigateTo('subscriptions');
    requestAnimationFrame(() => document.getElementById('add-sub-btn')?.click());
}

/**
 * @param {string} hostId
 * @param {string} emptyId
 * @param {boolean} on
 */
function renderInto(hostId, emptyId, on) {
    const host = document.getElementById(hostId);
    if (!host) return;
    host.classList.toggle('is-empty', on);
    if (hostId === 'home-hero') syncSysProxyHint(on);
    const existing = document.getElementById(emptyId);
    if (!on) { existing?.remove(); return; }
    if (existing && host.contains(existing)) return;
    existing?.remove();

    const box = document.createElement('div');
    box.id = emptyId;
    box.className = 'home-empty-state';

    const icon = document.createElement('div');
    icon.className = 'home-empty-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';

    const title = document.createElement('h3');
    title.className = 'home-empty-title';
    title.textContent = t('noSubscriptionTitle');

    const sub = document.createElement('p');
    sub.className = 'home-empty-sub';
    sub.textContent = t('noSubscriptionSub');

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'home-empty-btn';
    btn.textContent = t('addSubscription');
    btn.addEventListener('click', openAddSubscription);

    box.append(icon, title, sub, btn);
    host.appendChild(box);
    // In the home hero the stats row stays visible: the empty state sits above it
    // (styles.css reads --home-stats-h, kept current by trackHomeStatsHeight()).
    if (hostId === 'home-hero') trackHomeStatsHeight();
}

/** @type {ResizeObserver|null} */
let statsObserver = null;

/**
 * Keep --home-stats-h on the hero equal to the stats row's height. Measuring once
 * reads 0 while Home is hidden (another start page) and goes stale on resize, so
 * observe it: the observer fires again once the row is laid out.
 */
export function trackHomeStatsHeight() {
    const hero = document.getElementById('home-hero');
    const stats = hero?.querySelector('.home-stats');
    if (!hero || !(stats instanceof HTMLElement)) return;
    const apply = () => {
        if (stats.offsetHeight > 0) hero.style.setProperty('--home-stats-h', `${stats.offsetHeight}px`);
    };
    apply();
    if (statsObserver || typeof ResizeObserver === 'undefined') return;
    statsObserver = new ResizeObserver(apply);
    statsObserver.observe(stats);
}

/** @param {boolean} on */
function syncSysProxyHint(on) {
    const status = document.getElementById('proxy-status-text');
    // While the system proxy is on, the status shows "Proxy Active" (sysproxy.js).
    if (!status || appStore.get('isSysProxyEnabled')) return;
    status.textContent = t(on ? 'sysProxyNeedsSubscription' : 'proxyStatusReady');
}

/** Render (or clear) the empty state in every host currently in the DOM. */
export function syncNoSubscriptionState() {
    const on = !!appStore.get('noSubscription');
    for (const [hostId, emptyId] of HOSTS) renderInto(hostId, emptyId, on);
}

let initialized = false;

export function initNoSubscriptionState() {
    syncNoSubscriptionState();
    if (initialized) return;
    initialized = true;
    appStore.subscribe('noSubscription', () => syncNoSubscriptionState());
    // Every core (re)start reports whether a real profile loaded, whichever path
    // restarted it (switching, adding the active profile again, repairs).
    Bus.on(Events.CORE_RESTARTED, (/** @type {any} */ payload) => {
        if (payload?.activeConfig !== undefined) appStore.set('noSubscription', payload.activeConfig === null);
    });
    // The empty state's text is set once when it is built: rebuild it in the new language.
    Bus.on(Events.LANGUAGE_CHANGED, () => {
        for (const [, emptyId] of HOSTS) document.getElementById(emptyId)?.remove();
        syncNoSubscriptionState();
    });

    // Turning the system proxy on without a subscription would only proxy to DIRECT.
    // Delegated in the capture phase so the console switch (injected later) is covered too.
    document.addEventListener('click', (e) => {
        const toggle = /** @type {HTMLInputElement|null} */ (e.target instanceof HTMLInputElement ? e.target : null);
        if (!toggle || !SYS_PROXY_TOGGLES.has(toggle.id)) return;
        // `checked` is already flipped when click fires; preventDefault reverts it.
        if (appStore.get('noSubscription') && toggle.checked) {
            e.preventDefault();
            openAddSubscription();
        }
    }, true);
}
