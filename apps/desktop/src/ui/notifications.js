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

    // Evict oldest when at capacity
    while (container.children.length >= MAX_NOTIFICATIONS) {
        const oldest = container.firstElementChild;
        if (oldest) oldest.remove();
    }

    const notif = document.createElement('div');
    notif.className = 'glass-card py-3 px-5 border-l-4 flex flex-col gap-1 shadow-2xl transition-all duration-500 translate-x-full opacity-0 pointer-events-auto min-w-0 max-w-[480px]';

    const colors = {
        info: 'border-accent text-accent',
        success: 'border-emerald-500 text-emerald-400',
        error: 'border-rose-500 text-rose-400',
        warning: 'border-amber-500 text-amber-400',
    };
    notif.className += ` ${colors[type] || colors.info}`;
    notif.dataset.priority = String(NOTIFICATION_PRIORITY[type] ?? 2);

    if (title) {
        const titleDiv = document.createElement('div');
        titleDiv.className = 'text-xs font-bold tracking-tight break-all line-clamp-2';
        titleDiv.textContent = title;
        notif.appendChild(titleDiv);
    }

    const msgDiv = document.createElement('div');
    msgDiv.className = 'text-xs tracking-tight opacity-80 break-all line-clamp-3';
    msgDiv.textContent = message;
    // Full path tooltip on hover
    notif.title = title || message;
    notif.appendChild(msgDiv);

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
        notif.classList.remove('translate-x-full', 'opacity-0');
    });

    setTimeout(() => {
        notif.classList.add('translate-x-full', 'opacity-0');
        setTimeout(() => notif.remove(), 500);
    }, title ? 4000 : 3000);

    if (log) _forwardNotification(type, title, message);
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
            const input = document.createElement('input');
            input.type = 'text';
            input.id = 'modal-input';
            input.placeholder = placeholder;
            input.className = 'form-control form-control-lg';
            input.value = defaultValue;
            contentArea.appendChild(input);
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
                    contentArea.classList.remove('overflow-y-auto', 'max-h-[65vh]', 'pr-1', 'custom-scrollbar');
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
            contentArea.classList.add('overflow-y-auto', 'max-h-[65vh]', 'pr-1');
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

/**
 * Show a confirmation modal dialog.
 * @param {string} title
 * @param {string} message
 * @returns {Promise<boolean>}
 */
export function showConfirmModal(title, message = '') {
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
            msgDiv.className = 'rounded-lg border border-amber-500/20 bg-amber-500/10 px-5 py-4 text-sm leading-6 text-[var(--text-primary)]';
            msgDiv.textContent = messageStr;
            contentArea.appendChild(msgDiv);
        }

        // Focus trap: Tab cycles inside modal, Escape closes
        const trap = createFocusTrap(bg, { onEscape: () => close(false) });

        const close = (/** @type {boolean} */ val) => {
            bg.classList.add('opacity-0');
            container.classList.add('scale-95');
            unlockScroll();
            trap.deactivate();
            setTimeout(() => {
                bg.classList.add('hidden');
                resolve(val);
            }, 300);
        };

        bg.classList.remove('hidden');
        lockScroll();
        requestAnimationFrame(() => {
            bg.classList.remove('opacity-0');
            container.classList.remove('scale-95');
            trap.activate();
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
