// @ts-check
/**
 * Minimal home: the profile menu in the traffic card's top-left corner.
 * Lists the saved profiles, each with its usage (used / total · days left)
 * when the subscription reports it, and switches the way the tray does.
 */

import { getConfigsCached, getSettingsCached, invalidateConfigsCache } from './cache.js';
import { currentProfile } from './active-profile.js';
import { appStore } from './state.js';
import { switchProfile } from './tray.js';
import { readRunningProfile } from './running-profile.js';
import { networkChangesBegun } from './network-change.js';
import { Bus, Events } from './events.js';
import { t } from '../i18n.js';
import { createLogger } from '../utils/logger.js';
import { formatSubUsage } from '../utils/sub-info.js';

const logger = createLogger('HomeProfile');

const LAYERS_ICON = '<svg class="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m12 2 9 5-9 5-9-5 9-5z"/><path d="m3 12 9 5 9-5"/><path d="m3 17 9 5 9-5"/></svg>';
const CHEVRON_ICON = '<svg class="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
const CHECK_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';

/**
 * A profile file name as the menu shows it.
 * @param {string} file
 */
export function profileLabel(file) {
    return String(file || '').replace(/\.(ya?ml)$/i, '');
}

/**
 * Mount the menu into `#home-profile` (or `hostId`). Returns a cleanup function.
 * @param {{ switchTo?: (file: string) => Promise<void>, hostId?: string, btnId?: string }} [opts]
 * @returns {() => void}
 */
export function initHomeProfile({ switchTo = switchProfile, hostId = 'home-profile', btnId = 'home-profile-btn' } = {}) {
    const found = document.getElementById(hostId);
    if (!found) return () => {};
    const host = found;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = btnId;
    btn.className = 'home-profile-btn';
    btn.setAttribute('aria-haspopup', 'menu');
    btn.setAttribute('aria-expanded', 'false');
    btn.title = t('homeProfile');
    // Re-read by the translation pass when the language changes.
    btn.dataset.i18nTitle = 'homeProfile';
    // eslint-disable-next-line no-unsanitized/property -- static SVG constants
    btn.innerHTML = `${LAYERS_ICON}<span class="truncate"></span>${CHEVRON_ICON}`; // nosemgrep: js-innerhtml-assignment — static markup
    const label = /** @type {HTMLElement} */ (btn.querySelector('.truncate'));
    host.replaceChildren(btn);

    /** @type {HTMLElement | null} */
    let menu = null;
    let active = '';
    let profileListKey = '';
    /** @type {string[]} */
    let configOrder = [];
    let disposed = false;
    let selectionSeq = 0;
    /** Numbers each refresh: an older one that finishes last must not repaint. */
    let refreshSeq = 0;

    async function refresh() {
        const seq = ++refreshSeq;
        try {
            const [settings, configs] = await Promise.all([getSettingsCached(), getConfigsCached()]);
            if (disposed || seq !== refreshSeq) return;
            const list = Array.isArray(configs) ? configs : [];
            const before = active;
            const savedOrder = /** @type {any} */ (settings)?.config_order;
            configOrder = Array.isArray(savedOrder) ? savedOrder : [];
            const nextListKey = JSON.stringify([configOrder, list.map((/** @type {any} */ c) => [c?.name, c?.sub_info])]);
            active = currentProfile(settings, list.find((/** @type {any} */ c) => c?.is_active)?.name || '');
            label.textContent = profileLabel(active) || t('homeProfile');
            host.classList.toggle('hidden', list.length === 0);
            // Switched elsewhere (the tray) while open: its check mark is stale.
            if (menu && (active !== before || nextListKey !== profileListKey)) close(menu.contains(document.activeElement));
            profileListKey = nextListKey;
        } catch (e) {
            if (!disposed && seq === refreshSeq) {
                // The running profile is unknown until a read succeeds.
                active = '';
                label.textContent = t('homeProfile');
                if (menu) close(menu.contains(document.activeElement));
            }
            logger.debug('profile list failed', e);
        }
    }

    function close(refocus = false) {
        if (!menu) return;
        menu.remove();
        menu = null;
        btn.setAttribute('aria-expanded', 'false');
        document.removeEventListener('click', onDocClick, true);
        document.removeEventListener('keydown', onKey, true);
        document.removeEventListener('focusin', onFocus, true);
        if (refocus) btn.focus();
    }

    /** @param {MouseEvent} e */
    function onDocClick(e) {
        if (menu && !menu.contains(/** @type {Node} */ (e.target)) && !btn.contains(/** @type {Node} */ (e.target))) close();
    }

    /** @param {KeyboardEvent} e */
    function onKey(e) {
        if (!menu) return;
        const focus = document.activeElement;
        if (!menu.contains(focus) && !btn.contains(focus)) { close(); return; }
        const items = /** @type {HTMLElement[]} */ (Array.from(menu.querySelectorAll('[role="menuitemradio"]')));
        const i = items.indexOf(/** @type {HTMLElement} */ (document.activeElement));
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); }
        else if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length]?.focus(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); }
        else if (e.key === 'Home') { e.preventDefault(); items[0]?.focus(); }
        else if (e.key === 'End') { e.preventDefault(); items[items.length - 1]?.focus(); }
        // From the button, so Tab moves on from there rather than from the page start.
        else if (e.key === 'Tab') { btn.focus(); close(); }
    }

    /** @param {FocusEvent} e */
    function onFocus(e) {
        if (menu && !menu.contains(/** @type {Node|null} */ (e.target)) && !btn.contains(/** @type {Node|null} */ (e.target))) close();
    }

    /** Cancels an open waiting on reads and releases its event listeners immediately. */
    /** @type {(() => void) | null} */
    let cancelOpening = null;

    async function open() {
        if (cancelOpening) { cancelOpening(); return; }
        // A click elsewhere, Esc or focus leaving the button while the reads
        // run cancels the open: the menu must not appear and take focus then.
        let cancelled = false;
        const finish = () => {
            if (cancelOpening === finish) cancelOpening = null;
            document.removeEventListener('pointerdown', cancel, true);
            document.removeEventListener('keydown', cancel, true);
            btn.removeEventListener('blur', finish);
            cancelled = true;
        };
        const cancel = (/** @type {Event} */ e) => {
            if (e.type === 'keydown' && /** @type {KeyboardEvent} */ (e).key !== 'Escape') return;
            if (e.type === 'pointerdown' && btn.contains(/** @type {Node} */ (e.target))) return;
            finish();
        };
        cancelOpening = finish;
        document.addEventListener('pointerdown', cancel, true);
        document.addEventListener('keydown', cancel, true);
        btn.addEventListener('blur', finish);
        try {
            await openMenu(() => cancelled);
        } finally {
            finish();
        }
    }

    /** @param {() => boolean} cancelled */
    async function openMenu(cancelled) {
        invalidateConfigsCache();
        await refresh();
        if (disposed || menu || cancelled()) return;
        const configs = /** @type {any[]} */ ((await getConfigsCached().catch(() => [])) || []);
        if (disposed || menu || cancelled() || !btn.isConnected) return;
        const m = document.createElement('div');
        m.className = 'proxy-group-menu proxy-sort-menu home-profile-menu rounded-lg shadow-2xl border border-[var(--zephyr-border-default)]';
        m.setAttribute('role', 'menu');
        m.setAttribute('aria-label', t('homeProfile'));
        const sortedConfigs = [...configs].sort((a, b) => {
            const aIndex = configOrder.indexOf(a.name);
            const bIndex = configOrder.indexOf(b.name);
            return (aIndex < 0 ? configOrder.length : aIndex) - (bIndex < 0 ? configOrder.length : bIndex);
        });
        for (const c of sortedConfigs) {
            const file = String(c?.name || '');
            if (!file) continue;
            const item = document.createElement('button');
            item.type = 'button';
            item.tabIndex = -1;
            item.className = 'proxy-sort-option';
            item.setAttribute('role', 'menuitemradio');
            const on = file === active;
            item.setAttribute('aria-checked', on ? 'true' : 'false');
            const body = document.createElement('span');
            body.className = 'proxy-sort-body';
            const title = document.createElement('span');
            title.className = 'proxy-sort-title';
            title.textContent = profileLabel(file);
            const usage = document.createElement('span');
            usage.className = 'proxy-sort-desc home-profile-usage';
            usage.textContent = formatSubUsage(c?.sub_info, (d) => t('consoleSubDaysLeft', d, { d: String(d) })) || t('homeProfileNoUsage');
            body.append(title, usage);
            const check = document.createElement('span');
            check.className = 'proxy-group-check';
            check.setAttribute('aria-hidden', 'true');
            // eslint-disable-next-line no-unsanitized/property -- static SVG constant
            if (on) check.innerHTML = CHECK_ICON; // nosemgrep: js-innerhtml-assignment — static markup
            item.append(body, check);
            item.addEventListener('click', async () => {
                const seq = ++selectionSeq;
                const networkAtClick = networkChangesBegun();
                close(true);
                // The active profile now, not when the menu opened (the tray may have switched).
                // Unless the minimal config runs in its place (it failed to
                // load): picking it again retries it, as after a repair.
                if (!appStore.get('noSubscription')) {
                    const running = await readRunningProfile();
                    if (disposed) return;
                    if (seq !== selectionSeq) return;
                    if (networkAtClick !== networkChangesBegun()) return;
                    if (running === file && !appStore.get('isNetworkUpdating')) return;
                }
                label.textContent = t('switching');
                try { await switchTo(file); } catch (e) {
                    logger.warn('profile switch failed', e);
                } finally {
                    invalidateConfigsCache();
                    await refresh();
                }
            });
            m.append(item);
        }
        // Nothing to pick (the list could not be read): no empty menu that
        // takes the arrow keys; the button stays for another try.
        if (!m.childElementCount) return;
        host.append(m);
        menu = m;
        btn.setAttribute('aria-expanded', 'true');
        /** @type {HTMLElement | null} */ (m.querySelector('[aria-checked="true"]') || m.querySelector('[role="menuitemradio"]'))?.focus();
        document.addEventListener('click', onDocClick, true);
        document.addEventListener('keydown', onKey, true);
        document.addEventListener('focusin', onFocus, true);
    }

    const onBtn = () => { if (menu) close(true); else void open(); };
    btn.addEventListener('click', onBtn);
    const offConfig = Bus.on(Events.CONFIG_UPDATED, () => { invalidateConfigsCache(); void refresh(); });
    const offRestart = Bus.on(Events.CORE_RESTARTED, () => { void refresh(); });
    void refresh();

    return () => {
        disposed = true;
        cancelOpening?.();
        close();
        btn.removeEventListener('click', onBtn);
        if (typeof offConfig === 'function') offConfig();
        if (typeof offRestart === 'function') offRestart();
    };
}
