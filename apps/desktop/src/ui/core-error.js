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

const LOG_TAIL_LINES = 40;

const CARD_ID = 'core-error-state';
const DOWN_CLASS = 'core-down';

/**
 * Show the error card and resolve when the user presses Retry.
 * @param {string} message - raw error from start_core
 * @returns {Promise<void>}
 */
export function showCoreStartError(message) {
    hideCoreStartError();
    const hero = document.getElementById('home-hero');
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
            const res = await readCoreLog(0, 5000);
            const lines = Array.isArray(res?.lines) ? res.lines.slice(-LOG_TAIL_LINES) : [];
            log.textContent = lines.length ? lines.join('\n') : t('coreErrorLogEmpty');
            log.scrollTop = log.scrollHeight;
        } catch (e) {
            log.textContent = String(/** @type {any} */ (e)?.message ?? e);
        }
    });

    card.append(icon, title, sub, detail, actions, log);
    host.appendChild(card);
    const stats = hero?.querySelector('.home-stats');
    if (stats instanceof HTMLElement) card.style.bottom = `${stats.offsetHeight}px`;
    hero?.classList.add('is-core-error');
    document.getElementById('app-main-container')?.classList.add(DOWN_CLASS);
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
    document.getElementById('home-hero')?.classList.remove('is-core-error');
    const main = document.getElementById('app-main-container');
    if (main?.classList.contains(DOWN_CLASS)) {
        main.classList.remove(DOWN_CLASS);
        const status = document.getElementById('proxy-status-text');
        if (status) status.textContent = t('proxyStatusReady');
    }
}
