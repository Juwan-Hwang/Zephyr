// @ts-check
/**
 * TUN status label helper.
 *
 * The TUN card on the home page shows a short status line under its title.
 * It used to borrow the system-proxy strings (`proxyActive` / `proxyInactive`),
 * which made the TUN card read "System proxy disabled". This helper renders
 * the dedicated `tunActive` / `tunInactive` strings and keeps `data-i18n` in
 * sync so a later language switch re-translates the current state instead of
 * reverting to the static placeholder.
 */

import { translations, currentLang } from '../i18n.js';

/** Muted text utility used by the status line when TUN is off. */
const MUTED_CLASS = 'text-[var(--text-muted)]';

/**
 * Render the TUN status line for the given enabled state.
 *
 * @param {HTMLElement | null | undefined} el - The `#tun-status-text` element.
 * @param {boolean} enabled - Whether TUN is currently enabled.
 */
export function renderTunStatus(el, enabled) {
    if (!el) return;
    const key = enabled ? 'tunActive' : 'tunInactive';
    const all = /** @type {Record<string, Record<string, unknown>>} */ (/** @type {unknown} */ (translations));
    const localized = all[currentLang]?.[key];
    const fallback = all.en?.[key];
    el.dataset.i18n = key;
    el.textContent = typeof localized === 'string' && localized
        ? localized
        : (typeof fallback === 'string' ? fallback : key);
    el.classList.toggle('text-accent', enabled);
    el.classList.toggle(MUTED_CLASS, !enabled);
}
