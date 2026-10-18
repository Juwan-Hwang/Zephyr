// @ts-check
/**
 * Notification, Modal, and Confirm Modal UI components.
 * Extracted from ui.js for modularity.
 */

import { createFocusTrap } from '../utils/focus-trap.js';
import { markdownToHtml } from '../utils/markdown.js';
import { sanitizeHtml } from '../utils/sanitize.js';
import { translations } from '../i18n.js';
import { appStore } from './state.js';
import { forwardToBackend } from '../utils/frontend-log.js';
import { pasteWithFeedback, renderPasteButtonHtml } from '../utils/clipboard.js';

/**
 * Show a toast notification.
 * @param {string} message
 * @param {'info'|'success'|'error'|'warning'} type
 * @param {string|null} title
 */
/** @type {Record<string, number>} Priority map — lower = higher priority */
const NOTIFICATION_PRIORITY = {
    error: 0,
    warning: 1,
    info: 2,
    success: 3,
};

/** @type {number} Max simultaneous notifications */
const MAX_NOTIFICATIONS = 5;

/**
 * @param {string} message
 * @param {'info'|'success'|'warning'|'error'} [type]
 * @param {string|null} [title]
 * @param {{ log?: boolean }} [opts] - `log: false` skips app-log forwarding
 *        (use when the toast is triggered by a backend event that's already logged).
 */
export function showNotification(message, type = 'info', title = null, { log = true } = {}) {
    const container = document.getElementById('notif-container');
    if (!container) return;

    // At capacity, drop the least important toast. Children are kept in priority
    // order (errors first), so that is the last one. When everything shown
    // outranks the new toast, the new one is the least important: skip it.
    const incomingPriority = NOTIFICATION_PRIORITY[type] ?? 2;
    while (container.children.length >= MAX_NOTIFICATIONS) {
        const last = /** @type {HTMLElement|null} */ (container.lastElementChild);
        if (!last) break;
        if (Number(last.dataset.priority) < incomingPriority) {
            if (log) _forwardNotification(type, title, message);
            return;
        }
        last.remove();
    }

    const notif = document.createElement('div');
    notif.className = 'toast glass-card transition-all duration-[var(--zephyr-time-page)] notif-offscreen opacity-0 min-w-0';
    notif.dataset.type = type in NOTIFICATION_PRIORITY ? type : 'info';
    notif.dataset.priority = String(NOTIFICATION_PRIORITY[type] ?? 2);

    // Coloured status dot + neutral text: the colour says what kind of message
    // it is, the text stays readable (it used to be tinted end to end).
    const dot = document.createElement('span');
    dot.className = 'toast-dot';
    dot.setAttribute('aria-hidden', 'true');
    notif.appendChild(dot);

    const body = document.createElement('div');
    body.className = 'toast-body';
    if (title) {
        const titleDiv = document.createElement('div');
        titleDiv.className = 'toast-title line-clamp-2';
        titleDiv.textContent = title;
        body.appendChild(titleDiv);
    }

    const msgDiv = document.createElement('div');
    msgDiv.className = 'toast-msg line-clamp-3';
    msgDiv.textContent = message;
    body.appendChild(msgDiv);
    // Full text on hover (the body is clamped to three lines)
    notif.title = title ? `${title}\n${message}` : message;
    notif.appendChild(body);

    // Errors and warnings stay long enough to read, pause while hovered and can be
    // dismissed; success/info are brief and let clicks through to the controls below.
    const sticky = type === 'error' || type === 'warning';
    if (sticky) {
        notif.classList.add('toast-sticky');
        const closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.className = 'toast-close';
        closeBtn.setAttribute('aria-label', _tr('dismiss', 'Dismiss'));
        closeBtn.textContent = '×';
        closeBtn.addEventListener('click', () => dismiss());
        notif.appendChild(closeBtn);
    }

    // Priority insert — higher priority notifications appear first
    const priority = NOTIFICATION_PRIORITY[type] ?? 2;
    const existing = Array.from(container.children);
    const insertBefore = existing.find(
        (el) => Number(/** @type {HTMLElement} */ (el).dataset.priority) > priority
    );

    if (insertBefore) {
        container.insertBefore(notif, insertBefore);
    } else {
        container.appendChild(notif);
    }

    requestAnimationFrame(() => {
        notif.classList.remove('notif-offscreen', 'opacity-0');
    });

    let dismissed = false;
    const dismiss = () => {
        if (dismissed) return;
        dismissed = true;
        clearTimeout(timer);
        notif.classList.add('notif-offscreen', 'opacity-0');
        setTimeout(() => notif.remove(), 500);
    };
    let lifetime = title ? 3500 : 2500;
    if (sticky) lifetime = 7000;
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer = setTimeout(dismiss, lifetime);
    if (sticky) {
        notif.addEventListener('mouseenter', () => clearTimeout(timer));
        notif.addEventListener('mouseleave', () => {
            if (!dismissed) timer = setTimeout(dismiss, 2500);
        });
    }

    if (log) _forwardNotification(type, title, message);
}

/**
 * Current-language string with a fallback (toasts can fire before i18n settles).
 * @param {string} key
 * @param {string} fallback
 */
function _tr(key, fallback) {
    const lang = appStore.get('currentLang') || 'en';
    /** @type {any} */
    const table = /** @type {any} */ (translations)[lang] || translations.en;
    return table?.[key] || fallback;
}

/**
 * Map notification type to log level and forward to backend app log.
 * Extracted from showNotification to keep its cognitive complexity
 * below the SonarCloud threshold (15).
 * @param {string} type
 * @param {string|null} title
 * @param {string} message
 */
function _forwardNotification(type, title, message) {
    const level = /** @type {'error'|'warn'|'info'} */ (
        { error: 'error', warning: 'warn' }[type] ?? 'info'
    );
    const msg = title ? `[${title}] ${message}` : message;
    forwardToBackend(level, 'notification', msg);
}

/**
 * Lock body scroll when modal is open.
 */
function lockScroll() {
    document.body.style.overflow = 'hidden';
}

/**
 * Unlock body scroll.
 */
function unlockScroll() {
    document.body.style.overflow = '';
}

/**
 * Show a custom modal dialog with optional custom content.
 * @param {string} title
 * @param {string} placeholder
 * @param {string} defaultValue
 * @param {boolean} isCustomContent
 * @param {string} customHtml
 * @param {(contentArea: HTMLElement, close: (val: string|HTMLElement|null) => void) => void} [onReady]
 * @returns {Promise<string|HTMLElement|null>}
 */
let _modalOpen = false;

export function showModal(/** @type {string} */ title, placeholder = '', defaultValue = '', isCustomContent = false, customHtml = '', /** @type {((contentArea: HTMLElement, close: (val: string|HTMLElement|null) => void) => void)|undefined} */ onReady = undefined) {
    if (_modalOpen) return Promise.resolve(null);
    _modalOpen = true;
    return new Promise((resolve) => {
        const bg = document.getElementById('modal-bg');
        const container = document.getElementById('modal-container');
        const titleEl = document.getElementById('modal-title');
        const contentArea = document.getElementById('modal-content-area');
        const confirmBtn = document.getElementById('modal-confirm');
        const cancelBtn = document.getElementById('modal-cancel');

        if (!bg || !container || !titleEl || !contentArea || !confirmBtn || !cancelBtn) {
            resolve(null);
            return;
        }

        titleEl.textContent = title;

        if (isCustomContent) {
            contentArea.replaceChildren();
            contentArea.insertAdjacentHTML('beforeend', sanitizeHtml(customHtml));
        } else {
            contentArea.replaceChildren();
            const wrapper = document.createElement('div');
            wrapper.className = 'input-paste-wrapper';

            const input = document.createElement('input');
            input.type = 'text';
            input.id = 'modal-input';
            input.placeholder = placeholder;
            input.className = 'form-control form-control-lg';
            input.value = defaultValue;
            input.setAttribute('aria-labelledby', 'modal-title');

            const currentLang = appStore.get('currentLang') || 'en';
            /** @type {any} */
            const tObj = /** @type {any} */ (translations)[currentLang] || translations.en;
            const pasteLabel = tObj?.paste || 'Paste';

            wrapper.appendChild(input);
            wrapper.insertAdjacentHTML('beforeend', sanitizeHtml(renderPasteButtonHtml('modal-input-paste-btn', pasteLabel)));
            wrapper.querySelector('#modal-input-paste-btn')?.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const lang = appStore.get('currentLang') || 'en';
                void pasteWithFeedback(input, showNotification, translations, lang);
            });
            contentArea.appendChild(wrapper);
        }

        // Focus trap: Tab cycles inside modal, Escape closes
        const trap = createFocusTrap(bg, { onEscape: () => close(null) });

        const close = (/** @type {string|HTMLElement|null} */ val) => {
            bg.classList.add('opacity-0');
            container.classList.add('scale-95');
            unlockScroll();
            trap.deactivate();
            setTimeout(() => {
                // Restore classes AFTER animation completes to avoid visual glitch
                if (isCustomContent) {
                    container.classList.remove('w-[560px]', 'max-w-[90vw]');
                    container.classList.add('w-[400px]');
                    contentArea.classList.remove('overflow-y-auto', 'max-h-[65vh]', 'pe-1', 'custom-scrollbar');
                    cancelBtn.classList.remove('hidden');
                    confirmBtn.classList.remove('hidden');
                }
                bg.classList.add('hidden');
                _modalOpen = false;
                resolve(val);
            }, 300);
        };

        bg.classList.remove('hidden');
        lockScroll();

        // For custom content (e.g. update notes), constrain modal height
        if (isCustomContent) {
            container.classList.remove('w-[400px]');
            container.classList.add('w-[560px]', 'max-w-[90vw]');
            contentArea.classList.add('overflow-y-auto', 'max-h-[65vh]', 'pe-1');
            contentArea.classList.add('custom-scrollbar');
            // Hide default Cancel/Confirm buttons — custom content has its own action buttons
            cancelBtn.classList.add('hidden');
            confirmBtn.classList.add('hidden');
        }

        requestAnimationFrame(() => {
            bg.classList.remove('opacity-0');
            container.classList.remove('scale-95');
            trap.activate();
            // Call onReady after modal is visible, so callers can wire up events
            // on the custom content while the modal is still open.
            if (isCustomContent && onReady) {
                onReady(contentArea, close);
            }
        });

        confirmBtn.onclick = () => {
            if (isCustomContent) {
                close(contentArea);
            } else {
                const modalInput = document.getElementById('modal-input');
                const val = modalInput ? /** @type {HTMLInputElement} */(modalInput).value : '';
                close(val);
            }
        };
        cancelBtn.onclick = () => close(null);
        bg.onclick = (e) => { if (e.target === bg) close(null); };

        if (!isCustomContent) {
            const currentInput = document.getElementById('modal-input');
            if (currentInput) {
                /** @type {HTMLInputElement} */ (currentInput).focus();
                currentInput.onkeydown = (e) => {
                    if (e.key === 'Enter') close(/** @type {HTMLInputElement} */(currentInput).value);
                    // Escape handled by focus trap
                };
            }
        }
    });
}

/** Confirm dialogs share one modal: queue them so a second request cannot take over the first. */
let _confirmQueue = Promise.resolve();

/**
 * Show a confirmation modal dialog.
 * @param {string} title
 * @param {string} [message]
 * @param {{ danger?: boolean, confirmText?: string }} [options]
 *   danger: red confirm button, neutral message, initial focus on Cancel so Enter never destroys by accident.
 *   confirmText: label for the confirm button (e.g. "删除"); restored afterwards.
 * @returns {Promise<boolean>}
 */
export function showConfirmModal(title, message = '', options = {}) {
    const run = _confirmQueue.then(() => openConfirmModal(title, message, options));
    _confirmQueue = run.then(() => undefined, () => undefined);
    return run;
}

/**
 * @param {string} title
 * @param {string} [message]
 * @param {{ danger?: boolean, confirmText?: string }} [options]
 * @returns {Promise<boolean>}
 */
function openConfirmModal(title, message = '', options = {}) {
    const { danger = false, confirmText = '' } = options || {};
    return new Promise((resolve) => {
        const bg = document.getElementById('modal-bg');
        const container = document.getElementById('modal-container');
        const titleEl = document.getElementById('modal-title');
        const contentArea = document.getElementById('modal-content-area');
        const confirmBtn = document.getElementById('modal-confirm');
        const cancelBtn = document.getElementById('modal-cancel');

        if (!bg || !container || !titleEl || !contentArea || !confirmBtn || !cancelBtn) {
            resolve(false);
            return;
        }

        titleEl.textContent = title;

         
        contentArea.replaceChildren();
        const messageStr = message != null ? String(message) : '';
        if (messageStr.trim()) {
            const msgDiv = document.createElement('div');
            msgDiv.className = danger
                ? 'text-sm leading-6 text-[var(--text-secondary)]'
                : 'rounded-[var(--radius-md)] border border-amber-500/20 bg-amber-500/10 px-5 py-4 text-sm leading-6 text-[var(--text-primary)]';
            msgDiv.textContent = messageStr;
            contentArea.appendChild(msgDiv);
        }

        const originalConfirmLabel = confirmBtn.textContent;
        if (danger) {
            confirmBtn.classList.remove('btn-primary');
            confirmBtn.classList.add('btn-danger');
        }
        if (confirmText) confirmBtn.textContent = confirmText;

        // Focus trap: Tab cycles inside modal, Escape closes
        const trap = createFocusTrap(bg, { onEscape: () => close(false) });

        const close = (/** @type {boolean} */ val) => {
            bg.classList.add('opacity-0');
            container.classList.add('scale-95');
            unlockScroll();
            trap.deactivate();
            setTimeout(() => {
                bg.classList.add('hidden');
                if (danger) {
                    confirmBtn.classList.remove('btn-danger');
                    confirmBtn.classList.add('btn-primary');
                }
                if (confirmText) confirmBtn.textContent = originalConfirmLabel;
                resolve(val);
            }, 300);
        };

        bg.classList.remove('hidden');
        lockScroll();
        requestAnimationFrame(() => {
            bg.classList.remove('opacity-0');
            container.classList.remove('scale-95');
            trap.activate();
            // Destructive dialogs start on Cancel so a stray Enter never deletes.
            if (danger) cancelBtn.focus();
        });

        confirmBtn.onclick = () => close(true);
        cancelBtn.onclick = () => close(false);
        bg.onclick = (e) => { if (e.target === bg) close(false); };
        // Focus managed by trap.activate() — no need for manual confirmBtn.focus()
        confirmBtn.onkeydown = (e) => {
            if (e.key === 'Enter') close(true);
            // Escape handled by focus trap
        };
        cancelBtn.onkeydown = (_e) => {
            // Escape handled by focus trap
        };
    });
}

// ---------------------------------------------------------------------------
// Update notes modal (renders Markdown release notes)
// ---------------------------------------------------------------------------

/**
 * Show a modal with rendered Markdown release notes and confirm/cancel buttons.
 * Content is scrollable.
 * @param {string} title - Modal title
 * @param {string} releaseNotesMd - Raw Markdown release notes
 * @returns {Promise<boolean>} true if user confirmed
 */
export function showUpdateNotesModal(title, releaseNotesMd) {
    const html = sanitizeHtml(markdownToHtml(releaseNotesMd || ''));
    const customHtml = `<div class="space-y-1">${html}</div>`;

    // Use isCustomContent=true for scrollable layout, but restore confirm/cancel buttons via onReady.
    const t = /** @type {any} */ (translations)[appStore.get('currentLang')] || {};
    const updateBtnText = t.update || 'Update';
    let originalConfirmText = '';
    return showModal(title, '', '', true, customHtml, () => {
        const confirmBtn = document.getElementById('modal-confirm');
        const cancelBtn = document.getElementById('modal-cancel');
        if (confirmBtn) {
            originalConfirmText = confirmBtn.textContent;
            confirmBtn.classList.remove('hidden');
            confirmBtn.textContent = updateBtnText;
        }
        if (cancelBtn) cancelBtn.classList.remove('hidden');
    }).then(result => {
        // Restore confirm button text after modal closes
        const confirmBtn = document.getElementById('modal-confirm');
        if (confirmBtn && originalConfirmText) confirmBtn.textContent = originalConfirmText;
        return !!result;
    });
}
