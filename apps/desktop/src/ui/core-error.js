// @ts-check
/**
 * In-page error state for a core that failed to start (replaces the native alert()).
 * A banner at the top of the home page (either layout); the controls below stay
 * visible but dimmed and inert, so the page keeps its shape, and the node bar
 * reads "Stopped".
 *
 * @module ui/core-error
 */

import { t } from '../i18n.js';
import { readCoreLog } from '../api.js';
import { appStore } from './state.js';

const LOG_TAIL_LINES = 40;

/** Bytes read back from the end of the log: plenty for the last few dozen lines. */
const LOG_TAIL_BYTES = 16 * 1024;

const CARD_ID = 'core-error-state';
const DOWN_CLASS = 'core-down';

/** The dimmed sections behind the card (matches the `.core-down` rules in styles.css). */
const DIMMED_SELECTOR = [
    '[data-page="home"] > :not(#home-node, #core-error-state)',
    '[data-page="home"] #home-node-trigger',
    '[data-page="console"] .dz-content > :not(#core-error-state)',
].join(', ');

/** Sections this module made inert, so hiding the card restores only those. */
const madeInert = new Set();

/** @param {Element | null} main */
function setDimmedInert(main) {
    if (!main) return;
    main.querySelectorAll(DIMMED_SELECTOR).forEach((el) => {
        if (el.hasAttribute('inert') || el.contains(document.getElementById(CARD_ID))) return;
        el.setAttribute('inert', '');
        madeInert.add(el);
    });
}

function restoreInert() {
    madeInert.forEach((el) => el.removeAttribute('inert'));
    madeInert.clear();
}

/**
 * Last lines of the core log. The log is appended to across starts, so read from
 * its end (the backend reads forward from an offset) rather than from the start.
 * @returns {Promise<string[]>}
 */
async function readLogTail() {
    const probe = await readCoreLog(0, 1);
    const size = Number(probe?.file_size) || 0;
    // Start one byte early and drop the first (partial) line: when the offset is
    // right after a newline, that line is just the newline and nothing is lost.
    const offset = Math.max(0, size - LOG_TAIL_BYTES - 1);
    /** @type {string[]} */
    const lines = [];
    // A dense tail can hold more lines than one read returns: read on to the end.
    let at = offset;
    for (let i = 0; i < 20; i++) {
        const res = await readCoreLog(at, 2000);
        const chunk = Array.isArray(res?.lines) ? [...res.lines] : [];
        // Drop the partial first line, unless it is all there is (one line longer than the window).
        if (i === 0 && offset > 0 && (chunk.length > 1 || res?.has_more)) chunk.shift();
        lines.push(...chunk);
        if (lines.length > LOG_TAIL_LINES) lines.splice(0, lines.length - LOG_TAIL_LINES);
        const next = Number(res?.next_offset);
        if (!res?.has_more || !Number.isFinite(next) || next <= at) break;
        at = next;
    }
    return lines.map((l) => String(l).replace(/\r?\n$/, '')).slice(-LOG_TAIL_LINES);
}

/** The home page that is showing (minimal or console), if any. */
function visibleHomePage() {
    const pages = [
        document.querySelector('[data-page="home"]'),
        document.querySelector('[data-page="console"] .dz-content'),
    ];
    return /** @type {HTMLElement | undefined} */ (pages.find((el) => el && el.getClientRects().length > 0));
}

/**
 * Put the card at the top of the home page that is showing, or float it on
 * any other page so its Retry stays reachable.
 * @param {HTMLElement} card
 */
function placeCard(card) {
    const focused = card.contains(document.activeElement) ? /** @type {HTMLElement} */ (document.activeElement) : null;
    const page = visibleHomePage();
    const logOpen = card.classList.contains('has-log');
    card.className = page ? 'core-error-card is-banner glass-card' : 'core-error-card is-floating glass-card';
    card.classList.toggle('has-log', logOpen);
    if (page) {
        if (card.parentElement !== page || page.firstElementChild !== card) page.prepend(card);
    } else {
        const host = document.getElementById('app-main-container') || document.body;
        if (card.parentElement !== host) host.appendChild(card);
    }
    focused?.focus({ preventScroll: true });
}

/**
 * After a page switch: the card moves with the user (startup still waits on
 * its Retry), as a banner on a home page and floating elsewhere.
 */
export function relocateCoreStartError() {
    const card = document.getElementById(CARD_ID);
    if (!card) return;
    restoreInert();
    placeCard(card);
    setDimmedInert(document.getElementById('app-main-container'));
}

/**
 * Show the error card and resolve when the user presses Retry.
 * @param {string} message - raw error from start_core
 * @returns {Promise<void>}
 */
export function showCoreStartError(message) {
    hideCoreStartError();
    // The banner opens the home page that is showing (minimal or console);
    // on any other page it floats so its Retry is still reachable.
    const card = document.createElement('div');
    card.id = CARD_ID;
    card.setAttribute('role', 'alert');

    const icon = document.createElement('div');
    icon.className = 'core-error-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';

    const title = document.createElement('h3');
    title.className = 'core-error-title';
    title.textContent = t('coreStartFailedTitle');

    const sub = document.createElement('p');
    sub.className = 'core-error-sub';
    sub.textContent = t('coreStartFailedSub');

    const detail = document.createElement('code');
    detail.className = 'core-error-detail';
    detail.textContent = message;
    detail.title = message;

    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'core-error-retry';
    retry.textContent = t('retry');

    const logsBtn = document.createElement('button');
    logsBtn.type = 'button';
    logsBtn.className = 'core-error-retry is-secondary';
    logsBtn.textContent = t('coreErrorViewLog');
    logsBtn.setAttribute('aria-expanded', 'false');

    const actions = document.createElement('div');
    actions.className = 'core-error-actions';
    actions.append(retry, logsBtn);

    const log = document.createElement('pre');
    log.className = 'core-error-log custom-scrollbar';
    log.hidden = true;

    logsBtn.addEventListener('click', async () => {
        const open = log.hidden !== false;
        log.hidden = !open;
        card.classList.toggle('has-log', open);
        logsBtn.setAttribute('aria-expanded', String(open));
        if (!open) return;
        log.textContent = t('loading');
        try {
            const lines = await readLogTail();
            log.textContent = lines.length ? lines.join('\n') : t('coreErrorLogEmpty');
            log.scrollTop = log.scrollHeight;
        } catch (e) {
            const msg = String(/** @type {any} */ (e)?.message ?? e);
            // No log for this start yet (it failed before the core ran): say so in
            // the user's language instead of the backend's English string.
            log.textContent = /no log file available/i.test(msg) ? t('coreErrorLogEmpty') : msg;
        }
    });

    const text = document.createElement('div');
    text.className = 'core-error-text';
    text.append(title, sub, detail);
    card.append(icon, text, actions, log);
    placeCard(card);
    const mainEl = document.getElementById('app-main-container');
    mainEl?.classList.add(DOWN_CLASS);
    // The dimming blocks the mouse only; inert keeps keyboard users out as well.
    setDimmedInert(mainEl);
    const status = document.getElementById('proxy-status-text');
    // The key too: a later translation pass re-reads it.
    if (status) { status.dataset.i18n = 'coreNotRunning'; status.textContent = t('coreNotRunning'); }
    // A first start that failed: the node bar has not been drawn yet (that
    // starts with the core), so it says "Stopped" here.
    const nodeSub = document.getElementById('home-node-sub');
    if (nodeSub && !nodeSub.textContent) {
        nodeSub.textContent = t('homeStopped');
        nodeSub.dataset.coreErrorLabel = 'true';
        nodeSub.dataset.i18n = 'homeStopped';
        delete nodeSub.dataset.key;
        document.getElementById('home-node')?.classList.add('is-stopped');
    }
    for (const id of ['dz-lat-val', 'dz-node-lat']) {
        const value = document.getElementById(id);
        if (!value) continue;
        value.textContent = t('homeStopped');
        value.classList.remove('is-pending', 'is-text');
        value.removeAttribute('aria-busy');
        value.parentElement?.setAttribute('data-lat-state', 'none');
    }
    for (const id of ['dz-lat-badge', 'dz-node-lat-badge']) {
        const badge = document.getElementById(id);
        if (badge) { badge.hidden = true; badge.textContent = ''; }
    }

    return new Promise((resolve) => {
        retry.addEventListener('click', () => {
            retry.disabled = true;
            retry.textContent = t('loading');
            resolve();
        }, { once: true });
    });
}

/** Remove the error card (after a successful retry). */
export function hideCoreStartError() {
    document.getElementById(CARD_ID)?.remove();
    restoreInert();
    document.getElementById('home-hero')?.classList.remove('is-core-error');
    const main = document.getElementById('app-main-container');
    if (main?.classList.contains(DOWN_CLASS)) {
        main.classList.remove(DOWN_CLASS);
        const status = document.getElementById('proxy-status-text');
        if (status) {
            const key = appStore.get('isSysProxyEnabled') ? 'stateOn'
                : (appStore.get('noSubscription') ? 'sysProxyNeedsSubscription' : 'stateOff');
            // The key too: a later translation pass re-reads it.
            status.dataset.i18n = key;
            status.textContent = t(key);
        }
    }
    // The "Stopped" this card wrote on an undrawn node bar (paintNode always
    // sets a key, so its own text is left alone): the next paint fills it.
    const nodeSub = document.getElementById('home-node-sub');
    if (nodeSub?.dataset.coreErrorLabel && !nodeSub.dataset.key) {
        nodeSub.textContent = '';
        delete nodeSub.dataset.coreErrorLabel;
        delete nodeSub.dataset.i18n;
        document.getElementById('home-node')?.classList.remove('is-stopped');
    }
}
