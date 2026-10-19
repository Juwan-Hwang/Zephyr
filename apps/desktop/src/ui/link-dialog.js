// @ts-check
/**
 * Link dialog: a link field with live validation and an optional name field.
 * Same layout as the edit-subscription panel (title + ×, labelled tall fields, Cancel / primary).
 * Used by "Add subscription" and "Import override from URL".
 *
 * @module ui/link-dialog
 */

import { translations } from '../i18n.js';
import { appStore } from './state.js';
import { escapeHtml, escapeAttr } from '../utils/sanitize.js';
import { pasteWithFeedback, renderPasteButtonHtml } from '../utils/clipboard.js';
import { createFocusTrap } from '../utils/focus-trap.js';
import { validateHttpUrl } from '../utils/url-validate.js';
import { showNotification } from './notifications.js';

const ANIMATION_MS = 300;
const LIVE_CHECK_DELAY_MS = 350;

/**
 * @typedef {Object} LinkDialogOptions
 * @property {string} title
 * @property {string} [confirmText]
 * @property {string} [urlLabel]
 * @property {string} [urlPlaceholder]
 * @property {boolean} [withName] - show the optional name field
 * @property {string} [nameLabel]
 * @property {(url: string) => string | null} [suggestName] - name shown as placeholder for a valid link
 */

/** Closes the dialog currently open (resolving its promise and releasing its focus trap). @type {((val: null) => void) | null} */
let _closeOpen = null;

/**
 * @param {LinkDialogOptions} opts
 * @returns {Promise<{ url: string, name: string } | null>}
 */
export function showLinkDialog(opts) {
    /** @type {Record<string, string>} */
    const t = /** @type {any} */ (translations)[appStore.get('currentLang')] || translations.en;
    // A second open replaces the first: close it properly so its trap and promise end.
    _closeOpen?.(null);
    document.getElementById('link-dialog')?.remove();

    return new Promise((resolve) => {
        let closing = false;
        const modal = document.createElement('div');
        modal.id = 'link-dialog';
        modal.className = 'fixed inset-0 z-[var(--z-modal)] flex items-center justify-center bg-[var(--zephyr-bg-overlay)] backdrop-blur-md opacity-0 transition-opacity';
        modal.style.transitionDuration = `${ANIMATION_MS}ms`;
        modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-modal', 'true');
        modal.setAttribute('aria-labelledby', 'link-dialog-title');

        const nameBlock = opts.withName ? `
                <div class="flex flex-col gap-1.5">
                    <label for="link-dialog-name" class="text-xs font-medium text-[var(--text-muted)]">${escapeHtml(opts.nameLabel || t.subscriptionName || 'Name')} <span class="link-dialog-optional">${escapeHtml(t.optionalField || 'Optional')}</span></label>
                    <input id="link-dialog-name" type="text" autocomplete="off" spellcheck="false" class="form-control form-control-lg">
                </div>` : '';

        // eslint-disable-next-line no-unsanitized/property -- values escaped via escapeHtml()/escapeAttr() // nosemgrep: js-innerhtml-assignment — verified safe, see eslint-disable above
        modal.innerHTML = `
        <div class="glass-card w-[440px] p-6 space-y-5" style="opacity:0;transform:scale(0.95);transition:opacity ${ANIMATION_MS}ms cubic-bezier(0.16,1,0.3,1),transform ${ANIMATION_MS}ms cubic-bezier(0.16,1,0.3,1)">
            <div class="flex items-center justify-between">
                <h3 id="link-dialog-title" class="dialog-title">${escapeHtml(opts.title)}</h3>
                <button id="link-dialog-close" type="button" class="text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors" aria-label="${escapeAttr(t.closeDialog || 'Close')}">
                    <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
                </button>
            </div>
            <div class="space-y-4">
                <div class="flex flex-col gap-1.5">
                    <label for="link-dialog-url" class="text-xs font-medium text-[var(--text-muted)]">${escapeHtml(opts.urlLabel || t.subscriptionUrl || 'Link')}</label>
                    <div class="input-paste-wrapper">
                        <input id="link-dialog-url" type="text" inputmode="url" autocomplete="off" spellcheck="false" placeholder="${escapeAttr(opts.urlPlaceholder || 'https://')}" aria-describedby="link-dialog-url-error" class="form-control form-control-lg">
                        ${renderPasteButtonHtml('link-dialog-paste', t.paste || 'Paste')}
                    </div>
                    <p id="link-dialog-url-error" class="link-dialog-error" aria-live="polite"></p>
                </div>${nameBlock}
            </div>
            <div class="flex justify-end gap-2 pt-1">
                <button id="link-dialog-cancel" type="button" class="btn-ghost">${escapeHtml(t.cancel || 'Cancel')}</button>
                <button id="link-dialog-confirm" type="button" class="btn-primary" disabled>${escapeHtml(opts.confirmText || t.confirm || 'OK')}</button>
            </div>
        </div>`;
        document.body.appendChild(modal);

        const panel = /** @type {HTMLElement} */ (modal.querySelector('.glass-card'));
        const urlInput = /** @type {HTMLInputElement} */ (modal.querySelector('#link-dialog-url'));
        const nameInput = /** @type {HTMLInputElement | null} */ (modal.querySelector('#link-dialog-name'));
        const errorEl = /** @type {HTMLElement} */ (modal.querySelector('#link-dialog-url-error'));
        const confirmBtn = /** @type {HTMLButtonElement} */ (modal.querySelector('#link-dialog-confirm'));

        requestAnimationFrame(() => requestAnimationFrame(() => {
            if (!modal.isConnected || closing) return;
            modal.classList.remove('opacity-0');
            panel.style.opacity = '1';
            panel.style.transform = 'scale(1)';
        }));

        /** @type {ReturnType<typeof setTimeout> | null} */
        let liveTimer = null;

        /** @param {boolean} showError */
        const check = (showError) => {
            const code = validateHttpUrl(urlInput.value);
            confirmBtn.disabled = code !== '';
            let msg = '';
            if (code === 'scheme') msg = t.linkErrorScheme || 'Only http:// and https:// links are supported';
            else if (code === 'invalid') msg = t.linkErrorInvalid || 'Not a valid link';
            if (showError || !msg) {
                errorEl.textContent = msg;
                if (msg) urlInput.setAttribute('aria-invalid', 'true');
                else urlInput.removeAttribute('aria-invalid');
            }
            if (nameInput && opts.suggestName) {
                nameInput.placeholder = code === '' ? (opts.suggestName(urlInput.value.trim()) || '') : '';
            }
            return code;
        };

        urlInput.addEventListener('input', () => {
            if (liveTimer) clearTimeout(liveTimer);
            check(false); // clears a stale error at once, enables the button as soon as the link is good
            liveTimer = setTimeout(() => check(true), LIVE_CHECK_DELAY_MS);
        });
        urlInput.addEventListener('blur', () => { if (urlInput.value.trim()) check(true); });

        /** @param {{ url: string, name: string } | null} val */
        const close = (val) => {
            if (closing) return;
            closing = true;
            if (_closeOpen === close) _closeOpen = null;
            if (liveTimer) clearTimeout(liveTimer);
            trap.deactivate();
            panel.style.opacity = '0';
            panel.style.transform = 'scale(0.95)';
            modal.classList.add('opacity-0', 'pointer-events-none');
            setTimeout(() => modal.remove(), ANIMATION_MS);
            resolve(val);
        };

        const submit = () => {
            if (check(true) !== '') { urlInput.focus(); return; }
            close({ url: urlInput.value.trim(), name: (nameInput?.value || '').trim() });
        };

        _closeOpen = close;
        const trap = createFocusTrap(modal, { onEscape: () => close(null) });
        // Closed before the first frame: never start trapping keys for a removed dialog.
        requestAnimationFrame(() => { if (!closing) trap.activate(); });

        modal.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && e.target instanceof HTMLInputElement && !e.isComposing) {
                e.preventDefault();
                submit();
            }
        });
        modal.addEventListener('click', (e) => { if (e.target === modal) close(null); });
        modal.querySelector('#link-dialog-close')?.addEventListener('click', () => close(null));
        modal.querySelector('#link-dialog-cancel')?.addEventListener('click', () => close(null));
        confirmBtn.addEventListener('click', submit);
        modal.querySelector('#link-dialog-paste')?.addEventListener('click', (e) => {
            e.preventDefault();
            void pasteWithFeedback(urlInput, showNotification, translations, appStore.get('currentLang') || 'en');
        });

        setTimeout(() => { if (!closing) urlInput.focus(); }, 100);
    });
}
