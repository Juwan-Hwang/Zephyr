// @ts-check
/**
 * Notification, Modal, and Confirm Modal UI components.
 * Extracted from ui.js for modularity.
 */

import { sanitizeHtml } from '../utils/sanitize.js';

/**
 * Show a toast notification.
 * @param {string} message
 * @param {'info'|'success'|'error'|'warning'} type
 * @param {string|null} title
 */
export function showNotification(message, type = 'info', title = null) {
    const container = document.getElementById('notif-container');
    if (!container) return;

    const notif = document.createElement('div');
    notif.className = 'glass-card py-3 px-5 border-l-4 flex flex-col gap-1 shadow-2xl transition-all duration-500 translate-x-full opacity-0 pointer-events-auto min-w-[200px] max-w-[400px]';

    const colors = {
        info: 'border-accent text-accent',
        success: 'border-emerald-500 text-emerald-400',
        error: 'border-rose-500 text-rose-400',
        warning: 'border-amber-500 text-amber-400',
    };
    notif.className += ` ${colors[type] || colors.info}`;

    if (title) {
        const titleDiv = document.createElement('div');
        titleDiv.className = 'text-xs font-bold tracking-tight';
        titleDiv.textContent = title;
        notif.appendChild(titleDiv);
    }

    const msgDiv = document.createElement('div');
    msgDiv.className = 'text-xs tracking-tight opacity-80';
    msgDiv.textContent = message;
    notif.appendChild(msgDiv);

    container.appendChild(notif);

    requestAnimationFrame(() => {
        notif.classList.remove('translate-x-full', 'opacity-0');
    });

    setTimeout(() => {
        notif.classList.add('translate-x-full', 'opacity-0');
        setTimeout(() => notif.remove(), 500);
    }, title ? 4000 : 3000);
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
 * @returns {Promise<string|HTMLElement|null>}
 */
export function showModal(title, placeholder = '', defaultValue = '', isCustomContent = false, customHtml = '') {
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
            contentArea.innerHTML = '';
            contentArea.insertAdjacentHTML('beforeend', sanitizeHtml(customHtml));
        } else {
            contentArea.innerHTML = '';
            const input = document.createElement('input');
            input.type = 'text';
            input.id = 'modal-input';
            input.placeholder = placeholder;
            input.className = 'input-modal';
            input.value = defaultValue;
            contentArea.appendChild(input);
        }

        const close = (/** @type {string|HTMLElement|null} */ val) => {
            bg.classList.add('opacity-0');
            container.classList.add('scale-95');
            unlockScroll();
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
        });

        confirmBtn.onclick = () => {
            if (isCustomContent) {
                resolve(contentArea);
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
                    if (e.key === 'Escape') close(null);
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
        contentArea.innerHTML = '';
        const msgDiv = document.createElement('div');
        msgDiv.className = 'rounded-2xl border border-amber-500/20 bg-amber-500/10 px-5 py-4 text-sm leading-6 text-zinc-200';
        msgDiv.textContent = message;
        contentArea.appendChild(msgDiv);

        const close = (/** @type {boolean} */ val) => {
            bg.classList.add('opacity-0');
            container.classList.add('scale-95');
            unlockScroll();
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
        });

        confirmBtn.onclick = () => close(true);
        cancelBtn.onclick = () => close(false);
        bg.onclick = (e) => { if (e.target === bg) close(false); };
        confirmBtn.focus();
        confirmBtn.onkeydown = (e) => {
            if (e.key === 'Enter') close(true);
            if (e.key === 'Escape') close(false);
        };
        cancelBtn.onkeydown = (e) => {
            if (e.key === 'Escape') close(false);
        };
    });
}
