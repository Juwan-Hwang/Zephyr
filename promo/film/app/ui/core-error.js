// @ts-check
/**
 * In-page error state for a core that failed to start (replaces the native alert()).
 * The card takes the place of the home hero's speed area; the stats row and the
 * cards below stay visible but dimmed and inert, so the page keeps its shape.
 *
 * @module ui/core-error
 */

import { t } from '../i18n.js';
import { readCoreLog } from '../api.js';
import { appStore } from './state.js';
import { trackHomeStatsHeight } from './no-subscription.js';

const LOG_TAIL_LINES = 40;

/** Bytes read back from the end of the log: plenty for the last few dozen lines. */
const LOG_TAIL_BYTES = 16 * 1024;

const CARD_ID = 'core-error-state';
const DOWN_CLASS = 'core-down';

/** The dimmed sections behind the card (matches the `.core-down` rules in styles.css). */
const DIMMED_SELECTOR = [
    '.home-hero.is-core-error .home-stats',
    '[data-page="home"] > :not(#home-hero)',
    '[data-page="console"]',
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

/**
 * Show the error card and resolve when the user presses Retry.
 * @param {string} message - raw error from start_core
 * @returns {Promise<void>}
 */
export function showCoreStartError(message) {
    hideCoreStartError();
    // The hero lives on the minimal home page; when the console home is shown
    // instead, that page is hidden and the card (with its Retry) would be too.
    const heroEl = document.getElementById('home-hero');
    const hero = heroEl && heroEl.getClientRects().length > 0 ? heroEl : null;
    const host = hero || document.getElementById('app-main-container') || document.body;
    const card = document.createElement('div');
    card.id = CARD_ID;
    card.className = hero ? 'core-error-card' : 'core-error-card is-floating glass-card';
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

    card.append(icon, title, sub, detail, actions, log);
    host.appendChild(card);
    if (hero) trackHomeStatsHeight();
    hero?.classList.add('is-core-error');
    const mainEl = document.getElementById('app-main-container');
    mainEl?.classList.add(DOWN_CLASS);
    // The dimming blocks the mouse only; inert keeps keyboard users out as well.
    setDimmedInert(mainEl);
    const status = document.getElementById('proxy-status-text');
    if (status) status.textContent = t('coreNotRunning');

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
        // Leave the live "Proxy Active" text alone; otherwise show the idle hint.
        if (status && !appStore.get('isSysProxyEnabled')) {
            status.textContent = t(appStore.get('noSubscription') ? 'sysProxyNeedsSubscription' : 'proxyStatusReady');
        }
    }
}
